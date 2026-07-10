import crypto from 'node:crypto';
import type { AssetStore } from '../interceptor/assetInterceptor.js';
import { writeFileEnsured } from '../output/fileWriter.js';
import type { StaticInteractionSnapshot } from '../rewriter/htmlRewriter.js';
import { rootRelativeAssetPath } from '../utils/urlUtils.js';
import { routeSlug } from './capture.js';
import type {
  DesignTokenSummary,
  PageReconstructionEvidence,
  ReconstructionAsset,
  ReconstructionCapture,
  StyleEvidence,
} from './types.js';

export interface WriteReconstructionOptions {
  sourceUrl: string;
  origin: string;
  capture: ReconstructionCapture;
  rawPages: Map<string, string>;
  sourcePages?: Map<string, string>;
  pageStyles: Map<string, string>;
  store: AssetStore;
  openStateSnapshots?: Record<string, StaticInteractionSnapshot>;
}

interface PageIndexEntry {
  url: string;
  route: string;
  title: string;
  pageDataPath: string;
  rawHtmlPath: string;
  sourceHtmlPath: string;
  cleanDomPath: string;
  cssPath: string;
  screenshots: Array<{ viewport: string; path: string; width: number; height: number }>;
}

export async function writeReconstructionPackage(
  outDir: string,
  opts: WriteReconstructionOptions,
): Promise<void> {
  const assets = buildAssetInventory(opts.store);
  const designTokens = summarizeDesignTokens(opts.capture.pages);
  const pageIndex: PageIndexEntry[] = [];

  for (const page of opts.capture.pages) {
    const slug = artifactSlug(page.url);
    const base = `reconstruction/pages/${slug}`;
    const rawHtmlPath = `${base}/raw-hydrated.html`;
    const sourceHtmlPath = `${base}/source-response.html`;
    const cleanDomPath = `${base}/clean-dom.html`;
    const cssPath = `${base}/styles.css`;
    const pageDataPath = `${base}/page.json`;

    await writeFileEnsured(outDir, rawHtmlPath, opts.rawPages.get(page.url) ?? page.cleanDom);
    await writeFileEnsured(outDir, sourceHtmlPath, opts.sourcePages?.get(page.url) ?? opts.rawPages.get(page.url) ?? page.cleanDom);
    await writeFileEnsured(outDir, cleanDomPath, page.cleanDom);
    await writeFileEnsured(outDir, cssPath, combinedCss(page, opts.pageStyles.get(page.url)));
    await writeFileEnsured(
      outDir,
      `${base}/framer-appear.json`,
      JSON.stringify(page.framerAppearPayloads.map(parseJsonIfPossible), null, 2),
    );

    const viewports = [];
    for (const viewport of page.viewports) {
      await writeFileEnsured(outDir, viewport.screenshotPath, viewport.screenshot);
      const stateScreenshots = [];
      for (const state of viewport.stateScreenshots) {
        await writeFileEnsured(outDir, state.path, state.screenshot);
        const { screenshot: _stateScreenshot, ...stateMetadata } = state;
        stateScreenshots.push(stateMetadata);
      }
      const { screenshot: _screenshot, stateScreenshots: _stateScreenshots, ...serializable } = viewport;
      viewports.push({ ...serializable, stateScreenshots });
    }

    const pageData = {
      schemaVersion: 1,
      url: page.url,
      route: page.route,
      title: page.title,
      language: page.language,
      description: page.description,
      files: { sourceHtmlPath, rawHtmlPath, cleanDomPath, cssPath, framerAppearPath: `${base}/framer-appear.json` },
      fonts: page.fonts,
      mediaQueries: page.mediaQueries,
      cssKeyframes: page.cssKeyframes,
      stylesheets: page.stylesheets.map(({ cssText: _cssText, ...stylesheet }) => stylesheet),
      viewports,
    };
    await writeFileEnsured(outDir, pageDataPath, JSON.stringify(pageData, null, 2));

    pageIndex.push({
      url: page.url,
      route: page.route,
      title: page.title,
      pageDataPath,
      rawHtmlPath,
      sourceHtmlPath,
      cleanDomPath,
      cssPath,
      screenshots: viewports.map((item) => ({
        viewport: item.viewport.name,
        path: item.screenshotPath,
        width: item.viewport.width,
        height: item.viewport.height,
      })),
    });
  }

  await writeFileEnsured(outDir, 'reconstruction/assets.json', JSON.stringify(assets, null, 2));
  await writeFileEnsured(outDir, 'reconstruction/design-tokens.json', JSON.stringify(designTokens, null, 2));
  await writeFileEnsured(
    outDir,
    'reconstruction/open-states.json',
    JSON.stringify(opts.openStateSnapshots ?? {}, null, 2),
  );

  const index = {
    schemaVersion: 1,
    purpose: 'Ground-truth evidence for rebuilding the captured site in Next.js without depending on Framer at runtime.',
    sourceUrl: opts.sourceUrl,
    origin: opts.origin,
    capturedAt: opts.capture.capturedAt,
    generator: 'framer-html-exporter',
    handoffPath: 'LLM_HANDOFF.md',
    evidencePolicy: 'read-only',
    captureViewports: opts.capture.viewports,
    pages: pageIndex,
    assetsPath: 'reconstruction/assets.json',
    designTokensPath: 'reconstruction/design-tokens.json',
    openStatesPath: 'reconstruction/open-states.json',
    staticMirrorEntry: 'index.html',
    assetCount: assets.length,
    notes: [
      'Use screenshots as visual ground truth and page.json geometry/style catalogs as measurement evidence.',
      'Use clean-dom.html for semantic structure, source-response.html for framework replay, and raw-hydrated.html for post-runtime evidence.',
      'styles.css contains accessible CSSOM, media queries, keyframes, font-face declarations, and authored selectors.',
      'assets/ contains localized images, fonts, media, CSS, and the captured Framer module graph.',
      'Do not ship the captured Framer runtime in the reconstruction; reimplement behavior with React, CSS/Tailwind, and animation libraries.',
    ],
  };
  await writeFileEnsured(outDir, 'reconstruction/reconstruction.json', JSON.stringify(index, null, 2));
  await writeFileEnsured(outDir, 'LLM_HANDOFF.md', buildHandoffMarkdown(opts, pageIndex, assets, designTokens));
}

export function buildAssetInventory(store: AssetStore): ReconstructionAsset[] {
  const urlsByPath = new Map<string, string[]>();
  for (const [url, localPath] of store.urlMap()) {
    const urls = urlsByPath.get(localPath) ?? [];
    if (!urls.includes(url)) urls.push(url);
    urlsByPath.set(localPath, urls);
  }

  return store.all()
    .map((record) => ({
      urls: urlsByPath.get(record.localPath) ?? [record.url],
      localPath: rootRelativeAssetPath(record.localPath).replace(/^\//, ''),
      bytes: record.body.length,
      contentType: record.contentType,
      kind: assetKind(record.contentType, record.localPath),
      sha256: crypto.createHash('sha256').update(record.body).digest('hex'),
    }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.localPath.localeCompare(b.localPath));
}

export function summarizeDesignTokens(pages: PageReconstructionEvidence[]): DesignTokenSummary {
  const tallies = {
    colors: new Map<string, number>(),
    fontFamilies: new Map<string, number>(),
    fontSizes: new Map<string, number>(),
    fontWeights: new Map<string, number>(),
    spacing: new Map<string, number>(),
    radii: new Map<string, number>(),
    shadows: new Map<string, number>(),
  };
  for (const page of pages) {
    for (const viewport of page.viewports) {
      for (const node of viewport.nodes) {
        if (node.rect.width <= 0 || node.rect.height <= 0) continue;
        const style = viewport.styleCatalog[node.styleId];
        if (style) tallyStyle(style, tallies, node.directText !== undefined || node.textContent !== undefined, node.tag);
        if (node.before) {
          const beforeStyle = viewport.styleCatalog[node.before.styleId];
          if (beforeStyle) tallyStyle(beforeStyle, tallies, true, 'pseudo');
        }
        if (node.after) {
          const afterStyle = viewport.styleCatalog[node.after.styleId];
          if (afterStyle) tallyStyle(afterStyle, tallies, true, 'pseudo');
        }
      }
    }
  }

  return {
    colors: ranked(tallies.colors),
    fontFamilies: ranked(tallies.fontFamilies),
    fontSizes: ranked(tallies.fontSizes),
    fontWeights: ranked(tallies.fontWeights),
    spacing: ranked(tallies.spacing),
    radii: ranked(tallies.radii),
    shadows: ranked(tallies.shadows),
  };
}

function tallyStyle(
  style: StyleEvidence,
  tallies: Record<keyof DesignTokenSummary, Map<string, number>>,
  hasText: boolean,
  tag: string,
): void {
  const add = (map: Map<string, number>, value?: string, ignored = /^(?:none|normal|auto|0px|rgba\(0, 0, 0, 0\))$/i) => {
    const normalized = value?.trim();
    if (!normalized || ignored.test(normalized)) return;
    map.set(normalized, (map.get(normalized) ?? 0) + 1);
  };
  if (hasText) add(tallies.colors, style.color);
  add(tallies.colors, style['background-color']);
  if (/^(?:svg|path|circle|ellipse|line|polyline|polygon|rect|text|use|g|stop)$/i.test(tag)) {
    add(tallies.colors, style.fill);
    add(tallies.colors, style.stroke);
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (style[`border-${side}-style`] !== 'none' && parseFloat(style[`border-${side}-width`] ?? '0') > 0) {
      add(tallies.colors, style[`border-${side}-color`]);
    }
  }
  if (hasText) {
    add(tallies.fontFamilies, style['font-family'], /^$/);
    add(tallies.fontSizes, style['font-size'], /^$/);
    add(tallies.fontWeights, style['font-weight'], /^$/);
  }
  for (const property of [
    'gap', 'row-gap', 'column-gap', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  ]) add(tallies.spacing, style[property]);
  for (const property of ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius']) {
    add(tallies.radii, style[property]);
  }
  add(tallies.shadows, style['box-shadow']);
  add(tallies.shadows, style['text-shadow']);
}

function ranked(values: Map<string, number>): Array<{ value: string; uses: number }> {
  return Array.from(values, ([value, uses]) => ({ value, uses }))
    .sort((a, b) => b.uses - a.uses || a.value.localeCompare(b.value));
}

function assetKind(contentType: string, localPath: string): ReconstructionAsset['kind'] {
  const value = contentType.toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('font/') || /\.(?:woff2?|ttf|otf)$/i.test(localPath)) return 'font';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  if (value.includes('css')) return 'css';
  if (value.includes('javascript') || /\.(?:m?js)$/i.test(localPath)) return 'javascript';
  if (value.includes('json') || value.includes('xml') || value.startsWith('text/')) return 'data';
  return 'other';
}

function combinedCss(page: PageReconstructionEvidence, crawlerCss?: string): string {
  const chunks = new Set<string>();
  if (crawlerCss?.trim()) chunks.add(crawlerCss.trim());
  for (const stylesheet of page.stylesheets) {
    if (stylesheet.cssText?.trim()) chunks.add(stylesheet.cssText.trim());
  }
  return Array.from(chunks).join('\n\n/* ---- captured stylesheet boundary ---- */\n\n');
}

function buildHandoffMarkdown(
  opts: WriteReconstructionOptions,
  pageIndex: PageIndexEntry[],
  assets: ReconstructionAsset[],
  tokens: DesignTokenSummary,
): string {
  const lines: string[] = [
    '# Next.js reconstruction handoff',
    '',
    `Source: ${opts.sourceUrl}`,
    `Captured: ${opts.capture.capturedAt}`,
    '',
    '## Mission',
    '',
    'Rebuild this site from zero in Next.js. Match the supplied screenshots at every captured viewport, preserve all content and routes, use the localized assets and fonts, and reproduce every observed transition, keyframe, scroll animation, hover/focus state, overlay, and interaction. Do not depend on Framer or ship its captured runtime in the finished app.',
    '',
    'Treat screenshots as visual ground truth. Treat geometry/computed styles in each `page.json` as measurement evidence, `clean-dom.html` as the semantic content map, `styles.css` as authored responsive/animation evidence, and `source-response.html`, `raw-hydrated.html`, plus `assets/` as forensic fallbacks.',
    '',
    '## Working contract',
    '',
    '- Treat this entire export directory as read-only evidence. Make all implementation changes in the separate Next.js repository.',
    '- Keep the directory intact: this handoff deliberately links to neighboring evidence instead of inlining megabytes of DOM, CSS, runtime payloads, and binaries.',
    '- Before coding, confirm that `reconstruction/reconstruction.json`, `reconstruction/assets.json`, every route `page.json`, and the referenced screenshots are readable. If they are missing, request the complete export directory instead of guessing.',
    '- Read evidence progressively: site index first, then the current route screenshots and `page.json`, then its clean DOM/CSS, and only then raw/source HTML or module evidence when a detail remains ambiguous.',
    '- Do not modify the export, implement the site by embedding `index.html`, paste the hydrated DOM as application code, or load every evidence file into context at once.',
    '',
    '## Evidence map',
    '',
    '- `reconstruction/reconstruction.json`: machine-readable site index and capture contract.',
    '- `reconstruction/pages/*/page.json`: element tree, exact rectangles, deduplicated computed styles, responsive states, runtime animations, and interactive-state diffs.',
    '- `reconstruction/pages/*/source-response.html`: original server HTML before React/Next/SPA hydration.',
    '- `reconstruction/pages/*/clean-dom.html`: script-free rendered DOM for rebuilding components.',
    '- `reconstruction/pages/*/styles.css`: accessible CSSOM including media queries, font faces, selectors, transitions, and keyframes.',
    '- `reconstruction/assets.json`: complete original-URL to local-file mapping with content types and hashes.',
    '- `reconstruction/open-states.json`: captured click-opened menus, dialogs, drawers, and popovers.',
    '- `assets/`: localized images, fonts, media, styles, and raw module evidence.',
    '- `index.html`: fidelity reference mirror only; do not use it as the implementation.',
    '',
    '## Routes and visual references',
    '',
    '| Route | Title | Captures | Detailed evidence |',
    '| --- | --- | --- | --- |',
  ];

  for (const page of pageIndex) {
    const screenshots = page.screenshots.map((shot) => `${shot.viewport} ${shot.width}×${shot.height}: \`${shot.path}\``).join('<br>');
    lines.push(`| ${escapeTable(page.route)} | ${escapeTable(page.title)} | ${screenshots} | \`${page.pageDataPath}\` |`);
  }

  lines.push('', '## Recommended implementation order', '');
  lines.push('1. Inspect the target repository and preserve its package manager, Next.js version, conventions, and existing user changes.');
  lines.push('2. Read `reconstruction/reconstruction.json` and turn its route/viewport inventory into an implementation checklist.');
  lines.push('3. Load captured fonts, establish global tokens and layout primitives, and implement shared navigation/footer structure.');
  lines.push('4. Implement one route at a time using its screenshots, `page.json`, clean DOM, and CSS; validate every captured viewport before moving on.');
  lines.push('5. Add observed interactions and animation timing from the route evidence and `reconstruction/open-states.json`.');
  lines.push('6. Run the Next.js app, compare exact viewport screenshots, and iterate until material visual and behavioral differences are resolved.');

  lines.push('', '## Recovered design system', '');
  lines.push(`- Colors: ${formatTokens(tokens.colors, 24)}`);
  lines.push(`- Font families: ${formatTokens(tokens.fontFamilies, 16)}`);
  lines.push(`- Font sizes: ${formatTokens(tokens.fontSizes, 24)}`);
  lines.push(`- Font weights: ${formatTokens(tokens.fontWeights, 16)}`);
  lines.push(`- Spacing values: ${formatTokens(tokens.spacing, 32)}`);
  lines.push(`- Corner radii: ${formatTokens(tokens.radii, 20)}`);
  lines.push(`- Shadows: ${formatTokens(tokens.shadows, 16)}`);

  const fonts = uniqueFonts(opts.capture.pages);
  lines.push('', '## Fonts', '');
  for (const font of fonts) lines.push(`- ${font.family}; weight ${font.weight}; style ${font.style}; stretch ${font.stretch}; captured status ${font.status}`);

  for (const page of opts.capture.pages) appendPageMarkdown(lines, page, artifactSlug(page.url));

  lines.push('', '## Localized assets', '');
  lines.push(`Inventory: ${formatAssetCounts(assets)}.`);
  lines.push('Use `reconstruction/assets.json` to resolve each original URL to its localized file, content type, byte size, and hash. Binary assets and the potentially long URL list are intentionally not duplicated in this handoff. Inspect and import the files under `assets/` as needed for the route being built.');

  lines.push('', '## Acceptance checklist', '');
  lines.push('- Compare the rebuilt route against every supplied full-page screenshot at the exact viewport size.');
  lines.push('- Validate typography only after loading the captured local font files and matching weight/style declarations.');
  lines.push('- Verify desktop, tablet, and mobile layout independently; do not infer mobile by merely stacking desktop sections.');
  lines.push('- Exercise every listed link/control and compare hover, focus, open, closed, scroll, and entrance states.');
  lines.push('- Reproduce timing, delay, easing, transform origin, and stagger order from CSS/WAAPI/Framer appear evidence.');
  lines.push('- Confirm the finished Next.js app has no request to a Framer runtime, module, analytics, or asset host.');

  return lines.join('\n') + '\n';
}

function appendPageMarkdown(lines: string[], page: PageReconstructionEvidence, slug: string): void {
  lines.push('', `## Page: ${page.route}`, '');
  lines.push(`Title: ${page.title}`);
  if (page.description) lines.push(`Description: ${page.description}`);
  lines.push('');
  lines.push(`- Route data and exact state evidence: \`reconstruction/pages/${slug}/page.json\``);
  lines.push(`- Clean rendered DOM: \`reconstruction/pages/${slug}/clean-dom.html\``);
  lines.push(`- Captured CSSOM: \`reconstruction/pages/${slug}/styles.css\``);
  lines.push(`- Original server HTML: \`reconstruction/pages/${slug}/source-response.html\``);
  lines.push(`- Post-hydration forensic DOM: \`reconstruction/pages/${slug}/raw-hydrated.html\``);
  lines.push(`- Framer entrance payloads: \`reconstruction/pages/${slug}/framer-appear.json\``);
  lines.push('');
  for (const viewport of page.viewports) {
    const visibleNodes = viewport.nodes.filter((node) => node.rect.width > 0 && node.rect.height > 0).length;
    const states = viewport.stateScreenshots.map((state) => `\`${state.path}\``).join(', ');
    lines.push(`- ${viewport.viewport.name}: viewport ${viewport.viewport.width}×${viewport.viewport.height}; document ${viewport.documentSize.width}×${viewport.documentSize.height}; ${visibleNodes}/${viewport.nodes.length} elements visible; revealed full page \`${viewport.screenshotPath}\`; initial/scroll states ${states}.`);
  }

  const outline = semanticOutline(page);
  if (outline.length > 0) {
    lines.push('', 'Semantic/content outline:', '');
    for (const item of outline) lines.push(`- ${item}`);
  }

  const interactions = page.viewports[0]?.interactions ?? [];
  if (interactions.length > 0) {
    lines.push('', `Interactive controls (${interactions.length}; exact state diffs are in \`reconstruction/pages/${slug}/page.json\`):`, '');
    for (const item of interactions.slice(0, 60)) {
      lines.push(`- ${item.kind} ${item.label ? `“${oneLine(item.label)}”` : `\`${item.path}\``}${item.href ? ` → ${item.href}` : ''}${item.ariaHasPopup ? `; popup=${item.ariaHasPopup}` : ''}`);
    }
    if (interactions.length > 60) lines.push(`- …and ${interactions.length - 60} more controls in the route \`page.json\`.`);
  }

  const animations = page.viewports.flatMap((viewport) => viewport.animations);
  lines.push('', `Animation evidence: ${animations.length} Web Animation/runtime records, ${page.cssKeyframes.length} CSS keyframes, ${page.framerAppearPayloads.length} Framer appear payloads.`);
  if (page.mediaQueries.length > 0) {
    const queries = page.mediaQueries.slice(0, 24).map((query) => `\`${query}\``).join(', ');
    const remainder = page.mediaQueries.length > 24 ? `, plus ${page.mediaQueries.length - 24} more in \`styles.css\`` : '';
    lines.push(`Responsive media queries: ${queries}${remainder}.`);
  }
  if (page.cssKeyframes.length > 0) {
    const names = keyframeNames(page.cssKeyframes);
    lines.push(`Captured CSS keyframe names: ${names.length > 0 ? names.map((name) => `\`${name}\``).join(', ') : 'see the route CSS evidence'}.`);
  }
}

function semanticOutline(page: PageReconstructionEvidence): string[] {
  const viewport = page.viewports[0];
  if (!viewport) return [];
  const tags = new Set(['header', 'nav', 'main', 'section', 'article', 'aside', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  return viewport.nodes
    .filter((node) => tags.has(node.tag) || Boolean(node.role && /^(?:banner|navigation|main|region|contentinfo)$/.test(node.role)))
    .map((node) => {
      const label = node.attributes['aria-label'] || node.attributes['data-framer-name'] || node.directText || node.textContent || node.key;
      return `${node.tag}${node.role ? `[role=${node.role}]` : ''}: ${oneLine(label).slice(0, 300)}`;
    })
    .slice(0, 80);
}

function uniqueFonts(pages: PageReconstructionEvidence[]) {
  const fonts = new Map<string, PageReconstructionEvidence['fonts'][number]>();
  for (const page of pages) {
    for (const font of page.fonts) {
      const key = JSON.stringify([font.family, font.style, font.weight, font.stretch]);
      const previous = fonts.get(key);
      if (!previous || (previous.status !== 'loaded' && font.status === 'loaded')) fonts.set(key, font);
    }
  }
  return Array.from(fonts.values()).sort((a, b) => a.family.localeCompare(b.family) || a.weight.localeCompare(b.weight));
}

function formatTokens(tokens: Array<{ value: string; uses: number }>, limit: number): string {
  return tokens.slice(0, limit).map((token) => `\`${token.value}\` (${token.uses})`).join(', ') || 'none recovered';
}

function formatAssetCounts(assets: ReconstructionAsset[]): string {
  const counts = new Map<ReconstructionAsset['kind'], number>();
  for (const asset of assets) counts.set(asset.kind, (counts.get(asset.kind) ?? 0) + 1);
  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, count]) => `${count} ${kind}`)
    .join(', ') || 'no localized assets';
}

function keyframeNames(keyframes: string[]): string[] {
  const names = new Set<string>();
  for (const keyframe of keyframes) {
    for (const match of keyframe.matchAll(/@(?:-webkit-)?keyframes\s+([^\s{]+)/gi)) names.add(match[1]!);
  }
  return Array.from(names).sort();
}

function parseJsonIfPossible(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function artifactSlug(url: string): string {
  const parsed = new URL(url);
  const base = routeSlug(parsed.pathname);
  return parsed.search ? `${base}--${crypto.createHash('sha1').update(parsed.search).digest('hex').slice(0, 8)}` : base;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeTable(value: string): string {
  return oneLine(value).replace(/\|/g, '\\|');
}
