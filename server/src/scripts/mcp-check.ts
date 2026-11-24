/**
 * Talks to the MCP server over stdio exactly like Claude does:
 * lists tools, then runs load_design_image → capture_page → compare → annotate → save_report.
 * Run: npm run build && node dist/scripts/mcp-check.js
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { capturePage, closeBrowser } from '../capture/playwright.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const outDir = path.join(root, 'qa-reports');

type Block = { type: string; text?: string; data?: string };

function summarise(name: string, result: object) {
  const res = result as { content?: Block[]; isError?: boolean };
  const blocks = res.content ?? [];
  const images = blocks.filter((b) => b.type === 'image');
  const first = blocks.find((b) => b.type === 'text')?.text ?? '';
  console.log(`\n▶ ${name}${res.isError ? '  (ERROR)' : ''}  · ${images.length} image(s)`);
  console.log(first.length > 600 ? first.slice(0, 600) + ' …' : first);
  if (res.isError) throw new Error(`${name} failed`);
  return first ? JSON.parse(first) : {};
}

async function main() {
  // Design PNG from the fixture, standing in for a Figma export.
  const shot = await capturePage({ url: pathToFileURL(path.join(root, 'test-fixtures/login-design.html')).href, width: 1000 });
  await closeBrowser();
  const designPng = path.join(outDir, '_fixture-design.png');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(designPng, shot.png);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '..', 'index.js')],
    env: { ...process.env, VISUAL_QA_OUT_DIR: outDir } as Record<string, string>,
    stderr: 'inherit',
  });
  const client = new Client({ name: 'mcp-check', version: '0.0.0' });
  await client.connect(transport);

  try {
    await steps(client, designPng);
  } finally {
    await client.close();
  }
}

async function steps(client: Client, designPng: string) {
  const { tools } = await client.listTools();
  console.log('tools:', tools.map((t) => t.name).join(', '));

  const d = summarise('load_design_image', await client.callTool({ name: 'load_design_image', arguments: { imagePath: designPng } }));
  const c = summarise(
    'capture_page',
    await client.callTool({
      name: 'capture_page',
      arguments: { url: pathToFileURL(path.join(root, 'test-fixtures/login-build.html')).href, designId: d.designId },
    }),
  );
  const r = summarise('compare', await client.callTool({ name: 'compare', arguments: { designId: d.designId, captureId: c.captureId, crops: 2 } }));
  const first = r.regions[0];
  summarise('inspect_region', await client.callTool({ name: 'inspect_region', arguments: { runId: r.runId, regionId: first.id } }));
  summarise(
    'annotate',
    await client.callTool({
      name: 'annotate',
      arguments: {
        runId: r.runId,
        issues: [
          {
            title: 'Sign in button colour is lighter than design',
            type: 'color',
            severity: 'high',
            box: first.box,
            expected: '#4F46E5',
            actual: '#6366F1',
            fix: '.btn { background: #4f46e5; }',
          },
        ],
      },
    }),
  );
  summarise('save_report', await client.callTool({ name: 'save_report', arguments: { runId: r.runId, summary: 'MCP check run.' } }));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
