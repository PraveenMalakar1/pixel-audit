import { differenceCiede2000, formatHex, parse } from 'culori';

const ciede = differenceCiede2000();

export interface ParsedColor {
  hex: string; // #rrggbb
  alpha: number; // 0..1
}

/** Parses any CSS colour the browser returns (rgb(), lab(), oklch(), color(), hex...). */
export function parseColor(css: string | undefined): ParsedColor | undefined {
  if (!css || css === 'none') return undefined;
  const c = parse(css.trim());
  if (!c) return undefined;
  const hex = formatHex(c);
  if (!hex) return undefined;
  return { hex, alpha: c.alpha ?? 1 };
}

export function isTransparent(css: string | undefined): boolean {
  const c = parseColor(css);
  return !c || c.alpha < 0.02;
}

/** CIEDE2000 colour difference. ~1 = barely visible, 2–3 = noticeable side by side, > 5 = clearly different. */
export function deltaE(a: string, b: string): number {
  const ca = parse(a), cb = parse(b);
  if (!ca || !cb) return Infinity;
  return ciede(ca, cb);
}

export function hexWithAlpha(c: ParsedColor): string {
  return c.alpha < 0.999 ? `${c.hex} @ ${Math.round(c.alpha * 100)}%` : c.hex;
}
