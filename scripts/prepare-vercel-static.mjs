import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(rootDir, "dist", "vercel");

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function titleFromExportDir(name) {
  return name
    .replace(/-export$/, "")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function findExports() {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const exports = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith("-export")) {
      continue;
    }

    const indexPath = path.join(rootDir, entry.name, "index.html");
    if (await exists(indexPath)) {
      exports.push(entry.name);
    }
  }

  return exports.sort((a, b) => a.localeCompare(b));
}

function renderIndex(exportDirs) {
  const links = exportDirs
    .map((dir) => {
      const title = titleFromExportDir(dir);
      return `<a class="site-link" href="./${escapeHtml(dir)}/"><span>${escapeHtml(
        title,
      )}</span><code>/${escapeHtml(dir)}</code></a>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Framer HTML Exports</title>
    <style>
      :root {
        color-scheme: light;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f7f9;
        color: #15171a;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 40px 20px;
      }
      main {
        width: min(760px, 100%);
      }
      h1 {
        margin: 0 0 10px;
        font-size: clamp(32px, 6vw, 56px);
        line-height: 1;
        letter-spacing: 0;
      }
      p {
        margin: 0 0 28px;
        max-width: 58ch;
        color: #545b66;
        font-size: 16px;
        line-height: 1.6;
      }
      nav {
        display: grid;
        gap: 10px;
      }
      .site-link {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 20px;
        min-height: 64px;
        padding: 18px 20px;
        border: 1px solid #dfe3e8;
        border-radius: 8px;
        color: inherit;
        background: #ffffff;
        text-decoration: none;
        box-shadow: 0 1px 2px rgba(21, 23, 26, 0.04);
      }
      .site-link:hover {
        border-color: #aab2bd;
      }
      .site-link span {
        font-weight: 650;
      }
      code {
        color: #68707d;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 13px;
        overflow-wrap: anywhere;
      }
      @media (max-width: 560px) {
        body { place-items: start; }
        .site-link {
          align-items: flex-start;
          flex-direction: column;
          gap: 8px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Framer HTML Exports</h1>
      <p>Static captures packaged from the top-level <code>*-export</code> directories in this repository.</p>
      <nav aria-label="Exported sites">
        ${links}
      </nav>
    </main>
  </body>
</html>
`;
}

const exportDirs = await findExports();

if (exportDirs.length === 0) {
  throw new Error("No top-level *-export directories with index.html were found.");
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });

for (const dir of exportDirs) {
  await cp(path.join(rootDir, dir), path.join(outputDir, dir), {
    recursive: true,
  });
}

await writeFile(path.join(outputDir, "index.html"), renderIndex(exportDirs));

console.log(`Prepared ${exportDirs.length} export(s) in ${path.relative(rootDir, outputDir)}`);
