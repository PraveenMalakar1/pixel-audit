import { chromium, type Browser } from 'playwright';
import type { DomNode } from '../types.js';

let browser: Browser | undefined;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) browser = await chromium.launch({ headless: true });
  return browser;
}

export async function closeBrowser(): Promise<void> {
  if (browser) await browser.close().catch(() => {});
  browser = undefined;
}

export interface CaptureOptions {
  url: string;
  width: number;
  height?: number;
  fullPage?: boolean;
  /** CSS selector to wait for before capturing. */
  waitFor?: string;
  /** Extra wait (ms) after load, for late animations or data. */
  delayMs?: number;
  /** Playwright storage-state JSON (cookies/localStorage) for logged-in pages. */
  storageStatePath?: string;
  /** Selectors to hide (e.g. cookie banners, chat widgets). */
  hideSelectors?: string[];
  /** Hide cookie/consent banners (default true). */
  hideCookieBanners?: boolean;
  /** Hide small fixed chat/help bubbles in the bottom corners (default true). */
  hideChatWidgets?: boolean;
  maxDomNodes?: number;
}

export interface CaptureResult {
  png: Buffer;
  dom: DomNode[];
  title: string;
  pageWidth: number;
  pageHeight: number;
}

/** Runs inside the page. Must stay self-contained (it is serialised by Playwright). */
function extractDom(maxNodes: number): DomNode[] {
  const props = [
    'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'line-height',
    'letter-spacing', 'text-align', 'border-radius', 'border-top-width', 'border-top-color',
    'border-right-width', 'border-bottom-width', 'border-left-width', 'border-bottom-color',
    'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'margin-top', 'margin-bottom',
    'gap', 'box-shadow', 'opacity', 'display', 'justify-content', 'align-items', 'flex-direction',
  ];
  const skipTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR']);
  const out: DomNode[] = [];

  const selectorOf = (el: Element): string => {
    const parts: string[] = [];
    let cur: Element | null = el;
    while (cur && parts.length < 5) {
      if (cur.id) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      let p = cur.tagName.toLowerCase();
      const cls = Array.from(cur.classList).filter((c) => !/^(css|sc|jsx|svelte)-/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent: Element | null = cur.parentElement;
      if (parent) {
        const tag = cur.tagName;
        const same = Array.from(parent.children).filter((c) => c.tagName === tag);
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(p);
      if (cur.tagName === 'BODY') break;
      cur = parent;
    }
    return parts.join(' > ');
  };

  const walk = (el: Element, depth: number) => {
    if (out.length >= maxNodes || skipTags.has(el.tagName)) return;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0') {
      let text = '';
      for (const n of Array.from(el.childNodes)) if (n.nodeType === 3) text += n.textContent ?? '';
      // Form fields show placeholder / selected option text that is not a text node.
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) text = el.value || el.placeholder || '';
      else if (el instanceof HTMLSelectElement) text = el.selectedOptions[0]?.text ?? '';
      text = text.replace(/\s+/g, ' ').trim().slice(0, 120);
      const styles: Record<string, string> = {};
      for (const p of props) styles[p] = cs.getPropertyValue(p);
      // An empty field shows its placeholder, which has its own colour.
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.value && el.placeholder) {
        styles['color'] = getComputedStyle(el, '::placeholder').getPropertyValue('color') || styles['color'];
      }
      out.push({
        selector: selectorOf(el),
        tag: el.tagName.toLowerCase(),
        depth,
        text: text || undefined,
        box: {
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          width: Math.round(r.width),
          height: Math.round(r.height),
        },
        styles,
      });
    }
    for (const c of Array.from(el.children)) walk(c, depth + 1);
  };

  walk(document.body, 0);
  return out;
}

/** Runs inside the page: hides overlays that are not part of the design. Self-contained. */
function hideOverlays(o: { cookies: boolean; chat: boolean }): number {
  const hide = (el: Element) => (el as HTMLElement).style?.setProperty('display', 'none', 'important');
  const cookieRe = /cookie|consent|gdpr/i;
  let n = 0;
  if (o.cookies) {
    const known = '#cmpwrapper, #onetrust-consent-sdk, #CybotCookiebotDialog, #usercentrics-root, #cookiescript_injected, .cc-window, [id^="sp_message_container"], #didomi-host, #truste-consent-track, #qc-cmp2-container';
    for (const el of Array.from(document.querySelectorAll(known))) { hide(el); n++; }
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      // Banners rendered inside an open shadow root (innerText of the host is empty).
      if (el.shadowRoot && cookieRe.test(el.shadowRoot.textContent ?? '')) { hide(el); n++; continue; }
      const pos = getComputedStyle(el).position;
      const txt = el.innerText || '';
      if ((pos === 'fixed' || pos === 'sticky') && txt.length < 1500 && cookieRe.test(txt)) { hide(el); n++; }
    }
  }
  if (o.chat) {
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      if (getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      const small = r.width > 0 && r.height > 0 && r.width <= 220 && r.height <= 220;
      const bottomCorner = r.bottom > vh * 0.6 && (r.right > vw * 0.75 || r.left < vw * 0.25);
      if (small && bottomCorner) { hide(el); n++; }
    }
  }
  return n;
}

export async function capturePage(opts: CaptureOptions): Promise<CaptureResult> {
  const b = await getBrowser();
  const context = await b.newContext({
    viewport: { width: opts.width, height: opts.height ?? 900 },
    deviceScaleFactor: 1,
    storageState: opts.storageStatePath,
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    try {
      await page.goto(opts.url, { waitUntil: 'networkidle', timeout: 45_000 });
    } catch (e) {
      // Pages with long-polling never reach networkidle; fall back to "load".
      if (!/Timeout/i.test(String(e))) throw e;
      await page.goto(opts.url, { waitUntil: 'load', timeout: 45_000 });
    }
    if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 20_000 });

    // Scroll through the page to trigger lazy-loaded images, then go back to the top.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      window.scrollTo(0, 0);
    });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    const overlays = { cookies: opts.hideCookieBanners ?? true, chat: opts.hideChatWidgets ?? true };
    await page.evaluate(hideOverlays, overlays);
    if (opts.hideSelectors?.length) {
      await page.addStyleTag({ content: `${opts.hideSelectors.join(',')}{visibility:hidden !important}` });
    }
    // Consent tools often inject their banner a moment later: wait briefly and hide again.
    await page.waitForTimeout(opts.delayMs ?? 1200);
    await page.evaluate(hideOverlays, overlays);

    const dom = await page.evaluate(extractDom, opts.maxDomNodes ?? 4000);
    const png = await page.screenshot({
      fullPage: opts.fullPage ?? true,
      animations: 'disabled',
      caret: 'hide',
      type: 'png',
    });
    const size = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));
    return { png, dom, title: await page.title(), pageWidth: size.w, pageHeight: size.h };
  } finally {
    await context.close();
  }
}
