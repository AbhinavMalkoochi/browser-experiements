import type { Page } from 'playwright';
import { z } from 'zod';
import type { Action, ApproachCtx, TestProfile } from '../core/types.js';
import { extractAxSnapshot, formatAx, type AxSnapshot } from '../core/ax.js';
import { Actuator } from '../core/actuator.js';
import { chat } from '../core/llm.js';
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
      maxItems: 3,
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
          ref: { type: 'string' },
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

export async function executeActions(
  ctx: ApproachCtx,
  snap: AxSnapshot,
  actions: Action[],
  stepIndex: number
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
