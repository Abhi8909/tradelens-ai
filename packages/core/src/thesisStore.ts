import { validateThesis } from './thesis.ts';
import type { Result, Thesis } from './types.ts';

export const THESIS_STORE_KEY = 'tradelens-thesis-journal';
export const THESIS_SCHEMA_VERSION = 1;
export const MAX_THESES = 100;
export type ThesisStore = { schemaVersion: typeof THESIS_SCHEMA_VERSION; theses: Thesis[] };
export type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void };
/** `corrupt` and `unsupported` data must never be overwritten without an explicit, backed-up reset. */
export type ThesisStoreLoad =
  | { status: 'ok'; store: ThesisStore }
  | { status: 'corrupt' | 'unsupported'; reason: string; raw: string };

export const emptyThesisStore = (): ThesisStore => ({ schemaVersion: THESIS_SCHEMA_VERSION, theses: [] });

export function parseThesisStore(raw: string | null): ThesisStoreLoad {
  if (raw === null) return { status: 'ok', store: emptyThesisStore() };
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return { status: 'corrupt', reason: 'saved journal is not valid JSON', raw }; }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { status: 'corrupt', reason: 'saved journal has an unexpected shape', raw };
  const { schemaVersion, theses } = data as Record<string, unknown>;
  if (typeof schemaVersion === 'number' && Number.isInteger(schemaVersion) && schemaVersion > THESIS_SCHEMA_VERSION) {
    return { status: 'unsupported', reason: `saved journal uses schema version ${schemaVersion}, newer than this app supports (${THESIS_SCHEMA_VERSION})`, raw };
  }
  // Older schema versions would be migrated step by step here; version 1 is the first released format.
  if (schemaVersion !== THESIS_SCHEMA_VERSION) return { status: 'corrupt', reason: 'saved journal has a missing or invalid schema version', raw };
  if (!Array.isArray(theses)) return { status: 'corrupt', reason: 'saved journal has no thesis list', raw };
  if (theses.length > MAX_THESES) return { status: 'corrupt', reason: `saved journal has more than ${MAX_THESES} theses`, raw };
  const valid: Thesis[] = [];
  const ids = new Set<string>();
  for (const item of theses) {
    const thesis = validateThesis(item);
    if (!thesis.ok) return { status: 'corrupt', reason: thesis.errors[0], raw };
    if (ids.has(thesis.value.id)) return { status: 'corrupt', reason: `duplicate thesis id ${thesis.value.id}`, raw };
    ids.add(thesis.value.id);
    valid.push(thesis.value);
  }
  return { status: 'ok', store: { schemaVersion: THESIS_SCHEMA_VERSION, theses: valid } };
}

export const serializeThesisStore = (store: ThesisStore): string => JSON.stringify(store);

export function loadThesisStore(storage: KeyValueStorage, key = THESIS_STORE_KEY): ThesisStoreLoad {
  return parseThesisStore(storage.getItem(key));
}

/**
 * Read-modify-write against the *current* stored value, so a change made in another tab is not lost.
 * Nothing is written when the stored data is unreadable, the update fails, or storage throws.
 */
export function updateThesisStore(storage: KeyValueStorage, update: (store: ThesisStore) => Result<ThesisStore>, key = THESIS_STORE_KEY): Result<ThesisStore> {
  let current: ThesisStoreLoad;
  try { current = loadThesisStore(storage, key); } catch { return { ok: false, errors: ['browser storage is unavailable'] }; }
  if (current.status !== 'ok') return { ok: false, errors: [`not saved: ${current.reason}`] };
  const next = update(current.store);
  if (!next.ok) return next;
  if (next.value.theses.length > MAX_THESES) return { ok: false, errors: [`the journal holds at most ${MAX_THESES} theses`] };
  try { storage.setItem(key, serializeThesisStore(next.value)); } catch { return { ok: false, errors: ['not saved: browser storage is full or unavailable'] }; }
  return next;
}

/** Copy unreadable data to a timestamped backup key, then start an empty journal. Returns the backup key. */
export function backupAndResetThesisStore(storage: KeyValueStorage, raw: string, now: Date, key = THESIS_STORE_KEY): Result<string> {
  const backupKey = `${key}.backup.${now.toISOString()}`;
  try {
    storage.setItem(backupKey, raw);
    if (storage.getItem(backupKey) !== raw) return { ok: false, errors: ['backup could not be verified; journal left unchanged'] };
    storage.setItem(key, serializeThesisStore(emptyThesisStore()));
  } catch {
    return { ok: false, errors: ['backup failed: browser storage is full or unavailable; journal left unchanged'] };
  }
  return { ok: true, value: backupKey };
}
