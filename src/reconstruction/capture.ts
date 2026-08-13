import type { BrowserContext, Locator, Page } from 'playwright';
import { isGpuRiskyEmbedUrl } from '../interceptor/assetInterceptor.js';
import { applyForcedTheme, installForcedTheme, type ForcedTheme } from '../crawler/themeCapture.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import type {
  AccessibilityNodeEvidence,
  AnimationEvidence,
  CapturedViewportEvidence,
  CaptureViewport,
  InteractionEvidence,
  InteractionStateChange,
  NetworkEvidence,
  PageReconstructionEvidence,
  ReconstructionCapture,
  RuntimeDiagnostic,
  ViewportEvidence,
} from './types.js';

export const DEFAULT_RECONSTRUCTION_VIEWPORTS: CaptureViewport[] = [
  { name: 'desktop', width: 1440, height: 900, source: 'required', core: true },
  { name: 'tablet', width: 810, height: 1080, source: 'required', core: true },
  { name: 'mobile', width: 390, height: 844, source: 'required', core: true },
];

const DEFAULT_COVERAGE_WIDTHS = [320, 360, 430, 600, 1024, 1280, 1728, 1920];
const MAX_CAPTURE_VIEWPORTS = 24;

// These are the authored properties a rebuild needs. Capturing the entire computed
// declaration adds hundreds of browser defaults per node and makes the handoff less useful.
const STYLE_PROPERTIES = [
  'display', 'visibility', 'position', 'inset', 'top', 'right', 'bottom', 'left', 'z-index',
  'box-sizing', 'overflow', 'overflow-x', 'overflow-y', 'float', 'clear', 'isolation',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'aspect-ratio',
  'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'flex-direction', 'flex-wrap',
  'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self',
  'order', 'gap', 'row-gap', 'column-gap',
  'grid-template-columns', 'grid-template-rows', 'grid-auto-columns', 'grid-auto-rows',
  'grid-column', 'grid-row', 'grid-auto-flow', 'place-items', 'place-content',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
  'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
  'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  'outline', 'outline-offset', 'background', 'background-color', 'background-image',
  'background-size', 'background-position', 'background-repeat', 'background-clip',
  'color', 'opacity', 'box-shadow', 'filter', 'backdrop-filter', 'mix-blend-mode',
  'fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stop-color',
  'transform', 'transform-origin', 'transform-style', 'perspective', 'perspective-origin',
  'clip-path', 'mask-image', 'object-fit', 'object-position',
  'font-family', 'font-size', 'font-style', 'font-weight', 'font-stretch', 'font-variation-settings',
  'font-feature-settings', 'line-height', 'letter-spacing', 'text-align', 'text-indent',
  'text-transform', 'text-decoration', 'text-shadow', 'text-wrap', 'white-space', 'word-break',
  'overflow-wrap', 'vertical-align', 'list-style',
  'cursor', 'pointer-events', 'user-select', 'resize', 'appearance', 'caret-color',
  'transition-property', 'transition-duration', 'transition-delay', 'transition-timing-function',
  'animation-name', 'animation-duration', 'animation-delay', 'animation-iteration-count',
  'animation-direction', 'animation-fill-mode', 'animation-play-state', 'animation-timing-function',
  'scroll-behavior', 'scroll-snap-type', 'scroll-snap-align', 'will-change', 'contain',
] as const;

const OWNER_UI_SELECTOR = [
  '#__framer-badge-container',
  '#__framer-editorbar-container',
  '#__framer-editorbar-button',
  '#__framer-editorbar-label',
  'iframe#__framer-editorbar',
].join(',');

interface CaptureOptions {
  viewports?: CaptureViewport[];
  forceTheme?: ForcedTheme;
  scroll?: boolean;
  pageTimeoutMs?: number;
  adaptiveViewports?: boolean;
  /** Full crawl selection, including routes that failed before responsive capture. */
  requestedUrls?: Iterable<string>;
  initialFailedRoutes?: Array<{ url: string; reason: string }>;
}

export async function captureReconstruction(
  context: BrowserContext,
  urls: Iterable<string>,
  opts: CaptureOptions = {},
): Promise<ReconstructionCapture> {
  const requestedViewports = (opts.viewports?.length ? opts.viewports : DEFAULT_RECONSTRUCTION_VIEWPORTS)
    .map((viewport) => ({ ...viewport, source: viewport.source ?? (opts.viewports?.length ? 'user' as const : 'required' as const), core: viewport.core ?? true }));
  const pages: PageReconstructionEvidence[] = [];
  const urlList = Array.from(urls);
  const requestedUrlList = opts.requestedUrls ? Array.from(opts.requestedUrls) : urlList;
  const attemptedPages = urlList.length;
  const failedRoutes: Array<{ url: string; reason: string }> = [...(opts.initialFailedRoutes ?? [])];
  const discoveryFailures: Array<{ url: string; reason: string }> = [];
  const failedViewports: Array<{ url: string; viewport: CaptureViewport; reason: string }> = [];
  const discoveredBreakpoints = new Set<number>();
  const allViewports = new Map<string, CaptureViewport>();
  let environment: ReconstructionCapture['environment'] | undefined;

  const capturePage = async (url: string, exhaustiveResponsiveMatrix: boolean): Promise<PageReconstructionEvidence | undefined> => {
    const discovery = opts.adaptiveViewports === false || !exhaustiveResponsiveMatrix
      ? { breakpoints: [] as number[], environment: undefined }
      : await discoverResponsiveCapture(context, url, requestedViewports, opts).catch((error) => {
          const reason = (error as Error).message;
          discoveryFailures.push({ url, reason });
          logger.warn({ url, err: reason }, 'responsive-discovery-failed');
          return { breakpoints: [] as number[], environment: undefined };
        });
    discovery.breakpoints.forEach((width) => discoveredBreakpoints.add(width));
    environment ??= discovery.environment;
    // The entry route establishes the exhaustive site-wide responsive system.
    // Secondary routes still receive complete desktop/tablet/mobile evidence,
    // but do not repeat every coverage and breakpoint-adjacent probe. This keeps
    // full-site packages bounded while preserving every route and core layout.
    const viewports = exhaustiveResponsiveMatrix
      ? buildResponsiveViewportMatrix(requestedViewports, discovery.breakpoints, Boolean(opts.viewports?.length))
      : requestedViewports.map((viewport) => ({ ...viewport }));
    viewports.forEach((viewport) => allViewports.set(`${viewport.width}x${viewport.height}`, viewport));
    logger.info({ url, viewports: viewports.map((item) => item.name) }, 'reconstruction-page-capture-started');
    const captures = [];
    let pageMetadata: Omit<PageReconstructionEvidence, 'url' | 'route' | 'viewports'> | undefined;

    const captureViewport = async (viewport: CaptureViewport) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await installAnimationRecorder(page);
      await installForcedTheme(page, opts.forceTheme);
      const stabilizedEmbeds = await installRiskyEmbedCaptureRoute(page);
      const runtimeDiagnostics: RuntimeDiagnostic[] = [];
      const network = installRuntimeObservers(page, runtimeDiagnostics);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs ?? 60_000 });
        // Analytics, chat widgets, and polling APIs can keep otherwise-ready pages
        // permanently "busy". Five seconds is enough to catch ordinary late assets;
        // fonts, scrolling, screenshots, and the interceptor still settle afterward.
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
        await page.addStyleTag({ content: `${OWNER_UI_SELECTOR}{display:none!important}` }).catch(() => undefined);
        await applyForcedTheme(page, opts.forceTheme);
        await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
        await sleep(1_200);
        if (stabilizedEmbeds.length > 0) runtimeDiagnostics.push({
          kind: 'capture-warning',
          level: 'warning',
          message: `Stabilized ${stabilizedEmbeds.length} GPU-heavy cross-origin embed renderer(s) for deterministic screenshots; original iframe URLs, attributes, and geometry remain in source and DOM evidence.`,
        });

        const parsedUrl = new URL(url);
        const screenshotBase = `${routeSlug(parsedUrl.pathname + parsedUrl.search)}--${safeName(viewport.name)}`;
        const stateScreenshots: CapturedViewportEvidence['stateScreenshots'] = [{
          label: 'initial',
          scrollY: 0,
          path: `reconstruction/screenshots/${screenshotBase}--initial.png`,
          screenshot: await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }),
          kind: 'initial' as const,
        }];
        if (opts.scroll !== false && viewport.core !== false) {
          stateScreenshots.push(...await scrollForEvidence(page, screenshotBase));
        }
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
        await sleep(500);

        const extracted = await extractViewportEvidence(page, viewport);
        extracted.viewport.network = [...network.values()];
        extracted.viewport.diagnostics = runtimeDiagnostics;
        extracted.viewport.accessibilityTree = await captureAccessibilityTree(context, page, runtimeDiagnostics);

        const screenshotPath = `reconstruction/screenshots/${screenshotBase}--full.png`;
        const screenshot = await page.screenshot({ fullPage: true, type: 'png', animations: 'disabled', caret: 'hide' });
        if (viewport.core !== false) {
          stateScreenshots.push(...await captureInteractionStates(page, extracted.viewport.interactions, screenshotBase));
        }

        return {
          page: extracted.page,
          capture: { ...extracted.viewport, screenshotPath, screenshot, stateScreenshots },
        };
      } catch (err) {
        const reason = (err as Error).message;
        failedViewports.push({ url, viewport, reason });
        logger.error({ url, viewport: viewport.name, err: reason }, 'reconstruction-viewport-capture-failed');
        return undefined;
      } finally {
        await page.close().catch(() => undefined);
      }
    };
    const viewportResults: Array<Awaited<ReturnType<typeof captureViewport>>> = new Array(viewports.length);
    let viewportCursor = 0;
    const viewportWorkers = Array.from({ length: Math.min(3, viewports.length) }, async () => {
      while (true) {
        const index = viewportCursor;
        viewportCursor += 1;
        const viewport = viewports[index];
        if (!viewport) return;
        viewportResults[index] = await captureViewport(viewport);
      }
    });
    await Promise.all(viewportWorkers);

    for (const result of viewportResults) {
      if (!result) continue;
      pageMetadata ??= result.page;
      captures.push(result.capture);
    }

    if (pageMetadata && captures.length > 0) {
      const parsed = new URL(url);
      return {
        url,
        route: parsed.pathname + parsed.search,
        ...pageMetadata,
        viewports: captures,
      };
    }
    failedRoutes.push({ url, reason: 'Every responsive viewport failed.' });
    return undefined;
  };

  const primaryUrl = urlList[0];
  if (primaryUrl) {
    const primaryPage = await capturePage(primaryUrl, true);
    if (primaryPage) pages.push(primaryPage);
  }

  const secondaryUrls = urlList.slice(1);
  let cursor = 0;
  const workerCount = Math.min(2, secondaryUrls.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const url = secondaryUrls[index];
      if (!url) return;
      const page = await capturePage(url, false);
      if (page) pages.push(page);
    }
  });
  await Promise.all(workers);

  if (attemptedPages > 0 && pages.length === 0) {
    throw new Error('Reconstruction capture failed for every page and viewport; no LLM evidence was written.');
  }
  pages.sort((a, b) => a.url.localeCompare(b.url));
  const viewports = [...allViewports.values()].sort((a, b) => a.width - b.width || a.height - b.height);
  const interactions = pages.flatMap((page) => page.viewports.flatMap((viewport) => viewport.interactions));
  return {
    capturedAt: new Date().toISOString(),
    viewports,
    pages,
    coverage: {
      requestedRoutes: requestedUrlList,
      capturedRoutes: pages.map((page) => page.url),
      failedRoutes,
      discoveryFailures,
      requestedViewports,
      discoveredBreakpoints: [...discoveredBreakpoints].sort((a, b) => a - b),
      capturedViewportCount: pages.reduce((total, page) => total + page.viewports.length, 0),
      failedViewports,
      interactionCandidates: interactions.length,
      interactionStatesCaptured: interactions.filter((interaction) => interaction.activation?.outcome === 'changed').length,
      assetsCaptured: 0,
      assetBytes: 0,
      assetIssues: [],
    },
    environment: environment ?? {
      browser: `chromium ${context.browser()?.version() ?? 'unknown'}`,
      userAgent: 'unknown',
      platform: process.platform,
      locale: 'unknown',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      colorScheme: opts.forceTheme,
      reducedMotion: 'no-preference',
    },
  };
}

async function installRiskyEmbedCaptureRoute(page: Page): Promise<string[]> {
  const stabilized: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    let parsed: URL;
    try { parsed = new URL(request.url()); } catch {
      await route.fallback();
      return;
    }
    if (request.resourceType() !== 'document' || !isGpuRiskyEmbedUrl(parsed.href)) {
      await route.fallback();
      return;
    }
    stabilized.push(parsed.href);
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta name="color-scheme" content="dark"><style>html,body{height:100%;margin:0;background:#111;color:#fff;font:14px/1.4 sans-serif}body{display:grid;place-items:center;text-align:center;padding:16px;box-sizing:border-box}</style><body>Embedded media preserved in source evidence</body>',
    });
  });
  return stabilized;
}

async function discoverResponsiveCapture(
  context: BrowserContext,
  url: string,
  requestedViewports: CaptureViewport[],
  opts: CaptureOptions,
): Promise<{ breakpoints: number[]; environment?: ReconstructionCapture['environment'] }> {
  const page = await context.newPage();
  const viewport = requestedViewports.find((item) => item.width >= 1000) ?? requestedViewports[0] ?? DEFAULT_RECONSTRUCTION_VIEWPORTS[0]!;
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  // tsx/esbuild can add this helper to serialized page callbacks in dev mode.
  await page.addInitScript('globalThis.__name ||= ((target, _value) => target);');
  await installForcedTheme(page, opts.forceTheme);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs ?? 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    await applyForcedTheme(page, opts.forceTheme);
    await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
    const observed = await page.evaluate(() => {
      const conditions = new Set<string>();
      const cssChunks: string[] = [];
      const visit = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) conditions.add(rule.conditionText);
          if ('cssRules' in rule) {
            try { visit((rule as CSSGroupingRule).cssRules); } catch { /* inaccessible nested rules */ }
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        if (sheet.media?.mediaText) conditions.add(sheet.media.mediaText);
        try {
          visit(sheet.cssRules);
          cssChunks.push(Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\n'));
        } catch {
          if (sheet.href) cssChunks.push(`/* inaccessible stylesheet: ${sheet.href} */`);
        }
      }
      document.querySelectorAll('style').forEach((style) => cssChunks.push(style.textContent ?? ''));
      document.querySelectorAll<HTMLLinkElement>('link[media]').forEach((link) => conditions.add(link.media));
      return {
        conditions: [...conditions],
        cssText: cssChunks.join('\n'),
        rootFontSize: parseFloat(getComputedStyle(document.documentElement).fontSize) || 16,
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        locale: navigator.language,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
        reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'reduce' : 'no-preference',
      };
    });
    const expressions = `${observed.conditions.join('\n')}\n${observed.cssText}`;
    const breakpoints = new Set<number>();
    const widthExpression = /(?:min|max)-width\s*:\s*(-?\d*\.?\d+)\s*(px|em|rem)/gi;
    for (const match of expressions.matchAll(widthExpression)) {
      const numeric = Number(match[1]);
      if (!Number.isFinite(numeric)) continue;
      const width = Math.round(match[2]?.toLowerCase() === 'px' ? numeric : numeric * observed.rootFontSize);
      if (width >= 240 && width <= 2560) breakpoints.add(width);
    }
    return {
      breakpoints: [...breakpoints].sort((a, b) => a - b),
      environment: {
        browser: `chromium ${context.browser()?.version() ?? 'unknown'}`,
        userAgent: observed.userAgent,
        platform: observed.platform,
        locale: observed.locale,
        timezone: observed.timezone,
        colorScheme: observed.colorScheme,
        reducedMotion: observed.reducedMotion,
      },
    };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export function buildResponsiveViewportMatrix(
  requested: CaptureViewport[],
  breakpoints: number[],
  userSupplied = false,
): CaptureViewport[] {
  const byWidth = new Map<number, CaptureViewport>();
  const add = (viewport: CaptureViewport) => {
    const existing = byWidth.get(viewport.width);
    if (!existing || (viewport.core && !existing.core)) byWidth.set(viewport.width, viewport);
  };
  requested.forEach((viewport) => add({ ...viewport, core: viewport.core ?? true }));
  for (const breakpoint of breakpoints) {
    for (const [offset, source] of [[-1, 'breakpoint-below'], [0, 'breakpoint'], [1, 'breakpoint-above']] as const) {
      const width = breakpoint + offset;
      if (width < 320 || width > 1920) continue;
      add({
        name: `bp-${breakpoint}${offset < 0 ? '-below' : offset > 0 ? '-above' : ''}`,
        width,
        height: captureHeightForWidth(width),
        source,
        core: false,
      });
    }
  }
  if (!userSupplied) {
    for (const width of DEFAULT_COVERAGE_WIDTHS) {
      add({ name: `width-${width}`, width, height: captureHeightForWidth(width), source: 'coverage', core: false });
    }
  }
  const requestedWidths = new Set(requested.map((viewport) => viewport.width));
  return [...byWidth.values()]
    .sort((a, b) => {
      const aRank = requestedWidths.has(a.width) ? 0 : a.source?.startsWith('breakpoint') ? 1 : 2;
      const bRank = requestedWidths.has(b.width) ? 0 : b.source?.startsWith('breakpoint') ? 1 : 2;
      return aRank - bRank || a.width - b.width;
    })
    .slice(0, MAX_CAPTURE_VIEWPORTS)
    .sort((a, b) => a.width - b.width);
}

function captureHeightForWidth(width: number): number {
  if (width <= 430) return 844;
  if (width <= 900) return 1080;
  return 900;
}

function installRuntimeObservers(
  page: Page,
  diagnostics: RuntimeDiagnostic[],
): Map<string, NetworkEvidence> {
  const network = new Map<string, NetworkEvidence>();
  const addDiagnostic = (diagnostic: RuntimeDiagnostic) => {
    if (diagnostics.length < 250) diagnostics.push(diagnostic);
  };
  page.on('console', (message) => {
    if (!['warning', 'error', 'assert'].includes(message.type())) return;
    const location = message.location();
    addDiagnostic({
      kind: 'console',
      level: message.type(),
      message: message.text().slice(0, 4_000),
      url: location.url ? sanitizeEvidenceUrl(location.url) : undefined,
    });
  });
  page.on('pageerror', (error) => addDiagnostic({ kind: 'page-error', level: 'error', message: error.message.slice(0, 4_000) }));
  page.on('request', (request) => {
    const url = sanitizeEvidenceUrl(request.url());
    const key = `${request.method()} ${request.resourceType()} ${url}`;
    if (!network.has(key)) network.set(key, { url, method: request.method(), resourceType: request.resourceType() });
  });
  page.on('response', (response) => {
    const request = response.request();
    const url = sanitizeEvidenceUrl(request.url());
    const key = `${request.method()} ${request.resourceType()} ${url}`;
    const record = network.get(key) ?? { url, method: request.method(), resourceType: request.resourceType() };
    record.status = response.status();
    record.contentType = response.headers()['content-type'];
    record.fromServiceWorker = response.fromServiceWorker();
    network.set(key, record);
  });
  page.on('requestfailed', (request) => {
    const url = sanitizeEvidenceUrl(request.url());
    const key = `${request.method()} ${request.resourceType()} ${url}`;
    const failure = request.failure()?.errorText ?? 'unknown request failure';
    const record = network.get(key) ?? { url, method: request.method(), resourceType: request.resourceType() };
    record.failure = failure;
    network.set(key, record);
    addDiagnostic({ kind: 'request-failed', level: 'error', message: failure, url });
  });
  return network;
}

function sanitizeEvidenceUrl(value: string): string {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|secret|password|passwd|authorization|auth|session|jwt|email|code/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    parsed.username = '';
    parsed.password = '';
    return parsed.href;
  } catch {
    return value.slice(0, 2_000);
  }
}

async function captureAccessibilityTree(
  context: BrowserContext,
  page: Page,
  diagnostics: RuntimeDiagnostic[],
): Promise<AccessibilityNodeEvidence[] | undefined> {
  try {
    const session = await context.newCDPSession(page);
    const result = await session.send('Accessibility.getFullAXTree');
    await session.detach().catch(() => undefined);
    return result.nodes.map((node) => {
      const properties: Record<string, unknown> = {};
      for (const property of node.properties ?? []) properties[property.name] = property.value?.value;
      return {
        nodeId: node.nodeId,
        ignored: node.ignored,
        role: String(node.role?.value ?? '') || undefined,
        name: String(node.name?.value ?? '') || undefined,
        description: String(node.description?.value ?? '') || undefined,
        value: node.value?.value === undefined ? undefined : String(node.value.value),
        properties: Object.keys(properties).length > 0 ? properties : undefined,
        childIds: node.childIds,
        backendDOMNodeId: node.backendDOMNodeId,
      };
    });
  } catch (error) {
    diagnostics.push({ kind: 'capture-warning', level: 'warning', message: `Accessibility tree capture failed: ${(error as Error).message}` });
    return undefined;
  }
}

async function installAnimationRecorder(page: Page): Promise<void> {
  // tsx/esbuild can insert this helper into serialized page callbacks in dev mode.
  // Playwright evaluates those callbacks in the browser, outside the Node bundle.
  await page.addInitScript('globalThis.__name ||= ((target, _value) => target);');
  await page.addInitScript(() => {
    const scope = window as Window & { __LLM_RECONSTRUCTION_ANIMATIONS__?: unknown[] };
    scope.__LLM_RECONSTRUCTION_ANIMATIONS__ = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function animate(keyframes, options) {
      try {
        const element = this as Element;
        const target = element.id
          ? `#${element.id}`
          : element.getAttribute('data-framer-name')
            ? `[data-framer-name=${JSON.stringify(element.getAttribute('data-framer-name'))}]`
            : element.tagName.toLowerCase();
        scope.__LLM_RECONSTRUCTION_ANIMATIONS__?.push({
          source: 'runtime-call',
          target,
          keyframes: typeof keyframes === 'object' ? keyframes : String(keyframes),
          options,
        });
      } catch {
        // Recording must never interfere with the page.
      }
      return original.call(this, keyframes, options);
    };
  });
}

async function extractViewportEvidence(
  page: Page,
  viewport: CaptureViewport,
): Promise<{
  page: Omit<PageReconstructionEvidence, 'url' | 'route' | 'viewports'>;
  viewport: Omit<ViewportEvidence, 'screenshotPath'>;
}> {
  return page.evaluate(
    ({ properties, captureViewport }) => {
      const round = (value: number) => Math.round(value * 100) / 100;
      const allDomElements = Array.from(document.body?.querySelectorAll<HTMLElement>('*') ?? []);
      const ownerUiSelector = '#__framer-badge-container,#__framer-editorbar-container,#__framer-editorbar-button,#__framer-editorbar-label,iframe#__framer-editorbar';
      const elements = [document.body, ...allDomElements].filter((element): element is HTMLElement => (
        Boolean(element) && !element?.matches(ownerUiSelector) && !element?.closest(ownerUiSelector)
      ));
      const elementIds = new Map<Element, string>();
      elements.forEach((element, index) => elementIds.set(element, `e${index}`));

      const styleCatalog: Record<string, Record<string, string>> = {};
      const styleIds = new Map<string, string>();
      const captureStyle = (style: CSSStyleDeclaration): string => {
        const record: Record<string, string> = {};
        for (const property of properties) {
          const value = style.getPropertyValue(property);
          if (value) record[property] = value;
        }
        const serialized = JSON.stringify(record);
        const existing = styleIds.get(serialized);
        if (existing) return existing;
        const id = `s${styleIds.size}`;
        styleIds.set(serialized, id);
        styleCatalog[id] = record;
        return id;
      };

      const cssPath = (element: Element): string => {
        if (element === document.body) return 'body';
        if ((element as HTMLElement).id) return `#${CSS.escape((element as HTMLElement).id)}`;
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 8) {
          let part = current.tagName.toLowerCase();
          const name = current.getAttribute('data-framer-name');
          if (name) {
            part += `[data-framer-name=${JSON.stringify(name)}]`;
          } else {
            const siblings = current.parentElement
              ? Array.from(current.parentElement.children).filter((child) => child.tagName === current?.tagName)
              : [];
            if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
          }
          parts.unshift(part);
          current = current.parentElement;
        }
        return ['body', ...parts].join(' > ');
      };

      const directText = (element: Element): string => Array.from(element.childNodes)
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent ?? '')
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      const accessibleName = (element: HTMLElement): string | undefined => {
        const explicit = element.getAttribute('aria-label')?.trim();
        if (explicit) return explicit.slice(0, 500);
        const labelledBy = element.getAttribute('aria-labelledby');
        if (labelledBy) {
          const value = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
          if (value) return value.slice(0, 500);
        }
        if (element instanceof HTMLImageElement && element.alt) return element.alt.slice(0, 500);
        if (element instanceof HTMLInputElement && element.labels?.length) {
          const value = Array.from(element.labels).map((label) => label.textContent ?? '').join(' ').replace(/\s+/g, ' ').trim();
          if (value) return value.slice(0, 500);
        }
        const title = element.getAttribute('title')?.trim();
        if (title) return title.slice(0, 500);
        if (element.matches('a,button,summary,[role="button"],[role="link"],[role="tab"]')) {
          const value = element.innerText?.replace(/\s+/g, ' ').trim();
          if (value) return value.slice(0, 500);
        }
        return undefined;
      };

      const pseudo = (element: Element, name: '::before' | '::after') => {
        const style = getComputedStyle(element, name);
        const content = style.content;
        const visuallyPresent = content !== 'none' && content !== 'normal'
          || style.backgroundImage !== 'none'
          || (parseFloat(style.width) > 0 && parseFloat(style.height) > 0);
        if (!visuallyPresent || style.display === 'none') return undefined;
        return { content, styleId: captureStyle(style) };
      };

      const nodes = elements
        .filter((element) => !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(element.tagName))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          const attributes: Record<string, string> = {};
          for (const attribute of Array.from(element.attributes)) {
            if (attribute.name === 'nonce') continue;
            attributes[attribute.name] = attribute.value.length > 4_000
              ? `${attribute.value.slice(0, 4_000)}…[truncated]`
              : attribute.value;
          }
          const parentId = element.parentElement ? elementIds.get(element.parentElement) : undefined;
          const id = elementIds.get(element)!;
          const path = cssPath(element);
          const text = directText(element);
          const aggregateText = element.matches('h1,h2,h3,h4,h5,h6,figcaption,caption,legend,label')
            ? element.innerText?.replace(/\s+/g, ' ').trim().slice(0, 2_000)
            : undefined;
          const image = element instanceof HTMLImageElement ? element : undefined;
          const video = element instanceof HTMLVideoElement ? element : undefined;
          const media = image || video ? {
            currentSrc: image?.currentSrc || video?.currentSrc || undefined,
            naturalWidth: image?.naturalWidth || undefined,
            naturalHeight: image?.naturalHeight || undefined,
            videoWidth: video?.videoWidth || undefined,
            videoHeight: video?.videoHeight || undefined,
          } : undefined;
          return {
            id,
            parentId,
            domIndex: element === document.body ? -1 : allDomElements.indexOf(element),
            key: element.id || element.getAttribute('data-framer-name') || element.getAttribute('aria-label') || path,
            path,
            tag: element.tagName.toLowerCase(),
            role: element.getAttribute('role') || undefined,
            accessibleName: accessibleName(element),
            focusable: element.matches('a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])'),
            tabIndex: element.tabIndex,
            directText: text || undefined,
            textContent: aggregateText || undefined,
            attributes,
            rect: {
              x: round(rect.x + window.scrollX),
              y: round(rect.y + window.scrollY),
              width: round(rect.width),
              height: round(rect.height),
            },
            styleId: captureStyle(getComputedStyle(element)),
            before: pseudo(element, '::before'),
            after: pseudo(element, '::after'),
            media,
          };
        });

      const nodeByElement = new Map<Element, string>(elements.map((element) => [element, elementIds.get(element)!]));
      const interactions = elements
        .filter((element) => element.matches('a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[aria-haspopup],[tabindex]'))
        .map((element) => {
          const html = element as HTMLElement;
          const anchor = element instanceof HTMLAnchorElement ? element : undefined;
          const input = element instanceof HTMLInputElement ? element : undefined;
          return {
            nodeId: nodeByElement.get(element)!,
            domIndex: allDomElements.indexOf(html),
            path: cssPath(element),
            kind: element.getAttribute('role') || element.tagName.toLowerCase(),
            label: element.getAttribute('aria-label') || element.getAttribute('title') || html.innerText?.replace(/\s+/g, ' ').trim().slice(0, 240) || undefined,
            href: anchor?.href,
            target: anchor?.target || undefined,
            inputType: input?.type,
            ariaHasPopup: element.getAttribute('aria-haspopup') || undefined,
            ariaExpanded: element.getAttribute('aria-expanded') || undefined,
            ariaPressed: element.getAttribute('aria-pressed') || undefined,
            ariaSelected: element.getAttribute('aria-selected') || undefined,
          };
        });

      const animations: AnimationEvidence[] = document.getAnimations().map((animation) => {
        const effect = animation.effect instanceof KeyframeEffect ? animation.effect : undefined;
        const target = effect?.target instanceof Element ? effect.target : undefined;
        const timing = effect?.getTiming();
        return {
          source: 'web-animation',
          target: target ? cssPath(target) : undefined,
          targetNodeId: target ? nodeByElement.get(target) : undefined,
          playState: animation.playState,
          currentTime: typeof animation.currentTime === 'number' ? animation.currentTime : null,
          startTime: typeof animation.startTime === 'number' ? animation.startTime : null,
          playbackRate: animation.playbackRate,
          timing: timing ? { ...timing } : undefined,
          keyframes: effect?.getKeyframes().map((frame) => ({ ...frame })),
        };
      });
      const runtimeAnimations = ((window as Window & { __LLM_RECONSTRUCTION_ANIMATIONS__?: AnimationEvidence[] })
        .__LLM_RECONSTRUCTION_ANIMATIONS__ ?? []).map((item) => ({ ...item, source: 'runtime-call' as const }));

      const stylesheets = Array.from(document.styleSheets).map((sheet) => {
        try {
          return {
            href: sheet.href || undefined,
            media: sheet.media?.mediaText || undefined,
            cssText: Array.from(sheet.cssRules ?? []).map((rule) => rule.cssText).join('\n'),
          };
        } catch {
          return { href: sheet.href || undefined, media: sheet.media?.mediaText || undefined, inaccessible: true };
        }
      });

      const cssKeyframes: string[] = [];
      const mediaQueries = new Set<string>();
      const visitRules = (rules: CSSRuleList) => {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSKeyframesRule) cssKeyframes.push(rule.cssText);
          if (rule instanceof CSSMediaRule) mediaQueries.add(rule.conditionText);
          if ('cssRules' in rule) {
            try { visitRules((rule as CSSGroupingRule).cssRules); } catch { /* cross-origin grouping */ }
          }
        }
      };
      for (const sheet of Array.from(document.styleSheets)) {
        try { visitRules(sheet.cssRules); } catch { /* cross-origin stylesheet */ }
      }

      const cleanBody = document.body.cloneNode(true) as HTMLElement;
      cleanBody.querySelectorAll('script,style,noscript,template').forEach((node) => node.remove());
      cleanBody.querySelectorAll(ownerUiSelector).forEach((node) => node.remove());
      cleanBody.querySelectorAll('input[type="password"]').forEach((node) => node.setAttribute('value', ''));
      for (const element of Array.from(cleanBody.querySelectorAll<HTMLElement>('*'))) {
        for (const attribute of Array.from(element.attributes)) {
          if (attribute.name === 'nonce') element.removeAttribute(attribute.name);
          if (attribute.value.startsWith('data:') && attribute.value.length > 200_000) {
            element.setAttribute(attribute.name, '[large embedded data URL omitted from handoff]');
          }
        }
      }

      const rootStyle = getComputedStyle(document.documentElement);
      const rootCustomProperties: Record<string, string> = {};
      for (const property of Array.from(rootStyle)) {
        if (!property.startsWith('--')) continue;
        const value = rootStyle.getPropertyValue(property).trim();
        if (value) rootCustomProperties[property] = value;
      }

      const fonts: Array<{ family: string; style: string; weight: string; stretch: string; status: string }> = [];
      document.fonts?.forEach((font) => fonts.push({
        family: font.family,
        style: font.style,
        weight: font.weight,
        stretch: font.stretch,
        status: font.status,
      }));
      const framerAppearPayloads = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="framer/appear"]'))
        .map((script) => script.textContent?.trim() ?? '')
        .filter(Boolean);
      const description = document.querySelector<HTMLMetaElement>('meta[name="description"]')?.content;

      return {
        page: {
          title: document.title,
          language: document.documentElement.lang || undefined,
          description,
          cleanDom: cleanBody.outerHTML,
          stylesheets,
          fonts,
          cssKeyframes,
          mediaQueries: Array.from(mediaQueries),
          framerAppearPayloads,
        },
        viewport: {
          viewport: captureViewport,
          documentSize: {
            width: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
            height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0),
          },
          colorScheme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
          rootCustomProperties,
          styleCatalog,
          nodes,
          interactions,
          animations: [...animations, ...runtimeAnimations],
          network: [],
          diagnostics: [],
        },
      };
    },
    { properties: [...STYLE_PROPERTIES], captureViewport: viewport },
  );
}

async function captureInteractionStates(
  page: Page,
  interactions: InteractionEvidence[],
  screenshotBase: string,
): Promise<CapturedViewportEvidence['stateScreenshots']> {
  const screenshots: CapturedViewportEvidence['stateScreenshots'] = [];
  // Keep this bounded: CSS rules and runtime animation records remain the exhaustive source;
  // this section adds empirical hover/focus diffs for visible interactive controls.
  // CSS selectors/transitions remain exhaustive in the evidence package. This
  // empirical pass is deliberately sampled so large CMS sites do not spend
  // minutes hovering every repeated navigation and card link on every route.
  for (const [interactionIndex, interaction] of interactions.slice(0, 24).entries()) {
    if (interaction.domIndex < 0) continue;
    const pathLocator = page.locator(interaction.path).first();
    const locator = await pathLocator.count().catch(() => 0) > 0
      ? pathLocator
      : page.locator('body *').nth(interaction.domIndex);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const base = await captureStateStyles(locator).catch(() => undefined);
    if (!base) continue;

    await locator.hover({ timeout: 1_500 }).catch(() => undefined);
    await sleep(90);
    const hover = await captureStateStyles(locator).catch(() => undefined);
    interaction.hover = hover ? diffStateStyles(base, hover) : undefined;

    await page.mouse.move(0, 0).catch(() => undefined);
    await locator.focus({ timeout: 1_500 }).catch(() => undefined);
    await sleep(60);
    const focus = await captureStateStyles(locator).catch(() => undefined);
    interaction.focus = focus ? diffStateStyles(base, focus) : undefined;
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => undefined);

    const activationSafety = await locator.evaluate((element) => {
      const html = element as HTMLElement;
      const label = `${element.getAttribute('aria-label') ?? ''} ${element.getAttribute('title') ?? ''} ${html.innerText ?? ''}`;
      const button = element instanceof HTMLButtonElement ? element : undefined;
      const input = element instanceof HTMLInputElement ? element : undefined;
      const explicitlyStateful = element.matches('summary,[aria-expanded],[aria-pressed],[aria-haspopup],[role="tab"]');
      const namedToggle = /menu|hamburger|toggle|accordion|expand|collapse|open|close|next|previous|carousel|gallery|tab/i.test(label);
      const unsafe = element.matches('a[href],select,textarea')
        || Boolean(input)
        || Boolean(button?.form && (button.type === 'submit' || button.type === 'reset'))
        || Boolean(element.closest('form') && !explicitlyStateful && !namedToggle);
      return {
        safe: !unsafe && (explicitlyStateful || namedToggle),
        expanded: element.getAttribute('aria-expanded'),
        pressed: element.getAttribute('aria-pressed'),
        selected: element.getAttribute('aria-selected'),
        open: element instanceof HTMLDetailsElement ? element.open : element.closest('details')?.open,
      };
    }).catch(() => ({ safe: false, expanded: null, pressed: null, selected: null, open: undefined }));
    if (!activationSafety.safe) {
      interaction.activation = { attempted: false, outcome: 'skipped-unsafe' };
      continue;
    }

    try {
      const beforeActivation = await captureObservableState(page);
      await locator.click({ timeout: 2_000, noWaitAfter: true });
      await sleep(220);
      const afterActivation = await captureObservableState(page);
      const changes = diffObservableStates(beforeActivation, afterActivation);
      if (changes?.length) {
        const label = `interaction-${String(interactionIndex + 1).padStart(2, '0')}`;
        interaction.activation = { attempted: true, outcome: 'changed', changes, screenshotLabel: label };
        screenshots.push({
          label,
          scrollY: await page.evaluate(() => Math.round(window.scrollY)),
          path: `reconstruction/screenshots/${screenshotBase}--${label}.png`,
          screenshot: await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }),
          kind: 'interaction',
          target: interaction.path,
        });
      } else {
        interaction.activation = { attempted: true, outcome: 'no-observable-change' };
      }

      await page.keyboard.press('Escape').catch(() => undefined);
      await sleep(80);
      const toggleChanged = await locator.evaluate((element, initial) => (
        element.getAttribute('aria-expanded') !== initial.expanded
        || element.getAttribute('aria-pressed') !== initial.pressed
        || element.getAttribute('aria-selected') !== initial.selected
        || (element instanceof HTMLDetailsElement ? element.open : element.closest('details')?.open) !== initial.open
      ), activationSafety).catch(() => false);
      if (toggleChanged && await locator.isVisible().catch(() => false)) {
        await locator.click({ timeout: 1_500, noWaitAfter: true }).catch(() => undefined);
      }
      await page.keyboard.press('Escape').catch(() => undefined);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()).catch(() => undefined);
    } catch (error) {
      interaction.activation = { attempted: true, outcome: 'failed', error: (error as Error).message.slice(0, 1_000) };
      await page.keyboard.press('Escape').catch(() => undefined);
    }
  }
  return screenshots;
}

async function captureObservableState(page: Page): Promise<Array<{ nodePath: string; style: Record<string, string> }>> {
  return page.evaluate(() => {
    const stablePath = (element: Element): string => {
      if ((element as HTMLElement).id) return `#${CSS.escape((element as HTMLElement).id)}`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 7) {
        let part = current.tagName.toLowerCase();
        const name = current.getAttribute('data-framer-name');
        if (name) part += `[data-framer-name=${JSON.stringify(name)}]`;
        else if (current.parentElement) {
          const siblings = Array.from(current.parentElement.children).filter((child) => child.tagName === current?.tagName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return ['body', ...parts].join(' > ');
    };
    return Array.from(document.body.querySelectorAll<HTMLElement>('*')).slice(0, 2_000).map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        nodePath: stablePath(element),
        style: {
          display: style.display,
          visibility: style.visibility,
          opacity: style.opacity,
          transform: style.transform,
          x: String(Math.round((rect.x + window.scrollX) * 100) / 100),
          y: String(Math.round((rect.y + window.scrollY) * 100) / 100),
          width: String(Math.round(rect.width * 100) / 100),
          height: String(Math.round(rect.height * 100) / 100),
          class: element.className,
          'aria-expanded': element.getAttribute('aria-expanded') ?? '',
          'aria-hidden': element.getAttribute('aria-hidden') ?? '',
          'aria-pressed': element.getAttribute('aria-pressed') ?? '',
          'aria-selected': element.getAttribute('aria-selected') ?? '',
          hidden: String(element.hidden),
          open: String(element instanceof HTMLDetailsElement ? element.open : false),
        },
      };
    });
  });
}

function diffObservableStates(
  before: Array<{ nodePath: string; style: Record<string, string> }>,
  after: Array<{ nodePath: string; style: Record<string, string> }>,
): InteractionStateChange[] | undefined {
  const beforeByPath = new Map(before.map((item) => [item.nodePath, item.style]));
  const changes: InteractionStateChange[] = [];
  for (const item of after) {
    const previous = beforeByPath.get(item.nodePath);
    if (!previous) {
      changes.push({ nodePath: item.nodePath, changes: { presence: { from: 'missing', to: 'present' } } });
      if (changes.length >= 200) break;
      continue;
    }
    const difference: Record<string, { from: string; to: string }> = {};
    for (const [property, value] of Object.entries(item.style)) {
      const oldValue = previous[property] ?? '';
      if (value !== oldValue) difference[property] = { from: oldValue, to: value };
    }
    if (Object.keys(difference).length > 0) changes.push({ nodePath: item.nodePath, changes: difference });
    if (changes.length >= 200) break;
  }
  return changes.length > 0 ? changes : undefined;
}

async function captureStateStyles(locator: Locator): Promise<Array<{ nodePath: string; style: Record<string, string> }>> {
  return locator.evaluate((root, properties) => {
    const elements = [root, ...Array.from(root.querySelectorAll('*')).slice(0, 24)];
    return elements.map((element, index) => {
      const style = getComputedStyle(element);
      const values: Record<string, string> = {};
      for (const property of properties) values[property] = style.getPropertyValue(property);
      return { nodePath: index === 0 ? ':self' : `:self ${element.tagName.toLowerCase()}:nth-descendant(${index})`, style: values };
    });
  }, [...STYLE_PROPERTIES]);
}

function diffStateStyles(
  before: Array<{ nodePath: string; style: Record<string, string> }>,
  after: Array<{ nodePath: string; style: Record<string, string> }>,
): InteractionStateChange[] | undefined {
  const changes: InteractionStateChange[] = [];
  after.forEach((item, index) => {
    const previous = before[index];
    if (!previous) return;
    const difference: Record<string, { from: string; to: string }> = {};
    for (const [property, value] of Object.entries(item.style)) {
      const oldValue = previous.style[property] ?? '';
      if (value !== oldValue) difference[property] = { from: oldValue, to: value };
    }
    if (Object.keys(difference).length > 0) changes.push({ nodePath: item.nodePath, changes: difference });
  });
  return changes.length > 0 ? changes : undefined;
}

async function scrollForEvidence(
  page: Page,
  screenshotBase: string,
): Promise<CapturedViewportEvidence['stateScreenshots']> {
  const captures: CapturedViewportEvidence['stateScreenshots'] = [];
  try {
    const viewportHeight = page.viewportSize()?.height ?? 900;
    for (const progress of [0.25, 0.5, 0.75, 1]) {
      const height = await page.evaluate(() => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight));
      const target = Math.max(0, Math.round((height - viewportHeight) * progress));
      let current = await page.evaluate(() => window.scrollY);
      while (current + viewportHeight * 0.8 < target) {
        current = Math.min(target, current + viewportHeight * 0.8);
        await page.evaluate((y) => window.scrollTo(0, y), current);
        await sleep(160);
      }
      await page.evaluate((y) => window.scrollTo(0, y), target);
      await sleep(350);
      const percent = String(Math.round(progress * 100)).padStart(3, '0');
      captures.push({
        label: `scroll-${percent}`,
        scrollY: await page.evaluate(() => Math.round(window.scrollY)),
        path: `reconstruction/screenshots/${screenshotBase}--scroll-${percent}.png`,
        screenshot: await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' }),
        kind: 'scroll',
      });
    }
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'reconstruction-scroll-failed');
  }
  return captures;
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'viewport';
}

export function routeSlug(route: string): string {
  const [pathname = '', query = ''] = route.split('?');
  const clean = pathname.replace(/^\/+|\/+$/g, '');
  const base = clean ? safeName(clean.replace(/\//g, '--')) : 'home';
  return query ? `${base}--q-${safeName(query).slice(0, 80)}` : base;
}
