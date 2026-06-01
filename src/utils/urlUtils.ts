import crypto from 'node:crypto';
import path from 'node:path';
import { extensionFromContentType } from './mimeUtils.js';

const TRACKING_PARAM_PREFIXES = ['utm_', 'fbclid', 'gclid', 'mc_'];

export function tryParse(input: string, base?: string): URL | null {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
}

/**
 * Normalize a URL for crawl deduplication: drop hash, lowercase host, strip tracking params,
 * collapse trailing slash on path-only URLs.
 */
export function normalizePageUrl(input: string, base?: string): string | null {
  const u = tryParse(input, base);
  if (!u) return null;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  const params = new URLSearchParams();
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAM_PREFIXES.some((p) => k.toLowerCase().startsWith(p))) continue;
    params.append(k, v);
  }
  u.search = params.toString() ? `?${params.toString()}` : '';
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.replace(/\/+$/, '');
  }
  return u.toString();
}

export function sameOrigin(a: string, b: string): boolean {
  const ua = tryParse(a);
  const ub = tryParse(b);
  if (!ua || !ub) return false;
  return ua.origin === ub.origin;
}

/**
 * Lookup key for an asset (drops query/hash). Multiple variants of the same image
 * (different transforms) will collide in the key but each gets its own filename
 * via assetLocalPath().
 */
export function assetKey(input: string): string {
  const u = tryParse(input);
  if (!u) return input;
  return `${u.origin}${u.pathname}`;
}

/**
 * Convert a Framer asset URL to a local path under output/assets/.
 * Uses the canonical (query-less) origin + pathname so that any query-string
 * variant of the same asset (e.g. `?width=512` vs `?width=1024`) maps to the
 * SAME file. The static server (sirv) ignores query strings, so this guarantees
 * runtime-constructed asset URLs resolve regardless of which variant the JS asks
 * for. AssetStore.record() handles keeping the largest variant when multiple
 * sizes of the same image are captured.
 */
export function assetLocalPath(input: string, contentType?: string): string {
  const u = tryParse(input);
  if (!u) return path.join('assets', 'unknown', sha8(input));
  const host = u.hostname.toLowerCase();
  const rawPath = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const segments = rawPath.split('/').map(sanitizeSegment).filter(Boolean);
  let basename = segments.pop() ?? 'index';

  if (!path.extname(basename)) {
    const ext = extensionFromContentType(contentType);
    if (ext) basename = `${basename}.${ext}`;
  }

  return path.posix.join('assets', host, ...segments, basename);
}

/**
 * Convert a page URL to a local HTML path: "/" → "index.html", "/about" → "about/index.html"
 */
export function pageLocalPath(pageUrl: string): string {
  const u = tryParse(pageUrl);
  if (!u) return 'index.html';
  let p = decodeURIComponent(u.pathname).replace(/^\/+/, '').replace(/\/+$/, '');
  if (p === '') return 'index.html';
  // Sanitize each segment
  const segments = p.split('/').map(sanitizeSegment).filter(Boolean);
  if (segments.length === 0) return 'index.html';
  return path.posix.join(...segments, 'index.html');
}

/**
 * Map an absolute URL (possibly with query) to an absolute root-relative path
 * suitable for embedding in HTML/CSS/JS. Returns null if not in the asset map.
 */
export function rootRelativeAssetPath(localPath: string): string {
  return '/' + localPath.replace(/\\/g, '/');
}

function sanitizeSegment(seg: string): string {
  // Strip path-traversal and characters that are unsafe on common filesystems.
  return seg.replace(/[\\:*?"<>|]/g, '_').replace(/\.\.+/g, '_');
}

function sha8(s: string): string {
  return crypto.createHash('sha1').update(s).digest('hex').slice(0, 8);
}
