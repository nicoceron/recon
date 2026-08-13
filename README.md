# framer-html-exporter

Extract a published Framer page into the two files needed for an Astro rebuild.

## Default output

Every normal export is cleaned and contains exactly:

```text
example-export/
├── standalone.html
└── ASTRO_MIGRATION_TRACKER.csv
```

`standalone.html` is the replayable captured page source. Immediately before its closing `</body>`, it also contains a non-executing `#reconstruction-evidence` JSON capsule. The capsule embeds the original asset bodies and hashes, reference screenshots, DOM and computed-style snapshots, element geometry, responsive measurements, accessibility trees, safe interaction-state observations, animations, network evidence, runtime diagnostics, and an explicit capture-coverage report.

`ASTRO_MIGRATION_TRACKER.csv` inventories both the page and the evidence capsule section-by-section. Every tracker row starts as `TODO` so the Astro implementation can be completed and verified row by row. Capture failures and missing assets are emitted as tracker rows instead of being silently ignored.

The exporter does not generate a viewer, prompt, manifest, asset directory, or extra pages in the default mode.

## Export a page

```bash
npm install
npm run dev -- export https://example.framer.website/ --no-serve
```

The files are written to `exports/example-export/`. Without `--no-serve`, the CLI serves `standalone.html` directly and prints its URL.

For multiple URLs, each site receives its own two-file export directory:

```bash
npm run dev -- export \
  https://one.framer.website/ \
  https://two.framer.website/ \
  --no-serve
```

The default capture is one page at the supplied URL. Use `--include-url` to add another URL intentionally. The core matrix is desktop `1440x900`, tablet `810x1080`, and mobile `390x844`. The extractor also discovers CSS width breakpoints, captures one pixel below/at/above each breakpoint, and samples additional widths from 320 through 1920. Supplying `--viewports` replaces the broad sampling matrix while retaining discovered breakpoint probes.

Core viewports receive scroll and safe interaction-state capture. Breakpoint and coverage probes receive the initial/full-page, DOM, style, geometry, accessibility, network, and diagnostic pass. Submissions, navigation, destructive controls, credentials, and owner-only Framer responses are not exercised or persisted.

## Authorized project enrichment

Browser capture works from the published URL alone. If you also control the Framer project, Node.js 22+ can enrich the same capsule through Framer's official read-only Server API:

```bash
export FRAMER_API_KEY='your-api-key'
npm run dev -- export https://example.framer.website/ \
  --framer-project https://framer.com/projects/Website--project-id \
  --no-serve
```

This adds the canvas hierarchy and traits, project/publish information, CMS fields and records, localization groups, redirects, styles, variables, custom code, and complete user-authored code-file sources. The API key is read from the environment and is never embedded. Use `--framer-api-key-env NAME` to select a different environment variable.

## Astro handoff

Give the Astro agent both generated files and instruct it:

```text
Rebuild this page in Astro from standalone.html. Parse the non-executing
#reconstruction-evidence JSON capsule and treat ASTRO_MIGRATION_TRACKER.csv as the
completion ledger. Work through every TODO row, translate the captured DOM and CSS
into maintainable Astro components, extract/localize the embedded assets, reimplement
visible interactions and animations, and verify every captured viewport and state.
Do not ship the standalone HTML, evidence capsule, or Framer runtime. Do not finish
while the tracker contains unresolved rows.
```

The standalone file is evidence, not the final Astro implementation. The tracker is the checklist that prevents sections, bundles, assets, responsive states, or small interactions from being skipped.

## Legacy static mirror

The previous multi-file static mirror remains available only when explicitly requested:

```bash
npm run dev -- export https://example.framer.website/ --no-reconstruction
```

## CLI

```text
framer-html-exporter export <urls...> [options]
  -o, --out <dir>           Single-site output or multi-site parent       default: ./exports
  -p, --port <n>            Preferred preview port                          default: 3000
      --parallel <n>        Concurrent site extractions                   default: 2
      --no-serve            Do not start a preview server
      --signin              Open a persistent browser for auth
      --no-scroll           Skip lazy-load scroll triggering
      --no-adaptive-viewports Capture only explicitly requested responsive widths
      --max-depth <n>       Override crawl depth (reconstruction default: 3; 0 = one page)
      --include-url <url>   Add another URL intentionally; repeatable
      --force-theme <mode>  Capture light or dark
      --framer-project <url> Add authorized official Framer project evidence
      --framer-api-key-env   API-key environment variable     default: FRAMER_API_KEY
      --no-reconstruction   Opt into the legacy multi-file static mirror
```

## Development

```bash
npm run typecheck
npm test
npm run build
```

Generated exports and browser profiles are ignored by Git.

## License

[MIT](LICENSE)
