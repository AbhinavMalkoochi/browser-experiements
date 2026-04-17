import type { AtsType, ObservationMode } from './types.js';
import type { AxNode, AxSnapshot } from './ax.js';

export interface CanonicalField {
  ref: string;
  kind: 'text' | 'select' | 'check' | 'radio' | 'upload' | 'button' | 'link' | 'other';
  label: string;
  section: string;
  required: boolean;
  filled: boolean;
  value: string;
  placeholder: string;
  options: string[];
  disabled: boolean;
  framePath: string;
  context: string;
}

export interface CanonicalActionTarget {
  ref: string;
  kind: 'button' | 'link' | 'navigation' | 'submit' | 'upload';
  label: string;
  section: string;
  disabled: boolean;
}

export interface CanonicalObservation {
  ats: AtsType;
  mode: ObservationMode;
  url: string;
  title: string;
  pageKind:
    | 'landing'
    | 'application_form'
    | 'multi_step'
    | 'review'
    | 'login_wall'
    | 'captcha'
    | 'success'
    | 'other';
  visibleTextSummary: string;
  sections: string[];
  fields: CanonicalField[];
  actions: CanonicalActionTarget[];
  requiredCount: number;
  filledRequiredCount: number;
}

function fieldKind(node: AxNode): CanonicalField['kind'] {
  if (node.role === 'combobox') return 'select';
  if (node.role === 'checkbox') return 'check';
  if (node.role === 'radio') return 'radio';
  if (node.role === 'file' || node.type === 'file') return 'upload';
  if (node.role === 'button') return 'button';
  if (node.role === 'link') return 'link';
  if (node.role === 'textbox' || node.role === 'searchbox') return 'text';
  return 'other';
}

function actionKind(node: AxNode): CanonicalActionTarget['kind'] | null {
  const text = `${node.name} ${node.label}`.toLowerCase();
  if (node.role === 'link') return 'link';
  if (node.role === 'button' || node.tag === 'button' || node.type === 'submit') {
    if (/submit|apply|finish|send application/.test(text)) return 'submit';
    if (/continue|next|review|start|open|begin/.test(text)) return 'navigation';
    return 'button';
  }
  if (node.role === 'file' || node.type === 'file') return 'upload';
  return null;
}

function isFilled(node: AxNode): boolean {
  if (node.role === 'checkbox' || node.role === 'radio') return node.checked;
  if (node.role === 'file' || node.type === 'file') return Boolean(node.value);
  return Boolean(node.value?.trim());
}

export function inferPageKind(snapshot: AxSnapshot): CanonicalObservation['pageKind'] {
  const text = snapshot.visibleText.toLowerCase();
  if (/application submitted|application received|thanks for applying/.test(text)) return 'success';
  if (/captcha|verify you are human|cloudflare|recaptcha/.test(text)) return 'captcha';
  if (/sign in|log in|create account|create an account/.test(text)) return 'login_wall';
  const submit = snapshot.nodes.find(
    (n) => /submit|apply|finish|send application/i.test(`${n.name} ${n.label}`) && (n.role === 'button' || n.type === 'submit')
  );
  const requiredFields = snapshot.nodes.filter(
    (n) => n.required && ['textbox', 'combobox', 'checkbox', 'radio', 'file'].includes(n.role)
  );
  const navButtons = snapshot.nodes.filter(
    (n) => (n.role === 'button' || n.type === 'submit') && /continue|next|review/i.test(`${n.name} ${n.label}`)
  );
  if (requiredFields.length > 0 && submit) return 'application_form';
  if (requiredFields.length > 0 && navButtons.length > 0) return 'multi_step';
  if (submit && requiredFields.length === 0) return 'review';
  if (snapshot.nodes.some((n) => /apply|i am interested|i'm interested|apply now|start application/i.test(`${n.name} ${n.label}`))) {
    return 'landing';
  }
  return 'other';
}

export function buildCanonicalObservation(snapshot: AxSnapshot, ats: AtsType, mode: ObservationMode): CanonicalObservation {
  const sections = new Set<string>();
  const fields: CanonicalField[] = [];
  const actions: CanonicalActionTarget[] = [];
  for (const node of snapshot.nodes) {
    const section = node.section || 'General';
    if (section) sections.add(section);
    const kind = fieldKind(node);
    if (['text', 'select', 'check', 'radio', 'upload'].includes(kind)) {
      fields.push({
        ref: node.ref,
        kind,
        label: node.label || node.name || node.placeholder || '(unnamed)',
        section,
        required: node.required,
        filled: isFilled(node),
        value: node.value ?? '',
        placeholder: node.placeholder ?? '',
        options: node.options ?? [],
        disabled: node.disabled,
        framePath: node.framePath,
        context: node.context,
      });
    }
    const aKind = actionKind(node);
    if (aKind) {
      actions.push({
        ref: node.ref,
        kind: aKind,
        label: node.name || node.label || '(unnamed action)',
        section,
        disabled: node.disabled,
      });
    }
  }
  const requiredCount = fields.filter((f) => f.required).length;
  const filledRequiredCount = fields.filter((f) => f.required && f.filled).length;
  return {
    ats,
    mode,
    url: snapshot.url,
    title: snapshot.title,
    pageKind: inferPageKind(snapshot),
    visibleTextSummary: snapshot.visibleText.slice(0, 500),
    sections: [...sections],
    fields,
    actions,
    requiredCount,
    filledRequiredCount,
  };
}

export function formatCanonicalObservation(obs: CanonicalObservation, limit = 40): string {
  const lines: string[] = [];
  lines.push(`PAGE: kind=${obs.pageKind} ats=${obs.ats} required=${obs.filledRequiredCount}/${obs.requiredCount}`);
  lines.push(`URL: ${obs.url}`);
  lines.push(`TITLE: ${obs.title}`);
  if (obs.visibleTextSummary) lines.push(`VISIBLE: ${obs.visibleTextSummary}`);
  lines.push('');
  lines.push('FIELDS:');
  const sortedFields = [...obs.fields].sort((a, b) => {
    const aScore = (a.required ? 10 : 0) + (!a.filled ? 5 : 0);
    const bScore = (b.required ? 10 : 0) + (!b.filled ? 5 : 0);
    return bScore - aScore;
  }).slice(0, limit);
  for (const field of sortedFields) {
    const bits = [
      `[${field.ref}]`,
      field.kind,
      `"${field.label}"`,
      `section="${field.section}"`,
      field.required ? 'REQ' : '',
      field.filled ? `FILLED="${field.value.slice(0, 60)}"` : '',
      field.placeholder ? `ph="${field.placeholder}"` : '',
      field.disabled ? 'DIS' : '',
      field.options.length ? `opts=[${field.options.slice(0, 8).map((x) => `"${x}"`).join(',')}]` : '',
      field.context ? `ctx="${field.context.slice(0, 80)}"` : '',
    ].filter(Boolean);
    lines.push(bits.join(' '));
  }
  if (obs.fields.length > limit) lines.push(`... ${obs.fields.length - limit} more fields`);
  lines.push('');
  lines.push('ACTIONS:');
  for (const action of obs.actions.slice(0, 24)) {
    const bits = [`[${action.ref}]`, action.kind, `"${action.label}"`, `section="${action.section}"`, action.disabled ? 'DIS' : ''].filter(Boolean);
    lines.push(bits.join(' '));
  }
  return lines.join('\n');
}
