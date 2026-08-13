# Astro reconstruction agent guide

The rebuilding agent needs the two files generated for the page:

1. `standalone.html` — replayable source of the complete page plus its non-executing schema-v2 evidence capsule.
2. `ASTRO_MIGRATION_TRACKER.csv` — the implementation and verification ledger.

## Workflow

Open `standalone.html`, parse `script#reconstruction-evidence[type="application/x-reconstruction-evidence+json"]`, and work through the tracker from top to bottom. Every row starts as `TODO`.

1. Build the page route and section structure from the captured DOM.
2. Translate the captured CSS, responsive rules, typography, layering, and motion into maintainable Astro components and styles.
3. Extract every required embedded asset body from the evidence capsule. Each `assets[]` record points to a content-deduplicated `assetBlobs[blobIndex].dataUrl`; verify the blob SHA-256 and byte count before localizing every recorded path/URL alias in the Astro repository.
4. Reimplement visible links, controls, menus, galleries, scrolling behavior, keyboard focus, hover states, and animations with Astro and focused client islands where needed.
5. Verify the page at every core viewport and adaptive breakpoint probe recorded by the capsule, including its initial, scroll, and interaction screenshots.
6. Update each row with implementation evidence and a terminal status. Do not finish while any required row remains `TODO`, `IN_PROGRESS`, or `BLOCKED`.

For difficult responsive behavior, use `responsiveModels` and the exact per-node measurements to fit the simplest valid CSS rule. Use the accessibility tree for roles and accessible names, the network/diagnostic records to find hidden dependencies, and the coverage report as a hard completion boundary.

When `framerProject` is present, use that official API evidence for design-time hierarchy, replicas, components, CMS, localization, redirects, and code-file source. The browser captures remain authoritative when design-time intent and published output differ.

Do not iframe, paste, or ship `standalone.html`, its evidence capsule, or the raw Framer runtime. Do not redesign from memory or stop after a scaffold.

## Fresh clone

Generated exports are ignored by Git. When a source URL is available:

```bash
npm install
npm run dev -- export https://example.framer.website/ --no-serve
```

Otherwise ask for the absolute paths to both `standalone.html` and `ASTRO_MIGRATION_TRACKER.csv`.
