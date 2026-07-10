# Reconstruction agent guide

Use this guide when the end goal is a new Next.js implementation of a captured site. This file is tracked so it remains available in a fresh clone even though generated exports are not.

## The two inputs are different

The reconstruction agent needs:

- A writable repository where it will create or edit the Next.js app.
- One complete export directory from this extractor, available as read-only evidence.

The exporter repository explains and produces the evidence. It is not the application to rebuild, and its TypeScript source is not design evidence.

An export is a directory, not just one Markdown or HTML file. `LLM_HANDOFF.md` is the entry point, but it refers to screenshots, fonts, images, route data, DOM, and CSS beside it. Supplying only that Markdown file materially reduces reconstruction quality.

## Fresh clone: no exports is expected

Generated outputs are covered by `.gitignore`, so cloning this repository does not include the author's previous captures. Do not search Git history for them or assume the clone is broken.

Create a local export when a source URL is available:

```bash
npm install
npm run dev -- export https://example.com/ --no-serve
```

The package will normally be written to `./exports/example-export/`. Omit `--no-serve` when a local reference preview is useful.

If the agent cannot run the extractor or has not been given the source URL, it should stop before implementation and ask for the complete export directory (or an unpacked archive of it).

## Recommended local layout

The export can stay outside the new application repository as long as the coding agent can read its absolute path:

```text
work/
├── framer-html-exporter/
│   └── exports/example-export/       # local and gitignored
└── example-next/                     # writable reconstruction repo
```

If the coding environment cannot read across workspace roots, copy or link the export under a local ignored directory such as `example-next/.reference/example-export/`. Do not commit the evidence package by default; it can be large and may contain captured site or session data.

## Prompt to give the coding agent

Replace both paths with real absolute paths:

```text
Rebuild the captured site in the Next.js repository at <NEXT_REPO>.
Use <EXPORT_DIR> as read-only evidence and read <EXPORT_DIR>/LLM_HANDOFF.md first.
Implement every captured route and match every supplied screenshot at its exact viewport.
Use the localized assets and fonts, and reproduce the observed responsive, hover,
focus, scroll, animation, and open/closed interaction states. Do not modify the
export and do not ship captured Framer runtime code. Keep validating the implementation
against the screenshots until the differences are resolved.
```

Pointing the agent to this repository is useful for explaining the artifact contract, but the prompt must still include the actual export path.

## Agent execution protocol

1. Confirm that `LLM_HANDOFF.md`, `reconstruction/reconstruction.json`, `reconstruction/assets.json`, and the referenced screenshots exist under the export root.
2. Treat the export as immutable. Write only in the Next.js repository.
3. Read `reconstruction/reconstruction.json` for the route and viewport inventory, then inspect route-specific `page.json`, screenshots, DOM, and CSS on demand. Do not load every raw evidence file into context at once.
4. Inspect the existing application before choosing how to scaffold it. Preserve the repo's package manager, framework version, conventions, and unrelated user changes.
5. Establish local fonts, design tokens, global layout primitives, and shared chrome before implementing individual routes.
6. Build route by route and viewport by viewport. Use screenshots as visual ground truth; use geometry and computed styles as measurement evidence.
7. Recreate behavior from the captured interaction and animation evidence. Do not embed the static mirror, paste the raw hydrated DOM as the implementation, or depend on the captured Framer runtime.
8. Run the app and compare it at the exact captured viewport dimensions. Fix visible differences before declaring the reconstruction complete.

If required evidence is missing, name the missing path and request the full export. Do not silently invent the inaccessible design.

## Definition of done

- Every captured route exists and preserves the captured content and links.
- Desktop, tablet, and mobile screenshots match at their recorded dimensions.
- Captured local fonts and visual assets are used correctly.
- Responsive behavior is intentional at each captured breakpoint.
- Hover, focus, scroll, entrance, overlay, and other observed states work.
- The application makes no runtime request to Framer modules, analytics, or asset hosts.
- Normal Next.js checks pass, and the rebuilt app—not the static reference mirror—is what runs.
