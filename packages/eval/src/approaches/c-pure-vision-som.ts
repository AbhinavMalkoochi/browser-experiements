import fs from 'node:fs/promises';
import path from 'node:path';
import type { Approach, ApproachCtx, Action } from '../core/types.js';
import { renderSetOfMarks } from '../core/som.js';
import { snapshotWithRetry, profileToYaml, executeActions } from './shared.js';
import { chat, userTextImage } from '../core/llm.js';
import { ENV } from '../env.js';

const SOM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    thought: { type: 'string' },
    actions: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['click', 'fill', 'select', 'check', 'upload', 'press', 'scroll', 'wait', 'done', 'abort'] },
          index: { type: 'integer' },
          value: { type: 'string' },
          enter: { type: 'boolean' },
          seconds: { type: 'number' },
          reason: { type: 'string' },
          status: { type: 'string', enum: ['ready_to_submit', 'submitted', 'blocked', 'error'] },
        },
        required: ['kind', 'reason'],
      },
    },
  },
  required: ['thought', 'actions'],
} as const;

export const approachC: Approach = {
  name: 'c-pure-vision-som',
  description: 'Pure vision + Set-of-Marks: numbered-box screenshot, no DOM text fed to LLM.',
  async run(ctx: ApproachCtx) {
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let lastHash = '';
    let stagnation = 0;
    const profileYaml = profileToYaml(ctx.profile);

    while (steps < ctx.maxSteps) {
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);
      if (snap.structuralHash === lastHash) stagnation++; else stagnation = 0;
      lastHash = snap.structuralHash;
      if (stagnation >= 4) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };

      const som = await renderSetOfMarks(ctx.page, snap, 40);
      // Save for artifact
      await fs.writeFile(path.join(ctx.artifactDir, `som-${steps}.png`), som.pngBuffer).catch(() => {});

      // Vision model sees only the annotated screenshot + the goal + profile.
      const prompt = [
        `Goal: ${ctx.task.goal}`,
        '',
        'You will see a screenshot with numbered boxes around interactables.',
        'Return JSON: {thought, actions:[{kind, index, value?, ...}]}',
        '- Use the numbered "index" to target an element.',
        '- For fills, put the desired text in "value".',
        '- For uploads, put "resume" in value.',
        '- Emit {kind:"done", status:"ready_to_submit"} when form is filled and Submit is visible; do NOT submit.',
        '- Emit {kind:"abort", status:"blocked"} on captcha/login wall.',
        '',
        'Profile:',
        profileYaml,
      ].join('\n');

      let out;
      try {
        out = await chat<{ thought: string; actions: Array<Action & { index?: number }> }>({
          model: ENV.VISION_MODEL,
          messages: [userTextImage(prompt, som.dataUrl, 'high')],
          jsonSchema: { name: 'SomStep', schema: SOM_SCHEMA, strict: true },
          maxTokens: 800,
        });
      } catch (e) {
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: null, executed: false, error: (e as Error).message, llmUsage: [], notes: '' });
        return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      ctx.logLlm(out.usage);
      const parsed = out.json;
      if (!parsed) continue;

      // Translate SoM indexes into AX refs via the som.index map.
      const translated: Action[] = parsed.actions.map((a) => {
        const node = typeof a.index === 'number' ? som.index.get(a.index) : undefined;
        return {
          ...a,
          ref: node?.ref,
        };
      });
      const res = await executeActions(ctx, snap, translated, steps);
      executed += res.executed;
      if (res.terminal === 'done') { readyToSubmit = true; return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit }; }
      if (res.terminal === 'abort') return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
    }
    return { finalStatus: 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
