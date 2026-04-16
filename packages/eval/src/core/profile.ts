import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProfile } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const RESUME_PATH = path.resolve(__dirname, '../../fixtures/resume.pdf');

export const TEST_PROFILE: TestProfile = {
  firstName: 'Alex',
  lastName: 'Morgan',
  fullName: 'Alex Morgan',
  email: 'alex.morgan.test+jobagent@example.com',
  phone: '415-555-0142',
  linkedin: 'https://www.linkedin.com/in/alex-morgan-test',
  github: 'https://github.com/alex-morgan-test',
  website: 'https://alexmorgan.dev',
  location: 'San Francisco, CA, USA',
  city: 'San Francisco',
  state: 'California',
  country: 'United States',
  zip: '94105',
  currentCompany: 'Bright Labs',
  currentTitle: 'Software Engineer',
  yearsExperience: 4,
  workAuthorization: 'US Citizen',
  requiresSponsorship: 'No',
  willingToRelocate: 'Yes',
  preferredStartDate: '2026-06-01',
  salaryExpectation: '150000',
  gender: 'Prefer not to say',
  race: 'Prefer not to say',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'I do not wish to answer',
  pronouns: 'they/them',
  hispanicLatino: 'No',
  resumePath: RESUME_PATH,
  coverLetterPath: null,
  coverLetterText:
    'I am excited to apply for this role. I have four years of experience shipping reliable, high-performance web services with TypeScript, React, Node.js, and Python. I love working on developer-facing tools, reliability, and automation. I would be glad to talk more about how I can contribute.',
  summary:
    'Software engineer with 4 years of experience building web applications and platforms with TypeScript, React, Node.js, Python, and cloud infrastructure (AWS, GCP). Passionate about reliability, developer experience, and automation.',
  skills: [
    'TypeScript', 'JavaScript', 'Python', 'Go', 'React', 'Next.js', 'Node.js', 'PostgreSQL',
    'Redis', 'AWS', 'GCP', 'Docker', 'Kubernetes', 'GraphQL', 'REST', 'CI/CD',
  ],
  education: [
    {
      school: 'University of California, Berkeley',
      degree: 'Bachelor of Science',
      field: 'Computer Science',
      gradYear: 2021,
      gpa: '3.78',
    },
  ],
  experience: [
    {
      company: 'Bright Labs',
      title: 'Software Engineer',
      start: '2023-01',
      end: 'Present',
      bullets: [
        'Led the redesign of the billing platform, cutting P99 latency by 48%.',
        'Shipped a new React-based admin dashboard used by 1,200+ internal users.',
        'Introduced type-safe end-to-end tests, catching 30+ regressions per quarter.',
      ],
    },
    {
      company: 'Kestrel Systems',
      title: 'Software Engineer I',
      start: '2021-06',
      end: '2022-12',
      bullets: [
        'Built a low-latency event ingestion pipeline in Go on Kafka + Postgres.',
        'Mentored two interns, both converted to full-time offers.',
        'Automated on-call playbooks; reduced MTTR by 34% across three quarters.',
      ],
    },
  ],
  qa: [
    { q: 'Why do you want to work here', a: 'Your mission to build reliable, developer-facing tooling aligns with what I enjoy and do best.' },
    { q: 'Tell us about yourself', a: 'I am a software engineer with 4 years of experience focusing on platform reliability and developer experience.' },
    { q: 'Years of experience', a: '4' },
    { q: 'How did you hear about us', a: 'LinkedIn' },
    { q: 'Notice period', a: '2 weeks' },
    { q: 'Referred by', a: 'N/A' },
  ],
};
