# Local exports

Generated exports are ignored by Git.

Create one from the repository root:

```bash
npm install
npm run dev -- export https://example.framer.website/ --no-serve
```

Each default export contains only:

```text
standalone.html
ASTRO_MIGRATION_TRACKER.csv
```

Give an Astro reconstruction agent both files. The HTML is the replayable source and contains a non-executing schema-v2 evidence capsule with screenshots, geometry, styles, states, accessibility, diagnostics, and content-deduplicated embedded asset bodies (`assets[].blobIndex` → `assetBlobs[].dataUrl`). The CSV is the completion tracker.
