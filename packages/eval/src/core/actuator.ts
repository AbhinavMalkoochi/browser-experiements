import type { Page, ElementHandle, Frame } from 'playwright';
import type { AxNode, AxSnapshot } from './ax.js';
import type { Action } from './types.js';
import { waitForIdle, dismissOverlays } from './browser.js';

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
    try {
      await handle.click({ timeout: 8000, delay: 20 + Math.random() * 50 });
      return;
    } catch (e) {
      // Classic failure mode: a cookie banner / dialog intercepts pointer events.
      // Dismiss overlays and retry once, then fall back to a forced click.
      const msg = (e as Error).message;
      if (/intercepts pointer events|not stable|element is outside|not visible/i.test(msg)) {
        await dismissOverlays(this.page).catch(() => 0);
        try {
          await handle.click({ timeout: 4000, delay: 20 });
          return;
        } catch {/* fall through */}
      }
      try {
        await handle.click({ force: true, timeout: 3000 });
      } catch (e2) {
        throw e2;
      }
    }
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

  private fuzzyOptionMatch(node: AxNode | null, requestedValue: string): string | null {
    if (!node?.options?.length) return null;
    const want = normalizeChoice(requestedValue);
    if (!want) return null;
    const exact = node.options.find((opt) => normalizeChoice(opt) === want);
    if (exact) return exact;
    const contains = node.options.find((opt) => {
      const norm = normalizeChoice(opt);
      return norm.includes(want) || want.includes(norm);
    });
    if (contains) return contains;
    const semantic = node.options.find((opt) => semanticChoiceMatch(requestedValue, opt));
    return semantic ?? null;
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
            // Short-circuit: if the field is already filled with the same or substantially
            // similar value, skip. Prevents repeat-fill loops (the #1 failure mode).
            if (node?.value && typeof node.value === 'string') {
              const cur = node.value.trim();
              const want = v.trim();
              if (cur.length > 0 && (cur === want || (want.length > 3 && cur.startsWith(want.slice(0, 16))))) {
                return { ok: true, note: 'already filled — skipped' };
              }
            }
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
            const matchedValue = this.fuzzyOptionMatch(node, action.value) ?? action.value;
            // Radio group fallback: if the targeted node is a radio, find the sibling
            // radio in the same group whose label matches the requested value and click it.
            if (node?.role === 'radio' || node?.role === 'checkbox') {
              const want = normalizeChoice(matchedValue);
              const group = this.snapshot?.nodes.filter(
                (n) => (n.role === 'radio' || n.role === 'checkbox') && (n.label === node.label || n.name === node.name || n.section === node.section)
              ) ?? [];
              const match = group.find(
                (n) =>
                  normalizeChoice(n.name || '') === want ||
                  normalizeChoice(n.value || '') === want ||
                  semanticChoiceMatch(matchedValue, n.name || '') ||
                  semanticChoiceMatch(matchedValue, n.value || '')
              );
              if (match) {
                const mh = await this.resolveHandle(match);
                if (mh) {
                  await this.clickWithEventChain(mh);
                  return { ok: true, note: `radio fallback → ${match.name || match.value}` };
                }
              }
            }
            try {
              await handle.selectOption({ label: matchedValue });
              return { ok: true };
            } catch (e) {
              try {
                await handle.selectOption(matchedValue);
                return { ok: true };
              } catch {
                await this.clickWithEventChain(handle);
                await sleep(300);
                const opt = await this.page.getByRole('option', { name: matchedValue }).first().elementHandle().catch(() => null);
                if (opt) {
                  await this.clickWithEventChain(opt);
                  return { ok: true, note: 'combobox fallback' };
                }
                const txt = await this.page.getByText(matchedValue, { exact: false }).first().elementHandle().catch(() => null);
                if (txt) {
                  await this.clickWithEventChain(txt);
                  return { ok: true, note: 'text-click fallback' };
                }
                try {
                  await this.typeHuman(handle, matchedValue);
                  await this.page.keyboard.press('Enter').catch(() => {});
                  return { ok: true, note: 'typeahead fallback' };
                } catch {/* ignore */}
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
            // Broad file-input resolver: try the handle, then its subtree,
            // then walk up to 4 ancestors looking for a nearby input[type=file].
            const input = await handle.evaluateHandle((el) => {
              if (el instanceof HTMLInputElement && el.type === 'file') return el;
              const direct = (el as Element).querySelector('input[type=file]');
              if (direct) return direct as Element;
              let p: Element | null = (el as Element).parentElement;
              for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
                const inSub = p.querySelector('input[type=file]');
                if (inSub) return inSub as Element;
              }
              // Last resort: the closest form + first file input in the document
              const anyFile = document.querySelector('input[type=file]');
              return anyFile ?? null;
            });
            const asElement = input.asElement();
            if (!asElement) return { ok: false, error: 'no file input resolvable' };
            // setInputFiles works even when the input is hidden; Playwright un-hides it.
            try {
              await (asElement as ElementHandle<HTMLInputElement>).setInputFiles(action.value);
              return { ok: true };
            } catch (e) {
              // Some custom upload widgets open an OS dialog on click; use filechooser event.
              try {
                const chooserPromise = this.page
                  .waitForEvent('filechooser', { timeout: 4000 })
                  .then((chooser) => ({ ok: true as const, chooser }))
                  .catch((err: unknown) => ({ ok: false as const, err }));
                await this.clickWithEventChain(handle).catch(() => {});
                const chooserResult = await chooserPromise;
                if (!chooserResult.ok) {
                  return { ok: false, error: `upload failed: ${(e as Error).message} / chooser: ${(chooserResult.err as Error).message}` };
                }
                const chooser = chooserResult.chooser;
                await chooser.setFiles(action.value);
                return { ok: true, note: 'filechooser fallback' };
              } catch (e2) {
                return { ok: false, error: `upload failed: ${(e as Error).message} / chooser: ${(e2 as Error).message}` };
              }
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
function normalizeChoice(s: string): string {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function semanticChoiceMatch(requested: string, candidate: string): boolean {
  const want = normalizeChoice(requested);
  const have = normalizeChoice(candidate);
  if (!want || !have) return false;
  if (want === have || have.includes(want) || want.includes(have)) return true;
  if ((want === 'yes' || want === 'true') && /yes|authorized|eligible|able|i am|will not require/i.test(candidate)) return true;
  if ((want === 'no' || want === 'false') && /no|not authorized|not eligible|require sponsorship|will require/i.test(candidate)) return true;
  if (want.includes('decline') && /decline|not wish|prefer not/i.test(candidate)) return true;
  return false;
}
