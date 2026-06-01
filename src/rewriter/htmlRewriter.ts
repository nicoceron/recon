import * as cheerio from 'cheerio';
import parseSrcset from 'parse-srcset';
import { rewriteCss } from './cssRewriter.js';
import { normalizePageUrl, sameOrigin, tryParse } from '../utils/urlUtils.js';

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
    const absolute = tryParse(value, ctx.pageUrl)?.toString();
    if (!absolute) return;
    if (!sameOrigin(absolute, ctx.siteOrigin)) return;
    const normalized = normalizePageUrl(absolute);
    if (!normalized) return;
    const localPage = ctx.pageLookup(normalized);
    const fallbackPage = localPage ? undefined : ctx.pageFallback?.(normalized);
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

  if (ctx.staticRuntimeFixes) {
    $('head').prepend(`<script>${buildStaticHotlinkPreflight()}</script>`);
    if (ctx.runtimePageMap && Object.keys(ctx.runtimePageMap).length > 0) {
      $('body').append(`<script>${buildRuntimePageLinkRewriter(ctx.runtimePageMap, ctx.siteOrigin)}</script>`);
    }
    $('body').append(`<script>${buildStaticRuntimeFixes()}</script>`);
  }

  return $.html();
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

function buildRuntimePageLinkRewriter(pageMap: Record<string, string>, origin: string): string {
  const mapJson = JSON.stringify(pageMap);
  const originJson = JSON.stringify(origin);
  return `(function(){
var pageMap=${mapJson};
var siteOrigin=${originJson};
window.__STATIC_EXPORT_PAGE_MAP=pageMap;
window.__STATIC_EXPORT_SITE_ORIGIN=siteOrigin;
function ready(fn){
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',fn,{once:true});
  else fn();
}
function normPath(path){
  path=path||'/';
  if(path.length>1)path=path.replace(/\\/+$/,'');
  return path||'/';
}
function localTarget(raw){
  if(!raw||raw[0]==='#'||raw.indexOf('mailto:')===0||raw.indexOf('tel:')===0||raw.indexOf('javascript:')===0)return null;
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
  if(!raw||raw[0]!=='/')return null;
  try{return new URL(raw,siteOrigin).href;}catch(_){return null;}
}
window.__STATIC_EXPORT_LOCAL_TARGET=localTarget;
window.__STATIC_EXPORT_LIVE_TARGET=liveTarget;
function rewrite(a){
  var raw=a.getAttribute('href');
  var target=localTarget(raw)||liveTarget(raw);
  if(target&&raw!==target)a.setAttribute('href',target);
}
function rewriteAll(){
  document.querySelectorAll('a[href]').forEach(rewrite);
}
document.addEventListener('click',function(ev){
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

function buildStaticRuntimeFixes(): string {
  return `(function(){
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
function siteOrigin(){return window.__STATIC_EXPORT_SITE_ORIGIN||location.origin;}
function normalizedPath(path){
  path=String(path||'/');
  if(path.charAt(0)!=='/')path='/'+path;
  if(path.length>1)path=path.replace(/\\/+$/,'');
  return path||'/';
}
function localRoute(path){
  var map=pageMap();
  var p=normalizedPath(path);
  return map[p]||map[p+'/']||null;
}
function liveRoute(path){
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
    '[data-static-pressed]{transform:scale(.985)!important}'
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
  var card=control.closest&&control.closest('[role="button"],.actionable,.content-card');
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
  if(isProfileControl(control))return liveRoute('/settings')||siteOrigin();
  if(cls.indexOf('notifications-bell-button')>=0)return liveRoute('/notifications')||siteOrigin();
  if(cls.indexOf('search-button')>=0||lower==='search')return liveRoute('/discover')||siteOrigin();
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
  document.querySelectorAll('button,[role="button"],.avatar-wrapper.cursor-pointer,.top-nav-button,.content-card.hoverable,.actionable,.lux-button').forEach(function(el){
    el.setAttribute('data-static-hover','1');
  });
}
function bootStaticInteractions(){
  installActionStyles();
  function arm(){
    document.querySelectorAll('button,[role="button"],.avatar-wrapper.cursor-pointer,.lux-menu-trigger-wrapper[tabindex]').forEach(function(el){
      el.setAttribute('data-static-control','1');
      if(el.tagName!=='BUTTON'&&!el.getAttribute('role'))el.setAttribute('role','button');
      if(!el.hasAttribute('tabindex')&&el.getAttribute('role')==='button')el.setAttribute('tabindex','0');
    });
    bootHoverAnimations();
  }
  arm();
  new MutationObserver(arm).observe(document.documentElement,{childList:true,subtree:true});
  document.addEventListener('keydown',function(ev){
    if(ev.key!=='Enter'&&ev.key!==' ')return;
    var control=ev.target&&ev.target.closest?ev.target.closest('button,[role="button"],.avatar-wrapper.cursor-pointer,.lux-menu-trigger-wrapper[tabindex]'):null;
    if(!control)return;
    ev.preventDefault();
    control.click();
  },true);
  document.addEventListener('click',function(ev){
    if(ev.defaultPrevented)return;
    var target=ev.target;
    if(!target||!target.closest)return;
    if(target.closest('[data-static-export-panel]'))return;
    var button=target.closest('button');
    var control=button||target.closest('[role="button"],.avatar-wrapper.cursor-pointer,.lux-menu-trigger-wrapper[tabindex]');
    if(!control||control.disabled||control.getAttribute('aria-disabled')==='true')return;
    pressControl(control);
    var anchor=findNavigable(control);
    if(anchor){
      return;
    }
    var label=displayLabel(control);
    var fallback=actionFallback(control,label);
    if(fallback){
      if(control.tagName==='BUTTON'&&String(control.getAttribute('type')||'').toLowerCase()==='submit')ev.preventDefault();
      scheduleFallback(fallback);
    }
  },false);
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
  [bootStaticInteractions,bootReveals,bootScrollspy].forEach(function(fn){
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
