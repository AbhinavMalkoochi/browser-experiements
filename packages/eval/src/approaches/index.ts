import type { Approach } from '../core/types.js';
import { approachB } from './b-axtree-indexed.js';
import { approachC } from './c-pure-vision-som.js';
import { approachD } from './d-hierarchical.js';
import { approachE } from './e-form-dsl.js';
import { approachF } from './f-dual-eye.js';
import { approachG } from './g-replay-diff.js';
import { approachH } from './h-rmcts-lite.js';
import { approachA } from './a-stagehand.js';
import { approachI, approachJ, approachK, approachL, approachM, approachN } from './i-experimental-families.js';

export const APPROACHES: Record<string, Approach> = {
  a: approachA,
  b: approachB,
  c: approachC,
  d: approachD,
  e: approachE,
  f: approachF,
  g: approachG,
  h: approachH,
  i: approachI,
  j: approachJ,
  k: approachK,
  l: approachL,
  m: approachM,
  n: approachN,
};

export function listApproaches(): Approach[] {
  return Object.values(APPROACHES);
}
