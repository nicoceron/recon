import path from 'node:path';

export interface ExportJob {
  index: number;
  url: string;
  name: string;
  outDir: string;
}

/**
 * Resolve predictable output folders without making the common one-URL case verbose.
 * A CLI-supplied --out is the exact directory for one URL and a parent for many URLs.
 */
export function buildExportJobs(urls: string[], outOption: string, outWasExplicit: boolean): ExportJob[] {
  if (urls.length === 0) throw new Error('At least one URL is required.');
  const usedNames = new Map<string, number>();

  return urls.map((input, index) => {
    const url = normalizeHttpUrl(input);
    const parsed = new URL(url);
    const baseName = siteName(parsed);
    const occurrence = (usedNames.get(baseName) ?? 0) + 1;
    usedNames.set(baseName, occurrence);
    const name = occurrence === 1 ? baseName : `${baseName}-${occurrence}`;
    const outDir = urls.length === 1 && outWasExplicit
      ? path.resolve(outOption)
      : path.resolve(outOption, `${name}-export`);
    return { index, url, name, outDir };
  });
}

export async function runConcurrently<T, R>(
  items: T[],
  concurrency: number,
  runner: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results: Array<PromiseSettledResult<R>> = new Array(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(Math.floor(concurrency), items.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        results[index] = { status: 'fulfilled', value: await runner(item) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function normalizeHttpUrl(input: string): string {
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(withProtocol);
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Only http(s) URLs can be exported: ${input}`);
  }
  return parsed.href;
}

function siteName(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const firstLabel = host.split('.')[0] || 'site';
  const pathName = url.pathname.replace(/^\/+|\/+$/g, '');
  const raw = pathName ? `${firstLabel}-${pathName.replace(/\//g, '-')}` : firstLabel;
  return raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'site';
}
