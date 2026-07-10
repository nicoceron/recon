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
});
