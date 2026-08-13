import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { AssetStore } from '../interceptor/assetInterceptor.js';
import { ensureCleanDir } from '../output/fileWriter.js';
import type { StaticInteractionSnapshot } from '../rewriter/htmlRewriter.js';
import { rootRelativeAssetPath } from '../utils/urlUtils.js';
import {
  ASTRO_TRACKER_FILENAME,
  buildStandaloneMigrationTracker,
  RECONSTRUCTION_EVIDENCE_ID,
  RECONSTRUCTION_EVIDENCE_TYPE,
  STANDALONE_FILENAME,
} from './standaloneTracker.js';
import type {
  DesignTokenSummary,
  PageReconstructionEvidence,
  ReconstructionAsset,
  ReconstructionCapture,
  StyleEvidence,
} from './types.js';
import type { FramerProjectEvidence } from './framerProjectCapture.js';

export const RECONSTRUCTION_SOURCE_FILENAME = STANDALONE_FILENAME;
export const RECONSTRUCTION_TRACKER_FILENAME = ASTRO_TRACKER_FILENAME;

export interface WriteReconstructionOptions {
  sourceUrl: string;
  origin: string;
  capture: ReconstructionCapture;
  rawPages: Map<string, string>;
  sourcePages?: Map<string, string>;
  pageStyles: Map<string, string>;
  store: AssetStore;
  openStateSnapshots?: Record<string, StaticInteractionSnapshot>;
  projectEvidence?: FramerProjectEvidence;
}

export interface WriteStandalonePackageOptions extends WriteReconstructionOptions {
  sourceUrl: string;
  standaloneHtml: string;
}

interface EmbeddedAsset extends ReconstructionAsset {
  dataUrl?: string;
  blobIndex?: number;
}

interface EmbeddedBlob {
  sha256: string;
  bytes: number;
  contentType: string;
  dataUrl?: string;
}

interface ReconstructionEvidence {
  [key: string]: unknown;
  assets: EmbeddedAsset[];
  assetBlobs: EmbeddedBlob[];
}

interface StreamedDataUrl {
  __streamedDataUrl: true;
  contentType: string;
  body: Buffer;
}

/**
 * Write the deliberately small Astro handoff:
 *
 *   standalone.html              the rendered source page
 *   ASTRO_MIGRATION_TRACKER.csv  implementation and verification ledger
 *
 * Nothing else is required by the rebuilding agent.
 */
export async function writeReconstructionPackage(
  outDir: string,
  opts: WriteStandalonePackageOptions,
): Promise<void> {
  const assetRecords = opts.store.all();
  opts.capture.coverage.assetsCaptured = assetRecords.length;
  opts.capture.coverage.assetBytes = assetRecords.reduce((total, record) => total + record.body.length, 0);
  const issues = opts.store.issues();
  opts.capture.coverage.assetIssues = issues.filter(
    (issue) => !['privacy-excluded', 'source-missing', 'source-unreachable'].includes(issue.reason),
  );
  opts.capture.coverage.assetWarnings = issues.filter(
    (issue) => issue.reason === 'source-missing' || issue.reason === 'source-unreachable',
  );
  opts.capture.coverage.assetExclusions = issues.filter((issue) => issue.reason === 'privacy-excluded');
  const prepared = prepareReconstructionEvidence(opts, opts.standaloneHtml, false);
  opts.capture.coverage.uniqueAssetBlobs = prepared.blobs.length;
  opts.capture.coverage.uniqueAssetBytes = prepared.blobs.reduce((total, blob) => total + blob.record.body.length, 0);
  await ensureCleanDir(outDir);
  const standalonePath = path.join(outDir, STANDALONE_FILENAME);
  const trackerPath = path.join(outDir, ASTRO_TRACKER_FILENAME);
  const standaloneTemporaryPath = `${standalonePath}.tmp-${process.pid}`;
  const trackerTemporaryPath = `${trackerPath}.tmp-${process.pid}`;
  try {
    const written = await writeEvidenceHtml(standaloneTemporaryPath, opts.standaloneHtml, prepared);
    const tracker = buildStandaloneMigrationTracker({
      html: opts.standaloneHtml,
      evidence: prepared.evidence,
      sourceBytes: written.sourceBytes,
      evidenceBytes: written.evidenceBytes,
    }, {
      sourceFilename: STANDALONE_FILENAME,
      sourceUrl: opts.sourceUrl,
    });
    await fsPromises.writeFile(trackerTemporaryPath, tracker, 'utf8');
    await fsPromises.rename(trackerTemporaryPath, trackerPath);
    await fsPromises.rename(standaloneTemporaryPath, standalonePath);
  } catch (error) {
    await Promise.all([
      fsPromises.rm(standaloneTemporaryPath, { force: true }),
      fsPromises.rm(trackerTemporaryPath, { force: true }),
      fsPromises.rm(standalonePath, { force: true }),
      fsPromises.rm(trackerPath, { force: true }),
    ]);
    throw error;
  }
}

export function embedReconstructionEvidence(
  standaloneHtml: string,
  opts: WriteReconstructionOptions,
): string {
  const data = buildReconstructionEvidence(opts, standaloneHtml);
  const tag = `<script id="${RECONSTRUCTION_EVIDENCE_ID}" type="${RECONSTRUCTION_EVIDENCE_TYPE}" data-schema-version="2">${safeJson(data)}</script>`;
  const bodyClose = standaloneHtml.match(/<\/body\s*>/i);
  if (bodyClose?.index !== undefined) {
    return `${standaloneHtml.slice(0, bodyClose.index)}${tag}\n${standaloneHtml.slice(bodyClose.index)}`;
  }
  const htmlClose = standaloneHtml.match(/<\/html\s*>/i);
  if (htmlClose?.index !== undefined) {
    return `${standaloneHtml.slice(0, htmlClose.index)}${tag}\n${standaloneHtml.slice(htmlClose.index)}`;
  }
  return `${standaloneHtml}\n${tag}\n`;
}

export function buildReconstructionEvidence(opts: WriteReconstructionOptions, standaloneHtml = '') {
  return prepareReconstructionEvidence(opts, standaloneHtml, true).evidence;
}

function prepareReconstructionEvidence(
  opts: WriteReconstructionOptions,
  standaloneHtml: string,
  inlineBodies: boolean,
): {
  evidence: ReconstructionEvidence;
  blobs: Array<{ record: ReturnType<AssetStore['all']>[number]; contentType: string }>;
} {
  const inventory = buildAssetInventory(opts.store);
  const recordsByPath = new Map(opts.store.all().map((record) => [record.localPath, record]));
  const blobs: Array<{ record: ReturnType<AssetStore['all']>[number]; contentType: string }> = [];
  const blobIndexByHash = new Map<string, number>();
  const assets: EmbeddedAsset[] = inventory.map((asset) => {
    const record = recordsByPath.get(asset.localPath);
    if (!record) throw new Error(`Missing captured body for ${asset.localPath}`);
    let blobIndex = blobIndexByHash.get(asset.sha256);
    if (blobIndex === undefined) {
      blobIndex = blobs.length;
      blobIndexByHash.set(asset.sha256, blobIndex);
      blobs.push({ record, contentType: asset.contentType || 'application/octet-stream' });
    }
    return {
      ...asset,
      blobIndex,
    };
  });
  const assetBlobs: EmbeddedBlob[] = blobs.map(({ record, contentType }) => ({
    sha256: crypto.createHash('sha256').update(record.body).digest('hex'),
    bytes: record.body.length,
    contentType,
    ...(inlineBodies ? { dataUrl: `data:${contentType};base64,${record.body.toString('base64')}` } : {}),
  }));
  const data: ReconstructionEvidence = {
    schemaVersion: 2,
    purpose: 'Lossless, self-auditing evidence for translating the captured website into a native Astro application.',
    contract: {
      outputFiles: [STANDALONE_FILENAME, ASTRO_TRACKER_FILENAME],
      replayDocument: STANDALONE_FILENAME,
      completionLedger: ASTRO_TRACKER_FILENAME,
      evidenceElementId: RECONSTRUCTION_EVIDENCE_ID,
      evidenceType: RECONSTRUCTION_EVIDENCE_TYPE,
    },
    sourceUrl: opts.sourceUrl,
    origin: opts.origin,
    capturedAt: opts.capture.capturedAt,
    sourceFingerprint: {
      bytesBeforeEvidence: Buffer.byteLength(standaloneHtml),
      sha256BeforeEvidence: crypto.createHash('sha256').update(standaloneHtml).digest('hex'),
    },
    environment: opts.capture.environment,
    coverage: opts.capture.coverage,
    framerProject: opts.projectEvidence,
    validationPolicy: {
      primaryBrowser: opts.capture.environment.browser,
      geometryToleranceCssPixels: 2,
      screenshotPixelDifferenceRatio: 0.01,
      requireExactText: true,
      requireAllCapturedStates: true,
      requireKeyboardNavigation: true,
      requireNoUnexpectedConsoleOrHydrationErrors: true,
      completionStatuses: ['VERIFIED', 'NOT_APPLICABLE'],
      forbiddenOpenStatuses: ['TODO', 'IN_PROGRESS', 'BLOCKED'],
    },
    viewports: opts.capture.viewports,
    designTokens: summarizeDesignTokens(opts.capture.pages),
    routes: opts.capture.pages.map((page) => ({
      url: page.url,
      route: page.route,
      title: page.title,
      language: page.language,
      description: page.description,
      cleanDom: page.cleanDom,
      css: combinedCss(page, opts.pageStyles.get(page.url)),
      sourceHtml: opts.sourcePages?.get(page.url) ?? opts.rawPages.get(page.url) ?? page.cleanDom,
      rawHydratedHtml: opts.rawPages.get(page.url) ?? page.cleanDom,
      fonts: page.fonts,
      mediaQueries: page.mediaQueries,
      cssKeyframes: page.cssKeyframes,
      framerAppearPayloads: page.framerAppearPayloads.map(parseJsonIfPossible),
      responsiveModels: inferResponsiveModels(page),
      captures: page.viewports.map((viewport) => {
        const {
          screenshot: _screenshot,
          stateScreenshots: _stateScreenshots,
          screenshotPath: _screenshotPath,
          ...evidence
        } = viewport;
        return {
          ...evidence,
          fullPageScreenshot: dataUrlValue(viewport.screenshot, 'image/png', inlineBodies),
          states: viewport.stateScreenshots.map((state) => ({
            label: state.label,
            scrollY: state.scrollY,
            kind: state.kind,
            target: state.target,
            screenshot: dataUrlValue(state.screenshot, 'image/png', inlineBodies),
          })),
        };
      }),
    })),
    assets,
    assetBlobs,
    openStates: opts.openStateSnapshots ?? {},
  };
  return { evidence: data, blobs };
}

async function writeEvidenceHtml(
  outputPath: string,
  standaloneHtml: string,
  prepared: ReturnType<typeof prepareReconstructionEvidence>,
): Promise<{ sourceBytes: number; evidenceBytes: number }> {
  const insertion = evidenceInsertionPoint(standaloneHtml);
  const output = fs.createWriteStream(outputPath, { encoding: 'utf8' });
  let bytesWritten = 0;
  const write = async (value: string | Buffer): Promise<void> => {
    bytesWritten += Buffer.byteLength(value);
    if (!output.write(value)) await once(output, 'drain');
  };

  try {
    await write(standaloneHtml.slice(0, insertion));
    await write(`<script id="${RECONSTRUCTION_EVIDENCE_ID}" type="${RECONSTRUCTION_EVIDENCE_TYPE}" data-schema-version="2">`);
    const evidenceStart = bytesWritten;
    await writeJsonValue(write, prepared.evidence, prepared.evidence.assetBlobs, prepared.blobs);
    const evidenceBytes = bytesWritten - evidenceStart;
    await write('</script>\n');
    await write(standaloneHtml.slice(insertion));
    output.end();
    await once(output, 'finish');
    return { sourceBytes: bytesWritten, evidenceBytes };
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function evidenceInsertionPoint(html: string): number {
  const bodyClose = html.match(/<\/body\s*>/i);
  if (bodyClose?.index !== undefined) return bodyClose.index;
  const htmlClose = html.match(/<\/html\s*>/i);
  return htmlClose?.index ?? html.length;
}

async function writeJsonValue(
  write: (value: string | Buffer) => Promise<void>,
  value: unknown,
  assetBlobs: EmbeddedBlob[],
  bodies: ReturnType<typeof prepareReconstructionEvidence>['blobs'],
): Promise<void> {
  if (isStreamedDataUrl(value)) {
    await writeJsonStringPrefix(write, `data:${value.contentType};base64,`);
    await writeBase64(write, value.body);
    await write('"');
    return;
  }
  if (value === assetBlobs) {
    await write('[');
    for (let index = 0; index < assetBlobs.length; index += 1) {
      if (index > 0) await write(',');
      const blob = assetBlobs[index]!;
      const body = bodies[index];
      if (!body) throw new Error(`Missing embedded asset blob ${index}`);
      await write('{"sha256":');
      await writeJsonString(write, blob.sha256);
      await write(',"bytes":');
      await write(String(blob.bytes));
      await write(',"contentType":');
      await writeJsonString(write, blob.contentType);
      await write(',"dataUrl":');
      await writeJsonStringPrefix(write, `data:${blob.contentType};base64,`);
      await writeBase64(write, body.record.body);
      await write('"}');
    }
    await write(']');
    return;
  }
  if (value === null) {
    await write('null');
    return;
  }
  if (typeof value === 'string') {
    await writeJsonString(write, value);
    return;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    await write(JSON.stringify(value));
    return;
  }
  if (Array.isArray(value)) {
    await write('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) await write(',');
      await writeJsonValue(write, value[index], assetBlobs, bodies);
    }
    await write(']');
    return;
  }
  if (value && typeof value === 'object') {
    await write('{');
    let first = true;
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue;
      if (!first) await write(',');
      first = false;
      await writeJsonString(write, key);
      await write(':');
      await writeJsonValue(write, child, assetBlobs, bodies);
    }
    await write('}');
    return;
  }
  await write('null');
}

async function writeJsonString(
  write: (value: string | Buffer) => Promise<void>,
  value: string,
): Promise<void> {
  await writeJsonStringPrefix(write, value);
  await write('"');
}

async function writeJsonStringPrefix(
  write: (value: string | Buffer) => Promise<void>,
  value: string,
): Promise<void> {
  await write('"');
  const chunkSize = 64 * 1024;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    const encoded = JSON.stringify(value.slice(offset, offset + chunkSize)).slice(1, -1)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029');
    await write(encoded);
  }
}

async function writeBase64(
  write: (value: string | Buffer) => Promise<void>,
  value: Buffer,
): Promise<void> {
  // Multiples of three keep every chunk independently base64-decodable without
  // padding in the middle of the data URL.
  const chunkSize = 48 * 1024;
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    await write(value.subarray(offset, Math.min(value.length, offset + chunkSize)).toString('base64'));
  }
}

function dataUrlValue(value: Buffer, contentType: string, inline: boolean): string | StreamedDataUrl {
  return inline
    ? `data:${contentType};base64,${value.toString('base64')}`
    : { __streamedDataUrl: true, contentType, body: value };
}

function isStreamedDataUrl(value: unknown): value is StreamedDataUrl {
  return Boolean(value && typeof value === 'object' && (value as StreamedDataUrl).__streamedDataUrl === true);
}

/** Backward-compatible name retained for callers of the earlier reconstruction package. */
export function buildSourceCapsule(opts: WriteReconstructionOptions): string {
  return safeJson(buildReconstructionEvidence(opts));
}

export function buildAssetInventory(store: AssetStore): ReconstructionAsset[] {
  const urlsByPath = new Map<string, string[]>();
  for (const [url, localPath] of store.urlMap()) {
    const normalized = rootRelativeAssetPath(localPath).replace(/^\//, '');
    const urls = urlsByPath.get(normalized) ?? [];
    if (!urls.includes(url)) urls.push(url);
    urlsByPath.set(normalized, urls);
  }

  return store.all()
    .map((record) => {
      const localPath = rootRelativeAssetPath(record.localPath).replace(/^\//, '');
      return {
        urls: urlsByPath.get(localPath) ?? [record.url],
        localPath,
        bytes: record.body.length,
        contentType: record.contentType,
        kind: assetKind(record.contentType, record.localPath),
        sha256: crypto.createHash('sha256').update(record.body).digest('hex'),
      };
    })
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.localPath.localeCompare(b.localPath));
}

export function summarizeDesignTokens(pages: PageReconstructionEvidence[]): DesignTokenSummary {
  const tallies = {
    colors: new Map<string, number>(),
    fontFamilies: new Map<string, number>(),
    fontSizes: new Map<string, number>(),
    fontWeights: new Map<string, number>(),
    spacing: new Map<string, number>(),
    radii: new Map<string, number>(),
    shadows: new Map<string, number>(),
  };
  for (const page of pages) {
    for (const viewport of page.viewports) {
      for (const node of viewport.nodes) {
        if (node.rect.width <= 0 || node.rect.height <= 0) continue;
        const style = viewport.styleCatalog[node.styleId];
        if (style) tallyStyle(style, tallies, node.directText !== undefined || node.textContent !== undefined, node.tag);
        if (node.before) {
          const beforeStyle = viewport.styleCatalog[node.before.styleId];
          if (beforeStyle) tallyStyle(beforeStyle, tallies, true, 'pseudo');
        }
        if (node.after) {
          const afterStyle = viewport.styleCatalog[node.after.styleId];
          if (afterStyle) tallyStyle(afterStyle, tallies, true, 'pseudo');
        }
      }
    }
  }

  return {
    colors: ranked(tallies.colors),
    fontFamilies: ranked(tallies.fontFamilies),
    fontSizes: ranked(tallies.fontSizes),
    fontWeights: ranked(tallies.fontWeights),
    spacing: ranked(tallies.spacing),
    radii: ranked(tallies.radii),
    shadows: ranked(tallies.shadows),
  };
}

function renderCapsuleHtml(data: ReturnType<typeof capsuleDataShape>): string {
  const serialized = safeJson(data);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Website reconstruction source</title>
<style>
:root{color-scheme:dark;--bg:#101116;--panel:#191b23;--line:#303340;--text:#f4f5f7;--muted:#a8adbb;--accent:#8fa8ff}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
body{display:grid;grid-template-columns:290px minmax(0,1fr)}aside{position:sticky;top:0;height:100vh;padding:22px;border-right:1px solid var(--line);background:var(--panel);overflow:auto}
h1{font:700 18px/1.2 ui-sans-serif,system-ui;margin:0 0 8px}p{color:var(--muted);margin:0 0 20px}label{display:block;margin:16px 0 6px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
select,button{width:100%;border:1px solid var(--line);border-radius:8px;background:#101116;color:var(--text);padding:9px;font:inherit}button{cursor:pointer;text-align:left;margin:4px 0}button.active{border-color:var(--accent);color:#fff;background:#242b46}
main{min-width:0;padding:22px}.bar{display:flex;gap:10px;align-items:center;margin-bottom:18px}.bar strong{font:700 16px ui-sans-serif,system-ui}.meta{color:var(--muted);font-size:12px}
.panel{display:none}.panel.active{display:block}pre{margin:0;white-space:pre-wrap;word-break:break-word;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;max-height:calc(100vh - 90px);overflow:auto}
.shot{display:block;max-width:100%;height:auto;margin:auto;border:1px solid var(--line);background:#fff}.frame{width:100%;height:calc(100vh - 90px);border:1px solid var(--line);border-radius:10px;background:#fff}
.asset{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:10px 0;border-bottom:1px solid var(--line)}.asset small{color:var(--muted)}.asset a{color:var(--accent)}
@media(max-width:850px){body{grid-template-columns:1fr}aside{position:relative;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:12px}.frame{height:70vh}}
</style>
</head>
<body>
<aside>
  <h1>Reconstruction source</h1>
  <p id="summary"></p>
  <label for="route">Route</label><select id="route"></select>
  <label for="capture">Viewport / state</label><select id="capture"></select>
  <label>Inspect</label>
  <button data-panel="screenshot" class="active">Reference screenshot</button>
  <button data-panel="preview">DOM + CSS preview</button>
  <button data-panel="dom">Clean DOM</button>
  <button data-panel="css">Captured CSS</button>
  <button data-panel="evidence">Geometry / behavior JSON</button>
  <button data-panel="source">Original HTML</button>
  <button data-panel="assets">Embedded assets</button>
</aside>
<main>
  <div class="bar"><strong id="title"></strong><span class="meta" id="meta"></span></div>
  <section id="screenshot" class="panel active"><img id="shot" class="shot" alt="Reference capture"></section>
  <section id="preview" class="panel"><iframe id="frame" class="frame" sandbox=""></iframe></section>
  <section id="dom" class="panel"><pre id="domText"></pre></section>
  <section id="css" class="panel"><pre id="cssText"></pre></section>
  <section id="evidence" class="panel"><pre id="evidenceText"></pre></section>
  <section id="source" class="panel"><pre id="sourceText"></pre></section>
  <section id="assets" class="panel"><div id="assetList"></div></section>
</main>
<script type="application/json" id="reconstruction-source">${serialized}</script>
<script>
const DATA=JSON.parse(document.getElementById("reconstruction-source").textContent);
const routeSelect=document.getElementById("route"),captureSelect=document.getElementById("capture");
const assetLookup=new Map();
for(const asset of DATA.assets){const dataUrl=asset.dataUrl||DATA.assetBlobs?.[asset.blobIndex]?.dataUrl;if(!dataUrl)continue;assetLookup.set(asset.localPath,dataUrl);assetLookup.set("/"+asset.localPath,dataUrl);for(const url of asset.urls)assetLookup.set(url,dataUrl)}
document.getElementById("summary").textContent=DATA.routes.length+" routes · "+DATA.assets.length+" embedded assets · captured "+DATA.capturedAt;
for(const route of DATA.routes){const option=document.createElement("option");option.value=route.route;option.textContent=route.route+" — "+route.title;routeSelect.append(option)}
function currentRoute(){return DATA.routes.find(item=>item.route===routeSelect.value)||DATA.routes[0]}
function captureItems(route){const items=[];for(const capture of route.captures){for(const state of capture.states)items.push({capture,label:capture.viewport.name+" · "+state.label,src:state.screenshot,scrollY:state.scrollY});items.push({capture,label:capture.viewport.name+" · full page",src:capture.fullPageScreenshot,scrollY:0})}return items}
function fillCaptures(){captureSelect.replaceChildren();for(const [index,item] of captureItems(currentRoute()).entries()){const option=document.createElement("option");option.value=String(index);option.textContent=item.label;captureSelect.append(option)}render()}
function replaceAssets(value){return value.replace(/(?:https?:\\/\\/|\\/?assets\\/)[^"'()\\s<>]+/g,source=>assetLookup.get(source)||assetLookup.get(source.replace(/&amp;/g,"&"))||source)}
function render(){
  const route=currentRoute(),items=captureItems(route),selected=items[Number(captureSelect.value)||0]||items[0];
  document.getElementById("title").textContent=route.route;
  document.getElementById("meta").textContent=route.title;
  document.getElementById("shot").src=selected?.src||"";
  document.getElementById("domText").textContent=route.cleanDom;
  document.getElementById("cssText").textContent=route.css;
  document.getElementById("sourceText").textContent=route.sourceHtml;
  document.getElementById("evidenceText").textContent=JSON.stringify({route:route.route,fonts:route.fonts,mediaQueries:route.mediaQueries,cssKeyframes:route.cssKeyframes,framerAppearPayloads:route.framerAppearPayloads,capture:selected?.capture,selectedState:selected?.label,scrollY:selected?.scrollY,openStates:DATA.openStates},null,2);
  document.getElementById("frame").srcdoc="<!doctype html><html><head><meta charset=utf-8><style>"+replaceAssets(route.css)+"</style></head>"+replaceAssets(route.cleanDom)+"</html>";
}
function renderAssets(){const list=document.getElementById("assetList");if(list.childElementCount)return;for(const asset of DATA.assets){const row=document.createElement("div");row.className="asset";const info=document.createElement("div"),link=document.createElement("a");info.textContent=asset.localPath;const small=document.createElement("small");small.textContent=" · "+asset.contentType+" · "+asset.bytes+" bytes";info.append(small);link.href=asset.dataUrl||DATA.assetBlobs?.[asset.blobIndex]?.dataUrl||"";link.download=asset.localPath.split("/").pop();link.textContent="download";row.append(info,link);list.append(row)}}
routeSelect.addEventListener("change",fillCaptures);captureSelect.addEventListener("change",render);
for(const button of document.querySelectorAll("[data-panel]"))button.addEventListener("click",()=>{for(const item of document.querySelectorAll("[data-panel],.panel"))item.classList.remove("active");button.classList.add("active");document.getElementById(button.dataset.panel).classList.add("active");if(button.dataset.panel==="assets")renderAssets()});
routeSelect.value=DATA.routes[0]?.route||"";fillCaptures();
</script>
</body>
</html>`;
}

// Gives TypeScript a named return type source without maintaining a duplicate capsule interface.
function capsuleDataShape(opts: WriteReconstructionOptions) {
  return {
    schemaVersion: 1,
    purpose: '',
    sourceUrl: opts.sourceUrl,
    origin: opts.origin,
    capturedAt: opts.capture.capturedAt,
    viewports: opts.capture.viewports,
    designTokens: summarizeDesignTokens(opts.capture.pages),
    routes: [] as Array<Record<string, unknown>>,
    assets: [] as EmbeddedAsset[],
    assetBlobs: [] as EmbeddedBlob[],
    openStates: opts.openStateSnapshots ?? {},
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function inferResponsiveModels(page: PageReconstructionEvidence): Array<{
  path: string;
  key: string;
  widthRule: string;
  horizontalRule: string;
  measurements: Array<{ viewport: number; x: number; y: number; width: number; height: number }>;
}> {
  const byPath = new Map<string, { key: string; measurements: Array<{ viewport: number; x: number; y: number; width: number; height: number }> }>();
  for (const capture of page.viewports) {
    for (const node of capture.nodes) {
      if (node.rect.width <= 0 || node.rect.height <= 0) continue;
      const entry = byPath.get(node.path) ?? { key: node.key, measurements: [] };
      entry.measurements.push({ viewport: capture.viewport.width, ...node.rect });
      byPath.set(node.path, entry);
    }
  }
  const models = [];
  for (const [path, entry] of byPath) {
    const measurements = entry.measurements.sort((a, b) => a.viewport - b.viewport);
    if (measurements.length < 3) continue;
    const widths = measurements.map((item) => item.width);
    const widthRange = range(widths);
    const gutters = measurements.map((item) => item.viewport - item.width);
    const ratios = measurements.map((item) => item.width / item.viewport);
    const centered = measurements.every((item) => Math.abs(item.x - (item.viewport - item.width) / 2) <= 2);
    const maximum = Math.max(...widths);
    const plateau = measurements.filter((item) => Math.abs(item.width - maximum) <= 2).length >= 2;
    let widthRule = 'fluid-or-breakpoint-driven';
    if (measurements.every((item) => Math.abs(item.width - item.viewport) <= 2)) widthRule = 'width: 100vw';
    else if (widthRange <= 2) widthRule = `fixed ${roundModel(maximum)}px`;
    else if (range(gutters) <= 3) widthRule = `viewport minus ${roundModel(average(gutters))}px total gutter`;
    else if (range(ratios) <= 0.012) widthRule = `${roundModel(average(ratios) * 100)}% of viewport`;
    else if (plateau) widthRule = `fluid with max-width ${roundModel(maximum)}px`;
    const horizontalRule = centered
      ? 'centered'
      : range(measurements.map((item) => item.x)) <= 2
        ? `fixed left ${roundModel(average(measurements.map((item) => item.x)))}px`
        : 'responsive offset';
    models.push({ path, key: entry.key, widthRule, horizontalRule, measurements });
    if (models.length >= 1_500) break;
  }
  return models;
}

function range(values: number[]): number {
  return values.length ? Math.max(...values) - Math.min(...values) : 0;
}

function average(values: number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function roundModel(value: number): number {
  return Math.round(value * 100) / 100;
}

function tallyStyle(
  style: StyleEvidence,
  tallies: Record<keyof DesignTokenSummary, Map<string, number>>,
  hasText: boolean,
  tag: string,
): void {
  const add = (map: Map<string, number>, value?: string, ignored = /^(?:none|normal|auto|0px|rgba\(0, 0, 0, 0\))$/i) => {
    const normalized = value?.trim();
    if (!normalized || ignored.test(normalized)) return;
    map.set(normalized, (map.get(normalized) ?? 0) + 1);
  };
  if (hasText) add(tallies.colors, style.color);
  add(tallies.colors, style['background-color']);
  if (/^(?:svg|path|circle|ellipse|line|polyline|polygon|rect|text|use|g|stop)$/i.test(tag)) {
    add(tallies.colors, style.fill);
    add(tallies.colors, style.stroke);
  }
  for (const side of ['top', 'right', 'bottom', 'left']) {
    if (style[`border-${side}-style`] !== 'none' && parseFloat(style[`border-${side}-width`] ?? '0') > 0) {
      add(tallies.colors, style[`border-${side}-color`]);
    }
  }
  if (hasText) {
    add(tallies.fontFamilies, style['font-family'], /^$/);
    add(tallies.fontSizes, style['font-size'], /^$/);
    add(tallies.fontWeights, style['font-weight'], /^$/);
  }
  for (const property of [
    'gap', 'row-gap', 'column-gap', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  ]) add(tallies.spacing, style[property]);
  for (const property of [
    'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius',
  ]) add(tallies.radii, style[property]);
  add(tallies.shadows, style['box-shadow']);
  add(tallies.shadows, style['text-shadow']);
}

function ranked(values: Map<string, number>): Array<{ value: string; uses: number }> {
  return Array.from(values, ([value, uses]) => ({ value, uses }))
    .sort((a, b) => b.uses - a.uses || a.value.localeCompare(b.value));
}

function assetKind(contentType: string, localPath: string): ReconstructionAsset['kind'] {
  const value = contentType.toLowerCase();
  if (value.startsWith('image/')) return 'image';
  if (value.startsWith('font/') || /\.(?:woff2?|ttf|otf)$/i.test(localPath)) return 'font';
  if (value.startsWith('video/')) return 'video';
  if (value.startsWith('audio/')) return 'audio';
  if (value.includes('css')) return 'css';
  if (value.includes('javascript') || /\.(?:m?js)$/i.test(localPath)) return 'javascript';
  if (value.includes('json') || value.includes('xml') || value.startsWith('text/')) return 'data';
  return 'other';
}

function combinedCss(page: PageReconstructionEvidence, crawlerCss?: string): string {
  const chunks = new Set<string>();
  if (crawlerCss?.trim()) chunks.add(crawlerCss.trim());
  for (const stylesheet of page.stylesheets) {
    if (stylesheet.cssText?.trim()) chunks.add(stylesheet.cssText.trim());
  }
  return Array.from(chunks).join('\n\n/* ---- captured stylesheet boundary ---- */\n\n');
}

function parseJsonIfPossible(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
