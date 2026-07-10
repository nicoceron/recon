import path from 'node:path';

/** Build the copy-ready instruction shown after a reconstruction export succeeds. */
export function buildReconstructionPrompt(exportDir: string): string {
  const absoluteExportDir = path.resolve(exportDir);
  const handoffPath = path.join(absoluteExportDir, 'LLM_HANDOFF.md');

  return [
    `Rebuild the captured site in this Next.js repository. Treat ${absoluteExportDir}`,
    `as read-only evidence and read ${handoffPath} first. Match`,
    'every captured route and screenshot at its exact viewport, use the localized assets',
    'and fonts, and reproduce the observed responsive and interaction states. Do not',
    'modify the export or ship captured Framer runtime code.',
  ].join('\n');
}
