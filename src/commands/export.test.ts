import { describe, expect, it } from 'vitest';
import { AssetStore } from '../interceptor/assetInterceptor.js';
import { prepareSingleHtml } from './export.js';

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
});
