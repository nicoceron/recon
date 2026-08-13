import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AssetStore } from '../interceptor/assetInterceptor.js';
import type { PageReconstructionEvidence } from './types.js';
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

  it('writes only standalone HTML and the Astro migration tracker', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'framer-reconstruction-'));
    temporaryDirectories.push(outDir);
    const standaloneHtml = '<!doctype html><html><head><title>Example</title><style>@media (max-width: 767px){.hero{color:red}} @keyframes fade{from{opacity:0}to{opacity:1}}</style></head><body><nav data-framer-name="Landing"><a href="/about">About</a></nav><main><section data-framer-name="Hero Section" class="hero"><img src="https://cdn.example.com/photo.webp" alt="Photo"><h1>Hello</h1></section></main><script data-standalone-framer-runtime>const init_demo_exports={};</script></body></html>';
    const page = samplePage();
    const store = new AssetStore();
    store.record('https://cdn.example.com/photo.webp', Buffer.from('image-body'), 'image/webp');
    store.recordIssue({
      url: 'https://cdn.example.com/legacy-favicon.png',
      reason: 'source-missing',
      detail: 'top-up status=404',
    });

    await writeReconstructionPackage(outDir, {
      sourceUrl: 'https://example.com/',
      standaloneHtml,
      origin: 'https://example.com',
      capture: {
        capturedAt: '2026-08-12T00:00:00.000Z',
        viewports: [{ name: 'desktop', width: 1440, height: 900, source: 'required', core: true }],
        pages: [page],
        coverage: {
          requestedRoutes: ['https://example.com/'],
          capturedRoutes: ['https://example.com/'],
          failedRoutes: [],
          discoveryFailures: [],
          requestedViewports: [{ name: 'desktop', width: 1440, height: 900, source: 'required', core: true }],
          discoveredBreakpoints: [767],
          capturedViewportCount: 1,
          failedViewports: [],
          interactionCandidates: 0,
          interactionStatesCaptured: 0,
          assetsCaptured: 0,
          assetBytes: 0,
          assetIssues: [],
        },
        environment: {
          browser: 'chromium test',
          userAgent: 'test',
          platform: 'test',
          locale: 'en-US',
          timezone: 'UTC',
          colorScheme: 'light',
          reducedMotion: 'no-preference',
        },
      },
      rawPages: new Map([['https://example.com/', standaloneHtml]]),
      sourcePages: new Map([['https://example.com/', standaloneHtml]]),
      pageStyles: new Map([['https://example.com/', '.hero{color:red}']]),
      store,
      projectEvidence: {
        schemaVersion: 1,
        source: 'official-framer-server-api',
        projectUrl: 'https://framer.com/projects/Example--id',
        capturedAt: '2026-08-12T00:00:00.000Z',
        canvas: { rootId: 'root', nodes: [{ id: 'root' }] },
        collections: [],
        codeFiles: [{ id: 'code-1', name: 'Hero.tsx', path: 'Hero.tsx', content: 'export default function Hero() {}', exports: [], versionId: 'v1' }],
        locales: [],
        localizationGroups: [],
        redirects: [],
        colorStyles: [],
        textStyles: [],
        variables: [],
        errors: [],
      },
    });

    const entries = (await fs.readdir(outDir)).sort();
    const source = await fs.readFile(path.join(outDir, 'standalone.html'), 'utf8');
    const tracker = await fs.readFile(path.join(outDir, 'ASTRO_MIGRATION_TRACKER.csv'), 'utf8');
    const evidenceMarker = '<script id="reconstruction-evidence" type="application/x-reconstruction-evidence+json" data-schema-version="2">';
    const evidenceStart = source.indexOf(evidenceMarker) + evidenceMarker.length;
    const evidenceEnd = source.indexOf('</script>', evidenceStart);
    const evidence = JSON.parse(source.slice(evidenceStart, evidenceEnd));
    const sourceBeforeEvidence = source.slice(0, source.indexOf(evidenceMarker)) + source.slice(evidenceEnd + '</script>\n'.length);

    expect(entries).toEqual(['ASTRO_MIGRATION_TRACKER.csv', 'standalone.html']);
    expect(source).toContain('<section data-framer-name="Hero Section"');
    expect(source).toContain('id="reconstruction-evidence"');
    expect(source).toContain('application/x-reconstruction-evidence+json');
    expect(source).toContain('data:image/webp;base64,aW1hZ2UtYm9keQ==');
    expect(evidence.assets[0]).toMatchObject({ blobIndex: 0, bytes: 10 });
    expect(evidence.assets[0].dataUrl).toBeUndefined();
    expect(evidence.assetBlobs).toHaveLength(1);
    expect(evidence.assetBlobs[0].dataUrl).toBe('data:image/webp;base64,aW1hZ2UtYm9keQ==');
    expect(evidence.coverage.assetIssues).toEqual([]);
    expect(evidence.coverage.assetWarnings).toEqual([{
      url: 'https://cdn.example.com/legacy-favicon.png',
      reason: 'source-missing',
      detail: 'top-up status=404',
    }]);
    expect(evidence.sourceFingerprint).toEqual({
      bytesBeforeEvidence: Buffer.byteLength(sourceBeforeEvidence),
      sha256BeforeEvidence: crypto.createHash('sha256').update(sourceBeforeEvidence).digest('hex'),
    });
    expect(tracker).toContain('id,category,priority,status,owner');
    expect(tracker).toContain('evidence:capsule');
    expect(tracker).toContain('responsive-capture:1:1');
    expect(tracker).toContain('embedded-asset:');
    expect(tracker).toContain('evidence:framer-project');
    expect(tracker).toContain('framer-code-file:');
    expect(tracker).toContain('evidence:source-asset-warnings,source-warning,P2');
    expect(tracker).not.toContain('asset-capture-issue:');
    expect(tracker).toContain('section:/1');
    expect(tracker).toContain('head-node:1');
    expect(tracker).toContain('css:keyframe:');
    expect(tracker).toContain('asset:');
    expect(tracker.split('\n').length).toBeGreaterThan(10);
  });

  it('embeds identical asset bodies once and maps every source alias to the shared blob', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'framer-reconstruction-dedup-'));
    temporaryDirectories.push(outDir);
    const store = new AssetStore();
    const sharedBody = Buffer.from('one exact binary body');
    store.record('https://cdn.example.com/a.png', sharedBody, 'image/png');
    store.record('https://cdn.example.com/b.png', sharedBody, 'image/png');
    const page = samplePage();
    const capture = {
      capturedAt: '2026-08-12T00:00:00.000Z',
      viewports: [{ name: 'desktop', width: 1440, height: 900, source: 'required' as const, core: true }],
      pages: [page],
      coverage: {
        requestedRoutes: ['https://example.com/'], capturedRoutes: ['https://example.com/'], failedRoutes: [],
        discoveryFailures: [], requestedViewports: [{ name: 'desktop', width: 1440, height: 900, source: 'required' as const, core: true }],
        discoveredBreakpoints: [], capturedViewportCount: 1, failedViewports: [], interactionCandidates: 0,
        interactionStatesCaptured: 0, assetsCaptured: 0, assetBytes: 0, assetIssues: [],
      },
      environment: { browser: 'chromium test', userAgent: 'test', platform: 'test', locale: 'en-US', timezone: 'UTC', reducedMotion: 'no-preference' },
    };

    await writeReconstructionPackage(outDir, {
      sourceUrl: 'https://example.com/', standaloneHtml: '<html><body>Example</body></html>', origin: 'https://example.com',
      capture, rawPages: new Map(), pageStyles: new Map(), store,
    });

    const html = await fs.readFile(path.join(outDir, 'standalone.html'), 'utf8');
    const marker = '<script id="reconstruction-evidence" type="application/x-reconstruction-evidence+json" data-schema-version="2">';
    const start = html.indexOf(marker) + marker.length;
    const evidence = JSON.parse(html.slice(start, html.indexOf('</script>', start)));
    const tracker = await fs.readFile(path.join(outDir, 'ASTRO_MIGRATION_TRACKER.csv'), 'utf8');

    expect(evidence.assets).toHaveLength(2);
    expect(evidence.assets.map((asset: { blobIndex: number }) => asset.blobIndex)).toEqual([0, 0]);
    expect(evidence.assetBlobs).toHaveLength(1);
    expect(evidence.coverage).toMatchObject({ uniqueAssetBlobs: 1, uniqueAssetBytes: sharedBody.length });
    expect(tracker.match(/embedded-asset:/g)).toHaveLength(1);
  });

  it('tracks legacy namespaced elements without parsing their names as pseudo-classes', async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'framer-reconstruction-namespaced-'));
    temporaryDirectories.push(outDir);
    const store = new AssetStore();
    const page = samplePage();
    const standaloneHtml = '<html><body><pgf:pgfref id="a">One</pgf:pgfref><pgf:pgfref>Two</pgf:pgfref></body></html>';

    await writeReconstructionPackage(outDir, {
      sourceUrl: 'https://example.com/', standaloneHtml, origin: 'https://example.com',
      capture: {
        capturedAt: '2026-08-12T00:00:00.000Z',
        viewports: [{ name: 'desktop', width: 1440, height: 900, source: 'required', core: true }],
        pages: [page],
        coverage: {
          requestedRoutes: ['https://example.com/'], capturedRoutes: ['https://example.com/'], failedRoutes: [],
          discoveryFailures: [], requestedViewports: [{ name: 'desktop', width: 1440, height: 900, source: 'required', core: true }],
          discoveredBreakpoints: [], capturedViewportCount: 1, failedViewports: [], interactionCandidates: 0,
          interactionStatesCaptured: 0, assetsCaptured: 0, assetBytes: 0, assetIssues: [],
        },
        environment: { browser: 'chromium test', userAgent: 'test', platform: 'test', locale: 'en-US', timezone: 'UTC', reducedMotion: 'no-preference' },
      },
      rawPages: new Map(), pageStyles: new Map(), store,
    });

    const tracker = await fs.readFile(path.join(outDir, 'ASTRO_MIGRATION_TRACKER.csv'), 'utf8');
    expect(tracker).toContain('pgf:pgfref:nth-of-type(2)');
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
      network: [],
      diagnostics: [],
    }],
  };
}
