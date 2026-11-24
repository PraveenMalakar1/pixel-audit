import type { Issue, RunMeta, Severity } from '../types.js';

export interface ReportImages {
  /** data: URIs */
  sideBySide?: string;
  annotated?: string;
  overlay?: string;
  heatmap?: string;
  /** Per-issue zoomed Design vs Build crops, same order as issues. */
  issueImages?: (string | undefined)[];
}

/** Phase 2 measurements, shown as a reference table under the issues. */
export interface ReportMeasurements {
  stats: { figmaTextLayers: number; matchedText: number; matchedBoxes: number; elementsWithFindings: number };
  issues: { title: string; severity: Severity; count: number; expected?: string; actual?: string; fix?: string; selector?: string }[];
  missingText: { text: string }[];
  extraText: { text: string }[];
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

const SEV_ORDER: Severity[] = ['high', 'medium', 'low'];

/**
 * Same report without the document wrapper (doctype/html/head/body), for publishing as a
 * Claude Artifact, which adds its own skeleton.
 */
export function toShareFragment(fullHtml: string): string {
  return fullHtml
    .replace(/^<!doctype html>\s*<html[^>]*>\s*<head>\s*/i, '')
    .replace(/<meta charset="utf-8">\s*<meta name="viewport"[^>]*>\s*/i, '')
    .replace(/(<title>[^<]*<\/title>)/i, '$1\n<meta name="claude:viewport-fit-sides" content="cover">')
    .replace(/<\/head>\s*<body>\s*/i, '')
    .replace(/\s*<\/body>\s*<\/html>\s*$/i, '\n');
}

function measurementsHtml(m: ReportMeasurements): string {
  const rows = m.issues
    .map(
      (i) => `<tr><td><span class="pill sev-${esc(i.severity)}">${esc(i.severity)}</span></td><td>${esc(i.title)}${i.count > 1 ? ` <small>(${i.count} elements)</small>` : ''}${i.selector ? `<br><code class="sel">${esc(i.selector)}</code>` : ''}</td><td>${esc(i.expected ?? '')}</td><td>${esc(i.actual ?? '')}</td><td><code class="fixcode">${esc(i.fix ?? '')}</code></td></tr>`,
    )
    .join('');
  const list = (items: { text: string }[]) => items.slice(0, 40).map((t) => `<li>${esc(t.text)}</li>`).join('');
  return `
<h2 id="measurements">Exact measurements</h2>
<p class="howto">Every Figma layer was matched to its page element (${m.stats.matchedText} of ${m.stats.figmaTextLayers} text layers, ${m.stats.matchedBoxes} styled boxes) and compared value by value: font, colour (ΔE2000), radius, border, shadow, spacing, size and position. Identical problems on several elements are grouped. The issues above are the reviewed, root-cause version of this list.</p>
<details class="measure"><summary>${m.issues.length} measured differences</summary>
<div class="tablewrap"><table><thead><tr><th>Severity</th><th>Element</th><th>Design</th><th>Build</th><th>Fix</th></tr></thead><tbody>${rows}</tbody></table></div>
</details>
${m.missingText.length ? `<details class="measure"><summary>${m.missingText.length} design texts not found on the page</summary><ul class="textlist">${list(m.missingText)}</ul></details>` : ''}
${m.extraText.length ? `<details class="measure"><summary>${m.extraText.length} page texts not in the design</summary><ul class="textlist">${list(m.extraText)}</ul></details>` : ''}`;
}

export function buildReportHtml(meta: RunMeta, issues: Issue[], images: ReportImages, summary?: string, measurements?: ReportMeasurements): string {
  const counts = Object.fromEntries(SEV_ORDER.map((s) => [s, issues.filter((i) => i.severity === s).length]));
  const tabs = (
    [
      ['sbs', 'Side by side', images.sideBySide],
      ['ann', 'Annotated build', images.annotated],
      ['ovl', 'Overlay', images.overlay],
      ['heat', 'Pixel diff', images.heatmap],
    ] as const
  ).filter(([, , src]) => !!src);

  const issueCards = issues
    .map(
      (i, n) => `
    <article class="issue" id="issue-${n + 1}">
      <div class="issue-head">
        <span class="num sev-${esc(i.severity)}">${n + 1}</span>
        <h3>${esc(i.title)}</h3>
        <span class="pill sev-${esc(i.severity)}">${esc(i.severity)}</span>
        <span class="pill type">${esc(i.type)}</span>
      </div>
      ${
        i.expected || i.actual
          ? `<dl class="cmp"><div><dt>Design</dt><dd>${esc(i.expected ?? '—')}</dd></div><div><dt>Build</dt><dd>${esc(i.actual ?? '—')}</dd></div></dl>`
          : ''
      }
      ${i.fix ? `<p class="fix"><strong>Fix:</strong> ${esc(i.fix)}</p>` : ''}
      ${i.code ? `<div class="code"><button class="copy" type="button">Copy</button><pre><code>${esc(i.code)}</code></pre></div>` : ''}
      ${i.selector ? `<code class="sel">${esc(i.selector)}</code>` : ''}
      ${
        images.issueImages?.[n]
          ? `<div class="shot"><img class="zoom" loading="lazy" src="${images.issueImages[n]}" alt="Design vs build for issue ${n + 1}"></div>`
          : ''
      }
    </article>`,
    )
    .join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.designName)} QA</title>
<style>
:root{--bg:#f6f6f7;--surface:#ffffff;--text:#18181b;--muted:#636370;--border:#e4e4e7;--accent:#4f46e5;
--high:#e11d48;--medium:#d97706;--low:#2563eb;--codebg:#1e1f26;--codefg:#e6e7ee;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#0e1014;--surface:#171a20;--text:#e8e9ed;--muted:#9a9fab;--border:#2a2e37;--accent:#8b85ff;
--high:#fb7185;--medium:#fbbf24;--low:#60a5fa;--codebg:#0a0b0f;--codefg:#e6e7ee;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#0e1014;--surface:#171a20;--text:#e8e9ed;--muted:#9a9fab;--border:#2a2e37;--accent:#8b85ff;
--high:#fb7185;--medium:#fbbf24;--low:#60a5fa;--codebg:#0a0b0f;--codefg:#e6e7ee;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding-block:28px 64px;padding-left:max(16px, env(safe-area-inset-left, 0px));padding-right:max(16px, env(safe-area-inset-right, 0px))}
header h1{margin:0 0 4px;font-size:24px}
.meta{color:var(--muted);font-size:13px;word-break:break-all}
.meta a{color:var(--accent)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:12px 14px}
.stat b{display:block;font-size:26px;line-height:1.2}
.stat span{color:var(--muted);font-size:13px}
.stat.high b{color:var(--high)}.stat.medium b{color:var(--medium)}.stat.low b{color:var(--low)}
.summary{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;white-space:pre-wrap}
h2{font-size:18px;margin:32px 0 12px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}
.tabs label{cursor:pointer;padding:6px 12px;border:1px solid var(--border);border-radius:999px;background:var(--surface);font-size:13px}
.views input{position:absolute;opacity:0;pointer-events:none}
.view{display:none;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:8px;overflow:auto;max-height:80vh}
.view img{display:block;max-width:100%;height:auto;margin:0 auto}
${tabs.map(([id]) => `#t-${id}:checked ~ .tabs label[for="t-${id}"]{background:var(--accent);color:#fff;border-color:var(--accent)}#t-${id}:checked ~ .v-${id}{display:block}`).join('\n')}
.issue{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.issue-head{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.issue h3{margin:0;font-size:15px;flex:1 1 220px}
.num{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:50%;color:#fff;font-weight:700;font-size:12px}
.num.sev-high{background:var(--high)}.num.sev-medium{background:var(--medium)}.num.sev-low{background:var(--low)}
.pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid currentColor;text-transform:capitalize}
.pill.sev-high{color:var(--high)}.pill.sev-medium{color:var(--medium)}.pill.sev-low{color:var(--low)}.pill.type{color:var(--muted)}
.cmp{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:8px;margin:10px 0 0}
.cmp div{background:var(--bg);border-radius:8px;padding:8px 10px}
.cmp dt{font-size:12px;color:var(--muted)}.cmp dd{margin:0}
.fix{margin:10px 0 0}
.sel{display:inline-block;margin-top:8px;font-size:12px;color:var(--muted);word-break:break-all}
.empty{color:var(--muted)}
.shot{display:block;margin-top:12px;border:1px solid var(--border);border-radius:8px;overflow:hidden;background:#f4f4f5}
.shot img{display:block;width:100%;height:auto}
.toc{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
.toc a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--text);font-size:13px;border:1px solid var(--border);background:var(--surface);border-radius:999px;padding:3px 10px 3px 4px}
.toc .num{width:20px;height:20px;font-size:11px}
.howto{color:var(--muted);font-size:13px;margin:-4px 0 12px}
.fix{white-space:pre-line}
.code{position:relative;margin-top:10px;min-width:0}
.code pre{margin:0;background:var(--codebg);color:var(--codefg);border-radius:8px;padding:12px 14px;overflow-x:auto;font:12.5px/1.55 ui-monospace,"Cascadia Code",Consolas,monospace}
.code .copy{position:absolute;top:6px;right:6px;font-size:12px;padding:3px 9px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer}
.code .copy:focus-visible,.toc a:focus-visible,.tabs label:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.measure{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 14px;margin-bottom:10px}
.measure summary{cursor:pointer;font-weight:600}
.tablewrap{overflow-x:auto;margin-top:10px}
.tablewrap table{border-collapse:collapse;width:100%;min-width:760px;font-size:13px}
.tablewrap th,.tablewrap td{text-align:left;vertical-align:top;padding:8px;border-top:1px solid var(--border)}
.tablewrap th{color:var(--muted);font-weight:600;border-top:0}
.fixcode{white-space:pre-line;font-size:12px}
.textlist{margin:8px 0 0;padding-left:18px;columns:2 260px;font-size:13px}
.issue .why{margin:10px 0 0;color:var(--muted);font-size:14px}
img.zoom{cursor:zoom-in}
.lightbox{position:fixed;inset:0;background:rgba(0,0,0,.85);display:none;overflow:auto;z-index:10;cursor:zoom-out;padding:16px}
.lightbox.open{display:block}
.lightbox img{display:block;margin:0 auto;max-width:none;width:auto}
.lightbox .close{position:fixed;top:10px;right:14px;color:#fff;font-size:28px;line-height:1;background:none;border:0;cursor:pointer}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>Visual QA report: ${esc(meta.designName)}</h1>
  <div class="meta">
    Page: <a href="${esc(meta.pageUrl)}">${esc(meta.pageUrl)}</a><br>
    ${meta.figmaUrl ? `Design: <a href="${esc(meta.figmaUrl)}">${esc(meta.figmaUrl)}</a><br>` : ''}
    Checked ${esc(new Date(meta.createdAt).toLocaleString())} at ${meta.width}px width · run ${esc(meta.runId)}
  </div>
</header>

<section class="stats">
  <div class="stat"><b>${issues.length}</b><span>issues</span></div>
  <div class="stat high"><b>${counts.high}</b><span>high</span></div>
  <div class="stat medium"><b>${counts.medium}</b><span>medium</span></div>
  <div class="stat low"><b>${counts.low}</b><span>low</span></div>
  <div class="stat"><b>${(meta.diffRatio * 100).toFixed(2)}%</b><span>pixels differ</span></div>
</section>

${summary ? `<div class="summary">${esc(summary)}</div>` : ''}

<h2>Screens</h2>
<p class="howto">Numbered boxes mark each issue on the build: red = high, orange = medium, blue = low. <b>Side by side</b> shows the design next to the marked build. <b>Overlay</b> blends both, so misaligned items look doubled. <b>Pixel diff</b> shows every changed pixel in red. Click any image to see it full size (Esc to close).</p>
<div class="views">
  ${tabs.map(([id], i) => `<input type="radio" name="view" id="t-${id}"${i === 0 ? ' checked' : ''}>`).join('')}
  <div class="tabs">${tabs.map(([id, label]) => `<label for="t-${id}">${label}</label>`).join('')}</div>
  ${tabs.map(([id, label, src]) => `<div class="view v-${id}"><img class="zoom" src="${src}" alt="${label}"></div>`).join('\n  ')}
</div>

<h2>Issues</h2>
${
  issues.length
    ? `<p class="howto">Each issue shows the design (left) and the build with its marker (right), zoomed in on the spot that needs to change.</p>
<nav class="toc">${issues.map((i, n) => `<a href="#issue-${n + 1}"><span class="num sev-${esc(i.severity)}">${n + 1}</span>${esc(i.title.length > 42 ? i.title.slice(0, 40) + '…' : i.title)}</a>`).join('')}</nav>`
    : ''
}
${issueCards || '<p class="empty">No issues found. The build matches the design.</p>'}
${measurements ? measurementsHtml(measurements) : ''}
</div>
<div class="lightbox" id="lb" role="dialog" aria-label="Full-size image"><button class="close" aria-label="Close">×</button><img alt=""></div>
<script>
(function(){
  var lb=document.getElementById('lb'), im=lb.querySelector('img');
  document.addEventListener('click',function(e){
    var t=e.target;
    if(t.classList&&t.classList.contains('zoom')){im.src=t.src;im.alt=t.alt;lb.classList.add('open');}
    else if(lb.classList.contains('open')&&(t===lb||t===im||t.classList.contains('close'))){lb.classList.remove('open');}
  });
  document.addEventListener('keydown',function(e){if(e.key==='Escape')lb.classList.remove('open');});
  document.addEventListener('click',function(e){
    var b=e.target; if(!b.classList||!b.classList.contains('copy'))return;
    var code=b.parentNode.querySelector('code'); var txt=code.textContent;
    var done=function(){b.textContent='Copied';setTimeout(function(){b.textContent='Copy';},1500);};
    var fallback=function(){var r=document.createRange();r.selectNodeContents(code);var s=getSelection();s.removeAllRanges();s.addRange(r);b.textContent='Press Ctrl+C';};
    try{navigator.clipboard.writeText(txt).then(done,fallback);}catch(err){fallback();}
  });
})();
</script>
</body>
</html>`;
}
