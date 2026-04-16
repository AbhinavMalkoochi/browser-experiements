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
