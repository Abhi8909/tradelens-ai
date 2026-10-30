import test from 'node:test';
import assert from 'node:assert/strict';
import { createThesis, reviseThesis } from '../src/thesis.ts';
import {
  MAX_THESES, THESIS_SCHEMA_VERSION, THESIS_STORE_KEY, backupAndResetThesisStore, emptyThesisStore,
  loadThesisStore, parseThesisStore, serializeThesisStore, updateThesisStore, type KeyValueStorage, type ThesisStore
} from '../src/thesisStore.ts';
import type { Thesis } from '../src/types.ts';

const content = { symbol: 'DEMO-GAMMA', hypothesis: 'Demo margins expand', supportingEvidence: ['a'], opposingEvidence: ['b'], invalidationCriteria: 'Demo margin falls', timeHorizonDays: 30 };
const now = new Date('2026-10-01T00:00:00.000Z');

function thesis(id: string): Thesis {
  const result = createThesis(content, { id, now });
  assert.ok(result.ok);
  return result.value;
}
class MemoryStorage implements KeyValueStorage {
  data = new Map<string, string>();
  writes = 0;
  failWrites = false;
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('QuotaExceededError');
    this.writes++;
    this.data.set(key, value);
  }
}
const add = (t: Thesis) => (store: ThesisStore) => ({ ok: true as const, value: { ...store, theses: [...store.theses, t] } });

test('missing storage loads as an empty journal', () => {
  assert.deepEqual(parseThesisStore(null), { status: 'ok', store: emptyThesisStore() });
});

test('a saved journal round-trips', () => {
  const revised = reviseThesis(thesis('t1'), { ...content, timeHorizonDays: 45 }, { now: new Date('2026-10-02T00:00:00.000Z') });
  assert.ok(revised.ok);
  const store: ThesisStore = { schemaVersion: THESIS_SCHEMA_VERSION, theses: [revised.value, thesis('t2')] };
  const loaded = parseThesisStore(serializeThesisStore(store));
  assert.equal(loaded.status, 'ok');
  if (loaded.status === 'ok') assert.equal(serializeThesisStore(loaded.store), serializeThesisStore(store));
});

test('unreadable data is reported as corrupt with the raw text preserved', () => {
  const valid = JSON.parse(serializeThesisStore({ schemaVersion: 1, theses: [thesis('t1')] }));
  const cases: [string, string][] = [
    ['not JSON', '{oops'],
    ['array', '[]'],
    ['missing schema', JSON.stringify({ theses: [] })],
    ['older/unknown schema', JSON.stringify({ schemaVersion: 0, theses: [] })],
    ['string schema', JSON.stringify({ schemaVersion: '1', theses: [] })],
    ['no thesis list', JSON.stringify({ schemaVersion: 1 })],
    ['invalid thesis', JSON.stringify({ schemaVersion: 1, theses: [{ id: 'x', versions: [] }] })],
    ['duplicate ids', JSON.stringify({ ...valid, theses: [valid.theses[0], valid.theses[0]] })],
    ['too many theses', JSON.stringify({ schemaVersion: 1, theses: Array(MAX_THESES + 1).fill(valid.theses[0]) })]
  ];
  for (const [label, raw] of cases) {
    const loaded = parseThesisStore(raw);
    assert.equal(loaded.status, 'corrupt', label);
    assert.equal(loaded.raw, raw, label);
  }
});

test('data from a newer schema version is unsupported, not corrupt', () => {
  const loaded = parseThesisStore(JSON.stringify({ schemaVersion: THESIS_SCHEMA_VERSION + 1, theses: [{ future: true }] }));
  assert.equal(loaded.status, 'unsupported');
  if (loaded.status === 'unsupported') assert.match(loaded.reason, /newer/);
});

test('updateThesisStore writes on success and re-reads current data first', () => {
  const storage = new MemoryStorage();
  assert.ok(updateThesisStore(storage, add(thesis('t1'))).ok);
  // Simulate another tab saving in between: the next update must build on it, not on a stale copy.
  storage.data.set(THESIS_STORE_KEY, serializeThesisStore({ schemaVersion: 1, theses: [thesis('t1'), thesis('other-tab')] }));
  const result = updateThesisStore(storage, add(thesis('t3')));
  assert.ok(result.ok);
  const loaded = loadThesisStore(storage);
  assert.ok(loaded.status === 'ok');
  assert.deepEqual(loaded.store.theses.map((t) => t.id), ['t1', 'other-tab', 't3']);
});

test('updateThesisStore never overwrites unreadable or newer data', () => {
  for (const raw of ['{oops', JSON.stringify({ schemaVersion: 99, theses: [] })]) {
    const storage = new MemoryStorage();
    storage.data.set(THESIS_STORE_KEY, raw);
    const result = updateThesisStore(storage, add(thesis('t1')));
    assert.ok(!result.ok && /not saved/.test(result.errors[0]));
    assert.equal(storage.data.get(THESIS_STORE_KEY), raw);
    assert.equal(storage.writes, 0);
  }
});

test('updateThesisStore reports failed updates and storage errors without writing', () => {
  const storage = new MemoryStorage();
  const rejected = updateThesisStore(storage, () => ({ ok: false, errors: ['no changes to save'] }));
  assert.deepEqual(rejected, { ok: false, errors: ['no changes to save'] });
  assert.equal(storage.writes, 0);

  storage.failWrites = true;
  const full = updateThesisStore(storage, add(thesis('t1')));
  assert.ok(!full.ok && /full or unavailable/.test(full.errors[0]));
  assert.equal(storage.getItem(THESIS_STORE_KEY), null);

  const throwingRead: KeyValueStorage = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('unreachable'); } };
  const blocked = updateThesisStore(throwingRead, add(thesis('t1')));
  assert.ok(!blocked.ok && /unavailable/.test(blocked.errors[0]));
});

test('updateThesisStore enforces the journal size cap', () => {
  const storage = new MemoryStorage();
  const many = Array.from({ length: MAX_THESES + 1 }, (_, i) => thesis(`t${i}`));
  const result = updateThesisStore(storage, (store) => ({ ok: true, value: { ...store, theses: many } }));
  assert.ok(!result.ok && /at most/.test(result.errors[0]));
  assert.equal(storage.writes, 0);
});

test('backupAndResetThesisStore keeps a copy before starting fresh', () => {
  const storage = new MemoryStorage();
  storage.data.set(THESIS_STORE_KEY, '{oops');
  const result = backupAndResetThesisStore(storage, '{oops', new Date('2026-10-30T12:00:00.000Z'));
  assert.deepEqual(result, { ok: true, value: `${THESIS_STORE_KEY}.backup.2026-10-30T12:00:00.000Z` });
  assert.equal(storage.getItem(`${THESIS_STORE_KEY}.backup.2026-10-30T12:00:00.000Z`), '{oops');
  assert.equal(loadThesisStore(storage).status, 'ok');

  const full = new MemoryStorage();
  full.data.set(THESIS_STORE_KEY, '{oops');
  full.failWrites = true;
  const failed = backupAndResetThesisStore(full, '{oops', now);
  assert.ok(!failed.ok && /left unchanged/.test(failed.errors[0]));
  assert.equal(full.getItem(THESIS_STORE_KEY), '{oops');
});
