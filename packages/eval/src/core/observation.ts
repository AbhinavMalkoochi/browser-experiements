import type { Page } from 'playwright';
import { formatAx, type AxSnapshot } from './ax.js';
import { buildCanonicalObservation, formatCanonicalObservation, type CanonicalObservation } from './canonical.js';
import { renderSetOfMarks, type SomResult } from './som.js';
import type { ChatMessage } from './llm.js';
import type { AtsType, ObservationMode } from './types.js';

export interface ObservationBundle {
  mode: ObservationMode;
  snapshot: AxSnapshot;
  canonical: CanonicalObservation;
  som?: SomResult;
  promptMessages: ChatMessage[];
  textSummary: string;
}

export async function buildObservationBundle(
  page: Page,
  snapshot: AxSnapshot,
  ats: AtsType,
  mode: ObservationMode,
  opts: { includeVision?: boolean; axLimit?: number; canonicalLimit?: number } = {}
): Promise<ObservationBundle> {
  const canonical = buildCanonicalObservation(snapshot, ats, mode);
  const canonicalText = formatCanonicalObservation(canonical, opts.canonicalLimit ?? 40);
  const axText = formatAx(snapshot, opts.axLimit ?? 120);

  if (mode === 'raw_ax') {
    return {
      mode,
      snapshot,
      canonical,
      textSummary: axText,
      promptMessages: [{ role: 'user', content: `OBSERVATION_MODE: raw_ax\n${axText}` }],
    };
  }

  if (mode === 'canonical') {
    return {
      mode,
      snapshot,
      canonical,
      textSummary: canonicalText,
      promptMessages: [{ role: 'user', content: `OBSERVATION_MODE: canonical\n${canonicalText}` }],
    };
  }

  const som = await renderSetOfMarks(page, snapshot, 60);
  const somLegend = Array.from(som.index.entries())
    .slice(0, 40)
    .map(([idx, node]) => `#${idx} => ref=${node.ref} ${node.role} "${node.name || node.label}"`)
    .join('\n');

  if (mode === 'vision_som') {
    return {
      mode,
      snapshot,
      canonical,
      som,
      textSummary: `${canonicalText}\n\nSOM:\n${somLegend}`,
      promptMessages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: `OBSERVATION_MODE: vision_som\nUse the screenshot as primary grounding and the legend to map visible marks back to refs.\n${somLegend}` },
            { type: 'image_url', image_url: { url: som.dataUrl, detail: 'high' } },
          ],
        },
      ],
    };
  }

  return {
    mode,
    snapshot,
    canonical,
    som,
    textSummary: `${canonicalText}\n\nAX:\n${axText.slice(0, 3000)}\n\nSOM:\n${somLegend}`,
    promptMessages: [
      { role: 'user', content: `OBSERVATION_MODE: hybrid\nCANONICAL:\n${canonicalText}\n\nAX:\n${axText.slice(0, 3000)}\n\nSOM LEGEND:\n${somLegend}` },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Use the screenshot only when canonical/AX evidence is insufficient or conflicting.' },
          { type: 'image_url', image_url: { url: som.dataUrl, detail: opts.includeVision ? 'high' : 'low' } },
        ],
      },
    ],
  };
}
