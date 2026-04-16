import type { Page, Frame } from 'playwright';

/**
 * Compact accessibility snapshot for LLM consumption.
 * Produces a numbered list of "interactable" elements plus nearby text context.
 *
 * Design notes:
 * - We traverse the live DOM (including open shadow roots and same-origin iframes)
 *   because Chrome's accessibility tree misses many custom web components.
 * - Each interactable gets a stable ref like "1", "2", ..., plus a `sig` signature
 *   that other approaches (G) can use for replay diffing.
 * - We also expose resolved CSS selectors so the executor can click without a
 *   separate lookup when refs fail.
 */

export interface AxNode {
  ref: string;
  /** Element role, e.g. button, textbox, combobox, checkbox, radio, link, file. */
  role: string;
  /** Computed accessible name. */
  name: string;
  /** Associated label/legend/group heading. */
  label: string;
  /** Placeholder text for inputs. */
  placeholder: string;
  /** Current value (textbox/select). */
  value: string;
  /** Tag name. */
  tag: string;
  /** Input type (text/email/file/checkbox/radio/...). */
  type: string;
  /** CSS selector we can click/fill with. */
  selector: string;
  /** Opaque signature — role+name+label+type+tag — used for replay alignment. */
  sig: string;
  /** True if currently disabled. */
  disabled: boolean;
  /** True if currently required. */
  required: boolean;
  /** True if currently checked (checkbox/radio/switch). */
  checked: boolean;
  /** Option labels when this is a select/combobox. */
  options: string[];
  /** Bounding box {x, y, w, h} in page coordinates (for SoM). */
  bbox: { x: number; y: number; w: number; h: number };
  /** Whether visible in viewport after scroll. */
  inViewport: boolean;
  /** Frame path identifier if inside iframe. */
  framePath: string;
  /** Nearby free text (caption, helper text) within ~200px, trimmed. */
  context: string;
  /** Section heading that this element falls under (h1/h2/legend). */
  section: string;
}

export interface AxSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  nodes: AxNode[];
  /** Free-form visible text above-the-fold, trimmed. Useful for understanding context. */
  visibleText: string;
  /** Hash of node signatures in order — changes when layout/structure changes. */
  structuralHash: string;
}

const EXTRACTOR_SCRIPT = `
(() => {
  const INTERACTABLE_ROLES = new Set([
    'button','link','textbox','combobox','listbox','option','checkbox','radio',
    'menuitem','tab','switch','slider','spinbutton','searchbox','menuitemcheckbox',
    'menuitemradio','file',
  ]);

  function getComputedStyleSafe(el) { try { return getComputedStyle(el); } catch { return null; } }
  function isVisible(el) {
    const s = getComputedStyleSafe(el); if (!s) return false;
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }
  function textTrim(s) { return (s || '').replace(/\\s+/g, ' ').trim().slice(0, 280); }

  function labelFor(el) {
    // <label for=id>
    if (el.id) {
      const byFor = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (byFor) return textTrim(byFor.innerText);
    }
    // Ancestor <label>
    let p = el.parentElement;
    for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
      if (p.tagName === 'LABEL') return textTrim(p.innerText);
    }
    // aria-labelledby
    const ll = el.getAttribute('aria-labelledby');
    if (ll) {
      const names = ll.split(/\\s+/).map(id => document.getElementById(id)?.innerText).filter(Boolean);
      if (names.length) return textTrim(names.join(' '));
    }
    // aria-label
    const al = el.getAttribute('aria-label');
    if (al) return textTrim(al);
    // legend of fieldset ancestor
    let fs = el.closest('fieldset');
    if (fs) {
      const leg = fs.querySelector('legend');
      if (leg) return textTrim(leg.innerText);
    }
    return '';
  }

  function roleOf(el) {
    const ar = el.getAttribute('role');
    if (ar) return ar;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return el.href ? 'link' : 'generic';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox') return 'checkbox';
      if (ty === 'radio') return 'radio';
      if (ty === 'file') return 'file';
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
      if (ty === 'search') return 'searchbox';
      return 'textbox';
    }
    return '';
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const parts = [];
    let node = el;
    for (let i = 0; i < 6 && node && node.nodeType === 1; i++) {
      const tag = node.tagName.toLowerCase();
      let piece = tag;
      if (node.id && /^[a-zA-Z_][\\w-]*$/.test(node.id)) { piece += '#' + node.id; parts.unshift(piece); break; }
      const cls = (node.getAttribute('class') || '').split(/\\s+/).filter(c => c && /^[a-zA-Z_][\\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) piece += '.' + cls.join('.');
      let sib = node, nth = 1;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === node.tagName) nth++;
      piece += ':nth-of-type(' + nth + ')';
      parts.unshift(piece);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  function nameOf(el, role) {
    // button/link: visible text
    if (role === 'button' || role === 'link') {
      const t = textTrim(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
      if (t) return t;
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      return labelFor(el) || textTrim(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || '');
    }
    if (role === 'checkbox' || role === 'radio' || role === 'file') {
      return labelFor(el) || textTrim(el.getAttribute('aria-label') || el.name || '');
    }
    return textTrim(el.getAttribute('aria-label') || el.innerText || el.value || '');
  }

  function sectionOf(el) {
    let p = el;
    for (let i = 0; i < 15 && p; i++, p = p.parentElement) {
      const h = p.querySelector && p.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > legend');
      if (h) return textTrim(h.innerText);
    }
    return '';
  }

  function contextOf(el) {
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = textTrim(p.innerText);
      if (t && t.length > 20) return t.slice(0, 200);
    }
    return '';
  }

  function collect(root, acc, framePath) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    // Includes root itself as a candidate
    const els = [root];
    while ((n = walker.nextNode())) els.push(n);
    for (const el of els) {
      if (!(el instanceof Element)) continue;
      if (!isVisible(el)) continue;
      const role = roleOf(el);
      if (!INTERACTABLE_ROLES.has(role)) {
        // Also pick up custom components with tabindex/contenteditable
        const ce = el.getAttribute('contenteditable');
        const ti = el.getAttribute('tabindex');
        if (ce !== 'true' && ti === null) continue;
      }
      const r = el.getBoundingClientRect();
      const name = nameOf(el, role);
      const label = labelFor(el);
      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();
      const placeholder = el.getAttribute('placeholder') || '';
      const value = (el.value !== undefined ? el.value : el.textContent || '').toString().slice(0, 200);
      const disabled = el.disabled === true || el.getAttribute('aria-disabled') === 'true';
      const required = el.required === true || el.getAttribute('aria-required') === 'true';
      const checked = el.checked === true || el.getAttribute('aria-checked') === 'true';
      let options = [];
      if (tag === 'select') {
        options = Array.from(el.options || []).map(o => textTrim(o.textContent || '')).filter(Boolean).slice(0, 40);
      }
      acc.push({
        role, name, label, placeholder, value, tag, type,
        selector: cssPath(el),
        disabled, required, checked,
        options,
        bbox: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        inViewport: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth,
        framePath,
        context: contextOf(el),
        section: sectionOf(el),
      });
      // Recurse into open shadow roots
      if (el.shadowRoot) {
        const sub = [];
        collect(el.shadowRoot, sub, framePath + '::shadow');
        // dedupe is not required; push
        for (const s of sub) acc.push(s);
      }
    }
  }

  const acc = [];
  collect(document.documentElement, acc, '');
  // Top-level visible text
  const vt = (document.body?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 4000);
  return {
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: { x: scrollX, y: scrollY },
    visibleText: vt,
    nodes: acc,
  };
})();
`;

function hashString(s: string): string {
  // Simple FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

async function extractFromFrame(
  frame: Frame,
  framePath: string
): Promise<{ visibleText: string; nodes: Omit<AxNode, 'ref' | 'sig'>[]; url: string; title: string; viewport: { width: number; height: number }; scroll: { x: number; y: number } }> {
  try {
    const raw = await frame.evaluate(EXTRACTOR_SCRIPT);
    const r = raw as {
      url: string;
      title: string;
      viewport: { width: number; height: number };
      scroll: { x: number; y: number };
      visibleText: string;
      nodes: Omit<AxNode, 'ref' | 'sig' | 'framePath'>[];
    };
    const nodes = r.nodes.map((n) => ({ ...n, framePath }));
    return { visibleText: r.visibleText, nodes, url: r.url, title: r.title, viewport: r.viewport, scroll: r.scroll };
  } catch {
    return { visibleText: '', nodes: [], url: '', title: '', viewport: { width: 0, height: 0 }, scroll: { x: 0, y: 0 } };
  }
}

export async function extractAxSnapshot(page: Page): Promise<AxSnapshot> {
  const main = await extractFromFrame(page.mainFrame(), '');
  const frames = page.frames().filter((f) => f !== page.mainFrame());
  const frameResults = await Promise.all(
    frames.map(async (f, i) => extractFromFrame(f, `frame[${i}]`))
  );
  const combined: Omit<AxNode, 'ref' | 'sig'>[] = [...main.nodes];
  for (const fr of frameResults) combined.push(...fr.nodes);

  // Dedupe near-duplicate visually overlapping buttons by (role, name, bbox rounded to 10px)
  const seen = new Set<string>();
  const deduped: Omit<AxNode, 'ref' | 'sig'>[] = [];
  for (const n of combined) {
    const k = `${n.role}|${n.name}|${Math.round(n.bbox.x / 10)}|${Math.round(n.bbox.y / 10)}|${n.framePath}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(n);
  }

  const withRefs: AxNode[] = deduped.map((n, i) => {
    const sig = hashString(`${n.role}|${n.name}|${n.label}|${n.type}|${n.tag}|${n.framePath}`);
    return { ...n, ref: String(i + 1), sig };
  });

  const structuralHash = hashString(withRefs.map((n) => n.sig).join(','));

  return {
    url: main.url,
    title: main.title,
    viewport: main.viewport,
    scroll: main.scroll,
    nodes: withRefs,
    visibleText: main.visibleText,
    structuralHash,
  };
}

/** Formats a snapshot into an LLM-friendly compact string. */
export function formatAx(snapshot: AxSnapshot, limit = 120): string {
  const lines: string[] = [];
  lines.push(`URL: ${snapshot.url}`);
  lines.push(`Title: ${snapshot.title}`);
  lines.push(`Viewport: ${snapshot.viewport.width}x${snapshot.viewport.height}  Scroll: ${snapshot.scroll.x},${snapshot.scroll.y}`);
  lines.push('');
  lines.push('INTERACTABLES:');
  let section = '';
  const nodes = snapshot.nodes.slice(0, limit);
  for (const n of nodes) {
    if (n.section && n.section !== section) {
      section = n.section;
      lines.push(`-- Section: ${section} --`);
    }
    const bits: string[] = [];
    bits.push(`[${n.ref}]`);
    bits.push(n.role);
    if (n.type && n.type !== n.role) bits.push(`type=${n.type}`);
    if (n.name) bits.push(`"${n.name}"`);
    if (n.label && n.label !== n.name) bits.push(`label="${n.label}"`);
    if (n.placeholder) bits.push(`ph="${n.placeholder}"`);
    if (n.value) bits.push(`value="${String(n.value).slice(0, 60)}"`);
    if (n.required) bits.push('REQ');
    if (n.disabled) bits.push('DIS');
    if (n.checked) bits.push('CHK');
    if (n.options && n.options.length) bits.push(`opts=[${n.options.slice(0, 10).map((o) => `"${o}"`).join(',')}]`);
    if (n.framePath) bits.push(`@${n.framePath}`);
    lines.push(bits.join(' '));
  }
  if (snapshot.nodes.length > limit) {
    lines.push(`... (${snapshot.nodes.length - limit} more)`);
  }
  return lines.join('\n');
}

export function diffSnapshots(a: AxSnapshot, b: AxSnapshot): { added: number; removed: number; changed: number; total: number; changeRatio: number } {
  const mapA = new Map(a.nodes.map((n) => [n.sig, n]));
  const mapB = new Map(b.nodes.map((n) => [n.sig, n]));
  let added = 0, removed = 0, changed = 0;
  for (const [sig, na] of mapA) {
    const nb = mapB.get(sig);
    if (!nb) { removed++; continue; }
    if (na.value !== nb.value || na.checked !== nb.checked || na.disabled !== nb.disabled) changed++;
  }
  for (const sig of mapB.keys()) if (!mapA.has(sig)) added++;
  const total = Math.max(a.nodes.length, b.nodes.length);
  return { added, removed, changed, total, changeRatio: total === 0 ? 1 : (added + removed + changed) / total };
}
