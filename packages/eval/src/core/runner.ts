import fs from 'node:fs/promises';
import path from 'node:path';
import { openSession } from './browser.js';
import { verify } from './verifier.js';
import type { Approach, ApproachCtx, EvalTask, LlmUsage, RunResult, StepRecord, TestProfile } from './types.js';
import { ENV } from '../env.js';

export interface RunOptions {
  approach: Approach;
  task: EvalTask;
  profile: TestProfile;
  seed: number;
  resultsRoot: string;
  maxSteps?: number;
}

export async function runOne(opts: RunOptions): Promise<RunResult> {
  const startedAt = Date.now();
  const artifactDir = path.join(opts.resultsRoot, opts.approach.name, opts.task.id, `seed-${opts.seed}`);
  const cacheDir = path.join(opts.resultsRoot, opts.approach.name, '_cache');
  await fs.mkdir(artifactDir, { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });

  const stepsPath = path.join(artifactDir, 'steps.jsonl');
  const llmPath = path.join(artifactDir, 'llm.jsonl');

  const steps: StepRecord[] = [];
  const llmCalls: LlmUsage[] = [];

  const logStep = (r: StepRecord) => {
    steps.push(r);
    void fs.appendFile(stepsPath, JSON.stringify(r) + '\n').catch(() => {});
  };
  const logLlm = (u: LlmUsage) => {
    llmCalls.push(u);
    void fs.appendFile(llmPath, JSON.stringify(u) + '\n').catch(() => {});
  };

  const session = await openSession();
  let finalStatus: RunResult['finalStatus'] = 'done';
  let err: string | null = null;
  let stepsTaken = 0;
  let actionsExecuted = 0;
  let readyToSubmit = false;

  try {
    await session.page.goto(opts.task.url, { waitUntil: 'domcontentloaded' }).catch(async () => {
      // some sites block the first go; give it another shot after a brief pause
      await new Promise((r) => setTimeout(r, 1500));
      await session.page.goto(opts.task.url, { waitUntil: 'domcontentloaded' });
    });
    await session.page.waitForTimeout(1500);

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
    };

    const taskTimeout = new Promise<'__timeout__'>((resolve) =>
      setTimeout(() => resolve('__timeout__'), ENV.TASK_TIMEOUT_MS)
    );
    const run = opts.approach.run(ctx);
    const outcome = await Promise.race([run, taskTimeout]);
    if (outcome === '__timeout__') {
      finalStatus = 'timeout';
    } else {
      finalStatus = outcome.finalStatus;
      stepsTaken = outcome.stepsTaken;
      actionsExecuted = outcome.actionsExecuted;
      readyToSubmit = outcome.readyToSubmit;
    }
  } catch (e) {
    finalStatus = 'crashed';
    err = (e as Error).message;
  }

  // Verification — always do this even on crash.
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

  const result: RunResult = {
    approach: opts.approach.name,
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
  };
  await fs.writeFile(path.join(artifactDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

function failureModeOf(cls: string, finalStatus: string): string {
  if (finalStatus === 'timeout') return 'timeout';
  if (finalStatus === 'crashed') return 'crash';
  if (finalStatus === 'budget_exceeded') return 'budget_exceeded';
  if (cls === 'captcha') return 'captcha';
  if (cls === 'blocked') return 'blocked';
  if (cls === 'form_not_loaded') return 'form_not_loaded';
  if (cls === 'partial_filled') return 'partial_filled';
  if (cls === 'wrong_page') return 'wrong_page';
  return 'other';
}
