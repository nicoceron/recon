import { describe, expect, it } from 'vitest';
import { AssetStore } from '../interceptor/assetInterceptor.js';
import { chooseReplayPages, prepareSingleHtml } from './export.js';

describe('chooseReplayPages', () => {
  it('uses original server HTML for React/Next-style pages', () => {
    const hydrated = new Map([['https://example.com/', '<html><body><canvas></canvas><script src="app.js"></script></body></html>']]);
    const source = new Map([['https://example.com/', '<html><body><div id="root"></div><script src="app.js"></script></body></html>']]);
    expect(chooseReplayPages(hydrated, source).get('https://example.com/')).toBe(source.get('https://example.com/'));
  });

  it('keeps hydrated DOM for Framer pages', () => {
    const hydratedHtml = '<html><body><div data-framer-hydrate-v2>Hydrated Framer</div></body></html>';
    const hydrated = new Map([['https://example.com/', hydratedHtml]]);
    const source = new Map([['https://example.com/', '<html><body>SSR Framer</body></html>']]);
    expect(chooseReplayPages(hydrated, source).get('https://example.com/')).toBe(hydratedHtml);
  });
});

describe('prepareSingleHtml', () => {
  it('writes only the selected page and points uncaptured internal links at the real source page', async () => {
    const pages = new Map([
      [
        'https://example.com/',
        '<html><head></head><body><a href="/pricing">Pricing</a><a href="/">Home</a></body></html>',
      ],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', new AssetStore(), {
      liveUrl: 'https://example.com/',
      localizeAssets: false,
    });

    expect(result.url).toBe('https://example.com/');
    expect(result.html).toContain('href="https://example.com/pricing"');
    expect(result.html).toContain('href="./index.html"');
  });

  it('hotlinks non-Framer same-origin assets when asset localization is disabled', async () => {
    const pages = new Map([
      ['https://example.com/', '<html><body><img src="/_next/static/logo.png"></body></html>'],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', new AssetStore(), {
      liveUrl: 'https://example.com/',
      localizeAssets: false,
    });

    expect(result.html).toContain('src="https://example.com/_next/static/logo.png"');
  });

  it('uses localized asset paths when asset localization is enabled', async () => {
    const store = new AssetStore();
    store.record('https://cdn.example.com/logo.png', Buffer.from('png'), 'image/png');
    const pages = new Map([
      ['https://example.com/', '<html><body><img src="https://cdn.example.com/logo.png"></body></html>'],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', store, {
      liveUrl: 'https://example.com/',
      localizeAssets: true,
    });

    expect(result.html).toContain('src="/assets/cdn.example.com/logo.png"');
  });

  it('injects captured CSSOM for non-Framer pages', async () => {
    const pages = new Map([
      ['https://example.com/', '<html><head></head><body><div class="hero"></div></body></html>'],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', new AssetStore(), {
      liveUrl: 'https://example.com/',
      localizeAssets: false,
      pageStyles: new Map([['https://example.com/', '.hero{color:red}']]),
    });

    expect(result.html).toContain('data-static-captured-cssom="1"');
    expect(result.html).toContain('.hero{color:red}');
  });

  it('forces static app theme when requested', async () => {
    const pages = new Map([
      [
        'https://example.com/',
        `<html class="theme-root light"><head></head><body><script>
          function setTheme(newTheme) { window.__theme = newTheme; }
          var preferredTheme = "system";
        </script></body></html>`,
      ],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', new AssetStore(), {
      liveUrl: 'https://example.com/',
      localizeAssets: false,
      forceTheme: 'dark',
    });

    expect(result.html).toContain('class="theme-root dark"');
    expect(result.html).toContain('var preferredTheme = "dark";');
  });

  it('does not inject captured CSSOM for Framer pages', async () => {
    const pages = new Map([
      [
        'https://example.com/',
        '<html><head></head><body><div data-framer-hydrate-v2>Framer page</div></body></html>',
      ],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', new AssetStore(), {
      liveUrl: 'https://example.com/',
      localizeAssets: false,
      pageStyles: new Map([['https://example.com/', '.hero{color:red}']]),
    });

    expect(result.html).not.toContain('data-static-captured-cssom="1"');
    expect(result.html).not.toContain('.hero{color:red}');
  });

  it('lets original Next.js source hydrate without generic static repair layers', async () => {
    const pages = new Map([
      ['https://example.com/', '<html><head></head><body><main>SSR</main><script>self.__next_f=self.__next_f||[];self.__next_f.push([1,"data"])</script></body></html>'],
    ]);
    const result = await prepareSingleHtml(pages, 'https://example.com', new AssetStore(), {
      liveUrl: 'https://example.com/',
      localizeAssets: false,
      pageStyles: new Map([['https://example.com/', '.runtime-only{opacity:1}']]),
    });
    expect(result.html).not.toContain('data-static-captured-cssom="1"');
    expect(result.html).not.toContain('.runtime-only{opacity:1}');
    expect(result.html).not.toContain('[data-static-control]');
    expect(result.html).not.toContain('var pageMap=');
    expect(result.html).toContain('data-static-framework-visibility="1"');
  });

  it('keeps same-origin Next.js bootstrap paths at /_next when localized aliases exist', async () => {
    const store = new AssetStore();
    store.record('https://example.com/_next/static/app.js?build=1', Buffer.from('app'), 'text/javascript');
    const pages = new Map([
      [
        'https://example.com/',
        '<html><head><script src="/_next/static/app.js?build=1"></script></head><body><script>self.__next_f=[]</script></body></html>',
      ],
    ]);

    const result = await prepareSingleHtml(pages, 'https://example.com', store, {
      liveUrl: 'https://example.com/',
      localizeAssets: true,
    });

    expect(result.html).toContain('src="/_next/static/app.js?build=1"');
    expect(result.html).not.toContain('src="/assets/example.com/_next/static/app.js"');
  });
});
