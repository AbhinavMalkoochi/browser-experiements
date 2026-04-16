import type { EvalTask } from './types.js';

/**
 * Curated eval set drawn from the user's links.md.
 * We keep every URL verbatim; the `id` is a stable short slug for result folders.
 * submitAllowed is FALSE for all tasks — safety first; the agent must stop at the final Submit.
 */
export const TASKS: EvalTask[] = [
  {
    id: 'ashby-liquid',
    ats: 'ashby',
    url: 'https://jobs.ashbyhq.com/liquid/7b47044b-4b81-44b4-8986-ea5eaaa85c27?utm_source=Simplify&ref=Simplify',
    difficulty: 'easy',
    goal: 'Fill out the application completely. Use the candidate profile for every field. Upload the resume when asked. Stop BEFORE clicking the final Submit Application button.',
    expectSubmitControl: true,
    requiredFields: ['name', 'email', 'resume', 'phone'],
  },
  {
    id: 'ashby-mirage',
    ats: 'ashby',
    url: 'https://jobs.ashbyhq.com/mirage/1c4a937b-894e-402a-b2fd-93435b86657f/application?utm_source=Simplify&ref=Simplify',
    difficulty: 'easy',
    goal: 'Fill out the application form completely. Stop BEFORE clicking Submit.',
    expectSubmitControl: true,
  },
  {
    id: 'greenhouse-ispottv',
    ats: 'greenhouse',
    url: 'https://job-boards.greenhouse.io/ispottv/jobs/4684929005?utm_source=Simplify&ref=Simplify',
    difficulty: 'easy',
    goal: 'Fill out the application form completely. Upload the resume. Stop BEFORE clicking Submit Application.',
    expectSubmitControl: true,
  },
  {
    id: 'greenhouse-twitch',
    ats: 'greenhouse',
    url: 'https://job-boards.greenhouse.io/twitch/jobs/8447271002?utm_source=Simplify&ref=Simplify',
    difficulty: 'easy',
    goal: 'Fill out the application form completely. Stop BEFORE clicking Submit Application.',
    expectSubmitControl: true,
  },
  {
    id: 'greenhouse-tradedesk',
    ats: 'greenhouse',
    url: 'https://job-boards.greenhouse.io/thetradedesk/jobs/5105036007?utm_source=Simplify&ref=Simplify',
    difficulty: 'medium',
    goal: 'Fill out the application form completely. Answer EEO questions truthfully from profile. Stop BEFORE clicking Submit.',
    expectSubmitControl: true,
  },
  {
    id: 'lever-whoop',
    ats: 'lever',
    url: 'https://jobs.lever.co/whoop/b7f75849-b5c0-49fe-8d24-50cbb39d284d/apply?utm_source=Simplify&ref=Simplify',
    difficulty: 'easy',
    goal: 'Fill every field in the Lever application and upload the resume. Stop BEFORE Submit.',
    expectSubmitControl: true,
  },
  {
    id: 'workable-optisigns',
    ats: 'workable',
    url: 'https://apply.workable.com/optisigns-inc/j/EB560EFFD4/?utm_source=Simplify&ref=Simplify',
    difficulty: 'medium',
    goal: 'Click Apply for this job, fill in every field, upload the resume, and stop BEFORE clicking Submit.',
    expectSubmitControl: true,
  },
  {
    id: 'smartrecruiters-krg',
    ats: 'smartrecruiters',
    url: 'https://jobs.smartrecruiters.com/KrgTechnologyInc/101351633?utm_source=Simplify&ref=Simplify',
    difficulty: 'medium',
    goal: 'Open the I am interested / Apply form, fill in every field, upload the resume, stop BEFORE final Submit.',
    expectSubmitControl: true,
  },
  {
    id: 'applytojob-genalyte',
    ats: 'applytojob',
    url: 'https://genalyte.applytojob.com/apply/ms4az9EW8x/Software-Engineer-I?utm_source=Simplify&ref=Simplify',
    difficulty: 'medium',
    goal: 'Fill in every field in the application, upload the resume, stop BEFORE the final Submit button.',
    expectSubmitControl: true,
  },
  {
    id: 'workday-abbott',
    ats: 'workday',
    url: 'https://abbott.wd5.myworkdayjobs.com/en-US/abbottcareers/job/United-States---Minnesota---St-Paul/Software-Verification-Engineer-I_31147199-1?utm_source=Simplify&ref=Simplify',
    difficulty: 'hard',
    goal: 'Click Apply, then fill the first page of the Workday application. Stop after the first page is fully filled (do NOT submit; do NOT sign up for an account if possible).',
    expectSubmitControl: true,
  },
];

export function taskById(id: string): EvalTask | undefined {
  return TASKS.find((t) => t.id === id);
}
