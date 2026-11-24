import type { Box, DesignNode, DomNode, Issue, Severity } from '../types.js';
import { comparePosition, compareBox, compareText, DEFAULT_TOLERANCES, type BoxContext, type PropFinding, type Tolerances } from './compare.js';
import {
  designToLiveRows,
  domContentBounds,
  effectiveBackgrounds,
  figmaContentBounds,
  matchNodes,
  normText,
  visibleBorder,
  visibleRadius,
  visibleBackground,
  type Pair,
} from './matcher.js';
import { area, intersection } from '../diff/regions.js';

const intersectsMostly = (inner: Box, outer: Box) => intersection(inner, outer) >= 0.9 * area(inner);

export interface PropertyIssue extends Issue {
  /** How many elements share exactly this problem. */
  count: number;
  selectors: string[];
  figmaLayers: string[];
  findings: PropFinding[];
  code: string;
}

export interface PropertyCheckResult {
  stats: {
    figmaTextLayers: number;
    matchedText: number;
    matchedBoxes: number;
    elementsWithFindings: number;
  };
  issues: PropertyIssue[];
  /** Figma text that was not found on the page (changed or missing content). */
  missingText: { text: string; layer: string; at: Box }[];
  /** Page text with no Figma counterpart (extra or changed content). */
  extraText: { text: string; selector: string; at: Box }[];
}

const SEV_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
const maxSev = (a: Severity, b: Severity) => (SEV_RANK[a] >= SEV_RANK[b] ? a : b);

function union(a: Box, b: Box): Box {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function subject(p: Pair): string {
  const text = p.dom.text ?? p.design.text;
  if (text) return `"${text.length > 38 ? text.slice(0, 36) + '…' : text}"`;
  return `${p.design.name} (${p.dom.tag})`;
}

function codeFor(selector: string, findings: PropFinding[]): string {
  const css = findings.map((f) => `  ${f.css}`).join('\n');
  const tw = findings.map((f) => f.tw).filter(Boolean).join(' ');
  return `/* ${selector} */\n{\n${css}\n}${tw ? `\n/* Tailwind: ${tw} */` : ''}`;
}

/** Same problem on several elements → one issue ("6× card description: line-height …"). */
function signature(p: Pair, findings: PropFinding[]): string {
  const pos = findings.find((f) => f.property === 'position');
  const rest = findings
    .filter((f) => f.property !== 'position')
    .map((f) => `${f.property}=${f.expected}|${f.actual.replace(/\s*\(ΔE[^)]*\)/, '')}`)
    .sort()
    .join(';');
  // Position-only findings group by offset (e.g. a whole column shifted by the same amount).
  const posKey = pos && !rest ? pos.actual.replace(/^.*\(/, '(') : '';
  return `${p.dom.tag}#${rest}#${posKey}`;
}

export function runPropertyChecks(
  nodes: DesignNode[],
  dom: DomNode[],
  liveToDesign: Int32Array,
  designHeightAtBuildWidth: number,
  scale: number,
  tol: Partial<Tolerances> = {},
): PropertyCheckResult {
  const t = { ...DEFAULT_TOLERANCES, ...tol };
  const d2l = designToLiveRows(liveToDesign, designHeightAtBuildWidth);
  const bgs = effectiveBackgrounds(dom);
  const frameWidth = (nodes.find((n) => n.depth === 0)?.box.width ?? 1440) * scale;
  const children = new Map<string, DesignNode[]>();
  for (const n of nodes) if (n.parentId) children.set(n.parentId, [...(children.get(n.parentId) ?? []), n]);

  const ctxFor = (d: DesignNode, el: DomNode): BoxContext => ({
    effectiveBg: visibleBackground(el, dom, bgs.get(el)),
    scale,
    tol: t,
    border: visibleBorder(el, dom),
    radius: visibleRadius(el, dom),
    domContent: d.padding ? domContentBounds(el, dom) : undefined,
    figmaContent: d.padding ? figmaContentBounds(d, children) : undefined,
    frameWidth,
  });
  /** Text that follows an icon inside the same element (e.g. "📍 London"). */
  const hasLeadingIcon = (el: DomNode) =>
    dom.some((n) => n.depth > el.depth && (n.tag === 'svg' || n.tag === 'img') && n.box.x <= el.box.x + 24 && intersectsMostly(n.box, el.box));

  const findingsFor = (p: Pair): PropFinding[] => {
    const f = p.how === 'text' ? compareText(p.design, p.dom, t) : compareBox(p.design, p.dom, ctxFor(p.design, p.dom));
    const pos = comparePosition(p, t, { leadingIcon: p.how === 'text' && hasLeadingIcon(p.dom), frameWidth });
    return pos ? [...f, pos] : f;
  };

  // Prefer, among equally overlapping candidates, the element that matches best.
  const prefer = (d: DesignNode, el: DomNode) =>
    -compareBox(d, el, ctxFor(d, el)).reduce((s, f) => s + SEV_RANK[f.severity], 0);

  const { pairs, unmatchedText, unmatchedDomText } = matchNodes(nodes, dom, scale, d2l, prefer);

  const groups = new Map<string, { pairs: Pair[]; findings: PropFinding[] }>();
  for (const p of pairs) {
    const f = findingsFor(p);
    if (!f.length) continue;
    const key = signature(p, f);
    const g = groups.get(key);
    if (g) g.pairs.push(p);
    else groups.set(key, { pairs: [p], findings: f });
  }

  const issues: PropertyIssue[] = [];
  for (const { pairs: ps, findings } of groups.values()) {
    const first = ps[0];
    const severity = findings.reduce<Severity>((s, f) => maxSev(s, f.severity), 'low');
    const main = [...findings].sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity])[0];
    const more = findings.length > 1 ? ` (+${findings.length - 1} more)` : '';
    const who = ps.length > 1 ? `${ps.length}× ${subject(first)}…` : subject(first);
    const box = ps.slice(1).reduce((b, p) => union(b, p.dom.box), first.dom.box);
    const fixLine = findings
      .map((f) => (f.tw ? `${f.css}  →  ${f.tw}` : f.css))
      .join('\n');
    issues.push({
      title: `${who}: ${main.property} is ${main.actual.replace(/\s*\(.*\)$/, '')}, design ${main.expected}${more}`,
      type: main.type,
      severity,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      selector: first.dom.selector,
      designLayer: first.design.name,
      expected: findings.map((f) => `${f.property}: ${f.expected}`).join(' · '),
      actual: findings.map((f) => `${f.property}: ${f.actual}`).join(' · '),
      fix: fixLine,
      count: ps.length,
      selectors: ps.map((p) => p.dom.selector),
      figmaLayers: [...new Set(ps.map((p) => p.design.name))],
      findings,
      code: codeFor(ps.length > 1 ? `${ps.length} elements, e.g. ${first.dom.selector}` : first.dom.selector, findings),
    });
  }
  issues.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.count - a.count || a.box.y - b.box.y);

  const missingText = unmatchedText
    .map((n) => ({ text: (n.text ?? '').slice(0, 80), layer: n.name, at: { ...n.box, x: n.box.x * scale, y: d2l[Math.min(d2l.length - 1, Math.round(n.box.y * scale))], width: n.box.width * scale, height: n.box.height * scale } }))
    .filter((m) => normText(m.text).length > 1);
  const extraText = unmatchedDomText.map((el) => ({ text: (el.text ?? '').slice(0, 80), selector: el.selector, at: el.box }));

  return {
    stats: {
      figmaTextLayers: nodes.filter((n) => n.type === 'TEXT').length,
      matchedText: pairs.filter((p) => p.how === 'text').length,
      matchedBoxes: pairs.filter((p) => p.how === 'box').length,
      elementsWithFindings: issues.reduce((s, i) => s + i.count, 0),
    },
    issues,
    missingText,
    extraText,
  };
}
