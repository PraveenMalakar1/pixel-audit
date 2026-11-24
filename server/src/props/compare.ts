import type { Box, DesignNode, DomNode, IssueType, Severity } from '../types.js';
import { deltaE, hexWithAlpha, parseColor } from './color.js';
import type { Pair } from './matcher.js';

export interface Tolerances {
  position: number; // px
  size: number; // px
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  radius: number;
  colorDeltaE: number;
  padding: number;
}

export const DEFAULT_TOLERANCES: Tolerances = {
  position: 4,
  size: 2,
  fontSize: 0.5,
  lineHeight: 1,
  letterSpacing: 0.25,
  radius: 1,
  colorDeltaE: 3,
  padding: 1,
};

export interface PropFinding {
  property: string;
  type: IssueType;
  severity: Severity;
  expected: string;
  actual: string;
  /** CSS declaration that fixes it. */
  css: string;
  /** Tailwind class that fixes it (arbitrary values when needed). */
  tw?: string;
}

export interface PairResult {
  pair: Pair;
  findings: PropFinding[];
}

const px = (s: string | undefined): number | undefined => {
  if (!s || s === 'normal' || s === 'auto' || s === 'none') return undefined;
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : undefined;
};
const r1 = (v: number) => Math.round(v * 10) / 10;
const fmt = (v: number) => `${r1(v)}px`;

const WEIGHT_TW: Record<number, string> = {
  100: 'font-thin', 200: 'font-extralight', 300: 'font-light', 400: 'font-normal',
  500: 'font-medium', 600: 'font-semibold', 700: 'font-bold', 800: 'font-extrabold', 900: 'font-black',
};

/** "__DM_Sans_3a0388, __DM_Sans_Fallback_3a0388" → "dmsans" */
export function normFamily(s: string | undefined): string {
  const first = (s ?? '').split(',')[0].replace(/["']/g, '').trim();
  return first
    .replace(/^_+/, '')
    .replace(/_Fallback/i, '')
    .replace(/_[0-9a-f]{5,}$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

interface Shadow {
  inset: boolean;
  x: number;
  y: number;
  blur: number;
  spread: number;
  color: string;
}

/** Splits a computed box-shadow list and drops fully transparent layers (Tailwind adds several). */
export function parseShadows(css: string | undefined): Shadow[] {
  if (!css || css === 'none') return [];
  const parts: string[] = [];
  let depth = 0, cur = '';
  for (const ch of css) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  parts.push(cur);
  const out: Shadow[] = [];
  for (const p of parts) {
    const colorMatch = p.match(/(rgba?\([^)]*\)|lab\([^)]*\)|oklch\([^)]*\)|oklab\([^)]*\)|color\([^)]*\)|#[0-9a-f]{3,8})/i);
    const color = colorMatch?.[1] ?? 'rgb(0,0,0)';
    const nums = p.replace(colorMatch?.[1] ?? '', '').match(/-?[\d.]+px|-?[\d.]+(?=\s|$)/g)?.map((n) => parseFloat(n)) ?? [];
    const c = parseColor(color);
    if (!c || c.alpha < 0.01) continue;
    out.push({ inset: /inset/.test(p), x: nums[0] ?? 0, y: nums[1] ?? 0, blur: nums[2] ?? 0, spread: nums[3] ?? 0, color });
  }
  return out;
}

const shadowCss = (s: Shadow) => {
  const c = parseColor(s.color);
  const rgba = c ? hexToRgba(c.hex, c.alpha) : s.color;
  return `${s.inset ? 'inset ' : ''}${s.x}px ${s.y}px ${s.blur}px ${s.spread}px ${rgba}`;
};

function hexToRgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${Math.round(a * 100) / 100})`;
}

function sev(diff: number, medium: number, high = Infinity): Severity {
  return diff >= high ? 'high' : diff >= medium ? 'medium' : 'low';
}

function compareColor(
  out: PropFinding[],
  label: string,
  type: IssueType,
  figmaHex: string | undefined,
  domCss: string | undefined,
  cssProp: string,
  twPrefix: string,
  tol: Tolerances,
) {
  if (!figmaHex) return;
  const f = parseColor(figmaHex), d = parseColor(domCss);
  if (!f || !d) return;
  const de = deltaE(f.hex, d.hex);
  const alphaDiff = Math.abs(f.alpha - d.alpha);
  if (de < tol.colorDeltaE && alphaDiff < 0.1) return;
  const value = f.alpha < 0.999 ? hexToRgba(f.hex, f.alpha) : f.hex;
  out.push({
    property: label,
    type,
    severity: de >= 10 || alphaDiff >= 0.3 ? 'medium' : 'low',
    expected: hexWithAlpha(f),
    actual: `${hexWithAlpha(d)} (ΔE ${r1(de)})`,
    css: `${cssProp}: ${value};`,
    tw: `${twPrefix}-[${f.alpha < 0.999 ? value.replace(/\s/g, '') : f.hex}]`,
  });
}

export function compareText(d: DesignNode, el: DomNode, tol: Tolerances): PropFinding[] {
  const out: PropFinding[] = [];
  const s = el.styles;
  const f = d.font ?? {};

  if (f.family && normFamily(f.family) !== normFamily(s['font-family'])) {
    out.push({
      property: 'font-family', type: 'typography', severity: 'high',
      expected: f.family, actual: (s['font-family'] ?? '').split(',')[0].replace(/["']/g, ''),
      css: `font-family: "${f.family}", sans-serif;`, tw: `font-['${f.family.replace(/\s/g, '_')}']`,
    });
  }
  const fs = px(s['font-size']);
  if (f.size && fs !== undefined && Math.abs(fs - f.size) > tol.fontSize) {
    out.push({
      property: 'font-size', type: 'typography', severity: sev(Math.abs(fs - f.size), 2, 6),
      expected: fmt(f.size), actual: fmt(fs), css: `font-size: ${r1(f.size)}px;`, tw: `text-[${r1(f.size)}px]`,
    });
  }
  const fw = px(s['font-weight']);
  if (f.weight && fw !== undefined && fw !== f.weight) {
    out.push({
      property: 'font-weight', type: 'typography', severity: Math.abs(fw - f.weight) >= 200 ? 'high' : 'medium',
      expected: String(f.weight), actual: String(fw), css: `font-weight: ${f.weight};`, tw: WEIGHT_TW[f.weight] ?? `font-[${f.weight}]`,
    });
  }
  const lh = px(s['line-height']);
  if (f.lineHeight && lh !== undefined && Math.abs(lh - f.lineHeight) > tol.lineHeight) {
    // Line height only changes the look of multi-line text; on one line it just changes the box height.
    const multiLine = el.box.height > lh * 1.6;
    out.push({
      property: 'line-height', type: 'typography', severity: multiLine ? sev(Math.abs(lh - f.lineHeight), 4) : 'low',
      expected: fmt(f.lineHeight), actual: fmt(lh), css: `line-height: ${r1(f.lineHeight)}px;`, tw: `leading-[${r1(f.lineHeight)}px]`,
    });
  }
  const ls = s['letter-spacing'] === 'normal' ? 0 : px(s['letter-spacing']);
  if (f.letterSpacing !== undefined && ls !== undefined && Math.abs(ls - f.letterSpacing) > tol.letterSpacing) {
    out.push({
      property: 'letter-spacing', type: 'typography', severity: 'low',
      expected: fmt(f.letterSpacing), actual: fmt(ls), css: `letter-spacing: ${r1(f.letterSpacing)}px;`, tw: `tracking-[${r1(f.letterSpacing)}px]`,
    });
  }
  compareColor(out, 'text color', 'color', d.fill, s['color'], 'color', 'text', tol);
  return out;
}

export interface BoxContext {
  effectiveBg?: string;
  scale: number;
  tol: Tolerances;
  /** Largest border on the element or a same-size wrapper/child. */
  border?: { width: number; color?: string };
  /** First non-zero border-radius on the element or a same-size wrapper/child. */
  radius?: string;
  /** Visible content bounds inside the element / inside the Figma frame (1x). */
  domContent?: Box;
  figmaContent?: Box;
  frameWidth: number;
}

export function compareBox(d: DesignNode, el: DomNode, ctx: BoxContext): PropFinding[] {
  const out: PropFinding[] = [];
  const s = el.styles;
  const { effectiveBg, scale, tol } = ctx;
  const visibleShape = !!(d.fill || d.stroke || d.effects?.length);

  // Background: compare with what is visible behind the element when it has none of its own.
  if (d.fill) {
    const own = parseColor(s['background-color']);
    const bgCss = own && own.alpha > 0.02 ? s['background-color'] : effectiveBg;
    compareColor(out, 'background', 'color', d.fill, bgCss, 'background-color', 'bg', tol);
  }

  // Corner radius (only visible when the layer has a fill, border or shadow).
  if (d.cornerRadius !== undefined && visibleShape) {
    const want = Array.isArray(d.cornerRadius) ? d.cornerRadius : [d.cornerRadius, d.cornerRadius, d.cornerRadius, d.cornerRadius];
    // The radius may live on a same-size wrapper or child (e.g. <span><input class="rounded-lg"></span>).
    const radiusCss = ctx.radius && (px(s['border-radius']) ?? 0) === 0 ? ctx.radius : s['border-radius'];
    const have = (radiusCss ?? '0px').split(/\s+/).map((v) => px(v) ?? 0);
    const haveAll = [have[0], have[1] ?? have[0], have[2] ?? have[0], have[3] ?? have[1] ?? have[0]];
    const diff = Math.max(...want.map((w, i) => Math.abs(w * scale - haveAll[i])));
    if (diff > tol.radius) {
      const same = want.every((w) => w === want[0]);
      out.push({
        property: 'border-radius', type: 'shape', severity: sev(diff, 4),
        expected: same ? fmt(want[0] * scale) : want.map((w) => fmt(w * scale)).join(' '),
        actual: radiusCss ?? '0px',
        css: `border-radius: ${same ? fmt(want[0] * scale) : want.map((w) => fmt(w * scale)).join(' ')};`,
        tw: same ? `rounded-[${r1(want[0] * scale)}px]` : `rounded-[${want.map((w) => fmt(w * scale)).join('_')}]`,
      });
    }
  }

  // Border (the page may put it on a same-size wrapper or child, or on one side only).
  if (d.stroke && d.strokeWeight) {
    const b = ctx.border ?? { width: px(s['border-top-width']) ?? 0, color: s['border-top-color'] };
    if (b.width === 0 && d.strokeWeight >= 0.5) {
      out.push({
        property: 'border', type: 'shape', severity: 'medium',
        expected: `${fmt(d.strokeWeight)} ${d.stroke}`, actual: 'none', css: `border: ${d.strokeWeight}px solid ${d.stroke};`,
        tw: `border-[${d.strokeWeight}px] border-[${d.stroke}]`,
      });
    } else if (Math.abs(b.width - d.strokeWeight) > 0.5) {
      out.push({
        property: 'border-width', type: 'shape', severity: 'low',
        expected: fmt(d.strokeWeight), actual: fmt(b.width), css: `border-width: ${d.strokeWeight}px;`, tw: `border-[${d.strokeWeight}px]`,
      });
    } else compareColor(out, 'border color', 'color', d.stroke, b.color, 'border-color', 'border', tol);
  }

  // Shadow.
  const want = (d.effects ?? []).filter((e) => /px/.test(e) && !/^(layer_blur|background_blur)/.test(e)).map((e) => parseShadows(e)[0]).filter(Boolean) as Shadow[];
  const have = parseShadows(s['box-shadow']);
  if (want.length && !have.length) {
    out.push({
      property: 'box-shadow', type: 'shape', severity: 'medium', expected: want.map(shadowCss).join(', '), actual: 'none',
      css: `box-shadow: ${want.map(shadowCss).join(', ')};`, tw: `shadow-[${want.map(shadowCss).join(',').replace(/\s/g, '_')}]`,
    });
  } else if (want.length && have.length) {
    const a = want[0], b = have[0];
    const geo = Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.blur - b.blur), Math.abs(a.spread - b.spread));
    const ca = parseColor(a.color), cb = parseColor(b.color);
    const alpha = ca && cb ? Math.abs(ca.alpha - cb.alpha) : 0;
    if (geo > 1 || alpha > 0.05) {
      out.push({
        property: 'box-shadow', type: 'shape', severity: 'low', expected: want.map(shadowCss).join(', '), actual: have.map(shadowCss).join(', '),
        css: `box-shadow: ${want.map(shadowCss).join(', ')};`, tw: `shadow-[${want.map(shadowCss).join(',').replace(/\s/g, '_')}]`,
      });
    }
  } else if (!want.length && have.length && d.type !== 'TEXT') {
    out.push({
      property: 'box-shadow', type: 'shape', severity: 'low', expected: 'none', actual: have.map(shadowCss).join(', '),
      css: 'box-shadow: none;', tw: 'shadow-none',
    });
  }

  // Inner spacing: distance from the element's edge to its content. Compared on what is visible,
  // because the page may put padding on an inner container where Figma puts it on the frame.
  const fillsBox = (c: Box) => Math.abs(c.x - el.box.x) < 1 && Math.abs(c.y - el.box.y) < 1 && Math.abs(c.width - el.box.width) < 1;
  // Skip when the "content" is a form control filling the wrapper: its own padding places the text.
  if (d.padding && ctx.domContent && ctx.figmaContent && !fillsBox(ctx.domContent)) {
    const f = ctx.figmaContent, c = ctx.domContent;
    const wantTop = (f.y - d.box.y) * scale, haveTop = c.y - el.box.y;
    const wantLeft = (f.x - d.box.x) * scale, haveLeft = c.x - el.box.x;
    const centred = (s['text-align'] ?? '') === 'center' || (s['justify-content'] ?? '') === 'center';
    const dt = Math.abs(wantTop - haveTop), dl = centred ? 0 : Math.abs(wantLeft - haveLeft);
    if (dt > tol.position || dl > tol.position) {
      const exp: string[] = [], act: string[] = [], css: string[] = [], tw: string[] = [];
      if (dt > tol.position) {
        exp.push(`top ${fmt(wantTop)}`);
        act.push(`top ${fmt(haveTop)}`);
        css.push(`padding-top: ${fmt((px(s['padding-top']) ?? 0) + wantTop - haveTop)};`);
        tw.push(`pt-[${r1((px(s['padding-top']) ?? 0) + wantTop - haveTop)}px]`);
      }
      if (dl > tol.position) {
        exp.push(`left ${fmt(wantLeft)}`);
        act.push(`left ${fmt(haveLeft)}`);
        css.push(`padding-left: ${fmt((px(s['padding-left']) ?? 0) + wantLeft - haveLeft)};`);
        tw.push(`pl-[${r1((px(s['padding-left']) ?? 0) + wantLeft - haveLeft)}px]`);
      }
      const bigBox = el.box.height > 300 || el.box.width >= ctx.frameWidth * 0.9;
      out.push({
        // On full-width sections the space is often just distributed differently between neighbours.
        property: 'inner spacing', type: 'spacing', severity: bigBox ? 'low' : sev(Math.max(dt, dl), 8, 24),
        expected: `content inset ${exp.join(', ')}`, actual: `content inset ${act.join(', ')}`,
        css: css.join(' '), tw: tw.join(' '),
      });
    }
  }

  // Gap between children (auto-layout item spacing).
  if (d.itemSpacing) {
    const g = px(s['gap']);
    if (g !== undefined && Math.abs(g - d.itemSpacing * scale) > tol.padding) {
      out.push({
        property: 'gap', type: 'spacing', severity: sev(Math.abs(g - d.itemSpacing * scale), 4, 12),
        expected: fmt(d.itemSpacing * scale), actual: fmt(g), css: `gap: ${fmt(d.itemSpacing * scale)};`, tw: `gap-[${r1(d.itemSpacing * scale)}px]`,
      });
    }
  }

  // Size. Big containers grow with their content, so only larger differences matter there.
  const big = el.box.height > 300 || el.box.width >= ctx.frameWidth * 0.9;
  const dw = el.box.width - d.box.width * scale, dh = el.box.height - d.box.height * scale;
  if (Math.abs(dw) > (big ? 8 : tol.size) || Math.abs(dh) > (big ? 8 : tol.size)) {
    const parts: string[] = [], tw: string[] = [], exp: string[] = [], act: string[] = [];
    if (Math.abs(dw) > tol.size) {
      parts.push(`width: ${fmt(d.box.width * scale)};`);
      tw.push(`w-[${r1(d.box.width * scale)}px]`);
      exp.push(`w ${fmt(d.box.width * scale)}`);
      act.push(`w ${fmt(el.box.width)}`);
    }
    if (Math.abs(dh) > tol.size) {
      parts.push(`height: ${fmt(d.box.height * scale)};`);
      tw.push(`h-[${r1(d.box.height * scale)}px]`);
      exp.push(`h ${fmt(d.box.height * scale)}`);
      act.push(`h ${fmt(el.box.height)}`);
    }
    out.push({
      property: 'size', type: 'size', severity: big ? 'low' : sev(Math.max(Math.abs(dw), Math.abs(dh)), 8, 24),
      expected: exp.join(', '), actual: act.join(', '), css: parts.join(' '), tw: tw.join(' '),
    });
  }
  return out;
}

/**
 * Horizontal/vertical offset of the element vs where the Figma layer sits (after row alignment).
 * For text, the page element's box includes its padding (buttons, pills) and sometimes an icon,
 * while the Figma text layer is just the text: compare the content box with the right anchor.
 */
export function comparePosition(pair: Pair, tol: Tolerances, opts: { leadingIcon?: boolean; frameWidth: number }): PropFinding | undefined {
  const { liveBox: lb, dom: el } = pair;
  const s = el.styles;
  // Full-width sections: horizontal position is meaningless and vertical drift is reported as gaps.
  if (el.box.width >= opts.frameWidth * 0.9) return undefined;

  let box = el.box;
  if (pair.how === 'text') {
    const pl = (px(s['padding-left']) ?? 0) + (px(s['border-left-width']) ?? 0);
    const pr = (px(s['padding-right']) ?? 0) + (px(s['border-right-width']) ?? 0);
    const pt = (px(s['padding-top']) ?? 0) + (px(s['border-top-width']) ?? 0);
    const pb = (px(s['padding-bottom']) ?? 0) + (px(s['border-bottom-width']) ?? 0);
    box = { x: box.x + pl, y: box.y + pt, width: Math.max(1, box.width - pl - pr), height: Math.max(1, box.height - pt - pb) };
  }
  const flex = /flex|grid/.test(s['display'] ?? '');
  const row = !/column/.test(s['flex-direction'] ?? '');
  const hCenter = (s['text-align'] ?? '') === 'center' || (flex && row && s['justify-content'] === 'center') || (flex && !row && s['align-items'] === 'center');
  const right = (s['text-align'] ?? '') === 'right' || (s['text-align'] ?? '') === 'end';
  // Buttons and form fields centre their content vertically by default.
  const nativeControl = ['button', 'input', 'select', 'textarea'].includes(el.tag);
  const vCenter = nativeControl || (flex && row && s['align-items'] === 'center') || (flex && !row && s['justify-content'] === 'center');

  let dx: number;
  if (pair.how === 'text' && (hCenter || opts.leadingIcon)) {
    // Centred text, or text after an icon: compare centres / right edges instead of the left edge.
    dx = opts.leadingIcon && !hCenter ? box.x + box.width - (lb.x + lb.width) : box.x + box.width / 2 - (lb.x + lb.width / 2);
  } else if (pair.how === 'text' && right) dx = box.x + box.width - (lb.x + lb.width);
  else dx = box.x - lb.x;
  const dy = pair.how === 'text' && vCenter ? box.y + box.height / 2 - (lb.y + lb.height / 2) : box.y - lb.y;

  // Text boxes include line-height padding that Figma may not: allow a little extra vertically.
  const ty = pair.how === 'text' ? tol.position + 3 : tol.position;
  if (Math.abs(dx) <= tol.position && Math.abs(dy) <= ty) return undefined;
  const moves: string[] = [];
  if (Math.abs(dx) > tol.position) moves.push(`${r1(Math.abs(dx))}px too far ${dx > 0 ? 'right' : 'left'}`);
  if (Math.abs(dy) > ty) moves.push(`${r1(Math.abs(dy))}px too ${dy > 0 ? 'low' : 'high'}`);
  return {
    property: 'position',
    type: 'layout',
    severity: sev(Math.max(Math.abs(dx), Math.abs(dy)), 8, 32),
    expected: `x ${r1(lb.x)}, y ${r1(lb.y)}`,
    actual: `x ${r1(box.x)}, y ${r1(box.y)} (${moves.join(', ')})`,
    css: `/* move ${moves.join(' and ')}: adjust the parent's padding/margin or this element's margin */`,
  };
}

function twPadding(p: number[]): string {
  const [t, r, b, l] = p.map(r1);
  if (t === r && r === b && b === l) return `p-[${t}px]`;
  if (t === b && r === l) return `px-[${r}px] py-[${t}px]`;
  return `pt-[${t}px] pr-[${r}px] pb-[${b}px] pl-[${l}px]`;
}

export function boxOf(pair: Pair): Box {
  return pair.dom.box;
}
