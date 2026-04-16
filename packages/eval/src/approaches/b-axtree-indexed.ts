import type { Approach, ApproachCtx } from '../core/types.js';
import { ACTION_DSL_SCHEMA, executeActions, profileToYaml, snapshotWithRetry, type DslOutput } from './shared.js';
import { formatAx } from '../core/ax.js';
import { chat } from '../core/llm.js';
import { ENV } from '../env.js';

const SYSTEM_PROMPT = `You are a browser agent specialized in filling out online job applications.
You will be given:
- The overall goal
- The user's profile in YAML
- An accessibility snapshot (numbered interactable elements with role, name, label, options, required flag)

Rules:
- Return JSON following the provided schema. Output up to 3 actions per step; fewer is fine.
- Prefer exact matches for option labels on selects/radios. If the exact value does not appear, choose the option closest in meaning.
- For file uploads, put the literal string "resume" in the value; the system will supply the actual path.
- When the form is fully filled and a Submit/Apply button is visible and enabled, emit a single {kind:"done", status:"ready_to_submit"} — DO NOT click Submit.
- If the page is blocked by CAPTCHA, login wall, or unrecoverable error, emit {kind:"abort", status:"blocked"}.
- If critical required information is missing from the profile, emit {kind:"abort", status:"error"} with a reason.
- When filling long narrative fields (cover letter, "why this role"), use plausible text derived from the profile summary — never invent facts not in the profile.
- Always provide a short "reason" for each action.
`;

export const approachB: Approach = {
  name: 'b-axtree-indexed',
  description: 'AX-tree indexed refs + structured-output DSL actions (GPT-4o-mini executor).',
  async run(ctx: ApproachCtx) {
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let stagnationCount = 0;
    let lastHash = '';
    const profileYaml = profileToYaml(ctx.profile);

    while (steps < ctx.maxSteps) {
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);
      if (snap.structuralHash === lastHash) stagnationCount += 1;
      else stagnationCount = 0;
      lastHash = snap.structuralHash;
      if (stagnationCount >= 4) {
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
          notes: 'Giving up after 4 no-op steps.',
        });
        return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      const userPrompt = [
        `GOAL: ${ctx.task.goal}`,
        '',
        'PROFILE (YAML):',
        profileYaml,
        '',
        'SNAPSHOT:',
        formatAx(snap, 140),
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

      const res = await executeActions(ctx, snap, parsed.actions, steps);
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
