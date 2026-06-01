import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeFileEnsured(
  rootDir: string,
  relativePath: string,
  content: Buffer | string,
): Promise<void> {
  const abs = path.join(rootDir, relativePath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  if (typeof content === 'string') {
    await fs.writeFile(abs, content, 'utf8');
  } else {
    await fs.writeFile(abs, content);
  }
}

export async function ensureCleanDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
}
