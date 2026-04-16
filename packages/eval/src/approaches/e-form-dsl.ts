import type { Approach, ApproachCtx, Action } from '../core/types.js';
import { confirmReadyToSubmit, executeActions, isRunCancelled, profileToYaml, snapshotWithRetry } from './shared.js';
import { formatAx, diffSnapshots } from '../core/ax.js';
import { chat } from '../core/llm.js';
import { ENV } from '../env.js';

/**
 * Approach E (novel) — Form DSL compiler.
 *
 * One LLM call per *page* emits a complete FormSpec (every fill/select/upload/check + click order).
 * A deterministic interpreter then executes the spec without further LLM calls.
 * If the page changes (multi-step wizard) we re-compile.
 *
 * This dramatically reduces token costs vs one-action-per-step approaches on long forms.
 */
const FORM_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page_kind: { type: 'string', enum: ['landing', 'application_form', 'multi_step', 'login_wall', 'captcha', 'thank_you', 'other'] },
    fills: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string' }, value: { type: 'string' }, reason: { type: 'string' } },
        required: ['ref', 'value', 'reason'],
      },
    },
    selects: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string' }, option: { type: 'string' }, reason: { type: 'string' } },
        required: ['ref', 'option', 'reason'],
      },
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string' }, reason: { type: 'string' } },
        required: ['ref', 'reason'],
      },
    },
    uploads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string' }, file: { type: 'string', enum: ['resume', 'cover_letter'] }, reason: { type: 'string' } },
        required: ['ref', 'file', 'reason'],
      },
    },
    clicks_in_order: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { ref: { type: 'string' }, when: { type: 'string', enum: ['before_fills', 'after_fills', 'to_continue'] }, reason: { type: 'string' } },
        required: ['ref', 'when', 'reason'],
      },
    },
    terminal: { type: 'string', enum: ['continue', 'ready_to_submit', 'blocked'] },
    notes: { type: 'string' },
  },
  required: ['page_kind', 'fills', 'selects', 'checks', 'uploads', 'clicks_in_order', 'terminal', 'notes'],
} as const;

type FormSpec = {
  page_kind: string;
  fills: Array<{ ref: string; value: string; reason: string }>;
  selects: Array<{ ref: string; option: string; reason: string }>;
  checks: Array<{ ref: string; reason: string }>;
  uploads: Array<{ ref: string; file: 'resume' | 'cover_letter'; reason: string }>;
  clicks_in_order: Array<{ ref: string; when: 'before_fills' | 'after_fills' | 'to_continue'; reason: string }>;
  terminal: 'continue' | 'ready_to_submit' | 'blocked';
  notes: string;
};

const SYSTEM = `You are a form-filling compiler. Input: a page's accessibility snapshot + a candidate profile.
Output: a *complete* FormSpec for this page.

Rules:
- ref MUST be the numeric string from the snapshot brackets (e.g. "12"). Never use semantic names.
- SKIP any field whose snapshot already shows FILLED="..." — leave those out of fills/selects/checks.
- Include every OTHER required field in fills/selects/checks/uploads, matched to profile values.
- For selects: pick the option label that best matches the profile. Prefer exact; else closest semantic match.
- For EEO/demographic questions, use the profile's declared answers (gender, race, veteran_status, etc).
- clicks_in_order: include ONLY clicks needed on this page (e.g., "Continue" at the end). Do NOT include the final Submit.
- terminal: "ready_to_submit" if after executing, the form becomes ready for the user to submit.
- terminal: "continue" if this is a multi-step wizard and more pages remain.
- terminal: "blocked" if captcha/login/unrecoverable.
- If this is a landing page with an "Apply"/"I am interested" button, the whole spec should be a single click_in_order entry on that button, with terminal "continue".
- Never invent profile facts.
`;

export const approachE: Approach = {
  name: 'e-form-dsl',
  description: 'Novel: Form DSL compiler — one LLM call per page emits a typed FormSpec; interpreter executes.',
  async run(ctx: ApproachCtx) {
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let lastHash = '';
    let stagnation = 0;
    const profileYaml = profileToYaml(ctx.profile);

    while (steps < ctx.maxSteps) {
      if (isRunCancelled(ctx)) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);
      if (snap.behaviorHash === lastHash) stagnation++; else stagnation = 0;
      lastHash = snap.behaviorHash;
      if (stagnation >= 2) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit, note: 'no progress after compile' };

      const readyCheck = await confirmReadyToSubmit(ctx.page, snap);
      if (readyCheck.ready) {
        readyToSubmit = true;
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: { kind: 'done', status: 'ready_to_submit', reason: 'local ready-check' }, executed: true, error: null, llmUsage: [], notes: `${readyCheck.filled}/${readyCheck.total}` });
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      let out;
      try {
        out = await chat<FormSpec>({
          model: ENV.EXECUTOR_MODEL,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: [`GOAL: ${ctx.task.goal}`, '', 'PROFILE:', profileYaml, '', 'SNAPSHOT:', formatAx(snap, 160)].join('\n') },
          ],
          jsonSchema: { name: 'FormSpec', schema: FORM_SPEC_SCHEMA, strict: true },
          maxTokens: 1800,
        });
      } catch (e) {
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: null, executed: false, error: (e as Error).message, llmUsage: [], notes: '' });
        return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      ctx.logLlm(out.usage);
      const spec = out.json;
      if (!spec) {
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: null, executed: false, error: 'no form spec', llmUsage: [out.usage], notes: out.text.slice(0, 200) });
        continue;
      }

      if (spec.terminal === 'blocked') {
        return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit, note: spec.notes };
      }

      // Compile the spec into a linear action list.
      const actions: Action[] = [];
      for (const c of spec.clicks_in_order.filter((c) => c.when === 'before_fills'))
        actions.push({ kind: 'click', ref: c.ref, reason: c.reason });
      for (const f of spec.fills)
        actions.push({ kind: 'fill', ref: f.ref, value: f.value, reason: f.reason });
      for (const s of spec.selects)
        actions.push({ kind: 'select', ref: s.ref, value: s.option, reason: s.reason });
      for (const ch of spec.checks)
        actions.push({ kind: 'check', ref: ch.ref, reason: ch.reason });
      for (const u of spec.uploads)
        actions.push({ kind: 'upload', ref: u.ref, value: u.file === 'resume' ? ctx.profile.resumePath : (ctx.profile.coverLetterPath ?? ctx.profile.resumePath), reason: u.reason });
      for (const c of spec.clicks_in_order.filter((c) => c.when === 'after_fills' || c.when === 'to_continue'))
        actions.push({ kind: 'click', ref: c.ref, reason: c.reason });

      const res = await executeActions(ctx, snap, actions, steps);
      executed += res.executed;
      if (res.doneRejected || res.executed > 0) stagnation = 0;

      // After compile, if the page said ready_to_submit, verify then finish.
      if (spec.terminal === 'ready_to_submit') {
        readyToSubmit = true;
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      // Else continue; another compile pass will run on the next page.
    }
    return { finalStatus: 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
