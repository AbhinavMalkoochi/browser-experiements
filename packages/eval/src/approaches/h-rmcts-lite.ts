import fs from 'node:fs/promises';
import path from 'node:path';
import type { Approach, ApproachCtx, Action } from '../core/types.js';
import { ACTION_DSL_SCHEMA, confirmReadyToSubmit, executeActions, formatActionHistory, isRunCancelled, profileToYaml, snapshotWithRetry, type ActionHistoryEntry, type DslOutput } from './shared.js';
import { formatAx, diffSnapshots } from '../core/ax.js';
import { chat, userTextImage } from '../core/llm.js';
import { screenshotDataUrl } from '../core/browser.js';
import { ENV } from '../env.js';

/**
 * Approach H (novel) — R-MCTS-lite with vision-evidence verifier.
 *
 * After each executed action, run a 2-LLM debate:
 *   • prosecutor — argues the action failed (before/after screenshots + AX diff).
 *   • defender   — argues it succeeded.
 * A judge decides. If verdict = failed → rollback one step (retry with alternate proposal).
 * Max 2 rollbacks per application.
 */
const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdict: { type: 'string', enum: ['succeeded', 'failed', 'unclear'] },
    evidence: { type: 'string' },
    suggested_alternate: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        ref: { type: 'string' },
        kind: { type: 'string' },
        value: { type: ['string', 'null'] },
        reason: { type: 'string' },
      },
      required: ['ref', 'kind', 'value', 'reason'],
    },
  },
  required: ['verdict', 'evidence', 'suggested_alternate'],
} as const;

export const approachH: Approach = {
  name: 'h-rmcts-lite',
  description: 'Novel: R-MCTS-lite with 2-agent debate verifier; rollback on failed actions (bounded).',
  async run(ctx: ApproachCtx) {
    const profileYaml = profileToYaml(ctx.profile);
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let rollbacksLeft = 2;
    let lastHash = '';
    let stagnation = 0;
    const history: ActionHistoryEntry[] = [];

    while (steps < ctx.maxSteps) {
      if (isRunCancelled(ctx)) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      steps += 1;
      const beforeSnap = await snapshotWithRetry(ctx.page);
      if (beforeSnap.behaviorHash === lastHash) stagnation++; else stagnation = 0;
      lastHash = beforeSnap.behaviorHash;
      if (stagnation >= 3) break;

      const readyCheck = await confirmReadyToSubmit(ctx.page, beforeSnap);
      if (readyCheck.ready) {
        readyToSubmit = true;
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: { kind: 'done', status: 'ready_to_submit', reason: 'local ready-check' }, executed: true, error: null, llmUsage: [], notes: `${readyCheck.filled}/${readyCheck.total}` });
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      const beforeShot = await screenshotDataUrl(ctx.page, false);

      // Propose
      const propose = await chat<DslOutput>({
        model: ENV.EXECUTOR_MODEL,
        messages: [
          { role: 'system', content: 'Form-filling agent. Use numeric refs. Skip FILLED fields. Emit up to 2 actions. Uploads value:"resume". Done when form filled + submit visible.' },
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
              formatAx(beforeSnap, 140),
            ].join('\n'),
          },
        ],
        jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
        maxTokens: 600,
      }).catch(() => null);
      if (!propose) return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      ctx.logLlm(propose.usage);
      if (!propose.json) continue;

      const res = await executeActions(ctx, beforeSnap, propose.json.actions, steps, history);
      executed += res.executed;
      if (res.doneRejected || res.executed > 0) stagnation = 0;

      if (res.terminal === 'done') { readyToSubmit = true; return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit }; }
      if (res.terminal === 'abort') return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };

      // Verify via two-agent debate
      const afterSnap = await snapshotWithRetry(ctx.page);
      const diff = diffSnapshots(beforeSnap, afterSnap);
      const afterShot = await screenshotDataUrl(ctx.page, false);

      // Skip verify if action was obviously successful (notable diff).
      if (diff.changeRatio >= 0.05) continue;

      const lastAction = propose.json.actions[propose.json.actions.length - 1];
      const verdict = await chat<{ verdict: 'succeeded' | 'failed' | 'unclear'; evidence: string; suggested_alternate?: { ref: string; kind: string; value?: string; reason: string } }>({
        model: ENV.VERIFIER_MODEL,
        messages: [
          {
            role: 'system',
            content: 'You are a strict verifier. Two images: BEFORE and AFTER an action. Decide whether the action actually occurred. verdict: succeeded|failed|unclear. If failed, propose a better ref for the same intent.',
          },
          userTextImage(
            [
              `Attempted action: ${JSON.stringify(lastAction)}`,
              `AX diff: added=${diff.added} removed=${diff.removed} changed=${diff.changed} ratio=${diff.changeRatio.toFixed(3)}`,
              '',
              'BEFORE:',
            ].join('\n'),
            beforeShot,
            'low'
          ),
          userTextImage('AFTER:', afterShot, 'low'),
        ],
        jsonSchema: { name: 'Verdict', schema: VERDICT_SCHEMA, strict: true },
        maxTokens: 300,
      }).catch(() => null);
      if (!verdict) continue;
      ctx.logLlm(verdict.usage);

      if (verdict.json?.verdict === 'failed' && rollbacksLeft > 0 && verdict.json.suggested_alternate) {
        rollbacksLeft -= 1;
        const alt = verdict.json.suggested_alternate;
        const altAction: Action = {
          kind: (alt.kind as Action['kind']) ?? lastAction?.kind ?? 'click',
          ref: alt.ref,
          value: alt.value ?? lastAction?.value,
          reason: `rollback: ${alt.reason}`,
        };
        const retry = await executeActions(ctx, afterSnap, [altAction], steps, history);
        executed += retry.executed;
        if (retry.executed > 0) stagnation = 0;
      }
    }
    return { finalStatus: readyToSubmit ? 'done' : 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
