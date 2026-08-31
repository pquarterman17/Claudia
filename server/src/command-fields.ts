/**
 * Field-level primitives for command-schema.ts: size/depth bounds, primitive
 * and enum predicates, and the handful of nested shapes (PromptImage,
 * SessionTemplate, ToolkitAction, the answers map, an agent-kind array) that
 * show up inside more than one ClientCommand member. Split out of
 * command-schema.ts purely to stay under the repo's 400-line-per-file
 * ratchet (server/test/repo-integrity.test.ts) — there is no conceptual
 * boundary here, just a size one.
 */
import type { AgentKind, PermissionLaunchMode } from '@claudia/shared';

type Rec = Record<string, unknown>;
type Test = (v: unknown) => boolean;
/** A field's validator: given the whole command object and its (already
 * string-typed) `type` tag, returns undefined if fine or a ready-to-log
 * reason string. Nested-shape checks below have this same signature so they
 * can sit directly in a command's check list alongside scalar `field()`s. */
export type FieldCheck = (o: Rec, type: string) => string | undefined;

/**
 * MAX_LABEL_LEN — an id, title, tag, model name, branch, or path. None of
 * these are ever legitimately more than a couple hundred characters in this
 * app; 2,000 leaves headroom for an unusually long repository path without
 * letting a field like "sessionId" carry a document.
 *
 * MAX_TEXT_LEN — free-form content: a prompt, an objective, a pasted diff or
 * stack trace, a toolkit action's canned prompt, an AskUserQuestion answer.
 * Real prompts run to tens of thousands of characters; 200,000 (~200KB)
 * covers that generously while staying a small, fixed cost to reject.
 *
 * MAX_IMAGE_DATA_LEN — base64 image bytes. The browser already refuses to
 * attach an image over 5MB before encoding it (web/src/components/
 * ImageStrip.tsx, MAX_IMAGE_BYTES); base64 inflates raw bytes by 4/3, so 5MB
 * becomes ~6.99M characters. 7,000,000 leaves headroom over that without
 * accepting an arbitrarily large blob from a client that skips the
 * browser's own encoder and talks the wire protocol directly.
 *
 * MAX_ARRAY_LEN — any array, or object key count, without a tighter,
 * semantic bound of its own (see MAX_IMAGES_PER_PROMPT, MAX_WORKERS below).
 * Reused for object key count too, since both are "how many siblings can
 * one container hold" — a legitimate command never has more than a handful
 * of keys or array entries anywhere in its shape.
 *
 * MAX_DEPTH — how many object/array levels scanStructure will descend. The
 * deepest legitimate shape in this protocol is three levels (a command's
 * `images` array -> one {mediaType,data,name} object -> a field value), so
 * 6 is double that: no real command is ever rejected, but a hand-built
 * pollution or stack-exhaustion payload (`{"a":{"a":{"a":...}}}`) is caught
 * within a handful of recursive calls, not thousands.
 */
export const MAX_LABEL_LEN = 2_000;
export const MAX_TEXT_LEN = 200_000;
export const MAX_IMAGE_DATA_LEN = 7_000_000;
export const MAX_ARRAY_LEN = 200;
export const MAX_DEPTH = 6;
/** Mirrors web/src/components/ImageStrip.tsx MAX_IMAGES — one prompt's cap. */
export const MAX_IMAGES_PER_PROMPT = 4;
/** A generous multiple of the two known agent kinds. Workers are dealt
 * round-robin across pieces of one objective, so nothing legitimate needs a
 * long list — a human is not going to hand-type sixty agent slots. */
export const MAX_WORKERS = 8;

/**
 * Total string content in one command, summed over EVERY field including ones
 * no command declares.
 *
 * Found in review: the structural scan bounded nesting, array length and key
 * count, but never the size of a string sitting under an unknown key. So
 * `{"type":"ping","junk":"<megabytes>"}` validated perfectly — `ping` declares
 * no fields, the junk was never looked at, and the cost was paid anyway in
 * allocation and parse time, repeatable as fast as a local page can send.
 *
 * The budget is the largest legitimate command plus headroom: four images at
 * MAX_IMAGE_DATA_LEN each, and a prompt beside them. Anything past that is not
 * a command this protocol has, whatever it calls its fields.
 */
/**
 * Headroom for the JSON scaffolding the budget also charges for.
 *
 * The scan charges every KEY as well as every value, so a command made
 * entirely of maximum-size fields still needs room for `type`, `sessionId`,
 * `images`, and each image's `mediaType` and `name`. Without it the budget
 * rejected the exact command its own comment promised to admit — a full
 * 200,000-character prompt with four maximum images came up 172 characters
 * short, and the test named for that case used a four-character prompt.
 */
const STRUCTURAL_TEXT = 64_000;

export const MAX_TOTAL_TEXT_LEN =
  MAX_IMAGES_PER_PROMPT * MAX_IMAGE_DATA_LEN + MAX_TEXT_LEN + STRUCTURAL_TEXT;

/**
 * The ceiling on a single raw websocket frame, enforced by ws itself before
 * the bytes are ever assembled into a message.
 *
 * Deliberately the outermost of the three limits: the budget above still has
 * to parse the JSON before it can measure it, and this one does not. Sized
 * just above MAX_TOTAL_TEXT_LEN so no legitimate command is rejected at the
 * protocol layer for the sake of JSON punctuation.
 */
export const MAX_FRAME_BYTES = MAX_TOTAL_TEXT_LEN + 1_000_000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isPlainObject(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Walks the ENTIRE parsed payload — not just the fields a command's type
 * declares — for prototype-pollution keys, excess nesting, and oversized
 * arrays/objects, before any field is trusted. A forged sibling property is
 * exactly where a pollution or JSON-bomb attempt hides; checking only the
 * fields we go on to read would let it through unexamined.
 *
 * String VALUE length is deliberately not bounded here: a legitimate prompt
 * is long and a legitimate id is not, so length is checked per field, by
 * role, once we know which field we're looking at (see isLabel/isText
 * below). A value under a key nobody reads is never touched again after
 * this scan, so leaving its length unchecked costs nothing. Object KEYS are
 * bounded, though — `answers` is keyed by arbitrary question text, so a key
 * is exactly as attacker-reachable as a value.
 */
export function scanStructure(v: unknown, depth = 0, budget = { text: MAX_TOTAL_TEXT_LEN }): string | undefined {
  if (depth > MAX_DEPTH) return `nesting too deep (max ${MAX_DEPTH})`;
  if (typeof v === 'string') {
    // Charged whatever field it is under, declared or not. A per-field check
    // cannot see an undeclared one, which is precisely where the cost hid.
    budget.text -= v.length;
    return budget.text < 0 ? `too much text in one command (max ${MAX_TOTAL_TEXT_LEN})` : undefined;
  }
  if (Array.isArray(v)) {
    if (v.length > MAX_ARRAY_LEN) return `array has too many entries (max ${MAX_ARRAY_LEN})`;
    for (const item of v) {
      const err = scanStructure(item, depth + 1, budget);
      if (err) return err;
    }
    return undefined;
  }
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length > MAX_ARRAY_LEN) return `object has too many keys (max ${MAX_ARRAY_LEN})`;
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) return `forbidden key "${key}"`;
      if (key.length > MAX_TEXT_LEN) return 'object key too long';
      budget.text -= key.length;
      if (budget.text < 0) return `too much text in one command (max ${MAX_TOTAL_TEXT_LEN})`;
      const err = scanStructure(v[key], depth + 1, budget);
      if (err) return err;
    }
  }
  return undefined;
}

/** Short, fixed-size preview for naming attacker-supplied text (here, only
 * an unrecognized `type`) inside a reason string without echoing it whole. */
export function truncateForLog(s: string, max = 64): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export const isLabel: Test = (v) => typeof v === 'string' && v.length <= MAX_LABEL_LEN;
export const isText: Test = (v) => typeof v === 'string' && v.length <= MAX_TEXT_LEN;
export const isNullableLabel: Test = (v) => v === null || isLabel(v);
export const isNum: Test = (v) => typeof v === 'number' && Number.isFinite(v);
export const isBool: Test = (v) => typeof v === 'boolean';

function enumOf<T extends string>(values: readonly T[]): Test {
  const set = new Set<string>(values);
  return (v) => typeof v === 'string' && set.has(v);
}

export const AGENT_KINDS = ['claude', 'codex'] as const satisfies readonly AgentKind[];
export const PERMISSION_MODES = [
  'auto', 'default', 'acceptEdits', 'plan', 'bypassPermissions',
] as const satisfies readonly PermissionLaunchMode[];
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const THINKING_MODES = ['adaptive', 'disabled'] as const;
export const PLAN_TIERS = ['auto', 'pro', 'max5x', 'max20x', 'custom'] as const;
export const DEBATE_SUBJECTS = ['diff', 'plan', 'last'] as const;
export const FINISH_ACTIONS = ['notify', 'memory', 'commit', 'sleep', 'shutdown', 'script'] as const;
export const DIRECTIONS = ['up', 'down'] as const;
export const BULK_OPS = ['approve_all', 'interrupt_all'] as const;

export const isAgentKind = enumOf(AGENT_KINDS);
export const isPermissionMode = enumOf(PERMISSION_MODES);
export const isEffortLevel = enumOf(EFFORT_LEVELS);
export const isThinkingMode = enumOf(THINKING_MODES);
export const isPlanTier = enumOf(PLAN_TIERS);
export const isDebateSubject = enumOf(DEBATE_SUBJECTS);
export const isFinishAction = enumOf(FINISH_ACTIONS);
export const isDirection = enumOf(DIRECTIONS);
export const isBulkOp = enumOf(BULK_OPS);

/** Builds a FieldCheck for one scalar/enum field. Absence is only an error
 * when the field is required — an absent optional field is simply skipped,
 * which is how "present but wrong type" stays distinguishable from "absent"
 * in the reason text. */
export function field(key: string, required: boolean, test: Test, what: string): FieldCheck {
  return (o, type) => {
    const v = o[key];
    if (v === undefined) return required ? `${type}: ${key} is required` : undefined;
    return test(v) ? undefined : `${type}: ${key} must be ${what}`;
  };
}

export function runChecks(type: string, o: Rec, checks: FieldCheck[]): string | undefined {
  for (const check of checks) {
    const err = check(o, type);
    if (err) return err;
  }
  return undefined;
}

// ---- nested shapes shared by more than one command, or too irregular for field() ----

/** send_prompt's optional attachments — see shared/src/prompt-image.ts. */
export const imagesField: FieldCheck = (o, type) => {
  const v = o.images;
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return `${type}: images must be an array`;
  if (v.length > MAX_IMAGES_PER_PROMPT) return `${type}: images has too many entries (max ${MAX_IMAGES_PER_PROMPT})`;
  for (let i = 0; i < v.length; i++) {
    const img = v[i];
    if (!isPlainObject(img)) return `${type}: images[${i}] must be an object`;
    if (!isLabel(img.mediaType)) return `${type}: images[${i}].mediaType must be a string`;
    if (typeof img.data !== 'string' || img.data.length > MAX_IMAGE_DATA_LEN) {
      return `${type}: images[${i}].data must be a string`;
    }
    if (!isLabel(img.name)) return `${type}: images[${i}].name must be a string`;
  }
  return undefined;
};

/** save_template's payload — see SessionTemplate in shared/src/index.ts. */
export const templateField: FieldCheck = (o, type) => {
  const v = o.template;
  if (!isPlainObject(v)) return `${type}: template is required`;
  if (!isLabel(v.name)) return `${type}: template.name must be a string`;
  if (!isLabel(v.cwd)) return `${type}: template.cwd must be a string`;
  if (v.prompt !== undefined && !isText(v.prompt)) return `${type}: template.prompt must be a string`;
  if (!isPermissionMode(v.permissionMode)) return `${type}: template.permissionMode must be a known permission mode`;
  return undefined;
};

/** save_toolkit_action's payload — see ToolkitAction in shared/src/index.ts. */
export const toolkitActionField: FieldCheck = (o, type) => {
  const v = o.action;
  if (!isPlainObject(v)) return `${type}: action is required`;
  if (!isLabel(v.id)) return `${type}: action.id must be a string`;
  if (!isLabel(v.name)) return `${type}: action.name must be a string`;
  if (typeof v.prompt !== 'string' || v.prompt.length > MAX_TEXT_LEN) return `${type}: action.prompt must be a string`;
  if (v.cwd !== undefined && !isLabel(v.cwd)) return `${type}: action.cwd must be a string`;
  return undefined;
};

/** answer_question's answers — keyed by question text, per AskUserQuestion.
 * Key length and count are bounded generically by scanStructure; only the
 * value's type is this field's own business. */
export const answersField: FieldCheck = (o, type) => {
  const v = o.answers;
  if (!isPlainObject(v)) return `${type}: answers is required`;
  for (const key of Object.keys(v)) {
    if (typeof v[key] !== 'string' || (v[key] as string).length > MAX_TEXT_LEN) {
      return `${type}: answers values must be strings`;
    }
  }
  return undefined;
};

/** start_crew's worker list — dealt round-robin, so never empty and never long. */
export const workersField: FieldCheck = (o, type) => {
  const v = o.workers;
  if (!Array.isArray(v) || v.length === 0 || v.length > MAX_WORKERS) {
    return `${type}: workers must be a non-empty array of agent kinds`;
  }
  for (const item of v) {
    if (!isAgentKind(item)) return `${type}: workers must be a non-empty array of agent kinds`;
  }
  return undefined;
};
