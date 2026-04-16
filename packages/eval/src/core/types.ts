import type { Page } from 'playwright';

export type AtsType =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workday'
  | 'workable'
  | 'smartrecruiters'
  | 'icims'
  | 'oracle'
  | 'jobvite'
  | 'applytojob'
  | 'custom'
  | 'linkedin';

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface EvalTask {
  id: string;
  ats: AtsType;
  url: string;
  difficulty: Difficulty;
  /** Short natural-language description of the goal given to the agent. */
  goal: string;
  /** Expected presence indicators after filling is complete. */
  expectSubmitControl?: boolean;
  /** Known-required fields (heuristic; used for verification). */
  requiredFields?: string[];
  /** Expected QA questions in natural language form (best-effort). */
  expectedQuestions?: string[];
  /** If true, the approach is allowed to actually click submit. Defaults to false for safety. */
  submitAllowed?: boolean;
}

export interface TestProfile {
  firstName: string;
  lastName: string;
  fullName: string;
  email: string;
  phone: string;
  linkedin: string;
  github: string;
  website: string;
  location: string;
  city: string;
  state: string;
  country: string;
  zip: string;
  currentCompany: string;
  currentTitle: string;
  yearsExperience: number;
  workAuthorization: string;
  requiresSponsorship: 'No' | 'Yes';
  willingToRelocate: 'Yes' | 'No';
  preferredStartDate: string;
  salaryExpectation: string;
  gender: string;
  race: string;
  veteranStatus: string;
  disabilityStatus: string;
  pronouns: string;
  hispanicLatino: 'No' | 'Yes' | 'Decline';
  resumePath: string;
  coverLetterPath: string | null;
  coverLetterText: string;
  summary: string;
  skills: string[];
  education: Array<{ school: string; degree: string; field: string; gradYear: number; gpa: string }>;
  experience: Array<{ company: string; title: string; start: string; end: string; bullets: string[] }>;
  /** Optional custom Q&A library, matched in executor. */
  qa: Array<{ q: string; a: string }>;
}

export type ActionKind =
  | 'click'
  | 'fill'
  | 'select'
  | 'check'
  | 'upload'
  | 'press'
  | 'scroll'
  | 'goto'
  | 'wait'
  | 'done'
  | 'abort'
  | 'noop';

export interface Action {
  kind: ActionKind;
  /** For ref-based approaches. */
  ref?: string;
  /** For Playwright selector-based fallbacks. */
  selector?: string;
  /** For click-by-coordinate. */
  x?: number;
  y?: number;
  /** Index for Set-of-Marks. */
  index?: number;
  value?: string;
  /** Short human reason, used for logging. */
  reason?: string;
  /** Whether to press Enter after fill. */
  enter?: boolean;
  /** Seconds to wait. */
  seconds?: number;
  /** Final status on done/abort. */
  status?: 'ready_to_submit' | 'submitted' | 'blocked' | 'error';
}

export interface LlmUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Computed in metrics.ts from pricing table. */
  costUsd?: number;
}

export interface StepRecord {
  step: number;
  approach: string;
  tsMs: number;
  durationMs: number;
  url: string;
  actionExecuted: Action | null;
  executed: boolean;
  error: string | null;
  llmUsage: LlmUsage[];
  notes: string;
}

export interface VerifierResult {
  success: boolean;
  readyToSubmit: boolean;
  requiredFieldsFilled: number;
  requiredFieldsTotal: number;
  missing: string[];
  submitButtonFound: boolean;
  submitButtonEnabled: boolean;
  evidence: string;
  classification:
    | 'success'
    | 'partial_filled'
    | 'form_not_loaded'
    | 'captcha'
    | 'blocked'
    | 'wrong_page'
    | 'error';
  screenshotPath: string | null;
}

export interface RunResult {
  approach: string;
  taskId: string;
  seed: number;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  stepsTaken: number;
  actionsExecuted: number;
  totalLlmCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  finalUrl: string;
  finalStatus: 'done' | 'aborted' | 'crashed' | 'timeout' | 'budget_exceeded';
  success: boolean;
  readyToSubmit: boolean;
  verifier: VerifierResult;
  failureMode: string | null;
  error: string | null;
  artifactDir: string;
}

/** Optional structured run log (see `run-log.ts`); writes `run.log` under artifactDir. */
export interface RunLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ApproachCtx {
  page: Page;
  task: EvalTask;
  profile: TestProfile;
  approach: string;
  taskId: string;
  seed: number;
  artifactDir: string;
  /** Logger callback for per-step records. */
  logStep: (r: StepRecord) => void;
  /** Logger for LLM usage (accumulated). */
  logLlm: (u: LlmUsage) => void;
  /** Max total steps. */
  maxSteps: number;
  /** Shared replay cache dir (per approach). */
  cacheDir: string;
  /** Set when the outer harness hits TASK_TIMEOUT_MS; loops should exit quickly. */
  abortSignal?: AbortSignal;
  /** Human-readable debug log for this run. */
  runLog?: RunLog;
}

export interface Approach {
  name: string;
  /** Short description printed in the report. */
  description: string;
  /** Returns a final status. */
  run(ctx: ApproachCtx): Promise<{
    finalStatus: 'done' | 'aborted' | 'crashed' | 'budget_exceeded';
    stepsTaken: number;
    actionsExecuted: number;
    readyToSubmit: boolean;
    note?: string;
  }>;
}
