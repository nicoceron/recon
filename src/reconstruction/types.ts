export interface CaptureViewport {
  name: string;
  width: number;
  height: number;
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
  hover?: InteractionStateChange[];
  focus?: InteractionStateChange[];
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
}

export interface CapturedViewportEvidence extends ViewportEvidence {
  screenshot: Buffer;
  stateScreenshots: Array<{
    label: string;
    scrollY: number;
    path: string;
    screenshot: Buffer;
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
