import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { ENV } from '../env.js';

export interface SessionOptions {
  storageDir?: string;
  recordVideo?: string;
  viewport?: { width: number; height: number };
  userAgent?: string;
}

export interface Session {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close(): Promise<void>;
}

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export async function openSession(opts: SessionOptions = {}): Promise<Session> {
  const browser = await chromium.launch({
    headless: ENV.HEADLESS,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--no-sandbox',
    ],
  });
  const context = await browser.newContext({
    viewport: opts.viewport ?? { width: 1366, height: 900 },
    userAgent: opts.userAgent ?? DEFAULT_UA,
    locale: 'en-US',
    timezoneId: 'America/Los_Angeles',
    permissions: [],
  });

  // Light stealth patches — remove obvious automation tells.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4] });
    // @ts-expect-error — we patch window.chrome because headless lacks it.
    window.chrome = { runtime: {} };
  });

  const page = await context.newPage();
  page.setDefaultTimeout(ENV.STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(ENV.STEP_TIMEOUT_MS * 2);

  async function close() {
    try {
      await context.close();
    } catch {
      /* noop */
    }
    try {
      await browser.close();
    } catch {
      /* noop */
    }
  }

  return { browser, context, page, close };
}

export async function screenshotBuffer(page: Page, full = false): Promise<Buffer> {
  return page.screenshot({ fullPage: full, type: 'png' });
}

export async function screenshotDataUrl(page: Page, full = false): Promise<string> {
  const b = await screenshotBuffer(page, full);
  return `data:image/png;base64,${b.toString('base64')}`;
}

export async function waitForIdle(page: Page, ms = 1500): Promise<void> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: ms });
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, Math.min(800, ms)));
}

/**
 * Proactively dismiss cookie consent banners, GDPR dialogs, and similar
 * overlays that intercept pointer events and break click-resolution.
 *
 * This runs in the page context (single evaluate call) so it's fast and can
 * reach shadow-dom / iframe-less overlays. Returns count of overlays closed.
 */
export async function dismissOverlays(page: Page): Promise<number> {
  const script = `
(() => {
  const buttonTexts = [
    'accept all', 'accept', 'agree', 'i agree', 'i accept', 'allow all',
    'got it', 'ok', 'okay', 'understood', 'continue', 'close',
    'reject all', 'reject', 'decline', 'dismiss', 'no thanks',
  ];
  const selectors = [
    '[data-ui="cookie-consent"] button',
    '[aria-label*="cookie" i] button',
    '[class*="cookie" i] button',
    '[class*="consent" i] button',
    '[class*="gdpr" i] button',
    '#onetrust-accept-btn-handler',
    '#onetrust-reject-all-handler',
    '.onetrust-close-btn-handler',
    '[id*="cookie" i] button',
    '[id*="consent" i] button',
    'button[aria-label*="accept" i]',
    'button[aria-label*="dismiss" i]',
    'button[aria-label*="close" i]',
  ];
  let closed = 0;
  const tryClick = (el) => {
    try { el.click(); closed++; return true; } catch { return false; }
  };
  for (const sel of selectors) {
    const els = Array.from(document.querySelectorAll(sel));
    for (const el of els) {
      const txt = (el.textContent || '').toLowerCase().trim();
      if (!txt || buttonTexts.some((t) => txt.includes(t))) tryClick(el);
    }
  }
  // Fallback: any visible button at document root whose text matches.
  const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
  for (const el of allButtons) {
    const txt = (el.textContent || '').toLowerCase().trim();
    if (txt.length > 40) continue;
    if (buttonTexts.some((t) => txt === t || txt === t + '!') && isReasonablyOverlay(el)) {
      tryClick(el);
    }
  }
  function isReasonablyOverlay(el) {
    let p = el;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      const id = (p.id || '').toLowerCase();
      const cls = (typeof p.className === 'string' ? p.className : '').toLowerCase();
      const dui = (p.getAttribute && p.getAttribute('data-ui') || '').toLowerCase();
      const role = (p.getAttribute && p.getAttribute('role') || '').toLowerCase();
      if (id.includes('cookie') || id.includes('consent') || cls.includes('cookie') || cls.includes('consent') || cls.includes('gdpr') || dui.includes('cookie') || dui.includes('consent') || role === 'dialog' || role === 'alertdialog') {
        return true;
      }
    }
    return false;
  }
  return closed;
})();`;
  let total = 0;
  for (let i = 0; i < 3; i++) {
    try {
      const n = await page.evaluate(script);
      total += typeof n === 'number' ? n : 0;
    } catch {/* ignore */}
    await new Promise((r) => setTimeout(r, 300));
  }
  return total;
}
