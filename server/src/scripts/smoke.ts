/**
 * End-to-end smoke test without Claude or Figma:
 *   design HTML → PNG (stands in for a Figma export) → capture build → compare → annotate → report.
 * Run: npm run build && npm run smoke
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { capturePage, closeBrowser } from '../capture/playwright.js';
import { createCapture, createDesignFromImage, runAnnotate, runCompare, runSaveReport } from '../pipeline.js';
import type { Issue } from '../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.resolve(here, '../../../test-fixtures');
process.env.VISUAL_QA_OUT_DIR ??= path.resolve(here, '../../../qa-reports');

async function main() {
  const width = 1000;
  const designUrl = pathToFileURL(path.join(fixtures, 'login-design.html')).href;
  const buildUrl = pathToFileURL(path.join(fixtures, 'login-build.html')).href;

  // 1. Render the "design" to a PNG, as if exported from Figma.
  const designShot = await capturePage({ url: designUrl, width });
  const designPng = path.join(process.env.VISUAL_QA_OUT_DIR!, '_fixture-design.png');
  await fs.mkdir(path.dirname(designPng), { recursive: true });
  await fs.writeFile(designPng, designShot.png);
  const design = await createDesignFromImage(designPng, { name: 'login-design' });
  console.log('design  ', design.meta.designId, `${design.meta.width}x${design.meta.height}`);

  // 2. Capture the developer build.
  const capture = await createCapture({ url: buildUrl, designId: design.meta.designId });
  console.log('capture ', capture.meta.captureId, `${capture.meta.domCount} elements`);

  // 3. Compare.
  const run = await runCompare({ designId: design.meta.designId, captureId: capture.meta.captureId });
  console.log('run     ', run.meta.runId, `${(run.meta.diffRatio * 100).toFixed(2)}% pixels differ`);
  for (const r of run.regions) {
    const kind = r.kind === 'shifted' ? `shifted(${r.shift!.dx},${r.shift!.dy})` : 'changed';
    console.log(`  ${r.id.padEnd(4)} ${JSON.stringify(r.box).padEnd(44)} px=${String(r.pixels).padEnd(6)} ${kind.padEnd(15)} ${r.dom?.selector ?? '-'}`);
    for (const e of r.elements ?? []) console.log(`${' '.repeat(10)}· ${e.selector}${e.text ? ` "${e.text}"` : ''}`);
  }

  // 4. Without Claude, paint every region as a medium issue.
  const issues: Issue[] = run.regions.map((r) => ({
    title: `Difference near ${r.dom?.selector ?? 'unknown element'}`,
    type: 'other',
    severity: 'medium',
    box: r.box,
    selector: r.dom?.selector,
  }));
  const ann = await runAnnotate(run.meta.runId, issues);
  const rep = await runSaveReport(run.meta.runId, { summary: 'Smoke test: raw diff regions, not reviewed by Claude.' });
  console.log('annotated', ann.files.sideBySide);
  console.log('report   ', rep.files.html);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeBrowser);
