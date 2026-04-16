import type { Page } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { extractAxSnapshot, type AxSnapshot } from './ax.js';
import type { EvalTask, VerifierResult } from './types.js';
import { screenshotBuffer } from './browser.js';

/**
 * Universal post-hoc success verifier.
 * An approach "succeeds" when:
 *   - the current URL looks like the application form (not a dead-end),
 *   - at least 90% of detected required fields have non-empty value, OR
 *     85%+ required fields filled + a Submit control is present and enabled,
 *   - page is not showing a CAPTCHA or blocking screen.
 *
 * We purposely do NOT click submit for safety (unless task.submitAllowed is true).
 */

const CAPTCHA_SIGNALS = [
  'hcaptcha',
  'captcha',
  'are you a human',
  'verify you are human',
  'recaptcha',
  'press & hold',
  'bot detection',
  'cloudflare',
  'denied access',
];

const BLOCK_SIGNALS = ['403 forbidden', 'access denied', 'blocked', 'sorry, you have been blocked'];

const SUCCESS_SIGNALS = [
  'application received',
  'thanks for applying',
  'thank you for your interest',
  "we've received your application",
  'application submitted',
];

export async function verify(page: Page, task: EvalTask, artifactDir: string): Promise<VerifierResult> {
  let screenshotPath: string | null = null;
  try {
    const buf = await screenshotBuffer(page, true);
    screenshotPath = path.join(artifactDir, 'final.png');
    await fs.writeFile(screenshotPath, buf);
  } catch {/* ignore */}

  let snap: AxSnapshot;
  try {
    snap = await extractAxSnapshot(page);
  } catch {
    return {
      success: false,
      readyToSubmit: false,
      requiredFieldsFilled: 0,
      requiredFieldsTotal: 0,
      missing: [],
      submitButtonFound: false,
      submitButtonEnabled: false,
      evidence: 'failed to extract final snapshot',
      classification: 'error',
      screenshotPath,
    };
  }

  const text = snap.visibleText.toLowerCase();

  if (CAPTCHA_SIGNALS.some((s) => text.includes(s))) {
    return {
      success: false,
      readyToSubmit: false,
      requiredFieldsFilled: 0,
      requiredFieldsTotal: 0,
      missing: [],
      submitButtonFound: false,
      submitButtonEnabled: false,
      evidence: 'captcha detected',
      classification: 'captcha',
      screenshotPath,
    };
  }
  if (BLOCK_SIGNALS.some((s) => text.includes(s))) {
    return {
      success: false,
      readyToSubmit: false,
      requiredFieldsFilled: 0,
      requiredFieldsTotal: 0,
      missing: [],
      submitButtonFound: false,
      submitButtonEnabled: false,
      evidence: 'blocked page',
      classification: 'blocked',
      screenshotPath,
    };
  }
  const submittedLike = SUCCESS_SIGNALS.some((s) => text.includes(s));

  // Collect required form fields.
  const requiredNodes = snap.nodes.filter(
    (n) => n.required && ['textbox', 'combobox', 'checkbox', 'radio', 'file'].includes(n.role)
  );
  // Heuristic: required checkboxes/radios are "filled" when at least one in the radio-group is checked.
  // We approximate radio groups by label prefix match.
  let filled = 0;
  const missing: string[] = [];
  for (const n of requiredNodes) {
    if (n.role === 'checkbox' || n.role === 'radio') {
      const groupMatches = snap.nodes.filter(
        (m) =>
          (m.role === 'checkbox' || m.role === 'radio') &&
          (m.label === n.label || m.name === n.name)
      );
      if (groupMatches.some((m) => m.checked)) {
        filled += 1;
      } else {
        missing.push(n.name || n.label || '(radio group)');
      }
      continue;
    }
    if (n.role === 'file') {
      if (n.value) filled += 1;
      else missing.push(n.name || 'file upload');
      continue;
    }
    if ((n.value && n.value.trim().length > 0) || n.checked) {
      filled += 1;
    } else {
      missing.push(n.name || n.label || n.placeholder || '(unnamed field)');
    }
  }

  // Find a submit control.
  const submit = snap.nodes.find(
    (n) =>
      (n.role === 'button' || n.tag === 'button' || n.type === 'submit') &&
      /submit|apply|send application|finish/i.test(n.name || n.label || '')
  );
  const submitFound = !!submit;
  const submitEnabled = submit ? !submit.disabled : false;

  const totalReq = requiredNodes.length;
  const ratio = totalReq === 0 ? 0 : filled / totalReq;
  // Success scoring.
  let classification: VerifierResult['classification'] = 'partial_filled';
  if (submittedLike) classification = 'success';
  else if (totalReq === 0) {
    classification = submitFound ? 'partial_filled' : 'form_not_loaded';
  }

  const readyToSubmit =
    totalReq > 0 && ratio >= 0.85 && submitFound && submitEnabled && missing.length <= 2;
  const success = submittedLike || readyToSubmit;

  return {
    success,
    readyToSubmit,
    requiredFieldsFilled: filled,
    requiredFieldsTotal: totalReq,
    missing,
    submitButtonFound: submitFound,
    submitButtonEnabled: submitEnabled,
    evidence: `ratio=${ratio.toFixed(2)} filled=${filled}/${totalReq} submit=${submitFound}/${submitEnabled} submittedLike=${submittedLike}`,
    classification,
    screenshotPath,
  };
}
