import type { Page } from 'playwright';
import sharp from 'sharp';
import type { AxSnapshot, AxNode } from './ax.js';
import { screenshotBuffer } from './browser.js';

/**
 * Set-of-Marks: overlay a viewport screenshot with numbered colored boxes
 * around interactable elements so vision models can point at them by index.
 */
export interface SomResult {
  pngBuffer: Buffer;
  dataUrl: string;
  /** index -> AxNode (1-indexed) */
  index: Map<number, AxNode>;
}

export async function renderSetOfMarks(page: Page, snapshot: AxSnapshot, maxMarks = 60): Promise<SomResult> {
  const png = await screenshotBuffer(page, false);
  const meta = await sharp(png).metadata();
  const width = meta.width ?? snapshot.viewport.width;
  const height = meta.height ?? snapshot.viewport.height;

  // Pick nodes that are at least partly in viewport
  const candidates = snapshot.nodes
    .filter((n) => n.inViewport && n.bbox.w > 5 && n.bbox.h > 5)
    .slice(0, maxMarks);

  const svgParts: string[] = [];
  const colors = ['#E11D48', '#2563EB', '#059669', '#D97706', '#7C3AED', '#DB2777', '#0891B2', '#65A30D'];
  const index = new Map<number, AxNode>();
  candidates.forEach((n, i) => {
    const idx = i + 1;
    index.set(idx, n);
    const c = colors[i % colors.length];
    const x = Math.max(0, Math.min(width - 1, n.bbox.x));
    const y = Math.max(0, Math.min(height - 1, n.bbox.y));
    const w = Math.max(4, Math.min(width - x, n.bbox.w));
    const h = Math.max(4, Math.min(height - y, n.bbox.h));
    svgParts.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${c}" stroke-width="2" />`
    );
    const lx = Math.max(1, x - 1);
    const ly = Math.max(14, y - 2);
    svgParts.push(
      `<rect x="${lx}" y="${ly - 12}" width="${String(idx).length * 9 + 6}" height="14" fill="${c}" />`
    );
    svgParts.push(
      `<text x="${lx + 3}" y="${ly - 1}" font-family="monospace" font-size="12" fill="white" font-weight="bold">${idx}</text>`
    );
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svgParts.join('')}</svg>`;
  const composite = await sharp(png)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
  return {
    pngBuffer: composite,
    dataUrl: `data:image/png;base64,${composite.toString('base64')}`,
    index,
  };
}
