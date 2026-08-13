import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReconstructionPrompt } from './prompt.js';

describe('buildReconstructionPrompt', () => {
  it('builds an optional Astro prompt around the standalone source and tracker', () => {
    const exportDir = path.resolve('exports/example-export');
    const prompt = buildReconstructionPrompt('exports/example-export');

    expect(prompt).toContain(path.join(exportDir, 'standalone.html'));
    expect(prompt).toContain(path.join(exportDir, 'ASTRO_MIGRATION_TRACKER.csv'));
    expect(prompt).toContain('standalone HTML is the complete captured page');
    expect(prompt).toContain('read every tracker row');
    expect(prompt).toContain('section-by-section');
    expect(prompt).toContain('Localize the referenced assets and fonts');
    expect(prompt).toContain('do not ship Framer');
    expect(prompt).toContain('Do not redesign');
    expect(prompt).not.toContain('Next.js');
  });
});
