import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildReconstructionPrompt } from './prompt.js';

describe('buildReconstructionPrompt', () => {
  it('replaces both export placeholders with the resolved absolute path', () => {
    const exportDir = path.resolve('exports/example-export');

    expect(buildReconstructionPrompt('exports/example-export')).toBe(
      `Rebuild the captured site in this Next.js repository. Treat ${exportDir}\n` +
      `as read-only evidence and read ${path.join(exportDir, 'LLM_HANDOFF.md')} first. Match\n` +
      'every captured route and screenshot at its exact viewport, use the localized assets\n' +
      'and fonts, and reproduce the observed responsive and interaction states. Do not\n' +
      'modify the export or ship captured Framer runtime code.',
    );
  });
});
