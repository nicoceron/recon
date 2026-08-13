import type { BrowserContext } from 'playwright';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { assetLocalPath, rootRelativeAssetPath } from '../utils/urlUtils.js';

export interface AssetRecord {
  url: string;
  body: Buffer;
  contentType: string;
  localPath: string;
  rootRelativePath: string;
}

export interface AssetCaptureIssue {
  url: string;
  reason:
    | 'too-large'
    | 'body-read-failed'
    | 'privacy-excluded'
    | 'fetch-failed'
    | 'source-missing'
    | 'source-unreachable';
  detail?: string;
}

export function fetchIssueReason(error: unknown): AssetCaptureIssue['reason'] {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'ENOTFOUND' || /\b(?:ENOTFOUND|ERR_NAME_NOT_RESOLVED)\b/i.test(message)
    ? 'source-unreachable'
    : 'fetch-failed';
}

const MAX_BODY_BYTES = 50 * 1024 * 1024;

const SKIP_HOST_PATTERNS = [
  /(?:^|\.)events\.framer\.com$/i,
  /(?:^|\.)analytics\.framer\.com$/i,
  /(?:^|\.)telemetry\.framer\.com$/i,
];

const SKIP_PATH_PATTERNS = [
  /\/telemetry($|\/)/i,
  /\/analytics($|\/)/i,
];

/**
 * Privacy filter: never persist responses from these auth / editor endpoints
 * to disk — they contain JWTs, session tokens, owner-only metadata, etc.
 * The intercept still serves them to the live page (so the in-browser experience
 * during crawling works), but they are excluded from AssetStore so they never
 * land in `output/`.
 */
const PRIVACY_BLOCKLIST = [
  /(?:^|\.)api\.framer\.com$/i, // auth tokens, owner ACLs — covers /auth/, /edit/
  /(?:^|\.)framer\.com$/i,      // /projects, /edit, login responses
];

const PRIVACY_PATH_ALLOWLIST: Array<{ host: RegExp; path: RegExp }> = [
  // Runtime config the static site genuinely needs from api.framer.com:
  { host: /api\.framer\.com$/i, path: /^\/(modules|web\/(fontshare|v1\/sites\/hostnames|v2\/projects\/[^/]+\/assets))/i },
  // Framer module bundles (loaded by the runtime — JS only, no auth)
  { host: /(?:^|\.)framer\.com$/i, path: /^\/m\// },
];

/**
 * AssetStore captures every HTTP response body the browser fetched, keyed by
 * `assetKey(url)` (origin + path, query stripped) for dedup.  Each unique
 * `originalUrl` (with query) gets its own entry so per-transform variants
 * (e.g. `?w=512`) are preserved as separate files.
 */
export class AssetStore {
  private records = new Map<string, AssetRecord>();
  /** original URL → local path (so the rewriter can lookup any URL it sees) */
  private urlToLocalPath = new Map<string, string>();
  private captureIssues: AssetCaptureIssue[] = [];

  record(originalUrl: string, body: Buffer, contentType: string): AssetRecord {
    return this.recordInternal(originalUrl, body, contentType, false);
  }

  replace(originalUrl: string, body: Buffer, contentType: string): AssetRecord {
    return this.recordInternal(originalUrl, body, contentType, true);
  }

  private recordInternal(
    originalUrl: string,
    body: Buffer,
    contentType: string,
    replaceExisting: boolean,
  ): AssetRecord {
    const localPath = assetLocalPath(originalUrl, contentType);
    // Always map this URL → localPath (so srcset variants all resolve to the
    // canonical file).
    this.urlToLocalPath.set(originalUrl, localPath);

    const existing = this.records.get(localPath);
    if (existing) {
      // Same canonical path captured before (a different size variant). Keep
      // whichever body is larger — that's almost always the higher-resolution
      // image, which the browser can scale down via CSS at smaller breakpoints.
      if (replaceExisting || body.length > existing.body.length) {
        const updated: AssetRecord = { ...existing, body, contentType, url: originalUrl };
        this.records.set(localPath, updated);
        return updated;
      }
      return existing;
    }

    const rec: AssetRecord = {
      url: originalUrl,
      body,
      contentType,
      localPath,
      rootRelativePath: rootRelativeAssetPath(localPath),
    };
    this.records.set(localPath, rec);
    return rec;
  }

  has(originalUrl: string): boolean {
    return this.urlToLocalPath.has(originalUrl);
  }

  lookup(originalUrl: string): AssetRecord | undefined {
    const lp = this.urlToLocalPath.get(originalUrl);
    return lp ? this.records.get(lp) : undefined;
  }

  /** All recorded assets (deduped by local path) */
  all(): AssetRecord[] {
    return Array.from(this.records.values());
  }

  size(): number {
    return this.records.size;
  }

  /** Read-only view of the URL → local path map for the rewriter */
  urlMap(): ReadonlyMap<string, string> {
    return this.urlToLocalPath;
  }

  recordIssue(issue: AssetCaptureIssue): void {
    if (this.captureIssues.some((item) => item.url === issue.url && item.reason === issue.reason)) return;
    this.captureIssues.push(issue);
  }

  issues(): readonly AssetCaptureIssue[] {
    return this.captureIssues;
  }
}

export interface InterceptorOptions {
  /** Hostname (or any substring) of the page being crawled — its HTML is captured by the crawler, not here */
  pageHost: string;
}

export async function installAssetInterceptor(
  context: BrowserContext,
  store: AssetStore,
  opts: InterceptorOptions,
): Promise<void> {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = request.url();

    if (url.startsWith('data:') || url.startsWith('blob:')) {
      await route.continue();
      return;
    }

    if (request.resourceType() === 'document' && request.frame().parentFrame() && isGpuRiskyEmbedUrl(url)) {
      logger.debug({ url }, 'gpu-risky-embed-stabilized-for-capture');
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: stableEmbedDocument(url),
      });
      return;
    }

    if (shouldSkip(url)) {
      // Replace tracking calls with a 204 no-content so the page doesn't error
      await route.fulfill({ status: 204, body: '' });
      return;
    }

    try {
      const response = await withRetry(
        () => route.fetch({ timeout: 30_000 }),
        { attempts: 3, label: `fetch ${url}` },
      );
      const headers = response.headers();
      const contentType = headers['content-type'] ?? '';
      const contentLength = parseInt(headers['content-length'] ?? '0', 10);

      let body: Buffer;
      if (contentLength && contentLength > MAX_BODY_BYTES) {
        logger.warn({ url, contentLength }, 'asset-too-large-skipping-capture');
        store.recordIssue({ url, reason: 'too-large', detail: `content-length=${contentLength}` });
        await route.continue();
        return;
      }

      try {
        body = await response.body();
      } catch (err) {
        logger.warn({ url, err: (err as Error).message }, 'asset-body-read-error');
        store.recordIssue({ url, reason: 'body-read-failed', detail: (err as Error).message });
        await route.continue();
        return;
      }

      // Don't double-record the page HTML the crawler is about to capture itself
      const isPageDocument =
        request.resourceType() === 'document' &&
        url.includes(opts.pageHost) &&
        contentType.includes('text/html');

      if (!isPageDocument && isPrivacySafe(url)) {
        store.record(url, body, contentType);
      } else if (!isPageDocument) {
        logger.debug({ url }, 'asset-skipped-privacy-blocklist');
        store.recordIssue({ url: redactIssueUrl(url), reason: 'privacy-excluded' });
      }

      await route.fulfill({ response, body });
    } catch (err) {
      logger.debug({ url, err: (err as Error).message }, 'route-fetch-failed-continuing');
      store.recordIssue({ url, reason: fetchIssueReason(err), detail: (err as Error).message });
      await route.continue().catch(() => undefined);
    }
  });
}

export function isGpuRiskyEmbedUrl(value: string): boolean {
  try {
    return /(?:^|\.)(?:youtube(?:-nocookie)?\.com|youtu\.be|vimeo\.com)$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

function stableEmbedDocument(value: string): string {
  const parsed = new URL(value);
  const youtubeId = /youtube(?:-nocookie)?\.com$/i.test(parsed.hostname)
    ? parsed.pathname.match(/^\/embed\/([A-Za-z0-9_-]{6,})/)?.[1]
    : undefined;
  const background = youtubeId
    ? `background:#111 url(https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg) center/cover no-repeat;`
    : 'background:#111;';
  return '<!doctype html><meta name="color-scheme" content="dark">' +
    `<style>html,body{height:100%;margin:0}body{display:grid;place-items:center;${background}color:#fff;font:14px/1.4 sans-serif;text-align:center}span{padding:8px 12px;background:#000a;border-radius:4px}</style>` +
    '<body><span>Embedded media preserved in source evidence</span></body>';
}

function redactIssueUrl(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.search = '';
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '[redacted URL]';
  }
}

function shouldSkip(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (SKIP_HOST_PATTERNS.some((re) => re.test(parsed.hostname))) return true;
  if (SKIP_PATH_PATTERNS.some((re) => re.test(parsed.pathname))) return true;
  return false;
}

/**
 * Returns true if the URL is safe to persist to disk. URLs on PRIVACY_BLOCKLIST
 * hosts are only allowed if they match an explicit PRIVACY_PATH_ALLOWLIST entry
 * (runtime config the rendered site genuinely needs).
 */
function isPrivacySafe(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  const host = parsed.hostname;
  const blocked = PRIVACY_BLOCKLIST.some((re) => re.test(host));
  if (!blocked) return true;
  return PRIVACY_PATH_ALLOWLIST.some(
    ({ host: hr, path: pr }) => hr.test(host) && pr.test(parsed.pathname),
  );
}
