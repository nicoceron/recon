import { describe, expect, it } from 'vitest';
import { rewriteHtml } from './htmlRewriter.js';

const baseCtx = {
  pageUrl: 'https://example.com/',
  siteOrigin: 'https://example.com',
  assetLookup: (u: string): string | undefined => {
    if (u === 'https://cdn.example.com/img.png') return '/assets/cdn.example.com/img.png';
    return undefined;
  },
  pageLookup: (u: string): string | undefined => {
    if (u === 'https://example.com/about') return '/about/';
    return undefined;
  },
};

describe('rewriteHtml — asset URL rewriting', () => {
  it('rewrites <img src> when present in lookup', async () => {
    const html = `<img src="https://cdn.example.com/img.png">`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('src="/assets/cdn.example.com/img.png"');
  });

  it('rewrites srcset preserving descriptors', async () => {
    const html = `<img srcset="https://cdn.example.com/img.png 512w, https://other.com/x.png 1024w">`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('/assets/cdn.example.com/img.png 512w');
  });

  it('rewrites internal anchor hrefs to local page paths', async () => {
    const html = `<a href="https://example.com/about">About</a>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('href="/about/"');
  });

  it('leaves external anchors untouched', async () => {
    const html = `<a href="https://github.com/foo">External</a>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('href="https://github.com/foo"');
  });

  it('injects captured browser CSSOM and rewrites its asset URLs', async () => {
    const html = `<html><head></head><body><div class="hero"></div></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      capturedPageCss: '.hero{background-image:url("https://cdn.example.com/img.png")}',
    });
    expect(out).toContain('data-static-captured-cssom="1"');
    expect(out).toContain('background-image:url("/assets/cdn.example.com/img.png")');
  });
});

describe('rewriteHtml — Framer owner-UI stripping', () => {
  it('removes editor-bar shell elements', async () => {
    const html = `
      <html><body>
        <div id="__framer-editorbar-container"><button id="__framer-editorbar-button">edit</button></div>
        <span id="__framer-editorbar-label">Edit Framer Content</span>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('__framer-editorbar-container');
    expect(out).not.toContain('__framer-editorbar-button');
    expect(out).not.toContain('__framer-editorbar-label');
    expect(out).toContain('real content');
  });

  it('removes the "Made in Framer" badge', async () => {
    const html = `
      <html><body>
        <div id="__framer-badge-container">
          <a class="__framer-badge" href="https://www.framer.com">Made in Framer</a>
        </div>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('__framer-badge-container');
    expect(out).not.toContain('__framer-badge');
    expect(out).not.toContain('Made in Framer');
    expect(out).toContain('real content');
  });

  it('keeps and hides the Framer badge container when it is a hydration target', async () => {
    const html = `
      <html><head></head><body>
        <div id="__framer-badge-container">
          <a class="__framer-badge" href="https://www.framer.com">Made in Framer</a>
        </div>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, preserveFramerHydrationTargets: true });
    expect(out).toContain('__framer-badge-container');
    expect(out).toContain('__framer-badge');
    expect(out).toContain('#__framer-badge-container{display:none!important}');
    expect(out).toContain('real content');
  });

  it('removes inline scripts that bootstrap the editor bar', async () => {
    const html = `
      <html><body>
        <script>localStorage.setItem("__framer_force_showing_editorbar_since", "1")</script>
        <p>real content</p>
      </body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('__framer_force_showing_editorbar');
  });
});

describe('rewriteHtml — canonical URL override', () => {
  it('rewrites <link rel=canonical> when canonicalUrl is set', async () => {
    const html = `<link rel="canonical" href="https://old-site.framer.app/">`;
    const out = await rewriteHtml(html, { ...baseCtx, canonicalUrl: 'https://new-site.com/' });
    expect(out).toContain('href="https://new-site.com/"');
    expect(out).not.toContain('old-site.framer.app');
  });

  it('rewrites og:url + twitter:url', async () => {
    const html = `
      <meta property="og:url" content="https://old.framer.app/">
      <meta name="twitter:url" content="https://old.framer.app/">`;
    const out = await rewriteHtml(html, { ...baseCtx, canonicalUrl: 'https://new.com/' });
    expect(out).toContain('property="og:url" content="https://new.com/"');
    expect(out).toContain('name="twitter:url" content="https://new.com/"');
  });

  it('does NOT modify metadata when canonicalUrl is undefined', async () => {
    const html = `<link rel="canonical" href="https://orig.com/">`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).toContain('href="https://orig.com/"');
  });
});

describe('rewriteHtml — strip selectors', () => {
  // Important: text assertions are scoped to the document body — the injected
  // runtime stripper <script> echoes the selector strings (incl. literal text
  // for `:contains()`), so a naive substring check on `out` would false-positive.
  const bodyTextOf = async (html: string): Promise<string> => {
    const cheerio = await import('cheerio');
    const $ = cheerio.load(html);
    $('script').remove();
    return $('body').text();
  };

  it('removes matching elements from the SSR DOM', async () => {
    const html = `
      <html><body>
        <form><input value="Subscribe"></form>
        <p>Be the first to know about launches</p>
        <p>Keep me</p>
      </body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      stripSelectors: ['form:has(input[value="Subscribe"])', 'p:contains("Be the first")'],
    });
    const visibleText = await bodyTextOf(out);
    expect(visibleText).not.toMatch(/Subscribe/);
    expect(visibleText).not.toMatch(/Be the first/);
    expect(visibleText).toMatch(/Keep me/);
  });

  it('injects an anonymous runtime MutationObserver stripper for post-hydration coverage', async () => {
    const html = `<html><body><form><input value="Subscribe"></form></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      stripSelectors: ['form:has(input[value="Subscribe"])'],
    });
    // Anonymous (no identifying attribute) so it doesn't leak an exporter dependency
    expect(out).not.toContain('framer-html-exporter');
    expect(out).toContain('MutationObserver');
    // selector list is JSON-encoded inside the script
    expect(out).toContain('form:has(input[value=\\"Subscribe\\"])');
  });

  it('omits the runtime stripper entirely when no selectors are supplied', async () => {
    const html = `<html><body><p>x</p></body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('MutationObserver');
  });

  it('silently ignores invalid selectors instead of aborting', async () => {
    const html = `<p>content</p>`;
    const out = await rewriteHtml(html, { ...baseCtx, stripSelectors: ['!@#$%^'] });
    const visibleText = await bodyTextOf(out);
    expect(visibleText).toContain('content');
  });
});

describe('rewriteHtml — subscribeRedirect', () => {
  it('injects a MutationObserver redirector script with the given url and text', async () => {
    const html = `<html><body><form><input value="Subscribe"><button type="submit">Go</button></form></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      subscribeRedirect: { url: 'https://example.com', text: 'Try Now' },
    });
    expect(out).toContain('MutationObserver');
    expect(out).toContain('"https://example.com"');
    expect(out).toContain('"Try Now"');
    expect(out).toContain('data-sub-link');
    expect(out).toContain("a.target='_blank'");
  });

  it('defaults text to "Subscribe" when text is omitted', async () => {
    const html = `<html><body></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      subscribeRedirect: { url: 'https://example.com' },
    });
    expect(out).toContain('"Subscribe"');
  });

  it('does not inject the redirector when subscribeRedirect is unset', async () => {
    const html = `<html><body><form><input value="Subscribe"></form></body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('data-sub-link');
  });
});

describe('rewriteHtml — static runtime fixes', () => {
  it('injects reveal and scrollspy recovery only when requested', async () => {
    const html = `<html><body><div data-motion-reveal-target>Reveal me</div><div data-motion-reveal-item>Item</div></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('data-motion-reveal-target');
    expect(out).toContain('data-motion-reveal-item');
    expect(out).toContain('IntersectionObserver');
    expect(out).toContain('candidateAnchorGroups');
  });

  it('installs a preflight loader for hotlinked Next/Turbopack captures', async () => {
    const html = `<html><head><script src="/_next/static/chunks/app.js"></script></head><body></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('__turbopack_load_page_chunks__');
    expect(out).toContain('window.google.maps.__ib__');
    expect(out.indexOf('__turbopack_load_page_chunks__')).toBeLessThan(out.indexOf('/_next/static/chunks/app.js'));
  });

  it('locks captured themes before local app boot scripts can follow system preference', async () => {
    const html = `<html class="theme-root dark"><head></head><body><script>
      (function() {
        function setTheme(newTheme) { window.__theme = newTheme; }
        var preferredTheme = "system";
        setTheme(preferredTheme);
      })();
    </script></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('data-static-theme-lock="1"');
    expect(out).toContain('class="theme-root dark"');
    expect(out).toContain('var preferredTheme = "dark";');
    expect(out).not.toContain('var preferredTheme = "system";');
  });

  it('lets forceTheme override the captured document theme', async () => {
    const html = `<html class="theme-root light"><head></head><body></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true, forceTheme: 'dark' });
    expect(out).toContain('class="theme-root dark"');
    expect(out).toContain('window.__theme=t');
  });

  it('adds static button shims when runtime page routes are available', async () => {
    const html = `<html><body><button class="search-button" type="button"></button></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      runtimePageMap: { '/home': './home/index.html', '/discover': './discover/index.html' },
    });
    expect(out).toContain('__STATIC_EXPORT_PAGE_MAP');
    expect(out).toContain('actionFallback');
    expect(out).toContain('scheduleFallback');
    expect(out).toContain('bootStaticInteractions');
    expect(out).toContain('bootHoverAnimations');
  });

  it('installs captured map restoration for exported Google Maps iframes', async () => {
    const html = `<html><body><img data-static-captured-map="1" data-static-map-src="https://www.google.com/maps/embed/v1/place?q=x" src="data:image/png;base64,abc"></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('bootCapturedMaps');
    expect(out).toContain('__STATIC_EXPORT_MAP_IMAGES');
    expect(out).toContain('iframe[src*="google.com/maps/embed"]');
  });

  it('removes authenticated private email rows from static app captures', async () => {
    const html = `<html><body><section><div class="attendee"><span>Nicolas Ceron</span><span>nicolas@example.com</span></div><p>Keep public event copy</p></section></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).not.toContain('nicolas@example.com');
    expect(out).not.toContain('Nicolas Ceron');
    expect(out).toContain('Keep public event copy');
  });

  it('redacts profile/account settings form values in static app captures', async () => {
    const html = `<html><body>
      <main>
        <h1>Settings</h1>
        <h2>Your Profile</h2>
        <label>First Name<input value="Nicolas"></label>
        <label>Last Name<input value="Ceron"></label>
        <label>Username<input value="ceron"></label>
        <label>Website<input value="https://nicoceron.com"></label>
        <label>Bio<textarea>private bio</textarea></label>
        <section><h2>Phone Number</h2><div>+1 415 212 6297</div></section>
        <div inert class="full-name-note">Your full name is set as “<span>Nicolas Ceron</span>”</div>
        <div class="avatar-wrapper" style="background-image:url(https://example.com/avatar.png)"><img src="https://example.com/avatar.png"></div>
      </main>
    </body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      pageUrl: 'https://example.com/settings',
      staticRuntimeFixes: true,
    });
    expect(out).not.toContain('Nicolas');
    expect(out).not.toContain('Ceron');
    expect(out).not.toContain('ceron');
    expect(out).not.toContain('private bio');
    expect(out).not.toContain('+1 415 212 6297');
    expect(out).not.toContain('background-image:url');
    expect(out).toContain('Phone configured');
  });

  it('emits the interaction key class splitter with an escaped whitespace regex', async () => {
    const html = `<html><body><button class="search-button" type="button"></button></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      runtimePageMap: { '/home': './home/index.html' },
    });
    expect(out).toContain('split(/\\s+/)');
    expect(out).not.toContain('split(/s+/)');
  });

  it('sets the source origin for static button shims even without captured routes', async () => {
    const html = `<html><body><button class="search-button" type="button"></button></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).toContain('__STATIC_EXPORT_SITE_ORIGIN');
    expect(out).toContain('https://example.com');
    expect(out).toContain('forceLiveNavigation');
  });

  it('recognizes already-local stay-local hrefs to avoid rewrite loops', async () => {
    const html = `<html><body><a href="/discover/index.html">Discover</a></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true, stayLocal: true });
    expect(out).toContain('href="/discover/index.html"');
    expect(out).toContain('isLocalExportPath');
  });

  it('forces local static page links through document navigation', async () => {
    const html = `<html><body><a href="https://example.com/discover">Discover</a></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      stayLocal: true,
      runtimePageMap: { '/discover': '/discover/index.html' },
      pageLookup: () => '/discover/index.html',
    });
    expect(out).toContain('target=localTarget(raw)|| (stayLocal?localPathForUrl(u):u.href)');
    expect(out).toContain('location.href=target');
    expect(out).not.toContain('if(localTarget(raw))return');
  });

  it('injects local route interception for Framer multi-page exports without static shims', async () => {
    const html = `<html><head><script data-framer-bundle="main" src="/assets/main.mjs"></script></head><body><a href="https://example.com/discover">Discover</a></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: false,
      stayLocal: true,
      runtimePageMap: { '/discover': '/discover/index.html' },
      pageLookup: () => '/discover/index.html',
    });
    expect(out).toContain('__STATIC_EXPORT_PAGE_MAP');
    expect(out).toContain('releaseStaticPreloaders');
    expect(out).toContain('currentMatchesKnownLocalPath');
    expect(out).toContain("document.querySelector('[data-framer-hydrate-v2],[data-framer-root]')");
    expect(out).toContain('new MutationObserver(maintainStaticExport)');
    expect(out).not.toContain('bootStaticInteractions');
    expect(out.indexOf('__STATIC_EXPORT_PAGE_MAP')).toBeLessThan(out.indexOf('data-framer-bundle="main"'));
  });

  it('allows local event-link anchors to open previews even without a wrapper control', async () => {
    const html = `<html><body><a class="event-link content-link" href="/event/index.html">Event</a></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      stayLocal: true,
      runtimeInteractionSnapshotMap: {
        '/event/index.html': { html: '<aside data-static-captured-luma-panel="1">Event panel</aside>', kind: 'event-panel' },
      },
    });
    expect(out).toContain('if(!stayLocal||!anchor)return false');
    expect(out).toContain('openStaticCardPreview(anchorControl||directAnchor,directAnchor)');
  });

  it('animates captured overlays and supports nested interaction snapshots', async () => {
    const parentKey = 'ik|button||Menu|menu-button#0';
    const childKey = `${parentKey}>>ik|button||More|more-button#0`;
    const html = `<html><body><button class="menu-button" type="button">Menu</button></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      runtimeInteractionSnapshotMap: {
        [parentKey]: { html: '<div role="menu"><button class="more-button" type="button">More</button></div>', key: parentKey, kind: 'overlay' },
        [childKey]: { html: '<div role="menu">More menu</div>', key: childKey, kind: 'overlay' },
      },
    });
    expect(out).toContain('[data-static-generic-snapshot][data-static-open]');
    expect(out).toContain('[data-static-modal-backdrop][data-static-open]');
    expect(out).toContain('function nestedInteractionKey');
    expect(out).toContain("parentKey+'>>'+base+'#'+index");
    expect(out).toContain('openStaticInteractionSnapshotRecord(nestedSnapshot)');
  });

  it('sanitizes embedded Next user data in static captures', async () => {
    const html = `<html><body><script id="__NEXT_DATA__" type="application/json">{"props":{"initialUserData":{"user":{"email":"person@example.com","centrifugo_user_token":"jwt","api_id":"usr_1","name":"Person"}},"pageProps":{}},"page":"/home"}</script></body></html>`;
    const out = await rewriteHtml(html, { ...baseCtx, staticRuntimeFixes: true });
    expect(out).not.toContain('person@example.com');
    expect(out).not.toContain('centrifugo_user_token');
    expect(out).not.toContain('usr_1');
    expect(out).toContain('"page":"/home"');
  });

  it('emits syntactically valid static runtime scripts', async () => {
    const html = `<html><body><button class="search-button" type="button"></button></body></html>`;
    const out = await rewriteHtml(html, {
      ...baseCtx,
      staticRuntimeFixes: true,
      runtimePageMap: { '/home': './home/index.html' },
    });
    const cheerio = await import('cheerio');
    const $ = cheerio.load(out);
    const scripts = $('script')
      .toArray()
      .map((node) => $(node).html() ?? '')
      .filter((script) => script.includes('bootStaticInteractions') || script.includes('__STATIC_EXPORT_PAGE_MAP'));

    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('does not inject static runtime fixes by default', async () => {
    const html = `<html><body><div data-motion-reveal-target>Reveal me</div></body></html>`;
    const out = await rewriteHtml(html, baseCtx);
    expect(out).not.toContain('candidateAnchorGroups');
    expect(out).not.toContain('__turbopack_load_page_chunks__');
  });
});
