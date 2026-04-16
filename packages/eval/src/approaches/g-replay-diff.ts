import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Approach, ApproachCtx, Action } from '../core/types.js';
import { ACTION_DSL_SCHEMA, confirmReadyToSubmit, executeActions, formatActionHistory, profileToYaml, snapshotWithRetry, type ActionHistoryEntry, type DslOutput } from './shared.js';
import { formatAx } from '../core/ax.js';
import { chat } from '../core/llm.js';
import { ENV } from '../env.js';

/**
 * Approach G (novel) — Reflective replay + diff-adapt.
 *
 * First run against a URL pattern: full LLM loop (like B), record trajectory
 * {structuralHash, (ax_signature → action)} per step. Subsequent runs: replay.
 *
 * On replay, per step:
 *   • Compute current AX snapshot.
 *   • If structuralHash matches the recorded one → execute recorded actions
 *     by matching on sig; if all sigs resolve, zero LLM calls.
 *   • If diff ratio < 30% → call a mini LLM (only the changed nodes + prior action)
 *     to re-resolve refs.
 *   • Else → fall back to full executor call for that step only.
 *
 * Cache is disk-persistent per hostname+pathname pattern so user-to-user sharing
 * works trivially in Phase 1.
 */
interface TrajectoryStep {
  structuralHash: string;
  actions: Array<Action & { sig?: string }>;
}

interface Trajectory {
  urlPattern: string;
  createdAt: number;
  steps: TrajectoryStep[];
}

function urlPattern(url: string): string {
  try {
    const u = new URL(url);
    // Remove query params and IDs (hex/uuid) from path.
    const path = u.pathname.replace(/[0-9a-fA-F-]{8,}/g, '*');
    return `${u.host}${path}`;
  } catch {
    return url;
  }
}

function cacheKey(url: string): string {
  return crypto.createHash('sha1').update(urlPattern(url)).digest('hex');
}

async function readCache(cacheDir: string, url: string): Promise<Trajectory | null> {
  try {
    const txt = await fs.readFile(path.join(cacheDir, `${cacheKey(url)}.json`), 'utf8');
    return JSON.parse(txt) as Trajectory;
  } catch {
    return null;
  }
}
async function writeCache(cacheDir: string, traj: Trajectory): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, `${cacheKey(traj.urlPattern)}.json`), JSON.stringify(traj, null, 2));
}

export const approachG: Approach = {
  name: 'g-replay-diff',
  description: 'Novel: Reflective replay with per-step AX-signature diff-adapt; LLM only on mismatch.',
  async run(ctx: ApproachCtx) {
    const profileYaml = profileToYaml(ctx.profile);
    const urlPat = urlPattern(ctx.page.url());
    const cached = await readCache(ctx.cacheDir, ctx.page.url());
    const recorded: TrajectoryStep[] = [];

    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    let stagnation = 0;
    let lastHash = '';
    const history: ActionHistoryEntry[] = [];

    while (steps < ctx.maxSteps) {
      steps += 1;
      const snap = await snapshotWithRetry(ctx.page);
      if (snap.behaviorHash === lastHash) stagnation++; else stagnation = 0;
      lastHash = snap.behaviorHash;
      if (stagnation >= 3) break;

      const readyCheck = await confirmReadyToSubmit(ctx.page, snap);
      if (readyCheck.ready) {
        readyToSubmit = true;
        ctx.logStep({ step: steps, approach: ctx.approach, tsMs: Date.now(), durationMs: 0, url: ctx.page.url(), actionExecuted: { kind: 'done', status: 'ready_to_submit', reason: 'local ready-check' }, executed: true, error: null, llmUsage: [], notes: `${readyCheck.filled}/${readyCheck.total}` });
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }

      // Try replay first
      const prior = cached?.steps[steps - 1];
      let actions: Action[] | null = null;
      if (prior && prior.structuralHash === snap.structuralHash) {
        // All sigs resolvable?
        const resolved: Action[] = [];
        let allResolved = true;
        for (const a of prior.actions) {
          if (!a.sig) { resolved.push(a); continue; }
          const match = snap.nodes.find((n) => n.sig === a.sig);
          if (!match) { allResolved = false; break; }
          resolved.push({ ...a, ref: match.ref });
        }
        if (allResolved) actions = resolved;
      }

      // Mini-adapt: snap close to prior page but some sigs drifted — ask cheap model to re-resolve.
      if (!actions && prior) {
        // Describe what's different.
        const priorSigs = new Set(prior.actions.map((a) => a.sig).filter(Boolean));
        const newNodes = snap.nodes.filter((n) => priorSigs.size > 0 && !Array.from(priorSigs).includes(n.sig));
        if (newNodes.length < snap.nodes.length * 0.3) {
          const out = await chat<DslOutput>({
            model: ENV.EXECUTOR_MODEL,
            messages: [
              { role: 'system', content: 'Re-resolve stale refs for these cached actions on the current snapshot. Return new action list. Keep kind/value/reason; update ref to the right one.' },
              { role: 'user', content: [`PRIOR ACTIONS: ${JSON.stringify(prior.actions)}`, '', 'CURRENT SNAPSHOT:', formatAx(snap, 120)].join('\n') },
            ],
            jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
            maxTokens: 500,
          }).catch(() => null);
          if (out) { ctx.logLlm(out.usage); if (out.json) actions = out.json.actions; }
        }
      }

      if (!actions) {
        const out = await chat<DslOutput>({
          model: ENV.EXECUTOR_MODEL,
          messages: [
            { role: 'system', content: 'Form-filling agent. Use numeric refs. Skip FILLED fields. Uploads use value:"resume". Emit done when form filled + submit visible; never submit.' },
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
                formatAx(snap, 140),
              ].join('\n'),
            },
          ],
          jsonSchema: { name: 'AgentStep', schema: ACTION_DSL_SCHEMA, strict: true },
          maxTokens: 700,
        }).catch(() => null);
        if (!out) return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
        ctx.logLlm(out.usage);
        if (!out.json) continue;
        actions = out.json.actions;
      }

      // Record (for cache write at end) with sigs resolved from current snap.
      const recActions: Array<Action & { sig?: string }> = actions.map((a) => {
        if (a.ref) {
          const n = snap.nodes.find((x) => x.ref === a.ref);
          return { ...a, sig: n?.sig };
        }
        return a;
      });
      recorded.push({ structuralHash: snap.structuralHash, actions: recActions });

      const res = await executeActions(ctx, snap, actions, steps, history);
      executed += res.executed;
      if (res.terminal === 'done') {
        readyToSubmit = true;
        await writeCache(ctx.cacheDir, { urlPattern: urlPat, createdAt: Date.now(), steps: recorded }).catch(() => {});
        return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
      }
      if (res.terminal === 'abort') return { finalStatus: 'aborted', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
    }
    await writeCache(ctx.cacheDir, { urlPattern: urlPat, createdAt: Date.now(), steps: recorded }).catch(() => {});
    return { finalStatus: readyToSubmit ? 'done' : 'budget_exceeded', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
