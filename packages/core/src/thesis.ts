import type { Result, Thesis, ThesisContent, ThesisVersion } from './types.ts';

export const THESIS_LIMITS = {
  hypothesis: 2000, invalidationCriteria: 1000, evidenceItem: 500, evidenceItems: 20,
  changeNote: 280, maxHorizonDays: 3650, maxVersions: 200
} as const;
const SYMBOL = /^[A-Z0-9][A-Z0-9-]{0,19}$/;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FIELDS: (keyof ThesisContent)[] = ['symbol', 'hypothesis', 'supportingEvidence', 'opposingEvidence', 'invalidationCriteria', 'timeHorizonDays'];

const fail = <T>(...errors: string[]): Result<T> => ({ ok: false, errors });
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isIsoTimestamp = (value: unknown): value is string =>
  typeof value === 'string' && ISO.test(value) && new Date(value).toISOString() === value;

function text(value: unknown, field: string, max: number, errors: string[]): string {
  if (typeof value !== 'string') { errors.push(`${field} must be text`); return ''; }
  const trimmed = value.trim();
  if (!trimmed) errors.push(`${field} is required`);
  else if (trimmed.length > max) errors.push(`${field} must be at most ${max} characters`);
  return trimmed;
}

function evidence(value: unknown, field: string, errors: string[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) { errors.push(`${field} must be a list of text items`); return []; }
  const items = value.map((item) => item.trim()).filter(Boolean);
  if (items.length > THESIS_LIMITS.evidenceItems) errors.push(`${field} allows at most ${THESIS_LIMITS.evidenceItems} items`);
  if (items.some((item) => item.length > THESIS_LIMITS.evidenceItem)) errors.push(`${field} items must be at most ${THESIS_LIMITS.evidenceItem} characters`);
  return items;
}

/** Validate untrusted input and return a normalized (trimmed, empty lines removed) copy. */
export function validateThesisContent(input: unknown): Result<ThesisContent> {
  if (!isRecord(input)) return fail('thesis must be an object');
  const errors: string[] = [];
  const symbol = typeof input.symbol === 'string' ? input.symbol.trim() : '';
  if (!SYMBOL.test(symbol)) errors.push('symbol must be an instrument symbol such as DEMO-ALPHA');
  const content: ThesisContent = {
    symbol,
    hypothesis: text(input.hypothesis, 'hypothesis', THESIS_LIMITS.hypothesis, errors),
    supportingEvidence: evidence(input.supportingEvidence, 'supportingEvidence', errors),
    opposingEvidence: evidence(input.opposingEvidence, 'opposingEvidence', errors),
    invalidationCriteria: text(input.invalidationCriteria, 'invalidationCriteria', THESIS_LIMITS.invalidationCriteria, errors),
    timeHorizonDays: typeof input.timeHorizonDays === 'number' ? input.timeHorizonDays : NaN
  };
  if (!Number.isInteger(content.timeHorizonDays) || content.timeHorizonDays < 1 || content.timeHorizonDays > THESIS_LIMITS.maxHorizonDays) {
    errors.push(`timeHorizonDays must be a whole number from 1 to ${THESIS_LIMITS.maxHorizonDays}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: content };
}

function changeNoteOf(raw: unknown): Result<string> {
  if (raw === undefined) return { ok: true, value: '' };
  if (typeof raw !== 'string') return fail('changeNote must be text');
  const note = raw.trim();
  return note.length > THESIS_LIMITS.changeNote ? fail(`changeNote must be at most ${THESIS_LIMITS.changeNote} characters`) : { ok: true, value: note };
}

function frozenVersion(version: number, asOf: string, changeNote: string, content: ThesisContent): ThesisVersion {
  return Object.freeze({
    version, asOf, changeNote,
    content: Object.freeze({ ...content, supportingEvidence: Object.freeze([...content.supportingEvidence]) as string[], opposingEvidence: Object.freeze([...content.opposingEvidence]) as string[] })
  });
}

function timestamp(now: Date): Result<string> {
  return now instanceof Date && Number.isFinite(now.getTime()) ? { ok: true, value: now.toISOString() } : fail('now must be a valid date');
}

export function createThesis(input: unknown, options: { id: string; now: Date; changeNote?: unknown }): Result<Thesis> {
  if (!ID.test(options.id)) return fail('id must be 1-64 letters, digits or hyphens');
  const asOf = timestamp(options.now);
  if (!asOf.ok) return asOf;
  const content = validateThesisContent(input);
  if (!content.ok) return content;
  const note = changeNoteOf(options.changeNote);
  if (!note.ok) return note;
  return { ok: true, value: { id: options.id, createdAt: asOf.value, versions: [frozenVersion(1, asOf.value, note.value, content.value)] } };
}

export const originalVersion = (thesis: Thesis): ThesisVersion => thesis.versions[0];
export const latestVersion = (thesis: Thesis): ThesisVersion => thesis.versions[thesis.versions.length - 1];

export function changedFields(previous: ThesisContent, next: ThesisContent): (keyof ThesisContent)[] {
  return FIELDS.filter((field) => JSON.stringify(previous[field]) !== JSON.stringify(next[field]));
}

/** Append a new version. Earlier versions are reused as-is, never edited, and the as-of time must move forward. */
export function reviseThesis(thesis: Thesis, input: unknown, options: { now: Date; changeNote?: unknown }): Result<Thesis> {
  const asOf = timestamp(options.now);
  if (!asOf.ok) return asOf;
  const content = validateThesisContent(input);
  if (!content.ok) return content;
  const note = changeNoteOf(options.changeNote);
  if (!note.ok) return note;
  const latest = latestVersion(thesis);
  if (content.value.symbol !== originalVersion(thesis).content.symbol) return fail('the instrument of an existing thesis cannot be changed; start a new thesis instead');
  if (asOf.value <= latest.asOf) return fail(`as-of time ${asOf.value} must be after the latest version (${latest.asOf}); backdating is not allowed`);
  if (changedFields(latest.content, content.value).length === 0) return fail('no changes to save');
  if (thesis.versions.length >= THESIS_LIMITS.maxVersions) return fail(`a thesis can have at most ${THESIS_LIMITS.maxVersions} versions`);
  return { ok: true, value: { ...thesis, versions: [...thesis.versions, frozenVersion(latest.version + 1, asOf.value, note.value, content.value)] } };
}

/** Validate a stored thesis, including the integrity of its version history. */
export function validateThesis(raw: unknown): Result<Thesis> {
  if (!isRecord(raw)) return fail('thesis must be an object');
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return fail('thesis id is invalid');
  if (!Array.isArray(raw.versions) || raw.versions.length === 0) return fail(`thesis ${raw.id} has no versions`);
  if (raw.versions.length > THESIS_LIMITS.maxVersions) return fail(`thesis ${raw.id} has too many versions`);
  const versions: ThesisVersion[] = [];
  for (const [index, item] of raw.versions.entries()) {
    const label = `thesis ${raw.id} version ${index + 1}`;
    if (!isRecord(item)) return fail(`${label} must be an object`);
    if (item.version !== index + 1) return fail(`${label} is out of sequence`);
    if (!isIsoTimestamp(item.asOf)) return fail(`${label} has an invalid as-of time`);
    if (index > 0 && item.asOf <= versions[index - 1].asOf) return fail(`${label} is not later than the previous version`);
    const note = changeNoteOf(item.changeNote);
    if (!note.ok) return fail(`${label}: ${note.errors.join('; ')}`);
    const content = validateThesisContent(item.content);
    if (!content.ok) return fail(...content.errors.map((error) => `${label}: ${error}`));
    if (index > 0 && content.value.symbol !== versions[0].content.symbol) return fail(`${label} changes the instrument`);
    versions.push(frozenVersion(index + 1, item.asOf, note.value, content.value));
  }
  if (raw.createdAt !== versions[0].asOf) return fail(`thesis ${raw.id} createdAt must equal the original version's as-of time`);
  return { ok: true, value: { id: raw.id, createdAt: versions[0].asOf, versions } };
}
