import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
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

  const child = spawn('npx', ['sirv-cli', abs, '--port', String(opts.port), '--quiet'], {
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

/** Find consecutive-or-later free ports, also avoiding ports selected in this process. */
export async function findAvailablePorts(count: number, startPort: number): Promise<number[]> {
  if (!Number.isInteger(startPort) || startPort < 1 || startPort > 65_535) {
    throw new Error(`Invalid starting port: ${startPort}`);
  }
  const ports: number[] = [];
  let candidate = startPort;
  while (ports.length < count) {
    if (candidate > 65_535) throw new Error(`Could not find ${count} available ports from ${startPort}.`);
    if (await portIsAvailable(candidate)) ports.push(candidate);
    candidate += 1;
  }
  return ports;
}

function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
