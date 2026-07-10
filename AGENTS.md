# Instructions for coding agents

## Repository purpose

This repository is an evidence extractor. It does not contain the Next.js site that will eventually be rebuilt, and it is not a source template for that site.

Generated site exports are intentionally ignored by Git. A fresh clone with no generated directories under `exports/` (only its tracked explanatory README) is normal and complete.

## When the user asks for a site reconstruction

Read `RECONSTRUCTION_AGENT.md` before coding. The reconstruction needs two distinct locations:

1. A writable Next.js application repository.
2. A complete, read-only export directory produced by this project.

Start with `<export-directory>/LLM_HANDOFF.md`. Do not infer the target design from this repository's source code or README, and do not begin a visual reconstruction from the public URL alone when the evidence package is unavailable.

If the user supplied only this repository and no export:

- If they supplied a source URL and asked you to extract it, run the documented export command.
- Otherwise, explain that exports are local ignored artifacts and ask for the complete export directory or its absolute path.

## When modifying the extractor

Preserve the separation between compact model guidance and large evidence files. `LLM_HANDOFF.md` should index and explain the evidence; raw DOM, CSS, screenshots, assets, and runtime payloads belong in their dedicated files.

Run `npm run typecheck` and `npm test` after relevant changes.
