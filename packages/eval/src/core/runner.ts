import fs from 'node:fs/promises';
import path from 'node:path';
import { openSession, dismissOverlays } from './browser.js';
import { verify } from './verifier.js';
import { createRunLog } from './run-log.js';
import type { Approach, ApproachCtx, EvalTask, LlmUsage, RunResult, StepRecord, TestProfile } from './types.js';
import { ENV } from '../env.js';

export interface RunOptions {
  approach: Approach;
  task: EvalTask;
  profile: TestProfile;
  seed: number;
  resultsRoot: string;
  maxSteps?: number;
  /** When true, mirror `run.log` lines to stdout (overrides ENV.EVAL_VERBOSE). */
  verbose?: boolean;
}

export async function runOne(opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const artifactDir = path.join(opts.resultsRoot, opts.approach.name, opts.task.id, `seed-${opts.seed}`);
  const cacheDir = path.join(opts.resultsRoot, opts.approach.name, '_cache');
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const stepsPath = path.join(artifactDir, 'steps.jsonl');
  const llmPath = path.join(artifactDir, 'llm.jsonl');
  const mirror = opts.verbose === true || ENV.EVAL_VERBOSE;
  const logPrefix = `${opts.approach.name}/${opts.task.id}/s${opts.seed}`;
  const runLog = createRunLog(artifactDir, logPrefix, mirror);
  await fs.writeFile(path.join(artifactDir, 'run.log'), '').catch(() => {});

  const steps: StepRecord[] = [];
  const llmCalls: LlmUsage[] = [];

  const logStep = (r: StepRecord) => {
    steps.push(r);
    void fs.appendFile(stepsPath, JSON.stringify(r) + '\n').catch(() => {});
    runLog.info('step', {
      step: r.step,
      url: r.url,
      kind: r.actionExecuted?.kind ?? null,
      executed: r.executed,
      err: r.error ? String(r.error).slice(0, 200) : null,
    });
  };
  const logLlm = (u: LlmUsage) => {
    llmCalls.push(u);
    void fs.appendFile(llmPath, JSON.stringify(u) + '\n').catch(() => {});
    runLog.info('llm', { model: u.model, in: u.inputTokens, out: u.outputTokens, usd: u.costUsd });
  };

  const session = await openSession();
  let finalStatus: RunResult['finalStatus'] = 'done';
  let err: string | null = null;
  let stepsTaken = 0;
  let actionsExecuted = 0;
  let readyToSubmit = false;

  const abortCtl = new AbortController();
  try {
    runLog.info('goto', { url: opts.task.url });
    await session.page.goto(opts.task.url, { waitUntil: 'domcontentloaded' }).catch(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      await session.page.goto(opts.task.url, { waitUntil: 'domcontentloaded' });
    });
    await session.page.waitForTimeout(1500);
    const dismissed = await dismissOverlays(session.page).catch(() => 0);
    runLog.info('post_goto', { url: session.page.url(), overlaysDismissed: dismissed });

    const ctx: ApproachCtx = {
      page: session.page,
      task: opts.task,
      profile: opts.profile,
      approach: opts.approach.name,
      taskId: opts.task.id,
      seed: opts.seed,
      artifactDir,
      logStep,
      logLlm,
      maxSteps: opts.maxSteps ?? ENV.MAX_STEPS,
      cacheDir,
      abortSignal: abortCtl.signal,
      runLog,
    };

    const taskTimeout = new Promise<'__timeout__'>((resolve) =>
      setTimeout(() => resolve('__timeout__'), ENV.TASK_TIMEOUT_MS)
    );
    const run = opts.approach.run(ctx);
    const outcome = await Promise.race([run, taskTimeout]);
    if (outcome === '__timeout__') {
      abortCtl.abort();
      finalStatus = 'timeout';
      runLog.warn('harness_timeout', { ms: ENV.TASK_TIMEOUT_MS });
      await new Promise((r) => setTimeout(r, 400));
    } else {
      finalStatus = outcome.finalStatus;
      stepsTaken = outcome.stepsTaken;
      actionsExecuted = outcome.actionsExecuted;
      readyToSubmit = outcome.readyToSubmit;
      runLog.info('approach_finished', { finalStatus, stepsTaken, actionsExecuted, readyToSubmit });
    }
  } catch (e) {
    finalStatus = 'crashed';
    err = (e as Error).message;
    runLog.error('runner_catch', { message: err });
  }

  // Verification — always do this even on crash. Brief settle so late-loading
  // fields / transitions finish before we count required fields.
  try {
    await session.page.waitForLoadState('networkidle', { timeout: 4000 });
  } catch {/* ignore */}
  runLog.info('verify_begin', { url: session.page.url() });
  let verifier;
  try {
    verifier = await verify(session.page, opts.task, artifactDir);
  } catch (e) {
    verifier = {
      success: false,
      readyToSubmit: false,
      requiredFieldsFilled: 0,
      requiredFieldsTotal: 0,
      missing: [],
      submitButtonFound: false,
      submitButtonEnabled: false,
      evidence: `verifier crashed: ${(e as Error).message}`,
      classification: 'error' as const,
      screenshotPath: null,
    };
  }

  const finalUrl = session.page.url();
  await session.close();

  const finishedAt = Date.now();
  const totalInputTokens = llmCalls.reduce((s, c) => s + c.inputTokens, 0);
  const totalOutputTokens = llmCalls.reduce((s, c) => s + c.outputTokens, 0);
  const totalCostUsd = llmCalls.reduce((s, c) => s + (c.costUsd ?? 0), 0);

  runLog.info('verify_done', {
    success: verifier.success,
    classification: verifier.classification,
    filled: `${verifier.requiredFieldsFilled}/${verifier.requiredFieldsTotal}`,
    evidence: verifier.evidence.slice(0, 200),
  });

  const result: RunResult = {
    approach: opts.approach.name,
    description: opts.approach.description,
    taskId: opts.task.id,
    seed: opts.seed,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    stepsTaken,
    actionsExecuted,
    totalLlmCalls: llmCalls.length,
    totalInputTokens,
    totalOutputTokens,
    totalCostUsd,
    finalUrl,
    finalStatus,
    success: verifier.success,
    readyToSubmit: readyToSubmit || verifier.readyToSubmit,
    verifier,
    failureMode: verifier.success ? null : failureModeOf(verifier.classification, finalStatus),
    error: err,
    artifactDir,
    experiment: opts.approach.experiment,
  };
  await fs.writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

function failureModeOf(cls: string, finalStatus: string): string {
  if (finalStatus === 'timeout') return 'timeout';
  if (finalStatus === 'aborted') return 'aborted';
  if (finalStatus === 'crashed') return 'crash';
  if (finalStatus === 'budget_exceeded') return 'budget_exceeded';
  if (cls === 'captcha') return 'captcha';
  if (cls === 'blocked') return 'blocked';
  if (cls === 'form_not_loaded') return 'form_not_loaded';
  if (cls === 'partial_filled') return 'partial_filled';
  if (cls === 'wrong_page') return 'wrong_page';
  return 'other';
}
