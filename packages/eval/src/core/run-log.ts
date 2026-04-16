import fs from 'node:fs/promises';
import path from 'node:path';
import type { RunLog } from './types.js';

/** Per-run append-only log: `artifactDir/run.log` + optional mirrored console. */
export function createRunLog(artifactDir: string, prefix: string, mirrorConsole: boolean): RunLog {
  const logPath = path.join(artifactDir, 'run.log');
  const write = async (level: string, msg: string, data?: Record<string, unknown>) => {
    const ts = new Date().toISOString();
    const extra = data && Object.keys(data).length ? ` ${JSON.stringify(data)}` : '';
    const line = `[${ts}] [${level}] ${prefix} ${msg}${extra}\n`;
    try {
      await fs.appendFile(logPath, line);
    } catch {
      /* disk full etc. */
    }
    if (mirrorConsole) {
      const c = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
      c(`${prefix} [${level}] ${msg}${extra}`);
    }
  };
  return {
    info: (msg, data) => void write('INFO', msg, data),
    warn: (msg, data) => void write('WARN', msg, data),
    error: (msg, data) => void write('ERROR', msg, data),
  };
}
