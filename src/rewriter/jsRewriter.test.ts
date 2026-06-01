import { describe, expect, it } from 'vitest';
import { buildJsReplacements, rewriteJs } from './jsRewriter.js';

describe('buildJsReplacements', () => {
  it('emits 3 entries per host plus the Framer editor bootstrap host', () => {
    const r = buildJsReplacements(new Set(['cdn.example.com']));
    expect(r).toHaveLength(6);
    expect(r.map((x) => x.from)).toEqual([
      'https://cdn.example.com',
      'http://cdn.example.com',
      '//cdn.example.com',
      'https://framer.com',
      'http://framer.com',
      '//framer.com',
    ]);
    expect(r.slice(0, 3).every((x) => x.to === '/assets/cdn.example.com')).toBe(true);
    expect(r.slice(3).every((x) => x.to === '/assets/framer.com')).toBe(true);
  });

  it('orders longer hostnames first to avoid premature substring matches', () => {
    const r = buildJsReplacements(new Set(['a.example.com', 'longer-cdn.example.com']));
    const first = r[0]!;
    const last = r[r.length - 1]!;
    expect(first.from.length).toBeGreaterThan(last.from.length);
  });

  it('always rewrites Framer editor bootstrap imports to the local stub', () => {
    const r = buildJsReplacements(new Set());
    const out = rewriteJs('import(`https://framer.com/edit/init.mjs`)', { replacements: r });

    expect(out).toBe('import(`/assets/framer.com/edit/init.mjs`)');
  });
});

describe('rewriteJs', () => {
  it('replaces every occurrence of known prefixes', () => {
    const replacements = buildJsReplacements(new Set(['cdn.example.com']));
    const input = `let x = "https://cdn.example.com/a.png"; let y = "https://cdn.example.com/b.png";`;
    const out = rewriteJs(input, { replacements });
    expect(out).not.toContain('https://cdn.example.com');
    expect(out).toContain('/assets/cdn.example.com/a.png');
    expect(out).toContain('/assets/cdn.example.com/b.png');
  });

  it('preserves byte content for unrelated text', () => {
    const replacements = buildJsReplacements(new Set(['cdn.example.com']));
    const input = `function noTouch() { return 42; }`;
    expect(rewriteJs(input, { replacements })).toBe(input);
  });

  it('returns input unchanged when replacements is empty', () => {
    const input = `https://cdn.example.com/a`;
    expect(rewriteJs(input, { replacements: [] })).toBe(input);
  });

  it('handles protocol-relative URLs', () => {
    const replacements = buildJsReplacements(new Set(['cdn.example.com']));
    const out = rewriteJs(`fetch("//cdn.example.com/x")`, { replacements });
    expect(out).toBe(`fetch("/assets/cdn.example.com/x")`);
  });

  it('keeps rewritten local paths valid when used as new URL bases', () => {
    const replacements = buildJsReplacements(new Set(['framerusercontent.com']));
    const input =
      'new URL(`./collection.framercms`,`https://framerusercontent.com/modules/site/id/Module.js`).href';
    const out = rewriteJs(input, { replacements });

    expect(out).toBe(
      'new URL(`./collection.framercms`,location.origin+`/assets/framerusercontent.com/modules/site/id/Module.js`).href',
    );
  });

  it('allows Framer CMS range helpers to consume full local files', () => {
    const input =
      'async function x(e,t){let n=We(t),r=[],i=0;for(let e of n)r.push(`${e.from}-${e.to-1}`),i+=e.to-e.from;let a=new URL(e),o=r.join(`,`);a.searchParams.set(`range`,o);let s=await U(a);if(s.status!==200)throw Error(`Request failed: ${s.status} ${s.statusText}`);let c=await s.arrayBuffer(),l=new Uint8Array(c);if(l.length!==i)throw Error(`Request failed: Unexpected response length`);let u=new $e,d=0;for(let e of n){let t=e.to-e.from,n=d+t,r=l.subarray(d,n);u.write(e.from,r),d=n}return t.map(e=>u.read(e.from,e.to-e.from))}';
    const out = rewriteJs(input, { replacements: buildJsReplacements(new Set(['cdn.example.com'])) });

    expect(out).not.toContain('Unexpected response length');
    expect(out).toContain('if(l.length===i)');
    expect(out).toContain('else{u.write(0,l)}');
  });
});
