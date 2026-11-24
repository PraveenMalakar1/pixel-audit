import { describe, expect, it } from 'vitest';
import { deltaE, parseColor } from '../src/props/color.js';
import { compareText, DEFAULT_TOLERANCES, normFamily, parseShadows } from '../src/props/compare.js';
import { designToLiveRows, matchNodes } from '../src/props/matcher.js';
import type { DesignNode, DomNode } from '../src/types.js';

describe('colour', () => {
  it('reads the colour formats browsers return', () => {
    expect(parseColor('rgb(34, 34, 34)')?.hex).toBe('#222222');
    expect(parseColor('lab(44.0605 29.0279 -86.0352)')?.hex).toBe('#155dfc');
    expect(parseColor('rgba(0, 0, 0, 0)')?.alpha).toBe(0);
  });
  it('treats near-identical greys as the same and different blues as different', () => {
    expect(deltaE('#222222', '#232323')).toBeLessThan(1);
    expect(deltaE('#4f46e5', '#2563eb')).toBeGreaterThan(5);
  });
});

describe('normFamily', () => {
  it('matches Next.js font names to Figma family names', () => {
    expect(normFamily('__DM_Sans_3a0388, __DM_Sans_Fallback_3a0388')).toBe(normFamily('DM Sans'));
    expect(normFamily('"Inter", sans-serif')).toBe('inter');
  });
});

describe('parseShadows', () => {
  it('drops the transparent layers Tailwind adds', () => {
    const s = parseShadows('rgba(0, 0, 0, 0) 0px 0px 0px 0px, rgba(15, 20, 31, 0.12) 0px 4px 8px 0px');
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ x: 0, y: 4, blur: 8, spread: 0 });
  });
});

const el = (text: string, x: number, y: number, styles: Record<string, string>): DomNode => ({
  selector: text, tag: 'p', depth: 3, text, box: { x, y, width: 200, height: 20 }, styles,
});
const layer = (text: string, x: number, y: number, size: number, weight: number): DesignNode => ({
  id: text, name: text, type: 'TEXT', depth: 2, text, box: { x, y, width: 200, height: 20 },
  font: { family: 'DM Sans', size, weight, lineHeight: 20 }, fill: '#222222',
});

describe('matching and comparing text', () => {
  const rows = designToLiveRows(Int32Array.from({ length: 400 }, (_, i) => i), 400);

  it('prefers the element with the matching style when text repeats', () => {
    const heading = el('About Us', 100, 100, { 'font-size': '20px', 'font-weight': '400' });
    const link = el('About Us', 100, 140, { 'font-size': '14px', 'font-weight': '400' });
    const frame: DesignNode = { id: 'f', name: 'f', type: 'FRAME', depth: 0, box: { x: 0, y: 0, width: 400, height: 400 } };
    const { pairs } = matchNodes([frame, layer('About Us', 100, 120, 20, 400)], [link, heading], 1, rows);
    expect(pairs[0].dom).toBe(heading);
  });

  it('reports size, weight and colour differences with Tailwind fixes', () => {
    const f = compareText(
      layer('Hi', 0, 0, 15, 500),
      el('Hi', 0, 0, { 'font-family': '__DM_Sans_abc123', 'font-size': '14px', 'font-weight': '400', 'line-height': '20px', 'letter-spacing': 'normal', color: 'rgb(23, 23, 23)' }),
      DEFAULT_TOLERANCES,
    );
    expect(f.map((x) => x.property).sort()).toEqual(['font-size', 'font-weight', 'text color']);
    expect(f.find((x) => x.property === 'font-size')?.tw).toBe('text-[15px]');
    expect(f.find((x) => x.property === 'font-weight')?.tw).toBe('font-medium');
  });
});
