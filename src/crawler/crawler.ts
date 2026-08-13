import PQueue from 'p-queue';
import type { BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { normalizePageUrl, sameOrigin } from '../utils/urlUtils.js';
import { extractInternalLinks } from './linkExtractor.js';
import { inlineGoogleMapIframes } from './mapCapture.js';
import { applyForcedTheme, installForcedTheme, type ForcedTheme } from './themeCapture.js';
import { discoverSitemapPageUrls } from './sitemapDiscovery.js';

export interface CrawlOptions {
  startUrl: string;
  /** Additional same-origin URLs to capture without relying on anchor discovery. */
  additionalUrls?: string[];
  concurrency: number;
  maxDepth: number;
  viewportWidth: number;
  viewportHeight: number;
  scroll: boolean;
  pageTimeoutMs: number;
  /** Force browser color scheme and root theme class during capture. */
  forceTheme?: ForcedTheme;
  /**
   * If true, only crawl URLs whose path starts with the start URL's path.
   * Use for sandboxed previews like `framer.app/preview/<id>` where same-origin
   * isn't a tight enough scope.
   */
  pathPrefixScope?: boolean;
}

export interface CrawlResult {
  /** Map<normalized page URL, captured HTML> */
  pages: Map<string, string>;
  /** Map<normalized page URL, accessible CSSOM captured after hydration/scroll> */
  pageStyles: Map<string, string>;
  /** Map<normalized page URL, original server response HTML before hydration> */
  sourcePages: Map<string, string>;
  /** Origin (scheme://host) of the start URL */
  origin: string;
  /** Every normalized route selected by start/link/sitemap discovery. */
  discoveredUrls: string[];
  /** Routes selected for crawling that could not be captured. */
  failures: Array<{ url: string; reason: string }>;
}

/**
 * BFS crawl of a Framer site. The asset interceptor must already be installed
 * on `context` before calling this.
 */
export async function crawlSite(context: BrowserContext, opts: CrawlOptions): Promise<CrawlResult> {
  const startNormalized = normalizePageUrl(opts.startUrl);
  if (!startNormalized) throw new Error(`Cannot normalize start URL: ${opts.startUrl}`);
  const startParsed = new URL(startNormalized);
  const origin = startParsed.origin;
  const pathPrefix = opts.pathPrefixScope
    ? startParsed.pathname.replace(/\/+$/, '')
    : '';

  const inScope = (url: string): boolean => {
    if (!sameOrigin(url, origin)) return false;
    if (!pathPrefix) return true;
    try {
      const p = new URL(url).pathname.replace(/\/+$/, '');
      return p === pathPrefix || p.startsWith(pathPrefix + '/');
    } catch {
      return false;
    }
  };

  const pages = new Map<string, string>();
  const pageStyles = new Map<string, string>();
  const sourcePages = new Map<string, string>();
  const failures: Array<{ url: string; reason: string }> = [];
  const visited = new Set<string>([startNormalized]);
  const queue: Array<{ url: string; depth: number }> = [{ url: startNormalized, depth: 0 }];
  for (const additionalUrl of opts.additionalUrls ?? []) {
    const normalized = normalizePageUrl(additionalUrl, startNormalized);
    if (!normalized || !inScope(normalized) || visited.has(normalized)) continue;
    visited.add(normalized);
    queue.push({ url: normalized, depth: 1 });
  }
  if (opts.maxDepth !== 0) {
    const sitemapUrls = await discoverSitemapPageUrls(context, startNormalized);
    for (const sitemapUrl of sitemapUrls) {
      if (!inScope(sitemapUrl) || visited.has(sitemapUrl)) continue;
      visited.add(sitemapUrl);
      queue.push({ url: sitemapUrl, depth: 1 });
    }
  }
  const pQueue = new PQueue({ concurrency: opts.concurrency });

  let inFlight = 0;

  while (queue.length > 0 || inFlight > 0) {
    while (queue.length > 0 && pQueue.pending + pQueue.size < opts.concurrency * 2) {
      const next = queue.shift()!;
      inFlight += 1;
      pQueue
        .add(async () => {
          try {
            const captured = await crawlOnePage(context, next.url, opts);
            pages.set(next.url, captured.html);
            if (captured.sourceHtml?.trim()) sourcePages.set(next.url, captured.sourceHtml);
            if (captured.styles?.trim()) pageStyles.set(next.url, captured.styles);
            if (opts.maxDepth < 0 || next.depth < opts.maxDepth) {
              const links = extractInternalLinks(captured.html, next.url);
              for (const link of links) {
                if (!inScope(link)) continue;
                if (visited.has(link)) continue;
                visited.add(link);
                queue.push({ url: link, depth: next.depth + 1 });
              }
            }
          } catch (err) {
            const reason = (err as Error).message;
            failures.push({ url: next.url, reason });
            logger.error({ url: next.url, err: reason }, 'page-crawl-failed');
          } finally {
            inFlight -= 1;
          }
        })
        .catch(() => undefined);
    }
    await sleep(50);
  }

  await pQueue.onIdle();

  logger.info({ pages: pages.size, visited: visited.size, origin }, 'crawl-complete');
  return { pages, pageStyles, sourcePages, origin, discoveredUrls: [...visited], failures };
}

export async function crawlOnePage(
  context: BrowserContext,
  url: string,
  opts: CrawlOptions,
): Promise<{ html: string; sourceHtml?: string; styles?: string }> {
  const page = await context.newPage();
  await page.setViewportSize({ width: opts.viewportWidth, height: opts.viewportHeight });
  await installForcedTheme(page, opts.forceTheme);
  try {
    const maxAttempts = isWaybackReplayUrl(url) ? 4 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      logger.info({ url, attempt, maxAttempts }, 'crawling-page');
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs }).catch(async (err) => {
        if (attempt === maxAttempts) throw err;
        logger.warn({ url, attempt, maxAttempts, err: (err as Error).message }, 'wayback-navigation-failed-retrying');
        await sleep(1_000 * attempt);
        return undefined;
      });
      if (!response) continue;
      const sourceHtml = await response?.text().catch(() => undefined);

      try {
        await page.waitForLoadState('networkidle', { timeout: 30_000 });
      } catch {
        logger.debug({ url }, 'networkidle-timeout-falling-back-to-load');
        await page.waitForLoadState('load', { timeout: 10_000 }).catch(() => undefined);
      }
      await applyForcedTheme(page, opts.forceTheme);

      if (opts.scroll) {
        await scrollPage(page);
      }

      await applyForcedTheme(page, opts.forceTheme);
      await inlineGoogleMapIframes(page, url);
      await applyForcedTheme(page, opts.forceTheme);
      await page.evaluate(() => window.scrollTo(0, 0)).catch(() => undefined);
      await sleep(200);

      const html = await page.content();
      if (isIncompleteWaybackCapture(url, html)) {
        if (attempt === maxAttempts) {
          throw new Error(`Wayback replay remained incomplete after ${maxAttempts} attempts: ${url}`);
        }
        logger.warn({ url, attempt, maxAttempts }, 'wayback-capture-incomplete-retrying');
        await sleep(1_000 * attempt);
        continue;
      }

      const styles = await collectAccessibleCss(page);
      return { html, sourceHtml, styles };
    }
    throw new Error(`Could not capture page: ${url}`);
  } finally {
    await page.close().catch(() => undefined);
  }
}

function isWaybackReplayUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'web.archive.org' && /^\/web\/\d+/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function isIncompleteWaybackCapture(url: string, html: string): boolean {
  if (!isWaybackReplayUrl(url)) return false;
  if (/Application error:\s*a client-side exception has occurred/i.test(html)) return true;
  return /id=["']module-(?:platform|droid-computers|analytics|agent-readiness|missions)["'][^>]*>\s*<div[^>]*style=["'][^"']*min-height\s*:\s*\d+px[^"']*["'][^>]*>\s*<\/div>\s*<\/div>/i.test(html);
}

async function collectAccessibleCss(page: Page): Promise<string> {
  try {
    const css = await page.evaluate(`(() => {
      const seen = new Set();
      const chunks = [];
      function addCss(css) {
        const text = String(css || '').trim();
        if (!text || seen.has(text)) return;
        seen.add(text);
        chunks.push(text);
      }

      Array.from(document.styleSheets).forEach((sheet) => {
        try {
          if (!sheet.cssRules) return;
          addCss(Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\\n'));
        } catch (_) {
          // Cross-origin stylesheets can block cssRules; inline <style> tags are captured below.
        }
      });
      Array.from(document.querySelectorAll('style')).forEach((style) => addCss(style.textContent || ''));

      return chunks.join('\\n');
    })()`);
    return typeof css === 'string' ? css : '';
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'cssom-capture-error-ignored');
    return '';
  }
}

/**
 * Scroll the page to trigger lazy-loaded content. Client-heavy pages may
 * virtualize whole modules, so retain the richest DOM observed for each module
 * and freeze canvas pixels before the runtime unmounts them again.
 */
export async function scrollPage(page: Page): Promise<void> {
  try {
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    const steps = 5;
    const moduleTargets = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('[id^="module-"]'))
      .map((element) => Math.max(0, Math.floor(element.getBoundingClientRect().top + window.scrollY - window.innerHeight * 0.2))));
    const targets = [...new Set([
      0,
      ...moduleTargets,
      ...Array.from({ length: steps }, (_, index) => Math.floor((scrollHeight * (index + 1)) / steps)),
    ])].sort((a, b) => a - b);

    await recordLazyModuleSnapshots(page);
    for (const y of targets) {
      await page.evaluate((target) => window.scrollTo(0, target), y);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      await sleep(500);
      await recordLazyModuleSnapshots(page);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(200);
    await restoreLazyModuleSnapshots(page);
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'scroll-error-ignored');
  }
}

async function recordLazyModuleSnapshots(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const scope = window;
    const store = scope.__STATIC_MODULE_SNAPSHOTS__ || (scope.__STATIC_MODULE_SNAPSHOTS__ = {});
    document.querySelectorAll('[id^="module-"]').forEach((module) => {
      if (!module.id) return;
      const clone = module.cloneNode(true);
      const liveCanvases = Array.from(module.querySelectorAll('canvas'));
      Array.from(clone.querySelectorAll('canvas')).forEach((canvas, index) => {
        const live = liveCanvases[index];
        if (!live) return;
        try {
          const image = document.createElement('img');
          image.setAttribute('data-static-canvas-snapshot', '1');
          image.alt = live.getAttribute('aria-label') || live.getAttribute('title') || '';
          image.className = live.className || '';
          image.setAttribute('style', live.getAttribute('style') || '');
          image.width = live.width;
          image.height = live.height;
          image.src = live.toDataURL('image/png');
          canvas.replaceWith(image);
        } catch (_) {
          // A tainted canvas cannot be serialized; keep its semantic element.
        }
      });
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      const elements = clone.querySelectorAll('*').length;
      const placeholderOnly = !text && elements <= 1 && Boolean(clone.querySelector('[style*="min-height"]'));
      if (placeholderOnly) return;
      const html = clone.innerHTML;
      const score = elements * 1000 + text.length + html.length;
      if (!store[module.id] || score > store[module.id].score) store[module.id] = { html, score };
    });
  })()`);
}

async function restoreLazyModuleSnapshots(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    const store = window.__STATIC_MODULE_SNAPSHOTS__ || {};
    Object.keys(store).forEach((id) => {
      const module = document.getElementById(id);
      if (module) module.innerHTML = store[id].html;
    });
  })()`);
}
