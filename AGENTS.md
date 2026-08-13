# Instructions for coding agents

## Repository purpose

This repository extracts published sites into a two-file source handoff for a separate Astro reconstruction. It does not contain the rebuilt application.

Generated exports are ignored by Git. A fresh clone with only `exports/README.md` is normal.

## When the user asks for a site reconstruction

Read `RECONSTRUCTION_AGENT.md` before coding. The reconstruction needs:

1. A writable Astro repository.
2. The exported `standalone.html` and `ASTRO_MIGRATION_TRACKER.csv`.

Start with the exported HTML. It contains every captured route, DOM, CSS, responsive screenshot/state, asset, and behavior record. Do not infer the design from this repository’s source code.

If no export exists:

- If the user supplied a source URL and requested extraction, run the documented export command.
- Otherwise ask for both exported files or their absolute paths.

## When modifying the extractor

Preserve the two-file output contract: one `standalone.html` and one `ASTRO_MIGRATION_TRACKER.csv`. The default export must not create a viewer, prompt, manifest, assets directory, or extra HTML files.

Run `npm run typecheck` and `npm test` after relevant changes.
