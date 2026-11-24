---
name: visual-qa
description: Compare a live web page with its Figma design (or an exported design image), find visual bugs such as wrong spacing, colours, fonts, sizes, radius, or missing/extra elements, and paint them on screenshots with a shareable report. Use when the user runs /visual-qa, or asks for design QA, a pixel-perfect check, or "does my UI match Figma".
argument-hint: <page-url> <figma-frame-link | design-image-path> [width]
---

# Visual QA: build vs design

You are the design reviewer. The `visual-qa` MCP tools do the measuring; you decide what is a real bug, explain it simply, and suggest the fix.

Arguments: `$ARGUMENTS`

## 1. Get the inputs
- **Page URL**: http(s) or file URL of the built page. If the dev server is not running, ask the user or start it.
- **Design**: a Figma link to a *frame* (with `?node-id=`), or a local PNG/JPG export.
- **Width** (optional): otherwise use the design frame width.
If something is missing, ask for it in one short question.

## 2. Load the design
- Figma link → `figma_get_frame` (scale 1). If it fails because `FIGMA_TOKEN` is missing, tell the user how to set it (see README) and offer the image fallback.
- Image → `load_design_image` (scale 2 if it was exported at 2x).

## 3. Capture the build
`capture_page` with `url` and `designId`. Cookie/consent banners (including shadow-DOM ones) and small chat bubbles are hidden by default. Add `hideSelectors` for other overlays, and `waitFor` if content loads late.
If `horizontalOverflow` is true, report it as a layout issue.

## 4. Compare
Call `compare`. You get an overview (Design | Build | Pixel diff), zoomed crops of the biggest regions, a `gaps` list and a `regions` list.

**`gaps`** come from lining up design rows with build rows (vertical drift). Each gap has `net` (build minus design height in px), `build`/`design` areas and the `nextElement` after it:
- `less-space-in-build` / `more-space-in-build`: a spacing difference (margin or padding). Report it with the px value, on `nextElement`.
- `extra-content-in-build` / `missing-content-in-build` / `section-differs`: content that exists on one side only. Look at it in the images.
In crops, build-only rows are shown hatched pink on the design side ("nothing in the design here").

Each **region** has:
- `kind: "changed"`: the content differs (colour, font, shape, missing or extra element). These are the likely bugs.
- `kind: "shifted"` + `shift {dx, dy, residual}`: the same content moved. Usually a *side effect* of a size or spacing change above it. Find the cause, not the symptom:
  - When the top edge shifts one way and the bottom edge the other, the element's size changed.
  - When everything below a point moves by the same amount, the element at that point is taller or shorter, or its margin changed.
  - A `residual` above 0 means something else changed too (for example corner radius or border). Zoom in to check.
- `dom` / `elements`: the HTML elements there. `design`: the matching Figma layer, if any.

Use `inspect_region` (by `regionId` or any `box`) to zoom in wherever you are unsure. Check closely:
spacing and alignment · size · colour · font size, weight, line height · border radius, border, shadow · icons and images · text content · missing or extra elements.

**Before reporting a colour, shadow or font issue, confirm it with numbers.** Photos behind text, gradients and font smoothing often make identical values look different. When you have Figma layers (from `figma_get_frame`), compare exact values: layer `fill`, `font`, `cornerRadius`, `padding` vs the element's computed styles in the capture's `dom.json`. Quote both numbers in the issue.

## 4b. Exact property check (Figma designs)
When the design came from `figma_get_frame`, call `check_properties` with the `runId`. It matches every Figma layer to its page element and returns grouped `issues` with exact values (font, colour ΔE, radius, border, shadow, inner spacing, gap, size, position) plus CSS and Tailwind fix code, and `missingText` / `extraText` for content differences.

Then turn the measurements into **root causes**, not a list of symptoms:
- Many elements shifted by the same amount usually means one container is wrong (e.g. a padding that only applies at a larger breakpoint). Report the container once and list the symptoms in its fix.
- **Read the real markup** of the elements involved (Playwright `outerHTML`, or the source if you are in the repo) and write the fix with the project's real classes, as a before → after code block in the issue's `code` field.
- **Check interactive states before reporting colour differences on cards, buttons or links.** Designs often show the hover/selected state; hover the element and compare again. If it matches, say so in the summary and don't report it.
- Watch for silent CSS failures, e.g. Tailwind arbitrary values with spaces (`text-[rgba(34, 34, 34, 1)]`) are ignored.
- Content that changes on every load (tracking phone numbers, dates) is not a code bug: flag it for confirmation.

## 5. Decide what is a real issue
**Report**: clear differences a designer would reject.
**Ignore**: sub-pixel anti-aliasing, font smoothing, dynamic content (dates, avatars, live data, ads), placeholder text the design clearly marks as sample, and pure shifts already explained by another issue (mention them in that issue instead).

Severity:
- **high**: missing or extra element, wrong component or icon, broken layout or overflow, clearly wrong colour or text.
- **medium**: spacing or size off by more than 4px, wrong font size or weight, wrong radius, border or shadow.
- **low**: off by 4px or less, small colour shift, minor alignment.

## 6. Paint and report
1. `annotate` with the confirmed issues, most severe first. Each issue has a specific `title` ("Sign in button background is lighter than design"), `type`, `severity`, a `box` in build-screenshot coordinates (use the region or element box), `selector`, `expected` (design value), `actual` (build value), and `fix` (a concrete CSS or code change).
2. `save_report` with a 2–4 sentence `summary`. The report includes a zoomed Design vs Build crop for every issue.
3. **Always publish the report so the team can open it.** Publish `report-share.html` (path returned by `save_report` as `share`) with the Artifact tool, `icon: "inspect"`, and give the link. It is self-contained: all images are embedded. For a re-check of the same page, publish to the same artifact `url` so the team keeps one link. Only skip this if the user says not to share.
4. Reply to the user with:
   - the report link
   - a table: `# | Issue | Severity | Design → Build | Fix`
   - the local paths to `side-by-side.png` and `report.html`
   - one line offering to fix the issues in the code. If you are in the project's repo, find the selectors and offer to apply the CSS changes, then re-run steps 3–6 to confirm they are fixed.

Keep the language simple: the readers are developers and designers, not QA specialists.
