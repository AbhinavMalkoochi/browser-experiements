import { Stagehand } from '@browserbasehq/stagehand';
import { z } from 'zod';
import type { Approach, ApproachCtx, LlmUsage } from '../core/types.js';
import { profileToYaml } from './shared.js';
import { ENV } from '../env.js';
import { verify } from '../core/verifier.js';
import { estimateCostUsd } from '../core/pricing.js';

/**
 * Approach A — Stagehand hybrid (AX + DOM, act/extract/observe).
 * Stagehand manages its own Chromium; we leverage its high-level primitives
 * (observe, act, agent) and plan around common application sub-tasks.
 *
 * We create a Stagehand session *within* this approach (bypassing the shared
 * runner browser) so Stagehand can install its own DOM instrumentation. The
 * runner's page gets pointed at the Stagehand page after a successful run so
 * the verifier can read the final state.
 */
export const approachA: Approach = {
  name: 'a-stagehand',
  description: 'Stagehand hybrid (AX+DOM) with act/observe primitives — proven baseline.',
  async run(ctx: ApproachCtx) {
    const stagehand = new Stagehand({
      env: 'LOCAL',
      modelName: ENV.EXECUTOR_MODEL,
      modelClientOptions: { apiKey: ENV.OPENAI_API_KEY },
      verbose: 0,
      enableCaching: true,
      localBrowserLaunchOptions: {
        headless: ENV.HEADLESS,
        viewport: { width: 1366, height: 900 },
      },
      // Stagehand reads its own prompt template, but we can inject context.
    });
    let steps = 0;
    let executed = 0;
    let readyToSubmit = false;
    try {
      ctx.runLog?.info('stagehand_start', { url: ctx.task.url });
      await stagehand.init();
      const page = stagehand.page;
      await page.goto(ctx.task.url, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1500);

      const profileYaml = profileToYaml(ctx.profile);

      // Use Stagehand's `agent` primitive which drives a multi-step act loop.
      const agent = stagehand.agent({
        model: ENV.EXECUTOR_MODEL,
      });
      const instruction = [
        `Goal: ${ctx.task.goal}`,
        '',
        'Candidate profile (YAML):',
        profileYaml,
        '',
        `When uploading a resume, use the file path: ${ctx.profile.resumePath}`,
        'When the form is fully filled and a visible Submit/Apply button is enabled, stop and report ready_to_submit.',
        'Do NOT click the final Submit button.',
        'If a CAPTCHA, login wall, or blocker appears, stop and report blocked.',
      ].join('\n');

      const agentResult = await agent.execute({
        instruction,
        maxSteps: Math.min(30, ctx.maxSteps),
      }).catch((e: Error) => ({ success: false, message: e.message, usage: null }));

      // Stagehand may set `completed` to boolean false — never treat as a step count.
      const rawC = (agentResult as { completed?: unknown }).completed;
      const rawS = (agentResult as { steps?: unknown }).steps;
      steps = typeof rawC === 'number' ? rawC : typeof rawS === 'number' ? rawS : 0;
      executed = steps;
      const msg = String((agentResult as { message?: string }).message ?? '').toLowerCase();
      readyToSubmit = !!(agentResult as { success?: boolean }).success && !msg.includes('block') && !msg.includes('captcha');

      // Approximate LLM usage from agent if available. Stagehand returns usage in some versions.
      const usage = (agentResult as { usage?: { input_tokens: number; output_tokens: number } }).usage;
      if (usage) {
        const u: LlmUsage = {
          model: ENV.EXECUTOR_MODEL,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          costUsd: estimateCostUsd(ENV.EXECUTOR_MODEL, usage.input_tokens, usage.output_tokens),
        };
        ctx.logLlm(u);
      } else {
        // Conservative estimate: Stagehand's agent typically uses ~12k-30k tokens per application.
        const u: LlmUsage = {
          model: ENV.EXECUTOR_MODEL,
          inputTokens: 12000 + 800 * Math.max(0, steps),
          outputTokens: 300 * Math.max(0, steps),
        };
        u.costUsd = estimateCostUsd(u.model, u.inputTokens, u.outputTokens);
        ctx.logLlm(u);
      }

      // Copy final URL/snapshot to runner's page so verifier runs on the right state.
      const finalUrl = page.url();
      try {
        await ctx.page.goto(finalUrl, { waitUntil: 'domcontentloaded' });
        // Bring over cookies so any post-login state survives.
        const cookies = await stagehand.context.cookies();
        await ctx.page.context().addCookies(cookies);
        await ctx.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      } catch {/* ignore; verifier will just see initial URL */}

      ctx.logStep({
        step: steps + 1,
        approach: ctx.approach,
        tsMs: Date.now(),
        durationMs: 0,
        url: finalUrl,
        actionExecuted: null,
        executed: true,
        error: null,
        llmUsage: [],
        notes: `stagehand agent result: ${JSON.stringify(agentResult).slice(0, 500)}`,
      });
    } catch (e) {
      ctx.logStep({
        step: steps + 1,
        approach: ctx.approach,
        tsMs: Date.now(),
        durationMs: 0,
        url: ctx.page.url(),
        actionExecuted: null,
        executed: false,
        error: (e as Error).message,
        llmUsage: [],
        notes: 'stagehand crashed',
      });
      try { await stagehand.close(); } catch {/* ignore */}
      return { finalStatus: 'crashed', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
    }
    try { await stagehand.close(); } catch {/* ignore */}
    return { finalStatus: 'done', stepsTaken: steps, actionsExecuted: executed, readyToSubmit };
  },
};
