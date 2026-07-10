import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildExportJobs, runConcurrently } from './batchExport.js';

describe('buildExportJobs', () => {
  it('uses an explicit output directory exactly for one URL', () => {
    const jobs = buildExportJobs(['antimetal.com'], './custom-output', true);
    expect(jobs).toEqual([{
      index: 0,
      url: 'https://antimetal.com/',
      name: 'antimetal',
      outDir: path.resolve('./custom-output'),
    }]);
  });

  it('creates one named export directory per URL for a batch', () => {
    const jobs = buildExportJobs(
      ['https://antimetal.com/', 'https://allintitarvl.framer.website/'],
      './exports',
      false,
    );
    expect(jobs.map((job) => ({ name: job.name, outDir: job.outDir }))).toEqual([
      { name: 'antimetal', outDir: path.resolve('./exports/antimetal-export') },
      { name: 'allintitarvl', outDir: path.resolve('./exports/allintitarvl-export') },
    ]);
  });

  it('does not collide when the same site is listed twice', () => {
    const jobs = buildExportJobs(['https://example.com/', 'https://example.com/'], './exports', false);
    expect(jobs.map((job) => job.name)).toEqual(['example', 'example-2']);
  });
});

describe('runConcurrently', () => {
  it('runs every item and retains input order when one item fails', async () => {
    const results = await runConcurrently([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('two failed');
      return value * 10;
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 10 });
    expect(results[1]?.status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 30 });
  });
});
