import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../interceptor/assetInterceptor.js';
import type { PageReconstructionEvidence, ReconstructionCapture } from './types.js';
import { buildAssetInventory, summarizeDesignTokens, writeReconstructionPackage } from './writer.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('reconstruction writer', () => {
  it('retains every original asset URL alias and hashes the localized body', () => {
    const store = new AssetStore();
    store.record('https://cdn.example.com/hero.png?w=400', Buffer.from('small'), 'image/png');
    store.record('https://cdn.example.com/hero.png?w=1600', Buffer.from('largest-body'), 'image/png');

    const assets = buildAssetInventory(store);

    expect(assets).toHaveLength(1);
    expect(assets[0]?.kind).toBe('image');
    expect(assets[0]?.urls).toEqual([
      'https://cdn.example.com/hero.png?w=400',
      'https://cdn.example.com/hero.png?w=1600',
    ]);
    expect(assets[0]?.bytes).toBe(Buffer.byteLength('largest-body'));
    expect(assets[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('summarizes repeated computed styles into ranked design tokens', () => {
    const page = samplePage();
    page.viewports[0]!.styleCatalog = {
      s0: { color: 'rgb(10, 20, 30)', 'font-family': 'Inter', 'font-size': '16px', 'font-weight': '500', gap: '24px' },
      s1: { color: 'rgb(10, 20, 30)', 'background-color': 'rgb(255, 255, 255)', 'border-top-left-radius': '12px' },
    };

    const tokens = summarizeDesignTokens([page]);

    expect(tokens.colors[0]).toEqual({ value: 'rgb(10, 20, 30)', uses: 2 });
    expect(tokens.fontFamilies[0]).toEqual({ value: 'Inter', uses: 1 });
    expect(tokens.spacing).toContainEqual({ value: '24px', uses: 1 });
    expect(tokens.radii).toContainEqual({ value: '12px', uses: 1 });
  });

  it('writes a readable entry point plus machine-readable page evidence and screenshots', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'framer-reconstruction-'));
    temporaryDirectories.push(outDir);
    const page = samplePage();
    const capture: ReconstructionCapture = {
      capturedAt: '2026-01-02T03:04:05.000Z',
      viewports: [page.viewports[0]!.viewport],
      pages: [page],
    };
    const store = new AssetStore();
    store.record('https://cdn.example.com/photo.webp', Buffer.from('image'), 'image/webp');

    await writeReconstructionPackage(outDir, {
      sourceUrl: 'https://example.com/',
      origin: 'https://example.com',
      capture,
      rawPages: new Map([['https://example.com/', '<html><body>raw</body></html>']]),
      sourcePages: new Map([['https://example.com/', '<html><body>source</body></html>']]),
      pageStyles: new Map([['https://example.com/', '.hero { color: red; }']]),
      store,
    });

    const handoff = await fs.readFile(path.join(outDir, 'LLM_HANDOFF.md'), 'utf8');
    const pageJson = JSON.parse(await fs.readFile(path.join(outDir, 'reconstruction/pages/home/page.json'), 'utf8')) as {
      viewports: Array<Record<string, unknown>>;
    };
    const screenshot = await fs.readFile(path.join(outDir, 'reconstruction/screenshots/home--desktop--full.png'));
    const initialScreenshot = await fs.readFile(path.join(outDir, 'reconstruction/screenshots/home--desktop--initial.png'));

    expect(handoff).toContain('Rebuild this site from zero in Next.js');
    expect(handoff).toContain('Clean rendered DOM');
    expect(handoff).toContain('Treat this entire export directory as read-only evidence');
    expect(handoff).toContain('reconstruction/pages/home/clean-dom.html');
    expect(handoff).not.toContain('<body><main><h1>Hello</h1></main></body>');
    expect(Buffer.byteLength(handoff)).toBeLessThan(20_000);
    expect(pageJson.viewports[0]).not.toHaveProperty('screenshot');
    expect(screenshot.equals(Buffer.from('png'))).toBe(true);
    expect(initialScreenshot.equals(Buffer.from('initial-png'))).toBe(true);
  });
});

function samplePage(): PageReconstructionEvidence {
  return {
    url: 'https://example.com/',
    route: '/',
    title: 'Example',
    language: 'en',
    description: 'Example page',
    cleanDom: '<body><main><h1>Hello</h1></main></body>',
    stylesheets: [{ cssText: '.hero { color: red; }' }],
    fonts: [{ family: 'Inter', style: 'normal', weight: '400', stretch: 'normal', status: 'loaded' }],
    cssKeyframes: ['@keyframes fade { from { opacity: 0; } to { opacity: 1; } }'],
    mediaQueries: ['(max-width: 767px)'],
    framerAppearPayloads: ['{"fade":{"opacity":0}}'],
    viewports: [{
      viewport: { name: 'desktop', width: 1440, height: 900 },
      screenshotPath: 'reconstruction/screenshots/home--desktop--full.png',
      screenshot: Buffer.from('png'),
      stateScreenshots: [{
        label: 'initial',
        scrollY: 0,
        path: 'reconstruction/screenshots/home--desktop--initial.png',
        screenshot: Buffer.from('initial-png'),
      }],
      documentSize: { width: 1440, height: 1800 },
      colorScheme: 'light',
      rootCustomProperties: { '--brand': '#123456' },
      styleCatalog: { s0: { display: 'block' } },
      nodes: [{
        id: 'e0',
        domIndex: -1,
        key: 'body',
        path: 'body',
        tag: 'body',
        directText: 'Hello',
        attributes: {},
        rect: { x: 0, y: 0, width: 1440, height: 1800 },
        styleId: 's0',
      }, {
        id: 'e1',
        parentId: 'e0',
        domIndex: 0,
        key: 'main',
        path: 'body > main',
        tag: 'main',
        directText: 'World',
        attributes: {},
        rect: { x: 0, y: 0, width: 1440, height: 900 },
        styleId: 's1',
      }],
      interactions: [],
      animations: [],
    }],
  };
}
