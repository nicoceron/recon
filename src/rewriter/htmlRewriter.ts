import * as cheerio from 'cheerio';
import parseSrcset from 'parse-srcset';
import { rewriteCss } from './cssRewriter.js';
import { normalizePageUrl, pageLocalPath, sameOrigin, tryParse } from '../utils/urlUtils.js';

export interface StaticEventPreview {
  title?: string;
  image?: string;
  calendar?: string;
  city?: string;
  venueSub?: string;
  startAt?: string;
  endAt?: string;
  registrationAvailability?: string;
  soldOut?: boolean;
  about?: string;
}

export interface StaticInteractionSnapshot {
  html: string;
  styles?: string;
  href?: string;
  title?: string;
  key?: string;
  kind?: 'event-panel' | 'overlay';
  backdrop?: boolean;
}

export interface HtmlRewriteContext {
  pageUrl: string;
  /** Origin of the crawl (so internal links rewrite to local HTML paths) */
  siteOrigin: string;
  /** Lookup for asset URLs → local root-relative paths */
  assetLookup: (originalUrl: string) => string | undefined;
  /** Lookup for page URLs → local root-relative HTML paths */
  pageLookup: (normalizedPageUrl: string) => string | undefined;
  /** Optional fallback for same-origin links that were not captured locally. */
  pageFallback?: (normalizedPageUrl: string) => string | undefined;
  /** Optional fallback for asset URLs that are not in the local asset map. */
  assetFallback?: (absoluteUrl: string) => string | undefined;
  /** Keep Framer-owned hydration targets mounted and hide them instead of deleting them. */
  preserveFramerHydrationTargets?: boolean;
  /**
   * Inject a tiny client-side recovery layer for non-Framer hotlinked captures.
   * It re-arms offscreen reveal targets and simple scrollspy navs that can get
   * frozen in whatever state the lazy-load scroll pass captured.
   */
  staticRuntimeFixes?: boolean;
  /** Captured same-origin page routes for client-rendered links that appear after SSR rewrite. */
  runtimePageMap?: Record<string, string>;
  /** Public event-detail fields extracted from captured event pages for local preview drawers. */
  runtimeEventPreviewMap?: Record<string, StaticEventPreview>;
  /** Captured opened UI states keyed by local href or slug. */
  runtimeInteractionSnapshotMap?: Record<string, StaticInteractionSnapshot>;
  /** Accessible page-level CSSOM captured from the browser after hydration. */
  capturedPageCss?: string;
  /** Force the static output to keep this theme instead of following local system preference. */
  forceTheme?: 'light' | 'dark';
  /** Keep uncaptured same-origin app links local instead of linking back to the live source. */
  stayLocal?: boolean;
  /**
   * If set, rewrites <link rel="canonical"> and <meta property="og:url"> to
   * point at this URL. Without this, the captured HTML keeps the Framer
   * preview / framer.app URL it was published with, which leaks the original
   * hosting location to search engines and social embeds.
   */
  canonicalUrl?: string;
  /**
   * Extra CSS selectors to .remove() from each page. Useful for hiding form
   * widgets that aren't wired up (e.g. unconfigured FormSpark/Loops integrations
   * that POST to dead endpoints), or any content the deployer wants stripped.
   * Cheerio supports jQuery-style :has() and :contains() pseudo-classes.
   */
  stripSelectors?: string[];
  /**
   * If set, the subscribe form (form:has(input[value="Subscribe"])) is kept
   * visible but transformed: the button label changes to `text` and clicking
   * opens `url` in a new tab instead of submitting the form.
   */
  subscribeRedirect?: { url: string; text?: string };
}

const URL_ATTRS: Array<{ selector: string; attr: string }> = [
  { selector: 'img[src]', attr: 'src' },
  { selector: 'img[data-src]', attr: 'data-src' },
  { selector: 'img[data-lazy-src]', attr: 'data-lazy-src' },
  { selector: 'source[src]', attr: 'src' },
  { selector: 'video[src]', attr: 'src' },
  { selector: 'video[poster]', attr: 'poster' },
  { selector: 'audio[src]', attr: 'src' },
  { selector: 'iframe[src]', attr: 'src' },
  { selector: 'script[src]', attr: 'src' },
  { selector: 'link[href]', attr: 'href' },
  { selector: 'use[href]', attr: 'href' },
  { selector: 'use[xlink\\:href]', attr: 'xlink:href' },
  { selector: 'object[data]', attr: 'data' },
  { selector: 'embed[src]', attr: 'src' },
  { selector: 'meta[property="og:image"]', attr: 'content' },
  { selector: 'meta[name="twitter:image"]', attr: 'content' },
];

const SRCSET_ATTRS: Array<{ selector: string; attr: string }> = [
  { selector: 'img[srcset]', attr: 'srcset' },
  { selector: 'source[srcset]', attr: 'srcset' },
  { selector: 'link[imagesrcset]', attr: 'imagesrcset' },
];

export async function rewriteHtml(html: string, ctx: HtmlRewriteContext): Promise<string> {
  const $ = cheerio.load(html);

  // Strip every Framer owner-only UI element that gets serialized into the
  // captured HTML when the crawler is logged in to Framer. These render
  // floating overlays (a "Made in Framer" badge bottom-right, an edit-pencil
  // button mid-right) that are NOT part of the published site's intended UX.
  //
  // Coverage:
  //   1. Editor-bar bootstrap: <script src="framer.com/edit/...">
  //      and the inline loader script that sets `__framer_force_showing_editorbar`.
  //   2. Editor-bar UI shell: container <div>, button, label, and the iframe
  //      itself (iframe was stripped earlier; the shell still rendered the
  //      circular pencil icon thanks to its CSS).
  //   3. "Made in Framer" badge: container + the <a class="__framer-badge"> link.
  //   4. Telemetry endpoints: events.framer.com is already 204-stubbed at the
  //      interceptor; remove the dangling <script> tags too.
  $('script[src*="framer.com/edit"]').remove();
  $('script').each((_i, el) => {
    const txt = $(el).html();
    if (!txt) return;
    if (txt.includes('framer.com/edit') || txt.includes('__framer_force_showing_editorbar')) {
      $(el).remove();
    }
  });
  $('script[src*="events.framer.com"]').remove();

  // Editor-bar (entire shell)
  $('#__framer-editorbar-container').remove();
  $('#__framer-editorbar-button').remove();
  $('#__framer-editorbar-label').remove();
  $('iframe[id="__framer-editorbar"]').remove();
  $('iframe[src*="framer.com/edit"]').remove();

  // "Made in Framer" badge (the floating bottom-right link). Framer's main
  // runtime still hydrates this container, so hotlink-preserved pages must keep
  // the target node mounted and hide it instead of removing it.
  if (ctx.preserveFramerHydrationTargets) {
    $('head').append('<style>#__framer-badge-container{display:none!important}</style>');
  } else {
    $('#__framer-badge-container').remove();
    $('a.__framer-badge').remove();
    $('a[href="https://www.framer.com"]').remove();
    $('a[href="https://framer.com"]').remove();
  }

  // Override SEO canonical / og:url so the export doesn't keep advertising the
  // original Framer preview URL.
  if (ctx.canonicalUrl) {
    $('link[rel="canonical"]').attr('href', ctx.canonicalUrl);
    $('meta[property="og:url"]').attr('content', ctx.canonicalUrl);
    $('meta[name="twitter:url"]').attr('content', ctx.canonicalUrl);
  }

  // Apply caller-supplied strip selectors (e.g. to hide a Subscribe form whose
  // backend integration was never configured upstream).
  //
  // For SSR HTML we use cheerio's $().remove(). That alone is NOT enough on
  // a Framer site: after the page loads, Framer's React runtime hydrates and
  // re-injects components from the bundled JS, putting the elements back. So
  // we ALSO inject a small MutationObserver-based "runtime stripper" that
  // re-removes anything matching the selectors after every DOM mutation.
  // Together they cover both the pre-hydration paint and the post-hydration tree.
  if (ctx.stripSelectors?.length) {
    for (const sel of ctx.stripSelectors) {
      try {
        $(sel).remove();
      } catch {
        // bad selector — skip silently rather than abort the whole rewrite
      }
    }
    const runtimeStripper = buildRuntimeStripper(ctx.stripSelectors);
    // Anonymous <script> — no identifying attribute / comment so the export
    // doesn't reveal a dependency on this tool to anyone viewing source.
    $('body').append(`<script>${runtimeStripper}</script>`);
  }

  if (ctx.subscribeRedirect) {
    const { url, text } = ctx.subscribeRedirect;
    // Bake the hide rule into the static HTML so it is present from first paint
    // and never removed by Framer's init code (which clears JS-injected head styles).
    $('head').append('<style>form:has(input[value="Subscribe"]){display:none!important}</style>');
    $('body').append(`<script>${buildSubscribeRedirector(url, text ?? 'Subscribe')}</script>`);
  }

  for (const { selector, attr } of URL_ATTRS) {
    $(selector).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      const newValue = mapUrl(value, ctx);
      if (newValue !== undefined && newValue !== value) {
        $(el).attr(attr, newValue);
      }
    });
  }

  for (const { selector, attr } of SRCSET_ATTRS) {
    $(selector).each((_i, el) => {
      const value = $(el).attr(attr);
      if (!value) return;
      const newValue = mapSrcset(value, ctx);
      if (newValue !== value) $(el).attr(attr, newValue);
    });
  }

  // <a href> — keep external untouched, rewrite same-origin to local HTML paths
  $('a[href]').each((_i, el) => {
    const value = $(el).attr('href');
    if (!value) return;
    if (
      value.startsWith('mailto:') ||
      value.startsWith('tel:') ||
      value.startsWith('javascript:') ||
      value.startsWith('#')
    ) {
      return;
    }
    if (ctx.stayLocal && isRootRelativeLocalPagePath(value)) return;
    const absolute = tryParse(value, ctx.pageUrl)?.toString();
    if (!absolute) return;
    if (!sameOrigin(absolute, ctx.siteOrigin)) return;
    const normalized = normalizePageUrl(absolute);
    if (!normalized) return;
    const localPage = ctx.pageLookup(normalized);
    const fallbackPage = localPage ? undefined : ctx.stayLocal ? rootRelativePagePath(normalized) : ctx.pageFallback?.(normalized);
    if (localPage || fallbackPage) $(el).attr('href', localPage ?? fallbackPage);
  });

  // <form action> — typically external; rewrite if it points to a captured asset, otherwise leave
  $('form[action]').each((_i, el) => {
    const value = $(el).attr('action');
    if (!value) return;
    const newValue = mapUrl(value, ctx);
    if (newValue && newValue !== value) $(el).attr('action', newValue);
  });

  // Inline <style> blocks — pipe through CSS rewriter
  const styleNodes = $('style').toArray();
  for (const node of styleNodes) {
    const css = $(node).html();
    if (!css) continue;
    const rewritten = await rewriteCss(css, {
      baseUrl: ctx.pageUrl,
      lookup: ctx.assetLookup,
      fallback: ctx.assetFallback,
    });
    if (rewritten !== css) $(node).html(rewritten);
  }

  // Inline style="..." attributes containing url(...)
  $('[style]').each((_i, el) => {
    const value = $(el).attr('style');
    if (!value || !value.includes('url(')) return;
    const newValue = rewriteInlineStyle(value, ctx);
    if (newValue !== value) $(el).attr('style', newValue);
  });

  if (ctx.capturedPageCss?.trim()) {
    const capturedCss = await rewriteCss(ctx.capturedPageCss, {
      baseUrl: ctx.pageUrl,
      lookup: ctx.assetLookup,
      fallback: ctx.assetFallback,
    });
    $('head').append(`<style data-static-captured-cssom="1">${styleSafeCss(capturedCss)}</style>`);
  }

  if (ctx.staticRuntimeFixes) {
    sanitizeEmbeddedNextData($);
    sanitizePrivateDom($, ctx.pageUrl);
    const theme = ctx.forceTheme ?? detectDocumentTheme($);
    if (theme) lockDocumentTheme($, theme);
    $('head').prepend(`<script>${buildStaticHotlinkPreflight()}</script>`);
    $('body').append(
      `<script>${buildRuntimePageLinkRewriter(ctx.runtimePageMap ?? {}, ctx.siteOrigin, Boolean(ctx.stayLocal), ctx.runtimeEventPreviewMap ?? {}, ctx.runtimeInteractionSnapshotMap ?? {})}</script>`,
    );
    $('body').append(`<script>${buildStaticRuntimeFixes(Boolean(ctx.stayLocal))}</script>`);
  }

  return $.html();
}

function styleSafeCss(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function detectDocumentTheme($: cheerio.CheerioAPI): 'light' | 'dark' | undefined {
  const className = $('html').attr('class') ?? '';
  if (/(^|\s)dark(\s|$)/.test(className)) return 'dark';
  if (/(^|\s)light(\s|$)/.test(className)) return 'light';
  return undefined;
}

function lockDocumentTheme($: cheerio.CheerioAPI, theme: 'light' | 'dark'): void {
  const html = $('html');
  const classes = new Set((html.attr('class') ?? '').split(/\s+/).filter(Boolean));
  classes.delete('light');
  classes.delete('dark');
  classes.add('theme-root');
  classes.add(theme);
  html.attr('class', [...classes].join(' '));

  const lockScript = `(function(){var t=${JSON.stringify(theme)};var r=document.documentElement;r.classList.remove("light","dark");r.classList.add("theme-root",t);window.__theme=t;try{localStorage.setItem("theme",t)}catch(_){}})();`;
  let patchedExistingThemeScript = false;

  $('script').each((_i, el) => {
    const script = $(el).html();
    if (!script || !script.includes('window.__theme = newTheme')) return;
    const patched = script.replace(
      /((?:var|let|const)\s+preferredTheme\s*=\s*)["'][^"']*["'](\s*;)/,
      `$1"${theme}"$2`,
    );
    if (patched !== script) {
      $(el).html(patched);
      patchedExistingThemeScript = true;
    }
  });

  $('head').prepend(`<script data-static-theme-lock="1">${lockScript}</script>`);
  if (!patchedExistingThemeScript) {
    $('body').append(`<script data-static-theme-lock="1">${lockScript}</script>`);
  }
}

function mapUrl(rawUrl: string, ctx: HtmlRewriteContext): string | undefined {
  if (!rawUrl) return undefined;
  if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:')) return undefined;
  const absolute = tryParse(rawUrl, ctx.pageUrl)?.toString();
  if (!absolute) return undefined;
  return ctx.assetLookup(absolute) ?? ctx.assetFallback?.(absolute);
}

/**
 * Build a self-contained MutationObserver script that re-applies the same
 * strip selectors after every DOM mutation. Handles two selector shapes:
 *   1. Standard CSS selectors (incl. native `:has()`) → querySelectorAll
 *   2. jQuery-style `:contains("text")` → custom text-match (browsers don't
 *      implement `:contains` in CSS)
 */
function buildRuntimeStripper(selectors: readonly string[]): string {
  // Inline the selector list as a JSON-encoded string array (safe escape).
  const json = JSON.stringify(selectors);
  return `(function(){
var sels=${json};
var containsRe=/^(.+?):contains\\((["'])([^"']+)\\2\\)\\s*$/;
function strip(){
  for(var i=0;i<sels.length;i++){
    var s=sels[i];
    var m=s.match(containsRe);
    if(m){
      var base=m[1],txt=m[3];
      try{document.querySelectorAll(base).forEach(function(el){if((el.textContent||'').indexOf(txt)>=0)el.remove();});}catch(_){}
    }else{
      try{document.querySelectorAll(s).forEach(function(el){el.remove();});}catch(_){}
    }
  }
}
strip();
new MutationObserver(strip).observe(document.documentElement,{childList:true,subtree:true});
})();`;
}

const SENSITIVE_JSON_KEY_RE =
  /(?:token|secret|session|cookie|password|email|phone|stripe|google|apple|github|linkedin|telegram|twitter|instagram|zoom|eth_|solana|centrifugo|customer_id|user_id|api_id|geo_|address|first_name|last_name|avatar|bio|company|job_title|website|timezone)/i;

function sanitizeEmbeddedNextData($: cheerio.CheerioAPI): void {
  const script = $('script#__NEXT_DATA__');
  if (script.length === 0) return;
  const raw = script.html();
  if (!raw) return;

  try {
    const data = JSON.parse(raw);
    if (data?.props && typeof data.props === 'object') {
      delete data.props.initialUserData;
      delete data.props.user;
      delete data.props.viewer;
      if (data.props.pageProps && typeof data.props.pageProps === 'object') {
        delete data.props.pageProps.initialUserData;
        delete data.props.pageProps.user;
        delete data.props.pageProps.viewer;
      }
    }
    redactSensitiveJson(data);
    script.text(JSON.stringify(data).replace(/</g, '\\u003c'));
  } catch {
    // If the payload is not valid JSON, leave it untouched rather than risk
    // corrupting the rendered document.
  }
}

const PRIVATE_EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PRIVATE_PHONE_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;

function sanitizePrivateDom($: cheerio.CheerioAPI, pageUrl: string): void {
  const isSettingsPage = (() => {
    try {
      return new URL(pageUrl).pathname.replace(/\/+$/, '').startsWith('/settings');
    } catch {
      return false;
    }
  })();

  $('input[value],textarea').each((_i, el) => {
    const value = $(el).attr('value') ?? '';
    if (isSettingsPage || PRIVATE_EMAIL_RE.test(value) || PRIVATE_PHONE_RE.test(value)) {
      $(el).removeAttr('value');
      if ($(el).is('textarea')) $(el).text('');
    }
  });

  if (isSettingsPage) {
    $('[class*="full-name-note"], [inert]').each((_i, el) => {
      const text = $(el).text();
      if (/full name is set|Update Profile|View Profile|Sign Out/i.test(text)) $(el).remove();
    });
    $('[style*="background-image"]').removeAttr('style');
    $('img[src],img[srcset]').each((_i, el) => {
      const $el = $(el);
      const context = [
        $el.attr('alt') ?? '',
        $el.attr('class') ?? '',
        $el.parent().attr('class') ?? '',
        $el.parents('[class*="avatar"],[class*="profile"],[class*="picture"]').first().attr('class') ?? '',
      ].join(' ');
      if (/avatar|profile|picture|user/i.test(context)) {
        $el.removeAttr('src').removeAttr('srcset').attr('alt', 'Account');
      }
    });
  }

  $('body *')
    .toArray()
    .reverse()
    .forEach((el) => {
      const $el = $(el);
      const text = $el.text();
      if (!PRIVATE_EMAIL_RE.test(text)) return;

      let $target = $el;
      for (let i = 0; i < 3; i += 1) {
        const $parent = $target.parent();
        if ($parent.length === 0 || $parent.is('body')) break;
        const siblingText = $target
          .siblings()
          .toArray()
          .map((sibling) => $(sibling).text())
          .join(' ')
          .trim();
        if (i > 0 && siblingText && !PRIVATE_EMAIL_RE.test(siblingText)) break;
        const targetText = $target.text();
        const parentText = $parent.text();
        if (parentText.length > targetText.length + 260) break;
        $target = $parent;
      }
      $target.remove();
    });

  if (isSettingsPage) {
    $('body *').each((_i, el) => {
      const $el = $(el);
      if ($el.children().length > 0) return;
      const text = $el.text();
      if (!text || (!PRIVATE_PHONE_RE.test(text) && !PRIVATE_EMAIL_RE.test(text))) return;
      $el.text(PRIVATE_PHONE_RE.test(text) ? 'Phone configured' : 'Email configured');
    });
  }
}

function redactSensitiveJson(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) redactSensitiveJson(item);
    return;
  }

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_JSON_KEY_RE.test(key)) {
      delete obj[key];
      continue;
    }
    redactSensitiveJson(obj[key]);
  }
}

/**
 * Build a self-contained script that transforms the Framer subscribe form into
 * a redirect button. Uses MutationObserver so it survives React hydration.
 * A data attribute guards against duplicate event listeners on re-runs.
 */
function buildSubscribeRedirector(url: string, text: string): string {
  const jsonUrl = JSON.stringify(url);
  const jsonText = JSON.stringify(text);
  // The form is hidden by a <style> baked into the static HTML by rewriteHtml().
  // This script only handles inserting the <a> redirect link after React hydration.
  return `(function(){
var url=${jsonUrl},text=${jsonText};
function transform(){
  document.querySelectorAll('form').forEach(function(form){
    var btn=form.querySelector('input[value="Subscribe"],input[type="submit"],button[type="submit"]');
    if(!btn)return;
    var p=form.parentNode;
    if(!p||p.querySelector('[data-sub-link]'))return;
    var cs=window.getComputedStyle(btn);
    var a=document.createElement('a');
    a.setAttribute('data-sub-link','1');
    a.textContent=text;
    a.href=url;
    a.target='_blank';
    a.rel='noopener noreferrer';
    a.style.display='inline-flex';
    a.style.alignItems='center';
    a.style.justifyContent='center';
    a.style.textDecoration='none';
    a.style.cursor='pointer';
    a.style.boxSizing='border-box';
    a.style.whiteSpace='nowrap';
    a.style.padding=cs.padding||'12px';
    a.style.background=cs.background;
    a.style.backgroundColor=cs.backgroundColor;
    a.style.color=cs.color;
    a.style.borderRadius=cs.borderRadius;
    a.style.fontSize=cs.fontSize;
    a.style.fontWeight=cs.fontWeight;
    a.style.minWidth=cs.minWidth;
    a.style.height=cs.height;
    a.style.border=cs.border;
    p.insertBefore(a,form);
  });
}
transform();
// Run after React hydration/client-render settles (error #418 can delay to ~2s).
[200,500,1000,2000,3000,5000].forEach(function(ms){setTimeout(transform,ms);});
window.addEventListener('load',function(){setTimeout(transform,500);setTimeout(transform,1500);});
new MutationObserver(transform).observe(document.documentElement,{childList:true,subtree:true});
})();`;
}

function buildStaticHotlinkPreflight(): string {
  return `(function(){
if(typeof window==='undefined')return;
if(typeof window.__turbopack_load_page_chunks__!=='function'){
  window.__turbopack_load_page_chunks__=function(){return Promise.resolve();};
}
window.google=window.google||{};
window.google.maps=window.google.maps||{};
if(typeof window.google.maps.__ib__!=='function'){
  window.google.maps.__ib__=function(){};
}
})();`;
}

function rootRelativePagePath(pageUrl: string): string {
  return '/' + pageLocalPath(pageUrl).replace(/\\/g, '/');
}

function isRootRelativeLocalPagePath(value: string): boolean {
  return value === '/index.html' || /^\/.+\/index\.html(?:[?#].*)?$/.test(value);
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (char) => {
    switch (char) {
      case '<':
        return '\\u003c';
      case '>':
        return '\\u003e';
      case '&':
        return '\\u0026';
      case '\u2028':
        return '\\u2028';
      case '\u2029':
        return '\\u2029';
      default:
        return char;
    }
  });
}

function buildRuntimePageLinkRewriter(
  pageMap: Record<string, string>,
  origin: string,
  stayLocal: boolean,
  eventPreviewMap: Record<string, StaticEventPreview>,
  interactionSnapshotMap: Record<string, StaticInteractionSnapshot>,
): string {
  const mapJson = scriptSafeJson(pageMap);
  const originJson = scriptSafeJson(origin);
  const stayLocalJson = scriptSafeJson(stayLocal);
  const eventPreviewMapJson = scriptSafeJson(eventPreviewMap);
  const interactionSnapshotMapJson = scriptSafeJson(interactionSnapshotMap);
  return `(function(){
var pageMap=${mapJson};
var siteOrigin=${originJson};
var stayLocal=${stayLocalJson};
var eventPreviewMap=${eventPreviewMapJson};
var interactionSnapshotMap=${interactionSnapshotMapJson};
window.__STATIC_EXPORT_PAGE_MAP=pageMap;
window.__STATIC_EXPORT_SITE_ORIGIN=siteOrigin;
window.__STATIC_EXPORT_STAY_LOCAL=stayLocal;
window.__STATIC_EXPORT_EVENT_PREVIEWS=eventPreviewMap;
window.__STATIC_EXPORT_INTERACTION_SNAPSHOTS=interactionSnapshotMap;
function ready(fn){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn,{once:true});
  else fn();
}
function normPath(path){
  path=path||'/';
  if(path.length>1)path=path.replace(/\\/+$/,'');
  return path||'/';
}
function isLocalExportPath(raw){
  return stayLocal&&(raw==='/index.html'||/\\/index\\.html(?:[?#].*)?$/.test(raw));
}
function localTarget(raw){
  if(!raw||raw[0]==='#'||raw.indexOf('mailto:')===0||raw.indexOf('tel:')===0||raw.indexOf('javascript:')===0)return null;
  if(isLocalExportPath(raw))return raw;
  var u;
  try{
    if(raw[0]==='/')u=new URL(raw,siteOrigin);
    else u=new URL(raw,location.href);
  }catch(_){return null;}
  if(u.origin!==siteOrigin)return null;
  var p=normPath(u.pathname);
  return pageMap[p+u.search]||pageMap[p]||null;
}
function liveTarget(raw){
  if(!raw)return null;
  if(isLocalExportPath(raw))return raw;
  var u;
  try{
    if(raw[0]==='/')u=new URL(raw,siteOrigin);
    else u=new URL(raw,location.href);
  }catch(_){return null;}
  if(u.origin!==siteOrigin)return null;
  return stayLocal?localPathForUrl(u):u.href;
}
function localPathForUrl(u){
  var p=normPath(u.pathname);
  if(p==='/')return '/index.html';
  return '/' + p.split('/').filter(Boolean).map(function(part){return encodeURIComponent(decodeURIComponent(part));}).join('/') + '/index.html';
}
window.__STATIC_EXPORT_LOCAL_TARGET=localTarget;
window.__STATIC_EXPORT_LIVE_TARGET=liveTarget;
function rewrite(a){
  var raw=a.getAttribute('href');
  var target=localTarget(raw)||liveTarget(raw);
  if(target&&raw!==target)a.setAttribute('href',target);
}
function forceLiveNavigation(ev){
  var a=ev.target&&ev.target.closest?ev.target.closest('a[href]'):null;
  if(!a||a.target==='_blank'||ev.defaultPrevented)return;
  var raw=a.getAttribute('href');
  if(!raw||raw[0]==='#'||raw.indexOf('mailto:')===0||raw.indexOf('tel:')===0||raw.indexOf('javascript:')===0)return;
  if(isLocalExportPath(raw))return;
  var u;
  try{
    if(raw[0]==='/')u=new URL(raw,siteOrigin);
    else u=new URL(raw,location.href);
  }catch(_){return;}
  if(u.origin!==siteOrigin)return;
  if(localTarget(raw))return;
  ev.preventDefault();
  ev.stopImmediatePropagation();
  location.href=stayLocal?localPathForUrl(u):u.href;
}
function rewriteAll(){
  document.querySelectorAll('a[href]').forEach(rewrite);
}
document.addEventListener('click',forceLiveNavigation,true);
document.addEventListener('pointerdown',function(ev){
  var a=ev.target&&ev.target.closest?ev.target.closest('a[href]'):null;
  if(a)rewrite(a);
},true);
ready(rewriteAll);
setTimeout(rewriteAll,250);
setTimeout(rewriteAll,1000);
setTimeout(rewriteAll,2500);
new MutationObserver(rewriteAll).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['href']});
})();`;
}

function buildStaticRuntimeFixes(stayLocal: boolean): string {
  const stayLocalJson = JSON.stringify(stayLocal);
  return `(function(){
var stayLocal=${stayLocalJson};
function ready(fn){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn,{once:true});
  else fn();
}
function textOf(el){return (el&&el.textContent||'').replace(/\\s+/g,' ').trim();}
function norm(s){return String(s||'').replace(/\\s+/g,' ').trim().toUpperCase();}
function isUsefulLabel(s){return s.length>=3&&s.length<=48&&/[A-Z]/.test(s);}
function displayLabel(el){return (el&&(el.getAttribute('aria-label')||el.getAttribute('title')||textOf(el))||'').replace(/\\s+/g,' ').trim();}
function isVisibleBox(el){
  var r=el.getBoundingClientRect();
  var cs=getComputedStyle(el);
  return r.width>1&&r.height>1&&cs.display!=='none'&&cs.visibility!=='hidden';
}
function pageMap(){return window.__STATIC_EXPORT_PAGE_MAP||{};}
function eventPreviewMap(){return window.__STATIC_EXPORT_EVENT_PREVIEWS||{};}
function interactionSnapshotMap(){return window.__STATIC_EXPORT_INTERACTION_SNAPSHOTS||{};}
function siteOrigin(){return window.__STATIC_EXPORT_SITE_ORIGIN||location.origin;}
function normalizedPath(path){
  path=String(path||'/');
  if(path.charAt(0)!=='/')path='/'+path;
  if(path.length>1)path=path.replace(/\\/+$/,'');
  return path||'/';
}
function localPathForRoute(path){
  var p=normalizedPath(path);
  if(p==='/')return '/index.html';
  return '/' + p.split('/').filter(Boolean).map(function(part){return encodeURIComponent(decodeURIComponent(part));}).join('/') + '/index.html';
}
function localRoute(path){
  var map=pageMap();
  var p=normalizedPath(path);
  return map[p]||map[p+'/']||null;
}
function liveRoute(path){
  if(stayLocal)return localPathForRoute(path);
  try{return new URL(path,siteOrigin()).href;}catch(_){return null;}
}
function goRoute(path){
  var target=localRoute(path)||liveRoute(path);
  if(target)location.href=target;
}
function currentLiveUrl(){
  var canonical=document.querySelector('link[rel="canonical"]');
  if(canonical&&canonical.href)return canonical.href;
  var og=document.querySelector('meta[property="og:url"]');
  if(og&&og.content)return og.content;
  var origin=siteOrigin();
  var map=pageMap();
  var here=location.pathname.replace(/\\/index\\.html$/,'').replace(/\\/+$/,'')||'/';
  for(var key in map){
    try{
      var u=new URL(map[key],location.href);
      var p=u.pathname.replace(/\\/index\\.html$/,'').replace(/\\/+$/,'')||'/';
      if(p===here)return new URL(key,origin).href;
    }catch(_){}
  }
  return origin;
}
function humanRoute(path){
  if(path==='/')return 'Home';
  return path.replace(/^\\//,'').split('/').filter(Boolean).map(function(part){
    return part.replace(/[-_]+/g,' ').replace(/\\b\\w/g,function(c){return c.toUpperCase();});
  }).join(' / ');
}
function capturedRoutes(){
  var map=pageMap();
  return Object.keys(map).filter(function(path){
    return path.charAt(0)==='/'&&path.indexOf('/_next/')!==0&&path.indexOf('/api/')!==0;
  }).map(function(path){
    return {path:path,href:map[path],label:humanRoute(path)};
  }).sort(function(a,b){return a.label.localeCompare(b.label);});
}
function installActionStyles(){
  if(document.getElementById('__static-action-style'))return;
  var style=document.createElement('style');
  style.id='__static-action-style';
  style.textContent=[
    '[data-static-control]{cursor:pointer}',
    '[data-static-hover]{transition:transform 160ms cubic-bezier(.2,.8,.2,1),box-shadow 160ms ease,filter 160ms ease,background-color 160ms ease}',
    '[data-static-hover]:hover{filter:brightness(.985)}',
    '.content-card[data-static-hover]:hover{transform:translate3d(0,-1px,0)}',
    '[data-static-pressed]{transform:scale(.985)!important}',
    '[data-static-snapshot-modal]{position:fixed!important;top:.5rem!important;right:.5rem!important;bottom:.5rem!important;left:auto!important;z-index:9998!important;display:flex!important;flex-direction:column!important;width:min(34.375rem,calc(100vw - 1rem))!important;height:calc(100vh - 1rem)!important;max-height:calc(100vh - 1rem)!important;overflow:hidden!important;box-sizing:border-box!important;margin:0!important;opacity:0!important;visibility:visible!important;pointer-events:auto!important;background:var(--modal-bg-color,#222)!important;color:var(--primary-color,#fff)!important;box-shadow:-24px 0 70px rgba(0,0,0,.45)!important;transform:translateX(18px)!important;transition:opacity 220ms ease,transform 260ms cubic-bezier(.2,.8,.2,1)!important}',
    '[data-static-snapshot-modal][data-static-open]{opacity:1!important;transform:none!important}',
    '[data-static-export-panel]{position:fixed;top:3.75rem;right:1rem;z-index:9998;width:min(24rem,calc(100vw - 2rem));max-height:calc(100vh - 5rem);overflow:auto;background:var(--modal-bg-color,var(--page-bg-color,#fff));color:var(--primary-color,#111);border:1px solid var(--divider-color,rgba(0,0,0,.12));border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.18);padding:.75rem;opacity:0;transform:translateY(-6px) scale(.985);transform-origin:top right;transition:opacity 160ms ease,transform 180ms cubic-bezier(.2,.8,.2,1)}',
    '[data-static-export-panel][data-static-open]{opacity:1;transform:none}',
    '[data-static-export-panel] .static-panel-title{font-weight:700;font-size:1rem;margin:.125rem .25rem .625rem}',
    '[data-static-export-panel] .static-panel-note{color:var(--secondary-color-alpha,#666);font-size:.875rem;line-height:1.35;margin:.25rem .25rem .75rem}',
    '[data-static-export-panel] a,[data-static-export-panel] button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:.75rem;box-sizing:border-box;border:0;border-radius:10px;background:transparent;color:inherit;text-align:left;text-decoration:none;padding:.6875rem .75rem;font:inherit;cursor:pointer}',
    '[data-static-export-panel] a:hover,[data-static-export-panel] button:hover{background:var(--hover-bg-color,rgba(0,0,0,.055))}',
    '[data-static-export-panel] input{width:100%;box-sizing:border-box;border:1px solid var(--divider-color,rgba(0,0,0,.14));border-radius:10px;background:var(--input-bg-color,#fff);color:inherit;padding:.75rem .875rem;font:inherit;margin:.25rem 0 .625rem}',
    '[data-static-export-panel] .static-muted{color:var(--tertiary-color-alpha,#777);font-size:.8125rem}',
    '[data-static-modal-backdrop]{position:fixed;inset:0;z-index:9997;background:rgba(0,0,0,.68);backdrop-filter:blur(1.5px);opacity:0;transition:opacity 180ms ease}',
    '[data-static-modal-backdrop][data-static-open]{opacity:1}',
    '[data-static-generic-snapshot]{z-index:9998!important;opacity:0!important;transition:opacity 160ms ease,transform 180ms cubic-bezier(.2,.8,.2,1)!important;will-change:opacity,transform}',
    '[data-static-generic-snapshot]:not([data-static-fullscreen]){transform:translateY(-6px) scale(.985)!important;transform-origin:top right!important}',
    '[data-static-generic-snapshot][data-static-open]{opacity:1!important;transform:none!important}',
    '[data-static-card-preview]{position:fixed;top:2.45rem;right:1.45rem;bottom:.85rem;z-index:9998;width:min(35rem,calc(100vw - 2.25rem));overflow:auto;background:#202020;color:#f5f5f5;border:1px solid rgba(255,255,255,.14);border-radius:12px;box-shadow:0 26px 80px rgba(0,0,0,.5);opacity:0;transform:translateX(18px);transition:opacity 220ms ease,transform 260ms cubic-bezier(.2,.8,.2,1)}',
    '[data-static-card-preview][data-static-open]{opacity:1;transform:none}',
    '[data-static-card-preview] .static-preview-topbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:.5rem;padding:.65rem .75rem;background:rgba(32,32,32,.94);backdrop-filter:blur(14px);border-bottom:1px solid rgba(255,255,255,.12)}',
    '[data-static-card-preview] .static-preview-spacer{flex:1}',
    '[data-static-card-preview] .static-preview-nav{border:0;background:transparent;color:#f1f1f1;border-radius:8px;min-width:2.25rem;height:2.25rem;padding:0 .5rem;font:inherit;font-weight:800;cursor:pointer}',
    '[data-static-card-preview] .static-preview-pill{border:0;background:rgba(255,255,255,.1);color:#f4f4f4;border-radius:9px;height:2.25rem;padding:0 .875rem;font:inherit;font-weight:750;cursor:pointer}',
    '[data-static-card-preview] .static-preview-close{border:0;background:rgba(255,255,255,.1);color:#f4f4f4;border-radius:9px;width:2.25rem;height:2.25rem;display:flex;align-items:center;justify-content:center;cursor:pointer;font:inherit;font-weight:800}',
    '[data-static-card-preview] .static-preview-content{padding:.85rem 1.25rem 2rem}',
    '[data-static-card-preview] .static-preview-hero{display:block;width:min(100%,19rem);aspect-ratio:1/1;object-fit:contain;background:rgba(0,0,0,.2);margin:.35rem auto 1rem;border-radius:10px;box-shadow:0 18px 48px rgba(0,0,0,.26)}',
    '[data-static-card-preview] .static-preview-chip{display:inline-flex;align-items:center;gap:.4rem;border-radius:9px;background:rgba(255,255,255,.11);padding:.45rem .65rem;font-weight:750;margin:.15rem 0 .9rem}',
    '[data-static-card-preview] .static-preview-title{font-size:1.9rem;line-height:1.13;font-weight:800;margin:.25rem 0 .85rem;letter-spacing:0}',
    '[data-static-card-preview] .static-preview-host{font-size:1.02rem;color:#d3d3d3;font-weight:700;margin-bottom:1.05rem}',
    '[data-static-card-preview] .static-preview-facts{display:grid;grid-template-columns:1fr 1fr;gap:.9rem;margin:.9rem 0 1.25rem}',
    '[data-static-card-preview] .static-preview-fact{display:grid;grid-template-columns:3rem 1fr;gap:.75rem;align-items:center;min-width:0}',
    '[data-static-card-preview] .static-preview-icon{width:3rem;height:3rem;border-radius:10px;background:rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-weight:800;line-height:1.05;white-space:pre-line;text-align:center}',
    '[data-static-card-preview] .static-preview-fact-title{font-weight:800;color:#f5f5f5}',
    '[data-static-card-preview] .static-preview-fact-sub{color:#c8c8c8;font-size:.95rem;margin-top:.125rem}',
    '[data-static-card-preview] .static-preview-section{border:1px solid rgba(255,255,255,.13);border-radius:12px;margin:1.25rem 0;overflow:hidden;background:#2a2a2a}',
    '[data-static-card-preview] .static-preview-section-title{font-weight:800;padding:.95rem 1rem;border-bottom:1px solid rgba(255,255,255,.11);background:#353535}',
    '[data-static-card-preview] .static-preview-section-body{padding:1.35rem 1.5rem;line-height:1.55;color:#f0f0f0;white-space:pre-line}',
    '[data-static-card-preview] .static-preview-registration-row{display:grid;grid-template-columns:3rem 1fr;gap:.85rem;align-items:start;margin-bottom:1.15rem}',
    '[data-static-card-preview] .static-preview-reg-icon{width:3rem;height:3rem;border-radius:12px;background:rgba(255,255,255,.12);display:flex;align-items:center;justify-content:center;font-size:1.25rem}',
    '[data-static-card-preview] .static-preview-action{width:100%;border:0;border-radius:12px;background:#fff;color:#111;padding:.875rem 1rem;font:inherit;font-weight:800;cursor:pointer;margin-top:1.1rem}',
    '[data-static-card-preview] .static-preview-muted{color:#e8e8e8}',
    '@media (max-width:820px){[data-static-card-preview]{left:.75rem;right:.75rem;width:auto}[data-static-card-preview] .static-preview-facts{grid-template-columns:1fr}[data-static-card-preview] .static-preview-title{font-size:1.65rem}}'
  ].join('');
  document.head.appendChild(style);
}
function findNavigable(control){
  if(!control||control.matches('a[href]'))return null;
  var a=control.closest&&control.closest('a[href]');
  if(a)return a;
  if(control.querySelector){
    a=control.querySelector('a[href]');
    if(a)return a;
  }
    var card=control.closest&&control.closest('[role="button"],.actionable,.content-card,.event-row');
  if(card&&card.querySelector)return card.querySelector('a[href]');
  return null;
}
function navigateAnchor(a){
  if(!a)return;
  var href=a.getAttribute('href');
  if(!href)return;
  if(a.target==='_blank')window.open(href,'_blank','noopener,noreferrer');
  else location.href=href;
}
function normalizedLocalHref(href){
  if(!href)return '';
  try{
    var u=new URL(href,location.href);
    if(u.origin!==location.origin)return '';
    var p=u.pathname;
    if(p==='/'||p==='')return '/index.html';
    if(!/\\/index\\.html$/.test(p))p=p.replace(/\\/+$/,'')+'/index.html';
    return p;
  }catch(_){return '';}
}
function capturedLocalHrefs(){
  var out={'/index.html':true};
  var map=pageMap();
  Object.keys(map).forEach(function(key){
    out[normalizedLocalHref(map[key])]=true;
  });
  return out;
}
function shouldPreviewAnchor(anchor,control){
  if(!stayLocal||!anchor)return false;
  var href=anchor.getAttribute('href')||'';
  var local=normalizedLocalHref(href);
  if(!local||!/\\/index\\.html$/.test(local))return false;
  var anchorCls=String(anchor.className||'');
  var cls=control?String(control.className||''):'';
  var isEvent=anchorCls.indexOf('event-link')>=0||cls.indexOf('event-row')>=0;
  if(isEvent)return true;
  if(!control)return false;
  if(capturedLocalHrefs()[local])return false;
  return false;
}
function extractPreviewTitle(control,anchor){
  return (anchor&&anchor.getAttribute('aria-label'))||
    (control.querySelector('h1,h2,h3,[class*="title"]')&&textOf(control.querySelector('h1,h2,h3,[class*="title"]')))||
    textOf(control).replace(/Subscribe/g,'').slice(0,80)||
    'Details';
}
function clickedSlug(anchor){
  if(!anchor)return '';
  try{
    var u=new URL(anchor.getAttribute('href')||'',location.href);
    var parts=u.pathname.split('/').filter(Boolean);
    if(parts[parts.length-1]==='index.html')parts.pop();
    return parts[parts.length-1]||'';
  }catch(_){return '';}
}
function snapshotForAnchor(anchor){
  if(!anchor)return null;
  var local=normalizedLocalHref(anchor.getAttribute('href')||'');
  var slug=clickedSlug(anchor);
  var map=interactionSnapshotMap();
  return map[local]||map[slug]||null;
}
function interactionControlSelector(){
  return 'button,[role="button"],[aria-haspopup],[aria-expanded],.lux-menu-trigger-wrapper,.avatar-wrapper.cursor-pointer,.top-nav-button';
}
function interactionBaseKey(el){
  var tag=(el.tagName||'').toLowerCase();
  var role=el.getAttribute('data-static-added-role')==='1'?'':el.getAttribute('role')||'';
  var label=(el.getAttribute('aria-label')||el.getAttribute('title')||textOf(el)).slice(0,80);
  var cls=String(el.className||'').split(/\\s+/).filter(Boolean).filter(function(part){return part.indexOf('jsx-')!==0;}).slice(0,8).join('.');
  return ['ik',tag,role,label,cls].join('|');
}
function isInteractionNavigation(el){
  var anchor=el.closest&&el.closest('a[href]');
  if(!anchor)return false;
  var href=anchor.getAttribute('href')||'';
  if(!href||href==='#'||href.indexOf('javascript:')===0)return false;
  return !el.hasAttribute('aria-haspopup')&&!el.hasAttribute('aria-expanded');
}
function interactionControls(){
  return Array.prototype.slice.call(document.querySelectorAll(interactionControlSelector())).filter(function(el){
    if(!isVisibleBox(el))return false;
    if(el.disabled||el.getAttribute('aria-disabled')==='true')return false;
    if(el.closest&&el.closest('.content-card,.event-row')&&el.closest('.content-card,.event-row').querySelector('a.event-link[href]'))return false;
    if(isInteractionNavigation(el))return false;
    var label=(el.getAttribute('aria-label')||el.getAttribute('title')||textOf(el)).trim();
    var cls=String(el.className||'');
    if(!label&&!/avatar|menu|search|bell|profile|trigger|popover/i.test(cls))return false;
    if(/^(events|discover|calendars|create event|event page|view all)$/i.test(label))return false;
    return true;
  });
}
function interactionKeyForControl(control){
  if(!control)return '';
  var controls=interactionControls();
  var base=interactionBaseKey(control);
  var index=0;
  for(var i=0;i<controls.length;i++){
    var other=controls[i];
    if(other===control)break;
    if(interactionBaseKey(other)===base)index++;
  }
  return base+'#'+index;
}
function snapshotForControl(control){
  var key=interactionKeyForControl(control);
  var map=interactionSnapshotMap();
  var snapshot=key?map[key]||null:null;
  if(snapshot&&!snapshot.key)snapshot.key=key;
  return snapshot;
}
function staticOverlayControlSelector(){
  return 'button,a[href],[role="button"],[aria-haspopup],[aria-expanded],.lux-menu-trigger-wrapper,.avatar-wrapper.cursor-pointer,.top-nav-button';
}
function isNestedSnapshotControl(control){
  if(!control||!isVisibleBox(control)||control.disabled||control.getAttribute('aria-disabled')==='true')return false;
  var label=displayLabel(control);
  if(/^(close|copy link|event page|join waitlist|register|one-click rsvp|accept invite|decline|subscribe|subscribed|add to calendar|add to wallet|my ticket|sign out|update profile|save|delete|remove|cancel|submit|create|contact the host|report event)$/i.test(label))return false;
  var anchor=control.closest&&control.closest('a[href]');
  if(anchor&&!control.hasAttribute('aria-haspopup')&&!control.hasAttribute('aria-expanded'))return false;
  if(control.closest&&control.closest('.content-card,.event-row')&&control.closest('.content-card,.event-row').querySelector('a.event-link[href]'))return false;
  return true;
}
function snapshotNestedControls(nodes){
  var seen=[];
  nodes.forEach(function(node){
    if(!node.querySelectorAll)return;
    Array.prototype.slice.call(node.querySelectorAll(staticOverlayControlSelector())).forEach(function(control){
      if(seen.indexOf(control)<0&&isNestedSnapshotControl(control))seen.push(control);
    });
  });
  return seen;
}
function nestedInteractionKey(action,nodes,parentKey){
  if(!parentKey||!action)return '';
  var controls=snapshotNestedControls(nodes);
  var base=interactionBaseKey(action);
  var index=0;
  for(var i=0;i<controls.length;i++){
    var other=controls[i];
    if(other===action)break;
    if(interactionBaseKey(other)===base)index++;
  }
  return controls.indexOf(action)>=0?parentKey+'>>'+base+'#'+index:'';
}
function nextData(){
  if(window.__STATIC_EXPORT_NEXT_DATA!==undefined)return window.__STATIC_EXPORT_NEXT_DATA;
  var node=document.getElementById('__NEXT_DATA__');
  if(!node){window.__STATIC_EXPORT_NEXT_DATA=null;return null;}
  try{window.__STATIC_EXPORT_NEXT_DATA=JSON.parse(node.textContent||'{}');}
  catch(_){window.__STATIC_EXPORT_NEXT_DATA=null;}
  return window.__STATIC_EXPORT_NEXT_DATA;
}
function findEventRecordBySlug(slug){
  if(!slug)return null;
  var root=nextData();
  var found=null;
  function visit(value){
    if(found||!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(visit);return;}
    if(value.event&&value.event.url===slug){found=value;return;}
    if(value.url===slug){found={event:value};return;}
    Object.keys(value).forEach(function(key){visit(value[key]);});
  }
  visit(root);
  return found;
}
function cardInfo(control,anchor){
  var title=extractPreviewTitle(control,anchor);
  var time=textOf(control.querySelector('.event-time'))||'';
  var venue=textOf(control.querySelector('.meta-row'))||'';
  var image=control.querySelector('img');
  return {title:title,time:time,venue:venue,image:image&&(image.currentSrc||image.src)||''};
}
function fmtDate(value){
  if(!value)return '';
  try{return new Intl.DateTimeFormat(undefined,{weekday:'long',month:'long',day:'numeric'}).format(new Date(value));}
  catch(_){return '';}
}
function fmtTime(value){
  if(!value)return '';
  try{return new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(value));}
  catch(_){return '';}
}
function fmtMonth(value){
  if(!value)return '';
  try{return new Intl.DateTimeFormat(undefined,{month:'short'}).format(new Date(value)).toUpperCase();}
  catch(_){return '';}
}
function fmtDay(value){
  if(!value)return '';
  try{return new Intl.DateTimeFormat(undefined,{day:'numeric'}).format(new Date(value));}
  catch(_){return '';}
}
function appendText(parent,cls,text){
  var el=document.createElement('div');
  if(cls)el.className=cls;
  el.textContent=text||'';
  parent.appendChild(el);
  return el;
}
function appendFact(parent,icon,title,sub){
  var fact=document.createElement('div');
  fact.className='static-preview-fact';
  appendText(fact,'static-preview-icon',icon);
  var text=document.createElement('div');
  appendText(text,'static-preview-fact-title',title);
  if(sub)appendText(text,'static-preview-fact-sub',sub);
  fact.appendChild(text);
  parent.appendChild(fact);
}
function openStaticSnapshotPreview(anchor){
  var snapshot=snapshotForAnchor(anchor);
  if(!snapshot||!snapshot.html)return false;
  closeStaticPanels();
  if(window.__STATIC_EXPORT_ACTIVE_DISMISS){
    try{window.__STATIC_EXPORT_ACTIVE_DISMISS(true);}catch(_){}
  }
  document.querySelectorAll('[data-static-modal-backdrop],[data-static-card-preview],[data-static-snapshot-modal],[data-static-generic-snapshot]').forEach(function(el){el.remove();});
  if(snapshot.styles){
    var capturedStyle=document.getElementById('__static-snapshot-style');
    if(!capturedStyle){
      capturedStyle=document.createElement('style');
      capturedStyle.id='__static-snapshot-style';
      document.head.appendChild(capturedStyle);
    }
    capturedStyle.textContent=snapshot.styles;
  }
  var backdrop=document.createElement('div');
  backdrop.setAttribute('data-static-modal-backdrop','1');
  var holder=document.createElement('div');
  holder.innerHTML=snapshot.html;
  var modal=holder.querySelector('[data-static-captured-luma-panel]')||holder.firstElementChild;
  if(!modal)return false;
  modal.setAttribute('data-static-snapshot-modal','1');
  modal.setAttribute('role',modal.getAttribute('role')||'dialog');
  var closing=false;
  function dismiss(){
    if(closing)return;
    closing=true;
    modal.removeAttribute('data-static-open');
    backdrop.removeAttribute('data-static-open');
    setTimeout(function(){backdrop.remove();modal.remove();},260);
  }
  backdrop.addEventListener('click',dismiss);
  modal.addEventListener('click',function(ev){
    var target=ev.target;
    if(!target||!target.closest)return;
    var close=target.closest('button[aria-label="Close"],button.close-btn');
    if(close){ev.preventDefault();dismiss();return;}
    var control=target.closest('button,a[href]');
    if(!control)return;
    var label=displayLabel(control);
    if(/copy link/i.test(label)){
      ev.preventDefault();
      try{navigator.clipboard&&navigator.clipboard.writeText(location.origin+(snapshot.href||anchor.getAttribute('href')||''));}catch(_){}
      control.textContent='Copied';
      return;
    }
    if(/event page/i.test(label)){
      ev.preventDefault();
      var href=snapshot.href||anchor.getAttribute('href')||'';
      if(href)location.href=href;
      return;
    }
    if(/join waitlist|register|one-click rsvp/i.test(label)){
      ev.preventDefault();
      control.textContent=/join waitlist/i.test(label)?'Joined Waitlist':'Registered';
    }
  },true);
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
  requestAnimationFrame(function(){
    backdrop.setAttribute('data-static-open','1');
    modal.setAttribute('data-static-open','1');
  });
  return true;
}
function markStaticSnapshotNode(node){
  var cls=String(node.className||'');
  if(/overlay|backdrop|scrim/i.test(cls))node.setAttribute('data-static-fullscreen','1');
}
function openStaticInteractionSnapshotRecord(snapshot){
  if(!snapshot||!snapshot.html)return false;
  closeStaticPanels();
  if(window.__STATIC_EXPORT_ACTIVE_DISMISS){
    try{window.__STATIC_EXPORT_ACTIVE_DISMISS(true);}catch(_){}
  }
  document.querySelectorAll('[data-static-modal-backdrop],[data-static-card-preview],[data-static-snapshot-modal],[data-static-generic-snapshot]').forEach(function(el){el.remove();});
  if(snapshot.styles){
    var capturedStyle=document.getElementById('__static-snapshot-style');
    if(!capturedStyle){
      capturedStyle=document.createElement('style');
      capturedStyle.id='__static-snapshot-style';
      document.head.appendChild(capturedStyle);
    }
    capturedStyle.textContent=snapshot.styles;
  }
  var backdrop=null;
  var holder=document.createElement('div');
  holder.innerHTML=snapshot.html;
  var nodes=Array.prototype.slice.call(holder.children);
  if(nodes.length===0)return false;
  var closing=false;
  function dismiss(immediate){
    if(closing)return;
    closing=true;
    if(backdrop)backdrop.removeAttribute('data-static-open');
    nodes.forEach(function(node){node.removeAttribute('data-static-open');});
    var remove=function(){
      if(backdrop)backdrop.remove();
      nodes.forEach(function(node){node.remove();});
      if(window.__STATIC_EXPORT_ACTIVE_DISMISS===dismiss)window.__STATIC_EXPORT_ACTIVE_DISMISS=null;
    };
    document.removeEventListener('mousedown',outside,true);
    document.removeEventListener('keydown',escape,true);
    if(immediate)remove();
    else setTimeout(remove,220);
  }
  function outside(ev){
    for(var i=0;i<nodes.length;i++){
      if(nodes[i].contains(ev.target))return;
    }
    dismiss();
  }
  function escape(ev){
    if(ev.key==='Escape')dismiss();
  }
  if(snapshot.backdrop){
    backdrop=document.createElement('div');
    backdrop.setAttribute('data-static-modal-backdrop','1');
    backdrop.addEventListener('click',dismiss);
    document.body.appendChild(backdrop);
  }
  nodes.forEach(function(node){
    markStaticSnapshotNode(node);
    node.setAttribute('data-static-generic-snapshot','1');
    node.addEventListener('click',function(ev){
      var target=ev.target;
      if(!target||!target.closest)return;
      var close=target.closest('button[aria-label="Close"],button.close-btn,[data-dismiss],[data-close]');
      if(close){ev.preventDefault();dismiss();return;}
      var action=target.closest(staticOverlayControlSelector());
      if(!action)return;
      var label=displayLabel(action);
      var nestedKey=nestedInteractionKey(action,nodes,snapshot.key||'');
      var nestedSnapshot=nestedKey&&interactionSnapshotMap()[nestedKey];
      if(nestedSnapshot){
        ev.preventDefault();
        ev.stopPropagation();
        if(!nestedSnapshot.key)nestedSnapshot.key=nestedKey;
        dismiss(true);
        openStaticInteractionSnapshotRecord(nestedSnapshot);
        return;
      }
      if(/copy link/i.test(label)){
        ev.preventDefault();
        try{navigator.clipboard&&navigator.clipboard.writeText(location.href);}catch(_){}
        action.textContent='Copied';
      }
    },true);
    document.body.appendChild(node);
  });
  document.addEventListener('keydown',escape,true);
  if(!snapshot.backdrop)setTimeout(function(){document.addEventListener('mousedown',outside,true);},0);
  window.__STATIC_EXPORT_ACTIVE_DISMISS=dismiss;
  requestAnimationFrame(function(){
    if(backdrop)backdrop.setAttribute('data-static-open','1');
    nodes.forEach(function(node){node.setAttribute('data-static-open','1');});
  });
  return true;
}
function openStaticInteractionSnapshot(control){
  return openStaticInteractionSnapshotRecord(snapshotForControl(control));
}
function eventDrawerData(control,anchor){
  var info=cardInfo(control,anchor);
  var record=findEventRecordBySlug(clickedSlug(anchor));
  var event=record&&record.event||{};
  var calendar=record&&record.calendar||{};
  var local=normalizedLocalHref(anchor&&anchor.getAttribute('href')||'');
  var detail=eventPreviewMap()[local]||eventPreviewMap()[clickedSlug(anchor)]||{};
  var city=record&&record.featured_city&&record.featured_city.name || calendar.location&&calendar.location.city || calendar.city&&calendar.city.city || '';
  var start=detail.startAt||event.start_at||record&&record.start_at;
  var end=detail.endAt||event.end_at;
  var date=fmtDate(start)||info.time;
  var time=fmtTime(start);
  if(end)time+=(time?' - ':'')+fmtTime(end);
  var venue=info.venue || city;
  var availability=detail.registrationAvailability||record&&record.registration_availability||'';
  var isFull=detail.soldOut||availability==='waitlist'||availability==='sold-out';
  var status=isFull?'Event Full':'Registration';
  var action=isFull?'Join Waitlist':/subscribe/i.test(textOf(control))?'Subscribe':'Register';
  var about=detail.about||calendar.description_short || 'This is a static HTML preview generated from the event card and the public event data captured on this page.';
  return {
    title:detail.title||event.name||info.title,
    image:detail.image||event.cover_url||info.image||event.social_image_url,
    calendar:detail.calendar||calendar.name||'Luma Calendar',
    date:date,
    time:time||info.time,
    dateIcon:(fmtMonth(start)||'JUN')+(fmtDay(start)?'\\n'+fmtDay(start):''),
    venue:venue,
    city:detail.city||city,
    venueSub:detail.venueSub||city,
    status:status,
    action:action,
    registrationNote:isFull?'Please click on the button below to join the waitlist. You will be notified if additional spots become available.':'This is a static HTML registration preview.',
    about:about,
    href:anchor&&anchor.getAttribute('href')||''
  };
}
function openStaticCardPreview(control,anchor){
  closeStaticPanels();
  if(window.__STATIC_EXPORT_ACTIVE_DISMISS){
    try{window.__STATIC_EXPORT_ACTIVE_DISMISS(true);}catch(_){}
  }
  document.querySelectorAll('[data-static-modal-backdrop],[data-static-card-preview],[data-static-generic-snapshot]').forEach(function(el){el.remove();});
  var data=eventDrawerData(control,anchor);
  var title=data.title;
  var backdrop=document.createElement('div');
  backdrop.setAttribute('data-static-modal-backdrop','1');
  var modal=document.createElement('div');
  modal.setAttribute('data-static-card-preview','1');
  modal.setAttribute('role','dialog');
  modal.setAttribute('aria-label',title);
  var topbar=document.createElement('div');
  topbar.className='static-preview-topbar';
  appendText(topbar,'static-preview-nav','»');
  var copy=document.createElement('button');
  copy.type='button';
  copy.className='static-preview-pill';
  copy.textContent='Copy Link';
  copy.addEventListener('click',function(){
    try{navigator.clipboard&&navigator.clipboard.writeText(location.origin+data.href);}catch(_){}
    copy.textContent='Copied';
  });
  var eventPage=document.createElement('button');
  eventPage.type='button';
  eventPage.className='static-preview-pill';
  eventPage.textContent='Event Page ↗';
  eventPage.addEventListener('click',function(){if(data.href)location.href=data.href;});
  var up=document.createElement('button');
  up.className='static-preview-close';
  up.type='button';
  up.setAttribute('aria-label','Scroll to top');
  up.textContent='⌃';
  up.addEventListener('click',function(){modal.scrollTo({top:0,behavior:'smooth'});});
  var close=document.createElement('button');
  close.className='static-preview-close';
  close.type='button';
  close.setAttribute('aria-label','Close');
  close.textContent='⌄';
  topbar.appendChild(copy);
  topbar.appendChild(eventPage);
  appendText(topbar,'static-preview-spacer','');
  topbar.appendChild(up);
  topbar.appendChild(close);
  var content=document.createElement('div');
  content.className='static-preview-content';
  if(data.image){
    var img=document.createElement('img');
    img.className='static-preview-hero';
    img.src=data.image;
    img.alt=title;
    content.appendChild(img);
  }
  if(data.city)appendText(content,'static-preview-chip','Featured in '+data.city+' ›');
  appendText(content,'static-preview-title',title);
  appendText(content,'static-preview-host',data.calendar+' ›');
  var facts=document.createElement('div');
  facts.className='static-preview-facts';
  appendFact(facts,data.dateIcon,data.date,data.time);
  appendFact(facts,'⌖',data.venue,data.venueSub);
  content.appendChild(facts);
  var registration=document.createElement('div');
  registration.className='static-preview-section';
  appendText(registration,'static-preview-section-title','Registration');
  var registrationBody=document.createElement('div');
  registrationBody.className='static-preview-section-body';
  var registrationRow=document.createElement('div');
  registrationRow.className='static-preview-registration-row';
  appendText(registrationRow,'static-preview-reg-icon','▰');
  var registrationText=document.createElement('div');
  appendText(registrationText,'static-preview-fact-title',data.status);
  appendText(registrationText,'static-preview-muted',data.registrationNote);
  registrationRow.appendChild(registrationText);
  registrationBody.appendChild(registrationRow);
  var primary=document.createElement('button');
  primary.type='button';
  primary.className='static-preview-action';
  primary.textContent=data.action;
  primary.addEventListener('click',function(){primary.textContent=data.action==='Join Waitlist'?'Joined Waitlist':data.action+'d';});
  registrationBody.appendChild(primary);
  registration.appendChild(registrationBody);
  content.appendChild(registration);
  var about=document.createElement('div');
  about.className='static-preview-section';
  appendText(about,'static-preview-section-title','About Event');
  appendText(about,'static-preview-section-body',data.about);
  content.appendChild(about);
  modal.appendChild(topbar);
  modal.appendChild(content);
  var closing=false;
  function dismiss(){
    if(closing)return;
    closing=true;
    backdrop.removeAttribute('data-static-open');
    modal.removeAttribute('data-static-open');
    setTimeout(function(){backdrop.remove();modal.remove();},260);
  }
  close.addEventListener('click',dismiss);
  backdrop.addEventListener('click',dismiss);
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);
  requestAnimationFrame(function(){
    backdrop.setAttribute('data-static-open','1');
    modal.setAttribute('data-static-open','1');
  });
}
function closeStaticPanels(except){
  document.querySelectorAll('[data-static-export-panel]').forEach(function(panel){
    if(panel!==except){
      panel.removeAttribute('data-static-open');
      setTimeout(function(){panel.remove();},190);
    }
  });
}
function panelLink(label,path,sub){
  var href=localRoute(path)||liveRoute(path);
  var a=document.createElement('a');
  a.href=href||'#';
  var left=document.createElement('span');
  left.textContent=label;
  a.appendChild(left);
  if(sub){
    var right=document.createElement('span');
    right.className='static-muted';
    right.textContent=sub;
    a.appendChild(right);
  }
  return a;
}
function makePanel(id,title,anchor){
  var existing=document.getElementById(id);
  if(existing){
    existing.removeAttribute('data-static-open');
    setTimeout(function(){existing.remove();},190);
    return null;
  }
  closeStaticPanels();
  var panel=document.createElement('div');
  panel.id=id;
  panel.setAttribute('data-static-export-panel','1');
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-label',title);
  var heading=document.createElement('div');
  heading.className='static-panel-title';
  heading.textContent=title;
  panel.appendChild(heading);
  document.body.appendChild(panel);
  requestAnimationFrame(function(){panel.setAttribute('data-static-open','1');});
  try{
    var rect=anchor&&anchor.getBoundingClientRect?anchor.getBoundingClientRect():null;
    if(rect&&rect.right<innerWidth-32){
      panel.style.left=Math.max(16,Math.min(rect.left,innerWidth-400))+'px';
      panel.style.right='auto';
    }
  }catch(_){}
  return panel;
}
function toggleProfilePanel(anchor){
  var panel=makePanel('__static-profile-panel','Profile',anchor);
  if(!panel)return;
  var note=document.createElement('div');
  note.className='static-panel-note';
  note.textContent='Static account menu preview. Links open local captured HTML when available.';
  panel.appendChild(note);
  panel.appendChild(panelLink('Account settings','/settings','Local'));
  panel.appendChild(panelLink('Events','/home','Local'));
  panel.appendChild(panelLink('Calendars','/home/calendars','Local'));
  panel.appendChild(panelLink('Discover','/discover','Local'));
}
function toggleNotificationsPanel(anchor){
  var panel=makePanel('__static-notifications-panel','Notifications',anchor);
  if(!panel)return;
  var note=document.createElement('div');
  note.className='static-panel-note';
  note.textContent='Static notification menu preview.';
  panel.appendChild(note);
  panel.appendChild(panelLink('Open notifications','/notifications','Local'));
  panel.appendChild(panelLink('Events','/home','Local'));
}
function toggleSearchPanel(anchor){
  var panel=makePanel('__static-search-panel','Search',anchor);
  if(!panel)return;
  var input=document.createElement('input');
  input.type='search';
  input.placeholder='Search events';
  input.setAttribute('aria-label','Search events');
  panel.appendChild(input);
  panel.appendChild(panelLink('Discover events','/discover','Local'));
  panel.appendChild(panelLink('Your events','/home','Local'));
  panel.appendChild(panelLink('Calendars','/home/calendars','Local'));
  setTimeout(function(){try{input.focus();}catch(_){}},0);
}
function isSegmentControl(control,label){
  var cls=String(control.className||'');
  if(cls.indexOf('segment')>=0||cls.indexOf(' tab ')>=0||cls.indexOf('tag-button')>=0)return true;
  return /^(Upcoming|Past|Monthly|Annual|Global|City|South America|North America|Europe|Africa|Asia & Pacific)$/.test(label);
}
function selectPeer(control){
  var parent=control.parentElement;
  if(!parent)return;
  var peers=[].slice.call(parent.querySelectorAll('button,[role="button"]')).filter(function(peer){
    return peer.parentElement===parent||peer.closest('.segmented-control,.tabs,.tab-list')===parent;
  });
  if(peers.length<2||peers.length>12)peers=[].slice.call(parent.querySelectorAll('button,[role="button"]')).slice(0,12);
  peers.forEach(function(peer){
    peer.classList.remove('selected');
    peer.setAttribute('aria-selected','false');
  });
  control.classList.add('selected');
  control.setAttribute('aria-selected','true');
}
function currentRoutePath(){
  try{
    var canonical=document.querySelector('link[rel="canonical"]');
    if(canonical&&canonical.href)return new URL(canonical.href).pathname;
  }catch(_){}
  return location.pathname.replace(/\\/index\\.html$/,'').replace(/\\/+$/,'')||'/';
}
function routeAction(label){
  var lower=label.toLowerCase();
  var here=currentRoutePath();
  if(lower==='submit event')return '/create';
  if(lower==='create event')return here==='/create'?null:'/create';
  if(lower==='create calendar')return here==='/create-calendar'?null:'/create-calendar';
  if(lower==='events')return '/home';
  if(lower==='discover')return '/discover';
  if(lower==='calendars')return '/home/calendars';
  return null;
}
function actionFallback(control,label){
  var cls=String(control.className||'');
  var lower=String(label||'').toLowerCase();
  var route=routeAction(label);
  if(route)return localRoute(route)||liveRoute(route);
  if(/^(register|join waitlist|one-click rsvp|accept invite|decline|subscribe|subscribed|contact the host|report event|refund policy|translate|add to calendar|add to wallet|my ticket|invite a friend|update profile|create calendar|contact us|enter it here)$/i.test(label)){
    return currentLiveUrl();
  }
  return null;
}
function hasNativeOverlay(){
  return !!document.querySelector('.lux-menu,[role="dialog"],[aria-modal="true"],.modal,.drawer,.popover,[data-radix-popper-content-wrapper]');
}
function scheduleFallback(target){
  var before=location.href;
  setTimeout(function(){
    if(location.href!==before)return;
    if(hasNativeOverlay())return;
    location.href=target;
  },450);
}
function isProfileControl(control){
  if(!control)return false;
  var cls=String(control.className||'');
  return cls.indexOf('avatar-wrapper')>=0&&cls.indexOf('cursor-pointer')>=0;
}
function pressControl(control){
  if(!control||!control.setAttribute)return;
  control.setAttribute('data-static-pressed','1');
  setTimeout(function(){control.removeAttribute('data-static-pressed');},160);
}
function bootHoverAnimations(){
    document.querySelectorAll('button,[role="button"],.avatar-wrapper.cursor-pointer,.top-nav-button,.content-card.hoverable,.actionable,.event-row,.lux-button').forEach(function(el){
    el.setAttribute('data-static-hover','1');
  });
}
function bootCapturedMaps(){
  var store=window.__STATIC_EXPORT_MAP_IMAGES||{};
  window.__STATIC_EXPORT_MAP_IMAGES=store;
  function remember(){
    document.querySelectorAll('img[data-static-captured-map][data-static-map-src]').forEach(function(img){
      var src=img.getAttribute('data-static-map-src')||'';
      if(src&&!store[src])store[src]=img.outerHTML;
    });
  }
  function restore(){
    remember();
    document.querySelectorAll('iframe[src*="google.com/maps/embed"]').forEach(function(frame){
      var src=frame.getAttribute('src')||'';
      var html=store[src];
      if(!html)return;
      var holder=document.createElement('div');
      holder.innerHTML=html;
      var img=holder.firstElementChild;
      if(img)frame.replaceWith(img);
    });
  }
  restore();
  new MutationObserver(restore).observe(document.documentElement,{childList:true,subtree:true});
  setTimeout(restore,250);
  setTimeout(restore,1000);
  setTimeout(restore,2500);
}
function bootStaticInteractions(){
  installActionStyles();
  function arm(){
    document.querySelectorAll('button,[role="button"],.avatar-wrapper.cursor-pointer,.lux-menu-trigger-wrapper[tabindex],.event-row').forEach(function(el){
      el.setAttribute('data-static-control','1');
      if(el.tagName!=='BUTTON'&&!el.getAttribute('role')){
        el.setAttribute('role','button');
        el.setAttribute('data-static-added-role','1');
      }
      if(!el.hasAttribute('tabindex')&&el.getAttribute('role')==='button')el.setAttribute('tabindex','0');
    });
    bootHoverAnimations();
  }
  arm();
  new MutationObserver(arm).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('keydown',function(ev){
    if(ev.key!=='Enter'&&ev.key!==' ')return;
    var control=ev.target&&ev.target.closest?ev.target.closest('button,[role="button"],.avatar-wrapper.cursor-pointer,.lux-menu-trigger-wrapper[tabindex],.event-row'):null;
    if(!control)return;
    ev.preventDefault();
    control.click();
  },true);
  document.addEventListener('click',function(ev){
    if(ev.defaultPrevented)return;
    var target=ev.target;
    if(!target||!target.closest)return;
    if(target.closest('[data-static-export-panel]'))return;
    var directAnchor=target.closest('a[href]');
    if(directAnchor){
      var anchorControl=directAnchor.closest('.event-row,.content-card,.actionable,[role="button"]');
      if(shouldPreviewAnchor(directAnchor,anchorControl)){
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if(!openStaticSnapshotPreview(directAnchor))openStaticCardPreview(anchorControl||directAnchor,directAnchor);
        return;
      }
    }
    var button=target.closest('button');
    var control=button||target.closest('[role="button"],.avatar-wrapper.cursor-pointer,.lux-menu-trigger-wrapper[tabindex],.event-row');
    if(!control||control.disabled||control.getAttribute('aria-disabled')==='true')return;
    pressControl(control);
    if(openStaticInteractionSnapshot(control)){
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    var anchor=findNavigable(control);
    if(anchor){
      if(shouldPreviewAnchor(anchor,control)){
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if(!openStaticSnapshotPreview(anchor))openStaticCardPreview(control,anchor);
        return;
      }
      ev.preventDefault();
      ev.stopImmediatePropagation();
      navigateAnchor(anchor);
      return;
    }
    var label=displayLabel(control);
    var cls=String(control.className||'');
    if(isProfileControl(control)){
      ev.preventDefault();
      ev.stopImmediatePropagation();
      toggleProfilePanel(control);
      return;
    }
    if(cls.indexOf('notifications-bell-button')>=0){
      ev.preventDefault();
      ev.stopImmediatePropagation();
      toggleNotificationsPanel(control);
      return;
    }
    if(cls.indexOf('search-button')>=0||label.toLowerCase()==='search'){
      ev.preventDefault();
      ev.stopImmediatePropagation();
      toggleSearchPanel(control);
      return;
    }
    if(isSegmentControl(control,label)){
      ev.preventDefault();
      ev.stopImmediatePropagation();
      selectPeer(control);
      return;
    }
    var fallback=actionFallback(control,label);
    if(fallback){
      if(control.tagName==='BUTTON'&&String(control.getAttribute('type')||'').toLowerCase()==='submit')ev.preventDefault();
      scheduleFallback(fallback);
    }
  },true);
}
function bootReveals(){
  var targets=[].slice.call(document.querySelectorAll('[data-motion-reveal-target],[data-motion-reveal-item]'));
  if(!targets.length)return;
  function reveal(el){
    el.dataset.staticReveal='done';
    el.style.opacity='1';
    el.style.transform='none';
  }
  function prime(el){
    if(el.dataset.staticReveal==='done')return;
    var r=el.getBoundingClientRect();
    if(r.top<innerHeight*.9&&r.bottom>0){reveal(el);return;}
    el.dataset.staticReveal='pending';
    el.style.willChange='opacity, transform';
    el.style.transition=el.style.transition||'opacity 600ms ease, transform 600ms ease';
    el.style.opacity='0';
    el.style.transform='translate3d(0,12px,0)';
  }
  targets.forEach(prime);
  if(!('IntersectionObserver' in window)){targets.forEach(reveal);return;}
  var io=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(entry.isIntersecting){reveal(entry.target);io.unobserve(entry.target);}
    });
  },{rootMargin:'0px 0px -30% 0px',threshold:0});
  targets.forEach(function(el){
    if(el.dataset.staticReveal==='pending')io.observe(el);
  });
}
function candidateAnchorGroups(){
  var groups=[];
  var parents=[];
  [].slice.call(document.querySelectorAll('a')).forEach(function(a){
    var label=norm(textOf(a));
    if(!isUsefulLabel(label))return;
    var parent=a.parentElement;
    if(!parent)return;
    var record=parents.find(function(item){return item.parent===parent;});
    if(!record){record={parent:parent,anchors:[]};parents.push(record);}
    record.anchors.push(a);
  });
  parents.forEach(function(record){
    var labels=record.anchors.map(function(a){return norm(textOf(a));});
    var unique=labels.filter(function(label,index){return labels.indexOf(label)===index;});
    if(unique.length<3||unique.length>8)return;
    var pr=record.parent.getBoundingClientRect();
    if(pr.width>520||pr.height<unique.length*22)return;
    var markers=unique.map(function(label){
      var candidates=[].slice.call(document.querySelectorAll('h1,h2,h3,h4,p,span,div')).filter(function(el){
        if(record.parent.contains(el))return false;
        if(norm(textOf(el))!==label)return false;
        if(!isVisibleBox(el))return false;
        return true;
      }).sort(function(a,b){
        return Math.abs(a.getBoundingClientRect().left-record.parent.getBoundingClientRect().right)-Math.abs(b.getBoundingClientRect().left-record.parent.getBoundingClientRect().right);
      });
      return candidates[0]||null;
    });
    if(markers.filter(Boolean).length<3)return;
    groups.push({parent:record.parent,anchors:record.anchors,labels:labels,markers:markers});
  });
  return groups;
}
function bootScrollspy(){
  var groups=candidateAnchorGroups();
  if(!groups.length)return;
  groups.forEach(function(group){
    var activeClass='',inactiveClass='';
    group.anchors.forEach(function(a){
      var cls=a.getAttribute('class')||'';
      if(!activeClass&&cls.indexOf('text-[var(--color-text)]')>=0&&cls.indexOf('secondary')<0)activeClass=cls;
      if(!inactiveClass&&cls.indexOf('text-[var(--color-text-secondary)]')>=0)inactiveClass=cls;
    });
    group.activeClass=activeClass;
    group.inactiveClass=inactiveClass;
  });
  function setActive(group,index){
    group.anchors.forEach(function(a,i){
      if(group.activeClass&&group.inactiveClass){
        a.setAttribute('class',i===index?group.activeClass:group.inactiveClass);
      }else{
        a.style.opacity=i===index?'1':'.62';
      }
      a.setAttribute('aria-current',i===index?'true':'false');
    });
  }
  function update(){
    groups.forEach(function(group){
      var targetY=innerHeight*.42;
      var active=0;
      group.markers.forEach(function(marker,i){
        if(!marker)return;
        if(marker.getBoundingClientRect().top<=targetY)active=i;
      });
      setActive(group,active);
    });
  }
  var raf=0;
  function schedule(){if(raf)return;raf=requestAnimationFrame(function(){raf=0;update();});}
  update();
  addEventListener('scroll',schedule,{passive:true});
  addEventListener('resize',schedule);
  setTimeout(update,250);
  setTimeout(update,1000);
}
ready(function(){
  [bootCapturedMaps,bootStaticInteractions,bootReveals,bootScrollspy].forEach(function(fn){
    try{fn();}catch(_){}
  });
});
})();`;
}

function mapSrcset(value: string, ctx: HtmlRewriteContext): string {
  type Candidate = { url: string; d?: string; w?: string; h?: string };
  let candidates: Candidate[];
  try {
    candidates = parseSrcset(value) as Candidate[];
  } catch {
    return value;
  }
  if (!candidates.length) return value;
  return candidates
    .map((c) => {
      const mapped = mapUrl(c.url, ctx) ?? c.url;
      const descriptor = c.d ? ` ${c.d}x` : c.w ? ` ${c.w}w` : '';
      return `${mapped}${descriptor}`;
    })
    .join(', ');
}

function rewriteInlineStyle(value: string, ctx: HtmlRewriteContext): string {
  // Simple regex pass for inline style attributes — full PostCSS would be overkill here.
  return value.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, quote, urlInner) => {
    const mapped = mapUrl(urlInner, ctx);
    if (!mapped) return match;
    return `url(${quote}${mapped}${quote})`;
  });
}
