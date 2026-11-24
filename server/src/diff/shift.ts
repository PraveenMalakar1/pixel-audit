import type { Box } from '../types.js';

export interface ShiftResult {
  /** The build content equals the design content moved by (dx, dy). */
  dx: number;
  dy: number;
  /** Mismatch left after the best shift, relative to no shift (0 = perfect match). */
  residual: number;
}

/**
 * Checks whether a diff region is just the same pixels moved a little
 * (layout drift) rather than different content.
 * `design` and `live` are same-sized RGBA buffers.
 *
 * The check is symmetric: the build region must be found in the design moved by (dx,dy)
 * AND the design region must be found in the build moved by (-dx,-dy). Otherwise a
 * missing icon on a plain background would look like a "shift" onto empty background.
 */
export function detectShift(
  design: Uint8Array,
  live: Uint8Array,
  width: number,
  height: number,
  box: Box,
  maxShift = 8,
  maxResidual = 0.15,
): ShiftResult | undefined {
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
  const x1 = Math.min(width, box.x + box.width), y1 = Math.min(height, box.y + box.height);
  const areaPx = (x1 - x0) * (y1 - y0);
  if (areaPx <= 0) return undefined;
  const stride = areaPx > 60_000 ? 3 : areaPx > 20_000 ? 2 : 1;

  /** Pixels in the box of `a` that do not match `b` moved by (dx, dy). */
  const mismatches = (a: Uint8Array, b: Uint8Array, dx: number, dy: number): number => {
    let n = 0;
    for (let y = y0; y < y1; y += stride) {
      const sy = y - dy;
      for (let x = x0; x < x1; x += stride) {
        const sx = x - dx;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
          n++;
          continue;
        }
        const p = (y * width + x) * 4;
        const q = (sy * width + sx) * 4;
        if (Math.abs(a[p] - b[q]) + Math.abs(a[p + 1] - b[q + 1]) + Math.abs(a[p + 2] - b[q + 2]) > 60) n++;
      }
    }
    return n;
  };

  const base = mismatches(live, design, 0, 0);
  if (base === 0) return undefined;

  const scores: { dx: number; dy: number; n: number }[] = [];
  for (let dy = -maxShift; dy <= maxShift; dy++) {
    for (let dx = -maxShift; dx <= maxShift; dx++) {
      if (dx || dy) scores.push({ dx, dy, n: mismatches(live, design, dx, dy) });
    }
  }
  const bestN = Math.min(...scores.map((s) => s.n));
  if (bestN / base > maxResidual) return undefined;

  // Near-ties are common on plain edges (a horizontal border matches any dx): prefer the smallest move.
  const near = scores
    .filter((s) => s.n <= bestN * 1.05 + 2)
    .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)));

  for (const s of near) {
    const back = mismatches(design, live, -s.dx, -s.dy);
    const backBase = mismatches(design, live, 0, 0) || 1;
    if (back / backBase <= maxResidual) {
      return { dx: s.dx, dy: s.dy, residual: Math.round((Math.max(s.n / base, back / backBase)) * 100) / 100 };
    }
  }
  return undefined;
}
