import path from 'node:path';

/** Build an optional Astro handoff instruction; the default export writes no prompt file. */
export function buildReconstructionPrompt(exportDir: string): string {
  const absoluteExportDir = path.resolve(exportDir);
  const sourcePath = path.join(absoluteExportDir, 'standalone.html');
  const trackerPath = path.join(absoluteExportDir, 'ASTRO_MIGRATION_TRACKER.csv');

  return [
    `Replicate the website contained in ${sourcePath} as a fully working Astro site in this repository.`,
    '',
    `Use ${trackerPath} as the completion ledger. The standalone HTML is the complete captured page`,
    'source: inspect its DOM, CSS, responsive behavior, fonts, images, assets, interactions,',
    'animations, and original Framer evidence.',
    '',
    'Work through it step by step:',
    '1. Open the HTML and read every tracker row.',
    '2. Recreate the page section-by-section from the supplied DOM and CSS. Preserve exact content,',
    '   layout, typography, responsive variants, and per-instance differences.',
    '3. Localize the referenced assets and fonts needed by the Astro implementation.',
    '4. Reimplement visible interactions and motion with Astro and focused client islands; do not ship Framer.',
    '5. Compare desktop, tablet, and mobile, then resolve every tracker row with evidence.',
    '',
    'Do not redesign, approximate from memory, embed the source HTML in the app, or finish while',
    'the tracker contains unresolved rows.',
  ].join('\n');
}
