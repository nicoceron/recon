import path from 'node:path';
import type { BrowserContext } from 'playwright';
import { AssetStore, installAssetInterceptor } from '../interceptor/assetInterceptor.js';
import { crawlSite } from '../crawler/crawler.js';
import { inlineGoogleMapIframes } from '../crawler/mapCapture.js';
import { applyForcedTheme, installForcedTheme, type ForcedTheme } from '../crawler/themeCapture.js';
import { topupAssets } from '../crawler/assetTopup.js';
import { ensureCleanDir, writeFileEnsured } from '../output/fileWriter.js';
import { writeManifest, type Manifest } from '../output/manifestWriter.js';
import { rewriteCss } from '../rewriter/cssRewriter.js';
import { rewriteHtml, type StaticEventPreview, type StaticInteractionSnapshot } from '../rewriter/htmlRewriter.js';
import { buildJsReplacements, rewriteJs } from '../rewriter/jsRewriter.js';
import { editorToPreviewUrl, openSession, pickActivePageUrl } from '../session/browserSession.js';
import { logger } from '../utils/logger.js';
import { isTextual } from '../utils/mimeUtils.js';
import { normalizePageUrl, pageLocalPath, rootRelativeAssetPath, sameOrigin } from '../utils/urlUtils.js';

export interface ExportCommandOptions {
  url: string;
  outDir: string;
  headed: boolean;
  scroll: boolean;
  viewportWidth: number;
  localizeAssets: boolean;
  userDataDir: string;
  /** Write every crawled page to its own local HTML file instead of only index.html. */
  multiPage?: boolean;
  /** Crawl depth for same-origin links. 0 captures only the start and explicit includeUrls. */
  maxDepth?: number;
  /** Additional same-origin URLs to capture alongside the start page. */
  includeUrls?: string[];
  /** Keep uncaptured same-origin links inside the local export instead of linking to the live site. */
  stayLocal?: boolean;
  /** If set, override the captured canonical / og:url metadata */
  canonicalUrl?: string;
  /** Extra CSS selectors removed from every page during HTML rewrite */
  stripSelectors?: string[];
  /** If set, transform the subscribe form into a redirect link instead of stripping it */
  subscribeRedirect?: { url: string; text?: string };
  /** Force browser and static output theme. */
  forceTheme?: ForcedTheme;
}

export async function runExport(opts: ExportCommandOptions): Promise<void> {
  const outDir = path.resolve(opts.outDir);
  await ensureCleanDir(outDir);

  const session = await openSession({
    userDataDir: opts.userDataDir,
    headed: opts.headed,
    viewportWidth: opts.viewportWidth,
    viewportHeight: 900,
    initialUrl: opts.url,
  });

  try {
    // After user logged-in & navigated, take the visible page URL as the start.
    let liveUrl = pickActivePageUrl(session.context) ?? opts.url;

    // If the user is still on the editor page, derive the preview URL automatically.
    if (liveUrl.includes('framer.com/projects')) {
      const previewUrl = editorToPreviewUrl(liveUrl);
      if (previewUrl) {
        logger.info({ from: liveUrl, to: previewUrl }, 'editor-url-redirected-to-preview');
        liveUrl = previewUrl;
      }
    }
    logger.info({ providedUrl: opts.url, liveUrl }, 'start-url-resolved');

    const startHost = new URL(liveUrl).hostname;
    const store = new AssetStore();
    await installAssetInterceptor(session.context, store, { pageHost: startHost });

    // For sandboxed preview URLs (framer.app/preview/<id>), restrict crawl to that path subtree
    // so we don't spread into framer.app's own marketing pages (/preview, /preview/enterprise, ...).
    const pathPrefixScope =
      liveUrl.includes('framer.app/preview/') || liveUrl.includes('framer.com/preview/');

    const crawlResult = await crawlSite(session.context, {
      startUrl: liveUrl,
      additionalUrls: opts.includeUrls,
      concurrency: 1,
      maxDepth: opts.maxDepth ?? (opts.multiPage ? 1 : 0),
      viewportWidth: opts.viewportWidth,
      viewportHeight: 900,
      scroll: opts.scroll,
      pageTimeoutMs: 60_000,
      pathPrefixScope,
      forceTheme: opts.forceTheme,
    });

    logger.info({ pages: crawlResult.pages.size, assets: store.size() }, 'crawl-finished');
    const interactionSnapshots = await captureInteractionSnapshots(session.context, crawlResult.pages, crawlResult.origin, {
      viewportWidth: opts.viewportWidth,
      viewportHeight: 900,
      forceTheme: opts.forceTheme,
    });

    const shouldLocalizeAssets = opts.localizeAssets;
    if (shouldLocalizeAssets) {
      logger.info('starting-topup');
      // Top-up phase: scan HTML for asset URLs the browser didn't fetch (srcset
      // variants for other viewports, favicons skipped in headless, etc.) and pull
      // them down explicitly so the exported site renders correctly at every breakpoint.
      await topupAssets(session.context, crawlResult.pages, store);
      logger.info({ assets: store.size() }, 'topup-finished-starting-rewrite');
    }

    if (shouldLocalizeAssets) {
      const hosts = collectHosts(store);
      const jsReplacements = buildJsReplacements(hosts);
      await writeAssets(outDir, store, true, hosts, jsReplacements);
    }

    if (opts.multiPage) {
      await writeHtmlPages(outDir, crawlResult.pages, crawlResult.origin, store, {
        liveUrl,
        localizeAssets: shouldLocalizeAssets,
        canonicalUrl: opts.canonicalUrl,
        stripSelectors: opts.stripSelectors,
        subscribeRedirect: opts.subscribeRedirect,
        stayLocal: opts.stayLocal ?? true,
        multiPage: true,
        interactionSnapshots,
        pageStyles: crawlResult.pageStyles,
        forceTheme: opts.forceTheme,
      });
    } else {
      await writeSingleHtml(outDir, crawlResult.pages, crawlResult.origin, store, {
        liveUrl,
        localizeAssets: shouldLocalizeAssets,
        canonicalUrl: opts.canonicalUrl,
        stripSelectors: opts.stripSelectors,
        subscribeRedirect: opts.subscribeRedirect,
        stayLocal: opts.stayLocal,
        interactionSnapshots,
        pageStyles: crawlResult.pageStyles,
        forceTheme: opts.forceTheme,
      });
    }

    if (shouldLocalizeAssets) {
      // Stub Framer's editor-bootstrap module: the rewritten JS bundles still
      // perform `import('/assets/framer.com/edit/init.mjs')` for owner-only UX.
      // Serving an empty ES module makes the dynamic import resolve as a no-op
      // instead of throwing a 404 → "Failed to fetch dynamically imported module"
      // console error on every page load.
      // The Framer runtime does:
      //   const { createEditorBar: e } = await import('/assets/framer.com/edit/init.mjs')
      //   return { default: e() }
      // So we MUST export a callable `createEditorBar` to avoid a TypeError.
      // It returns null so React renders nothing.
      await writeFileEnsured(
        outDir,
        'assets/framer.com/edit/init.mjs',
        `/* stubbed by framer-html-exporter: editor bootstrap is a no-op in static export */
export const createEditorBar = () => null;
export default createEditorBar;
`,
      );
    }

    const manifest = buildManifest(liveUrl, crawlResult.origin, crawlResult.pages, store, {
      includeAssets: shouldLocalizeAssets,
      multiPage: opts.multiPage,
    });
    await writeManifest(outDir, manifest);

    logger.info(
      { pages: manifest.totals.pages, assets: manifest.totals.assets, bytes: manifest.totals.assetBytes },
      'export-complete',
    );
    process.stderr.write(
      `\nDone. ${manifest.totals.pages} page(s), ${manifest.totals.assets} asset(s) saved to ${outDir}\n` +
        `Run:  npm run serve   (or:  framer-html-exporter serve)   then open http://localhost:3000\n\n`,
    );
  } finally {
    await session.close();
  }
}

function collectHosts(store: AssetStore): Set<string> {
  const hosts = new Set<string>();
  for (const rec of store.all()) {
    try {
      hosts.add(new URL(rec.url).hostname);
    } catch {
      // ignore malformed
    }
  }
  return hosts;
}

async function captureInteractionSnapshots(
  context: BrowserContext,
  pages: Map<string, string>,
  origin: string,
  opts: { viewportWidth: number; viewportHeight: number; forceTheme?: ForcedTheme },
): Promise<Record<string, StaticInteractionSnapshot>> {
  const snapshots: Record<string, StaticInteractionSnapshot> = {};

  await captureLumaPopularEventSnapshots(context, pages, origin, opts, snapshots);
  await captureGenericInteractionSnapshots(context, pages, origin, opts, snapshots);

  logger.info({ count: Object.keys(snapshots).length }, 'interaction-snapshots-captured');
  return snapshots;
}

async function captureLumaPopularEventSnapshots(
  context: BrowserContext,
  pages: Map<string, string>,
  origin: string,
  opts: { viewportWidth: number; viewportHeight: number; forceTheme?: ForcedTheme },
  snapshots: Record<string, StaticInteractionSnapshot>,
): Promise<void> {
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return;
  }
  if (host !== 'luma.com' && !host.endsWith('.luma.com')) return;

  const sourceUrls = selectLumaEventSnapshotSources(pages);
  if (sourceUrls.length === 0) return;

  const page = await context.newPage();
  await page.setViewportSize({ width: opts.viewportWidth, height: opts.viewportHeight });
  await installForcedTheme(page, opts.forceTheme);

  try {
    logger.info({ pages: sourceUrls.length, urls: sourceUrls }, 'capturing-interaction-snapshots');
    const events: Array<{ sourceUrl: string; href: string; title: string; slug: string }> = [];
    const seenSlugs = new Set<string>();
    const maxEventSnapshots = 14;

    for (const sourceUrl of sourceUrls) {
      if (events.length >= maxEventSnapshots) break;
      try {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
        await applyForcedTheme(page, opts.forceTheme);
        await page.waitForSelector('a.event-link[href]', { timeout: 8_000 }).catch(() => undefined);
        const pageEvents = await page.evaluate(() => {
          return Array.from(document.querySelectorAll<HTMLAnchorElement>('a.event-link[href]'))
            .map((anchor) => ({
              href: anchor.href,
              title: anchor.getAttribute('aria-label') || anchor.textContent?.replace(/\s+/g, ' ').trim() || '',
              slug: anchor.pathname.split('/').filter(Boolean).at(-1) || '',
            }))
            .filter((event) => Boolean(event.slug));
        });
        for (const event of pageEvents) {
          if (!event.slug || seenSlugs.has(event.slug)) continue;
          seenSlugs.add(event.slug);
          events.push({ ...event, sourceUrl });
          if (events.length >= maxEventSnapshots) break;
        }
      } catch (err) {
        logger.debug({ url: sourceUrl, err: (err as Error).message }, 'luma-event-source-scan-failed');
      }
    }
    logger.info(
      { count: events.length, slugs: events.map((event) => event.slug), sources: sourceUrls.length },
      'interaction-snapshot-events-found',
    );

    for (const event of events) {
      const normalized = normalizePageUrl(event.href, origin);
      if (!normalized) continue;
      const localHref = rootRelativePagePath(normalized);

      try {
        await page.goto(event.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await applyForcedTheme(page, opts.forceTheme);
        await page.waitForSelector('a.event-link[href]', { timeout: 20_000 });
        const clicked = await page.evaluate((slug) => {
          const anchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a.event-link[href]')).find((candidate) => {
            try {
              const parts = new URL(candidate.href).pathname.split('/').filter(Boolean);
              return parts.includes(slug);
            } catch {
              return candidate.href.includes(slug);
            }
          });
          if (!anchor) return false;
          anchor.click();
          return true;
        }, event.slug);
        if (!clicked) throw new Error(`Could not click event link: ${event.slug}`);
        await page.waitForSelector('.lux-modal.panel', { timeout: 20_000 });
        await page.waitForTimeout(900);
        await applyForcedTheme(page, opts.forceTheme);
        await inlineGoogleMapIframes(page, event.href);
        await applyForcedTheme(page, opts.forceTheme);

        const rawSnapshot = await page.evaluate(`(() => {
            const sourceOrigin = ${JSON.stringify(origin)};
            const modal = document.querySelector('.lux-modal.panel');
            if (!modal) return null;
            const clone = modal.cloneNode(true);
            clone.removeAttribute('style');
            clone.setAttribute('data-static-captured-luma-panel', '1');
            clone.querySelectorAll('script,iframe,noscript').forEach((node) => node.remove());
            clone.querySelectorAll('input,textarea').forEach((node) => {
              node.removeAttribute('value');
              node.textContent = '';
            });
            clone.querySelectorAll('[class*="guests-string"]').forEach((node) => {
              const count = (node.textContent || '').match(/(\\d[\\d,.]*)\\s+others/i)?.[1];
              node.textContent = count ? count + ' attendees' : 'Attendees';
            });
            const textWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode = textWalker.nextNode())) {
              textNode.nodeValue = (textNode.nodeValue || '').replace(/\\bWelcome,\\s+[^!?.]+([!?.])/gi, 'Welcome$1');
            }

            const emailRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i;
            Array.from(clone.querySelectorAll('*')).reverse().forEach((node) => {
              const text = node.textContent || '';
              if (!emailRe.test(text)) return;
              let target = node;
              for (let i = 0; i < 3 && target.parentElement && target.parentElement !== clone; i += 1) {
                const parentText = target.parentElement.textContent || '';
                if (parentText.length > text.length + 220) break;
                target = target.parentElement;
              }
              target.remove();
            });
            Array.from(clone.querySelectorAll('*')).reverse().forEach((node) => {
              const text = node.textContent || '';
              if (!/Update Profile|View Profile|Edit Profile|Sign Out/i.test(text)) return;
              let target = node;
              for (let i = 0; i < 5 && target.parentElement && target.parentElement !== clone; i += 1) {
                const parentText = target.parentElement.textContent || '';
                if (parentText.length > text.length + 320) break;
                target = target.parentElement;
              }
              target.remove();
            });

            function localPathForUrl(url) {
              const parts = url.pathname.split('/').filter(Boolean).map((part) => encodeURIComponent(decodeURIComponent(part)));
              return parts.length === 0 ? '/index.html' : '/' + parts.join('/') + '/index.html';
            }
            clone.querySelectorAll('a[href]').forEach((anchor) => {
              const raw = anchor.getAttribute('href');
              if (!raw) return;
              try {
                const parsed = new URL(raw, sourceOrigin);
                if (parsed.origin === sourceOrigin) anchor.setAttribute('href', localPathForUrl(parsed));
                else anchor.setAttribute('target', '_blank');
              } catch (_) {
                // Leave malformed links alone.
              }
            });

            const seenCss = new Set();
            const cssChunks = [];
            function addCss(css) {
              const text = String(css || '').trim();
              if (!text || seenCss.has(text)) return;
              seenCss.add(text);
              cssChunks.push(text);
            }
            Array.from(document.styleSheets).forEach((sheet) => {
              try {
                if (!sheet.cssRules) return;
                addCss(Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\\n'));
              } catch (_) {
                // Cross-origin stylesheets can block cssRules; fall back to inline <style> text below.
              }
            });
            Array.from(document.querySelectorAll('style')).forEach((style) => addCss(style.textContent || ''));
            const styles = cssChunks.join('\\n');

            return { html: clone.outerHTML, styles };
          })()`);
        const snapshotRecord =
          rawSnapshot && typeof rawSnapshot === 'object'
            ? (rawSnapshot as { html?: unknown; styles?: unknown })
            : undefined;
        const html = typeof snapshotRecord?.html === 'string' ? snapshotRecord.html : '';
        if (!html) continue;
        const styles = typeof snapshotRecord?.styles === 'string' ? snapshotRecord.styles : undefined;
        snapshots[localHref] = { html, styles, href: localHref, title: event.title, kind: 'event-panel', backdrop: true };
        snapshots[event.slug] = { html, styles, href: localHref, title: event.title, kind: 'event-panel', backdrop: true };
      } catch (err) {
        logger.warn({ slug: event.slug, err: (err as Error).message }, 'interaction-snapshot-failed');
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'interaction-snapshot-capture-skipped');
  } finally {
    await page.close().catch(() => undefined);
  }

  logger.info({ count: Object.keys(snapshots).filter((key) => !key.startsWith('ik:')).length / 2 }, 'luma-event-snapshots-captured');
}

function selectLumaEventSnapshotSources(pages: Map<string, string>): string[] {
  const priorityPaths = ['/discover', '/bogota', '/home', '/', '/tech'];
  return [...pages.entries()]
    .filter(([, html]) => !detectFramerDocument(html) && html.includes('event-link'))
    .map(([url]) => url)
    .sort((a, b) => {
      const pathA = new URL(a).pathname.replace(/\/+$/, '') || '/';
      const pathB = new URL(b).pathname.replace(/\/+$/, '') || '/';
      const rankA = priorityPaths.includes(pathA) ? priorityPaths.indexOf(pathA) : 999;
      const rankB = priorityPaths.includes(pathB) ? priorityPaths.indexOf(pathB) : 999;
      if (rankA !== rankB) return rankA - rankB;
      return pathA.localeCompare(pathB);
    })
    .slice(0, 8);
}

async function captureGenericInteractionSnapshots(
  context: BrowserContext,
  pages: Map<string, string>,
  origin: string,
  opts: { viewportWidth: number; viewportHeight: number; forceTheme?: ForcedTheme },
  snapshots: Record<string, StaticInteractionSnapshot>,
): Promise<void> {
  const priorityPaths = ['/', '/discover', '/home', '/settings', '/notifications', '/home/calendars', '/create'];
  const candidateUrls = [...pages.entries()]
    .filter(([, html]) => !detectFramerDocument(html))
    .map(([url]) => url)
    .sort((a, b) => {
      const pathA = new URL(a).pathname.replace(/\/+$/, '') || '/';
      const pathB = new URL(b).pathname.replace(/\/+$/, '') || '/';
      const rankA = priorityPaths.includes(pathA) ? priorityPaths.indexOf(pathA) : 999;
      const rankB = priorityPaths.includes(pathB) ? priorityPaths.indexOf(pathB) : 999;
      return rankA - rankB;
    })
    .slice(0, 5);
  if (candidateUrls.length === 0) return;

  const page = await context.newPage();
  await page.setViewportSize({ width: opts.viewportWidth, height: opts.viewportHeight });
  await installForcedTheme(page, opts.forceTheme);
  let captured = 0;
  const maxSnapshots = 28;
  const maxNestedSnapshotsPerParent = 3;

  try {
    logger.info({ pages: candidateUrls.length }, 'capturing-generic-interaction-snapshots');
    for (const url of candidateUrls) {
      if (captured >= maxSnapshots) break;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined);
      await applyForcedTheme(page, opts.forceTheme);
      await page.waitForTimeout(500);

      const candidates = await page.evaluate(`(() => {
        const selector = 'button,[role="button"],[aria-haspopup],[aria-expanded],.lux-menu-trigger-wrapper,.avatar-wrapper.cursor-pointer,.top-nav-button';
        function textOf(el){return (el && el.textContent || '').replace(/\\s+/g,' ').trim();}
        function visible(el){
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 8 && r.height > 8 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
        }
        function isNavigation(el){
          const anchor = el.closest && el.closest('a[href]');
          if (!anchor) return false;
          const href = anchor.getAttribute('href') || '';
          if (!href || href === '#' || href.indexOf('javascript:') === 0) return false;
          return !el.hasAttribute('aria-haspopup') && !el.hasAttribute('aria-expanded');
        }
        function baseKey(el){
          const tag = (el.tagName || '').toLowerCase();
          const role = el.getAttribute('role') || '';
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).slice(0,80);
          const cls = String(el.className || '').split(/\\s+/).filter(Boolean).filter((part) => part.indexOf('jsx-') !== 0).slice(0,8).join('.');
          return ['ik', tag, role, label, cls].join('|');
        }
        function interactionKey(el, controls){
          const base = baseKey(el);
          let index = 0;
          for (const other of controls) {
            if (other === el) break;
            if (baseKey(other) === base) index += 1;
          }
          return base + '#' + index;
        }
        const controls = Array.from(document.querySelectorAll(selector)).filter((el) => {
          if (!visible(el)) return false;
          if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
          if (el.closest('.content-card,.event-row')?.querySelector('a.event-link[href]')) return false;
          if (el.closest('[data-static-captured-luma-panel],[role="dialog"],[aria-modal="true"]')) return false;
          if (isNavigation(el)) return false;
          const label = (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).trim();
          const cls = String(el.className || '');
          if (!label && !/avatar|menu|search|bell|profile|trigger|popover/i.test(cls)) return false;
          if (/^(events|discover|calendars|create event|event page|view all)$/i.test(label)) return false;
          return true;
        });
        const seen = new Set();
        return controls.map((el) => {
          const key = interactionKey(el, controls);
          return { key, label: (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).slice(0,80) };
        }).filter((item) => {
          if (seen.has(item.key)) return false;
          seen.add(item.key);
          return true;
        }).slice(0, 8);
      })()`);

      for (const candidate of candidates as Array<{ key: string; label: string }>) {
        if (captured >= maxSnapshots) break;
        if (!candidate.key || snapshots[candidate.key]) continue;
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
          await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
          await applyForcedTheme(page, opts.forceTheme);
          await page.waitForTimeout(400);
          const before = await page.evaluate(genericOverlaySignatureScript);
          const clicked = await page.evaluate(`(${genericClickScript})(${JSON.stringify(candidate.key)})`);
          if (!clicked) continue;
          await page.waitForTimeout(800);
          await applyForcedTheme(page, opts.forceTheme);
          if (normalizePageUrl(page.url(), origin) !== normalizePageUrl(url, origin)) continue;
          const rawSnapshot = await page.evaluate(
            `(${genericOverlayCaptureScript})(${JSON.stringify({ before, origin }).replace(/</g, '\\u003c')})`,
          );
          const snapshotRecord =
            rawSnapshot && typeof rawSnapshot === 'object'
              ? (rawSnapshot as { html?: unknown; styles?: unknown; backdrop?: unknown; title?: unknown })
              : undefined;
          const html = typeof snapshotRecord?.html === 'string' ? snapshotRecord.html : '';
          if (!html) continue;
          snapshots[candidate.key] = {
            html,
            styles: typeof snapshotRecord?.styles === 'string' ? snapshotRecord.styles : undefined,
            title: typeof snapshotRecord?.title === 'string' ? snapshotRecord.title : candidate.label,
            key: candidate.key,
            kind: 'overlay',
            backdrop: typeof snapshotRecord?.backdrop === 'boolean' ? snapshotRecord.backdrop : false,
          };
          captured += 1;
          if (captured >= maxSnapshots) continue;

          const nestedCandidates = await page.evaluate(`(${genericNestedInteractionCandidatesScript})()`);
          for (const nestedCandidate of (
            nestedCandidates as Array<{ key: string; label: string }>
          ).slice(0, maxNestedSnapshotsPerParent)) {
            if (captured >= maxSnapshots) break;
            if (!nestedCandidate.key) continue;
            const nestedKey = `${candidate.key}>>${nestedCandidate.key}`;
            if (snapshots[nestedKey]) continue;
            try {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 });
              await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => undefined);
              await applyForcedTheme(page, opts.forceTheme);
              await page.waitForTimeout(400);
              const nestedBefore = await page.evaluate(genericOverlaySignatureScript);
              const parentClicked = await page.evaluate(`(${genericClickScript})(${JSON.stringify(candidate.key)})`);
              if (!parentClicked) continue;
              await page.waitForTimeout(500);
              await applyForcedTheme(page, opts.forceTheme);
              const childClicked = await page.evaluate(`(${genericNestedClickScript})(${JSON.stringify(nestedCandidate.key)})`);
              if (!childClicked) continue;
              await page.waitForTimeout(700);
              await applyForcedTheme(page, opts.forceTheme);
              if (normalizePageUrl(page.url(), origin) !== normalizePageUrl(url, origin)) continue;
              const rawNestedSnapshot = await page.evaluate(
                `(${genericOverlayCaptureScript})(${JSON.stringify({ before: nestedBefore, origin }).replace(/</g, '\\u003c')})`,
              );
              const nestedSnapshotRecord =
                rawNestedSnapshot && typeof rawNestedSnapshot === 'object'
                  ? (rawNestedSnapshot as { html?: unknown; styles?: unknown; backdrop?: unknown; title?: unknown })
                  : undefined;
              const nestedHtml = typeof nestedSnapshotRecord?.html === 'string' ? nestedSnapshotRecord.html : '';
              if (!nestedHtml) continue;
              snapshots[nestedKey] = {
                html: nestedHtml,
                styles: typeof nestedSnapshotRecord?.styles === 'string' ? nestedSnapshotRecord.styles : undefined,
                title: typeof nestedSnapshotRecord?.title === 'string' ? nestedSnapshotRecord.title : nestedCandidate.label,
                key: nestedKey,
                kind: 'overlay',
                backdrop: typeof nestedSnapshotRecord?.backdrop === 'boolean' ? nestedSnapshotRecord.backdrop : false,
              };
              captured += 1;
            } catch (err) {
              logger.debug({ url, key: nestedKey, err: (err as Error).message }, 'nested-interaction-snapshot-failed');
            }
          }
        } catch (err) {
          logger.debug({ url, key: candidate.key, err: (err as Error).message }, 'generic-interaction-snapshot-failed');
        }
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'generic-interaction-snapshot-capture-skipped');
  } finally {
    await page.close().catch(() => undefined);
  }

  logger.info({ count: captured }, 'generic-interaction-snapshots-captured');
}

const genericOverlaySignatureScript = `(() => {
  const selector = '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],.lux-menu,.lux-modal,.modal,.drawer,.popover,.dropdown,[class*="menu"],[class*="popover"],[class*="modal"],[class*="drawer"],[class*="dropdown"]';
  function visible(el){
    if (el === document.body || el === document.documentElement || el.id === '__next') return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 16 && r.height > 16 && cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function sig(el){
    const r = el.getBoundingClientRect();
    return [(el.tagName||'').toLowerCase(), String(el.className||''), (el.getAttribute('role')||''), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), (el.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120)].join('|');
  }
  return Array.from(document.querySelectorAll(selector)).filter(visible).map(sig);
})()`;

const genericClickScript = `(key) => {
  const selector = 'button,[role="button"],[aria-haspopup],[aria-expanded],.lux-menu-trigger-wrapper,.avatar-wrapper.cursor-pointer,.top-nav-button';
  function textOf(el){return (el && el.textContent || '').replace(/\\s+/g,' ').trim();}
  function visible(el){
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
  }
  function isNavigation(el){
    const anchor = el.closest && el.closest('a[href]');
    if (!anchor) return false;
    const href = anchor.getAttribute('href') || '';
    if (!href || href === '#' || href.indexOf('javascript:') === 0) return false;
    return !el.hasAttribute('aria-haspopup') && !el.hasAttribute('aria-expanded');
  }
  function baseKey(el){
    const tag = (el.tagName || '').toLowerCase();
    const role = el.getAttribute('role') || '';
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).slice(0,80);
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean).filter((part) => part.indexOf('jsx-') !== 0).slice(0,8).join('.');
    return ['ik', tag, role, label, cls].join('|');
  }
  function interactionKey(el, controls){
    const base = baseKey(el);
    let index = 0;
    for (const other of controls) {
      if (other === el) break;
      if (baseKey(other) === base) index += 1;
    }
    return base + '#' + index;
  }
  const controls = Array.from(document.querySelectorAll(selector)).filter((el) => {
    if (!visible(el)) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    if (el.closest('.content-card,.event-row')?.querySelector('a.event-link[href]')) return false;
    if (isNavigation(el)) return false;
    const label = (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).trim();
    const cls = String(el.className || '');
    if (!label && !/avatar|menu|search|bell|profile|trigger|popover/i.test(cls)) return false;
    if (/^(events|discover|calendars|create event|event page|view all)$/i.test(label)) return false;
    return true;
  });
  const el = controls.find((control) => interactionKey(control, controls) === key);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  el.click();
  return true;
}`;

const genericNestedInteractionCandidatesScript = `() => {
  const overlaySelector = '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],.lux-menu,.lux-modal,.modal,.drawer,.popover,.dropdown,[class*="menu"],[class*="popover"],[class*="modal"],[class*="drawer"],[class*="dropdown"]';
  const controlSelector = 'button,a[href],[role="button"],[aria-haspopup],[aria-expanded],.lux-menu-trigger-wrapper,.avatar-wrapper.cursor-pointer,.top-nav-button';
  function textOf(el){return (el && el.textContent || '').replace(/\\s+/g,' ').trim();}
  function visible(el){
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
  }
  function overlayVisible(el){
    if (el === document.body || el === document.documentElement || el.id === '__next') return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 16 && r.height > 16 && cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function score(el){
    const r = el.getBoundingClientRect();
    const cls = String(el.className || '');
    const role = el.getAttribute('role') || '';
    let value = Math.min(r.width * r.height, 600000);
    if (/dialog|modal|drawer|panel/i.test(cls) || role === 'dialog' || el.getAttribute('aria-modal') === 'true') value += 1000000;
    if (/menu|popover|dropdown|listbox/i.test(cls) || role === 'menu' || role === 'listbox') value += 500000;
    return value;
  }
  function labelOf(el){return (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).trim();}
  function isAllowed(el){
    if (!visible(el)) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const label = labelOf(el);
    if (/^(close|copy link|event page|join waitlist|register|one-click rsvp|accept invite|decline|subscribe|subscribed|add to calendar|add to wallet|my ticket|sign out|update profile|save|delete|remove|cancel|submit|create|contact the host|report event)$/i.test(label)) return false;
    const anchor = el.closest && el.closest('a[href]');
    if (anchor && !el.hasAttribute('aria-haspopup') && !el.hasAttribute('aria-expanded')) return false;
    if (el.closest('.content-card,.event-row')?.querySelector('a.event-link[href]')) return false;
    if (!label && !/avatar|menu|search|bell|profile|trigger|popover|dropdown|more|filter|sort/i.test(String(el.className || ''))) return false;
    return true;
  }
  function baseKey(el){
    const tag = (el.tagName || '').toLowerCase();
    const role = el.getAttribute('role') || '';
    const label = labelOf(el).slice(0,80);
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean).filter((part) => part.indexOf('jsx-') !== 0).slice(0,8).join('.');
    return ['ik', tag, role, label, cls].join('|');
  }
  function interactionKey(el, controls){
    const base = baseKey(el);
    let index = 0;
    for (const other of controls) {
      if (other === el) break;
      if (baseKey(other) === base) index += 1;
    }
    return base + '#' + index;
  }
  const overlay = Array.from(document.querySelectorAll(overlaySelector))
    .filter(overlayVisible)
    .filter((el) => !/(^|\\s)(page-wrapper|page-content|theme-root)(\\s|$)/i.test(String(el.className || '')))
    .sort((a, b) => score(b) - score(a))[0];
  if (!overlay) return [];
  const controls = Array.from(overlay.querySelectorAll(controlSelector)).filter(isAllowed);
  const seen = new Set();
  return controls.map((el) => ({ key: interactionKey(el, controls), label: labelOf(el).slice(0,80) })).filter((item) => {
    if (seen.has(item.key)) return false;
    seen.add(item.key);
    return true;
  }).slice(0, 6);
}`;

const genericNestedClickScript = `(key) => {
  const overlaySelector = '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],.lux-menu,.lux-modal,.modal,.drawer,.popover,.dropdown,[class*="menu"],[class*="popover"],[class*="modal"],[class*="drawer"],[class*="dropdown"]';
  const controlSelector = 'button,a[href],[role="button"],[aria-haspopup],[aria-expanded],.lux-menu-trigger-wrapper,.avatar-wrapper.cursor-pointer,.top-nav-button';
  function textOf(el){return (el && el.textContent || '').replace(/\\s+/g,' ').trim();}
  function visible(el){
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 8 && r.height > 8 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.pointerEvents !== 'none';
  }
  function overlayVisible(el){
    if (el === document.body || el === document.documentElement || el.id === '__next') return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 16 && r.height > 16 && cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function score(el){
    const r = el.getBoundingClientRect();
    const cls = String(el.className || '');
    const role = el.getAttribute('role') || '';
    let value = Math.min(r.width * r.height, 600000);
    if (/dialog|modal|drawer|panel/i.test(cls) || role === 'dialog' || el.getAttribute('aria-modal') === 'true') value += 1000000;
    if (/menu|popover|dropdown|listbox/i.test(cls) || role === 'menu' || role === 'listbox') value += 500000;
    return value;
  }
  function labelOf(el){return (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el)).trim();}
  function isAllowed(el){
    if (!visible(el)) return false;
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
    const label = labelOf(el);
    if (/^(close|copy link|event page|join waitlist|register|one-click rsvp|accept invite|decline|subscribe|subscribed|add to calendar|add to wallet|my ticket|sign out|update profile|save|delete|remove|cancel|submit|create|contact the host|report event)$/i.test(label)) return false;
    const anchor = el.closest && el.closest('a[href]');
    if (anchor && !el.hasAttribute('aria-haspopup') && !el.hasAttribute('aria-expanded')) return false;
    if (el.closest('.content-card,.event-row')?.querySelector('a.event-link[href]')) return false;
    if (!label && !/avatar|menu|search|bell|profile|trigger|popover|dropdown|more|filter|sort/i.test(String(el.className || ''))) return false;
    return true;
  }
  function baseKey(el){
    const tag = (el.tagName || '').toLowerCase();
    const role = el.getAttribute('role') || '';
    const label = labelOf(el).slice(0,80);
    const cls = String(el.className || '').split(/\\s+/).filter(Boolean).filter((part) => part.indexOf('jsx-') !== 0).slice(0,8).join('.');
    return ['ik', tag, role, label, cls].join('|');
  }
  function interactionKey(el, controls){
    const base = baseKey(el);
    let index = 0;
    for (const other of controls) {
      if (other === el) break;
      if (baseKey(other) === base) index += 1;
    }
    return base + '#' + index;
  }
  const overlay = Array.from(document.querySelectorAll(overlaySelector))
    .filter(overlayVisible)
    .filter((el) => !/(^|\\s)(page-wrapper|page-content|theme-root)(\\s|$)/i.test(String(el.className || '')))
    .sort((a, b) => score(b) - score(a))[0];
  if (!overlay) return false;
  const controls = Array.from(overlay.querySelectorAll(controlSelector)).filter(isAllowed);
  const el = controls.find((control) => interactionKey(control, controls) === key);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
  el.click();
  return true;
}`;

const genericOverlayCaptureScript = `({ before, origin }) => {
  const beforeSet = new Set(before || []);
  const selector = '[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-radix-popper-content-wrapper],.lux-menu,.lux-modal,.modal,.drawer,.popover,.dropdown,[class*="menu"],[class*="popover"],[class*="modal"],[class*="drawer"],[class*="dropdown"]';
  function textOf(el){return (el && el.textContent || '').replace(/\\s+/g,' ').trim();}
  function visible(el){
    if (el === document.body || el === document.documentElement || el.id === '__next') return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 16 && r.height > 16 && cs.display !== 'none' && cs.visibility !== 'hidden';
  }
  function sig(el){
    const r = el.getBoundingClientRect();
    return [(el.tagName||'').toLowerCase(), String(el.className||''), (el.getAttribute('role')||''), Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height), textOf(el).slice(0,120)].join('|');
  }
  function score(el){
    const r = el.getBoundingClientRect();
    const cls = String(el.className || '');
    const role = el.getAttribute('role') || '';
    let value = Math.min(r.width * r.height, 600000);
    if (/dialog|modal|drawer|panel/i.test(cls) || role === 'dialog' || el.getAttribute('aria-modal') === 'true') value += 1000000;
    if (/menu|popover|dropdown|listbox/i.test(cls) || role === 'menu' || role === 'listbox') value += 500000;
    return value;
  }
  function localPathForUrl(url) {
    const parts = url.pathname.split('/').filter(Boolean).map((part) => encodeURIComponent(decodeURIComponent(part)));
    return parts.length === 0 ? '/index.html' : '/' + parts.join('/') + '/index.html';
  }
  function sanitizeClone(clone) {
    clone.setAttribute('data-static-captured-overlay', '1');
    clone.querySelectorAll('script,iframe,noscript').forEach((node) => node.remove());
    clone.querySelectorAll('input,textarea').forEach((node) => {
      node.removeAttribute('value');
      node.textContent = '';
    });
    clone.querySelectorAll('[class*="guests-string"]').forEach((node) => {
      const count = (node.textContent || '').match(/(\\d[\\d,.]*)\\s+others/i)?.[1];
      node.textContent = count ? count + ' attendees' : 'Attendees';
    });
    const textWalker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    let textNode;
    while ((textNode = textWalker.nextNode())) {
      textNode.nodeValue = (textNode.nodeValue || '').replace(/\\bWelcome,\\s+[^!?.]+([!?.])/gi, 'Welcome$1');
    }
    const cloneText = textOf(clone).toLowerCase();
    if (cloneText.includes('view profile') && cloneText.includes('sign out')) {
      clone.querySelectorAll('a[href]').forEach((anchor) => {
        const raw = anchor.getAttribute('href') || '';
        if (/\\/user\\//i.test(raw)) anchor.setAttribute('href', '/settings');
      });
      clone.querySelectorAll('[style*="background-image"]').forEach((node) => node.removeAttribute('style'));
      clone.querySelectorAll('*').forEach((node) => {
        const text = textOf(node);
        if (!text || /^(View Profile|Settings|Sign Out)$/i.test(text)) return;
        const cls = String(node.className || '');
        if ((' ' + cls + ' ').toLowerCase().includes(' name ')) node.textContent = 'Account';
        if (/^@[\\w.-]+$/.test(text)) node.textContent = '@user';
      });
    }
    const sensitiveRe = /([A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}|luma\\.auth-session-key|__cf_bm|token|secret|password|session)/i;
    Array.from(clone.querySelectorAll('*')).reverse().forEach((node) => {
      const text = node.textContent || '';
      if (!sensitiveRe.test(text)) return;
      let target = node;
      for (let i = 0; i < 3 && target.parentElement && target.parentElement !== clone; i += 1) {
        const parentText = target.parentElement.textContent || '';
        if (parentText.length > text.length + 220) break;
        target = target.parentElement;
      }
      target.remove();
    });
    clone.querySelectorAll('a[href]').forEach((anchor) => {
      const raw = anchor.getAttribute('href');
      if (!raw) return;
      try {
        const parsed = new URL(raw, origin);
        if (parsed.origin === origin) anchor.setAttribute('href', localPathForUrl(parsed));
        else anchor.setAttribute('target', '_blank');
      } catch (_) {}
    });
  }
  function collectStyles() {
    const seenCss = new Set();
    const cssChunks = [];
    function addCss(css) {
      const text = String(css || '').trim();
      if (!text || seenCss.has(text)) return;
      seenCss.add(text);
      cssChunks.push(text);
    }
    Array.from(document.styleSheets).forEach((sheet) => {
      try {
        if (!sheet.cssRules) return;
        addCss(Array.from(sheet.cssRules).map((rule) => rule.cssText).join('\\n'));
      } catch (_) {}
    });
    Array.from(document.querySelectorAll('style')).forEach((style) => addCss(style.textContent || ''));
    return cssChunks.join('\\n');
  }
  const overlays = Array.from(document.querySelectorAll(selector))
    .filter(visible)
    .filter((el) => !/(^|\\s)(page-wrapper|page-content|theme-root)(\\s|$)/i.test(String(el.className || '')))
    .filter((el) => !beforeSet.has(sig(el)))
    .sort((a, b) => score(b) - score(a));
  const overlay = overlays[0];
  if (!overlay) return null;
  const clone = overlay.cloneNode(true);
  sanitizeClone(clone);
  const cls = String(overlay.className || '');
  const role = overlay.getAttribute('role') || '';
  const backdrop = /dialog|modal|drawer|panel/i.test(cls) || role === 'dialog' || overlay.getAttribute('aria-modal') === 'true';
  return { html: clone.outerHTML, styles: collectStyles(), backdrop, title: overlay.getAttribute('aria-label') || textOf(clone).slice(0,80) };
}`;

async function writeAssets(
  outDir: string,
  store: AssetStore,
  rewrite: boolean,
  _hosts: Set<string>,
  jsReplacements: ReturnType<typeof buildJsReplacements> = [],
): Promise<void> {
  const assetLookup = (originalUrl: string): string | undefined => {
    const rec = store.lookup(originalUrl);
    return rec?.rootRelativePath;
  };

  for (const rec of store.all()) {
    if (!rewrite || rec.localPath.endsWith('.framercms') || !isTextual(rec.contentType)) {
      await writeFileEnsured(outDir, rec.localPath, rec.body);
      continue;
    }

    let text = rec.body.toString('utf8');
    const lower = (rec.contentType.split(';')[0] ?? '').toLowerCase();

    if (lower === 'text/css') {
      text = await rewriteCss(text, { baseUrl: rec.url, lookup: assetLookup });
    } else if (
      lower === 'application/javascript' ||
      lower === 'text/javascript' ||
      rec.localPath.endsWith('.js') ||
      rec.localPath.endsWith('.mjs')
    ) {
      text = rewriteJs(text, { replacements: jsReplacements });
    } else if (lower === 'image/svg+xml') {
      // SVG can have <style> with url() and href references — treat like CSS for url() at minimum
      text = await rewriteCss(text, { baseUrl: rec.url, lookup: assetLookup });
    }
    // JSON / plain text: leave alone

    await writeFileEnsured(outDir, rec.localPath, text);
  }
}

interface SingleHtmlOptions {
  liveUrl: string;
  localizeAssets: boolean;
  canonicalUrl?: string;
  stripSelectors?: string[];
  subscribeRedirect?: { url: string; text?: string };
  stayLocal?: boolean;
  multiPage?: boolean;
  interactionSnapshots?: Record<string, StaticInteractionSnapshot>;
  pageStyles?: Map<string, string>;
  forceTheme?: ForcedTheme;
}

export async function prepareSingleHtml(
  pages: Map<string, string>,
  origin: string,
  store: AssetStore,
  opts: SingleHtmlOptions,
): Promise<{ url: string; html: string }> {
  const selected = selectPrimaryPage(pages, opts.liveUrl);
  if (!selected) throw new Error('No captured page HTML to write');
  const [url, html] = selected;
  const pageUrls = new Set([url]);
  if (opts.multiPage) {
    for (const pageUrl of pages.keys()) pageUrls.add(pageUrl);
  }
  const pagePathLookup = buildPagePathLookup(pageUrls, opts.multiPage);
  const runtimePageMap = buildRuntimePageMap(pageUrls, opts.multiPage);
  const runtimeEventPreviewMap = buildRuntimeEventPreviewMap(pages);
  return prepareHtmlPage(url, html, origin, store, opts, pagePathLookup, runtimePageMap, runtimeEventPreviewMap);
}

async function prepareHtmlPage(
  url: string,
  html: string,
  origin: string,
  store: AssetStore,
  opts: SingleHtmlOptions,
  pagePathLookup: Map<string, string>,
  runtimePageMap: Record<string, string>,
  runtimeEventPreviewMap: Record<string, StaticEventPreview>,
): Promise<{ url: string; html: string }> {
  const isFramerDocument = detectFramerDocument(html);

  const assetLookup = (originalUrl: string): string | undefined => {
    if (!opts.localizeAssets) return undefined;
    const rec = store.lookup(originalUrl);
    return rec?.rootRelativePath;
  };
  const assetFallback = (absoluteUrl: string): string | undefined => {
    if (opts.localizeAssets || isFramerDocument) return undefined;
    return sameOrigin(absoluteUrl, origin) ? absoluteUrl : undefined;
  };

  const pageLookup = (candidateUrl: string): string | undefined => {
    return pagePathLookup.get(candidateUrl);
  };
  const pageFallback = (candidateUrl: string): string | undefined => {
    if (pagePathLookup.has(candidateUrl)) return undefined;
    if (opts.stayLocal) return rootRelativePagePath(candidateUrl);
    return candidateUrl === url ? undefined : candidateUrl;
  };

  const rewritten = await rewriteHtml(html, {
    pageUrl: url,
    siteOrigin: origin,
    assetLookup,
    assetFallback,
    pageLookup,
    pageFallback,
    preserveFramerHydrationTargets: isFramerDocument,
    staticRuntimeFixes: !isFramerDocument,
    runtimePageMap,
    runtimeEventPreviewMap,
    runtimeInteractionSnapshotMap: opts.interactionSnapshots,
    capturedPageCss: isFramerDocument ? undefined : opts.pageStyles?.get(url),
    forceTheme: opts.forceTheme,
    stayLocal: opts.stayLocal,
    canonicalUrl: opts.canonicalUrl,
    stripSelectors: opts.stripSelectors,
    subscribeRedirect: opts.subscribeRedirect,
  });

  return { url, html: rewritten };
}

async function writeSingleHtml(
  outDir: string,
  pages: Map<string, string>,
  origin: string,
  store: AssetStore,
  opts: SingleHtmlOptions,
): Promise<void> {
  const { html } = await prepareSingleHtml(pages, origin, store, opts);
  await writeFileEnsured(outDir, 'index.html', html);
}

async function writeHtmlPages(
  outDir: string,
  pages: Map<string, string>,
  origin: string,
  store: AssetStore,
  opts: SingleHtmlOptions,
): Promise<void> {
  const pagePathLookup = buildPagePathLookup(new Set(pages.keys()), true);
  const runtimePageMap = buildRuntimePageMap(new Set(pages.keys()), true);
  const runtimeEventPreviewMap = buildRuntimeEventPreviewMap(pages);
  for (const [url, html] of pages) {
    const result = await prepareHtmlPage(url, html, origin, store, opts, pagePathLookup, runtimePageMap, runtimeEventPreviewMap);
    await writeFileEnsured(outDir, pageLocalPath(result.url), result.html);
  }

  const selected = selectPrimaryPage(pages, opts.liveUrl);
  if (selected) {
    const [url, html] = selected;
    const result = await prepareHtmlPage(url, html, origin, store, opts, pagePathLookup, runtimePageMap, runtimeEventPreviewMap);
    await writeFileEnsured(outDir, 'index.html', result.html);
  }
}

function buildPagePathLookup(pageUrls: Set<string>, multiPage = false): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const url of pageUrls) {
    lookup.set(url, multiPage ? rootRelativePagePath(url) : './index.html');
  }
  return lookup;
}

function buildRuntimePageMap(pageUrls: Set<string>, multiPage = false): Record<string, string> {
  const map: Record<string, string> = {};
  for (const url of pageUrls) {
    const parsed = new URL(url);
    const pathKey = parsed.pathname.replace(/\/+$/, '') || '/';
    map[pathKey] = multiPage ? rootRelativePagePath(url) : './index.html';
    if (parsed.search) map[pathKey + parsed.search] = map[pathKey];
  }
  return map;
}

function buildRuntimeEventPreviewMap(pages: Map<string, string>): Record<string, StaticEventPreview> {
  const previews: Record<string, StaticEventPreview> = {};
  for (const [url, html] of pages) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 1) continue;
    const slug = parts[0];
    if (!slug) continue;

    const nextData = extractNextData(html);
    if (!nextData) continue;
    const record = findEventRecordBySlug(nextData, slug);
    const preview = record ? eventPreviewFromRecord(record) : undefined;
    if (!preview) continue;

    const localPath = rootRelativePagePath(url);
    previews[localPath] = preview;
    previews[slug] = preview;
  }
  return previews;
}

function extractNextData(html: string): unknown {
  const match = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function findEventRecordBySlug(root: unknown, slug: string): Record<string, unknown> | undefined {
  let found: Record<string, unknown> | undefined;
  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const record = value as Record<string, unknown>;
    const event = record.event;
    if (event && typeof event === 'object' && (event as Record<string, unknown>).url === slug) {
      found = record;
      return;
    }
    for (const item of Object.values(record)) visit(item);
  };
  visit(root);
  return found;
}

function eventPreviewFromRecord(record: Record<string, unknown>): StaticEventPreview | undefined {
  const event = asRecord(record.event);
  if (!event) return undefined;
  const calendar = asRecord(record.calendar) ?? {};
  const featuredCity = asRecord(record.featured_city);
  const location = asRecord(calendar.location) ?? asRecord(calendar.city);
  const city = readString(featuredCity?.name) ?? readString(location?.city);
  const region = readString(location?.region);
  const venueSub = [city, region && region !== city ? region : undefined].filter(Boolean).join(', ');
  const registrationAvailability = readString(record.registration_availability);
  const ticketInfo = asRecord(record.ticket_info);
  const about = richTextToPlainText(record.description_mirror) || richTextToPlainText(event.description_mirror);

  return {
    title: readString(event.name),
    image: readString(event.cover_url) ?? readString(event.social_image_url),
    calendar: readString(calendar.name),
    city,
    venueSub,
    startAt: readString(event.start_at) ?? readString(record.start_at),
    endAt: readString(event.end_at),
    registrationAvailability,
    soldOut: readBoolean(record.sold_out) ?? readBoolean(ticketInfo?.is_sold_out),
    about,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function richTextToPlainText(value: unknown): string {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(richTextToPlainText).filter(Boolean).join('\n\n');
  if (typeof value !== 'object') return '';

  const node = value as Record<string, unknown>;
  if (typeof node.text === 'string') return node.text;
  const content = Array.isArray(node.content) ? node.content : [];
  const parts = content.map(richTextToPlainText).filter(Boolean);
  if (parts.length === 0) return '';
  return node.type === 'paragraph' ? parts.join('') : parts.join('\n\n');
}

function rootRelativePagePath(pageUrl: string): string {
  return '/' + pageLocalPath(pageUrl).replace(/\\/g, '/');
}

function selectPrimaryPage(pages: Map<string, string>, liveUrl: string): [string, string] | undefined {
  if (pages.size === 0) return undefined;
  const normalized = normalizePageUrl(liveUrl);
  if (normalized) {
    const exact = pages.get(normalized);
    if (exact !== undefined) return [normalized, exact];
  }
  return pages.entries().next().value as [string, string] | undefined;
}

function detectFramerDocument(html: string): boolean {
  return (
    html.includes('data-framer-hydrate-v2') ||
    html.includes('data-framer-bundle=') ||
    html.includes('type="framer/appear"')
  );
}

function buildManifest(
  sourceUrl: string,
  origin: string,
  pages: Map<string, string>,
  store: AssetStore,
  opts: { includeAssets?: boolean; multiPage?: boolean } = {},
): Manifest {
  let totalBytes = 0;
  const assetEntries = opts.includeAssets === false ? [] : store.all().map((rec) => {
    totalBytes += rec.body.length;
    return {
      url: rec.url,
      localPath: rootRelativeAssetPath(rec.localPath),
      bytes: rec.body.length,
      contentType: rec.contentType,
    };
  });

  return {
    sourceUrl,
    origin,
    runAt: new Date().toISOString(),
    pages: Array.from(pages.keys()).map((url) => ({
      url,
      localPath: opts.multiPage ? rootRelativePagePath(url) : '/index.html',
    })),
    assets: assetEntries,
    totals: {
      pages: pages.size,
      assets: assetEntries.length,
      assetBytes: totalBytes,
    },
  };
}
