export interface CaptureViewport {
  name: string;
  width: number;
  height: number;
  /** Why this width is part of the verification matrix. */
  source?: 'required' | 'user' | 'breakpoint-below' | 'breakpoint' | 'breakpoint-above' | 'coverage';
  /** Core viewports receive the full scroll and interaction-state pass. */
  core?: boolean;
}

export interface RectEvidence {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type StyleEvidence = Record<string, string>;

export interface PseudoElementEvidence {
  content: string;
  styleId: string;
}

export interface NodeEvidence {
  id: string;
  parentId?: string;
  domIndex: number;
  key: string;
  path: string;
  tag: string;
  role?: string;
  accessibleName?: string;
  focusable?: boolean;
  tabIndex?: number;
  directText?: string;
  textContent?: string;
  attributes: Record<string, string>;
  rect: RectEvidence;
  styleId: string;
  before?: PseudoElementEvidence;
  after?: PseudoElementEvidence;
  media?: {
    currentSrc?: string;
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
  };
}

export interface InteractionStateChange {
  nodePath: string;
  changes: Record<string, { from: string; to: string }>;
}

export interface InteractionEvidence {
  nodeId: string;
  domIndex: number;
  path: string;
  kind: string;
  label?: string;
  href?: string;
  target?: string;
  inputType?: string;
  ariaHasPopup?: string;
  ariaExpanded?: string;
  ariaPressed?: string;
  ariaSelected?: string;
  hover?: InteractionStateChange[];
  focus?: InteractionStateChange[];
  activation?: {
    attempted: boolean;
    outcome: 'changed' | 'no-observable-change' | 'skipped-unsafe' | 'failed';
    changes?: InteractionStateChange[];
    screenshotLabel?: string;
    error?: string;
  };
}

export interface RuntimeDiagnostic {
  kind: 'console' | 'page-error' | 'request-failed' | 'capture-warning';
  level?: string;
  message: string;
  url?: string;
}

export interface NetworkEvidence {
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  contentType?: string;
  fromServiceWorker?: boolean;
  failure?: string;
}

export interface AccessibilityNodeEvidence {
  nodeId: string;
  ignored?: boolean;
  role?: string;
  name?: string;
  description?: string;
  value?: string;
  properties?: Record<string, unknown>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface AnimationEvidence {
  source: 'web-animation' | 'runtime-call';
  target?: string;
  targetNodeId?: string;
  playState?: string;
  currentTime?: number | null;
  startTime?: number | null;
  playbackRate?: number;
  timing?: Record<string, unknown>;
  keyframes?: Array<Record<string, unknown>>;
  options?: unknown;
}

export interface FontEvidence {
  family: string;
  style: string;
  weight: string;
  stretch: string;
  status: string;
}

export interface StylesheetEvidence {
  href?: string;
  media?: string;
  cssText?: string;
  inaccessible?: boolean;
}

export interface ViewportEvidence {
  viewport: CaptureViewport;
  screenshotPath: string;
  documentSize: { width: number; height: number };
  colorScheme: string;
  rootCustomProperties: Record<string, string>;
  styleCatalog: Record<string, StyleEvidence>;
  nodes: NodeEvidence[];
  interactions: InteractionEvidence[];
  animations: AnimationEvidence[];
  accessibilityTree?: AccessibilityNodeEvidence[];
  network: NetworkEvidence[];
  diagnostics: RuntimeDiagnostic[];
}

export interface CapturedViewportEvidence extends ViewportEvidence {
  screenshot: Buffer;
  stateScreenshots: Array<{
    label: string;
    scrollY: number;
    path: string;
    screenshot: Buffer;
    kind?: 'initial' | 'scroll' | 'interaction';
    target?: string;
  }>;
}

export interface PageReconstructionEvidence {
  url: string;
  route: string;
  title: string;
  language?: string;
  description?: string;
  cleanDom: string;
  stylesheets: StylesheetEvidence[];
  fonts: FontEvidence[];
  cssKeyframes: string[];
  mediaQueries: string[];
  framerAppearPayloads: string[];
  viewports: CapturedViewportEvidence[];
}

export interface ReconstructionCapture {
  capturedAt: string;
  viewports: CaptureViewport[];
  pages: PageReconstructionEvidence[];
  coverage: {
    requestedRoutes: string[];
    capturedRoutes: string[];
    failedRoutes: Array<{ url: string; reason: string }>;
    discoveryFailures: Array<{ url: string; reason: string }>;
    requestedViewports: CaptureViewport[];
    discoveredBreakpoints: number[];
    capturedViewportCount: number;
    failedViewports: Array<{ url: string; viewport: CaptureViewport; reason: string }>;
    interactionCandidates: number;
    interactionStatesCaptured: number;
    assetsCaptured: number;
    assetBytes: number;
    /** Unique body totals after content-hash deduplication in the evidence capsule. */
    uniqueAssetBlobs?: number;
    uniqueAssetBytes?: number;
    assetIssues: Array<{ url: string; reason: string; detail?: string }>;
    /** Referenced resources missing or unreachable on the live source. */
    assetWarnings?: Array<{ url: string; reason: string; detail?: string }>;
    /** Intentionally omitted owner/auth responses. These are policy decisions, not failures. */
    assetExclusions?: Array<{ url: string; reason: string; detail?: string }>;
  };
  environment: {
    browser: string;
    userAgent: string;
    platform: string;
    locale: string;
    timezone: string;
    colorScheme?: string;
    reducedMotion: string;
  };
}

export interface ReconstructionAsset {
  urls: string[];
  localPath: string;
  bytes: number;
  contentType: string;
  kind: 'image' | 'font' | 'video' | 'audio' | 'css' | 'javascript' | 'data' | 'other';
  sha256: string;
}

export interface DesignTokenSummary {
  colors: Array<{ value: string; uses: number }>;
  fontFamilies: Array<{ value: string; uses: number }>;
  fontSizes: Array<{ value: string; uses: number }>;
  fontWeights: Array<{ value: string; uses: number }>;
  spacing: Array<{ value: string; uses: number }>;
  radii: Array<{ value: string; uses: number }>;
  shadows: Array<{ value: string; uses: number }>;
}
