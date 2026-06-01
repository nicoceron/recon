import { describe, expect, it } from 'vitest';
import { extensionFromContentType, isTextual } from './mimeUtils.js';

describe('extensionFromContentType', () => {
  it('maps common text types', () => {
    expect(extensionFromContentType('text/html')).toBe('html');
    expect(extensionFromContentType('text/css')).toBe('css');
  });
  it('handles charset suffix', () => {
    expect(extensionFromContentType('text/javascript; charset=utf-8')).toBe('js');
  });
  it('falls back to lookup table for less-common types', () => {
    expect(extensionFromContentType('font/woff2')).toBe('woff2');
    expect(extensionFromContentType('image/avif')).toBe('avif');
  });
  it('returns undefined for unknown types', () => {
    expect(extensionFromContentType('application/x-made-up')).toBeUndefined();
    expect(extensionFromContentType(undefined)).toBeUndefined();
  });
});

describe('isTextual', () => {
  it('true for text/* and javascript/json/svg/xml', () => {
    expect(isTextual('text/html')).toBe(true);
    expect(isTextual('text/css')).toBe(true);
    expect(isTextual('application/javascript')).toBe(true);
    expect(isTextual('application/json')).toBe(true);
    expect(isTextual('image/svg+xml')).toBe(true);
  });
  it('false for binary types', () => {
    expect(isTextual('image/png')).toBe(false);
    expect(isTextual('font/woff2')).toBe(false);
    expect(isTextual('application/octet-stream')).toBe(false);
  });
  it('false for missing input', () => {
    expect(isTextual(undefined)).toBe(false);
  });
});
