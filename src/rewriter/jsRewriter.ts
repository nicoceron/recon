import { logger } from '../utils/logger.js';

export interface JsRewriteContext {
  /**
   * Map of CDN host or full URL prefix → root-relative replacement.
   * Order matters: longer prefixes should appear first.
   */
  replacements: Array<{ from: string; to: string }>;
}

/**
 * Rewrite a JS bundle (or any text body) by literal string replacement of known
 * CDN host prefixes. Never AST-parses minified bundles — the goal is byte-safe
 * substitution that maps CDN hosts to local `/assets/<host>` paths.
 *
 * After running, the JS will reference paths like `/assets/framerusercontent.com/...`
 * which `sirv` serves from the same `output/` root. URL fingerprints / query
 * params don't need rewriting because the captured filenames already include
 * a hash of the original query (see assetLocalPath in urlUtils).
 */
export function rewriteJs(body: string, ctx: JsRewriteContext): string {
  if (!ctx.replacements.length) return body;
  let out = body;
  let totalReplacements = 0;
  for (const { from, to } of ctx.replacements) {
    if (!out.includes(from)) continue;
    const before = out.length;
    out = out.split(from).join(to);
    const after = out.length;
    totalReplacements += Math.abs(before - after);
  }
  if (totalReplacements > 0) {
    logger.debug({ deltaBytes: totalReplacements, prefixes: ctx.replacements.length }, 'js-rewrite-applied');
  }
  return fixFramerCmsRangeHelpers(fixLocalNewUrlBases(out));
}

/**
 * Framer CMS modules often do:
 *
 *   new URL("./collection.framercms", "https://framerusercontent.com/modules/.../Module.js")
 *
 * After CDN host rewriting, that second argument becomes a root-relative
 * pathname. Browsers reject root-relative strings as the base argument to
 * `new URL()`, so make those bases absolute against the current origin while
 * keeping the path local.
 */
function fixLocalNewUrlBases(body: string): string {
  return body.replace(
    /new URL\(([^,]+),\s*(["'`])(\/assets\/[^"'`]+)\2\)/g,
    (_match, firstArg: string, quote: string, basePath: string) =>
      `new URL(${firstArg},location.origin+${quote}${basePath}${quote})`,
  );
}

/**
 * Framer's CMS CDN supports a custom `?range=0-10,20-30` query and returns the
 * concatenated byte ranges. Ordinary static hosts ignore that query and return
 * the full `.framercms` file. Accept either response shape: CDN-style ranged
 * bytes or local full-file bytes.
 */
function fixFramerCmsRangeHelpers(body: string): string {
  return body.replace(
    /let c=await ([A-Za-z_$][\w$]*)\.arrayBuffer\(\),l=new Uint8Array\(c\);if\(l\.length!==i\)throw Error\(`Request failed: Unexpected response length`\);let u=new ([A-Za-z_$][\w$]*),d=0;for\(let e of n\)\{let t=e\.to-e\.from,n=d\+t,r=l\.subarray\(d,n\);u\.write\(e\.from,r\),d=n\}return t\.map\(e=>u\.read\(e\.from,e\.to-e\.from\)\)/g,
    (_match, responseVar: string, chunkStoreClass: string) =>
      `let c=await ${responseVar}.arrayBuffer(),l=new Uint8Array(c),u=new ${chunkStoreClass},d=0;if(l.length===i){for(let e of n){let t=e.to-e.from,n=d+t,r=l.subarray(d,n);u.write(e.from,r),d=n}}else{u.write(0,l)}return t.map(e=>u.read(e.from,e.to-e.from))`,
  );
}

/**
 * Build the replacement table from the set of asset hosts we observed.
 * Each host gets two replacement entries: one for `https://host` → `/assets/host`,
 * and one for protocol-relative `//host` → `/assets/host`.
 */
export function buildJsReplacements(hosts: Set<string>): JsRewriteContext['replacements'] {
  const sorted = Array.from(new Set([...hosts, 'framer.com'])).sort((a, b) => b.length - a.length);
  const out: Array<{ from: string; to: string }> = [];
  for (const host of sorted) {
    out.push({ from: `https://${host}`, to: `/assets/${host}` });
    out.push({ from: `http://${host}`, to: `/assets/${host}` });
    out.push({ from: `//${host}`, to: `/assets/${host}` });
  }
  return out;
}
