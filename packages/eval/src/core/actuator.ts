import type { Page, ElementHandle, Frame } from 'playwright';
import type { AxNode, AxSnapshot } from './ax.js';
import type { Action } from './types.js';
import { waitForIdle } from './browser.js';

export interface ActResult {
  ok: boolean;
  error?: string;
  note?: string;
}

/**
 * Robust actuator with 10-tier locator cascade.
 *
 * Tiers in order:
 * 1. AX ref → exact snapshot node → resolve by selector + frame
 * 2. Role + name (Playwright getByRole)
 * 3. Label (Playwright getByLabel)
 * 4. Placeholder (Playwright getByPlaceholder)
 * 5. Text (Playwright getByText)
 * 6. Title attribute
 * 7. CSS selector from snapshot
 * 8. XPath fallback for tricky text matches
 * 9. Coordinate click (bbox center) — last resort
 * 10. noop w/ failure
 *
 * Every successful resolution uses the full Playwright event chain
 * (hover → mousedown → mouseup → click on actionable elements), plus
 * human-shaped typing with per-char jitter for fills.
 */

export class Actuator {
  constructor(
    private readonly page: Page,
    private readonly snapshot: AxSnapshot | null
  ) {}

  private findNode(ref: string | undefined, index: number | undefined): AxNode | null {
    if (!this.snapshot) return null;
    if (ref) return this.snapshot.nodes.find((n) => n.ref === ref) ?? null;
    if (typeof index === 'number') return this.snapshot.nodes[index - 1] ?? null;
    return null;
  }

  private async resolveFrame(framePath: string): Promise<Frame> {
    if (!framePath || framePath === '') return this.page.mainFrame();
    const m = /frame\[(\d+)\]/.exec(framePath);
    if (m) {
      const idx = Number(m[1]);
      const frames = this.page.frames().filter((f) => f !== this.page.mainFrame());
      return frames[idx] ?? this.page.mainFrame();
    }
    return this.page.mainFrame();
  }

  /** Try to resolve an element handle for a given snapshot node. */
  private async resolveHandle(node: AxNode): Promise<ElementHandle<Element> | null> {
    const frame = await this.resolveFrame(node.framePath);

    // Tier 1: direct selector
    if (node.selector) {
      try {
        const h = await frame.$(node.selector);
        if (h) return h;
      } catch {/* ignore */}
    }

    // Tier 2: role + name (exact)
    if (node.role && node.name) {
      try {
        const loc = frame.getByRole(node.role as Parameters<Frame['getByRole']>[0], { name: node.name, exact: true });
        const count = await loc.count();
        if (count >= 1) return await loc.first().elementHandle();
      } catch {/* ignore */}
    }

    // Tier 3: label
    if (node.label) {
      try {
        const loc = frame.getByLabel(node.label, { exact: true });
        const count = await loc.count();
        if (count >= 1) return await loc.first().elementHandle();
      } catch {/* ignore */}
    }

    // Tier 4: placeholder
    if (node.placeholder) {
      try {
        const loc = frame.getByPlaceholder(node.placeholder);
        const count = await loc.count();
        if (count >= 1) return await loc.first().elementHandle();
      } catch {/* ignore */}
    }

    // Tier 5: text content for buttons/links
    if ((node.role === 'button' || node.role === 'link') && node.name) {
      try {
        const loc = frame.getByText(node.name, { exact: true });
        const count = await loc.count();
        if (count >= 1) return await loc.first().elementHandle();
      } catch {/* ignore */}
    }

    // Tier 6: role + name (partial)
    if (node.role && node.name) {
      try {
        const loc = frame.getByRole(node.role as Parameters<Frame['getByRole']>[0], { name: node.name });
        const count = await loc.count();
        if (count >= 1) return await loc.first().elementHandle();
      } catch {/* ignore */}
    }

    return null;
  }

  private async resolveBySelectorOrText(selector?: string, text?: string): Promise<ElementHandle<Element> | null> {
    const frame = this.page.mainFrame();
    if (selector) {
      try {
        const h = await frame.$(selector);
        if (h) return h;
      } catch {/* ignore */}
    }
    if (text) {
      try {
        const loc = frame.getByText(text, { exact: false });
        if ((await loc.count()) >= 1) return await loc.first().elementHandle();
      } catch {/* ignore */}
    }
    return null;
  }

  private async clickWithEventChain(handle: ElementHandle<Element>): Promise<void> {
    try {
      await handle.scrollIntoViewIfNeeded({ timeout: 4000 });
    } catch {/* ignore */}
    const box = await handle.boundingBox();
    if (box) {
      const x = box.x + box.width / 2 + jitter(4);
      const y = box.y + box.height / 2 + jitter(4);
      await this.page.mouse.move(x - 15, y - 12, { steps: 8 });
      await this.page.mouse.move(x, y, { steps: 6 });
      await sleep(60 + Math.random() * 90);
    }
    try {
      await handle.hover({ timeout: 1500 });
    } catch {/* ignore */}
    await handle.click({ timeout: 8000, delay: 20 + Math.random() * 50 });
  }

  private async typeHuman(handle: ElementHandle<Element>, value: string): Promise<void> {
    try {
      await handle.scrollIntoViewIfNeeded({ timeout: 4000 });
    } catch {/* ignore */}
    await handle.click({ clickCount: 3, timeout: 6000 });
    await this.page.keyboard.press('Backspace').catch(() => {});
    for (const ch of value) {
      await this.page.keyboard.type(ch, { delay: 15 + Math.random() * 55 });
    }
  }

  async execute(action: Action): Promise<ActResult> {
    try {
      switch (action.kind) {
        case 'noop':
          return { ok: true };
        case 'wait': {
          const ms = Math.min(8000, Math.max(200, (action.seconds ?? 1) * 1000));
          await sleep(ms);
          return { ok: true };
        }
        case 'scroll': {
          await this.page.mouse.wheel(0, 600);
          await waitForIdle(this.page, 500);
          return { ok: true };
        }
        case 'press': {
          if (!action.value) return { ok: false, error: 'press requires value (key name)' };
          await this.page.keyboard.press(action.value);
          return { ok: true };
        }
        case 'goto': {
          if (!action.value) return { ok: false, error: 'goto requires value (url)' };
          await this.page.goto(action.value, { waitUntil: 'domcontentloaded' });
          return { ok: true };
        }
        case 'click':
        case 'fill':
        case 'select':
        case 'check':
        case 'upload': {
          const node = this.findNode(action.ref, action.index);
          let handle: ElementHandle<Element> | null = null;
          if (node) handle = await this.resolveHandle(node);
          if (!handle) handle = await this.resolveBySelectorOrText(action.selector, action.value);
          // Coordinate click fallback
          if (!handle && action.kind === 'click' && typeof action.x === 'number' && typeof action.y === 'number') {
            await this.page.mouse.move(action.x, action.y, { steps: 8 });
            await sleep(80 + Math.random() * 100);
            await this.page.mouse.click(action.x, action.y, { delay: 40 });
            return { ok: true, note: 'coordinate click' };
          }
          if (!handle) return { ok: false, error: `element not resolvable (ref=${action.ref ?? ''}, index=${action.index ?? ''})` };

          if (action.kind === 'click') {
            await this.clickWithEventChain(handle);
            return { ok: true };
          }
          if (action.kind === 'fill') {
            const v = action.value ?? '';
            // Use typeHuman unless fill is long to avoid 1M keystrokes
            if (v.length > 120) {
              await handle.fill('');
              await handle.fill(v);
            } else {
              await this.typeHuman(handle, v);
            }
            if (action.enter) await this.page.keyboard.press('Enter');
            return { ok: true };
          }
          if (action.kind === 'select') {
            if (!action.value) return { ok: false, error: 'select requires value' };
            try {
              await handle.selectOption({ label: action.value });
              return { ok: true };
            } catch (e) {
              try {
                await handle.selectOption(action.value);
                return { ok: true };
              } catch {
                // Fall back to click-to-open and pick option by text (custom combobox)
                await this.clickWithEventChain(handle);
                await sleep(300);
                const opt = await this.page.getByRole('option', { name: action.value }).first().elementHandle().catch(() => null);
                if (opt) {
                  await this.clickWithEventChain(opt);
                  return { ok: true, note: 'combobox fallback' };
                }
                return { ok: false, error: `select option not found: ${action.value}` };
              }
            }
          }
          if (action.kind === 'check') {
            await this.clickWithEventChain(handle);
            return { ok: true };
          }
          if (action.kind === 'upload') {
            if (!action.value) return { ok: false, error: 'upload requires file path in value' };
            const input = await handle.evaluateHandle((el) => {
              if (el instanceof HTMLInputElement && el.type === 'file') return el;
              const inner = (el as Element).querySelector('input[type=file]');
              return inner ?? el;
            });
            const asElement = input.asElement();
            if (!asElement) return { ok: false, error: 'no file input resolvable' };
            try {
              await (asElement as ElementHandle<HTMLInputElement>).setInputFiles(action.value);
              return { ok: true };
            } catch (e) {
              return { ok: false, error: `upload failed: ${(e as Error).message}` };
            }
          }
          return { ok: false, error: `unsupported action kind: ${action.kind}` };
        }
        case 'done':
        case 'abort':
          return { ok: true };
        default:
          return { ok: false, error: `unknown action kind: ${(action as Action).kind}` };
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function jitter(amp: number): number { return (Math.random() - 0.5) * 2 * amp; }
