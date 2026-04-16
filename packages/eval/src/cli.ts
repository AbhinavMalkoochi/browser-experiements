#!/usr/bin/env -S tsx
import './env.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { APPROACHES, listApproaches } from './approaches/index.js';
import { TASKS, taskById } from './core/tasks.js';
import { TEST_PROFILE } from './core/profile.js';
import { runOne } from './core/runner.js';
import { writeReport, summarize } from './core/reporter.js';
import { ENV } from './env.js';
import type { RunResult } from './core/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_ROOT = path.resolve(__dirname, '../results');

type CliArgs = Record<string, string | boolean | string[]>;

function parseArgs(argv: string[]): { cmd: string; args: CliArgs } {
  const [cmd, ...rest] = argv;
  const args: CliArgs = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const nxt = rest[i + 1];
      if (nxt === undefined || nxt.startsWith('--')) {
        args[key] = true;
      } else {
        if (args[key] !== undefined) {
          args[key] = (Array.isArray(args[key]) ? (args[key] as string[]) : [args[key] as string]).concat([nxt]);
        } else {
          args[key] = nxt;
        }
        i++;
      }
    }
  }
  return { cmd: cmd ?? 'help', args };
}

function pickApproaches(args: CliArgs): typeof APPROACHES[string][] {
  const raw = args.approach ?? args.approaches ?? args.a ?? null;
  if (args.all || raw === 'all' || raw === true || raw === null) return listApproaches();
  const keys = Array.isArray(raw) ? raw : String(raw).split(',');
  return keys
    .map((k) => APPROACHES[k.trim().toLowerCase()])
    .filter((x): x is (typeof APPROACHES)[string] => Boolean(x));
}

function pickTasks(args: CliArgs) {
  const raw = args.task ?? args.tasks ?? args.t ?? null;
  if (args.all || raw === 'all' || raw === true || raw === null) return TASKS;
  const keys = Array.isArray(raw) ? raw : String(raw).split(',');
  return keys.map((k) => taskById(k.trim())).filter((x): x is NonNullable<ReturnType<typeof taskById>> => Boolean(x));
}

async function cmdRun(args: CliArgs) {
  const approaches = pickApproaches(args);
  const tasks = pickTasks(args);
  const seeds = Number(args.seeds ?? 1);
  const concurrency = Number(args.concurrency ?? ENV.CONCURRENCY);

  if (approaches.length === 0) throw new Error(`No approaches matched. Available: ${Object.keys(APPROACHES).join(', ')}`);
  if (tasks.length === 0) throw new Error('No tasks matched.');

  await fs.mkdir(RESULTS_ROOT, { recursive: true });
  console.log(`Running ${approaches.length} approaches × ${tasks.length} tasks × ${seeds} seeds (concurrency=${concurrency})`);

  const queue: Array<{ approach: (typeof APPROACHES)[string]; task: (typeof TASKS)[number]; seed: number }> = [];
  for (const a of approaches) for (const t of tasks) for (let s = 0; s < seeds; s++) queue.push({ approach: a, task: t, seed: s });

  const allResults: RunResult[] = [];
  let done = 0;
  const errors: string[] = [];

  async function worker(id: number) {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) return;
      const started = Date.now();
      console.log(`[w${id}] START ${job.approach.name} / ${job.task.id} / seed=${job.seed}`);
      try {
        const r = await runOne({
          approach: job.approach,
          task: job.task,
          profile: TEST_PROFILE,
          seed: job.seed,
          resultsRoot: RESULTS_ROOT,
        });
        allResults.push(r);
        done++;
        const mark = r.success ? '✓' : r.readyToSubmit ? '≈' : '✗';
        console.log(
          `[w${id}]   ${mark} ${job.approach.name} / ${job.task.id} ` +
          `status=${r.finalStatus} success=${r.success} ready=${r.readyToSubmit} ` +
          `cost=$${r.totalCostUsd.toFixed(4)} dur=${(r.durationMs / 1000).toFixed(1)}s ` +
          `steps=${r.stepsTaken} llm=${r.totalLlmCalls} fail=${r.failureMode ?? '-'} ` +
          `(${done}/${approaches.length * tasks.length * seeds})`
        );
      } catch (e) {
        const msg = `[w${id}] CRASH ${job.approach.name}/${job.task.id}: ${(e as Error).stack ?? (e as Error).message}`;
        console.error(msg);
        errors.push(msg);
      }
      // Tiny pause between runs to avoid hammering same hosts.
      await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
      void started;
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, i) => worker(i + 1)));

  const reportPath = await writeReport(RESULTS_ROOT, allResults);
  const summary = summarize(allResults);
  console.log('\n=== SUMMARY ===');
  for (const r of summary.byApproach) {
    console.log(
      `${r.approach.padEnd(24)}  success=${(r.successRate * 100).toFixed(0)}%  ready=${(r.readyRate * 100).toFixed(0)}%  ` +
      `avgCost=$${r.avgCostUsd.toFixed(4)}  avgDur=${(r.avgDurationMs / 1000).toFixed(1)}s  ` +
      `avgLLM=${r.avgLlmCalls.toFixed(1)}  failures=${JSON.stringify(r.failureModes)}`
    );
  }
  console.log(`\nTotal cost: $${summary.totalCostUsd.toFixed(4)}`);
  console.log(`HTML report: ${reportPath}`);
  if (errors.length) console.log(`${errors.length} runs crashed. See logs.`);
}

async function cmdReport() {
  // Aggregate any result.json files under RESULTS_ROOT into a report.
  const all: RunResult[] = [];
  async function walk(d: string) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && e.name === 'result.json') {
        try {
          const r = JSON.parse(await fs.readFile(p, 'utf8'));
          all.push(r);
        } catch {/* ignore */}
      }
    }
  }
  await walk(RESULTS_ROOT);
  const reportPath = await writeReport(RESULTS_ROOT, all);
  console.log(`Wrote ${reportPath} with ${all.length} results.`);
}

function cmdList() {
  console.log('Approaches:');
  for (const a of listApproaches()) console.log(`  ${a.name.padEnd(28)} ${a.description}`);
  console.log('\nTasks:');
  for (const t of TASKS) console.log(`  ${t.id.padEnd(24)} ${t.ats.padEnd(16)} ${t.difficulty.padEnd(6)} ${t.url}`);
}

async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  if (cmd === 'run') await cmdRun(args);
  else if (cmd === 'report') await cmdReport();
  else if (cmd === 'list') cmdList();
  else {
    console.log('Usage:');
    console.log('  pnpm eval list');
    console.log('  pnpm eval run --approach a[,b,...] --task id1[,id2] [--all] [--seeds N] [--concurrency N]');
    console.log('  pnpm eval report');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
