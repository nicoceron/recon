import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../utils/logger.js';

export interface ServeOptions {
  outDir: string;
  port: number;
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const abs = path.resolve(opts.outDir);
  if (!fs.existsSync(abs)) {
    throw new Error(`Output directory does not exist: ${abs}. Run 'export' first.`);
  }

  logger.info({ dir: abs, port: opts.port }, 'starting-static-server');
  process.stderr.write(`\nServing ${abs} on http://localhost:${opts.port}\n\n`);

  const child = spawn('npx', ['sirv-cli', abs, '--port', String(opts.port), '--single', '--quiet'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  await new Promise<void>((resolve, reject) => {
    child.on('exit', (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`sirv-cli exited with code ${code}`));
    });
    child.on('error', reject);
  });
}
