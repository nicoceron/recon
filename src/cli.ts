#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { runExport } from './commands/export.js';
import { runServe } from './commands/serve.js';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('framer-html-exporter')
  .description('Capture a published Framer page into one portable index.html file.')
  .version('0.1.0');

program
  .command('export')
  .description('Export the resolved start page as one full HTML document.')
  .argument('<url>', 'Framer editor / preview / published / custom-domain URL')
  .option('-o, --out <dir>', 'Output directory', './output')
  .option('--headed', 'Force headed browser even if session exists', false)
  .option('--no-scroll', 'Skip lazy-load scroll trigger')
  .option('--viewport-width <n>', 'Capture viewport width', (v) => parseInt(v, 10), 1440)
  .option('--localize-assets', 'Download and rewrite assets for offline/self-hosted use', false)
  .option('--multi-page', 'Write every crawled page to its own local HTML file', false)
  .option('--full-site', 'Framer full-site preset: --localize-assets --multi-page --stay-local', false)
  .option('--max-depth <n>', 'Same-origin crawl depth; defaults to 3 with --multi-page and 0 otherwise', (v) => parseInt(v, 10))
  .option('--force-theme <theme>', 'Force captured page theme: light or dark')
  .option(
    '--include-url <url>',
    'Additional same-origin URL to capture; repeatable',
    (value: string, prev: string[] = []) => prev.concat(value),
    [] as string[],
  )
  .option('--stay-local', 'Keep uncaptured same-origin links inside the local export instead of linking to the live site', false)
  .option(
    '--canonical-url <url>',
    'Override <link rel=canonical> and og:url in the export so the static site no longer advertises its Framer preview URL',
  )
  .option(
    '--strip-selector <selector>',
    'Remove every element matching this CSS selector from every page (cheerio supports :has() and :contains()). Repeatable.',
    (value: string, prev: string[] = []) => prev.concat(value),
    [] as string[],
  )
  .option('--subscribe-url <url>', 'Keep the subscribe form but redirect clicks to this URL (opens in a new tab) instead of submitting')
  .option('--subscribe-text <text>', 'Label to show on the subscribe button when --subscribe-url is set', 'Subscribe')
  .option('--user-data-dir <dir>', 'Persistent browser profile dir', './.browser-data')
  .action(async (url: string, options: Record<string, unknown>) => {
    try {
      const subscribeUrl = options.subscribeUrl as string | undefined;
      const forceTheme = parseForceTheme(options.forceTheme);
      const fullSite = options.fullSite as boolean;
      await runExport({
        url,
        outDir: options.out as string,
        headed: options.headed as boolean,
        scroll: options.scroll as boolean,
        viewportWidth: options.viewportWidth as number,
        localizeAssets: (options.localizeAssets as boolean) || fullSite,
        multiPage: (options.multiPage as boolean) || fullSite,
        maxDepth: options.maxDepth as number | undefined,
        includeUrls: options.includeUrl as string[] | undefined,
        forceTheme,
        stayLocal: (options.stayLocal as boolean) || fullSite,
        userDataDir: path.resolve(options.userDataDir as string),
        canonicalUrl: options.canonicalUrl as string | undefined,
        stripSelectors: options.stripSelector as string[] | undefined,
        subscribeRedirect: subscribeUrl
          ? { url: subscribeUrl, text: options.subscribeText as string }
          : undefined,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'export-failed');
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Serve the exported static site via sirv.')
  .option('-o, --out <dir>', 'Directory to serve', './output')
  .option('-p, --port <n>', 'Port', (v) => parseInt(v, 10), 3000)
  .action(async (options: Record<string, unknown>) => {
    try {
      await runServe({
        outDir: options.out as string,
        port: options.port as number,
      });
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'serve-failed');
      process.exit(1);
    }
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error({ err: (err as Error).message }, 'cli-error');
  process.exit(1);
});

function parseForceTheme(value: unknown): 'light' | 'dark' | undefined {
  if (value === undefined) return undefined;
  if (value === 'light' || value === 'dark') return value;
  throw new Error('--force-theme must be "light" or "dark"');
}
