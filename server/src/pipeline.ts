import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { fetchFrame } from './figma/client.js';
import { capturePage, type CaptureOptions } from './capture/playwright.js';
import { alignImages, pixelDiff, rawToPng } from './diff/pixel.js';
import { area, findRegions, type RawRegion } from './diff/regions.js';
import { detectShift } from './diff/shift.js';
import { alignRows, mergeGaps, rowSignatures, warpDesign, type GapBlock } from './diff/align.js';
import { elementsInside, locateDesign, locateDom, scaleBox } from './match/locate.js';
import { blend, clampBox, drawIssues, fit, row } from './annotate/draw.js';
import { buildReportHtml, toShareFragment } from './report/html.js';
import { runPropertyChecks, type PropertyCheckResult } from './props/check.js';
import type { Tolerances } from './props/compare.js';
import { dirFor, exists, makeDir, newId, outRoot, pageSlug, readJson, readMeta, writeJson } from './store.js';
import type { Box, CaptureMeta, DesignMeta, DesignNode, DiffRegion, DomNode, Issue, RunMeta } from './types.js';

/* ------------------------------------------------------------------ design */

export async function createDesignFromFigma(
  figmaUrl: string,
  scale = 1,
  refresh = false,
): Promise<{ meta: DesignMeta; dir: string; nodes: DesignNode[]; cached: boolean }> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      'FIGMA_TOKEN is not set. Create a personal access token in Figma (Settings → Security → Personal access tokens, scope "File content: read") and set it as the FIGMA_TOKEN environment variable, then restart Claude Code. Or export the frame as PNG and use load_design_image.',
    );
  }
  const frame = await fetchFrame(figmaUrl, scale, token, { cacheDir: path.join(outRoot(), '_figma-cache'), refresh });
  const designId = newId('d', frame.name);
  const dir = await makeDir('design', designId);
  await fs.writeFile(path.join(dir, 'design.png'), frame.png);
  await writeJson(path.join(dir, 'nodes.json'), frame.nodes);
  const meta: DesignMeta = {
    designId,
    source: 'figma',
    name: frame.name,
    width: frame.width,
    height: frame.height,
    scale,
    figmaUrl,
    fileKey: frame.fileKey,
    nodeId: frame.nodeId,
    nodeCount: frame.nodes.length,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  return { meta, dir, nodes: frame.nodes, cached: frame.cached };
}

export async function createDesignFromImage(imagePath: string, opts: { name?: string; scale?: number } = {}): Promise<{ meta: DesignMeta; dir: string }> {
  const abs = path.resolve(imagePath);
  if (!(await exists(abs))) throw new Error(`Design image not found: ${abs}`);
  const scale = opts.scale ?? 1;
  const png = await sharp(abs).png().toBuffer({ resolveWithObject: true });
  const name = opts.name ?? path.basename(abs).replace(/\.[a-z]+$/i, '');
  const designId = newId('d', name);
  const dir = await makeDir('design', designId);
  await fs.writeFile(path.join(dir, 'design.png'), png.data);
  await writeJson(path.join(dir, 'nodes.json'), []);
  const meta: DesignMeta = {
    designId,
    source: 'image',
    name,
    width: Math.round(png.info.width / scale),
    height: Math.round(png.info.height / scale),
    scale,
    nodeCount: 0,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  return { meta, dir };
}

/* ----------------------------------------------------------------- capture */

export async function createCapture(
  opts: Omit<CaptureOptions, 'width'> & { width?: number; designId?: string },
): Promise<{ meta: CaptureMeta; dir: string; dom: DomNode[] }> {
  let width = opts.width;
  if (!width && opts.designId) width = (await readMeta<DesignMeta>('design', opts.designId)).width;
  width ||= 1440;

  const result = await capturePage({ ...opts, width });
  const captureId = newId('c', pageSlug(opts.url));
  const dir = await makeDir('capture', captureId);
  await fs.writeFile(path.join(dir, 'live.png'), result.png);
  await writeJson(path.join(dir, 'dom.json'), result.dom);
  const meta: CaptureMeta = {
    captureId,
    url: opts.url,
    title: result.title,
    viewportWidth: width,
    viewportHeight: opts.height ?? 900,
    pageWidth: result.pageWidth,
    pageHeight: result.pageHeight,
    domCount: result.dom.length,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  return { meta, dir, dom: result.dom };
}

/* ----------------------------------------------------------------- compare */

export interface RowGapFinding {
  id: string;
  kind: GapBlock['kind'];
  /** Build height minus design height here, in design (CSS) px. Negative = build is shorter. */
  net: number;
  /** Area in the build screenshot (page px). */
  build: { y: number; height: number };
  /** Area in the design frame (1x px). */
  design: { y: number; height: number };
  /** First element at/after the gap: usually the one whose margin or position changed. */
  nextElement?: { selector: string; tag: string; text?: string };
  /** Elements inside an extra-content gap. */
  elements?: { selector: string; tag: string; text?: string }[];
}

export interface CompareResult {
  meta: RunMeta;
  dir: string;
  regions: DiffRegion[];
  gaps: RowGapFinding[];
  files: { design: string; designAligned: string; live: string; heatmap: string };
}

export async function runCompare(opts: {
  designId: string;
  captureId: string;
  threshold?: number;
  maxRegions?: number;
  /** Line up design and build rows first, so vertical drift does not flag everything below it. Default true. */
  alignRows?: boolean;
}): Promise<CompareResult> {
  // 0.05 catches close colour swaps (e.g. #4F46E5 → #2563EB) that 0.1 misses once rows are aligned.
  const threshold = opts.threshold ?? 0.05;
  const design = await readMeta<DesignMeta>('design', opts.designId);
  const capture = await readMeta<CaptureMeta>('capture', opts.captureId);
  const dDir = dirFor('design', opts.designId);
  const cDir = dirFor('capture', opts.captureId);

  const [designPng, livePng, nodes, dom] = await Promise.all([
    fs.readFile(path.join(dDir, 'design.png')),
    fs.readFile(path.join(cDir, 'live.png')),
    readJson<DesignNode[]>(path.join(dDir, 'nodes.json')),
    readJson<DomNode[]>(path.join(cDir, 'dom.json')),
  ]);

  const aligned = await alignImages(designPng, livePng);
  const W = aligned.width;
  const H = aligned.liveHeight;
  const live = aligned.live.subarray(0, W * H * 4);
  const designToLiveScale = W / design.width;

  // Re-flow the design rows to match the build rows (handles vertical drift).
  let liveToDesign: Int32Array;
  let gaps: GapBlock[] = [];
  if (opts.alignRows ?? true) {
    const a = alignRows(rowSignatures(aligned.design, W, aligned.designHeight), rowSignatures(aligned.live, W, H));
    liveToDesign = a.liveToDesign;
    gaps = mergeGaps(a.gaps).filter((g) => Math.max(g.build.height, g.design.height) >= 4);
  } else {
    liveToDesign = Int32Array.from({ length: H }, (_, y) => (y < aligned.designHeight ? y : -1));
  }
  const designAligned = warpDesign(aligned.design, W, liveToDesign, aligned.designHeight);
  const diff = pixelDiff(designAligned, live, W, H, threshold);

  /** Build box → design box (1x Figma coordinates) through the row mapping. */
  const toDesignBox = (b: Box): Box => {
    const y0 = mappedRow(liveToDesign, b.y, 1), y1 = mappedRow(liveToDesign, b.y + b.height - 1, -1);
    const top = y0 >= 0 ? y0 : b.y, bottom = y1 >= 0 ? y1 : b.y + b.height - 1;
    return scaleBox({ x: b.x, y: top, width: b.width, height: Math.max(1, bottom - top + 1) }, 1 / designToLiveScale);
  };

  // Keep small fragments until they are grouped per element (e.g. 4 rounded corners), then drop noise.
  const raw = findRegions(diff.mask, W, H, { max: 400, minPixels: 4 });
  const grouped = groupByElement(raw, dom)
    .filter((g) => g.pixels >= 12)
    .sort((a, b) => b.pixels - a.pixels)
    .slice(0, opts.maxRegions ?? 25);

  const regions: DiffRegion[] = grouped.map((r, i) => {
    const shift = detectShift(designAligned, live, W, H, r.box);
    const region: DiffRegion = {
      id: `r${i + 1}`,
      box: r.box,
      pixels: r.pixels,
      density: Math.round((r.pixels / (r.box.width * r.box.height)) * 1000) / 1000,
      kind: shift ? 'shifted' : 'changed',
    };
    if (shift) region.shift = shift;
    const el = r.element ?? locateDom(r.box, dom);
    if (el) region.dom = { selector: el.selector, tag: el.tag, text: el.text };
    const inside = elementsInside(r.box, dom);
    if (inside.length > 1) region.elements = inside.map((n) => ({ selector: n.selector, tag: n.tag, text: n.text }));
    const layer = nodes.length ? locateDesign(toDesignBox(r.box), nodes, 1) : undefined;
    if (layer) region.design = { id: layer.id, name: layer.name, type: layer.type, text: layer.text };
    return region;
  });

  // Spacing / content gaps found by the row alignment, as findings with element hints.
  const px = (v: number) => Math.round(v / designToLiveScale);
  const rowGaps: RowGapFinding[] = gaps.map((g, i) => {
    const end = g.build.y + g.build.height;
    const below = dom
      .filter((n) => n.tag !== 'body' && n.box.y >= end - 2)
      .sort((a, b) => a.box.y - b.box.y || area(b.box) - area(a.box))[0];
    const inside = g.build.height >= 4 && g.kind !== 'more-space-in-build' ? elementsInside({ x: 0, y: g.build.y, width: W, height: g.build.height }, dom, 4) : [];
    return {
      id: `g${i + 1}`,
      kind: g.kind,
      net: px(g.net),
      build: g.build,
      design: { y: px(g.design.y), height: px(g.design.height) },
      nextElement: below ? { selector: below.selector, tag: below.tag, text: below.text } : undefined,
      elements: inside.length ? inside.map((n) => ({ selector: n.selector, tag: n.tag, text: n.text })) : undefined,
    };
  });

  const runId = newId('run', pageSlug(capture.url));
  const dir = await makeDir('run', runId);
  const files = {
    design: path.join(dir, 'design.png'),
    designAligned: path.join(dir, 'design-aligned.png'),
    live: path.join(dir, 'live.png'),
    heatmap: path.join(dir, 'heatmap.png'),
  };
  const [dOut, daOut, lOut, hOut] = await Promise.all([
    rawToPng(aligned.design.subarray(0, W * aligned.designHeight * 4) as Buffer, W, aligned.designHeight),
    rawToPng(hatchUnmatched(designAligned, W, liveToDesign), W, H),
    rawToPng(live as Buffer, W, H),
    rawToPng(diff.heatmap, W, H),
  ]);
  await Promise.all([
    fs.writeFile(files.design, dOut),
    fs.writeFile(files.designAligned, daOut),
    fs.writeFile(files.live, lOut),
    fs.writeFile(files.heatmap, hOut),
    writeJson(path.join(dir, 'regions.json'), regions),
    writeJson(path.join(dir, 'gaps.json'), rowGaps),
    // Build row → design row, so crops can show the real design area (including design-only rows).
    fs.writeFile(path.join(dir, 'row-map.bin'), Buffer.from(liveToDesign.buffer)),
  ]);

  const meta: RunMeta = {
    runId,
    designId: opts.designId,
    captureId: opts.captureId,
    pageUrl: capture.url,
    figmaUrl: design.figmaUrl,
    designName: design.name,
    width: W,
    height: H,
    designHeight: aligned.designHeight,
    liveHeight: aligned.liveHeight,
    designToLiveScale,
    threshold,
    mismatchedPixels: diff.mismatched,
    diffRatio: diff.ratio,
    regionCount: regions.length,
    createdAt: new Date().toISOString(),
  };
  await writeJson(path.join(dir, 'meta.json'), meta);
  return { meta, dir, regions, gaps: rowGaps, files };
}

/** For display: build-only rows get a light diagonal hatch ("nothing in the design here"). */
function hatchUnmatched(raw: Buffer, width: number, map: Int32Array): Buffer {
  const out = Buffer.from(raw);
  for (let y = 0; y < map.length; y++) {
    if (map[y] >= 0) continue;
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      const stripe = (x + y) % 12 < 2;
      out[p] = stripe ? 225 : 248;
      out[p + 1] = stripe ? 120 : 240;
      out[p + 2] = stripe ? 200 : 248;
      out[p + 3] = 255;
    }
  }
  return out;
}

/** Nearest build row (searching in `step` direction) that has a design match. */
function mappedRow(map: Int32Array, y: number, step: 1 | -1): number {
  for (let k = 0; k < 200; k++) {
    const j = y + k * step;
    if (j < 0 || j >= map.length) break;
    if (map[j] >= 0) return map[j];
  }
  return -1;
}

/** Design image whose rows line up with the build (falls back for older runs). */
async function alignedDesignFile(dir: string): Promise<string> {
  const f = path.join(dir, 'design-aligned.png');
  return (await exists(f)) ? f : path.join(dir, 'design.png');
}

/**
 * Joins diff fragments that belong to the same small element (e.g. the four edges
 * of an input whose corner radius changed) into one region covering that element.
 */
function groupByElement(raw: RawRegion[], dom: DomNode[]): (RawRegion & { element?: DomNode })[] {
  const groups = new Map<DomNode, RawRegion[]>();
  const loose: (RawRegion & { element?: DomNode })[] = [];
  for (const r of raw) {
    const el = locateDom(r.box, dom);
    if (!el) loose.push(r);
    else groups.set(el, [...(groups.get(el) ?? []), r]);
  }
  const out = [...loose];
  for (const [el, parts] of groups) {
    const partsArea = parts.reduce((s, p) => s + area(p.box), 0);
    const pixels = parts.reduce((s, p) => s + p.pixels, 0);
    // Only merge into small components; big containers (cards, sections) keep separate regions.
    if (parts.length > 1 && area(el.box) <= 8 * partsArea) {
      const box = [el.box, ...parts.map((p) => p.box)].reduce(unionBox);
      out.push({ box, pixels, element: el });
    } else {
      for (const p of parts) out.push({ ...p, element: el });
    }
  }
  return out;
}

function unionBox(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

/** Design | Live | Diff overview, sized for a quick look. */
export async function overviewImage(runId: string): Promise<Buffer> {
  const dir = dirFor('run', runId);
  const meta = await readMeta<RunMeta>('run', runId);
  const s = Math.min(1, 560 / meta.width, 2400 / meta.height);
  const w = Math.max(1, Math.round(meta.width * s));
  const load = (f: string) => sharp(path.join(dir, f)).resize({ width: w }).png().toBuffer();
  const [d, l, h] = await Promise.all([load('design.png'), load('live.png'), load('heatmap.png')]);
  return row([
    { png: d, label: 'Design' },
    { png: l, label: 'Build' },
    { png: h, label: 'Pixel diff' },
  ]);
}

/** Zoomed design vs build crop of one area. */
export async function cropPair(
  runId: string,
  box: Box,
  opts: { padding?: number; label?: string; liveFile?: string; buildLabel?: string } = {},
): Promise<Buffer> {
  const dir = dirFor('run', runId);
  const meta = await readMeta<RunMeta>('run', runId);
  const pad = opts.padding ?? 24;
  const b = clampBox({ x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad }, meta.width, meta.height);
  const zoom = Math.max(1, Math.min(3, 520 / b.width, 640 / b.height));
  const crop = (f: string) =>
    sharp(path.join(dir, f))
      .extract({ left: b.x, top: b.y, width: b.width, height: b.height })
      .resize({ width: Math.max(1, Math.round(b.width * zoom)), kernel: zoom > 1 ? 'nearest' : 'lanczos3' })
      .png()
      .toBuffer();
  // Design side: the original design at the rows that match this build area (shows design-only content too).
  let designCrop: Promise<Buffer>;
  let designY = b.y;
  const mapFile = path.join(dir, 'row-map.bin');
  if (await exists(mapFile)) {
    const buf = await fs.readFile(mapFile);
    const map = new Int32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    let top = mappedRow(map, b.y, 1);
    let bottom = mappedRow(map, b.y + b.height - 1, -1);
    if (top < 0) top = Math.max(0, b.y);
    if (bottom < top) bottom = top + b.height - 1;
    top = Math.max(0, Math.min(meta.designHeight - 1, top));
    bottom = Math.max(top, Math.min(meta.designHeight - 1, bottom));
    designY = top;
    designCrop = sharp(path.join(dir, 'design.png'))
      .extract({ left: b.x, top, width: b.width, height: bottom - top + 1 })
      .resize({ width: Math.max(1, Math.round(b.width * zoom)), kernel: zoom > 1 ? 'nearest' : 'lanczos3' })
      .png()
      .toBuffer();
  } else {
    designCrop = crop(path.basename(await alignedDesignFile(dir)));
  }
  const [d, l] = await Promise.all([designCrop, crop(opts.liveFile ?? 'live.png')]);
  const tag = opts.label ? `${opts.label} · ` : '';
  return row([
    { png: d, label: `${tag}Design (x${b.x} y${designY})` },
    { png: l, label: opts.buildLabel ?? `${tag}Build` },
  ]);
}

export async function getRegions(runId: string): Promise<DiffRegion[]> {
  return readJson<DiffRegion[]>(path.join(dirFor('run', runId), 'regions.json'));
}

/* -------------------------------------------------------- property check */

export async function runPropertyCheck(runId: string, tol: Partial<Tolerances> = {}): Promise<PropertyCheckResult & { file: string }> {
  const dir = dirFor('run', runId);
  const meta = await readMeta<RunMeta>('run', runId);
  const [nodes, dom, mapBuf] = await Promise.all([
    readJson<DesignNode[]>(path.join(dirFor('design', meta.designId), 'nodes.json')),
    readJson<DomNode[]>(path.join(dirFor('capture', meta.captureId), 'dom.json')),
    fs.readFile(path.join(dir, 'row-map.bin')).catch(() => undefined),
  ]);
  if (!nodes.length) {
    throw new Error('This design has no layer data (it was loaded from an image). Exact property checks need a Figma link (figma_get_frame).');
  }
  const map = mapBuf
    ? new Int32Array(mapBuf.buffer, mapBuf.byteOffset, mapBuf.byteLength / 4)
    : Int32Array.from({ length: meta.liveHeight }, (_, y) => (y < meta.designHeight ? y : -1));
  const result = runPropertyChecks(nodes, dom, map, meta.designHeight, meta.designToLiveScale, tol);
  const file = path.join(dir, 'properties.json');
  await writeJson(file, result);
  return { ...result, file };
}

/* ---------------------------------------------------------------- annotate */

export async function runAnnotate(runId: string, issues: Issue[]) {
  const dir = dirFor('run', runId);
  const meta = await readMeta<RunMeta>('run', runId);
  const numbered = issues.map((i, n) => ({ ...i, id: i.id ?? `i${n + 1}` }));

  const [designPng, designAlignedPng, livePng] = await Promise.all([
    fs.readFile(path.join(dir, 'design.png')),
    fs.readFile(await alignedDesignFile(dir)),
    fs.readFile(path.join(dir, 'live.png')),
  ]);
  const annotated = await drawIssues(livePng, numbered);
  const [dRaw, lRaw] = await Promise.all([
    sharp(designAlignedPng).ensureAlpha().raw().toBuffer(),
    sharp(livePng).ensureAlpha().raw().toBuffer(),
  ]);
  const overlay = await drawIssues(await rawToPng(blend(dRaw, lRaw), meta.width, meta.height), numbered);
  const sideBySide = await row([
    { png: designPng, label: 'Figma design' },
    { png: annotated, label: `Build: ${numbered.length} issue${numbered.length === 1 ? '' : 's'}` },
  ]);

  const files = {
    annotated: path.join(dir, 'annotated.png'),
    sideBySide: path.join(dir, 'side-by-side.png'),
    overlay: path.join(dir, 'overlay.png'),
    issues: path.join(dir, 'issues.json'),
  };
  await Promise.all([
    fs.writeFile(files.annotated, annotated),
    fs.writeFile(files.sideBySide, sideBySide),
    fs.writeFile(files.overlay, overlay),
    writeJson(files.issues, numbered),
  ]);
  return { files, issues: numbered, sideBySide };
}

/* ------------------------------------------------------------------ report */

async function dataUri(file: string, maxW = 1600): Promise<string | undefined> {
  if (!(await exists(file))) return undefined;
  const buf = await sharp(file).resize({ width: maxW, withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

export async function runSaveReport(runId: string, opts: { summary?: string; issues?: Issue[] } = {}) {
  const dir = dirFor('run', runId);
  const meta = await readMeta<RunMeta>('run', runId);
  let issues = opts.issues;
  if (issues) await runAnnotate(runId, issues);
  else {
    const f = path.join(dir, 'issues.json');
    if (!(await exists(f))) throw new Error('No issues saved for this run yet. Call annotate first, or pass issues.');
    issues = await readJson<Issue[]>(f);
  }

  const [sideBySide, annotated, overlay, heatmap] = await Promise.all([
    dataUri(path.join(dir, 'side-by-side.png'), 2000),
    dataUri(path.join(dir, 'annotated.png')),
    dataUri(path.join(dir, 'overlay.png')),
    dataUri(path.join(dir, 'heatmap.png')),
  ]);
  // One zoomed "Design vs Build (with marker)" picture per issue, so readers see exactly where to change.
  const issueDir = path.join(dir, 'issues');
  await fs.mkdir(issueDir, { recursive: true });
  const hasAnnotated = await exists(path.join(dir, 'annotated.png'));
  const issueImages: (string | undefined)[] = [];
  for (const [n, issue] of issues.entries()) {
    const png = await cropPair(runId, issue.box, {
      padding: 40,
      liveFile: hasAnnotated ? 'annotated.png' : 'live.png',
      buildLabel: `Build · issue ${n + 1}`,
    });
    const file = path.join(issueDir, `issue-${n + 1}.png`);
    await fs.writeFile(file, png);
    issueImages.push(await dataUri(file, 1400));
  }

  const propsFile = path.join(dir, 'properties.json');
  const measurements = (await exists(propsFile)) ? await readJson<PropertyCheckResult>(propsFile) : undefined;
  const html = buildReportHtml(meta, issues, { sideBySide, annotated, overlay, heatmap, issueImages }, opts.summary, measurements);
  const files = {
    html: path.join(dir, 'report.html'),
    /** Publish this one as a Claude Artifact (no document wrapper). */
    share: path.join(dir, 'report-share.html'),
    json: path.join(dir, 'report.json'),
  };
  await fs.writeFile(files.html, html, 'utf8');
  await fs.writeFile(files.share, toShareFragment(html), 'utf8');
  await writeJson(files.json, { ...meta, summary: opts.summary, issues });
  return { files, count: issues.length };
}
