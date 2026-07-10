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
 * Uses the canonical origin + pathname so ordinary transform variants (for
 * example `?width=512` vs `?width=1024`) map to the same file. Optimizer
 * endpoints such as Next.js `/_next/image?url=/images/hero.jpg&w=1200` are a
 * special case: the `url`/`src` parameter identifies a different underlying
 * asset, so it becomes part of the filename while dimensions remain ignored.
 * AssetStore.record() then keeps the largest captured size of each real image.
 */
export function assetLocalPath(input: string, contentType?: string): string {
  const u = tryParse(input);
  if (!u) return path.join('assets', 'unknown', sha8(input));
  const host = u.hostname.toLowerCase();
  const rawPath = decodeURIComponent(u.pathname.replace(/^\/+/, ''));
  const segments = rawPath.split('/').map(sanitizeSegment).filter(Boolean);
  let basename = segments.pop() ?? 'index';

  const semanticIdentity = u.searchParams.get('url') ?? u.searchParams.get('src');
  if (semanticIdentity) {
    const decodedIdentity = safeDecodeURIComponent(semanticIdentity);
    const identityUrl = tryParse(decodedIdentity, u.origin);
    const identityPath = identityUrl?.pathname ?? decodedIdentity;
    const identityBase =
      sanitizeSegment(path.posix.basename(identityPath) || 'asset')
        .replace(/\.[a-z0-9]{1,8}$/i, '')
        .slice(0, 48) || 'asset';
    basename = `${basename}--${identityBase}-${sha8(decodedIdentity)}`;
  }

  const ext = extensionFromContentType(contentType);
  if (ext && shouldAppendContentTypeExtension(basename, ext)) {
    basename = `${basename}.${ext}`;
  }

  return path.posix.join('assets', host, ...segments, basename);
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function shouldAppendContentTypeExtension(basename: string, contentExt: string): boolean {
  const currentExt = path.extname(basename).replace(/^\./, '').toLowerCase();
  if (!currentExt) return true;
  if (currentExt === contentExt.toLowerCase()) return false;

  // URLs like /m/icons/Star.js@0.0.57 have a version suffix after the real
  // extension. Static servers infer MIME from the final suffix, so append .js.
  return basename.toLowerCase().includes(`.${contentExt.toLowerCase()}@`);
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
