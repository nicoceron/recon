#!/usr/bin/env node
import { Command } from 'commander';
import path from 'node:path';
import { buildExportJobs, runConcurrently, type ExportJob } from './commands/batchExport.js';
import { runExport } from './commands/export.js';
import { findAvailablePorts, runServe } from './commands/serve.js';
import type { CaptureViewport } from './reconstruction/types.js';
import { logger } from './utils/logger.js';

const program = new Command();

program
  .name('framer-html-exporter')
  .description('Extract a published Framer page into standalone HTML plus an Astro migration tracker CSV.')
  .version('0.1.0');

program
  .command('export')
  .description('Extract a page into standalone.html and ASTRO_MIGRATION_TRACKER.csv by default.')
  .argument('<urls...>', 'One or more public URLs; multiple sites export concurrently')
  .option('-o, --out <dir>', 'Single-site output directory, or multi-site parent directory', './exports')
  .option('--signin', 'Open a persistent browser for a private/authenticated page', false)
  .option('--headed', 'Deprecated alias for --signin', false)
  .option('--parallel <n>', 'Maximum sites extracted concurrently', parsePositiveInteger, 2)
  .option('-p, --port <n>', 'Preferred first preview port; occupied ports are skipped automatically', parsePort, 3000)
  .option('--no-serve', 'Extract without starting preview servers')
  .option('--no-scroll', 'Skip lazy-load scroll trigger')
  .option('--viewport-width <n>', 'Capture viewport width', (v) => parseInt(v, 10), 1440)
  .option('--localize-assets', 'Download and rewrite assets for offline/self-hosted use', false)
  .option('--multi-page', 'Write every crawled page to its own local HTML file', false)
  .option('--full-site', 'Framer full-site preset: --localize-assets --multi-page --stay-local', false)
  .option('--no-reconstruction', 'Use the legacy static mirror output with assets, manifest, and optional multiple HTML pages')
  .option(
    '--viewports <list>',
    'Responsive evidence matrix, e.g. desktop:1440x900,tablet:810x1080,mobile:390x844',
    parseViewports,
  )
  .option('--no-adaptive-viewports', 'Capture only the requested viewport matrix without breakpoint-adjacent probes')
  .option('--max-depth <n>', 'Override same-origin crawl depth; reconstruction defaults to 3, use 0 for one page', (v) => parseInt(v, 10))
  .option('--force-theme <theme>', 'Force captured page theme: light or dark')
  .option('--framer-project <url>', 'Authorized Framer editor project URL to enrich the browser capture with official project data')
  .option('--framer-api-key-env <name>', 'Environment variable containing the Framer API key', 'FRAMER_API_KEY')
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
  .action(async (urls: string[], options: Record<string, unknown>, command: Command) => {
    try {
      const subscribeUrl = options.subscribeUrl as string | undefined;
      const forceTheme = parseForceTheme(options.forceTheme);
      const fullSite = options.fullSite as boolean;
      const reconstruction = options.reconstruction as boolean;
      const framerProjectUrl = options.framerProject as string | undefined;
      const framerApiKeyEnv = options.framerApiKeyEnv as string;
      if (framerProjectUrl && !reconstruction) throw new Error('--framer-project is available only in reconstruction mode.');
      const framerApiKey = framerProjectUrl ? process.env[framerApiKeyEnv] : undefined;
      if (framerProjectUrl && !framerApiKey) {
        throw new Error(`--framer-project requires an API key in the ${framerApiKeyEnv} environment variable.`);
      }
      const signin = Boolean(options.signin || options.headed);
      if (signin && urls.length > 1) {
        throw new Error('--signin accepts one URL per command because it requires interactive browser confirmation.');
      }

      const jobs = buildExportJobs(
        urls,
        options.out as string,
        command.getOptionValueSource('out') === 'cli',
      );
      const results = await runConcurrently(jobs, options.parallel as number, async (job) => {
        logger.info({ name: job.name, url: job.url, outDir: job.outDir }, 'site-export-started');
        await runExport({
          url: job.url,
          outDir: job.outDir,
          headed: signin,
          scroll: options.scroll as boolean,
          viewportWidth: options.viewportWidth as number,
          localizeAssets: (options.localizeAssets as boolean) || fullSite,
          multiPage: (options.multiPage as boolean) || fullSite,
          maxDepth: options.maxDepth as number | undefined,
          includeUrls: options.includeUrl as string[] | undefined,
          forceTheme,
          reconstruction,
          reconstructionViewports: options.viewports as CaptureViewport[] | undefined,
          adaptiveViewports: options.adaptiveViewports as boolean,
          framerProjectUrl,
          framerApiKey,
          stayLocal: (options.stayLocal as boolean) || fullSite,
          userDataDir: path.resolve(options.userDataDir as string),
          canonicalUrl: options.canonicalUrl as string | undefined,
          stripSelectors: options.stripSelector as string[] | undefined,
          subscribeRedirect: subscribeUrl
            ? { url: subscribeUrl, text: options.subscribeText as string }
            : undefined,
        });
        return job;
      });

      const failures = results.flatMap((result, index) => result.status === 'rejected'
        ? [{ job: jobs[index]!, error: result.reason }]
        : []);
      if (failures.length > 0) {
        for (const failure of failures) {
          logger.error({
            name: failure.job.name,
            url: failure.job.url,
            err: failure.error instanceof Error ? failure.error.message : String(failure.error),
            stack: failure.error instanceof Error ? failure.error.stack : undefined,
          }, 'site-export-failed');
        }
        throw new Error(`${failures.length} of ${jobs.length} site exports failed.`);
      }

      if (!(options.serve as boolean)) {
        printCompletedJobs(jobs);
        return;
      }

      const ports = await findAvailablePorts(jobs.length, options.port as number);
      printServedJobs(jobs, ports, reconstruction);
      await Promise.all(jobs.map((job, index) => runServe({ outDir: job.outDir, port: ports[index]! })));
    } catch (err) {
      logger.error({ err: (err as Error).message, stack: (err as Error).stack }, 'export-failed');
      process.exitCode = 1;
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

function parseViewports(value: string): CaptureViewport[] {
  const result = value.split(',').map((entry, index) => {
    const trimmed = entry.trim();
    const match = trimmed.match(/^(?:([a-z0-9_-]+):)?(\d+)x(\d+)$/i);
    if (!match) throw new Error(`Invalid viewport "${trimmed}". Use name:WIDTHxHEIGHT.`);
    const width = Number(match[2]);
    const height = Number(match[3]);
    if (width < 240 || height < 240 || width > 7680 || height > 7680) {
      throw new Error(`Viewport "${trimmed}" is outside the supported 240-7680px range.`);
    }
    return { name: match[1] ?? `viewport-${index + 1}`, width, height };
  });
  if (result.length === 0) throw new Error('At least one viewport is required.');
  return result;
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('Value must be a positive integer.');
  return parsed;
}

function parsePort(value: string): number {
  const parsed = parsePositiveInteger(value);
  if (parsed > 65_535) throw new Error('Port must be between 1 and 65535.');
  return parsed;
}

function printCompletedJobs(jobs: ExportJob[]): void {
  process.stderr.write('\nExports complete:\n');
  for (const job of jobs) process.stderr.write(`  ${job.name}: ${job.outDir}\n`);
  process.stderr.write('\n');
}

function printServedJobs(jobs: ExportJob[], ports: number[], reconstruction: boolean): void {
  process.stderr.write('\nExports complete and previews are ready:\n');
  jobs.forEach((job, index) => {
    const entry = reconstruction ? '/standalone.html' : '/';
    process.stderr.write(`  ${job.name}: http://localhost:${ports[index]}${entry}  (${job.outDir})\n`);
  });
  process.stderr.write('\nPress Ctrl+C to stop all preview servers.\n\n');
}
