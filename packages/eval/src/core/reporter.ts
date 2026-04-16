import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunResult } from './types.js';

export interface SummaryTableRow {
  approach: string;
  runs: number;
  successRate: number;
  readyRate: number;
  avgDurationMs: number;
  medianDurationMs: number;
  p95DurationMs: number;
  avgCostUsd: number;
  avgLlmCalls: number;
  avgSteps: number;
  avgActionsExecuted: number;
  failureModes: Record<string, number>;
}

function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[i]!;
}

export function summarize(results: RunResult[]): {
  byApproach: SummaryTableRow[];
  byTask: Record<string, Record<string, { success: boolean; cost: number; duration: number; failureMode: string | null; readyToSubmit: boolean }>>;
  totalCostUsd: number;
} {
  const grouped = new Map<string, RunResult[]>();
  for (const r of results) {
    const arr = grouped.get(r.approach) ?? [];
    arr.push(r);
    grouped.set(r.approach, arr);
  }
  const byApproach: SummaryTableRow[] = [];
  for (const [approach, arr] of grouped) {
    const runs = arr.length;
    const success = arr.filter((r) => r.success).length;
    const ready = arr.filter((r) => r.readyToSubmit).length;
    const durations = arr.map((r) => r.durationMs);
    const avgDurationMs = durations.reduce((s, d) => s + d, 0) / Math.max(1, runs);
    const medianDurationMs = quantile(durations, 0.5);
    const p95DurationMs = quantile(durations, 0.95);
    const avgCostUsd = arr.reduce((s, r) => s + r.totalCostUsd, 0) / Math.max(1, runs);
    const avgLlmCalls = arr.reduce((s, r) => s + r.totalLlmCalls, 0) / Math.max(1, runs);
    const avgSteps = arr.reduce((s, r) => s + r.stepsTaken, 0) / Math.max(1, runs);
    const avgActionsExecuted = arr.reduce((s, r) => s + r.actionsExecuted, 0) / Math.max(1, runs);
    const failureModes: Record<string, number> = {};
    for (const r of arr) {
      if (!r.success) {
        const k = r.failureMode ?? 'other';
        failureModes[k] = (failureModes[k] ?? 0) + 1;
      }
    }
    byApproach.push({
      approach,
      runs,
      successRate: success / Math.max(1, runs),
      readyRate: ready / Math.max(1, runs),
      avgDurationMs,
      medianDurationMs,
      p95DurationMs,
      avgCostUsd,
      avgLlmCalls,
      avgSteps,
      avgActionsExecuted,
      failureModes,
    });
  }
  byApproach.sort((a, b) => b.readyRate - a.readyRate || b.successRate - a.successRate || a.avgCostUsd - b.avgCostUsd);

  const byTask: Record<string, Record<string, { success: boolean; cost: number; duration: number; failureMode: string | null; readyToSubmit: boolean }>> = {};
  for (const r of results) {
    if (!byTask[r.taskId]) byTask[r.taskId] = {};
    byTask[r.taskId]![r.approach] = {
      success: r.success,
      cost: r.totalCostUsd,
      duration: r.durationMs,
      failureMode: r.failureMode,
      readyToSubmit: r.readyToSubmit,
    };
  }
  const totalCostUsd = results.reduce((s, r) => s + r.totalCostUsd, 0);

  return { byApproach, byTask, totalCostUsd };
}

export async function writeReport(resultsRoot: string, results: RunResult[]): Promise<string> {
  const summary = summarize(results);
  const jsonPath = path.join(resultsRoot, 'summary.json');
  await fs.writeFile(jsonPath, JSON.stringify({ results, summary }, null, 2));

  const tasks = Array.from(new Set(results.map((r) => r.taskId))).sort();
  const approaches = summary.byApproach.map((b) => b.approach);

  const heatmap = approaches.map((a) => {
    const row = tasks.map((t) => {
      const rs = results.filter((r) => r.approach === a && r.taskId === t);
      if (rs.length === 0) return { cell: '-', color: '#eee', title: 'no run' };
      const succ = rs.filter((r) => r.success).length;
      const ready = rs.filter((r) => r.readyToSubmit).length;
      const fr = rs[0]!;
      const status = fr.success ? 'success' : fr.readyToSubmit ? 'ready' : (fr.failureMode ?? 'fail');
      const color = fr.success ? '#16a34a' : fr.readyToSubmit ? '#65a30d' : '#ef4444';
      return {
        cell: `${succ}/${rs.length} · ${ready}/${rs.length}r`,
        color,
        title: `status=${status}\ncost=$${fr.totalCostUsd.toFixed(4)}\nduration=${(fr.durationMs / 1000).toFixed(1)}s\nsteps=${fr.stepsTaken}\nllm=${fr.totalLlmCalls}\nevidence=${fr.verifier.evidence}`,
      };
    });
    return { approach: a, row };
  });

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Best-job-agent eval report</title>
<style>
  body { font-family: -apple-system, system-ui, Segoe UI, sans-serif; margin: 24px; color: #111; }
  h1, h2 { margin: 16px 0 8px; }
  table { border-collapse: collapse; margin: 8px 0 24px; }
  th, td { border: 1px solid #ddd; padding: 6px 10px; text-align: left; font-size: 13px; }
  th { background: #f6f6f6; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .cell { display: inline-block; min-width: 72px; padding: 4px 6px; color: white; text-align: center; font-size: 11px; border-radius: 3px; }
  .muted { color: #666; font-size: 12px; }
  .badge { display: inline-block; background: #eee; border-radius: 3px; padding: 1px 5px; font-size: 11px; margin-right: 4px; }
</style>
</head>
<body>
<h1>Best-job-agent eval report</h1>
<p class="muted">Generated ${new Date().toISOString()} · ${results.length} runs · total cost $${summary.totalCostUsd.toFixed(4)}</p>

<h2>Approach leaderboard (sorted by ready-rate, then success, then cost)</h2>
<table>
  <thead><tr>
    <th>Approach</th><th class="num">Runs</th><th class="num">Success</th><th class="num">Ready</th>
    <th class="num">Avg dur (s)</th><th class="num">Med dur (s)</th><th class="num">P95 dur (s)</th>
    <th class="num">Avg cost ($)</th><th class="num">Avg LLM calls</th><th class="num">Avg steps</th><th class="num">Avg actions</th>
    <th>Failures</th>
  </tr></thead>
  <tbody>
  ${summary.byApproach
    .map(
      (r) => `<tr>
      <td><b>${r.approach}</b></td>
      <td class="num">${r.runs}</td>
      <td class="num">${(r.successRate * 100).toFixed(0)}%</td>
      <td class="num">${(r.readyRate * 100).toFixed(0)}%</td>
      <td class="num">${(r.avgDurationMs / 1000).toFixed(1)}</td>
      <td class="num">${(r.medianDurationMs / 1000).toFixed(1)}</td>
      <td class="num">${(r.p95DurationMs / 1000).toFixed(1)}</td>
      <td class="num">${r.avgCostUsd.toFixed(4)}</td>
      <td class="num">${r.avgLlmCalls.toFixed(1)}</td>
      <td class="num">${r.avgSteps.toFixed(1)}</td>
      <td class="num">${r.avgActionsExecuted.toFixed(1)}</td>
      <td>${Object.entries(r.failureModes).map(([k, v]) => `<span class="badge">${k}:${v}</span>`).join('')}</td>
    </tr>`
    )
    .join('\n')}
  </tbody>
</table>

<h2>Per-task heatmap (cells: success/total · ready/total)</h2>
<table>
  <thead><tr><th>Approach</th>${tasks.map((t) => `<th>${t}</th>`).join('')}</tr></thead>
  <tbody>
  ${heatmap
    .map(
      (h) => `<tr>
      <td><b>${h.approach}</b></td>
      ${h.row
        .map(
          (c) => `<td title="${escapeHtml(c.title)}"><span class="cell" style="background:${c.color}">${c.cell}</span></td>`
        )
        .join('')}
    </tr>`
    )
    .join('\n')}
  </tbody>
</table>

<h2>All runs</h2>
<table>
  <thead><tr>
    <th>Approach</th><th>Task</th><th>Seed</th><th>Success</th><th>Ready</th>
    <th class="num">Dur (s)</th><th class="num">Cost ($)</th><th class="num">LLM</th><th class="num">Steps</th>
    <th>Failure</th><th>Evidence</th>
  </tr></thead>
  <tbody>
  ${results
    .map(
      (r) => `<tr>
      <td>${r.approach}</td>
      <td>${r.taskId}</td>
      <td>${r.seed}</td>
      <td>${r.success ? '✓' : ''}</td>
      <td>${r.readyToSubmit ? '✓' : ''}</td>
      <td class="num">${(r.durationMs / 1000).toFixed(1)}</td>
      <td class="num">${r.totalCostUsd.toFixed(4)}</td>
      <td class="num">${r.totalLlmCalls}</td>
      <td class="num">${r.stepsTaken}</td>
      <td>${r.failureMode ?? ''}</td>
      <td class="muted">${escapeHtml(r.verifier.evidence)}</td>
    </tr>`
    )
    .join('\n')}
  </tbody>
</table>
</body></html>`;
  const htmlPath = path.join(resultsRoot, 'report.html');
  await fs.writeFile(htmlPath, html);
  return htmlPath;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
