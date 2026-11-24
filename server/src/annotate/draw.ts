import sharp, { type OverlayOptions } from 'sharp';
import type { Box, Issue, Severity } from '../types.js';

export const SEVERITY_COLOR: Record<Severity, string> = {
  high: '#e11d48',
  medium: '#f59e0b',
  low: '#2563eb',
};

const FONT = 'Arial, Helvetica, sans-serif';

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export function clampBox(b: Box, w: number, h: number): Box {
  const x = Math.max(0, Math.min(w - 1, Math.round(b.x)));
  const y = Math.max(0, Math.min(h - 1, Math.round(b.y)));
  const width = Math.max(1, Math.min(w - x, Math.round(b.width)));
  const height = Math.max(1, Math.min(h - y, Math.round(b.height)));
  return { x, y, width, height };
}

/** Paints numbered boxes for each issue onto the screenshot. */
export async function drawIssues(png: Buffer, issues: Issue[]): Promise<Buffer> {
  const { width: w = 0, height: h = 0 } = await sharp(png).metadata();
  const shapes = issues.map((issue, i) => {
    const c = SEVERITY_COLOR[issue.severity] ?? SEVERITY_COLOR.medium;
    const b = clampBox(issue.box, w, h);
    const p = 3; // draw just outside the element
    const rx = Math.max(0, b.x - p), ry = Math.max(0, b.y - p);
    const cx = Math.max(13, Math.min(w - 13, rx));
    const cy = Math.max(13, Math.min(h - 13, ry));
    return (
      `<rect x="${rx}" y="${ry}" width="${b.width + 2 * p}" height="${b.height + 2 * p}" rx="3" ` +
      `fill="${c}" fill-opacity="0.08" stroke="${c}" stroke-width="2.5"/>` +
      `<circle cx="${cx}" cy="${cy}" r="12" fill="${c}" stroke="#ffffff" stroke-width="2"/>` +
      `<text x="${cx}" y="${cy + 4.5}" font-family="${FONT}" font-size="13" font-weight="700" fill="#ffffff" text-anchor="middle">${i + 1}</text>`
    );
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${shapes.join('')}</svg>`;
  return sharp(png).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toBuffer();
}

export interface Panel {
  png: Buffer;
  label: string;
}

/** Places images next to each other with a label above each. */
export async function row(panels: Panel[], opts: { gap?: number; margin?: number; background?: string } = {}): Promise<Buffer> {
  const gap = opts.gap ?? 24;
  const margin = opts.margin ?? 16;
  const header = 36;
  const metas = await Promise.all(panels.map((p) => sharp(p.png).metadata()));
  const sizes = metas.map((m) => ({ w: m.width ?? 0, h: m.height ?? 0 }));
  const width = margin * 2 + sizes.reduce((s, x) => s + x.w, 0) + gap * (panels.length - 1);
  const height = margin * 2 + header + Math.max(...sizes.map((s) => s.h));

  let x = margin;
  const composites: OverlayOptions[] = [];
  const labels: string[] = [];
  panels.forEach((p, i) => {
    composites.push({ input: p.png, left: x, top: margin + header });
    labels.push(
      `<text x="${x}" y="${margin + 22}" font-family="${FONT}" font-size="16" font-weight="700" fill="#18181b">${escapeXml(p.label)}</text>`,
    );
    x += sizes[i].w + gap;
  });
  composites.push({
    input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${labels.join('')}</svg>`),
    left: 0,
    top: 0,
  });

  return sharp({ create: { width, height, channels: 4, background: opts.background ?? '#f4f4f5' } })
    .composite(composites)
    .png()
    .toBuffer();
}

/** 50/50 blend of two same-sized RGBA buffers ("onion skin"). */
export function blend(a: Buffer, b: Buffer, weightA = 0.5): Buffer {
  const out = Buffer.alloc(a.length);
  const wb = 1 - weightA;
  for (let i = 0; i < a.length; i++) out[i] = Math.round(a[i] * weightA + b[i] * wb);
  return out;
}

/** Resizes so the image fits inside maxW x maxH (never enlarges). */
export function fit(png: Buffer, maxW: number, maxH: number): Promise<Buffer> {
  return sharp(png).resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
}
