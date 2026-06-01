import postcss from 'postcss';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import postcssUrl from 'postcss-url';
import { logger } from '../utils/logger.js';
import { tryParse } from '../utils/urlUtils.js';

export interface CssRewriteContext {
  /** The URL the CSS came from — used to resolve relative `url()` references */
  baseUrl: string;
  /** Lookup: original absolute URL → root-relative local path (e.g. "/assets/foo.png") */
  lookup: (originalUrl: string) => string | undefined;
  /** Optional fallback used when an asset is not in the local lookup. */
  fallback?: (absoluteUrl: string) => string | undefined;
}

/**
 * Rewrite all `url(...)` references inside a CSS string. Uses PostCSS so it
 * handles comments, data URIs, and quoted strings correctly (regex would not).
 */
export async function rewriteCss(css: string, ctx: CssRewriteContext): Promise<string> {
  if (!css.includes('url(') && !css.includes('@import')) return css;

  try {
    const result = await postcss([
      postcssUrl({
        url: (asset: { url: string }) => {
          const original = asset.url;
          if (!original || original.startsWith('data:') || original.startsWith('#')) {
            return original;
          }
          const absolute = tryParse(original, ctx.baseUrl)?.toString();
          if (!absolute) return original;
          const local = ctx.lookup(absolute);
          return local ?? ctx.fallback?.(absolute) ?? original;
        },
      }),
    ]).process(css, { from: undefined });
    return result.css;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'css-rewrite-error-returning-original');
    return css;
  }
}
