import { describe, expect, it } from 'vitest';
import { rewriteHtml } from './htmlRewriter.js';

const baseCtx = {
  pageUrl: 'https://example.com/',
  siteOrigin: 'https://example.com',
  assetLookup: (u: string): string | undefined => {
    if (u === 'https://cdn.example.com/img.png') return '/assets/cdn.example.com/img.png';
    return undefined;
  },
  pageLookup: (u: string): string | undefined => {
    if (u === 'https://example.com/about') return '/about/';
    return undefined;
  },
};

describe('rewriteHtml — asset URL rewriting', () => {
  it('rewrites <img src> when present in lookup', async () => {
    const html = `<img src="https://cdn.example.com/img.png">`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('src="/assets/cdn.example.com/img.png"');
  });

  it('rewrites srcset preserving descriptors', async () => {
    const html = `<img srcset="https://cdn.example.com/img.png 512w, https://other.com/x.png 1024w">`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('/assets/cdn.example.com/img.png 512w');
  });

  it('rewrites internal anchor hrefs to local page paths', async () => {
    const html = `<a href="https://example.com/about">About</a>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('href="/about/"');
  });

  it('leaves external anchors untouched', async () => {
    const html = `<a href="https://github.com/foo">External</a>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('href="https://github.com/foo"');
  });
});

describe('rewriteHtml — Framer owner-UI stripping', () => {
  it('removes editor-bar shell elements', async () => {
    const html = `
      <html><body>
        <div id="__framer-editorbar-container"><button id="__framer-editorbar-button">edit</button></div>
        <span id="__framer-editorbar-label">Edit Framer Content</span>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('__framer-editorbar-container');
    expect(out).not.toContain('__framer-editorbar-button');
    expect(out).not.toContain('__framer-editorbar-label');
    expect(out).toContain('real content');
  });

  it('removes the "Made in Framer" badge', async () => {
    const html = `
      <html><body>
        <div id="__framer-badge-container">
          <a class="__framer-badge" href="https://www.framer.com">Made in Framer</a>
        </div>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('__framer-badge-container');
    expect(out).not.toContain('__framer-badge');
    expect(out).not.toContain('Made in Framer');
    expect(out).toContain('real content');
  });

  it('keeps and hides the Framer badge container when it is a hydration target', async () => {
    const html = `
      <html><head></head><body>
        <div id="__framer-badge-container">
          <a class="__framer-badge" href="https://www.framer.com">Made in Framer</a>
        </div>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, preserveFramerHydrationTargets: true });
    expect(out).toContain('__framer-badge-container');
    expect(out).toContain('__framer-badge');
    expect(out).toContain('#__framer-badge-container{display:none!important}');
    expect(out).toContain('real content');
  });

  it('removes inline scripts that bootstrap the editor bar', async () => {
    const html = `
      <html><body>
        <script>localStorage.setItem("__framer_force_showing_editorbar_since", "1")</script>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('__framer_force_showing_editorbar');
  });
});

describe('rewriteHtml — canonical URL override', () => {
  it('rewrites <link rel=canonical> when canonicalUrl is set', async () => {
    const html = `<link rel="canonical" href="https://old-site.framer.app/">`;
    const out = await rewriteHtml(html, { ...baseCtx, canonicalUrl: 'https://new-site.com/' });
    expect(out).toContain('href="https://new-site.com/"');
    expect(out).not.toContain('old-site.framer.app');
  });

  it('rewrites og:url + twitter:url', async () => {
    const html = `
      <meta property="og:url" content="https://old.framer.app/">
      <meta name="twitter:url" content="https://old.framer.app/">`;
    const out = await rewriteHtml(html, { ...baseCtx, canonicalUrl: 'https://new.com/' });
    expect(out).toContain('property="og:url" content="https://new.com/"');
    expect(out).toContain('name="twitter:url" content="https://new.com/"');
  });

  it('does NOT modify metadata when canonicalUrl is undefined', async () => {
    const html = `<link rel="canonical" href="https://orig.com/">`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('href="https://orig.com/"');
  });
});

describe('rewriteHtml — strip selectors', () => {
  // Important: text assertions are scoped to the document body — the injected
  // runtime stripper <script> echoes the selector strings (incl. literal text
  // for `:contains()`), so a naive substring check on `out` would false-positive.
  const bodyTextOf = async (html: string): Promise<string> => {
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    $('script').remove();
    return $('body').text();
  };

  it('removes matching elements from the SSR DOM', async () => {
    const html = `
      <html><body>
        <form><input value="Subscribe"></form>
        <p>Be the first to know about launches</p>
        <p>Keep me</p>
      </body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      stripSelectors: ['form:has(input[value="Subscribe"])', 'p:contains("Be the first")'],
    });
    const visibleText = await bodyTextOf(out);
    expect(visibleText).not.toMatch(/Subscribe/);
    expect(visibleText).not.toMatch(/Be the first/);
    expect(visibleText).toMatch(/Keep me/);
  });

  it('injects an anonymous runtime MutationObserver stripper for post-hydration coverage', async () => {
    const html = `<html><body><form><input value="Subscribe"></form></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      stripSelectors: ['form:has(input[value="Subscribe"])'],
    });
    // Anonymous (no identifying attribute) so it doesn't leak an exporter dependency
    expect(out).not.toContain('framer-html-exporter');
    expect(out).toContain('MutationObserver');
    // selector list is JSON-encoded inside the script
    expect(out).toContain('form:has(input[value=\\"Subscribe\\"])');
  });

  it('omits the runtime stripper entirely when no selectors are supplied', async () => {
    const html = `<html><body><p>x</p></body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('MutationObserver');
  });

  it('silently ignores invalid selectors instead of aborting', async () => {
    const html = `<p>content</p>`;
    const out = await rewriteHtml(html, { ...baseCtx, stripSelectors: ['!@#$%^'] });
    const visibleText = await bodyTextOf(out);
    expect(visibleText).toContain('content');
  });
});

describe('rewriteHtml — subscribeRedirect', () => {
  it('injects a MutationObserver redirector script with the given url and text', async () => {
    const html = `<html><body><form><input value="Subscribe"><button type="submit">Go</button></form></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      subscribeRedirect: { url: 'https://example.com', text: 'Try Now' },
    });
    expect(out).toContain('MutationObserver');
    expect(out).toContain('"https://example.com"');
    expect(out).toContain('"Try Now"');
    expect(out).toContain('data-sub-link');
    expect(out).toContain("a.target='_blank'");
  });

  it('defaults text to "Subscribe" when text is omitted', async () => {
    const html = `<html><body></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      subscribeRedirect: { url: 'https://example.com' },
    });
    expect(out).toContain('"Subscribe"');
  });

  it('does not inject the redirector when subscribeRedirect is unset', async () => {
    const html = `<html><body><form><input value="Subscribe"></form></body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('data-sub-link');
  });
});

describe('rewriteHtml — static runtime fixes', () => {
  it('injects reveal and scrollspy recovery only when requested', async () => {
    const html = `<html><body><div data-motion-reveal-target>Reveal me</div><div data-motion-reveal-item>Item</div></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('data-motion-reveal-target');
    expect(out).toContain('data-motion-reveal-item');
    expect(out).toContain('IntersectionObserver');
    expect(out).toContain('candidateAnchorGroups');
  });

  it('installs a preflight loader for hotlinked Next/Turbopack captures', async () => {
    const html = `<html><head><script src="/_next/static/chunks/app.js"></script></head><body></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('__turbopack_load_page_chunks__');
    expect(out).toContain('window.google.maps.__ib__');
    expect(out.indexOf('__turbopack_load_page_chunks__')).toBeLessThan(out.indexOf('/_next/static/chunks/app.js'));
  });

  it('adds static button shims when runtime page routes are available', async () => {
    const html = `<html><body><button class="search-button" type="button"></button></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      runtimePageMap: { '/home': './home/index.html', '/discover': './discover/index.html' },
    });
    expect(out).toContain('__STATIC_EXPORT_PAGE_MAP');
    expect(out).toContain('actionFallback');
    expect(out).toContain('scheduleFallback');
    expect(out).toContain('bootStaticInteractions');
    expect(out).toContain('bootHoverAnimations');
  });

  it('emits syntactically valid static runtime scripts', async () => {
    const html = `<html><body><button class="search-button" type="button"></button></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      runtimePageMap: { '/home': './home/index.html' },
    });
    const cheerio = await import('cheerio');
    const $ = cheerio.load(out);
    const scripts = $('script')
      .toArray()
      .map((node) => $(node).html() ?? '')
      .filter((script) => script.includes('bootStaticInteractions') || script.includes('__STATIC_EXPORT_PAGE_MAP'));

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('does not inject static runtime fixes by default', async () => {
    const html = `<html><body><div data-motion-reveal-target>Reveal me</div></body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('candidateAnchorGroups');
    expect(out).not.toContain('__turbopack_load_page_chunks__');
  });
});
