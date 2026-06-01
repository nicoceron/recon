import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { chromium, type BrowserContext } from 'playwright';
import { logger } from '../utils/logger.js';

export interface SessionOptions {
  userDataDir: string;
  headed: boolean;
  viewportWidth: number;
  viewportHeight?: number;
  /** URL to open initially in the headed browser so the user lands on the right page */
  initialUrl?: string;
}

export interface OpenSession {
  context: BrowserContext;
  isFirstRun: boolean;
  close: () => Promise<void>;
}

export async function openSession(opts: SessionOptions): Promise<OpenSession> {
  const absDir = path.resolve(opts.userDataDir);
  fs.mkdirSync(absDir, { recursive: true });

  const isFirstRun = !hasExistingProfile(absDir);
  const headless = opts.headed ? false : !isFirstRun;
  const viewportHeight = opts.viewportHeight ?? 900;

  logger.info(
    { userDataDir: absDir, headless, isFirstRun },
    headless ? 'launching-headless-browser' : 'launching-headed-browser',
  );

  const context = await chromium.launchPersistentContext(absDir, {
    headless,
    viewport: headless ? { width: opts.viewportWidth, height: viewportHeight } : null,
    args: ['--disable-blink-features=AutomationControlled'],
  });

  if (isFirstRun || opts.headed) {
    await ensureInitialPage(context, opts.initialUrl);
    await waitForUserConfirmation();
  }

  return {
    context,
    isFirstRun,
    close: async () => {
      try {
        await context.close();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'context-close-error');
      }
    },
  };
}

function hasExistingProfile(dir: string): boolean {
  // Chromium creates a Default/ subdir on first launch
  return fs.existsSync(path.join(dir, 'Default'));
}

async function ensureInitialPage(context: BrowserContext, initialUrl?: string): Promise<void> {
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const target = initialUrl ?? 'https://www.framer.com/login';
    if (page.url() === 'about:blank' || page.url() === '') {
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
        logger.warn({ target, err: (err as Error).message }, 'initial-navigation-failed');
      });
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'open-initial-page-error');
  }
}

/**
 * After the user has signaled readiness, return the URL of whichever page in the
 * context looks like a renderable Framer site (preview / published / custom domain).
 * Falls back to the first non-blank page's URL.
 */
export function pickActivePageUrl(context: BrowserContext): string | undefined {
  const pages = context.pages();
  // Prefer pages that look like a renderable site (not the editor / not a login page)
  for (const page of pages) {
    const url = page.url();
    if (!url || url === 'about:blank') continue;
    if (url.includes('framer.app/preview') || url.includes('.framer.website')) return url;
  }
  for (const page of pages) {
    const url = page.url();
    if (!url || url === 'about:blank') continue;
    if (url.includes('/login')) continue;
    if (url.includes('framer.com/projects')) continue;
    return url;
  }
  // Last resort: any non-blank URL (editor or otherwise)
  for (const page of pages) {
    const url = page.url();
    if (url && url !== 'about:blank') return url;
  }
  return undefined;
}

const EDITOR_PROJECT_ID = /framer\.com\/projects\/[^/?#]+--([\w-]+)/i;

/** If the URL is a Framer editor URL, return the equivalent preview URL. */
export function editorToPreviewUrl(url: string): string | undefined {
  const m = url.match(EDITOR_PROJECT_ID);
  if (!m) return undefined;
  return `https://framer.app/preview/${m[1]}`;
}

function waitForUserConfirmation(): Promise<void> {
  const sentinel = path.resolve('.framer-html-exporter-ready');
  try {
    fs.unlinkSync(sentinel);
  } catch {
    /* ignore — sentinel may not exist */
  }

  const stdinIsTty = Boolean((process.stdin as NodeJS.ReadStream).isTTY);
  const lines: string[] = [
    '',
    '>> Use the opened browser to sign in if needed, then navigate to the page you want to export.',
    '>> When the page is ready, do one of these:',
  ];
  if (stdinIsTty) lines.push('>>   (a) Press Enter in this terminal, or');
  lines.push(`>>   ${stdinIsTty ? '(b)' : '* '} From another shell run:    touch ${sentinel}`);
  lines.push('', '');
  process.stderr.write(lines.join('\n'));

  return new Promise((resolve) => {
    let done = false;
    let rl: readline.Interface | undefined;

    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (rl) {
        try {
          rl.close();
        } catch {
          /* ignore */
        }
      }
      try {
        fs.unlinkSync(sentinel);
      } catch {
        /* ignore */
      }
      resolve();
    };

    if (stdinIsTty) {
      rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      rl.on('line', () => finish());
      // Deliberately don't resolve on 'close' — only on actual user input or sentinel.
    }

    const timer = setInterval(() => {
      if (fs.existsSync(sentinel)) finish();
    }, 1000);
  });
}
