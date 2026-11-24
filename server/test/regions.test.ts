import { describe, expect, it } from 'vitest';
import { findRegions, mergeOverlapping } from '../src/diff/regions.js';
import { detectShift } from '../src/diff/shift.js';

function maskWith(width: number, height: number, rects: [number, number, number, number][]) {
  const m = new Uint8Array(width * height);
  for (const [x, y, w, h] of rects) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) m[j * width + i] = 1;
  return m;
}

/** White RGBA image with filled rectangles of a colour. */
function image(width: number, height: number, rects: [number, number, number, number, [number, number, number]][]) {
  const buf = new Uint8Array(width * height * 4).fill(255);
  for (const [x, y, w, h, c] of rects)
    for (let j = y; j < y + h; j++)
      for (let i = x; i < x + w; i++) {
        const p = (j * width + i) * 4;
        buf[p] = c[0];
        buf[p + 1] = c[1];
        buf[p + 2] = c[2];
      }
  return buf;
}

describe('findRegions', () => {
  it('returns nothing for an identical image', () => {
    expect(findRegions(new Uint8Array(100 * 100), 100, 100)).toEqual([]);
  });

  it('finds two separate areas with tight boxes', () => {
    const r = findRegions(maskWith(200, 200, [[10, 10, 20, 20], [150, 150, 30, 10]]), 200, 200);
    expect(r).toHaveLength(2);
    expect(r.map((x) => x.box)).toEqual(
      expect.arrayContaining([
        { x: 10, y: 10, width: 20, height: 20 },
        { x: 150, y: 150, width: 30, height: 10 },
      ]),
    );
  });

  it('drops tiny noise', () => {
    expect(findRegions(maskWith(100, 100, [[50, 50, 2, 2]]), 100, 100)).toEqual([]);
  });

  it('sorts by size, largest first', () => {
    const r = findRegions(maskWith(300, 100, [[0, 0, 10, 10], [200, 0, 40, 40]]), 300, 100);
    expect(r[0].pixels).toBeGreaterThan(r[1].pixels);
  });
});

describe('mergeOverlapping', () => {
  it('merges touching boxes', () => {
    const r = mergeOverlapping(
      [
        { box: { x: 0, y: 0, width: 10, height: 10 }, pixels: 5 },
        { box: { x: 11, y: 0, width: 10, height: 10 }, pixels: 5 },
      ],
      2,
    );
    expect(r).toEqual([{ box: { x: 0, y: 0, width: 21, height: 10 }, pixels: 10 }]);
  });
});

describe('detectShift', () => {
  const W = 120, H = 80;
  const purple: [number, number, number] = [79, 70, 229];

  it('detects the same block moved down by 2px', () => {
    const design = image(W, H, [[20, 20, 40, 20, purple]]);
    const live = image(W, H, [[20, 22, 40, 20, purple]]);
    const s = detectShift(design, live, W, H, { x: 15, y: 15, width: 50, height: 32 });
    expect(s).toMatchObject({ dx: 0, dy: 2 });
  });

  it('does not call a missing icon a shift', () => {
    // Design: purple square with a white mark inside. Build: plain purple square.
    const design = image(W, H, [[20, 20, 48, 48, purple], [34, 34, 20, 6, [255, 255, 255]]]);
    const live = image(W, H, [[20, 20, 48, 48, purple]]);
    expect(detectShift(design, live, W, H, { x: 20, y: 20, width: 48, height: 48 })).toBeUndefined();
  });

  it('does not call a colour change a shift', () => {
    const design = image(W, H, [[20, 20, 40, 20, purple]]);
    const live = image(W, H, [[20, 20, 40, 20, [99, 102, 241]]]);
    expect(detectShift(design, live, W, H, { x: 20, y: 20, width: 40, height: 20 })).toBeUndefined();
  });
});
