import type { Box, DesignNode, DomNode } from '../types.js';
import { area, intersection } from '../diff/regions.js';

interface HasBox {
  box: Box;
}

/**
 * Picks the element that best explains a diff region:
 * the smallest element covering most of the region, otherwise the best overlap (IoU).
 */
function bestMatch<T extends HasBox>(region: Box, items: T[], boxOf: (t: T) => Box = (t) => t.box): T | undefined {
  const ra = area(region);
  if (!ra) return undefined;
  let containing: { item: T; a: number } | undefined;
  let bestIou: { item: T; iou: number } | undefined;
  for (const item of items) {
    const b = boxOf(item);
    const inter = intersection(region, b);
    if (!inter) continue;
    const ba = area(b);
    if (inter >= 0.7 * ra && (!containing || ba < containing.a)) containing = { item, a: ba };
    const iou = inter / (ra + ba - inter);
    if (!bestIou || iou > bestIou.iou) bestIou = { item, iou };
  }
  return containing?.item ?? bestIou?.item;
}

export function locateDom(region: Box, dom: DomNode[]): DomNode | undefined {
  // Ignore the page wrappers; they always "contain" everything.
  const candidates = dom.filter((n) => n.tag !== 'body' && n.tag !== 'html');
  return bestMatch(region, candidates);
}

/** Leaf-most elements lying mostly (>= 60%) inside the region, top to bottom. */
export function elementsInside(region: Box, dom: DomNode[], limit = 6): DomNode[] {
  const inside = dom.filter((n) => {
    const a = area(n.box);
    return a > 0 && n.tag !== 'body' && intersection(region, n.box) >= 0.6 * a;
  });
  // Drop elements whose child is also in the list (keep the most specific ones).
  const leaf = inside.filter(
    (n) => !inside.some((m) => m !== n && m.depth > n.depth && intersection(m.box, n.box) >= 0.95 * area(m.box)),
  );
  return leaf.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x).slice(0, limit);
}

export function scaleBox(b: Box, s: number): Box {
  return { x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s };
}

/** `scale` converts design 1x coordinates into live page pixels. */
export function locateDesign(region: Box, nodes: DesignNode[], scale: number): DesignNode | undefined {
  const candidates = nodes.filter((n) => n.depth > 0);
  return bestMatch(region, candidates, (n) => scaleBox(n.box, scale));
}
