import fs from 'node:fs/promises';
import path from 'node:path';
import type { Box, DesignNode } from '../types.js';

const API = 'https://api.figma.com';
const MAX_NODES = 5000;

export interface FigmaRef {
  fileKey: string;
  nodeId: string;
}

/**
 * Parses links such as
 *   https://www.figma.com/design/AbC123/My-File?node-id=12-34
 *   https://www.figma.com/file/AbC123/My-File?node-id=12%3A34
 */
export function parseFigmaUrl(url: string): FigmaRef {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (!/(^|\.)figma\.com$/.test(u.hostname)) throw new Error(`Not a Figma link: ${url}`);
  const m = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (!m) throw new Error(`Could not find the Figma file key in: ${url}`);
  const raw = u.searchParams.get('node-id');
  if (!raw) {
    throw new Error(
      'The Figma link must point to a frame (it needs "?node-id=..."). In Figma, select the frame, right-click → Copy/Paste as → Copy link to selection.',
    );
  }
  const nodeId = raw.includes(':') ? raw : raw.replace(/-/g, ':');
  return { fileKey: m[1], nodeId };
}

async function figmaGet<T>(pathAndQuery: string, token: string, attempt = 0): Promise<T> {
  const res = await fetch(`${API}${pathAndQuery}`, { headers: { 'X-Figma-Token': token } });
  if (res.status === 429 && attempt < 2) {
    const wait = Number(res.headers.get('retry-after') ?? '20');
    if (Number.isFinite(wait) && wait <= 90) {
      console.error(`[visual-qa] Figma rate limit, retrying in ${wait}s`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return figmaGet<T>(pathAndQuery, token, attempt + 1);
    }
    throw new Error(
      `Figma rate limit: Figma asks to wait ${Math.round(wait / 60)} minutes. Cached frames still work; or export the frame as PNG and use load_design_image.`,
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const hint =
      res.status === 403
        ? ' Check that FIGMA_TOKEN is valid and has access to this file.'
        : res.status === 404
          ? ' The file or frame was not found. Check the link.'
          : res.status === 429
            ? ' Figma rate limit hit. Wait a minute and retry.'
            : '';
    throw new Error(`Figma API ${res.status} ${res.statusText}.${hint} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/* ---------- minimal Figma REST shapes we use ---------- */
interface FColor { r: number; g: number; b: number; a: number }
interface FPaint { type: string; visible?: boolean; opacity?: number; color?: FColor }
interface FEffect { type: string; visible?: boolean; color?: FColor; offset?: { x: number; y: number }; radius?: number; spread?: number }
interface FNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  children?: FNode[];
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number } | null;
  fills?: FPaint[];
  strokes?: FPaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  opacity?: number;
  characters?: string;
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number; letterSpacing?: number };
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  itemSpacing?: number;
  effects?: FEffect[];
}

export function colorToHex(c: FColor, opacity = 1): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const a = (c.a ?? 1) * opacity;
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${a < 0.999 ? h(a) : ''}`;
}

function firstSolid(paints?: FPaint[]): string | undefined {
  const p = paints?.find((x) => x.visible !== false && x.type === 'SOLID' && x.color);
  return p?.color ? colorToHex(p.color, p.opacity ?? 1) : undefined;
}

function effectToCss(e: FEffect): string | undefined {
  if (e.visible === false) return undefined;
  if (e.type !== 'DROP_SHADOW' && e.type !== 'INNER_SHADOW') return `${e.type.toLowerCase()}(${e.radius ?? 0}px)`;
  const c = e.color ? colorToHex(e.color) : '#000000';
  return `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${e.offset?.x ?? 0}px ${e.offset?.y ?? 0}px ${e.radius ?? 0}px ${e.spread ?? 0}px ${c}`;
}

/** Flattens the frame tree into a list with boxes relative to the frame origin. */
export function flattenNodes(root: FNode): DesignNode[] {
  const origin = root.absoluteBoundingBox ?? { x: 0, y: 0, width: 0, height: 0 };
  const out: DesignNode[] = [];
  const walk = (n: FNode, depth: number, parentId?: string) => {
    if (out.length >= MAX_NODES || n.visible === false) return;
    const bb = n.absoluteBoundingBox;
    if (bb) {
      const box: Box = {
        x: Math.round((bb.x - origin.x) * 100) / 100,
        y: Math.round((bb.y - origin.y) * 100) / 100,
        width: Math.round(bb.width * 100) / 100,
        height: Math.round(bb.height * 100) / 100,
      };
      const node: DesignNode = { id: n.id, name: n.name, type: n.type, depth, parentId, box };
      if (n.characters) node.text = n.characters.slice(0, 200);
      const fill = firstSolid(n.fills);
      if (fill) node.fill = fill;
      const stroke = firstSolid(n.strokes);
      if (stroke) {
        node.stroke = stroke;
        node.strokeWeight = n.strokeWeight;
      }
      if (n.rectangleCornerRadii) node.cornerRadius = n.rectangleCornerRadii;
      else if (n.cornerRadius) node.cornerRadius = n.cornerRadius;
      if (n.opacity !== undefined && n.opacity < 1) node.opacity = n.opacity;
      if (n.style && n.type === 'TEXT') {
        node.font = {
          family: n.style.fontFamily,
          size: n.style.fontSize,
          weight: n.style.fontWeight,
          lineHeight: n.style.lineHeightPx,
          letterSpacing: n.style.letterSpacing,
        };
      }
      if (n.paddingTop || n.paddingRight || n.paddingBottom || n.paddingLeft) {
        node.padding = {
          top: n.paddingTop ?? 0,
          right: n.paddingRight ?? 0,
          bottom: n.paddingBottom ?? 0,
          left: n.paddingLeft ?? 0,
        };
      }
      if (n.itemSpacing) node.itemSpacing = n.itemSpacing;
      const effects = (n.effects ?? []).map(effectToCss).filter((x): x is string => !!x);
      if (effects.length) node.effects = effects;
      out.push(node);
    }
    for (const c of n.children ?? []) walk(c, depth + 1, n.id);
  };
  walk(root, 0);
  return out;
}

export interface FigmaFrame extends FigmaRef {
  name: string;
  width: number;
  height: number;
  png: Buffer;
  nodes: DesignNode[];
}

interface FrameInfo {
  name: string;
  width: number;
  height: number;
  nodes: DesignNode[];
}

export interface FetchOptions {
  /** Folder for cached Figma responses (Figma rate limits are strict). */
  cacheDir?: string;
  /** Ignore the cache and download again. */
  refresh?: boolean;
}

async function readCache<T>(file: string | undefined, parse: (b: Buffer) => T): Promise<T | undefined> {
  if (!file) return undefined;
  try {
    return parse(await fs.readFile(file));
  } catch {
    return undefined;
  }
}

async function fetchFrameInfo(fileKey: string, nodeId: string, token: string): Promise<FrameInfo> {
  const res = await figmaGet<{ nodes: Record<string, { document: FNode } | null> }>(
    `/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`,
    token,
  );
  const doc = res.nodes?.[nodeId]?.document;
  if (!doc) throw new Error(`Frame ${nodeId} was not found in file ${fileKey}.`);
  const bb = doc.absoluteBoundingBox;
  return { name: doc.name, width: Math.round(bb?.width ?? 0), height: Math.round(bb?.height ?? 0), nodes: flattenNodes(doc) };
}

async function fetchFramePng(fileKey: string, nodeId: string, scale: number, token: string): Promise<Buffer> {
  const res = await figmaGet<{ err?: string | null; images: Record<string, string | null> }>(
    // use_absolute_bounds: render exactly the frame box, without shadows/overflow widening the image.
    `/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}&use_absolute_bounds=true`,
    token,
  );
  const imageUrl = res.images?.[nodeId];
  if (!imageUrl) throw new Error(`Figma could not render frame ${nodeId}${res.err ? `: ${res.err}` : ''}.`);
  const img = await fetch(imageUrl);
  if (!img.ok) throw new Error(`Downloading the Figma render failed: ${img.status}`);
  return Buffer.from(await img.arrayBuffer());
}

export async function fetchFrame(url: string, scale: number, token: string, opts: FetchOptions = {}): Promise<FigmaFrame & { cached: boolean }> {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  const base = opts.cacheDir ? path.join(opts.cacheDir, `${fileKey}_${nodeId.replace(/[^\w-]/g, '-')}`) : undefined;
  const infoFile = base && `${base}.json`;
  const pngFile = base && `${base}@${scale}x.png`;

  let info = opts.refresh ? undefined : await readCache(infoFile, (b) => JSON.parse(b.toString('utf8')) as FrameInfo);
  let png = opts.refresh ? undefined : await readCache(pngFile, (b) => b);
  const cached = !!info && !!png;

  if (!info) info = await fetchFrameInfo(fileKey, nodeId, token);
  if (!png) png = await fetchFramePng(fileKey, nodeId, scale, token);

  if (base && !cached) {
    await fs.mkdir(path.dirname(base), { recursive: true });
    await fs.writeFile(infoFile!, JSON.stringify(info));
    await fs.writeFile(pngFile!, png);
  }
  return { fileKey, nodeId, ...info, png, cached };
}
