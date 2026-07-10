import * as cheerio from 'cheerio';
import type { BrowserContext } from 'playwright';
import { logger } from '../utils/logger.js';
import { normalizePageUrl, sameOrigin } from '../utils/urlUtils.js';

const DEFAULT_MAX_SITEMAP_URLS = 200;

export async function discoverSitemapPageUrls(
  context: BrowserContext,
  startUrl: string,
  maxUrls = DEFAULT_MAX_SITEMAP_URLS,
): Promise<string[]> {
  const origin = new URL(startUrl).origin;
  const sitemapQueue = [`${origin}/sitemap.xml`];
  const visitedSitemaps = new Set<string>();
  const pages = new Set<string>();

  try {
    const robots = await context.request.get(`${origin}/robots.txt`, { timeout: 10_000 });
    if (robots.ok()) {
      for (const sitemap of parseRobotsSitemaps(await robots.text())) sitemapQueue.push(sitemap);
    }
  } catch {
    // /sitemap.xml remains the conventional fallback.
  }

  while (sitemapQueue.length > 0 && pages.size < maxUrls) {
    const sitemapUrl = sitemapQueue.shift()!;
    if (visitedSitemaps.has(sitemapUrl)) continue;
    visitedSitemaps.add(sitemapUrl);
    try {
      const response = await context.request.get(sitemapUrl, { timeout: 15_000 });
      if (!response.ok()) continue;
      const xml = await response.text();
      const parsed = parseSitemap(xml);
      if (parsed.kind === 'index') {
        for (const child of parsed.urls) {
          const normalized = normalizePageUrl(child, sitemapUrl);
          if (normalized && !visitedSitemaps.has(normalized)) sitemapQueue.push(normalized);
        }
        continue;
      }
      for (const candidate of parsed.urls) {
        const normalized = normalizePageUrl(candidate, sitemapUrl);
        if (!normalized || !sameOrigin(normalized, origin)) continue;
        pages.add(normalized);
        if (pages.size >= maxUrls) break;
      }
    } catch (err) {
      logger.debug({ sitemapUrl, err: (err as Error).message }, 'sitemap-read-failed');
    }
  }

  logger.info({ pages: pages.size, sitemaps: visitedSitemaps.size }, 'sitemap-discovery-complete');
  return Array.from(pages);
}

export function parseSitemap(xml: string): { kind: 'index' | 'urlset'; urls: string[] } {
  const $ = cheerio.load(xml, { xmlMode: true });
  const kind = $('sitemapindex').length > 0 ? 'index' : 'urlset';
  const selector = kind === 'index' ? 'sitemap > loc' : 'url > loc';
  const urls = $(selector).toArray().map((node) => $(node).text().trim()).filter(Boolean);
  return { kind, urls };
}

export function parseRobotsSitemaps(robots: string): string[] {
  return robots.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*sitemap\s*:\s*(\S+)\s*$/i);
    return match?.[1] ? [match[1]] : [];
  });
}
