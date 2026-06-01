import { describe, expect, it } from 'vitest';
import { rewriteCss } from './cssRewriter.js';

describe('rewriteCss', () => {
  const lookup = (url: string): string | undefined => {
    if (url === 'https://cdn.example.com/font.woff2') return '/assets/cdn.example.com/font.woff2';
    if (url === 'https://cdn.example.com/bg.png') return '/assets/cdn.example.com/bg.png';
    return undefined;
  };

  it('rewrites url() in @font-face', async () => {
    const css = `@font-face { src: url("https://cdn.example.com/font.woff2") format("woff2"); }`;
    const out = await rewriteCss(css, { baseUrl: 'https://example.com/', lookup });
    expect(out).toContain('/assets/cdn.example.com/font.woff2');
    expect(out).not.toContain('https://cdn.example.com/font.woff2');
  });

  it('rewrites url() in background-image', async () => {
    const css = `.hero { background-image: url('https://cdn.example.com/bg.png'); }`;
    const out = await rewriteCss(css, { baseUrl: 'https://example.com/', lookup });
    expect(out).toContain('/assets/cdn.example.com/bg.png');
  });

  it('leaves data: URIs alone', async () => {
    const css = `.x { background: url(data:image/png;base64,AAAA); }`;
    const out = await rewriteCss(css, { baseUrl: 'https://example.com/', lookup });
    expect(out).toContain('data:image/png;base64,AAAA');
  });

  it('leaves URLs not in lookup map unchanged', async () => {
    const css = `.x { background: url('https://other.com/img.png'); }`;
    const out = await rewriteCss(css, { baseUrl: 'https://example.com/', lookup });
    expect(out).toContain('https://other.com/img.png');
  });

  it('returns input unchanged when no url() present (fast path)', async () => {
    const css = `body { color: red; }`;
    expect(await rewriteCss(css, { baseUrl: 'https://example.com/', lookup })).toBe(css);
  });
});
