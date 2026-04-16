import type { Approach, ApproachCtx } from '../core/types.js';
import {
  ACTION_DSL_SCHEMA,
  buildProgressHint,
  confirmReadyToSubmit,
  executeActions,
  formatActionHistory,
  isRunCancelled,
  profileToYaml,
  snapshotWithRetry,
  type ActionHistoryEntry,
  type DslOutput,
} from './shared.js';
import { formatAx, diffSnapshots } from '../core/ax.js';
import { chat } from '../core/llm.js';
import { ENV } from '../env.js';

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'array', items: { type: 'string' } },
    success_criteria: { type: 'array', items: { type: 'string' } },
    human_in_loop_flags: { type: 'array', items: { type: 'string' } },
    ats_family: { type: 'string' },
  },
  required: ['plan', 'success_criteria', 'human_in_loop_flags', 'ats_family'],
} as const;

const PLANNER_PROMPT = `You are a senior browser-agent planner. Given a starting page's accessibility snapshot
and a user profile, emit:
1) plan — a short ordered list of high-level steps a form-filler must take.
2) success_criteria — observable conditions meaning the task is complete.
3) human_in_loop_flags — things the automated agent should escalate to a human (captcha, create-account-wall).
4) ats_family — greenhouse/lever/ashby/workday/workable/smartrecruiters/applytojob/icims/oracle/linkedin/custom.
Return only JSON.`;

const EXEC_PROMPT = `You are a fast, reliable form-filling executor. Follow the plan; emit 1–3 typed DSL actions per step.
Use the accessibility snapshot's numbered refs (e.g. "12"); never use semantic names like "email".
Do NOT re-fill a field whose snapshot shows a FILLED="..." marker — it is already correct.
Do NOT repeat an action that already succeeded in RECENT ACTIONS.
Never click a Submit button — emit {kind:"done", status:"ready_to_submit"} when all required fields are filled and Submit is visible+enabled.
If captcha/blocked → {kind:"abort", status:"blocked"}. For file uploads use value:"resume".`;

export const approachD: Approach = {
  name: 'd-hierarchical',
  description: 'Hierarchical planner (big model) + tiny executor + change-observer verifier.',
  async run(ctx: ApproachCtx) {
    const profileYaml = profileToYaml(ctx.profile);
    const firstSnap = await snapshotWithRetry(ctx.page);

    // === Planner — single call ===
    let plan;
    try {
      plan = await chat<{ plan: string[]; success_criteria: string[]; human_in_loop_flags: string[]; ats_family: string }>({
        model: ENV.PLANNER_MODEL,
        messages: [
          { role: 'system', content: PLANNER_PROMPT },
          {
            role: 'user',
            content: [
              `TASK GOAL: ${ctx.task.goal}`,
              '',
              'PROFILE (YAML):',
              profileYaml,
              '',
              'INITIAL SNAPSHOT:',
              formatAx(firstSnap, 100),
            ].join('\n'),
          },
        ],
        jsonSchema: { name: 'Plan', schema: PLAN_SCHEMA, strict: true },
        maxTokens: 700,
      });
    } catch (e) {
      ctx.logStep({ step: 0, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: null, executed: false, error: `plan fail: ${(e as Error).message}`, llmUsage: [], notes: '' });
      return { finalStatus: 'crashed', stepsTaken: 0, actionsExecuted: 0, readyToSubmit: false };
    }
    ctx.logLlm(plan.usage);
    const planText = plan.json
      ? `PLAN:\n${plan.json.plan.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n\nSUCCESS CRITERIA:\n${plan.json.success_criteria.join('\n')}`
      : plan.text;

    // === Executor loop ===
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let prevSnap = firstSnap;
    let noChangeCount = 0;
    const history: ActionHistoryEntry[] = [];

    while (steps < ctx.maxSteps) {
      if (isRunCancelled(ctx)) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);

      const readyCheck = await confirmReadyToSubmit(ctx.page, snap);
      if (readyCheck.ready) {
        readyToSubmit = true;
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: { kind: 'done', status: 'ready_to_submit', reason: 'local ready-check' }, executed: true, error: null, llmUsage: [], notes: `${readyCheck.filled}/${readyCheck.total}` });
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      const diff = diffSnapshots(prevSnap, snap);
      const behaviorUnchanged = snap.behaviorHash === prevSnap.behaviorHash;
      if (steps > 1 && diff.changeRatio < 0.01 && behaviorUnchanged) noChangeCount += 1;
      else noChangeCount = 0;
      prevSnap = snap;
      if (noChangeCount >= 3) {
        return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit, note: 'no-change stall' };
      }

      let out;
      try {
        out = await chat<DslOutput>({
          model: ENV.EXECUTOR_MODEL,
          messages: [
            { role: 'system', content: EXEC_PROMPT },
            {
              role: 'user',
              content: [
                planText,
                '',
                buildProgressHint(snap, readyCheck),
                '',
                'PROFILE:',
                profileYaml,
                '',
                formatActionHistory(history),
                '',
                'CURRENT SNAPSHOT:',
                formatAx(snap, 140),
              ].join('\n'),
            },
          ],
          jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
          maxTokens: 700,
        });
      } catch (e) {
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: null, executed: false, error: (e as Error).message, llmUsage: [], notes: '' });
        return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      ctx.logLlm(out.usage);
      if (!out.json) continue;
      const res = await executeActions(ctx, snap, out.json.actions, steps, history);
      executed += res.executed;
      if (res.doneRejected || res.executed > 0) noChangeCount = 0;
      if (res.terminal === 'done') { readyToSubmit = true; return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit }; }
      if (res.terminal === 'abort') return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
    }
    return { finalStatus: 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
