import { describe, expect, it } from 'vitest';
import {
  assetKey,
  assetLocalPath,
  normalizePageUrl,
  pageLocalPath,
  rootRelativeAssetPath,
  sameOrigin,
  tryParse,
} from './urlUtils.js';

describe('tryParse', () => {
  it('parses absolute URL', () => {
    expect(tryParse('https://example.com/path')?.toString()).toBe('https://example.com/path');
  });
  it('parses relative URL with base', () => {
    expect(tryParse('/foo', 'https://example.com')?.toString()).toBe('https://example.com/foo');
  });
  it('returns null on garbage', () => {
    expect(tryParse('not a url')).toBeNull();
  });
});

describe('normalizePageUrl', () => {
  it('strips fragment + lowercases host', () => {
    expect(normalizePageUrl('https://Example.COM/foo/#bar')).toBe('https://example.com/foo');
  });
  it('strips trailing slash on non-root paths', () => {
    expect(normalizePageUrl('https://example.com/about/')).toBe('https://example.com/about');
  });
  it('keeps root slash', () => {
    expect(normalizePageUrl('https://example.com/')).toBe('https://example.com/');
  });
  it('strips utm_* tracking params but keeps real query params', () => {
    expect(normalizePageUrl('https://example.com/p?utm_source=x&id=42')).toBe(
      'https://example.com/p?id=42',
    );
  });
  it('rejects non-http(s) schemes', () => {
    expect(normalizePageUrl('mailto:foo@bar')).toBeNull();
    expect(normalizePageUrl('javascript:void(0)')).toBeNull();
  });
});

describe('sameOrigin', () => {
  it('matches same scheme + host + port', () => {
    expect(sameOrigin('https://a.com/x', 'https://a.com/y')).toBe(true);
  });
  it('rejects different host', () => {
    expect(sameOrigin('https://a.com/', 'https://b.com/')).toBe(false);
  });
  it('rejects different scheme', () => {
    expect(sameOrigin('https://a.com/', 'http://a.com/')).toBe(false);
  });
});

describe('assetKey', () => {
  it('strips query and fragment', () => {
    expect(assetKey('https://cdn.example.com/img.png?w=512&h=300#anchor')).toBe(
      'https://cdn.example.com/img.png',
    );
  });
  it('returns input on parse failure', () => {
    expect(assetKey('not a url')).toBe('not a url');
  });
});

describe('assetLocalPath', () => {
  it('produces a host-prefixed POSIX path under assets/', () => {
    expect(assetLocalPath('https://cdn.example.com/foo/bar.png')).toBe(
      'assets/cdn.example.com/foo/bar.png',
    );
  });
  it('canonicalises away the query string (one file per URL path)', () => {
    expect(assetLocalPath('https://cdn.example.com/img.png?w=512')).toBe(
      assetLocalPath('https://cdn.example.com/img.png?w=1024'),
    );
  });
  it('appends extension from content-type when missing', () => {
    expect(assetLocalPath('https://cdn.example.com/img', 'image/webp')).toBe(
      'assets/cdn.example.com/img.webp',
    );
  });
  it('sanitises path-traversal segments', () => {
    expect(assetLocalPath('https://cdn.example.com/../etc/passwd')).not.toContain('..');
  });
});

describe('pageLocalPath', () => {
  it('maps root to index.html', () => {
    expect(pageLocalPath('https://example.com/')).toBe('index.html');
  });
  it('maps /about to about/index.html', () => {
    expect(pageLocalPath('https://example.com/about')).toBe('about/index.html');
  });
  it('handles nested paths', () => {
    expect(pageLocalPath('https://example.com/a/b/c')).toBe('a/b/c/index.html');
  });
});

describe('rootRelativeAssetPath', () => {
  it('prepends slash and normalises separators', () => {
    expect(rootRelativeAssetPath('assets/foo/bar.png')).toBe('/assets/foo/bar.png');
  });
});
