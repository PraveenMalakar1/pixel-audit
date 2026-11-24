/**
 * Vertical row alignment ("git diff for pixel rows").
 *
 * Real pages drift vertically: one section 40px taller pushes everything below it down,
 * and a plain pixel diff then flags the whole rest of the page. Here we match design rows
 * to build rows with a banded edit-distance, so drift becomes a few precise findings
 * ("build has 40px less space here") and the rest of the page lines up again.
 */

export interface RowSigs {
  sig: Float32Array; // height * buckets, mean luminance per bucket
  blank: Uint8Array; // 1 = row is (nearly) uniform
  buckets: number;
  height: number;
}

export function rowSignatures(raw: Uint8Array, width: number, height: number, buckets = 48): RowSigs {
  const sig = new Float32Array(height * buckets);
  const blank = new Uint8Array(height);
  const bw = width / buckets;
  for (let y = 0; y < height; y++) {
    let min = 255, max = 0;
    const row = y * width * 4;
    for (let b = 0; b < buckets; b++) {
      const x0 = Math.floor(b * bw), x1 = Math.max(x0 + 1, Math.floor((b + 1) * bw));
      let s = 0;
      for (let x = x0; x < x1; x++) {
        const p = row + x * 4;
        const l = 0.299 * raw[p] + 0.587 * raw[p + 1] + 0.114 * raw[p + 2];
        s += l;
        if (l < min) min = l;
        if (l > max) max = l;
      }
      sig[y * buckets + b] = s / (x1 - x0);
    }
    blank[y] = max - min < 12 ? 1 : 0;
  }
  return { sig, blank, buckets, height };
}

export type GapKind = 'more-space-in-build' | 'less-space-in-build' | 'extra-content-in-build' | 'missing-content-in-build';

export interface RowGap {
  kind: GapKind;
  /** Position in the build (page px). For removed design rows: where they would have been. */
  liveY: number;
  /** Position in the design (page px, after scaling to build width). */
  designY: number;
  rows: number;
}

export interface RowAlignment {
  /** For each build row, the matching design row, or -1 if the row exists only in the build. */
  liveToDesign: Int32Array;
  gaps: RowGap[];
  /** Total design rows with no match / build rows with no match. */
  removed: number;
  inserted: number;
}

export function alignRows(d: RowSigs, l: RowSigs, opts: { band?: number; gapCost?: number } = {}): RowAlignment {
  const B = d.buckets;
  const hd = d.height, hl = l.height;
  const G = opts.gapCost ?? 40;
  const band = opts.band ?? 400;
  const lo = Math.min(0, hl - hd) - band;
  const hi = Math.max(0, hl - hd) + band;
  const K = hi - lo + 1;

  const cost = (i: number, j: number) => {
    let s = 0;
    const a = i * B, b = j * B;
    for (let k = 0; k < B; k++) s += Math.abs(d.sig[a + k] - l.sig[b + k]);
    return s / B;
  };

  // dir: 1 = match (diag), 2 = design row removed (up), 3 = build row inserted (left)
  const dir = new Uint8Array((hd + 1) * K);
  let prev = new Float64Array(K).fill(Infinity);
  let cur = new Float64Array(K).fill(Infinity);

  // Row i = 0: only insertions.
  for (let k = 0; k < K; k++) {
    const j = k + lo;
    if (j >= 0 && j <= hl) {
      prev[k] = j * G;
      dir[k] = 3;
    }
  }
  for (let i = 1; i <= hd; i++) {
    cur.fill(Infinity);
    const rowDir = i * K;
    for (let k = 0; k < K; k++) {
      const j = i + k + lo;
      if (j < 0 || j > hl) continue;
      let best = Infinity, bd = 0;
      if (j === 0) {
        best = i * G;
        bd = 2;
      } else {
        if (prev[k] < Infinity) {
          const c = prev[k] + cost(i - 1, j - 1);
          if (c < best) { best = c; bd = 1; }
        }
        if (k + 1 < K && prev[k + 1] + G < best) { best = prev[k + 1] + G; bd = 2; }
        if (k > 0 && cur[k - 1] + G < best) { best = cur[k - 1] + G; bd = 3; }
      }
      cur[k] = best;
      dir[rowDir + k] = bd;
    }
    [prev, cur] = [cur, prev];
  }

  // Backtrack from (hd, hl).
  const liveToDesign = new Int32Array(hl).fill(-1);
  const ops: { op: number; i: number; j: number }[] = [];
  let i = hd, j = hl;
  while (i > 0 || j > 0) {
    const k = j - i - lo;
    const op = i === 0 ? 3 : j === 0 ? 2 : dir[i * K + k];
    if (op === 1) {
      liveToDesign[j - 1] = i - 1;
      i--; j--;
    } else if (op === 2) {
      ops.push({ op, i: i - 1, j });
      i--;
    } else {
      ops.push({ op, i, j: j - 1 });
      j--;
    }
  }
  ops.reverse();

  // Group consecutive unmatched rows into gaps.
  const gaps: RowGap[] = [];
  let removed = 0, inserted = 0;
  for (const o of ops) {
    const isRemoved = o.op === 2;
    if (isRemoved) removed++; else inserted++;
    const blank = isRemoved ? d.blank[o.i] : l.blank[o.j];
    const kind: GapKind = isRemoved
      ? blank ? 'less-space-in-build' : 'missing-content-in-build'
      : blank ? 'more-space-in-build' : 'extra-content-in-build';
    const last = gaps[gaps.length - 1];
    // Removed rows advance in the design at a fixed build row; inserted rows advance in the build.
    const continues =
      last &&
      last.kind === kind &&
      (isRemoved
        ? last.liveY === o.j && last.designY + last.rows === o.i
        : last.designY === o.i && last.liveY + last.rows === o.j);
    if (continues) last.rows++;
    else gaps.push({ kind, liveY: o.j, designY: o.i, rows: 1 });
  }
  return { liveToDesign, gaps: gaps.filter((g) => g.rows >= 2), removed, inserted };
}

export interface GapBlock {
  kind: GapKind | 'section-differs';
  /** Area in the build (height 0 = nothing in the build there). */
  build: { y: number; height: number };
  /** Area in the design, page px at build width (height 0 = nothing in the design there). */
  design: { y: number; height: number };
  /** build height - design height: > 0 build is taller here, < 0 shorter. */
  net: number;
}

/** Joins gap fragments that are close together (e.g. a restructured footer) into blocks. */
export function mergeGaps(gaps: RowGap[], tolerance = 24): GapBlock[] {
  const blocks: (GapBlock & { kinds: Set<GapKind> })[] = [];
  for (const g of gaps) {
    const inBuild = g.kind === 'more-space-in-build' || g.kind === 'extra-content-in-build';
    const b = { y: g.liveY, height: inBuild ? g.rows : 0 };
    const d = { y: g.designY, height: inBuild ? 0 : g.rows };
    const last = blocks[blocks.length - 1];
    if (last && b.y - (last.build.y + last.build.height) <= tolerance && d.y - (last.design.y + last.design.height) <= tolerance) {
      last.build.height = Math.max(last.build.y + last.build.height, b.y + b.height) - last.build.y;
      last.design.height = Math.max(last.design.y + last.design.height, d.y + d.height) - last.design.y;
      last.net += inBuild ? g.rows : -g.rows;
      last.kinds.add(g.kind);
    } else {
      blocks.push({ kind: g.kind, build: b, design: d, net: inBuild ? g.rows : -g.rows, kinds: new Set([g.kind]) });
    }
  }
  return blocks.map(({ kinds, ...blk }) => ({ ...blk, kind: kinds.size === 1 ? [...kinds][0] : 'section-differs' }));
}

/**
 * Builds a design image re-flowed to match the build rows. Build-only rows repeat the nearest
 * matched design row above (usually background), so extra content shows up in the diff.
 */
export function warpDesign(design: Uint8Array, width: number, map: Int32Array, designHeight: number): Buffer {
  const out = Buffer.alloc(width * map.length * 4, 255);
  const rowBytes = width * 4;
  let last = -1;
  for (let j = 0; j < map.length; j++) {
    const i = map[j] >= 0 ? map[j] : last;
    if (map[j] >= 0) last = map[j];
    if (i >= 0 && i < designHeight) out.set(design.subarray(i * rowBytes, (i + 1) * rowBytes), j * rowBytes);
  }
  return out;
}
