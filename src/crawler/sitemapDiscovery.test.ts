import { describe, expect, it } from 'vitest';
import { parseRobotsSitemaps, parseSitemap } from './sitemapDiscovery.js';

describe('sitemap discovery parsers', () => {
  it('extracts page URLs from a sitemap urlset', () => {
    expect(parseSitemap(`<?xml version="1.0"?><urlset>
      <url><loc>https://example.com/</loc></url>
      <url><loc>https://example.com/events?kind=a&amp;page=2</loc></url>
    </urlset>`)).toEqual({
      kind: 'urlset',
      urls: ['https://example.com/', 'https://example.com/events?kind=a&page=2'],
    });
  });

  it('extracts child files from a sitemap index', () => {
    expect(parseSitemap('<sitemapindex><sitemap><loc>https://example.com/posts.xml</loc></sitemap></sitemapindex>'))
      .toEqual({ kind: 'index', urls: ['https://example.com/posts.xml'] });
  });

  it('extracts case-insensitive Sitemap directives from robots.txt', () => {
    expect(parseRobotsSitemaps('User-agent: *\nSitemap: https://example.com/a.xml\nsitemap: https://example.com/b.xml'))
      .toEqual(['https://example.com/a.xml', 'https://example.com/b.xml']);
  });
});
