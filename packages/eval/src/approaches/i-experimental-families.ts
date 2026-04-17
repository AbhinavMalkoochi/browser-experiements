import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Approach, ApproachCtx, Action, ExperimentConfig, ObservationMode } from '../core/types.js';
import { buildProgressHint, checkReadyToSubmit, confirmReadyToSubmit, executeActions, formatActionHistory, isRunCancelled, profileToYaml, snapshotWithRetry, type ActionHistoryEntry, type DslOutput, ACTION_DSL_SCHEMA } from './shared.js';
import { buildObservationBundle } from '../core/observation.js';
import { chat, type ChatMessage } from '../core/llm.js';
import { ENV } from '../env.js';
import { diffSnapshots, type AxSnapshot } from '../core/ax.js';
import type { CanonicalObservation } from '../core/canonical.js';

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    plan: { type: 'array', items: { type: 'string' } },
    checkpoints: { type: 'array', items: { type: 'string' } },
  },
  required: ['plan', 'checkpoints'],
} as const;

const FIELD_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    page_kind: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ref: { type: 'string' },
          kind: { type: 'string', enum: ['fill', 'select', 'check', 'upload', 'click'] },
          value: { type: ['string', 'null'] },
          reason: { type: 'string' },
        },
        required: ['ref', 'kind', 'value', 'reason'],
      },
    },
    terminal: { type: 'string', enum: ['continue', 'ready_to_submit', 'blocked'] },
  },
  required: ['page_kind', 'actions', 'terminal'],
} as const;

interface TrajectoryStep {
  structuralHash: string;
  actions: Array<Action & { sig?: string }>;
}

interface Trajectory {
  steps: TrajectoryStep[];
}

function hashKey(parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex');
}

async function readReplay(cacheDir: string, key: string): Promise<Trajectory | null> {
  try {
    const txt = await fs.readFile(path.join(cacheDir, `${key}.json`), 'utf8');
    return JSON.parse(txt) as Trajectory;
  } catch {
    return null;
  }
}

async function writeReplay(cacheDir: string, key: string, trajectory: Trajectory): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${key}.json`), JSON.stringify(trajectory, null, 2));
}

function experimentalSystem(family: string, mode: ObservationMode): string {
  return [
    `You are a browser-task execution policy for a reliability benchmark.`,
    `Family: ${family}. Observation mode: ${mode}.`,
    `Use numeric refs only for interactive actions.`,
    `Prefer precise typed actions over narration.`,
    `Do not submit forms unless the harness has explicitly decided it is safe.`,
    `Do not brute-force random clicks. If uncertain, act conservatively and use the strongest grounded target.`,
  ].join(' ');
}

async function proposeFieldActions(
  ctx: ApproachCtx,
  promptBits: string[],
  observationMessages: ChatMessage[],
  canonical: CanonicalObservation
): Promise<{ actions: Action[]; terminal: 'continue' | 'ready_to_submit' | 'blocked' } | null> {
  const out = await chat<{ page_kind: string; actions: Array<{ ref: string; kind: 'fill' | 'select' | 'check' | 'upload' | 'click'; value: string | null; reason: string }>; terminal: 'continue' | 'ready_to_submit' | 'blocked' }>({
    model: ENV.EXECUTOR_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You map a structured page observation to the smallest complete set of form actions needed next. Use refs from the observation. Skip already filled fields. Prioritize required missing fields first. Emit at most 10 actions. For uploads use value:"resume".',
      },
      { role: 'user', content: promptBits.join('\n') },
      ...observationMessages,
    ],
    jsonSchema: { name: 'FieldPlan', schema: FIELD_PLAN_SCHEMA, strict: true },
    maxTokens: 900,
  }).catch(() => null);
  if (!out?.json) return null;
  ctx.logLlm(out.usage);
  return {
    terminal: out.json.terminal,
    actions: out.json.actions.map((a) => normalizeFieldAction(a, canonical)),
  };
}

function normalizeFieldAction(
  action: { ref: string; kind: 'fill' | 'select' | 'check' | 'upload' | 'click'; value: string | null; reason: string },
  canonical: CanonicalObservation
): Action {
  const cleanRef = String(action.ref).replace(/^\[|\]$/g, '').trim();
  const field = canonical.fields.find((f) => f.ref === cleanRef);
  const actionTarget = canonical.actions.find((a) => a.ref === cleanRef);
  let kind: Action['kind'] = action.kind;
  if (field) {
    if (field.kind === 'text' && action.kind === 'select') kind = 'fill';
    if (field.kind === 'select' && action.kind === 'fill') kind = 'select';
    if ((field.kind === 'radio' || field.kind === 'check') && action.kind === 'select') kind = 'check';
    if (field.kind === 'upload') kind = 'upload';
  } else if (actionTarget) {
    kind = actionTarget.kind === 'submit' || actionTarget.kind === 'navigation' || actionTarget.kind === 'button' || actionTarget.kind === 'link'
      ? 'click'
      : action.kind;
  }
  return { kind, ref: cleanRef, value: action.value ?? undefined, reason: action.reason };
}

function createExperimentalApproach(
  name: string,
  description: string,
  experiment: ExperimentConfig
): Approach {
  return {
    name,
    description,
    experiment,
    async run(ctx: ApproachCtx) {
      const profileYaml = profileToYaml(ctx.profile);
      let steps = 0;
      let executed = 0;
      let readyToSubmit = false;
      let lastSnap: AxSnapshot | null = null;
      let noProgress = 0;
      let planText = '';
      const history: ActionHistoryEntry[] = [];
      const recorded: TrajectoryStep[] = [];
      const replayKey = hashKey([ctx.task.ats, ctx.task.id, experiment.family, experiment.observationMode]);
      const replay = experiment.recoveryMode === 'replay_diff' ? await readReplay(ctx.cacheDir, replayKey) : null;

      while (steps < ctx.maxSteps) {
        if (isRunCancelled(ctx)) return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
        steps += 1;
        const snap = await snapshotWithRetry(ctx.page);
        const readyCheck = await confirmReadyToSubmit(ctx.page, snap);
        if (readyCheck.ready) {
          readyToSubmit = true;
          return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
        }

        const observationMode =
          experiment.recoveryMode === 'selective_vision' && noProgress >= 1 && experiment.observationMode !== 'hybrid'
            ? 'hybrid'
            : experiment.observationMode;
        const obs = await buildObservationBundle(ctx.page, snap, ctx.task.ats, observationMode, {
          includeVision: experiment.recoveryMode === 'selective_vision' && noProgress >= 1,
          canonicalLimit: 45,
          axLimit: 140,
        });

        if (!planText && experiment.plannerMode === 'planner_executor') {
          const plan = await chat<{ plan: string[]; checkpoints: string[] }>({
            model: ENV.PLANNER_MODEL,
            messages: [
              { role: 'system', content: 'Plan a short reliable browser workflow for the current task. Focus on the minimal next subgoals and stopping conditions.' },
              { role: 'user', content: `GOAL: ${ctx.task.goal}\n\nPROFILE:\n${profileYaml}\n\nOBSERVATION:\n${obs.textSummary}` },
            ],
            jsonSchema: { name: 'Plan', schema: PLAN_SCHEMA, strict: true },
            maxTokens: 700,
          }).catch(() => null);
          if (plan?.json) {
            ctx.logLlm(plan.usage);
            planText = `PLAN:\n${plan.json.plan.map((p, i) => `${i + 1}. ${p}`).join('\n')}\nCHECKPOINTS:\n${plan.json.checkpoints.join('\n')}`;
          }
        }

        let actions: Action[] | null = null;
        let declaredTerminal: 'continue' | 'ready_to_submit' | 'blocked' = 'continue';

        if (replay?.steps[steps - 1] && replay.steps[steps - 1]!.structuralHash === snap.structuralHash) {
          const step = replay.steps[steps - 1]!;
          const resolved = step.actions.map((a) => {
            if (!a.sig) return a;
            const match = snap.nodes.find((n) => n.sig === a.sig);
            return match ? { ...a, ref: match.ref } : a;
          });
          if (resolved.every((a) => !a.sig || Boolean(a.ref))) {
            actions = resolved.map(({ sig: _sig, ...rest }) => rest);
          }
        }

        if (!actions && experiment.plannerMode === 'field_state') {
          const fieldPlan = await proposeFieldActions(
            ctx,
            [
              `GOAL: ${ctx.task.goal}`,
              '',
              buildProgressHint(snap, readyCheck),
              '',
              'PROFILE:',
              profileYaml,
              '',
              formatActionHistory(history),
            ],
            obs.promptMessages,
            obs.canonical
          );
          if (fieldPlan) {
            actions = fieldPlan.actions;
            declaredTerminal = fieldPlan.terminal;
          }
        }

        if (!actions) {
          const out = await chat<DslOutput>({
            model: ENV.EXECUTOR_MODEL,
            messages: [
              { role: 'system', content: experimentalSystem(experiment.family, observationMode) },
              {
                role: 'user',
                content: [
                  `GOAL: ${ctx.task.goal}`,
                  '',
                  planText,
                  '',
                  buildProgressHint(snap, readyCheck),
                  '',
                  'PROFILE:',
                  profileYaml,
                  '',
                  formatActionHistory(history),
                  '',
                  'Respond with 1-3 typed actions. Use `done` only when the form is genuinely ready for submit.',
                ].join('\n'),
              },
              ...obs.promptMessages,
            ],
            jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
            maxTokens: 800,
          }).catch(() => null);
          if (!out) return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
          ctx.logLlm(out.usage);
          if (!out.json) continue;
          actions = out.json.actions;
        }

        if (declaredTerminal === 'blocked') {
          return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit, note: 'model blocked' };
        }

        recorded.push({
          structuralHash: snap.structuralHash,
          actions: actions.map((a) => {
            const node = a.ref ? snap.nodes.find((n) => n.ref === a.ref) : null;
            return node ? { ...a, sig: node.sig } : a;
          }),
        });

        const result = await executeActions(ctx, snap, actions, steps, history);
        executed += result.executed;
        if (result.terminal === 'done' || declaredTerminal === 'ready_to_submit') {
          readyToSubmit = true;
          if (experiment.recoveryMode === 'replay_diff') {
            await writeReplay(ctx.cacheDir, replayKey, { steps: recorded }).catch(() => {});
          }
          return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
        }
        if (result.terminal === 'abort') return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };

        const afterSnap = await snapshotWithRetry(ctx.page);
        const change = lastSnap ? diffSnapshots(lastSnap, afterSnap).changeRatio : 1;
        const localReady = checkReadyToSubmit(afterSnap);
        if (localReady.ready) {
          readyToSubmit = true;
          if (experiment.recoveryMode === 'replay_diff') {
            await writeReplay(ctx.cacheDir, replayKey, { steps: recorded }).catch(() => {});
          }
          return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
        }
        if (result.executed > 0 || change >= 0.02) noProgress = 0;
        else noProgress += 1;
        lastSnap = afterSnap;
        if (noProgress >= 3) break;
      }

      if (experiment.recoveryMode === 'replay_diff') {
        await writeReplay(ctx.cacheDir, replayKey, { steps: recorded }).catch(() => {});
      }
      return { finalStatus: readyToSubmit ? 'done' : 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
    },
  };
}

export const approachI = createExperimentalApproach(
  'i-raw-ax-dsl',
  'Phase 1 family A baseline: raw AX observation + typed DSL executor.',
  { family: 'family_a_raw_baseline', observationMode: 'raw_ax', plannerMode: 'single_loop', recoveryMode: 'none' }
);

export const approachJ = createExperimentalApproach(
  'j-canonical-dsl',
  'Phase 1 family A: canonical observation + typed DSL executor.',
  { family: 'family_a_canonical', observationMode: 'canonical', plannerMode: 'single_loop', recoveryMode: 'local_verify' }
);

export const approachK = createExperimentalApproach(
  'k-canonical-state',
  'Phase 1 family B: canonical observation + field-state action compiler.',
  { family: 'family_b_field_state', observationMode: 'canonical', plannerMode: 'field_state', recoveryMode: 'local_verify' }
);

export const approachL = createExperimentalApproach(
  'l-hybrid-vision',
  'Phase 1 family C: canonical observation with selective vision fallback.',
  { family: 'family_c_hybrid', observationMode: 'canonical', plannerMode: 'single_loop', recoveryMode: 'selective_vision' }
);

export const approachM = createExperimentalApproach(
  'm-planner-executor',
  'Phase 1 family E: planner/executor split over canonical observation.',
  { family: 'family_e_planner_executor', observationMode: 'canonical', plannerMode: 'planner_executor', recoveryMode: 'local_verify' }
);

export const approachN = createExperimentalApproach(
  'n-replay-canonical',
  'Phase 1 family D: canonical observation + replay/diff reuse.',
  { family: 'family_d_replay', observationMode: 'canonical', plannerMode: 'single_loop', recoveryMode: 'replay_diff' }
);
