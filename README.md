# Visual QA: Figma vs build, inside Claude

A Claude Code plugin that compares a live web page with its Figma design, finds visual bugs and **paints them on screenshots**, with a shareable HTML report.

```
/visual-qa http://localhost:3000/login https://www.figma.com/design/ABC123/App?node-id=12-34
```

Claude loads the design, captures the page, runs a pixel diff, reviews every difference visually, and returns:
- `side-by-side.png`: the design next to the build, with numbered issue markers
- `report.html`: a self-contained report (side by side, annotated, overlay and pixel-diff views, plus the issue list with fixes)
- an offer to fix the CSS in your repo and re-check

## How it works

| Step | Tool | What it does |
|---|---|---|
| 1 | `figma_get_frame` | Figma REST API: frame PNG and every layer (box, fill, font, radius, padding) |
| 1b | `load_design_image` | Use an exported PNG/JPG instead of Figma |
| 2 | `capture_page` | Playwright: full-page screenshot and computed CSS of each visible element |
| 3 | `compare` | Scales the design to the build width, **lines up rows** (like `git diff` for pixel rows) so vertical drift becomes spacing findings ("31px less space here") instead of a page full of red, runs pixelmatch, and groups differences into regions labelled **changed** or **shifted**, with the matching element and Figma layer |
| 3b | `check_properties` | **Exact check (Phase 2)**: matches Figma layers to page elements (by text, then by box overlap) and compares font family/size/weight/line height/letter spacing, text and background colour (CIEDE2000 ΔE), radius, border, shadow, inner spacing, gap, size and position, with CSS and Tailwind fix code for each difference |
| 4 | `inspect_region` | Zoomed design vs build crop for Claude to check details |
| 5 | `annotate` | Paints numbered boxes (red = high, orange = medium, blue = low), plus side-by-side and overlay images |
| 6 | `save_report` | Writes `report.html` and `report.json` |

The `/visual-qa` skill ([skills/visual-qa/SKILL.md](skills/visual-qa/SKILL.md)) tells Claude how to judge the regions: severity rules, what to ignore, and how to trace a shift back to its cause.

## Setup

Requires Node 20+.

```bash
cd server
npm install
npx playwright install chromium
npm run build
```

### Figma token
1. Figma → **Settings → Security → Personal access tokens** → create one with **File content: read**.
2. Set it as an environment variable before you start Claude Code:
   - PowerShell (permanent): `setx FIGMA_TOKEN "figd_..."` and then open a new terminal
   - bash: `export FIGMA_TOKEN=figd_...`

No token? Export the frame from Figma as PNG and pass the file path instead of the link.

Figma's API rate limits are strict, so frames are cached in `qa-reports/_figma-cache/`. Pass `refresh: true` to `figma_get_frame` after the design changes.

Cookie/consent banners (including shadow-DOM ones such as consentmanager) and small chat bubbles are hidden automatically before capture.

### Load the plugin in Claude Code
```bash
claude --plugin-dir D:\Experiments\ui-qa
```
Then run `/visual-qa <page-url> <figma-link-or-image> [width]` in any project.

Output goes to `./qa-reports/` in the folder where Claude Code runs. Set `VISUAL_QA_OUT_DIR` to change it.

**Other MCP clients** (Claude Desktop and others): add a server with command `node` and args `["<path>/server/dist/index.js"]`.

## Getting a good Figma link
Select the **frame** in Figma → right-click → **Copy/Paste as → Copy link to selection**. The link must contain `?node-id=`.

## Testing

```bash
cd server
npm run build
npm run smoke       # full pipeline on test-fixtures/ (no Claude, no Figma)
npm run mcp-check   # same flow through the real MCP protocol
npx vitest run      # unit tests (on Windows run from a "D:\..." path, upper-case drive letter)
npm run inspect     # MCP Inspector UI
```

`test-fixtures/login-build.html` contains 6 planted bugs (listed in its header comment) against `login-design.html`.

## Current limits
- The pixel diff misses corner-radius changes (pixelmatch ignores anti-aliased edges). `check_properties` catches them when the design comes from Figma; with a PNG design there are no layer values to compare.
- Photos, gradients and text over images create some pixel noise. Claude filters it by checking values, but expect a few low-value regions on image-heavy pages.
- Figma designs often show hover/selected states (e.g. one highlighted card). The skill tells Claude to hover and re-check before reporting these.
- Exact-check tolerances: position 4px, size 2px, font size 0.5px, line height 1px, radius 1px, colour ΔE 3, padding 1px. Change them with `tolerances`.
- Pages behind a login need a Playwright storage-state file (`storageStatePath`).
- One breakpoint per run. Run again with another frame and width for tablet or mobile.

## Roadmap
1. ✅ **MVP**: Figma/image design, capture, pixel diff with row alignment and shift detection, annotate, shareable HTML report
2. ✅ **Property diff**: Figma layer ↔ DOM matching and exact checks for spacing, colour (ΔE), font, size, radius, border and shadow, with tolerances and CSS/Tailwind fix code
3. **Fix loop**: Claude edits the CSS, re-captures and confirms
4. **Team features**: `visual-qa.config.json` (page ↔ frame map), ignore list, multi-breakpoint runs, CI mode, Jira/Linear tickets
