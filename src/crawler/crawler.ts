import PQueue from 'p-queue';
import type { BrowserContext, Page } from 'playwright';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { normalizePageUrl, sameOrigin } from '../utils/urlUtils.js';
import { extractInternalLinks } from './linkExtractor.js';
import { inlineGoogleMapIframes } from './mapCapture.js';
import { applyForcedTheme, installForcedTheme, type ForcedTheme } from './themeCapture.js';

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
  /** Origin (scheme://host) of the start URL */
  origin: string;
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
  const visited = new Set<string>([startNormalized]);
  const queue: Array<{ url: string; depth: number }> = [{ url: startNormalized, depth: 0 }];
  for (const additionalUrl of opts.additionalUrls ?? []) {
    const normalized = normalizePageUrl(additionalUrl, startNormalized);
    if (!normalized || !inScope(normalized) || visited.has(normalized)) continue;
    visited.add(normalized);
    queue.push({ url: normalized, depth: 1 });
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
            logger.error({ url: next.url, err: (err as Error).message }, 'page-crawl-failed');
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
  return { pages, pageStyles, origin };
}

async function crawlOnePage(
  context: BrowserContext,
  url: string,
  opts: CrawlOptions,
): Promise<{ html: string; styles?: string }> {
  const page = await context.newPage();
  await page.setViewportSize({ width: opts.viewportWidth, height: opts.viewportHeight });
  await installForcedTheme(page, opts.forceTheme);
  try {
    logger.info({ url }, 'crawling-page');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.pageTimeoutMs });

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

    const styles = await collectAccessibleCss(page);
    return { html: await page.content(), styles };
  } finally {
    await page.close().catch(() => undefined);
  }
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
 * Scroll the page in 5 steps to trigger lazy-loaded images / IntersectionObserver assets.
 */
async function scrollPage(page: Page): Promise<void> {
  try {
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    const steps = 5;
    for (let i = 1; i <= steps; i += 1) {
      const y = Math.floor((scrollHeight * i) / steps);
      await page.evaluate((target) => window.scrollTo(0, target), y);
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
      await sleep(300);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(200);
  } catch (err) {
    logger.debug({ err: (err as Error).message }, 'scroll-error-ignored');
  }
}
