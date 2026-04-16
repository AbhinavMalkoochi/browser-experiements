import type { Approach, ApproachCtx } from '../core/types.js';
import {
  ACTION_DSL_SCHEMA,
  confirmReadyToSubmit,
  executeActions,
  formatActionHistory,
  profileToYaml,
  snapshotWithRetry,
  type ActionHistoryEntry,
  type DslOutput,
} from './shared.js';
import { formatAx } from '../core/ax.js';
import { chat } from '../core/llm.js';
import { ENV } from '../env.js';

const SYSTEM_PROMPT = `You are a browser agent specialized in filling out online job applications.

You will be given:
- The overall goal
- The user's profile in YAML
- A recent-action history (what you just did, success/failure)
- An accessibility snapshot (numbered interactable elements with role, name, label, options, required, FILLED markers)

Rules:
- Return JSON following the provided schema. Output 1–3 actions per step; prefer fewer.
- ref MUST be the numeric string from the snapshot brackets (e.g. "7"). NEVER use semantic names like "email".
- Do NOT re-fill a field that already has a "FILLED=..." marker — it is already correct. Move on.
- Do NOT repeat the exact same action that succeeded in the history — move to the next task.
- Prefer exact option labels on selects/radios. If the profile has no matching option, pick the closest semantic match.
- For file uploads, set value to the literal string "resume"; the system will resolve the actual file path.
- When all required fields are filled and a Submit/Apply button is visible and enabled, emit a single action {"kind":"done","status":"ready_to_submit"} — DO NOT click Submit.
- If blocked by CAPTCHA, login wall, or unrecoverable error, emit {"kind":"abort","status":"blocked"}.
- If two consecutive attempts at the same element fail, try a sibling element or scroll first.
- Always provide a short "reason".
`;

export const approachB: Approach = {
  name: 'b-axtree-indexed',
  description: 'AX-tree indexed refs + structured-output DSL actions (GPT-4o-mini executor).',
  async run(ctx: ApproachCtx) {
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let stagnationCount = 0;
    let lastBehaviorHash = '';
    const history: ActionHistoryEntry[] = [];
    const profileYaml = profileToYaml(ctx.profile);

    while (steps < ctx.maxSteps) {
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);
      if (snap.behaviorHash === lastBehaviorHash) stagnationCount += 1;
      else stagnationCount = 0;
      lastBehaviorHash = snap.behaviorHash;
      if (stagnationCount >= 3) {
        ctx.logStep({
          step: steps,
          approach: ctx.approach,
          tsMs: Date.now(),
          durationMs: 0,
          url: ctx.page.url(),
          actionExecuted: null,
          executed: false,
          error: 'stagnation',
          llmUsage: [],
          notes: 'Giving up after 3 no-change steps.',
        });
        return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      const readyCheck = await confirmReadyToSubmit(ctx.page, snap);
      if (readyCheck.ready) {
        readyToSubmit = true;
        ctx.logStep({
          step: steps,
          approach: ctx.approach,
          tsMs: Date.now(),
          durationMs: 0,
          url: ctx.page.url(),
          actionExecuted: { kind: 'done', status: 'ready_to_submit', reason: 'local ready-check passed' },
          executed: true,
          error: null,
          llmUsage: [],
          notes: `filled=${readyCheck.filled}/${readyCheck.total} submit=${readyCheck.submitFound}/${readyCheck.submitEnabled}`,
        });
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      const missingHint = readyCheck.total > 0
        ? `PROGRESS: ${readyCheck.filled}/${readyCheck.total} required fields filled. STILL MISSING: ${readyCheck.missing.slice(0, 8).join(', ')}. Submit ${readyCheck.submitFound ? 'visible' : 'not yet visible'}.`
        : 'PROGRESS: no required fields detected yet — you may need to click an Apply button first.';

      const userPrompt = [
        `GOAL: ${ctx.task.goal}`,
        '',
        missingHint,
        '',
        'PROFILE (YAML):',
        profileYaml,
        '',
        formatActionHistory(history),
        '',
        'SNAPSHOT:',
        formatAx(snap, 180),
      ].join('\n');

      let out;
      try {
        out = await chat<DslOutput>({
          model: ENV.EXECUTOR_MODEL,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
          maxTokens: 800,
        });
      } catch (e) {
        ctx.logStep({
          step: steps,
          approach: ctx.approach,
          tsMs: Date.now(),
          durationMs: 0,
          url: ctx.page.url(),
          actionExecuted: null,
          executed: false,
          error: `llm error: ${(e as Error).message}`,
          llmUsage: [],
          notes: '',
        });
        return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      ctx.logLlm(out.usage);
      const parsed = out.json;
      if (!parsed || !Array.isArray(parsed.actions)) {
        ctx.logStep({
          step: steps,
          approach: ctx.approach,
          tsMs: Date.now(),
          durationMs: 0,
          url: ctx.page.url(),
          actionExecuted: null,
          executed: false,
          error: 'LLM returned malformed actions',
          llmUsage: [out.usage],
          notes: out.text.slice(0, 400),
        });
        continue;
      }

      const res = await executeActions(ctx, snap, parsed.actions, steps, history);
      executed += res.executed;

      if (res.terminal === 'done') {
        readyToSubmit = true;
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      if (res.terminal === 'abort') {
        return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
    }
    return { finalStatus: 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
