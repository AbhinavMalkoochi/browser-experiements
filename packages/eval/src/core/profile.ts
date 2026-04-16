import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProfile } from './types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Use the real resume.pdf committed at the repo root. This guarantees uploads
 * exercise a real (browser-recognizable) PDF end-to-end.
 */
export const RESUME_PATH = path.resolve(__dirname, '../../../../resume.pdf');

/**
 * Test persona — deliberately synthetic (no real person). International student
 * with F-1 OPT status who needs future sponsorship and will relocate anywhere.
 * This stresses common branching fields (sponsorship/relocation/EEO).
 */
export const TEST_PROFILE: TestProfile = {
  firstName: 'Priya',
  lastName: 'Narayan',
  fullName: 'Priya Narayan',
  email: 'priya.narayan.apply@gmail.com',
  phone: '415-555-0168',
  linkedin: 'https://www.linkedin.com/in/priya-narayan-dev',
  github: 'https://github.com/priya-narayan',
  website: 'https://priyanarayan.dev',
  location: 'San Jose, CA, USA',
  city: 'San Jose',
  state: 'California',
  country: 'United States',
  zip: '95112',
  currentCompany: 'Bright Labs',
  currentTitle: 'Software Engineer',
  yearsExperience: 2,
  workAuthorization:
    'F-1 STEM OPT — authorized to work in the US; will require H-1B sponsorship in the future',
  requiresSponsorship: 'Yes',
  willingToRelocate: 'Yes',
  preferredStartDate: '2026-06-15',
  salaryExpectation: '145000',
  gender: 'Female',
  race: 'Asian',
  veteranStatus: 'I am not a protected veteran',
  disabilityStatus: 'No, I do not have a disability',
  pronouns: 'she/her',
  hispanicLatino: 'No',
  resumePath: RESUME_PATH,
  coverLetterPath: null,
  coverLetterText:
    "I am a software engineer with two years of full-time industry experience plus internships across web infrastructure and developer tooling. I ship reliable, well-tested TypeScript, Python, and Go services and care deeply about developer experience and reliability. I'm excited by your team's focus on building tools that engineers actually love using, and I would contribute pragmatic code, thoughtful design, and a strong bias toward small, safe increments.",
  summary:
    'Software engineer with ~2 years of industry experience in TypeScript, Python, Go, React/Next.js, Node.js, PostgreSQL, and AWS/GCP. Focus on reliability, developer experience, and automation. Currently on F-1 STEM OPT; open to relocate anywhere in the US.',
  skills: [
    'TypeScript', 'JavaScript', 'Python', 'Go', 'React', 'Next.js', 'Node.js', 'PostgreSQL',
    'Redis', 'AWS', 'GCP', 'Docker', 'Kubernetes', 'GraphQL', 'REST', 'CI/CD', 'Playwright',
    'Terraform', 'Kafka',
  ],
  education: [
    {
      school: 'University of California, San Diego',
      degree: 'Master of Science',
      field: 'Computer Science',
      gradYear: 2024,
      gpa: '3.86',
    },
    {
      school: 'Indian Institute of Technology, Bombay',
      degree: 'Bachelor of Technology',
      field: 'Computer Science and Engineering',
      gradYear: 2022,
      gpa: '8.7/10',
    },
  ],
  experience: [
    {
      company: 'Bright Labs',
      title: 'Software Engineer',
      start: '2024-07',
      end: 'Present',
      bullets: [
        'Led the redesign of the billing platform, cutting P99 latency by 48%.',
        'Shipped a new React-based admin dashboard used by 1,200+ internal users.',
        'Introduced type-safe end-to-end tests, catching 30+ regressions per quarter.',
      ],
    },
    {
      company: 'Stripe',
      title: 'Software Engineer Intern',
      start: '2023-06',
      end: '2023-09',
      bullets: [
        'Built a low-latency fraud-signal pipeline in Go on Kafka + Postgres.',
        'Added tracing instrumentation adopted across 3 partner services.',
      ],
    },
  ],
  qa: [
    { q: 'Why do you want to work here', a: 'Your focus on reliability and developer-facing tooling is exactly the space I enjoy most — I want to ship software other engineers love depending on.' },
    { q: 'Tell us about yourself', a: 'I am a software engineer with two years of industry experience focused on developer experience and reliability, currently on F-1 STEM OPT.' },
    { q: 'Why this role', a: 'The work combines platform reliability and developer experience, which is where I have shipped most of my best results.' },
    { q: 'Years of experience', a: '2' },
    { q: 'How did you hear about us', a: 'LinkedIn' },
    { q: 'Notice period', a: '2 weeks' },
    { q: 'Referred by', a: 'N/A' },
    { q: 'Will you now or in the future require sponsorship', a: 'Yes' },
    { q: 'Are you legally authorized to work', a: 'Yes' },
    { q: 'Willing to relocate', a: 'Yes, I am willing to relocate anywhere in the US.' },
    { q: 'Desired salary', a: '$145,000 USD base, flexible' },
  ],
};

