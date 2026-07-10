# recon

Extract one or more published sites into ground-truth reconstruction packages that another LLM can rebuild from zero in Next.js.

This project is not primarily an offline Framer mirror and it is not a mechanical Framer-to-React transpiler. Its job is to observe the published site at multiple responsive sizes, preserve every useful source and asset, and organize the evidence so a coding agent can reproduce the design without shipping Framer's runtime.

## The output contract

The default export captures:

- Every discovered same-origin route, combining visible links with `robots.txt`/XML sitemap discovery and configurable crawl depth.
- Desktop, tablet, and mobile initial, scroll-state, and revealed full-page screenshots.
- The rendered DOM, semantic content, links, controls, forms, ARIA state, and media dimensions.
- Per-element document coordinates and a deduplicated computed-style catalog at every viewport.
- Accessible CSSOM, selectors, CSS variables, media queries, `@font-face` declarations, transitions, and keyframes.
- Loaded font families, weights, styles, stretches, and the corresponding localized font files.
- Images, SVGs, video/audio, stylesheets, data, and Framer's module graph, with original URL aliases and SHA-256 hashes.
- Active Web Animations, calls to `Element.animate`, Framer appear payloads, and CSS animation declarations.
- Empirical hover and focus style differences for visible controls.
- Captured click-opened menus, popovers, dialogs, drawers, and other interaction surfaces.
- The original hydrated HTML and a runnable static mirror as forensic references.

The result has one human/LLM entry point, `LLM_HANDOFF.md`, and structured evidence beside it:

```text
export/
├── LLM_HANDOFF.md                 # Give this to the rebuilding agent first
├── index.html                     # Framer-powered visual reference mirror
├── manifest.json                  # Static-export inventory
├── assets/                        # Local images, fonts, media, CSS, and module evidence
└── reconstruction/
    ├── reconstruction.json        # Site index and evidence contract
    ├── assets.json                # Original URL → local file map, types, sizes, hashes
    ├── design-tokens.json         # Ranked colors, type, spacing, radii, and shadows
    ├── open-states.json           # Click-opened interaction surfaces
    ├── screenshots/               # Full-page visual ground truth at each viewport
    └── pages/<route>/
        ├── page.json              # Geometry, computed styles, states, and animations
        ├── clean-dom.html          # Script-free rendered content/structure
        ├── source-response.html    # Original HTML before React/Next hydration
        ├── raw-hydrated.html       # Original post-hydration DOM
        ├── styles.css              # Captured CSSOM/media queries/keyframes/font faces
        └── framer-appear.json      # Framer entrance-animation payloads
```

`LLM_HANDOFF.md` is intentionally a compact, text-only index. Large DOM, CSS, runtime payloads, images, and fonts are not duplicated or base64-inlined into it: doing so would waste the model's context window and make the artifact less useful. For maximum fidelity, give the rebuilding agent the entire export directory and tell it to start with `LLM_HANDOFF.md`.

## Rebuild in a separate Next.js repo

The coding agent needs both a writable Next.js repository and a readable export directory. Pointing it at this repository explains the extraction format, but this repository does not include example exports: generated output is intentionally ignored by Git.

Give the agent the absolute path to the **entire export directory**, not only `LLM_HANDOFF.md` or `index.html`. The handoff is a compact index; its screenshots, fonts, images, route data, DOM, and CSS remain in neighboring files.

Use this prompt in the new repository:

```text
Rebuild the captured site in this Next.js repository. Treat <ABSOLUTE_EXPORT_DIR>
as read-only evidence and read <ABSOLUTE_EXPORT_DIR>/LLM_HANDOFF.md first. Match
every captured route and screenshot at its exact viewport, use the localized assets
and fonts, and reproduce the observed responsive and interaction states. Do not
modify the export or ship captured Framer runtime code.
```

See [RECONSTRUCTION_AGENT.md](RECONSTRUCTION_AGENT.md) for the fresh-clone case, recommended cross-repo layout, the agent's evidence-reading order, and the definition of done.

## One-command workflow

```bash
npm install
npm run dev -- export https://antimetal.com/
```

That single command:

1. Runs Chromium headlessly, including on the first run.
2. Crawls and extracts the site.
3. Writes `./exports/antimetal-export/`.
4. Starts its reference preview on the first available port at or above `3000`.
5. Prints the exact output directory, preview URL, and a copy-ready reconstruction prompt with the absolute export path filled in.

Keep the command running while using the preview. Press `Ctrl+C` to stop the server.

### Export several sites in parallel

Pass several links to the same command:

```bash
npm run dev -- export \
  https://antimetal.com/ \
  https://allintitarvl.framer.website/
```

The sites export concurrently in isolated headless browsers. Outputs are written to:

```text
exports/
├── antimetal-export/
└── allintitarvl-export/
```

When extraction finishes, both are served automatically on different available ports, normally `http://localhost:3000` and `http://localhost:3001`. If either port is occupied, the CLI skips it and finds the next available port.

The default concurrency is two sites. Adjust it when processing a larger list:

```bash
npm run dev -- export https://one.example https://two.example https://three.example --parallel 3
```

You can also run separate export commands in different terminals. Each command uses an isolated headless browser and automatically chooses a free preview port.

Responsive evidence is also captured with bounded parallelism inside each site: two routes are processed at a time and the desktop, tablet, and mobile viewports for each route run together. Large CMS sites can still take longer and produce large packages because every discovered route receives its own screenshots and structured evidence; use `--max-depth` when you intentionally want a narrower crawl.

### Optional sign-in mode

Public pages do not require sign-in and never open a visible browser. If a private or authenticated page genuinely needs a session, opt in explicitly:

```bash
npm run dev -- export https://private.example.com/ --signin
```

`--signin` opens a persistent browser profile and waits for confirmation after you authenticate. It accepts one URL per command because the confirmation is interactive. The extraction continues in that same visible authenticated session.

### Export without serving

For unattended batches or CI, disable the preview server:

```bash
npm run dev -- export https://antimetal.com/ --no-serve
```

For one URL, an explicit `--out` is used exactly as provided:

```bash
npm run dev -- export https://mahadeva.framer.ai/ -o ./mahadeva-export
```

For multiple URLs, `--out` is the parent directory containing one named export folder per site.

The default command localizes assets, crawls same-origin routes to depth 3, and captures three viewports:

- `desktop:1440x900`
- `tablet:810x1080`
- `mobile:390x844`

Route discovery is automatic: the crawler follows same-origin links and also reads sitemap URLs advertised by `robots.txt` plus the conventional `/sitemap.xml`. Use `--include-url` only for public routes that are absent from both navigation and sitemaps.

Use a custom matrix when the design has known breakpoints:

```bash
npm run dev -- export https://mahadeva.framer.ai/ \
  -o ./mahadeva-export \
  --viewports desktop:1512x982,tablet:834x1112,mobile:393x852
```

Then hand the output directory to the Next.js coding agent with this instruction:

> Read `LLM_HANDOFF.md` first. Rebuild the site from zero in Next.js. Use the localized assets and fonts, match every supplied screenshot at its exact viewport, and reproduce all responsive, animation, hover, focus, scroll, and open/closed interaction states. Do not depend on Framer at runtime.

## CLI

```text
framer-html-exporter export <urls...> [options]
  -o, --out <dir>           One-site output, or multi-site parent    default: ./exports
  -p, --port <n>            Preferred first preview port             default: 3000
      --parallel <n>        Concurrent site extractions              default: 2
      --no-serve            Do not start preview servers
      --signin              Visible persistent browser for auth
      --no-scroll           Skip lazy-load/scroll-state traversal
      --viewports <list>    name:WIDTHxHEIGHT entries, comma-separated
      --max-depth <n>       Same-origin crawl depth                   default: 3
      --include-url <url>   Add a same-origin route; repeatable
      --force-theme <mode>  Capture light or dark
      --canonical-url <url> Override canonical metadata in mirror HTML
      --strip-selector <s>  Remove mirror elements; repeatable
      --user-data-dir <dir> Persistent browser profile                default: ./.browser-data
      --no-reconstruction   Legacy mode: skip reconstruction evidence

framer-html-exporter serve [options]
  -o, --out <dir>           Export directory                          default: ./output
  -p, --port <n>            Port                                      default: 3000
```

The older `--localize-assets`, `--multi-page`, `--full-site`, and `--stay-local` flags remain accepted. Reconstruction mode enables their relevant behavior automatically.

Exports are served automatically. To serve an existing output manually:

```bash
npm run serve -- -o ./mahadeva-export -p 4177
```

## What “exact” means

A published page is a black-box observation surface. The extractor records all browser-observable evidence it can recover: pixels, layout boxes, computed styles, source CSS, loaded assets/fonts, live animation data, DOM, routes, and interaction states. It also retains the raw HTML and module graph when a behavior cannot be safely inferred.

The reconstruction agent still has to translate that evidence into maintainable React components and animation code. This is deliberate: copying minified Framer runtime code into a Next.js app would preserve the dependency rather than reconstruct the site.

Some states cannot be discovered safely without domain knowledge—for example destructive authenticated actions, checkout completion, private CMS variants, or content that never appears in any crawled route or interaction. Use `--include-url` for hidden routes, a persisted signed-in profile for protected pages, and review sensitive exports before sharing them.

Published Framer, Next.js, React, and other browser-rendered sites are supported. Framework pages retain both the original server response and the post-hydration DOM; the static reference replays the clean source so React/Next applications are not hydrated twice. Same-origin framework chunks and optimizer-generated images are localized alongside third-party assets. CSS animations, Web Animations, Framer motion, responsive states, and observed style changes are captured directly. Libraries such as GSAP that continuously mutate inline styles are visible in screenshots and computed states, while untriggered timelines, callbacks, and application-only state may still require site-specific instrumentation.

## Development

```bash
npm run typecheck
npm test
npm run build
```

Generated exports and browser profiles are ignored by Git.

## Vercel reference deployment

The included Vercel setup publishes top-level `*-export` directories as reference mirrors. It is for visually inspecting captured sites, not for deploying the eventual Next.js reconstruction.

```bash
npm run build
npm run vercel:prepare
npm run serve -- -o ./dist/vercel -p 4177
```

## License

[MIT](LICENSE)
