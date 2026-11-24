/** Rectangle in pixels. For live pages it is page coordinates (not viewport). */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Severity = 'high' | 'medium' | 'low';

export type IssueType =
  | 'layout'
  | 'spacing'
  | 'size'
  | 'color'
  | 'typography'
  | 'shape'
  | 'content'
  | 'missing'
  | 'extra'
  | 'image'
  | 'other';

/** One layer from the Figma frame, flattened. Box is relative to the frame, at 1x. */
export interface DesignNode {
  id: string;
  name: string;
  type: string;
  depth: number;
  parentId?: string;
  box: Box;
  text?: string;
  fill?: string;
  stroke?: string;
  strokeWeight?: number;
  cornerRadius?: number | number[];
  opacity?: number;
  font?: {
    family?: string;
    size?: number;
    weight?: number;
    lineHeight?: number;
    letterSpacing?: number;
  };
  padding?: { top: number; right: number; bottom: number; left: number };
  itemSpacing?: number;
  effects?: string[];
}

/** One visible element from the live page. */
export interface DomNode {
  selector: string;
  tag: string;
  depth: number;
  text?: string;
  box: Box;
  styles: Record<string, string>;
}

/** An area where design and live pixels differ. */
export interface DiffRegion {
  id: string;
  box: Box;
  /** Number of differing pixels inside the box. */
  pixels: number;
  /** pixels / box area (0..1). */
  density: number;
  /**
   * "shifted": same content, moved by `shift` px (often a side effect of a size change elsewhere).
   * "changed": the content itself differs (colour, font, shape, missing/extra element).
   */
  kind: 'shifted' | 'changed';
  /** residual: share of differences left after undoing the shift (> 0 means something else changed too). */
  shift?: { dx: number; dy: number; residual: number };
  /** Elements that sit mostly inside this region (useful when the region spans several). */
  elements?: { selector: string; tag: string; text?: string }[];
  /** Most likely live element under this region. */
  dom?: { selector: string; tag: string; text?: string };
  /** Most likely Figma layer under this region. */
  design?: { id: string; name: string; type: string; text?: string };
}

/** A confirmed visual issue (written by Claude, painted by `annotate`). */
export interface Issue {
  id?: string;
  title: string;
  type: IssueType;
  severity: Severity;
  /** Location on the live screenshot (page coordinates). */
  box: Box;
  selector?: string;
  designLayer?: string;
  expected?: string;
  actual?: string;
  fix?: string;
  /** Code the developer can apply (CSS / Tailwind / JSX before → after). Shown as a code block. */
  code?: string;
}

export interface DesignMeta {
  designId: string;
  source: 'figma' | 'image';
  name: string;
  /** Frame width/height at 1x (CSS pixels). */
  width: number;
  height: number;
  /** Export scale of design.png (2 = retina export). */
  scale: number;
  figmaUrl?: string;
  fileKey?: string;
  nodeId?: string;
  nodeCount: number;
  createdAt: string;
}

export interface CaptureMeta {
  captureId: string;
  url: string;
  title: string;
  viewportWidth: number;
  viewportHeight: number;
  pageWidth: number;
  pageHeight: number;
  domCount: number;
  createdAt: string;
}

export interface RunMeta {
  runId: string;
  designId: string;
  captureId: string;
  pageUrl: string;
  figmaUrl?: string;
  designName: string;
  width: number;
  height: number;
  /** Heights after scaling the design to the build width; a big gap means layout drift. */
  designHeight: number;
  liveHeight: number;
  /** live px per design 1x px. */
  designToLiveScale: number;
  threshold: number;
  mismatchedPixels: number;
  diffRatio: number;
  regionCount: number;
  createdAt: string;
}
