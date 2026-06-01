import { writeFileEnsured } from './fileWriter.js';

export interface Manifest {
  sourceUrl: string;
  origin: string;
  runAt: string;
  pages: Array<{ url: string; localPath: string }>;
  assets: Array<{ url: string; localPath: string; bytes: number; contentType: string }>;
  totals: {
    pages: number;
    assets: number;
    assetBytes: number;
  };
}

export async function writeManifest(rootDir: string, manifest: Manifest): Promise<void> {
  await writeFileEnsured(rootDir, 'manifest.json', JSON.stringify(manifest, null, 2));
}
