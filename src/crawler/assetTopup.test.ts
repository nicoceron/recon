import { describe, expect, it } from 'vitest';
import type { BrowserContext } from 'playwright';
import { AssetStore } from '../interceptor/assetInterceptor.js';
import { collectUrlsFromText, topupAssets } from './assetTopup.js';

describe('collectUrlsFromText', () => {
  it('collects relative JS module dependencies against the captured bundle URL', () => {
    const urls = new Set<string>();

    collectUrlsFromText(
      'import{a as b}from"./chunk.mjs";const utils=()=>import(`./collection-utils.mjs`);export{x}from"../shared.mjs";',
      urls,
      'https://framerusercontent.com/sites/site-id/script_main.mjs',
    );

    expect(Array.from(urls).sort()).toEqual([
      'https://framerusercontent.com/sites/shared.mjs',
      'https://framerusercontent.com/sites/site-id/chunk.mjs',
      'https://framerusercontent.com/sites/site-id/collection-utils.mjs',
    ]);
  });

  it('still collects absolute Framer asset URLs embedded in text', () => {
    const urls = new Set<string>();

    collectUrlsFromText(
      'const image = "https://framerusercontent.com/images/example.png?width=1200&height=800";',
      urls,
    );

    expect(urls).toEqual(new Set(['https://framerusercontent.com/images/example.png?width=1200&height=800']));
  });

  it('collects Framer CMS files constructed from module new URL bases', () => {
    const urls = new Set<string>();

    collectUrlsFromText(
      'new URL(`./collection-indexes-default-0.framercms`,`https://framerusercontent.com/modules/project/module/collection.js`).href.replace(`/modules/`,`/cms/`)',
      urls,
    );

    expect(urls).toContain('https://framerusercontent.com/cms/project/module/collection-indexes-default-0.framercms');
  });

  it('recursively fetches module dependencies discovered in top-up assets', async () => {
    const store = new AssetStore();
    const pages = new Map([
      [
        'https://courso.framer.website/',
        '<script type="module" src="https://framerusercontent.com/sites/site-id/entry.mjs"></script>',
      ],
    ]);
    const responses = new Map([
      [
        'https://framerusercontent.com/sites/site-id/entry.mjs',
        'import{a as e}from"./chunk.mjs";export{e};',
      ],
      ['https://framerusercontent.com/sites/site-id/chunk.mjs', 'export const a = 1;'],
    ]);
    const fetched: string[] = [];
    const context = {
      request: {
        fetch: async (url: string) => {
          fetched.push(url);
          const body = responses.get(url);
          return {
            status: () => (body ? 200 : 404),
            body: async () => Buffer.from(body ?? ''),
            headers: () => ({ 'content-type': 'text/javascript' }),
          };
        },
      },
    } as unknown as BrowserContext;

    const result = await topupAssets(context, pages, store);

    expect(result).toMatchObject({ fetched: 2, failed: 0 });
    expect(fetched).toEqual([
      'https://framerusercontent.com/sites/site-id/entry.mjs',
      'https://framerusercontent.com/sites/site-id/chunk.mjs',
    ]);
    expect(store.has('https://framerusercontent.com/sites/site-id/entry.mjs')).toBe(true);
    expect(store.has('https://framerusercontent.com/sites/site-id/chunk.mjs')).toBe(true);
  });

  it('tops up same-origin framework assets without treating page links as assets', async () => {
    const store = new AssetStore();
    const pages = new Map([
      [
        'https://example.com/',
        '<script src="/_next/static/app.js"></script><img src="/_next/image?url=%2Fimages%2Fhero.jpg&w=1200&q=75"><a href="/pricing">Pricing</a>',
      ],
    ]);
    const fetched: string[] = [];
    const context = {
      request: {
        fetch: async (url: string) => {
          fetched.push(url);
          return {
            status: () => 200,
            body: async () => Buffer.from(url.endsWith('.js') ? 'export{}' : 'image'),
            headers: () => ({
              'content-type': url.endsWith('.js') ? 'text/javascript' : 'image/webp',
            }),
          };
        },
      },
    } as unknown as BrowserContext;

    const result = await topupAssets(context, pages, store);

    expect(result).toMatchObject({ fetched: 2, failed: 0 });
    expect(fetched).toEqual([
      'https://example.com/_next/static/app.js',
      'https://example.com/_next/image?url=%2Fimages%2Fhero.jpg&w=1200&q=75',
    ]);
    expect(fetched).not.toContain('https://example.com/pricing');
  });

  it('does not treat ordinary meta content as a relative asset URL', async () => {
    const store = new AssetStore();
    const pages = new Map([
      [
        'https://example.com/',
        '<meta name="description" content="A concise page description">' +
          '<meta property="og:image" content="/social.png">' +
          '<meta property="og:image:type" content="image/png">' +
          '<meta property="og:image:width" content="1200">' +
          '<meta property="og:image:height" content="630">',
      ],
    ]);
    const fetched: string[] = [];
    const context = {
      request: {
        fetch: async (url: string) => {
          fetched.push(url);
          return {
            status: () => 200,
            body: async () => Buffer.from('image'),
            headers: () => ({ 'content-type': 'image/png' }),
          };
        },
      },
    } as unknown as BrowserContext;

    await topupAssets(context, pages, store);

    expect(fetched).toEqual(['https://example.com/social.png']);
    expect(fetched).not.toContain('https://example.com/A%20concise%20page%20description');
    expect(fetched).not.toContain('https://example.com/image/png');
    expect(fetched).not.toContain('https://example.com/1200');
    expect(fetched).not.toContain('https://example.com/630');
  });

  it('ignores connection and navigation link hints while retaining fetchable link assets', async () => {
    const store = new AssetStore();
    const pages = new Map([
      [
        'https://example.com/',
        '<link rel="preconnect" href="https://fonts.gstatic.com/">' +
          '<link rel="canonical" href="https://example.com/">' +
          '<link rel="stylesheet" href="https://cdn.assets.test/site.css">' +
          '<link rel="preload" as="font" href="https://cdn.assets.test/site.woff2">',
      ],
    ]);
    const fetched: string[] = [];
    const context = {
      request: {
        fetch: async (url: string) => {
          fetched.push(url);
          return {
            status: () => 200,
            body: async () => Buffer.from('asset'),
            headers: () => ({ 'content-type': url.endsWith('.css') ? 'text/css' : 'font/woff2' }),
          };
        },
      },
    } as unknown as BrowserContext;

    await topupAssets(context, pages, store);

    expect(fetched).toEqual([
      'https://cdn.assets.test/site.css',
      'https://cdn.assets.test/site.woff2',
    ]);
  });

  it('tops up explicitly referenced assets from arbitrary CDN hosts', async () => {
    const store = new AssetStore();
    const pages = new Map([
      ['https://example.com/', '<img srcset="https://cdn.assets.test/hero-400.webp 400w, https://cdn.assets.test/hero-1600.webp 1600w">'],
    ]);
    const fetched: string[] = [];
    const context = {
      request: {
        fetch: async (url: string) => {
          fetched.push(url);
          return {
            status: () => 200,
            body: async () => Buffer.from('image'),
            headers: () => ({ 'content-type': 'image/webp' }),
          };
        },
      },
    } as unknown as BrowserContext;

    await topupAssets(context, pages, store);

    expect(fetched).toEqual([
      'https://cdn.assets.test/hero-400.webp',
      'https://cdn.assets.test/hero-1600.webp',
    ]);
  });

  it('records publisher non-success responses as source warnings', async () => {
    const store = new AssetStore();
    const pages = new Map([
      ['https://example.com/', '<link rel="icon" href="/missing-favicon.png">'],
    ]);
    const context = {
      request: {
        fetch: async () => ({
          status: () => 404,
          body: async () => Buffer.alloc(0),
          headers: () => ({ 'content-type': 'text/html' }),
        }),
      },
    } as unknown as BrowserContext;

    const result = await topupAssets(context, pages, store);

    expect(result).toMatchObject({ fetched: 0, failed: 1 });
    expect(store.issues()).toEqual([
      {
        url: 'https://example.com/missing-favicon.png',
        reason: 'source-missing',
        detail: 'top-up status=404',
      },
    ]);
  });

  it('records an unresolvable source host separately from transient fetch failures', async () => {
    const store = new AssetStore();
    const pages = new Map([
      ['https://example.com/', '<script src="https://retired-cdn.invalid/embed.js"></script>'],
    ]);
    const context = {
      request: {
        fetch: async () => {
          throw new Error('getaddrinfo ENOTFOUND retired-cdn.invalid');
        },
      },
    } as unknown as BrowserContext;

    await topupAssets(context, pages, store);

    expect(store.issues()).toEqual([
      {
        url: 'https://retired-cdn.invalid/embed.js',
        reason: 'source-unreachable',
        detail: 'top-up: getaddrinfo ENOTFOUND retired-cdn.invalid',
      },
    ]);
  });
});
