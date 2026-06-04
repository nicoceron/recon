import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';

const GOOGLE_MAP_IFRAME_SELECTOR = 'iframe[src*="google.com/maps/embed"]';

export async function inlineGoogleMapIframes(page: Page, pageUrl: string): Promise<number> {
  let inlined = 0;
  const frames = await page.locator(GOOGLE_MAP_IFRAME_SELECTOR).elementHandles().catch(() => []);

  for (const frame of frames) {
    try {
      const src = await frame.getAttribute('src');
      if (!src) continue;

      const box = await frame.boundingBox();
      if (!box || box.width < 32 || box.height < 32) continue;

      await frame.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => undefined);
      await page.waitForTimeout(900);

      const png = await frame.screenshot({ type: 'png', timeout: 8_000 });
      const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
      const width = Math.round(box.width);
      const height = Math.round(box.height);

      await frame.evaluate(
        (node: Element, payload) => {
          const iframe = node as HTMLIFrameElement;
          const img = document.createElement('img');
          img.src = payload.dataUrl;
          img.alt = iframe.getAttribute('title') || iframe.getAttribute('aria-label') || 'Map';
          img.setAttribute('data-static-captured-map', '1');
          img.setAttribute('data-static-map-src', payload.src);
          img.setAttribute('loading', 'lazy');
          img.style.cssText = iframe.getAttribute('style') || '';
          if (!img.style.width) img.style.width = '100%';
          if (!img.style.height) img.style.height = `${payload.height}px`;
          if (!img.style.display) img.style.display = 'block';
          img.style.objectFit = 'cover';
          img.style.pointerEvents = 'none';
          if (payload.width) img.setAttribute('width', String(payload.width));
          if (payload.height) img.setAttribute('height', String(payload.height));
          iframe.replaceWith(img);
        },
        { dataUrl, src, width, height },
      );
      inlined += 1;
    } catch (err) {
      logger.debug({ pageUrl, err: (err as Error).message }, 'map-iframe-capture-failed');
    }
  }

  if (inlined > 0) logger.info({ url: pageUrl, count: inlined }, 'map-iframes-inlined');
  return inlined;
}
