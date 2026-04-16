import type { Page } from 'playwright';
import type { Action, ApproachCtx, TestProfile } from '../core/types.js';
import { extractAxSnapshot, type AxSnapshot } from '../core/ax.js';
import { Actuator } from '../core/actuator.js';
import { waitForIdle } from '../core/browser.js';

/**
 * JSON schema for the typed action DSL. Used by approaches B/D/F for
 * strict OpenAI structured-output decoding.
 */
export const ACTION_DSL_SCHEMA = {
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
          kind: {
            type: 'string',
            enum: [
              'click', 'fill', 'select', 'check', 'upload', 'press',
              'scroll', 'wait', 'goto', 'done', 'abort',
            ],
          },
          ref: { type: ['string', 'null'] },
          value: { type: ['string', 'null'] },
          enter: { type: ['boolean', 'null'] },
          seconds: { type: ['number', 'null'] },
          reason: { type: 'string' },
          status: { type: ['string', 'null'] },
        },
        required: ['kind', 'ref', 'value', 'enter', 'seconds', 'reason', 'status'],
      },
    },
  },
  required: ['thought', 'actions'],
} as const;

export type DslOutput = { thought: string; actions: Action[] };

/** Compact profile serialization used in executor prompts. */
export function profileToYaml(p: TestProfile): string {
  const lines: string[] = [];
  lines.push(`name: ${p.fullName}`);
  lines.push(`first_name: ${p.firstName}`);
  lines.push(`last_name: ${p.lastName}`);
  lines.push(`email: ${p.email}`);
  lines.push(`phone: ${p.phone}`);
  lines.push(`location: ${p.location}`);
  lines.push(`city: ${p.city}`);
  lines.push(`state: ${p.state}`);
  lines.push(`zip: ${p.zip}`);
  lines.push(`country: ${p.country}`);
  lines.push(`linkedin: ${p.linkedin}`);
  lines.push(`github: ${p.github}`);
  lines.push(`website: ${p.website}`);
  lines.push(`current_company: ${p.currentCompany}`);
  lines.push(`current_title: ${p.currentTitle}`);
  lines.push(`years_experience: ${p.yearsExperience}`);
  lines.push(`work_authorization: ${p.workAuthorization}`);
  lines.push(`requires_sponsorship: ${p.requiresSponsorship}`);
  lines.push(`willing_to_relocate: ${p.willingToRelocate}`);
  lines.push(`preferred_start_date: ${p.preferredStartDate}`);
  lines.push(`salary_expectation: ${p.salaryExpectation}`);
  lines.push(`gender: ${p.gender}`);
  lines.push(`race: ${p.race}`);
  lines.push(`veteran_status: ${p.veteranStatus}`);
  lines.push(`disability_status: ${p.disabilityStatus}`);
  lines.push(`pronouns: ${p.pronouns}`);
  lines.push(`hispanic_latino: ${p.hispanicLatino}`);
  lines.push(`summary: ${p.summary}`);
  lines.push(`skills: ${p.skills.join(', ')}`);
  lines.push('education:');
  for (const e of p.education) lines.push(`  - ${e.degree} in ${e.field}, ${e.school} (${e.gradYear}) GPA ${e.gpa}`);
  lines.push('experience:');
  for (const x of p.experience) lines.push(`  - ${x.title} @ ${x.company} (${x.start}–${x.end})`);
  lines.push('qa_cache:');
  for (const q of p.qa) lines.push(`  - Q: ${q.q}\n    A: ${q.a}`);
  return lines.join('\n');
}

export interface StepCtx {
  page: Page;
  approach: string;
  stepIndex: number;
  artifactDir: string;
}

export interface ActionHistoryEntry {
  step: number;
  action: Action;
  ok: boolean;
  error?: string;
}

/**
 * Short textual action history for the executor prompt. Encourages the model
 * to stop re-proposing the same action after a successful execution and to
 * try a different strategy after a failure.
 */
export function formatActionHistory(history: ActionHistoryEntry[], limit = 8): string {
  if (history.length === 0) return 'RECENT ACTIONS: (none yet)';
  const tail = history.slice(-limit);
  const lines = tail.map((h) => {
    const a = h.action;
    const bits: string[] = [`${a.kind}`];
    if (a.ref) bits.push(`ref=${a.ref}`);
    if (a.value) bits.push(`value=${JSON.stringify(a.value).slice(0, 60)}`);
    const status = h.ok ? 'ok' : `FAIL(${(h.error ?? '').slice(0, 80)})`;
    return `  #${h.step} ${bits.join(' ')} -> ${status}`;
  });
  return `RECENT ACTIONS (oldest→newest):\n${lines.join('\n')}`;
}

export async function executeActions(
  ctx: ApproachCtx,
  snap: AxSnapshot,
  actions: Action[],
  stepIndex: number,
  history?: ActionHistoryEntry[]
): Promise<{ executed: number; terminal: 'done' | 'abort' | null; lastError: string | null }> {
  const actuator = new Actuator(ctx.page, snap);
  let executed = 0;
  let terminal: 'done' | 'abort' | null = null;
  let lastError: string | null = null;
  for (const a of actions) {
    if (a.kind === 'done') {
      terminal = 'done';
      break;
    }
    if (a.kind === 'abort') {
      terminal = 'abort';
      break;
    }
    // Inject resume path
    const resolved: Action = { ...a };
    if (resolved.kind === 'upload' && (!resolved.value || resolved.value === 'resume' || resolved.value === 'RESUME' || resolved.value === '<resume>')) {
      resolved.value = ctx.profile.resumePath;
    }
    const t0 = Date.now();
    const res = await actuator.execute(resolved);
    const dur = Date.now() - t0;
    ctx.logStep({
      step: stepIndex,
      approach: ctx.approach,
      tsMs: Date.now(),
      durationMs: dur,
      url: ctx.page.url(),
      actionExecuted: resolved,
      executed: res.ok,
      error: res.error ?? null,
      llmUsage: [],
      notes: res.note ?? '',
    });
    if (res.ok) {
      executed += 1;
    } else {
      lastError = res.error ?? 'unknown';
    }
    if (history) history.push({ step: stepIndex, action: resolved, ok: res.ok, error: res.error });
    // Between actions, a small idle pause helps dynamic forms reveal conditional fields.
    await waitForIdle(ctx.page, 400);
  }
  return { executed, terminal, lastError };
}

/** Common executor loop: snapshot → LLM → actions → repeat. */
export interface ExecutorLoopOpts {
  model: string;
  systemPrompt: string;
  extraUserContext?: (snap: AxSnapshot) => string;
  /** Called once before each LLM call to limit token growth. */
  axLimit?: number;
}

export async function snapshotWithRetry(page: Page, attempts = 3): Promise<AxSnapshot> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await extractAxSnapshot(page);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('snapshot failed');
}

/**
 * Fast local check: is the current snapshot already ready to submit?
 * Mirrors the verifier's scoring but cheaper (no screenshot, no file IO).
 * Approaches call this before every LLM step to short-circuit to `done`.
 */
export function checkReadyToSubmit(snap: AxSnapshot): {
  ready: boolean;
  filled: number;
  total: number;
  missing: string[];
  submitFound: boolean;
  submitEnabled: boolean;
} {
  const required = snap.nodes.filter(
    (n) => n.required && ['textbox', 'combobox', 'checkbox', 'radio', 'file'].includes(n.role)
  );
  let filled = 0;
  const missing: string[] = [];
  for (const n of required) {
    if (n.role === 'checkbox' || n.role === 'radio') {
      const group = snap.nodes.filter(
        (m) => (m.role === 'checkbox' || m.role === 'radio') && (m.label === n.label || m.name === n.name)
      );
      if (group.some((m) => m.checked)) filled += 1;
      else missing.push(n.name || n.label || '(radio group)');
      continue;
    }
    if (n.role === 'file') {
      if (n.value) filled += 1;
      else missing.push(n.name || 'file upload');
      continue;
    }
    if ((n.value && n.value.trim().length > 0) || n.checked) filled += 1;
    else missing.push(n.name || n.label || n.placeholder || '(unnamed)');
  }
  const submit = snap.nodes.find(
    (n) => (n.role === 'button' || n.tag === 'button' || n.type === 'submit') && /submit|apply|send application|finish/i.test(n.name || n.label || '')
  );
  const submitFound = !!submit;
  const submitEnabled = submit ? !submit.disabled : false;
  const ratio = required.length === 0 ? 0 : filled / required.length;
  const ready = required.length > 0 && ratio >= 0.85 && submitFound && submitEnabled && missing.length <= 2;
  return { ready, filled, total: required.length, missing, submitFound, submitEnabled };
}
