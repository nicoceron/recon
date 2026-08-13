import * as cheerio from 'cheerio';
import parseSrcset from 'parse-srcset';
import type { BrowserContext } from 'playwright';
import { AssetStore, fetchIssueReason } from '../interceptor/assetInterceptor.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { tryParse } from '../utils/urlUtils.js';

/**
 * Hosts whose URLs we want to capture & rewrite. Anything pointing to these hosts
 * but not yet in the AssetStore (e.g. srcset variants the browser didn't actually
 * fetch at the capture viewport, favicons skipped in headless mode) gets pulled
 * down in this top-up phase.
 */
const ASSET_HOST_PATTERNS = [
  /(?:^|\.)framerusercontent\.com$/i,
  /(?:^|\.)framerstatic\.com$/i,
  /(?:^|\.)framercanvas\.com$/i,
  /^framer\.com$/i,  // only path /m/* will be captured (handled by URL filter)
  /(?:^|\.)jspm\.io$/i,
];

const ATTRS_TO_SCAN = ['src', 'href', 'data-src', 'data-lazy-src', 'poster', 'content'];
const SRCSET_ATTRS = ['srcset', 'data-srcset'];
const MAX_TOPUP_BODY_BYTES = 50 * 1024 * 1024;

export async function topupAssets(
  context: BrowserContext,
  pages: Map<string, string>,
  store: AssetStore,
): Promise<{ fetched: number; skipped: number; failed: number }> {
  const candidates = new Set<string>();
  const scannedTextAssets = new Set<string>();
  const pageOrigins = new Set<string>();

  for (const pageUrl of pages.keys()) {
    const parsed = tryParse(pageUrl);
    if (parsed) pageOrigins.add(parsed.origin);
  }

  for (const [pageUrl, html] of pages) {
    collectAssetUrls(html, pageUrl, candidates);
  }

  let fetched = 0;
  let failed = 0;
  let skipped = candidates.size;
  const failedUrls = new Set<string>();

  // Use Playwright's request context — sends cookies + UA from the existing session
  const request = context.request;

  // Scan captured and newly fetched JSON / JS / text bodies recursively. Framer
  // can load tiny re-export modules that import the real bundle, so a single pass
  // leaves reachable modules unfetched.
  const batchSize = 8;
  for (;;) {
    collectUrlsFromTextAssets(store, scannedTextAssets, candidates, pageOrigins);

    const missing: string[] = [];
    for (const url of candidates) {
      if (!store.has(url) && !failedUrls.has(url)) {
        missing.push(url);
      }
    }

    logger.info({ candidates: candidates.size, missing: missing.length }, 'topup-starting');
    if (missing.length === 0) {
      skipped = Math.max(0, candidates.size - fetched - failed);
      break;
    }

    for (let i = 0; i < missing.length; i += batchSize) {
      const batch = missing.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (url) => {
          try {
            const response = await withRetry(
              () => request.fetch(url, { timeout: 30_000, ignoreHTTPSErrors: true }),
              { attempts: 2, label: `topup ${url}` },
            );
            const status = response.status();
            if (status >= 400) {
              logger.debug({ url, status }, 'topup-non-2xx');
              // The request completed and the publisher returned a non-success
              // response. Preserve that fact as source evidence, but do not
              // misclassify a broken live reference as an extractor failure.
              store.recordIssue({ url, reason: 'source-missing', detail: `top-up status=${status}` });
              failedUrls.add(url);
              failed += 1;
              return;
            }
            const contentLength = Number(response.headers()['content-length'] ?? 0);
            if (contentLength > MAX_TOPUP_BODY_BYTES) {
              store.recordIssue({ url, reason: 'too-large', detail: `top-up content-length=${contentLength}` });
              failedUrls.add(url);
              failed += 1;
              return;
            }
            const body = await response.body();
            if (body.length > MAX_TOPUP_BODY_BYTES) {
              store.recordIssue({ url, reason: 'too-large', detail: `top-up body-bytes=${body.length}` });
              failedUrls.add(url);
              failed += 1;
              return;
            }
            const contentType = response.headers()['content-type'] ?? '';
            store.record(url, body, contentType);
            fetched += 1;
          } catch (err) {
            logger.debug({ url, err: (err as Error).message }, 'topup-fetch-failed');
            store.recordIssue({ url, reason: fetchIssueReason(err), detail: `top-up: ${(err as Error).message}` });
            failedUrls.add(url);
            failed += 1;
          }
        }),
      );
    }

    skipped = candidates.size - fetched - failed;
  }

  const cmsFetched = await fetchFullFramerCmsFiles(context, store);
  fetched += cmsFetched;

  logger.info({ fetched, skipped, failed }, 'topup-complete');
  return { fetched, skipped, failed };
}

function collectUrlsFromTextAssets(
  store: AssetStore,
  scanned: Set<string>,
  candidates: Set<string>,
  allowedOrigins: ReadonlySet<string>,
): void {
  for (const rec of store.all()) {
    if (scanned.has(rec.localPath)) continue;
    const ct = rec.contentType.toLowerCase();
    if (
      !ct.includes('json') &&
      !ct.includes('javascript') &&
      !ct.includes('text/css') &&
      !ct.includes('text/plain')
    ) {
      scanned.add(rec.localPath);
      continue;
    }

    scanned.add(rec.localPath);
    const text = rec.body.toString('utf8');
    collectUrlsFromText(text, candidates, rec.url, allowedOrigins);
  }
}

async function fetchFullFramerCmsFiles(context: BrowserContext, store: AssetStore): Promise<number> {
  const urls = new Set<string>();
  for (const rec of store.all()) {
    if (!rec.localPath.endsWith('.framercms')) continue;
    const parsed = tryParse(rec.url);
    if (!parsed) continue;
    parsed.search = '';
    parsed.hash = '';
    urls.add(parsed.toString());
  }

  if (urls.size === 0) return 0;

  logger.info({ files: urls.size }, 'topup-full-cms-starting');
  let fetched = 0;
  const request = context.request;
  const batchSize = 8;
  const all = Array.from(urls);

  for (let i = 0; i < all.length; i += batchSize) {
    const batch = all.slice(i, i + batchSize);
    await Promise.all(
      batch.map(async (url) => {
        try {
          const response = await withRetry(
            () => request.fetch(url, { timeout: 30_000, ignoreHTTPSErrors: true }),
            { attempts: 2, label: `topup full cms ${url}` },
          );
          const status = response.status();
          if (status >= 400) {
            logger.debug({ url, status }, 'topup-full-cms-non-2xx');
            store.recordIssue({ url, reason: 'source-missing', detail: `full CMS top-up status=${status}` });
            return;
          }
          const body = await response.body();
          const contentType = response.headers()['content-type'] ?? '';
          store.replace(url, body, contentType);
          fetched += 1;
        } catch (err) {
          logger.debug({ url, err: (err as Error).message }, 'topup-full-cms-fetch-failed');
          store.recordIssue({ url, reason: fetchIssueReason(err), detail: `full CMS top-up: ${(err as Error).message}` });
        }
      }),
    );
  }

  logger.info({ fetched, files: urls.size }, 'topup-full-cms-complete');
  return fetched;
}

/**
 * Find any absolute URL pointing to a known asset host inside text content
 * (JSON manifests, JS bundles, CSS). Catches asset references constructed at
 * runtime that aren't in any HTML attribute.
 */
export function collectUrlsFromText(
  text: string,
  into: Set<string>,
  baseUrl?: string,
  allowedOrigins: ReadonlySet<string> = new Set(),
): void {
  // Match `https://[subdomain.]host/path` style absolute URLs.
  // The host part allows zero-or-more subdomains (so we match bare
  // `https://framerusercontent.com/...` as well as `https://x.framerusercontent.com/...`).
  // Stop the path at characters that can't appear in a URL value (quotes, whitespace,
  // brackets, comma — comma is a srcset separator and not valid inside a single URL).
  const re = /https?:\/\/(?:[a-z0-9-]+\.)*(?:framerusercontent|framerstatic|framercanvas)\.com[^\s"'`<>(){}\[\]\\,]*/gi;
  for (const m of text.matchAll(re)) {
    const raw = m[0]
      // Trim trailing punctuation that often follows URLs in JSON/JS
      .replace(/[.,;:!?'"`)\]}>]+$/g, '');
    if (shouldFetchHost(raw, allowedOrigins)) into.add(raw);
  }

  collectFramerCmsUrlsFromText(text, into);

  if (!baseUrl) return;

  collectRelativeModuleSpecifiers(text, baseUrl, into, allowedOrigins);
}

function collectFramerCmsUrlsFromText(text: string, into: Set<string>): void {
  const pattern =
    /new URL\(\s*(["'`])([^"'`]+\.framercms)\1\s*,\s*(["'`])(https?:\/\/(?:[a-z0-9-]+\.)*framerusercontent\.com\/modules\/[^"'`]+)\3\s*\)/gi;

  for (const match of text.matchAll(pattern)) {
    const relativePath = match[2];
    const moduleBase = match[4];
    if (!relativePath || !moduleBase) continue;
    const absolute = tryParse(relativePath, moduleBase);
    if (!absolute) continue;
    absolute.pathname = absolute.pathname.replace('/modules/', '/cms/');
    absolute.search = '';
    absolute.hash = '';
    const url = absolute.toString();
    if (shouldFetchHost(url)) into.add(url);
  }
}

function collectRelativeModuleSpecifiers(
  text: string,
  baseUrl: string,
  into: Set<string>,
  allowedOrigins: ReadonlySet<string>,
): void {
  const patterns = [
    /\bimport\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g,
    /\bimport\s*(?:(?:[\w*{}\s,]+)\s*from\s*)?(["'`])([^"'`]+)\1/g,
    /\bexport\s*(?:[\w*{}\s,]+)\s*from\s*(["'`])([^"'`]+)\1/g,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[2];
      if (!specifier?.startsWith('.')) continue;
      const absolute = tryParse(specifier, baseUrl)?.toString();
      if (absolute && shouldFetchHost(absolute, allowedOrigins)) into.add(absolute);
    }
  }
}

function collectAssetUrls(
  html: string,
  baseUrl: string,
  into: Set<string>,
): void {
  const $ = cheerio.load(html);

  for (const attr of ATTRS_TO_SCAN) {
    $(`[${attr}]`).each((_i, el) => {
      const tag = 'tagName' in el ? el.tagName.toLowerCase() : '';
      if (!isAssetAttribute(tag, attr)) return;
      if (tag === 'link' && attr === 'href' && !isFetchableLinkElement($(el).attr('rel'), $(el).attr('as'))) {
        return;
      }
      const value = $(el).attr(attr);
      if (!value) return;
      if (tag === 'meta' && attr === 'content') {
        const field = `${$(el).attr('property') ?? ''} ${$(el).attr('name') ?? ''} ${$(el).attr('itemprop') ?? ''}`;
        if (!/(?:^|[:\s_-])(?:image|video|audio|icon|url)(?:$|[:\s_-])/i.test(field)) return;
        // Metadata adjacent to a media URL often contains MIME type and numeric
        // dimensions (og:image:type/width/height). They are descriptors, not
        // relative paths such as /image/jpeg or /1200.
        if (/^\s*\d+(?:\.\d+)?\s*$/.test(value) || /^\s*[\w.+-]+\/[\w.+-]+\s*$/.test(value)) return;
      }
      const abs = tryParse(value, baseUrl)?.toString();
      if (abs && shouldFetchExplicitAsset(abs)) into.add(abs);
    });
  }

  for (const attr of SRCSET_ATTRS) {
    $(`[${attr}]`).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      let parts: Array<{ url: string }>;
      try {
        parts = parseSrcset(value) as Array<{ url: string }>;
      } catch {
        return;
      }
      for (const p of parts) {
        const abs = tryParse(p.url, baseUrl)?.toString();
        if (abs && shouldFetchExplicitAsset(abs)) into.add(abs);
      }
    });
  }

  // Catch-all: anything in inline style url(...) or in <meta> content that's a known host
  $('[style]').each((_i, el) => {
    const value = $(el).attr('style');
    if (!value || !value.includes('url(')) return;
    for (const m of value.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) {
      const abs = tryParse(m[1]!, baseUrl)?.toString();
      if (abs && shouldFetchExplicitAsset(abs)) into.add(abs);
    }
  });
}

function shouldFetchExplicitAsset(absoluteUrl: string): boolean {
  const url = tryParse(absoluteUrl);
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
  const host = url.hostname.toLowerCase();
  if (/(?:^|\.)(?:events|analytics|telemetry)\.framer\.com$/i.test(host)) return false;
  if (/(?:^|\.)ingest\.sentry\.io$/i.test(host)) return false;
  if (host === 'api.framer.com') {
    return /^\/(?:modules|web\/(?:fontshare|v1\/sites\/hostnames|v2\/projects\/[^/]+\/assets))/i.test(url.pathname);
  }
  if (host === 'framer.com' || host === 'www.framer.com') return url.pathname.startsWith('/m/');
  return true;
}

function isAssetAttribute(tag: string, attr: string): boolean {
  if (attr === 'href') return tag === 'link' || tag === 'use';
  if (attr === 'content') return tag === 'meta';
  return ['img', 'source', 'video', 'audio', 'iframe', 'script', 'use', 'object', 'embed'].includes(tag);
}

/**
 * Connection/navigation hints are URLs, but they are not downloadable assets.
 * Fetching a bare preconnect origin (for example https://fonts.gstatic.com/) only
 * creates a misleading 404 in the reconstruction ledger.
 */
function isFetchableLinkElement(relValue?: string, asValue?: string): boolean {
  const rel = new Set((relValue ?? '').toLowerCase().split(/\s+/).filter(Boolean));
  if (rel.has('dns-prefetch') || rel.has('preconnect') || rel.has('canonical') || rel.has('alternate')) {
    return false;
  }
  if (rel.has('stylesheet') || rel.has('icon') || rel.has('manifest') || rel.has('modulepreload')) return true;
  if (rel.has('preload') || rel.has('prefetch')) return (asValue ?? '').toLowerCase() !== 'document';
  return false;
}

function shouldFetchHost(absoluteUrl: string, allowedOrigins: ReadonlySet<string> = new Set()): boolean {
  const u = tryParse(absoluteUrl);
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  // For framer.com, only capture /m/* (modules) — exclude editor/login URLs
  if (u.hostname.toLowerCase() === 'framer.com' || u.hostname.toLowerCase() === 'www.framer.com') {
    return u.pathname.startsWith('/m/');
  }
  return allowedOrigins.has(u.origin) || ASSET_HOST_PATTERNS.some((re) => re.test(u.hostname));
}
