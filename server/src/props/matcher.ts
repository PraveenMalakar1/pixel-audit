import type { Box, DesignNode, DomNode } from '../types.js';
import { area, intersection } from '../diff/regions.js';
import { isTransparent } from './color.js';

export interface Pair {
  design: DesignNode;
  dom: DomNode;
  how: 'text' | 'box';
  /** Where the Figma layer would sit in the build screenshot (page px). */
  liveBox: Box;
  score: number;
}

/** Inverts the build→design row map: for each design row, the build row it ended up at. */
export function designToLiveRows(liveToDesign: Int32Array, designHeight: number): Int32Array {
  const d2l = new Int32Array(designHeight).fill(-1);
  for (let j = 0; j < liveToDesign.length; j++) {
    const i = liveToDesign[j];
    if (i >= 0 && i < designHeight && d2l[i] < 0) d2l[i] = j;
  }
  // Design rows with no build row (removed content/space) collapse onto the previous matched row.
  let last = 0;
  for (let i = 0; i < designHeight; i++) {
    if (d2l[i] >= 0) last = d2l[i];
    else d2l[i] = last;
  }
  return d2l;
}

/** Figma 1x box → build page box, following the row alignment for the vertical position. */
export function designBoxToLive(b: Box, scale: number, d2l: Int32Array): Box {
  const clampRow = (y: number) => Math.max(0, Math.min(d2l.length - 1, Math.round(y)));
  const top = d2l[clampRow(b.y * scale)];
  return { x: b.x * scale, y: top, width: b.width * scale, height: b.height * scale };
}

export function normText(s: string | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function textKey(s: string | undefined): string {
  return normText(s).slice(0, 60);
}

const center = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const dist = (a: Box, b: Box) => {
  const ca = center(a), cb = center(b);
  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
};

/** Layers worth comparing as boxes: they carry visible styling of their own. */
const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'STAR', 'POLYGON', 'ELLIPSE']);
export const SVG_TAGS = new Set(['svg', 'path', 'rect', 'circle', 'g', 'line', 'polyline', 'polygon', 'ellipse', 'use']);

function isStyledBox(n: DesignNode, frame: Box): boolean {
  if (n.type === 'TEXT' || n.depth === 0 || VECTOR_TYPES.has(n.type)) return false;
  if (n.box.width < 12 || n.box.height < 12) return false;
  if (n.box.width >= frame.width * 0.98 && n.box.height >= frame.height * 0.5) return false;
  return !!(n.fill || n.stroke || n.cornerRadius || n.effects?.length || n.padding);
}

/**
 * Pairs Figma layers with DOM elements.
 *  1. Text layers ↔ elements with the same text (nearest one wins when text repeats).
 *  2. Styled boxes ↔ the element whose box overlaps best (IoU ≥ 0.7); among near-equal
 *     candidates `prefer` picks the one that matches best (e.g. the wrapper that has the radius).
 */
export function matchNodes(
  nodes: DesignNode[],
  dom: DomNode[],
  scale: number,
  d2l: Int32Array,
  prefer: (d: DesignNode, el: DomNode) => number = () => 0,
): { pairs: Pair[]; unmatchedText: DesignNode[]; unmatchedDomText: DomNode[] } {
  const frame = nodes.find((n) => n.depth === 0)?.box ?? { x: 0, y: 0, width: 1e9, height: 1e9 };
  const live = new Map<DesignNode, Box>();
  for (const n of nodes) live.set(n, designBoxToLive(n.box, scale, d2l));

  const pairs: Pair[] = [];
  const usedDom = new Set<DomNode>();
  const usedDesign = new Set<DesignNode>();

  // 1. Text.
  const domByText = new Map<string, DomNode[]>();
  for (const el of dom) {
    if (!el.text) continue;
    const k = textKey(el.text);
    if (k.length < 2) continue;
    domByText.set(k, [...(domByText.get(k) ?? []), el]);
  }
  const textNodes = nodes.filter((n) => n.type === 'TEXT' && n.text && textKey(n.text).length >= 2);
  const candidates: { d: DesignNode; el: DomNode; dd: number; cost: number }[] = [];
  const firstLine = (s: string | undefined) => textKey((s ?? '').split('\n')[0]);
  for (const d of textNodes) {
    const k = textKey(d.text);
    let els = domByText.get(k) ?? [];
    // Multi-line Figma text is often split into one element per line on the page: match the first line.
    if (!els.length && d.text!.includes('\n')) els = domByText.get(firstLine(d.text)) ?? [];
    if (!els.length && k.length >= 20) {
      // Long text split differently (e.g. extra punctuation): compare the first 20 chars.
      for (const [dk, list] of domByText) if (dk.length >= 20 && dk.slice(0, 20) === k.slice(0, 20)) els = els.concat(list);
    }
    for (const el of els) {
      const dd = dist(live.get(d)!, el.box);
      // Same words can be a heading and a link ("About Us"): prefer the one whose style matches.
      const fs = parseFloat(el.styles['font-size'] ?? '');
      const fw = parseFloat(el.styles['font-weight'] ?? '');
      const styleCost =
        (d.font?.size && Number.isFinite(fs) ? Math.abs(fs - d.font.size) * 12 : 0) +
        (d.font?.weight && Number.isFinite(fw) ? Math.abs(fw - d.font.weight) * 0.15 : 0);
      candidates.push({ d, el, dd, cost: dd + styleCost });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  for (const c of candidates) {
    if (usedDom.has(c.el) || usedDesign.has(c.d) || c.dd > 600) continue;
    usedDom.add(c.el);
    usedDesign.add(c.d);
    pairs.push({ design: c.d, dom: c.el, how: 'text', liveBox: live.get(c.d)!, score: c.dd });
  }
  // The other lines of a matched multi-line text are covered too (not "extra" content).
  for (const p of pairs) {
    if (!p.design.text?.includes('\n')) continue;
    const lines = new Set(p.design.text.split('\n').map((l) => textKey(l)));
    for (const el of dom) {
      if (!usedDom.has(el) && el.text && lines.has(textKey(el.text)) && dist(el.box, p.dom.box) < 200) usedDom.add(el);
    }
  }

  // 2. Styled boxes.
  const boxCands: { d: DesignNode; el: DomNode; iou: number; pref: number }[] = [];
  for (const d of nodes) {
    if (!isStyledBox(d, frame)) continue;
    const lb = live.get(d)!;
    const la = area(lb);
    const list: { el: DomNode; iou: number }[] = [];
    for (const el of dom) {
      if (el.tag === 'body' || el.tag === 'html' || SVG_TAGS.has(el.tag)) continue;
      const inter = intersection(lb, el.box);
      if (!inter) continue;
      const iou = inter / (la + area(el.box) - inter);
      if (iou >= 0.7) list.push({ el, iou });
    }
    if (!list.length) continue;
    const best = Math.max(...list.map((x) => x.iou));
    for (const x of list) if (x.iou >= best - 0.03) boxCands.push({ d, el: x.el, iou: x.iou, pref: prefer(d, x.el) });
  }
  boxCands.sort((a, b) => b.pref - a.pref || b.iou - a.iou);
  for (const c of boxCands) {
    if (usedDesign.has(c.d) || usedDom.has(c.el)) continue;
    usedDom.add(c.el);
    usedDesign.add(c.d);
    pairs.push({ design: c.d, dom: c.el, how: 'box', liveBox: live.get(c.d)!, score: c.iou });
  }

  const unmatchedText = textNodes.filter((n) => !usedDesign.has(n));
  const unmatchedDomText = dom.filter((el) => el.text && textKey(el.text).length >= 2 && !usedDom.has(el));
  return { pairs, unmatchedText, unmatchedDomText };
}

const LEAF_TAGS = new Set(['img', 'svg', 'input', 'select', 'textarea', 'video', 'picture', 'canvas', 'iframe']);

/** Bounds of the visible content inside an element (text and media), for comparing padding/insets. */
export function domContentBounds(el: DomNode, dom: DomNode[]): Box | undefined {
  let u: Box | undefined;
  for (const n of dom) {
    if (n.depth <= el.depth) continue;
    if (!(n.text || LEAF_TAGS.has(n.tag))) continue;
    if (intersection(n.box, el.box) < 0.95 * area(n.box)) continue;
    u = u ? unionBox(u, n.box) : n.box;
  }
  return u;
}

/** Bounds of the visible content inside a Figma frame: text and leaf layers, ignoring full-size backgrounds. */
export function figmaContentBounds(d: DesignNode, children: Map<string, DesignNode[]>): Box | undefined {
  let u: Box | undefined;
  const fullSize = (n: DesignNode) => n.box.width >= d.box.width * 0.95 && n.box.height >= d.box.height * 0.95;
  const walk = (id: string) => {
    for (const c of children.get(id) ?? []) {
      const kids = children.get(c.id);
      if (c.type === 'TEXT' || ((!kids || !kids.length) && !fullSize(c))) u = u ? unionBox(u, c.box) : c.box;
      else walk(c.id);
    }
  };
  walk(d.id);
  return u;
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/**
 * Background seen across this element's box: its own, else a same-size child or wrapper that
 * paints it (e.g. a card inside a grid cell), else the nearest ancestor's (`fallback`).
 */
export function visibleBackground(el: DomNode, dom: DomNode[], fallback: string | undefined): string | undefined {
  if (!isTransparent(el.styles['background-color'])) return el.styles['background-color'];
  for (const n of dom) {
    if (n === el || isTransparent(n.styles['background-color'])) continue;
    const inter = intersection(n.box, el.box);
    if (inter && inter / (area(n.box) + area(el.box) - inter) >= 0.9) return n.styles['background-color'];
  }
  return fallback;
}

/** First non-zero border-radius on the element or on wrappers/children with (almost) the same box. */
export function visibleRadius(el: DomNode, dom: DomNode[]): string | undefined {
  if ((parseFloat(el.styles['border-radius'] ?? '0') || 0) > 0) return el.styles['border-radius'];
  for (const n of dom) {
    const inter = intersection(n.box, el.box);
    if (!inter || inter / (area(n.box) + area(el.box) - inter) < 0.85) continue;
    if ((parseFloat(n.styles['border-radius'] ?? '0') || 0) > 0) return n.styles['border-radius'];
  }
  return undefined;
}

/** Largest border on the element or on wrappers/children with (almost) the same box. */
export function visibleBorder(el: DomNode, dom: DomNode[]): { width: number; color?: string } {
  let best = { width: 0, color: undefined as string | undefined };
  for (const n of dom) {
    const inter = intersection(n.box, el.box);
    if (!inter || inter / (area(n.box) + area(el.box) - inter) < 0.85) continue;
    for (const side of ['top', 'right', 'bottom', 'left']) {
      const w = parseFloat(n.styles[`border-${side}-width`] ?? '0') || 0;
      if (w > best.width) best = { width: w, color: n.styles[`border-${side === 'bottom' ? 'bottom' : 'top'}-color`] };
    }
  }
  return best;
}

/**
 * The background actually visible behind each element: its own, or the nearest
 * ancestor's (by containment and depth) when its own is transparent.
 */
export function effectiveBackgrounds(dom: DomNode[]): Map<DomNode, string> {
  const withBg = dom.filter((n) => !isTransparent(n.styles['background-color']));
  const out = new Map<DomNode, string>();
  for (const n of dom) {
    if (!isTransparent(n.styles['background-color'])) {
      out.set(n, n.styles['background-color']);
      continue;
    }
    let best: DomNode | undefined;
    for (const a of withBg) {
      if (a.depth >= n.depth) continue;
      if (intersection(a.box, n.box) < 0.95 * area(n.box)) continue;
      if (!best || a.depth > best.depth) best = a;
    }
    out.set(n, best?.styles['background-color'] ?? 'rgb(255, 255, 255)');
  }
  return out;
}
