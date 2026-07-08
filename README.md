# framer-html-exporter

Capture one published Framer/static page into one portable `index.html`.

The default output keeps the source page's SSR DOM and runtime scripts intact, then fixes links and asset URLs so the page can be served locally. This is the NoCodeExport-style mode: fast, faithful, and intentionally not a React/Next.js converter.

## What It Does

- Opens the target URL in Playwright so the page can fully render.
- Captures the resolved start page HTML after hydration and scroll-triggered lazy loading.
- Preserves Framer SSR DOM, inline styles, module preloads, appear scripts, and runtime script references.
- Writes one `index.html`.
- Rewrites same-page links to `./index.html` and uncaptured same-origin links back to the real source URL.
- Optionally downloads and rewrites assets for offline/self-hosted use with `--localize-assets`.
- Strips Framer owner UI such as editor controls and the "Made in Framer" badge.

## Quick Start

```bash
npm install
npm run dev -- export https://vexor.framer.ai/ -o ./vexor-single
npm run dev -- serve -o ./vexor-single -p 3000
```

Open `http://localhost:3000`.

## CLI

```bash
framer-html-exporter export <url> [options]
  -o, --out <dir>           Output directory                  default: ./output
      --headed              Force headed browser
      --no-scroll           Skip lazy-load scroll trigger
      --viewport-width <n>  Capture viewport width             default: 1440
      --localize-assets     Download and rewrite assets locally
      --multi-page          Write crawled same-origin pages as local HTML files
      --max-depth <n>       Same-origin crawl depth             default: 1 with --multi-page, else 0
      --force-theme <theme> Force captured page theme: light or dark
      --include-url <url>   Additional same-origin URL to capture; repeatable
      --stay-local          Keep uncaptured same-origin links inside the local export
      --canonical-url <url> Override canonical, og:url, and twitter:url
      --strip-selector <s>  Remove matching elements; repeatable
      --subscribe-url <url> Redirect subscribe form clicks to this URL
      --subscribe-text <t>  Subscribe button label             default: Subscribe
      --user-data-dir <dir> Persistent browser profile dir      default: ./.browser-data

framer-html-exporter serve [options]
  -o, --out <dir>           Directory to serve                 default: ./output
  -p, --port <n>            Port                               default: 3000
```

For local development, run the same commands through `npm run dev --`:

```bash
npm run dev -- export https://altrix.framer.ai/ -o ./altrix-single
npm run dev -- export https://syntiro.framer.website/ -o ./syntiro-single --localize-assets
npm run dev -- export https://luma.com/ -o ./luma-local --multi-page --stay-local --force-theme dark --include-url https://luma.com/settings
npm run dev -- serve -o ./altrix-single -p 4177
```

## Output Modes

Default mode hotlinks remote assets/runtime URLs where possible. This is the most faithful mode for Framer pages because the original runtime keeps controlling animations, hovers, breakpoints, and component behavior.

For non-Framer pages, the exporter also captures the browser-accessible CSSOM after hydration and injects it into each exported page. This preserves runtime-loaded framework styles, authenticated app UI states, and interaction surfaces that are not fully represented by the original HTML alone.

`--localize-assets` downloads captured assets into `assets/` and rewrites references to local paths. Use it when you need offline/self-hosted files. It is slower and can miss runtime-built URLs if the page did not request them during capture.

## Accepted URLs

- Published Framer URLs such as `https://site.framer.website/`
- Framer AI/demo URLs such as `https://site.framer.ai/`
- Framer preview/editor URLs when your persisted browser session can access them
- Other static/SSR pages where a single-page HTML capture is useful

## Development

```bash
npm run typecheck
npm test
npm run build
```

The Playwright browser profile lives in `./.browser-data` by default and is ignored by Git.

## Vercel Deployment

This repo includes a static Vercel deployment setup for committed export folders.
Vercel runs `npm ci --ignore-scripts` so it does not download Playwright browsers,
then runs `npm run build && npm run vercel:prepare`.

`npm run vercel:prepare` copies every top-level `*-export` directory that contains
an `index.html` file into `dist/vercel` and creates a simple index page linking to
each export. It also rewrites root-absolute `/assets/` references in the deployment
copy so each export resolves assets from its own directory. For example,
`vellix-export` is deployed at `/vellix-export/`.

Run the same command locally to preview the deployment bundle:

```bash
npm run build
npm run vercel:prepare
npm run dev -- serve -o ./dist/vercel -p 4177
```

## Limits

- This is a single-page HTML extractor, not a Next.js/React decompiler.
- Live backend actions stay live. If a button routes to an uncaptured page, the export points to the real source page instead of inventing local UI.
- Authenticated pages should be reviewed before sharing exports. The interceptor avoids known private Framer endpoints, but generated output is intentionally ignored by Git.

## License

[MIT](LICENSE)
