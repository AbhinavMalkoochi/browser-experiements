import fs from 'node:fs/promises';
import path from 'node:path';
import type { Approach, ApproachCtx, Action } from '../core/types.js';
import { ACTION_DSL_SCHEMA, confirmReadyToSubmit, executeActions, formatActionHistory, isRunCancelled, profileToYaml, snapshotWithRetry, type ActionHistoryEntry, type DslOutput } from './shared.js';
import { formatAx } from '../core/ax.js';
import { renderSetOfMarks } from '../core/som.js';
import { chat, userTextImage } from '../core/llm.js';
import { ENV } from '../env.js';

const VISION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    thought: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['click', 'fill', 'select', 'check', 'upload', 'press', 'scroll', 'wait', 'done', 'abort'] },
          index: { type: ['integer', 'null'] },
          value: { type: ['string', 'null'] },
          enter: { type: ['boolean', 'null'] },
          seconds: { type: ['number', 'null'] },
          reason: { type: 'string' },
          status: { type: ['string', 'null'] },
        },
        required: ['kind', 'index', 'value', 'enter', 'seconds', 'reason', 'status'],
      },
    },
  },
  required: ['thought', 'actions'],
} as const;

/**
 * Approach F (novel) — Dual-eye consensus.
 *
 * For each step:
 *   • EYE_A: AX-tree executor proposes action list with refs.
 *   • EYE_B: Vision executor proposes action list with SoM indexes → translated to refs.
 * If both top-1 actions target the same element and same kind → execute (cheap, confident).
 * If they disagree → ask a tiny arbiter LLM (sees AX + cropped image) to decide, then execute.
 * Motivation: most browser-agent failures are grounding mistakes; two independent perception
 * pathways agreeing is strong evidence of correct grounding.
 */
export const approachF: Approach = {
  name: 'f-dual-eye',
  description: 'Novel: dual-eye (AX + vision SoM) parallel proposers; consensus → execute, else arbiter.',
  async run(ctx: ApproachCtx) {
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let stagnation = 0;
    let lastHash = '';
    const history: ActionHistoryEntry[] = [];
    const profileYaml = profileToYaml(ctx.profile);

    while (steps < ctx.maxSteps) {
      if (isRunCancelled(ctx)) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);
      if (snap.behaviorHash === lastHash) stagnation++; else stagnation = 0;
      lastHash = snap.behaviorHash;
      if (stagnation >= 3) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };

      const readyCheck = await confirmReadyToSubmit(ctx.page, snap);
      if (readyCheck.ready) {
        readyToSubmit = true;
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: { kind: 'done', status: 'ready_to_submit', reason: 'local ready-check' }, executed: true, error: null, llmUsage: [], notes: `${readyCheck.filled}/${readyCheck.total}` });
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      const som = await renderSetOfMarks(ctx.page, snap, 40);
      await fs.writeFile(path.join(ctx.artifactDir, `som-${steps}.png`), som.pngBuffer).catch(() => {});

      const axPromise = chat<DslOutput>({
        model: ENV.EXECUTOR_MODEL,
        messages: [
          { role: 'system', content: 'Reliable form-filling agent. Return exactly 1 action (top priority). Use numeric refs. Skip fields with FILLED="...". For uploads value:"resume". Done: {kind:"done", status:"ready_to_submit"}. Block: {kind:"abort"}.' },
          {
            role: 'user',
            content: [
              `GOAL: ${ctx.task.goal}`,
              '',
              'PROFILE:',
              profileYaml,
              '',
              formatActionHistory(history),
              '',
              'SNAPSHOT:',
              formatAx(snap, 120),
            ].join('\n'),
          },
        ],
        jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
        maxTokens: 500,
      });

      // --- Eye B (Vision SoM) ---
      const visionPromise = chat<{ thought: string; actions: Array<Action & { index?: number }> }>({
        model: ENV.VISION_MODEL,
        messages: [
          userTextImage(
            [`Goal: ${ctx.task.goal}`, 'Return JSON with 1 action. Use the numbered index from the screenshot.', 'For uploads: value:"resume". For done: kind:"done", status:"ready_to_submit". For block: kind:"abort".', '', 'Profile:', profileYaml].join('\n'),
            som.dataUrl,
            'high'
          ),
        ],
        jsonSchema: { name: 'SomStep', schema: VISION_SCHEMA, strict: true },
        maxTokens: 500,
      });

      const [axRes, visRes] = await Promise.all([axPromise.catch((e) => ({ error: e })), visionPromise.catch((e) => ({ error: e }))]);
      if ('error' in axRes && 'error' in visRes) {
        return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      let axAct: Action | null = null;
      let visAct: Action | null = null;
      if ('usage' in axRes) {
        ctx.logLlm(axRes.usage);
        axAct = axRes.json?.actions?.[0] ?? null;
      }
      if ('usage' in visRes) {
        ctx.logLlm(visRes.usage);
        const v = visRes.json?.actions?.[0];
        if (v) {
          const node = typeof v.index === 'number' ? som.index.get(v.index) : undefined;
          visAct = { ...v, ref: node?.ref };
        }
      }

      const consensus = (a: Action | null, b: Action | null): boolean => {
        if (!a || !b) return false;
        if (a.kind !== b.kind) return false;
        if (['done', 'abort', 'scroll', 'wait', 'press'].includes(a.kind)) return true;
        if (!a.ref || !b.ref) return false;
        return a.ref === b.ref;
      };

      let chosen: Action | null = null;
      if (consensus(axAct, visAct)) {
        chosen = axAct;
      } else if (axAct && visAct) {
        // Arbiter — small model, sees both proposals + SoM image + AX.
        const arb = await chat<{ chosen: 'A' | 'B'; reason: string }>({
          model: ENV.VERIFIER_MODEL,
          messages: [
            userTextImage(
              [
                `Goal: ${ctx.task.goal}`,
                '',
                'Two candidate actions were proposed:',
                `A (AX-tree eye): ${JSON.stringify(axAct)}`,
                `B (vision eye): ${JSON.stringify(visAct)}`,
                '',
                'Decide which is correct for the current page. Return JSON {chosen:"A"|"B", reason}.',
                '',
                'Compact AX:',
                formatAx(snap, 80),
              ].join('\n'),
              som.dataUrl,
              'low'
            ),
          ],
          jsonSchema: {
            name: 'Arb',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { chosen: { type: 'string', enum: ['A', 'B'] }, reason: { type: 'string' } },
              required: ['chosen', 'reason'],
            },
            strict: true,
          },
          maxTokens: 200,
        }).catch(() => null);
        if (arb) {
          ctx.logLlm(arb.usage);
          chosen = arb.json?.chosen === 'B' ? visAct : axAct;
        } else {
          chosen = axAct; // default to AX
        }
      } else {
        chosen = axAct ?? visAct;
      }

      if (!chosen) {
        stagnation = 0;
        continue;
      }

      const res = await executeActions(ctx, snap, [chosen], steps, history);
      executed += res.executed;
      if (res.doneRejected || res.executed > 0) stagnation = 0;
      if (res.terminal === 'done') { readyToSubmit = true; return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit }; }
      if (res.terminal === 'abort') return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
    }
    return { finalStatus: 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
