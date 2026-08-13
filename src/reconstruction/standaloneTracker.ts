import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

export const STANDALONE_FILENAME = 'standalone.html';
export const ASTRO_TRACKER_FILENAME = 'ASTRO_MIGRATION_TRACKER.csv';
export const RECONSTRUCTION_EVIDENCE_ID = 'reconstruction-evidence';
export const RECONSTRUCTION_EVIDENCE_TYPE = 'application/x-reconstruction-evidence+json';

export interface MigrationTrackerOptions {
  sourceFilename?: string;
  sourceUrl?: string;
}

export interface MigrationTrackerSource {
  /** HTML before the non-executing reconstruction evidence script is inserted. */
  html: string;
  /** Already-built schema-v2 evidence. Avoids serializing and reparsing huge bodies. */
  evidence?: EvidenceRecord;
  /** Exact UTF-8 bytes of the finished standalone file. */
  sourceBytes?: number;
  /** Exact UTF-8 bytes of the serialized JSON capsule. */
  evidenceBytes?: number;
}

interface TrackerRow {
  id: string;
  category: string;
  priority: string;
  status: 'TODO';
  owner: string;
  route: string;
  viewport: string;
  sourceLocator: string;
  sourceElement: string;
  detail: string;
  requirement: string;
  verification: string;
  sourceSize: string;
  notes: string;
}

interface TrackerInput {
  id: string;
  category: string;
  priority?: string;
  route?: string;
  viewport?: string;
  sourceLocator: string;
  sourceElement: string;
  detail: string;
  requirement: string;
  verification: string;
  sourceSize?: string;
  notes?: string;
}

type AddTrackerRow = (input: TrackerInput) => void;
type EvidenceRecord = Record<string, unknown>;

const HEADERS = [
  'id',
  'category',
  'priority',
  'status',
  'owner',
  'route',
  'viewport',
  'source_locator',
  'source_element',
  'detail',
  'implementation_requirement',
  'verification_evidence',
  'source_size_or_count',
  'notes',
];

const INTERACTIVE_NAME = /menu|hamburger|next|previous|scroll|gallery|slider|button|logo/i;
const URL_ATTRIBUTE_NAMES = new Set(['src', 'srcset', 'poster', 'href', 'action', 'data-src', 'data-srcset']);
const MEDIA_TAGS = new Set(['img', 'video', 'source', 'audio', 'iframe', 'object', 'embed']);

export function buildStandaloneMigrationTracker(
  source: string | MigrationTrackerSource,
  options: MigrationTrackerOptions = {},
): string {
  const sourceFilename = options.sourceFilename ?? STANDALONE_FILENAME;
  const sourceUrl = options.sourceUrl ?? '';
  const primaryRoute = routeFromSourceUrl(sourceUrl);
  const html = typeof source === 'string' ? source : source.html;
  const $ = cheerio.load(html);
  let evidence: EvidenceRecord | undefined;
  let evidenceBytes = 0;
  if (typeof source === 'string') {
    const evidenceElement = $(`script#${RECONSTRUCTION_EVIDENCE_ID}[type="${RECONSTRUCTION_EVIDENCE_TYPE}"]`).first();
    const evidenceText = evidenceElement.text();
    evidence = parseEvidence(evidenceText);
    evidenceBytes = Buffer.byteLength(evidenceText);
    // Embedded screenshots and asset bodies are authoritative evidence, but must
    // not be mistaken for source-page scripts or scanned again as page URLs.
    evidenceElement.remove();
  } else {
    evidence = source.evidence;
    evidenceBytes = source.evidenceBytes ?? 0;
  }
  const inventoryHtml = $.html();
  const embeddedAssetUrls = new Set(
    evidence
      ? records(evidence.assets).flatMap((asset) => Array.isArray(asset.urls) ? asset.urls.map((url) => String(url)) : [])
      : [],
  );
  const rows: TrackerRow[] = [];
  const add = (input: TrackerInput): void => {
    const category = input.category;
    const priority = input.priority ?? priorityFor(category);
    rows.push({
      id: input.id,
      category,
      priority,
      status: 'TODO',
      owner: 'Astro agent',
      route: input.route ?? primaryRoute,
      viewport: input.viewport ?? '',
      sourceLocator: input.sourceLocator,
      sourceElement: input.sourceElement,
      detail: input.detail,
      requirement: input.requirement,
      verification: input.verification,
      sourceSize: input.sourceSize ?? '',
      notes: input.notes ?? '',
    });
  };

  const sourceBytes = typeof source === 'string' ? Buffer.byteLength(html) : source.sourceBytes ?? Buffer.byteLength(html);
  const scripts = $('script').toArray();
  const styles = $('style').toArray();
  const bodyElement = $('body').get(0);
  const bodyElements = $('body').find('*').toArray().filter((element) => !['script', 'style'].includes(element.name));
  const domElements = bodyElement ? [bodyElement, ...bodyElements] : bodyElements;
  const headElements = $('head').find('*').toArray().filter((element) => !['script', 'style'].includes(element.name));
  const documentElements = [...headElements, ...domElements];
  const sections = domElements.filter((element) => element.name === 'section');
  const links = domElements.filter((element) => element.name === 'a');
  const media = domElements.filter((element) => MEDIA_TAGS.has(element.name));
  const namedElements = domElements.filter((element) => Boolean(attr(element, 'data-framer-name')));
  const runtimeScript = scripts.find((element) => attr(element, 'data-standalone-framer-runtime') !== undefined);
  const runtimeText = runtimeScript ? $(runtimeScript).html() ?? '' : '';
  const cssBlocks = styles.flatMap((element, styleIndex) => parseCssBlocks($(element).html() ?? '', styleIndex));
  const urls = collectUrls($, [...documentElements, ...scripts, ...styles], styles, inventoryHtml);

  add({
    id: 'meta:source',
    category: 'meta',
    priority: 'P0',
    sourceLocator: sourceFilename,
    sourceElement: sourceFilename,
    detail: JSON.stringify({ sourceUrl, bytes: sourceBytes, sections: sections.length, domNodes: domElements.length, styles: styles.length, scripts: scripts.length, links: links.length, media: media.length }),
    requirement: `Treat ${sourceFilename} as the only source of truth for this Astro page.`,
    verification: 'The Astro implementation is traceable to this file and every tracker row is resolved against it.',
    sourceSize: `bytes=${sourceBytes}`,
  });
  add({
    id: 'meta:completion-gate',
    category: 'meta',
    priority: 'P0',
    sourceLocator: ASTRO_TRACKER_FILENAME,
    sourceElement: 'completion gate',
    detail: 'Every generated row starts TODO.',
    requirement: 'Do not finish while any row is TODO, IN_PROGRESS, or BLOCKED. Terminal rows must be VERIFIED or evidence-backed NOT_APPLICABLE for raw runtime code only.',
    verification: 'Final audit finds no open tracker rows and every terminal row has implementation evidence.',
  });
  add({
    id: 'meta:standalone-boundary',
    category: 'meta',
    priority: 'P0',
    sourceLocator: 'scripts and styles in standalone HTML',
    sourceElement: 'export boundary',
    detail: 'The rendered page is mixed with export shims and a bundled Framer runtime.',
    requirement: 'Extract the page into maintainable Astro code; do not iframe, paste, or ship the standalone runtime as the implementation.',
    verification: 'The Astro build works without loading the standalone file or raw Framer runtime.',
  });

  if (evidence) addEvidenceRows(evidence, add, sourceFilename, evidenceBytes);
  else add({
    id: 'meta:evidence-capsule-missing',
    category: 'capture-failure',
    priority: 'P0',
    sourceLocator: `script#${RECONSTRUCTION_EVIDENCE_ID}`,
    sourceElement: 'verified evidence capsule',
    detail: 'The standalone page does not contain the schema-v2 responsive evidence capsule.',
    requirement: 'Regenerate the export with verified capture enabled before reconstruction.',
    verification: `Confirm ${sourceFilename} contains #${RECONSTRUCTION_EVIDENCE_ID} with type ${RECONSTRUCTION_EVIDENCE_TYPE}.`,
  });

  const requestedViewports = evidence
    ? records(record(evidence.coverage).requestedViewports)
    : [];
  const coreViewports: EvidenceRecord[] = requestedViewports.length > 0
    ? requestedViewports
    : [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'tablet', width: 810, height: 1080 },
        { name: 'mobile', width: 390, height: 844 },
      ];
  for (const [index, viewport] of coreViewports.entries()) {
    const name = stringValue(viewport.name) || `viewport-${index + 1}`;
    const width = Number(viewport.width);
    const height = Number(viewport.height);
    add({
      id: `responsive-viewport:${name}`,
      category: 'responsive-viewport',
      priority: 'P0',
      viewport: name,
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.coverage.requestedViewports[${index}]`,
      sourceElement: `${width}x${height}`,
      detail: JSON.stringify(viewport),
      requirement: `Implement and visually verify the page at the required ${width}x${height} viewport.`,
      verification: 'Capture the Astro page at this exact viewport and compare the complete page, section order, crop, text wrapping, and fixed navigation.',
    });
  }

  if (!evidence) add({
    id: `route:${primaryRoute}`,
    category: 'route',
    priority: 'P0',
    route: primaryRoute,
    sourceLocator: 'html/body/#main',
    sourceElement: 'standalone page',
    detail: `The standalone source represents the ${primaryRoute} page and contains ${sections.length} sections.`,
    requirement: `Create the Astro ${primaryRoute} route with the full captured content, metadata, DOM order, responsive behavior, and links.`,
    verification: `Open ${primaryRoute} directly at all recorded viewports and verify the full page is present.`,
    sourceSize: `sections=${sections.length};domNodes=${domElements.length}`,
  });

  scripts.forEach((element, index) => {
    const body = $(element).html() ?? '';
    const isRuntime = element === runtimeScript;
    add({
      id: `bundle:script:${index + 1}`,
      category: 'bundle',
      priority: isRuntime ? 'P0' : 'P1',
      sourceLocator: `html.script[${index + 1}]`,
      sourceElement: isRuntime ? 'data-standalone-framer-runtime' : `inline-script-${index + 1}`,
      detail: JSON.stringify({ attrs: element.attribs ?? {}, bytes: Buffer.byteLength(body), head: compact(body.slice(0, 240)) }),
      requirement: isRuntime
        ? 'Audit this Framer runtime for visible behavior and reimplement only the required result in Astro/client code; never ship the raw runtime.'
        : 'Audit this export or behavior script and reproduce its visible behavior, or mark it NOT_APPLICABLE with evidence.',
      verification: 'Record the behavior decision and confirm no visible, navigation, responsive, interaction, or animation behavior was lost.',
      sourceSize: `bytes=${Buffer.byteLength(body)}`,
      notes: isRuntime ? 'Runtime bundle is evidence only.' : 'Do not copy the export shim blindly.',
    });
  });

  const bundleParts = new Set<string>();
  for (const match of runtimeText.matchAll(/\b(?:init_[A-Za-z0-9_$]+|[A-Za-z_$][A-Za-z0-9_$]*_exports)\b/g)) bundleParts.add(match[0]);
  for (const part of [...bundleParts].sort()) {
    add({
      id: `bundle-part:runtime:${part}`,
      category: 'bundle-part',
      priority: 'P2',
      sourceLocator: `script[data-standalone-framer-runtime] marker ${part}`,
      sourceElement: part,
      detail: 'Named module/export marker found inside the standalone runtime.',
      requirement: 'Audit this bundle part for visible behavior/content dependencies, then reimplement the required result in Astro and document why the raw marker is not shipped.',
      verification: 'The tracker records the relevant behavior or confirms the marker is unused by the rendered page.',
    });
  }

  styles.forEach((element, index) => {
    const body = $(element).html() ?? '';
    add({
      id: `evidence:style-block:${index + 1}`,
      category: 'evidence',
      priority: 'P1',
      sourceLocator: `html.style[${index + 1}]`,
      sourceElement: `style-block-${index + 1}`,
      detail: JSON.stringify({ attrs: element.attribs ?? {}, bytes: Buffer.byteLength(body) }),
      requirement: 'Use this inline stylesheet as evidence for the Astro CSS translation while removing Framer-only export chrome.',
      verification: 'Every required rule has an Astro CSS equivalent and visual comparisons show no missing style block.',
      sourceSize: `bytes=${Buffer.byteLength(body)}`,
    });
  });

  cssBlocks.forEach((block, index) => {
    const header = compact(block.header);
    const body = compact(block.body);
    const lower = header.toLowerCase();
    const category = lower.startsWith('@font-face')
      ? 'font'
      : lower.startsWith('@media')
        ? 'media-query'
        : lower.startsWith('@keyframes') || lower.startsWith('@-webkit-keyframes')
          ? 'keyframe'
          : /^(from|to|\d+(?:\.\d+)?%)$/i.test(header)
            ? 'keyframe-step'
            : lower.startsWith('@')
              ? 'css-at-rule'
              : 'style-rule';
    const declarations = (body.match(/(?:^|;)\s*[-A-Za-z_][\w-]*\s*:/g) ?? []).length;
    add({
      id: `css:${category}:${index + 1}`,
      category,
      priority: category === 'style-rule' ? 'P2' : 'P1',
      sourceLocator: `style[${block.styleIndex + 1}].block[${index + 1}]`,
      sourceElement: header.slice(0, 240),
      detail: JSON.stringify({ header, body, depth: block.depth }),
      requirement: category === 'style-rule'
        ? 'Translate this selector and declaration block into maintainable Astro CSS while preserving layout, typography, color, layering, and motion.'
        : category === 'media-query'
          ? 'Implement this responsive rule and verify the page changes at the same breakpoint.'
          : category === 'font'
            ? 'Preserve this font-face family, style, weight, display, and source behavior with a local Astro asset.'
            : category === 'keyframe' || category === 'keyframe-step'
              ? 'Reimplement the observed animation definition or step where it affects the page.'
              : 'Audit this CSS at-rule and preserve its user-visible effect in Astro.',
      verification: 'Match the computed result in the relevant viewport and record screenshot or behavior evidence.',
      sourceSize: `declarations=${declarations};bytes=${block.raw.length}`,
    });
  });

  const cssVariables = new Map<string, { property: string; value: string; count: number }>();
  for (const style of styles) {
    for (const match of ($(style).html() ?? '').matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;}]*)/g)) {
      const property = match[1]!;
      const value = compact(match[2] ?? '');
      const key = `${property}=${value}`;
      const current = cssVariables.get(key) ?? { property, value, count: 0 };
      current.count += 1;
      cssVariables.set(key, current);
    }
  }
  for (const [index, variable] of [...cssVariables.values()].entries()) {
    add({
      id: `css-variable:${variable.property}:${index + 1}`,
      category: 'css-variable',
      priority: 'P2',
      sourceLocator: `style[*] declaration ${variable.property}`,
      sourceElement: variable.property,
      detail: JSON.stringify(variable),
      requirement: 'Preserve this design token/custom property or replace it with a documented Astro CSS variable producing the same result.',
      verification: 'Inspect the built page computed value at the responsive states where it is used.',
      sourceSize: `occurrences=${variable.count}`,
    });
  }

  sections.forEach((element, index) => {
    const node = element as Element;
    add({
      id: `section:/${index + 1}`,
      category: 'section',
      priority: 'P0',
      sourceLocator: `body section[${index + 1}] path=${cssPath($, node)}`,
      sourceElement: attr(node, 'data-framer-name') ?? `unnamed-section-${index + 1}`,
      detail: JSON.stringify({ path: cssPath($, node), attrs: selectedAttrs(node), text: directText($, node) }),
      requirement: `Rebuild section ${index + 1} in the same order with exact content, media, layout, layering, typography, responsive variants, and links.`,
      verification: 'Compare this section at desktop, tablet, and mobile and while scrolling through the full page.',
    });
  });

  headElements.forEach((element, index) => {
    const node = element as Element;
    add({
      id: `head-node:${index + 1}`,
      category: 'head-node',
      priority: 'P1',
      sourceLocator: `html head node[${index + 1}] path=${cssPath($, node)}`,
      sourceElement: node.name,
      detail: JSON.stringify({ path: cssPath($, node), attrs: selectedAttrs(node), directText: directText($, node) }),
      requirement: 'Preserve this document metadata, preload, stylesheet, title, or head-level behavior in the Astro page where it affects rendering, SEO, loading, or navigation.',
      verification: 'Inspect the built document head and confirm metadata, preload, stylesheet, title, and head-level behavior are intentional and complete.',
      sourceSize: `attributes=${Object.keys(node.attribs ?? {}).length}`,
    });
  });

  domElements.forEach((element, index) => {
    const node = element as Element;
    const style = attr(node, 'style') ?? '';
    add({
      id: `dom-node:${index + 1}`,
      category: 'dom-node',
      priority: 'P2',
      sourceLocator: `body DOM node[${index + 1}] path=${cssPath($, node)}`,
      sourceElement: node.name,
      detail: JSON.stringify({ path: cssPath($, node), attrs: selectedAttrs(node), directText: directText($, node) }),
      requirement: 'Preserve this element semantic tag, DOM order, meaningful attributes, content, responsive visibility, layout role, and inline visual properties in Astro.',
      verification: 'Compare the corresponding built element and investigate any missing node, content, visibility, or geometry difference.',
      sourceSize: `attributes=${Object.keys(node.attribs ?? {}).length};inlineStyleBytes=${style.length}`,
    });
    if (/\b(?:animation(?:-[\w-]+)?|transition(?:-[\w-]+)?)\s*:/i.test(style)) {
      add({
        id: `animation:inline-style:${index + 1}`,
        category: 'animation',
        priority: 'P0',
        sourceLocator: `body DOM node[${index + 1}].style`,
        sourceElement: attr(node, 'data-framer-name') ?? node.name,
        detail: JSON.stringify({ path: cssPath($, node), style }),
        requirement: 'Preserve this inline motion/visual state in Astro CSS or the client behavior owning the state.',
        verification: 'Check the element at rest and during the relevant interaction, scroll, or animation state.',
      });
    }
  });

  const namedGroups = new Map<string, { count: number; tags: Set<string>; paths: string[] }>();
  for (const element of namedElements) {
    const node = element as Element;
    const name = attr(node, 'data-framer-name')!;
    const current = namedGroups.get(name) ?? { count: 0, tags: new Set<string>(), paths: [] };
    current.count += 1;
    current.tags.add(node.name);
    current.paths.push(cssPath($, node));
    namedGroups.set(name, current);
  }
  for (const [name, group] of namedGroups) {
    add({
      id: `named-component:${slug(name)}`,
      category: 'named-component',
      priority: 'P1',
      sourceLocator: `body DOM data-framer-name=${name}`,
      sourceElement: name,
      detail: JSON.stringify({ name, count: group.count, tags: [...group.tags], paths: group.paths }),
      requirement: `Account for every captured ${name} instance and preserve its page-specific variants.`,
      verification: 'Confirm all occurrences are present and visually match at all responsive states.',
      sourceSize: `occurrences=${group.count}`,
    });
  }

  links.forEach((element, index) => {
    const node = element as Element;
    const href = attr(node, 'href') ?? '';
    add({
      id: `link:${index + 1}`,
      category: 'link',
      priority: 'P0',
      sourceLocator: `body anchor[${index + 1}] path=${cssPath($, node)}`,
      sourceElement: attr(node, 'data-framer-name') ?? href,
      detail: JSON.stringify({ path: cssPath($, node), href, target: attr(node, 'target') ?? '', rel: attr(node, 'rel') ?? '', text: directText($, node), attrs: node.attribs ?? {} }),
      requirement: isInternalLink(href)
        ? 'Map this captured internal link to the appropriate Astro route or local page while preserving label, target, rel, hover, and focus behavior.'
        : 'Preserve this external link, target, rel, label, and focus/hover treatment exactly.',
      verification: 'Click with mouse and keyboard; verify destination, target, rel, visible label, focus ring, and hover treatment.',
    });
  });

  const interactionElements = domElements.filter((element) => {
    const node = element as Element;
    const name = attr(node, 'data-framer-name') ?? '';
    return node.name === 'a'
      || attr(node, 'data-highlight') !== undefined
      || attr(node, 'tabindex') !== undefined
      || Object.keys(node.attribs ?? {}).some((key) => /^on/i.test(key))
      || INTERACTIVE_NAME.test(name);
  });
  interactionElements.forEach((element, index) => {
    const node = element as Element;
    add({
      id: `interaction:${index + 1}`,
      category: 'interaction',
      priority: 'P0',
      sourceLocator: `body interactive[${index + 1}] path=${cssPath($, node)}`,
      sourceElement: attr(node, 'data-framer-name') ?? attr(node, 'href') ?? node.name,
      detail: JSON.stringify({ path: cssPath($, node), tag: node.name, attrs: node.attribs ?? {}, text: directText($, node) }),
      requirement: 'Reimplement this observed interactive target in Astro/vanilla client code or a focused island, including keyboard focus, hover, click, menu, gallery, or scroll behavior implied by its attributes/name.',
      verification: 'Exercise the target with keyboard, mouse, and touch where applicable; compare every visible state and navigation result.',
    });
  });

  media.forEach((element, index) => {
    const node = element as Element;
    add({
      id: `media:${index + 1}`,
      category: 'media',
      priority: 'P0',
      sourceLocator: `body ${node.name}[${index + 1}] path=${cssPath($, node)}`,
      sourceElement: attr(node, 'src') ?? attr(node, 'poster') ?? attr(node, 'srcset') ?? node.name,
      detail: JSON.stringify({ path: cssPath($, node), tag: node.name, attrs: node.attribs ?? {} }),
      requirement: node.name === 'video'
        ? 'Preserve video source/poster, autoplay, loop, muted, playsinline, preload, crop, background, and responsive behavior in Astro.'
        : 'Preserve image/media source-set, intrinsic dimensions, loading, crop, object position, alt text, and responsive behavior in Astro.',
      verification: 'Verify media loads in the built site, matches the reference crop/aspect ratio, and behaves correctly at all three viewports.',
    });
  });

  for (const [index, reference] of [...urls.values()].sort((a, b) => a.url.localeCompare(b.url)).entries()) {
    if (embeddedAssetUrls.has(reference.url)) continue;
    const kind = assetKind(reference.url);
    add({
      id: `asset:${hash(reference.url)}`,
      category: 'asset',
      priority: kind === 'external' ? 'P1' : 'P0',
      sourceLocator: `standalone external URL[${index + 1}]`,
      sourceElement: reference.url,
      detail: JSON.stringify({ url: reference.url, references: reference.references }),
      requirement: kind === 'font'
        ? 'Localize this font or provide an equivalent local font with matching metrics; do not rely on the original site at runtime.'
        : kind === 'video'
          ? 'Localize this video and preserve playback behavior.'
          : kind === 'image'
            ? 'Localize this image and preserve crop, source-set behavior, and resolution.'
            : 'Audit this external reference and preserve its required visible result or intentional external navigation.',
      verification: 'Build with the intended local-asset strategy and verify the page still renders correctly.',
      sourceSize: `references=${reference.references.length}`,
    });
  }

  const animationRules = cssBlocks.filter((block) => /(?:animation|transition)\s*:/i.test(block.body) || /(?:animation|transition)-[\w-]+\s*:/i.test(block.body));
  animationRules.forEach((block, index) => {
    add({
      id: `animation:css-declaration:${index + 1}`,
      category: 'animation',
      priority: 'P0',
      sourceLocator: `style[${block.styleIndex + 1}] selector=${compact(block.header)}`,
      sourceElement: compact(block.header),
      detail: JSON.stringify({ header: compact(block.header), body: compact(block.body) }),
      requirement: 'Reimplement this transition/animation declaration in Astro CSS or the owning client island with equivalent timing, easing, trigger, and final state.',
      verification: 'Trigger the relevant hover, focus, load, scroll, or state change and compare motion and settled result.',
    });
  });

  const externalReferences = new Map<string, number>();
  for (const match of inventoryHtml.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    const url = normalizeUrl(match[0]);
    if (!url || urls.has(url)) continue;
    externalReferences.set(url, (externalReferences.get(url) ?? 0) + 1);
  }
  for (const [url, count] of [...externalReferences.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    add({
      id: `external-reference:${hash(url)}`,
      category: 'external-reference',
      priority: 'P2',
      sourceLocator: 'standalone full-text URL scan',
      sourceElement: url,
      detail: `Found ${count} occurrence(s) outside explicit media/link/style URL references.`,
      requirement: 'Audit this reference in the bundled source and preserve it only if it drives required visible behavior or intentional external navigation.',
      verification: 'The tracker contains a documented decision and the Astro build has no accidental dependency on the standalone file.',
      sourceSize: `occurrences=${count}`,
    });
  }

  return [HEADERS, ...rows.map((row) => [
    row.id,
    row.category,
    row.priority,
    row.status,
    row.owner,
    row.route,
    row.viewport,
    row.sourceLocator,
    row.sourceElement,
    row.detail,
    row.requirement,
    row.verification,
    row.sourceSize,
    row.notes,
  ])].map((row) => row.map(csvEscape).join(',')).join('\n') + '\n';
}

function parseEvidence(value: string): EvidenceRecord | undefined {
  if (!value.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && parsed.schemaVersion === 2 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function addEvidenceRows(
  evidence: EvidenceRecord,
  add: AddTrackerRow,
  sourceFilename: string,
  evidenceBytes: number,
): void {
  const coverage = record(evidence.coverage);
  const environment = record(evidence.environment);
  const routes = records(evidence.routes);
  const assets = records(evidence.assets);
  const viewports = records(evidence.viewports);
  const framerProject = record(evidence.framerProject);
  const failedRoutes = records(coverage.failedRoutes);
  const discoveryFailures = records(coverage.discoveryFailures);
  const failedViewports = records(coverage.failedViewports);
  const assetIssues = records(coverage.assetIssues);
  const assetWarnings = records(coverage.assetWarnings);
  const assetExclusions = records(coverage.assetExclusions);

  add({
    id: 'evidence:capsule',
    category: 'evidence-capsule',
    priority: 'P0',
    sourceLocator: `script#${RECONSTRUCTION_EVIDENCE_ID}`,
    sourceElement: RECONSTRUCTION_EVIDENCE_TYPE,
    detail: JSON.stringify({
      schemaVersion: evidence.schemaVersion,
      capturedAt: evidence.capturedAt,
      routes: routes.length,
      viewports: viewports.length,
      assets: assets.length,
      bytes: evidenceBytes,
      environment,
    }),
    requirement: 'Use this embedded schema-v2 capsule for source screenshots, computed styles, geometry, accessibility, interaction states, network evidence, diagnostics, and original asset bodies.',
    verification: 'Parse the non-executing JSON script successfully and retain its evidence until every tracker row is resolved.',
    sourceSize: `bytes=${evidenceBytes}`,
    notes: `The evidence lives inside ${sourceFilename}; it is not a page runtime or viewer.`,
  });

  if (framerProject.source === 'official-framer-server-api') {
    const projectNodes = records(record(framerProject.canvas).nodes);
    const collections = records(framerProject.collections);
    const codeFiles = records(framerProject.codeFiles);
    const projectErrors = records(framerProject.errors);
    add({
      id: 'evidence:framer-project',
      category: 'framer-project',
      priority: projectErrors.length ? 'P0' : 'P1',
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.framerProject`,
      sourceElement: 'official Framer Server API project graph',
      detail: JSON.stringify({
        projectUrl: framerProject.projectUrl,
        capturedAt: framerProject.capturedAt,
        nodes: projectNodes.length,
        collections: collections.length,
        codeFiles: codeFiles.length,
        locales: records(framerProject.locales).length,
        localizationGroups: records(framerProject.localizationGroups).length,
        redirects: records(framerProject.redirects).length,
        errors: projectErrors,
      }),
      requirement: 'Use the authorized project graph for hierarchy, component identity, responsive replicas, CMS structure, localization, redirects, and user-authored code. Use browser evidence as the authority for final rendered output.',
      verification: 'Every project resource is reconciled with the Astro implementation or has an explicit evidence-backed disposition.',
      sourceSize: `nodes=${projectNodes.length};collections=${collections.length};codeFiles=${codeFiles.length}`,
    });
    codeFiles.forEach((file, index) => add({
      id: `framer-code-file:${hash(stringValue(file.id) || `${index}`)}`,
      category: 'code-file',
      priority: 'P0',
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.framerProject.codeFiles[${index}]`,
      sourceElement: stringValue(file.path) || stringValue(file.name) || `code-file-${index + 1}`,
      detail: JSON.stringify({ id: file.id, name: file.name, path: file.path, versionId: file.versionId, exports: file.exports, bytes: Buffer.byteLength(stringValue(file.content) ?? '') }),
      requirement: 'Port the user-authored component or override behavior from this official source file without carrying Framer editor-only APIs into Astro.',
      verification: 'The target behavior matches the source and the implementation decision is recorded.',
      sourceSize: `bytes=${Buffer.byteLength(stringValue(file.content) ?? '')}`,
    }));
    projectErrors.forEach((error, index) => add({
      id: `framer-project-read-failure:${index + 1}`,
      category: 'capture-failure',
      priority: 'P0',
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.framerProject.errors[${index}]`,
      sourceElement: stringValue(error.stage) || 'project read failure',
      detail: JSON.stringify(error),
      requirement: 'Resolve or explicitly approve this missing design-time project evidence.',
      verification: 'The resource is recaptured or its absence is documented without silently inferring it.',
    }));
  }

  add({
    id: 'evidence:coverage',
    category: 'coverage',
    priority: failedRoutes.length || discoveryFailures.length || failedViewports.length || assetIssues.length ? 'P0' : 'P1',
    sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.coverage`,
    sourceElement: 'capture coverage report',
    detail: JSON.stringify({
      requestedRoutes: coverage.requestedRoutes,
      capturedRoutes: coverage.capturedRoutes,
      requestedViewports: coverage.requestedViewports,
      discoveredBreakpoints: coverage.discoveredBreakpoints,
      capturedViewportCount: coverage.capturedViewportCount,
      failedRoutes,
      discoveryFailures,
      failedViewports,
      interactionCandidates: coverage.interactionCandidates,
      interactionStatesCaptured: coverage.interactionStatesCaptured,
      assetsCaptured: coverage.assetsCaptured,
      assetBytes: coverage.assetBytes,
      uniqueAssetBlobs: coverage.uniqueAssetBlobs,
      uniqueAssetBytes: coverage.uniqueAssetBytes,
      assetIssues,
      assetWarnings,
      assetExclusions,
    }),
    requirement: failedRoutes.length || discoveryFailures.length || failedViewports.length || assetIssues.length
      ? 'Resolve every failed route, breakpoint-discovery pass, viewport, or asset capture before declaring the reconstruction complete.'
      : 'Preserve the declared route, responsive, state, and asset coverage in the Astro verification suite.',
    verification: 'The final implementation has an evidence-backed result for every required route, viewport, breakpoint probe, and captured interaction state.',
  });

  for (const [index, failure] of [...failedRoutes, ...discoveryFailures, ...failedViewports].entries()) {
    add({
      id: `capture-failure:${index + 1}`,
      category: 'capture-failure',
      priority: 'P0',
      route: stringValue(failure.url) || '/',
      viewport: JSON.stringify(failure.viewport ?? ''),
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.coverage`,
      sourceElement: 'failed capture',
      detail: JSON.stringify(failure),
      requirement: 'Recapture or explicitly resolve this missing evidence; do not silently infer the source state.',
      verification: 'A replacement capture exists or the limitation has an explicit evidence-backed disposition.',
    });
  }

  assetIssues.forEach((issue, index) => add({
    id: `asset-capture-issue:${index + 1}`,
    category: 'capture-failure',
    priority: issue.reason === 'privacy-excluded' ? 'P1' : 'P0',
    sourceLocator: stringValue(issue.url) || `asset issue ${index + 1}`,
    sourceElement: stringValue(issue.reason) || 'asset capture issue',
    detail: JSON.stringify(issue),
    requirement: issue.reason === 'privacy-excluded'
      ? 'Confirm this privacy-excluded response is not required by the target page; never copy credentials or owner-only data.'
      : 'Recapture or deliberately replace this missing asset before reconstruction is complete.',
    verification: 'The target has no accidental source dependency and every required visible asset is locally available.',
  }));

  if (assetWarnings.length > 0) add({
    id: 'evidence:source-asset-warnings',
    category: 'source-warning',
    priority: 'P2',
    sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.coverage.assetWarnings`,
    sourceElement: 'missing or unreachable source responses',
    detail: JSON.stringify(assetWarnings),
    requirement: 'Decide whether each already-missing live resource needs a deliberate replacement in the reconstruction.',
    verification: 'The reconstruction either replaces visibly required content or documents why the broken source reference has no user-visible effect.',
    sourceSize: `responses=${assetWarnings.length}`,
    notes: 'These references were already unavailable at capture time; they are source limitations, not extractor failures.',
  });

  if (assetExclusions.length > 0) add({
    id: 'evidence:privacy-exclusions',
    category: 'privacy-exclusion',
    priority: 'P2',
    sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.coverage.assetExclusions`,
    sourceElement: 'owner/auth response exclusions',
    detail: JSON.stringify(assetExclusions),
    requirement: 'Keep owner-only and authentication responses out of the reconstruction package.',
    verification: 'The target has no dependency on excluded editor/auth data and no credentials are present in the handoff.',
    sourceSize: `responses=${assetExclusions.length}`,
    notes: 'These are intentional privacy controls, not missing visible assets.',
  });

  for (const [routeIndex, route] of routes.entries()) {
    const routeName = stringValue(route.route) || '/';
    const captures = records(route.captures);
    const responsiveModels = records(route.responsiveModels);
    const trackedInteractions = new Set<string>();
    add({
      id: `route:${routeName}`,
      category: 'route',
      priority: 'P0',
      route: routeName,
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.routes[${routeIndex}]`,
      sourceElement: stringValue(route.title) || routeName,
      detail: JSON.stringify({ url: route.url, route: routeName, title: route.title, captures: captures.length }),
      requirement: `Create the Astro ${routeName} route with its complete captured content, metadata, responsive behavior, links, and states.`,
      verification: `Open ${routeName} directly at all recorded viewports and compare it against the embedded evidence.`,
      sourceSize: `captures=${captures.length}`,
    });
    if (responsiveModels.length > 0) add({
      id: `responsive-models:${routeIndex + 1}`,
      category: 'responsive-model',
      priority: 'P1',
      route: routeName,
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.routes[${routeIndex}].responsiveModels`,
      sourceElement: 'cross-width geometry models',
      detail: `Contains ${responsiveModels.length} element models with exact measurements and inferred width/position rules.`,
      requirement: 'Use the simplest CSS rule supported by the cross-width measurements; preserve breakpoint discontinuities where a single fluid rule does not fit.',
      verification: 'Target element geometry agrees with the recorded measurements across core widths and breakpoint probes.',
      sourceSize: `models=${responsiveModels.length}`,
    });
    for (const [captureIndex, capture] of captures.entries()) {
      const viewport = record(capture.viewport);
      const viewportName = stringValue(viewport.name) || `${viewport.width ?? '?'}x${viewport.height ?? '?'}`;
      const nodes = records(capture.nodes);
      const interactions = records(capture.interactions);
      const states = records(capture.states);
      const network = records(capture.network);
      const diagnostics = records(capture.diagnostics);
      const accessibilityTree = records(capture.accessibilityTree);
      add({
        id: `responsive-capture:${routeIndex + 1}:${captureIndex + 1}`,
        category: 'responsive-capture',
        priority: viewport.core === true ? 'P0' : 'P1',
        route: routeName,
        viewport: viewportName,
        sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.routes[${routeIndex}].captures[${captureIndex}]`,
        sourceElement: `${viewport.width ?? '?'}x${viewport.height ?? '?'}`,
        detail: JSON.stringify({
          viewport,
          documentSize: capture.documentSize,
          nodes: nodes.length,
          styles: Object.keys(record(capture.styleCatalog)).length,
          interactions: interactions.length,
          states: states.map((state) => ({ label: state.label, kind: state.kind, target: state.target, scrollY: state.scrollY })),
          networkRequests: network.length,
          diagnostics: diagnostics.length,
          accessibilityNodes: accessibilityTree.length,
        }),
        requirement: 'Match the source geometry, computed appearance, text wrapping, crops, and document dimensions at this exact viewport.',
        verification: 'Compare the Astro render against the embedded full-page and state screenshots and reconcile important node rectangles and computed styles.',
        sourceSize: `nodes=${nodes.length};states=${states.length};network=${network.length};ax=${accessibilityTree.length}`,
      });

      states.forEach((state, stateIndex) => add({
        id: `visual-state:${routeIndex + 1}:${captureIndex + 1}:${stateIndex + 1}`,
        category: 'visual-state',
        priority: state.kind === 'interaction' ? 'P0' : 'P1',
        route: routeName,
        viewport: viewportName,
        sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.routes[${routeIndex}].captures[${captureIndex}].states[${stateIndex}]`,
        sourceElement: stringValue(state.label) || `state-${stateIndex + 1}`,
        detail: JSON.stringify({ label: state.label, kind: state.kind, target: state.target, scrollY: state.scrollY }),
        requirement: state.kind === 'interaction'
          ? 'Reproduce this observed interactive state and its state transition in Astro.'
          : 'Preserve the source page appearance at this scroll/initial state.',
        verification: 'Capture the equivalent Astro state and compare it with the embedded PNG reference.',
      }));

      interactions.forEach((interaction, interactionIndex) => {
        const activation = record(interaction.activation);
        const interactionKey = JSON.stringify([
          interaction.path,
          interaction.kind,
          interaction.label,
          interaction.href,
          interaction.target,
          interaction.ariaHasPopup,
        ]);
        if (trackedInteractions.has(interactionKey)) return;
        trackedInteractions.add(interactionKey);
        add({
          id: `observed-interaction:${routeIndex + 1}:${hash(interactionKey)}`,
          category: 'observed-interaction',
          priority: activation.outcome === 'changed' ? 'P0' : 'P1',
          route: routeName,
          viewport: viewportName,
          sourceLocator: stringValue(interaction.path) || `interaction-${interactionIndex + 1}`,
          sourceElement: stringValue(interaction.label) || stringValue(interaction.kind) || 'interactive control',
          detail: JSON.stringify({
            kind: interaction.kind,
            href: interaction.href,
            target: interaction.target,
            ariaHasPopup: interaction.ariaHasPopup,
            ariaExpanded: interaction.ariaExpanded,
            hover: interaction.hover,
            focus: interaction.focus,
            activation,
          }),
          requirement: activation.outcome === 'changed'
            ? 'Implement the recorded hover, focus, activation, and resulting DOM/style/geometry changes.'
            : 'Preserve this control semantics, destination, keyboard focus, and observable states; document if activation was intentionally not explored for safety.',
          verification: 'Exercise this control with pointer and keyboard input and compare its state to the recorded evidence.',
          notes: 'Equivalent occurrences at other captured widths are represented by this canonical tracker row; exact per-width evidence remains in the capsule.',
        });
      });

      if (accessibilityTree.length > 0) add({
        id: `accessibility-tree:${routeIndex + 1}:${captureIndex + 1}`,
        category: 'accessibility',
        priority: 'P1',
        route: routeName,
        viewport: viewportName,
        sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.routes[${routeIndex}].captures[${captureIndex}].accessibilityTree`,
        sourceElement: 'Chromium accessibility tree',
        detail: `Captured ${accessibilityTree.length} accessibility nodes including roles, names, values, and states.`,
        requirement: 'Preserve meaningful roles, accessible names, values, focusability, and keyboard state semantics in Astro.',
        verification: 'Compare the target accessibility tree and complete keyboard navigation without inaccessible controls.',
        sourceSize: `nodes=${accessibilityTree.length}`,
      });

      diagnostics.forEach((diagnostic, diagnosticIndex) => add({
        id: `runtime-diagnostic:${routeIndex + 1}:${captureIndex + 1}:${diagnosticIndex + 1}`,
        category: 'runtime-diagnostic',
        priority: diagnostic.kind === 'page-error' ? 'P0' : 'P2',
        route: routeName,
        viewport: viewportName,
        sourceLocator: stringValue(diagnostic.url) || `capture diagnostic ${diagnosticIndex + 1}`,
        sourceElement: stringValue(diagnostic.kind) || 'diagnostic',
        detail: JSON.stringify(diagnostic),
        requirement: 'Determine whether this source diagnostic affects visible behavior; preserve the result without introducing an equivalent target error.',
        verification: 'The Astro page has no unexpected console, request, or hydration failures.',
      }));
    }
  }

  const assetsByHash = new Map<string, { asset: EvidenceRecord; indexes: number[]; paths: string[]; urls: unknown[] }>();
  assets.forEach((asset, index) => {
    const assetHash = stringValue(asset.sha256) || `asset-${index}`;
    const group = assetsByHash.get(assetHash) ?? { asset, indexes: [], paths: [], urls: [] };
    group.indexes.push(index);
    const localPath = stringValue(asset.localPath);
    if (localPath && !group.paths.includes(localPath)) group.paths.push(localPath);
    if (Array.isArray(asset.urls)) group.urls.push(...asset.urls);
    assetsByHash.set(assetHash, group);
  });
  for (const [assetHash, group] of assetsByHash) {
    const asset = group.asset;
    const kind = stringValue(asset.kind) || 'other';
    const directlyLocalizable = ['image', 'font', 'video', 'audio'].includes(kind);
    add({
      id: `embedded-asset:${hash(assetHash)}`,
      category: 'embedded-asset',
      priority: directlyLocalizable ? 'P0' : 'P1',
      sourceLocator: `#${RECONSTRUCTION_EVIDENCE_ID}.assets[${group.indexes[0]}]`,
      sourceElement: group.paths[0] || `asset-${group.indexes[0]! + 1}`,
      detail: JSON.stringify({
        urls: Array.from(new Set(group.urls.map((url) => String(url)))),
        localPaths: group.paths,
        aliases: group.indexes.length,
        blobIndex: asset.blobIndex,
        bytes: asset.bytes,
        contentType: asset.contentType,
        kind: asset.kind,
        sha256: asset.sha256,
      }),
      requirement: directlyLocalizable
        ? 'Extract this embedded asset body into the Astro project, retain the recorded hash/source mapping, and remove dependence on the source host.'
        : 'Audit this embedded source body for required CSS, data, or visible behavior. Translate only the required result; do not ship a raw platform/runtime bundle blindly.',
      verification: directlyLocalizable
        ? 'The localized asset hash matches the evidence body and the final page uses it at every applicable viewport.'
        : 'The tracker documents what was translated or why the source body is not needed, and the target has no accidental runtime dependency on it.',
      sourceSize: `bytes=${asset.bytes ?? ''}`,
      notes: group.indexes.length > 1 ? `${group.indexes.length} URL/path records share this exact body.` : '',
    });
  }
}

function isRecord(value: unknown): value is EvidenceRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown): EvidenceRecord {
  return isRecord(value) ? value : {};
}

function records(value: unknown): EvidenceRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseCssBlocks(css: string, styleIndex: number): Array<{ header: string; body: string; raw: string; depth: number; styleIndex: number }> {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const frames: Array<{ header: string; bodyStart: number; depth: number; styleIndex: number }> = [];
  const blocks: Array<{ header: string; body: string; raw: string; depth: number; styleIndex: number }> = [];
  let segmentStart = 0;
  for (let index = 0; index < clean.length; index += 1) {
    if (clean[index] === '{') {
      frames.push({ header: clean.slice(segmentStart, index).trim(), bodyStart: index + 1, depth: frames.length, styleIndex });
      segmentStart = index + 1;
    } else if (clean[index] === '}') {
      const frame = frames.pop();
      if (frame) {
        const body = clean.slice(frame.bodyStart, index);
        blocks.push({ header: frame.header, body, raw: `${frame.header}{${body}}`, depth: frame.depth, styleIndex });
      }
      segmentStart = index + 1;
    }
  }
  return blocks;
}

function collectUrls(
  $: cheerio.CheerioAPI,
  elements: Element[],
  styles: Element[],
  html: string,
): Map<string, { url: string; references: string[] }> {
  const urls = new Map<string, { url: string; references: string[] }>();
  const add = (rawUrl: string, reference: string): void => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    const current = urls.get(url) ?? { url, references: [] };
    current.references.push(reference);
    urls.set(url, current);
  };
  for (const element of elements) {
    for (const [name, value] of Object.entries(element.attribs ?? {})) {
      if (!URL_ATTRIBUTE_NAMES.has(name) || !value) continue;
      if (name.includes('srcset')) {
        for (const candidate of value.split(',')) add(candidate.trim().split(/\s+/)[0] ?? '', `${cssPath($, element)}.${name}`);
      } else add(value, `${cssPath($, element)}.${name}`);
    }
  }
  for (const element of styles) {
    const body = $(element).html() ?? '';
    for (const match of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1]!, 'style.url()');
  }
  // Keep text-level references too; runtime bundles frequently contain media or module URLs
  // that are not represented by a DOM attribute.
  for (const match of html.matchAll(/https?:\/\/[^\s"'`<>]+/g)) {
    const url = normalizeUrl(match[0]);
    if (url && !urls.has(url) && assetKind(url) !== 'external') add(url, 'standalone text URL');
  }
  return urls;
}

function normalizeUrl(value: string): string | undefined {
  let url = value.trim().replaceAll('&amp;', '&').replace(/[),;]+$/g, '');
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return undefined;
  return url;
}

function assetKind(url: string): 'font' | 'video' | 'image' | 'external' {
  if (/fonts\.(?:gstatic|googleapis)\.com|\.woff2?(?:[?#]|$)/i.test(url)) return 'font';
  if (/\.mp4(?:[?#]|$)/i.test(url)) return 'video';
  if (/framerusercontent\.com\/images|\.(?:png|jpe?g|webp|gif|svg)(?:[?#]|$)/i.test(url)) return 'image';
  return 'external';
}

function selectedAttrs(element: Element): Record<string, string> {
  const allowed = new Set(['id', 'class', 'data-framer-name', 'data-highlight', 'aria-label', 'aria-expanded', 'aria-haspopup', 'role', 'href', 'target', 'rel', 'src', 'srcset', 'poster', 'alt', 'tabindex', 'style', 'type', 'loading', 'autoplay', 'loop', 'muted', 'playsinline', 'preload', 'name', 'content', 'charset', 'property', 'http-equiv', 'as', 'crossorigin', 'media', 'integrity', 'sizes']);
  return Object.fromEntries(Object.entries(element.attribs ?? {}).filter(([key]) => allowed.has(key)).map(([key, value]) => [key, value.slice(0, 4000)]));
}

function attr(element: Element, name: string): string | undefined {
  const value = element.attribs?.[name];
  return value === undefined ? undefined : value;
}

function directText($: cheerio.CheerioAPI, element: Element): string {
  return $(element).contents().filter((_index, child) => child.type === 'text').text().replace(/\s+/g, ' ').trim().slice(0, 240);
}

function cssPath($: cheerio.CheerioAPI, element: Element): string {
  const parts: string[] = [];
  let current: Element | undefined = element;
  while (current && current.name !== 'body' && current.name !== 'html') {
    const id = attr(current, 'id');
    if (id) {
      parts.unshift(`#${id}`);
      break;
    }
    // Do not pass the raw tag name back through a CSS selector parser. Legacy
    // documents can contain namespaced/custom tags such as `pgf:pgfref`; in a
    // selector, the colon is interpreted as a pseudo-class and aborts the
    // entire package. Compare parsed node names directly instead.
    const siblings = current.parent
      ? $(current.parent).children().toArray().filter(
          (sibling): sibling is Element => sibling.type === 'tag' && sibling.name === current!.name,
        )
      : [current];
    const index = siblings.indexOf(current) + 1;
    parts.unshift(`${current.name}${siblings.length > 1 ? `:nth-of-type(${index})` : ''}`);
    current = current.parent && current.parent.type === 'tag' ? current.parent : undefined;
  }
  const root = pathRoot(element);
  return [root, ...parts].join(' > ');
}

function pathRoot(element: Element): 'html' | 'body' {
  let current: Element | undefined = element;
  while (current) {
    if (current.name === 'head' || current.name === 'html') return 'html';
    if (current.name === 'body') return 'body';
    current = current.parent && current.parent.type === 'tag' ? current.parent : undefined;
  }
  return 'body';
}

function isInternalLink(href: string): boolean {
  return href.startsWith('/') || href.startsWith('./') || href.startsWith('../') || href.includes('regent-template.framer.website');
}

function routeFromSourceUrl(sourceUrl: string): string {
  try {
    const parsed = new URL(sourceUrl);
    return `${parsed.pathname || '/'}${parsed.search}`;
  } catch {
    return '/';
  }
}

function priorityFor(category: string): string {
  if (['route', 'section', 'dom-node', 'media', 'link', 'interaction', 'animation', 'asset'].includes(category)) return 'P0';
  if (['bundle', 'bundle-part', 'font', 'media-query', 'keyframe', 'responsive-viewport', 'head-node'].includes(category)) return 'P1';
  return 'P2';
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) result = Math.imul(result ^ value.charCodeAt(index), 16777619);
  return (result >>> 0).toString(16).padStart(8, '0');
}

function compact(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function csvEscape(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
