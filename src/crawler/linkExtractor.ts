import * as cheerio from 'cheerio';
import { normalizePageUrl, sameOrigin } from '../utils/urlUtils.js';

/**
 * Extract all same-origin anchor hrefs from an HTML document.
 * Filters out: external links, mailto/tel/javascript schemes, fragment-only links.
 */
export function extractInternalLinks(html: string, pageUrl: string): string[] {
  const $ = cheerio.load(html);
  const seen = new Set<string>();
  const out: string[] = [];

  $('a[href]').each((_i, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) {
      return;
    }
    const normalized = normalizePageUrl(href, pageUrl);
    if (!normalized) return;
    if (!sameOrigin(normalized, pageUrl)) return;
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  });

  return out;
}
