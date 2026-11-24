#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import sharp from 'sharp';
import { z } from 'zod';
import { closeBrowser } from './capture/playwright.js';
import {
  runPropertyCheck,
  createCapture,
  createDesignFromFigma,
  createDesignFromImage,
  cropPair,
  getRegions,
  overviewImage,
  runAnnotate,
  runCompare,
  runSaveReport,
} from './pipeline.js';
import { outRoot } from './store.js';
import type { DesignNode, Issue } from './types.js';

type Content =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

const text = (t: string): Content => ({ type: 'text', text: t });
const json = (o: unknown): Content => text(JSON.stringify(o, null, 2));

/** Image block small enough for Claude to look at. */
async function image(png: Buffer, maxW = 1600, maxH = 1600): Promise<Content> {
  const buf = await sharp(png).resize({ width: maxW, height: maxH, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  return { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' };
}

function handle<A>(fn: (args: A) => Promise<Content[]>) {
  return async (args: A) => {
    try {
      return { content: await fn(args) };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[visual-qa]', e);
      return { content: [text(`Error: ${msg}`)], isError: true };
    }
  };
}

/** Compact listing of Figma layers for Claude to read. */
function layerSummary(nodes: DesignNode[], limit = 80) {
  return nodes
    .filter((n) => n.depth > 0)
    .slice(0, limit)
    .map((n) => ({
      id: n.id,
      name: n.name,
      type: n.type,
      box: n.box,
      ...(n.text ? { text: n.text.slice(0, 60) } : {}),
      ...(n.fill ? { fill: n.fill } : {}),
      ...(n.font ? { font: n.font } : {}),
      ...(n.cornerRadius ? { radius: n.cornerRadius } : {}),
      ...(n.padding ? { padding: n.padding } : {}),
    }));
}

const boxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

const issueSchema = z.object({
  id: z.string().optional(),
  title: z.string().describe('Short, specific: "Login button is 8px too narrow"'),
  type: z.enum(['layout', 'spacing', 'size', 'color', 'typography', 'shape', 'content', 'missing', 'extra', 'image', 'other']),
  severity: z.enum(['high', 'medium', 'low']),
  box: boxSchema.describe('Where to draw the marker, in build screenshot pixels (same coordinates as diff regions).'),
  selector: z.string().optional(),
  designLayer: z.string().optional(),
  expected: z.string().optional().describe('Value in the design, e.g. "padding 16px, #4F46E5"'),
  actual: z.string().optional().describe('Value in the build'),
  fix: z.string().optional().describe('Suggested fix in plain words'),
  code: z.string().optional().describe('Fix code for the developer: CSS / Tailwind / JSX, before → after'),
});

const server = new McpServer({ name: 'visual-qa', version: '0.1.0' });

server.registerTool(
  'figma_get_frame',
  {
    title: 'Get Figma frame',
    description:
      'Downloads a Figma frame as the reference design: a PNG render plus every layer (position, size, fill colour, font, radius, padding). Needs FIGMA_TOKEN. Returns a designId for capture_page/compare.',
    inputSchema: {
      figmaUrl: z.string().describe('Figma link to a frame (must include ?node-id=...)'),
      scale: z.number().min(0.5).max(4).default(1).describe('Export scale. 1 matches CSS pixels.'),
      refresh: z.boolean().default(false).describe('Download again even if this frame is cached (use after the design changed).'),
    },
  },
  handle(async ({ figmaUrl, scale, refresh }: { figmaUrl: string; scale: number; refresh: boolean }) => {
    const { meta, dir, nodes, cached } = await createDesignFromFigma(figmaUrl, scale, refresh);
    const png = await sharp(`${dir}/design.png`).toBuffer();
    return [
      json({
        designId: meta.designId,
        frame: meta.name,
        fromCache: cached,
        width: meta.width,
        height: meta.height,
        suggestedCaptureWidth: meta.width,
        layerCount: meta.nodeCount,
        layers: layerSummary(nodes),
        files: { image: `${dir}/design.png`, layers: `${dir}/nodes.json` },
      }),
      await image(png),
    ];
  }),
);

server.registerTool(
  'load_design_image',
  {
    title: 'Load design image',
    description:
      'Uses a local image (PNG/JPG exported from Figma or any design tool) as the reference design, when no Figma token or link is available. Returns a designId.',
    inputSchema: {
      imagePath: z.string().describe('Path to the exported design image'),
      name: z.string().optional(),
      scale: z.number().min(0.5).max(4).default(1).describe('2 if the image was exported at 2x'),
    },
  },
  handle(async ({ imagePath, name, scale }: { imagePath: string; name?: string; scale: number }) => {
    const { meta, dir } = await createDesignFromImage(imagePath, { name, scale });
    return [
      json({ designId: meta.designId, name: meta.name, width: meta.width, height: meta.height, suggestedCaptureWidth: meta.width, file: `${dir}/design.png` }),
    ];
  }),
);

server.registerTool(
  'capture_page',
  {
    title: 'Capture live page',
    description:
      'Opens the page in headless Chromium, takes a full-page screenshot and records every visible element with its computed CSS. Pass designId to use the design frame width automatically. Returns a captureId.',
    inputSchema: {
      url: z.string().describe('http(s):// or file:// URL of the built page'),
      designId: z.string().optional().describe('Use this design frame width as the viewport width'),
      width: z.number().int().min(200).max(4000).optional(),
      height: z.number().int().min(200).max(4000).optional().describe('Viewport height (default 900)'),
      fullPage: z.boolean().default(true),
      waitFor: z.string().optional().describe('CSS selector to wait for'),
      delayMs: z.number().int().min(0).max(30000).optional(),
      hideSelectors: z.array(z.string()).optional().describe('Selectors to hide, e.g. chat widgets'),
      hideCookieBanners: z.boolean().default(true).describe('Hide cookie/consent banners'),
      hideChatWidgets: z.boolean().default(true).describe('Hide small fixed chat bubbles in the bottom corners'),
      storageStatePath: z.string().optional().describe('Playwright storage-state JSON for logged-in pages'),
    },
  },
  handle(async (args: {
    url: string;
    designId?: string;
    width?: number;
    height?: number;
    fullPage: boolean;
    waitFor?: string;
    delayMs?: number;
    hideSelectors?: string[];
    hideCookieBanners: boolean;
    hideChatWidgets: boolean;
    storageStatePath?: string;
  }) => {
    const { meta, dir } = await createCapture(args);
    const png = await sharp(`${dir}/live.png`).toBuffer();
    return [
      json({
        captureId: meta.captureId,
        title: meta.title,
        viewport: `${meta.viewportWidth}x${meta.viewportHeight}`,
        page: `${meta.pageWidth}x${meta.pageHeight}`,
        elements: meta.domCount,
        horizontalOverflow: meta.pageWidth > meta.viewportWidth,
        files: { screenshot: `${dir}/live.png`, dom: `${dir}/dom.json` },
      }),
      await image(png),
    ];
  }),
);

server.registerTool(
  'compare',
  {
    title: 'Compare design and build',
    description:
      'Aligns the design and the build screenshot, lines up their rows (so vertical drift does not flag the whole page), runs a pixel diff and groups the differences into regions. Returns: `gaps` (where the build has more/less vertical space or extra/missing content vs the design, in px), `regions` (areas that differ, with the likely HTML element and Figma layer), an overview image and zoomed crops. Regions are CANDIDATES: review them visually before reporting.',
    inputSchema: {
      designId: z.string(),
      captureId: z.string(),
      threshold: z.number().min(0).max(1).default(0.05).describe('Pixel colour tolerance (0 = exact). Raise to 0.1 if photos/gradients create too much noise.'),
      maxRegions: z.number().int().min(1).max(60).default(25),
      crops: z.number().int().min(0).max(8).default(4).describe('How many zoomed region crops to include'),
      alignRows: z.boolean().default(true).describe('Line up design and build rows before diffing'),
    },
  },
  handle(async (args: { designId: string; captureId: string; threshold: number; maxRegions: number; crops: number; alignRows: boolean }) => {
    const r = await runCompare(args);
    const out: Content[] = [
      json({
        runId: r.meta.runId,
        size: `${r.meta.width}x${r.meta.height}`,
        designToLiveScale: Math.round(r.meta.designToLiveScale * 1000) / 1000,
        pixelsDifferent: `${(r.meta.diffRatio * 100).toFixed(2)}%`,
        heights: { design: r.meta.designHeight, build: r.meta.liveHeight },
        gaps: r.gaps,
        regions: r.regions,
        files: { ...r.files, folder: r.dir },
      }),
      await image(await overviewImage(r.meta.runId), 1800, 1600),
    ];
    for (const region of r.regions.slice(0, args.crops)) {
      out.push(text(`Region ${region.id}: ${region.dom?.selector ?? 'unknown element'}${region.design ? ` ↔ Figma "${region.design.name}"` : ''}`));
      out.push(await image(await cropPair(r.meta.runId, region.box, { label: region.id }), 1400, 900));
    }
    return out;
  }),
);

server.registerTool(
  'inspect_region',
  {
    title: 'Zoom into a region',
    description: 'Shows a zoomed Design vs Build crop for a region id from compare, or for any box, to check details closely.',
    inputSchema: {
      runId: z.string(),
      regionId: z.string().optional(),
      box: boxSchema.optional(),
      padding: z.number().int().min(0).max(200).default(24),
    },
  },
  handle(async ({ runId, regionId, box, padding }: { runId: string; regionId?: string; box?: { x: number; y: number; width: number; height: number }; padding: number }) => {
    let target = box;
    let label = 'area';
    if (regionId) {
      const region = (await getRegions(runId)).find((r) => r.id === regionId);
      if (!region) throw new Error(`Region ${regionId} not found in run ${runId}.`);
      target = region.box;
      label = region.id;
    }
    if (!target) throw new Error('Pass regionId or box.');
    return [await image(await cropPair(runId, target, { padding, label }), 1600, 1200)];
  }),
);

server.registerTool(
  'check_properties',
  {
    title: 'Exact property check',
    description:
      'Phase 2 exact check (needs a Figma design from figma_get_frame). Matches Figma layers to page elements (text first, then boxes) and compares exact values: font family/size/weight/line-height/letter-spacing, text and background colour (ΔE2000), border radius, border, shadow, padding, gap, size and position. Identical problems on several elements are grouped. Each issue comes with CSS and Tailwind fix code. Also lists design text missing from the page and page text not in the design.',
    inputSchema: {
      runId: z.string(),
      maxIssues: z.number().int().min(1).max(200).default(60),
      tolerances: z
        .object({
          position: z.number().optional(),
          size: z.number().optional(),
          fontSize: z.number().optional(),
          lineHeight: z.number().optional(),
          letterSpacing: z.number().optional(),
          radius: z.number().optional(),
          colorDeltaE: z.number().optional(),
          padding: z.number().optional(),
        })
        .optional()
        .describe('Allowed differences. Defaults: position 4px, size 2px, font-size 0.5px, line-height 1px, radius 1px, colour ΔE 3, padding 1px.'),
    },
  },
  handle(async ({ runId, maxIssues, tolerances }: { runId: string; maxIssues: number; tolerances?: Record<string, number> }) => {
    const r = await runPropertyCheck(runId, tolerances ?? {});
    return [
      json({
        stats: r.stats,
        issues: r.issues.slice(0, maxIssues).map(({ findings, selectors, ...i }) => ({ ...i, alsoAt: selectors.slice(1, 6) })),
        moreIssues: Math.max(0, r.issues.length - maxIssues),
        missingText: r.missingText.slice(0, 40),
        extraText: r.extraText.slice(0, 40),
        file: r.file,
      }),
    ];
  }),
);

server.registerTool(
  'annotate',
  {
    title: 'Paint issues',
    description:
      'Paints the confirmed issues as numbered boxes (red = high, orange = medium, blue = low) on the build screenshot. Also writes a side-by-side image and an overlay image. Pass only issues you verified.',
    inputSchema: {
      runId: z.string(),
      issues: z.array(issueSchema),
    },
  },
  handle(async ({ runId, issues }: { runId: string; issues: Issue[] }) => {
    const r = await runAnnotate(runId, issues);
    return [json({ files: r.files, count: r.issues.length }), await image(r.sideBySide, 1800, 1600)];
  }),
);

server.registerTool(
  'save_report',
  {
    title: 'Save HTML report',
    description:
      'Writes report.html (self-contained, shareable, with images embedded) and report.json for a run. Uses the issues from annotate unless new ones are passed.',
    inputSchema: {
      runId: z.string(),
      summary: z.string().optional().describe('2-4 sentence overall verdict'),
      issues: z.array(issueSchema).optional(),
    },
  },
  handle(async ({ runId, summary, issues }: { runId: string; summary?: string; issues?: Issue[] }) => {
    const r = await runSaveReport(runId, { summary, issues });
    return [json({ ...r.files, issues: r.count, outputRoot: outRoot() })];
  }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[visual-qa] MCP server ready. Output folder: ${outRoot()}`);
}

const shutdown = async () => {
  await closeBrowser();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('close', shutdown);

main().catch((e) => {
  console.error('[visual-qa] fatal', e);
  process.exit(1);
});
