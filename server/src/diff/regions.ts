import type { Box } from '../types.js';

export interface RegionOptions {
  /** Grid cell size in px used to group nearby differing pixels. */
  cell?: number;
  /** A cell counts as "different" when it has at least this many differing pixels. */
  minCellPixels?: number;
  /** Cells this many empty cells apart are still joined into one region. */
  gap?: number;
  /** Regions with fewer differing pixels are dropped as noise. */
  minPixels?: number;
  /** Maximum number of regions returned (largest first). */
  max?: number;
}

export interface RawRegion {
  box: Box;
  pixels: number;
}

/**
 * Groups a per-pixel difference mask (1 = different) into rectangles.
 * Pure function, so it is easy to unit-test.
 */
export function findRegions(mask: Uint8Array, width: number, height: number, opts: RegionOptions = {}): RawRegion[] {
  const cell = opts.cell ?? 8;
  const minCellPixels = opts.minCellPixels ?? 2;
  const gap = opts.gap ?? 0;
  const minPixels = opts.minPixels ?? 12;
  const max = opts.max ?? 40;

  const gw = Math.ceil(width / cell);
  const gh = Math.ceil(height / cell);
  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const crow = Math.floor(y / cell) * gw;
    for (let x = 0; x < width; x++) {
      if (mask[row + x]) counts[crow + Math.floor(x / cell)]++;
    }
  }

  const seen = new Uint8Array(gw * gh);
  const reach = gap + 1;
  const regions: RawRegion[] = [];

  for (let start = 0; start < counts.length; start++) {
    if (seen[start] || counts[start] < minCellPixels) continue;
    // Flood fill over "hot" cells, joining cells within `reach`.
    const stack = [start];
    seen[start] = 1;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, pixels = 0;
    while (stack.length) {
      const c = stack.pop()!;
      const cx = c % gw;
      const cy = (c - cx) / gw;
      pixels += counts[c];
      if (cx < minX) minX = cx;
      if (cy < minY) minY = cy;
      if (cx > maxX) maxX = cx;
      if (cy > maxY) maxY = cy;
      for (let dy = -reach; dy <= reach; dy++) {
        const ny = cy + dy;
        if (ny < 0 || ny >= gh) continue;
        for (let dx = -reach; dx <= reach; dx++) {
          const nx = cx + dx;
          if (nx < 0 || nx >= gw) continue;
          const n = ny * gw + nx;
          if (!seen[n] && counts[n] >= minCellPixels) {
            seen[n] = 1;
            stack.push(n);
          }
        }
      }
    }
    if (pixels < minPixels) continue;

    // Tighten the box to the actual differing pixels.
    const x0 = minX * cell, y0 = minY * cell;
    const x1 = Math.min(width, (maxX + 1) * cell), y1 = Math.min(height, (maxY + 1) * cell);
    let tx0 = x1, ty0 = y1, tx1 = x0, ty1 = y0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (mask[y * width + x]) {
          if (x < tx0) tx0 = x;
          if (y < ty0) ty0 = y;
          if (x > tx1) tx1 = x;
          if (y > ty1) ty1 = y;
        }
      }
    }
    regions.push({ box: { x: tx0, y: ty0, width: tx1 - tx0 + 1, height: ty1 - ty0 + 1 }, pixels });
  }

  return mergeOverlapping(regions, 2)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, max);
}

export function intersection(a: Box, b: Box): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function area(b: Box): number {
  return Math.max(0, b.width) * Math.max(0, b.height);
}

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function pad(b: Box, p: number): Box {
  return { x: b.x - p, y: b.y - p, width: b.width + 2 * p, height: b.height + 2 * p };
}

/** Repeatedly merges regions whose (padded) boxes touch. */
export function mergeOverlapping(regions: RawRegion[], padding: number): RawRegion[] {
  const list = regions.map((r) => ({ ...r, box: { ...r.box } }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (intersection(pad(list[i].box, padding), list[j].box) > 0) {
          list[i] = { box: union(list[i].box, list[j].box), pixels: list[i].pixels + list[j].pixels };
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}
