import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { crawlOnePage, isIncompleteWaybackCapture, scrollPage } from './crawler.js';

const waybackUrl = 'https://web.archive.org/web/20260804095252/https://factory.ai/';

describe('isIncompleteWaybackCapture', () => {
  it('rejects a Wayback client-side application error', () => {
    expect(isIncompleteWaybackCapture(
      waybackUrl,
      '<html><body><h2>Application error: a client-side exception has occurred</h2></body></html>',
    )).toBe(true);
  });

  it('rejects unresolved client-only module placeholders', () => {
    expect(isIncompleteWaybackCapture(
      waybackUrl,
      '<html><body><main><div id="module-platform"><div style="min-height:900px"></div></div></main></body></html>',
    )).toBe(true);
  });

  it('rejects unresolved placeholders in later virtualized modules', () => {
    expect(isIncompleteWaybackCapture(
      waybackUrl,
      '<html><body><main><div id="module-platform"><h2>Loaded</h2></div><div id="module-droid-computers"><div style="min-height:900px"></div></div></main></body></html>',
    )).toBe(true);
  });

  it('accepts a hydrated module capture', () => {
    expect(isIncompleteWaybackCapture(
      waybackUrl,
      '<html><body><main><div id="module-platform"><section><h2>One platform, every surface</h2></section></div></main></body></html>',
    )).toBe(false);
  });

  it('does not impose Wayback heuristics on ordinary pages', () => {
    expect(isIncompleteWaybackCapture(
      'https://example.com/',
      '<html><body><div id="module-platform"><div style="min-height:900px"></div></div></body></html>',
    )).toBe(false);
  });
});

describe('scrollPage', () => {
  it('preserves every virtualized module and freezes its canvas after scrolling', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
    try {
      await page.setContent(`<!doctype html><html><body style="margin:0">
        <div id="module-one"><div style="min-height:700px"></div></div>
        <div id="module-two"><div style="min-height:700px"></div></div>
        <div id="module-three"><div style="min-height:700px"></div></div>
        <script>
          const modules = [...document.querySelectorAll('[id^="module-"]')];
          function render() {
            modules.forEach((module, index) => {
              const rect = module.getBoundingClientRect();
              if (rect.top < innerHeight && rect.bottom > 0) {
                if (index === 1) {
                  module.innerHTML = '<div style="min-height:700px"><h2>Module two</h2><canvas width="40" height="20"></canvas></div>';
                  const canvas = module.querySelector('canvas');
                  const context = canvas.getContext('2d');
                  context.fillStyle = 'rgb(255,0,0)';
                  context.fillRect(0, 0, 40, 20);
                } else {
                  module.innerHTML = '<div style="min-height:700px"><h2>Module ' + (index === 0 ? 'one' : 'three') + '</h2></div>';
                }
              } else {
                module.innerHTML = '<div style="min-height:700px"></div>';
              }
            });
          }
          addEventListener('scroll', render, { passive: true });
          render();
        </script>
      </body></html>`);

      await scrollPage(page);

      const capture = await page.evaluate(() => ({
        text: document.body.innerText,
        canvasCount: document.querySelectorAll('canvas').length,
        frozenCanvasCount: document.querySelectorAll('img[data-static-canvas-snapshot="1"]').length,
        snapshots: (window as Window & { __STATIC_MODULE_SNAPSHOTS__?: Record<string, { html: string }> })
          .__STATIC_MODULE_SNAPSHOTS__ ?? {},
      }));
      expect(Object.keys(capture.snapshots)).toEqual(['module-one', 'module-two', 'module-three']);
      expect(capture.text).toContain('Module one');
      expect(capture.text).toContain('Module two');
      expect(capture.text).toContain('Module three');
      expect(capture.canvasCount).toBe(0);
      expect(capture.frozenCanvasCount).toBe(1);
    } finally {
      await browser.close();
    }
  }, 30_000);
});

describe('crawlOnePage', () => {
  it('retries a transient Wayback navigation failure', async () => {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const url = 'https://web.archive.org/web/20260804095252/https://example.test/';
    let attempts = 0;
    await context.route(url, async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.abort('connectionclosed');
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body><main>Complete archived page</main></body></html>',
      });
    });

    try {
      const capture = await crawlOnePage(context, url, {
        startUrl: url,
        concurrency: 1,
        maxDepth: 0,
        viewportWidth: 800,
        viewportHeight: 600,
        scroll: false,
        pageTimeoutMs: 5_000,
      });
      expect(attempts).toBe(2);
      expect(capture.html).toContain('Complete archived page');
    } finally {
      await browser.close();
    }
  }, 30_000);
});
