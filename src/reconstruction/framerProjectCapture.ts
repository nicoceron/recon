import type { Framer } from 'framer-api';
import { logger } from '../utils/logger.js';

export interface FramerProjectEvidence {
  schemaVersion: 1;
  source: 'official-framer-server-api';
  projectUrl: string;
  capturedAt: string;
  projectInfo?: unknown;
  publishInfo?: unknown;
  canvas?: {
    rootId?: string;
    nodes: unknown[];
  };
  collections: unknown[];
  codeFiles: unknown[];
  customCode?: unknown;
  locales: unknown[];
  defaultLocale?: unknown;
  localizationGroups: unknown[];
  redirects: unknown[];
  colorStyles: unknown[];
  textStyles: unknown[];
  variables: unknown[];
  errors: Array<{ stage: string; message: string }>;
}

const MAX_PROJECT_NODES = 25_000;

/**
 * Read-only enrichment for projects the user controls. The published browser
 * capture remains authoritative for rendered output; this graph preserves the
 * designer's structure, CMS, localization, and user-authored code.
 */
export async function captureFramerProject(
  projectUrl: string,
  apiKey?: string,
): Promise<FramerProjectEvidence> {
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error('Official Framer Server API enrichment requires Node.js 22 or newer.');
  }
  const { connect } = await import('framer-api').catch((error) => {
    throw new Error(`Official Framer project enrichment is unavailable; install the optional framer-api dependency. ${(error as Error).message}`);
  });
  const framer = await connect(projectUrl, apiKey || undefined);
  const evidence: FramerProjectEvidence = {
    schemaVersion: 1,
    source: 'official-framer-server-api',
    projectUrl,
    capturedAt: new Date().toISOString(),
    collections: [],
    codeFiles: [],
    locales: [],
    localizationGroups: [],
    redirects: [],
    colorStyles: [],
    textStyles: [],
    variables: [],
    errors: [],
  };
  const read = async <T>(stage: string, operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await operation();
    } catch (error) {
      const message = (error as Error).message;
      evidence.errors.push({ stage, message });
      logger.warn({ stage, err: message }, 'framer-project-evidence-read-failed');
      return undefined;
    }
  };

  try {
    const [projectInfo, publishInfo, customCode, locales, defaultLocale, localizationGroups, redirects, colorStyles, textStyles] = await Promise.all([
      read('project-info', () => framer.getProjectInfo()),
      read('publish-info', () => framer.getPublishInfo()),
      read('custom-code', () => framer.getCustomCode()),
      read('locales', () => framer.getLocales()),
      read('default-locale', () => framer.getDefaultLocale()),
      read('localization-groups', () => framer.getLocalizationGroups()),
      read('redirects', () => framer.getRedirects()),
      read('color-styles', () => framer.getColorStyles()),
      read('text-styles', () => framer.getTextStyles()),
    ]);
    evidence.projectInfo = serializeInspectable(projectInfo);
    evidence.publishInfo = serializeInspectable(publishInfo);
    evidence.customCode = serializeInspectable(customCode);
    evidence.locales = serializeArray(locales);
    evidence.defaultLocale = serializeInspectable(defaultLocale);
    evidence.localizationGroups = serializeArray(localizationGroups);
    evidence.redirects = serializeArray(redirects);
    evidence.colorStyles = serializeArray(colorStyles);
    evidence.textStyles = serializeArray(textStyles);

    const variables = await readOptionalArrayMethod(framer, 'getVariables', evidence.errors);
    evidence.variables = serializeArray(variables);

    const root = await read('canvas-root', () => framer.getCanvasRoot());
    if (root) evidence.canvas = await captureCanvasTree(root, evidence.errors);

    const collections = await read('collections', () => framer.getCollections());
    if (collections) {
      evidence.collections = await Promise.all(collections.map(async (collection) => {
        const [fields, items] = await Promise.all([
          read(`collection:${collection.id}:fields`, () => collection.getFields()),
          read(`collection:${collection.id}:items`, () => collection.getItems()),
        ]);
        return {
          ...recordFromInspectable(collection),
          fields: serializeArray(fields),
          items: serializeArray(items),
        };
      }));
    }

    const codeFiles = await read('code-files', () => framer.getCodeFiles());
    if (codeFiles) {
      evidence.codeFiles = codeFiles.map((file) => ({
        id: file.id,
        name: file.name,
        path: file.path,
        content: file.content,
        exports: serializeInspectable(file.exports),
        versionId: file.versionId,
      }));
    }

    logger.info({
      projectUrl,
      nodes: evidence.canvas?.nodes.length ?? 0,
      collections: evidence.collections.length,
      codeFiles: evidence.codeFiles.length,
      errors: evidence.errors.length,
    }, 'framer-project-evidence-captured');
    return evidence;
  } finally {
    await framer.disconnect().catch(() => undefined);
  }
}

async function captureCanvasTree(
  root: Awaited<ReturnType<Framer['getCanvasRoot']>>,
  errors: Array<{ stage: string; message: string }>,
): Promise<{ rootId?: string; nodes: unknown[] }> {
  const nodes: unknown[] = [];
  const queue: Array<{ node: typeof root | Awaited<ReturnType<typeof root.getChildren>>[number]; parentId?: string }> = [{ node: root }];
  while (queue.length > 0 && nodes.length < MAX_PROJECT_NODES) {
    const entry = queue.shift()!;
    const node = entry.node;
    let children: Awaited<ReturnType<typeof root.getChildren>> = [];
    let rect: unknown;
    try {
      [children, rect] = await Promise.all([node.getChildren(), node.getRect()]);
    } catch (error) {
      errors.push({ stage: `canvas-node:${node.id}`, message: (error as Error).message });
    }
    nodes.push({
      type: node.constructor.name,
      parentId: entry.parentId,
      childIds: children.map((child) => child.id),
      rect: serializeInspectable(rect),
      attributes: recordFromInspectable(node),
    });
    for (const child of children) queue.push({ node: child, parentId: node.id });
  }
  if (queue.length > 0) {
    errors.push({ stage: 'canvas-tree', message: `Node limit ${MAX_PROJECT_NODES} reached with ${queue.length} nodes still queued.` });
  }
  return { rootId: root.id, nodes };
}

async function readOptionalArrayMethod(
  framer: Framer,
  method: string,
  errors: Array<{ stage: string; message: string }>,
): Promise<unknown[]> {
  const candidate = (framer as unknown as Record<string, unknown>)[method];
  if (typeof candidate !== 'function') return [];
  try {
    const result: unknown = await candidate.call(framer);
    return Array.isArray(result) ? result : [];
  } catch (error) {
    errors.push({ stage: method, message: (error as Error).message });
    return [];
  }
}

function serializeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((item) => serializeInspectable(item)) : [];
}

function recordFromInspectable(value: unknown): Record<string, unknown> {
  const serialized = serializeInspectable(value);
  return serialized && typeof serialized === 'object' && !Array.isArray(serialized)
    ? serialized as Record<string, unknown>
    : {};
}

function serializeInspectable(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value instanceof Date) return value.toISOString();
  if (depth >= 10) return '[maximum serialization depth reached]';
  if (typeof value !== 'object') return String(value);
  if (seen.has(value)) return '[circular reference]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => serializeInspectable(item, depth + 1, seen));
  if (value instanceof Map) return Object.fromEntries([...value].map(([key, item]) => [String(key), serializeInspectable(item, depth + 1, seen)]));
  if (value instanceof Set) return [...value].map((item) => serializeInspectable(item, depth + 1, seen));

  const result: Record<string, unknown> = {};
  const keys = new Set<string>(Object.keys(value));
  let prototype: object | null = Object.getPrototypeOf(value);
  while (prototype && prototype !== Object.prototype) {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype))) {
      if (key !== 'constructor' && descriptor.get) keys.add(key);
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  for (const key of keys) {
    if (key.startsWith('_') || /engine|token|secret|password/i.test(key)) continue;
    try {
      const item = (value as Record<string, unknown>)[key];
      if (typeof item === 'function') continue;
      const serialized = serializeInspectable(item, depth + 1, seen);
      if (serialized !== undefined) result[key] = serialized;
    } catch {
      // A trait getter may be unavailable for this node kind.
    }
  }
  return result;
}
