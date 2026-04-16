import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';

// Load .env from repo root as well (our OPENAI_API_KEY lives there)
const repoRootEnv = path.resolve(process.cwd(), '../../.env');
if (fs.existsSync(repoRootEnv)) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  (await import('dotenv')).config({ path: repoRootEnv, override: false });
}

export const ENV = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
  // Model defaults — overridable via env. These are widely available OpenAI models.
  PLANNER_MODEL: process.env.PLANNER_MODEL ?? 'gpt-4o',
  EXECUTOR_MODEL: process.env.EXECUTOR_MODEL ?? 'gpt-4o-mini',
  VISION_MODEL: process.env.VISION_MODEL ?? 'gpt-4o',
  VERIFIER_MODEL: process.env.VERIFIER_MODEL ?? 'gpt-4o-mini',
  // Runtime knobs
  HEADLESS: (process.env.HEADLESS ?? 'true').toLowerCase() === 'true',
  MAX_STEPS: Number(process.env.MAX_STEPS ?? '40'),
  STEP_TIMEOUT_MS: Number(process.env.STEP_TIMEOUT_MS ?? '20000'),
  TASK_TIMEOUT_MS: Number(process.env.TASK_TIMEOUT_MS ?? '300000'),
  CONCURRENCY: Number(process.env.CONCURRENCY ?? '2'),
};

if (!ENV.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required in environment (root .env).');
}
