import test from 'node:test';
import assert from 'node:assert/strict';
import { THESIS_LIMITS, changedFields, createThesis, latestVersion, originalVersion, reviseThesis, validateThesis, validateThesisContent } from '../src/thesis.ts';
import type { Thesis } from '../src/types.ts';

const content = {
  symbol: 'DEMO-ALPHA',
  hypothesis: '  Synthetic order book recovers over the next quarter.  ',
  supportingEvidence: ['Demo close above 20-day SMA', '  ', 'Lower demo volatility'],
  opposingEvidence: ['RSI near 70 in the demo series'],
  invalidationCriteria: 'Demo close below 90 for five sessions',
  timeHorizonDays: 90
};
const t0 = new Date('2026-10-01T09:00:00.000Z');
const t1 = new Date('2026-10-02T09:00:00.000Z');
const t2 = new Date('2026-10-03T09:00:00.000Z');

function created(): Thesis {
  const result = createThesis(content, { id: 'thesis-1', now: t0 });
  assert.ok(result.ok);
  return result.value;
}

test('validateThesisContent normalizes text and evidence lists', () => {
  const result = validateThesisContent(content);
  assert.ok(result.ok);
  assert.equal(result.value.hypothesis, 'Synthetic order book recovers over the next quarter.');
  assert.deepEqual(result.value.supportingEvidence, ['Demo close above 20-day SMA', 'Lower demo volatility']);
  assert.deepEqual(validateThesisContent({ ...content, opposingEvidence: [] }).ok, true, 'evidence lists may be empty');
});

test('validateThesisContent reports every invalid field', () => {
  assert.deepEqual(validateThesisContent(null), { ok: false, errors: ['thesis must be an object'] });
  assert.equal(validateThesisContent([]).ok, false);
  const result = validateThesisContent({ symbol: 'demo alpha', hypothesis: ' ', supportingEvidence: 'one', opposingEvidence: [1], invalidationCriteria: 7, timeHorizonDays: 1.5 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.errors.length, 6);
    for (const field of ['symbol', 'hypothesis', 'supportingEvidence', 'opposingEvidence', 'invalidationCriteria', 'timeHorizonDays']) {
      assert.ok(result.errors.some((e) => e.includes(field)), `missing error for ${field}`);
    }
  }
});

test('validateThesisContent enforces length, count and range limits', () => {
  const invalid = [
    { hypothesis: 'x'.repeat(THESIS_LIMITS.hypothesis + 1) },
    { invalidationCriteria: 'x'.repeat(THESIS_LIMITS.invalidationCriteria + 1) },
    { supportingEvidence: Array(THESIS_LIMITS.evidenceItems + 1).fill('item') },
    { opposingEvidence: ['x'.repeat(THESIS_LIMITS.evidenceItem + 1)] },
    { timeHorizonDays: 0 }, { timeHorizonDays: THESIS_LIMITS.maxHorizonDays + 1 }, { timeHorizonDays: '90' }, { timeHorizonDays: NaN },
    { symbol: '' }, { symbol: '-DEMO' }, { symbol: 'A'.repeat(21) }
  ];
  for (const patch of invalid) assert.equal(validateThesisContent({ ...content, ...patch }).ok, false, JSON.stringify(patch).slice(0, 60));
  assert.equal(validateThesisContent({ ...content, timeHorizonDays: THESIS_LIMITS.maxHorizonDays, hypothesis: 'x'.repeat(THESIS_LIMITS.hypothesis) }).ok, true);
});

test('createThesis records an explicit as-of time and creation date', () => {
  const thesis = created();
  assert.equal(thesis.createdAt, '2026-10-01T09:00:00.000Z');
  assert.equal(thesis.versions.length, 1);
  assert.deepEqual({ ...originalVersion(thesis), content: undefined }, { version: 1, asOf: thesis.createdAt, changeNote: '', content: undefined });
  assert.equal(createThesis(content, { id: 'bad id!', now: t0 }).ok, false);
  assert.equal(createThesis(content, { id: 'ok', now: new Date('nope') }).ok, false);
  assert.equal(createThesis({ ...content, hypothesis: '' }, { id: 'ok', now: t0 }).ok, false);
  assert.equal(createThesis(content, { id: 'ok', now: t0, changeNote: 'x'.repeat(THESIS_LIMITS.changeNote + 1) }).ok, false);
});

test('reviseThesis appends a version and leaves the original untouched', () => {
  const thesis = created();
  const snapshot = JSON.stringify(thesis);
  const result = reviseThesis(thesis, { ...content, opposingEvidence: [...content.opposingEvidence, 'Sector demo index weakening'] }, { now: t1, changeNote: 'Added counterpoint' });
  assert.ok(result.ok);
  const revised = result.value;
  assert.equal(JSON.stringify(thesis), snapshot, 'input thesis not mutated');
  assert.equal(revised.versions.length, 2);
  assert.equal(revised.versions[0], thesis.versions[0], 'original version is carried over by reference');
  assert.equal(revised.createdAt, thesis.createdAt);
  assert.deepEqual({ version: latestVersion(revised).version, asOf: latestVersion(revised).asOf, note: latestVersion(revised).changeNote }, { version: 2, asOf: '2026-10-02T09:00:00.000Z', note: 'Added counterpoint' });
  assert.deepEqual(changedFields(revised.versions[0].content, revised.versions[1].content), ['opposingEvidence']);
});

test('stored versions are frozen against in-place edits', () => {
  const thesis = created();
  const original = originalVersion(thesis);
  assert.ok(Object.isFrozen(original) && Object.isFrozen(original.content) && Object.isFrozen(original.content.supportingEvidence));
  assert.throws(() => { (original.content as { hypothesis: string }).hypothesis = 'rewritten'; }, TypeError);
  assert.throws(() => { original.content.opposingEvidence.push('sneaky'); }, TypeError);
});

test('reviseThesis rejects backdating, no-op edits and instrument changes', () => {
  const thesis = created();
  const edit = { ...content, hypothesis: 'Updated hypothesis' };
  const sameTime = reviseThesis(thesis, edit, { now: t0 });
  assert.ok(!sameTime.ok && /backdating/.test(sameTime.errors[0]), 'same as-of time');
  const backdated = reviseThesis(thesis, edit, { now: new Date('2026-09-30T00:00:00.000Z') });
  assert.ok(!backdated.ok && /backdating/.test(backdated.errors[0]));
  const noop = reviseThesis(thesis, { ...content, hypothesis: `  ${content.hypothesis}  ` }, { now: t1 });
  assert.ok(!noop.ok && noop.errors[0] === 'no changes to save', 'whitespace-only change is not a revision');
  const moved = reviseThesis(thesis, { ...edit, symbol: 'DEMO-BETA' }, { now: t1 });
  assert.ok(!moved.ok && /instrument/.test(moved.errors[0]));
  assert.equal(reviseThesis(thesis, { ...edit, timeHorizonDays: -1 }, { now: t1 }).ok, false);
  assert.equal(reviseThesis(thesis, edit, { now: t1, changeNote: 42 }).ok, false);
});

test('reviseThesis enforces the version cap', () => {
  let thesis = created();
  for (let i = 1; i < THESIS_LIMITS.maxVersions; i++) {
    const next = reviseThesis(thesis, { ...content, hypothesis: `revision ${i}` }, { now: new Date(t0.getTime() + i * 1000) });
    assert.ok(next.ok);
    thesis = next.value;
  }
  const over = reviseThesis(thesis, { ...content, hypothesis: 'one too many' }, { now: t2 });
  assert.ok(!over.ok && /at most/.test(over.errors[0]));
});

test('validateThesis round-trips JSON and detects tampered history', () => {
  const revised = reviseThesis(created(), { ...content, timeHorizonDays: 120 }, { now: t1 });
  assert.ok(revised.ok);
  const json = () => JSON.parse(JSON.stringify(revised.value));
  const loaded = validateThesis(json());
  assert.ok(loaded.ok);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.value)), json());
  assert.ok(Object.isFrozen(loaded.value.versions[0]));

  const cases: [string, (raw: ReturnType<typeof json>) => unknown, RegExp][] = [
    ['reordered versions', (r) => ({ ...r, versions: [r.versions[1], r.versions[0]] }), /out of sequence/],
    ['backdated later version', (r) => { r.versions[1].asOf = '2026-09-01T00:00:00.000Z'; return r; }, /not later/],
    ['non-ISO timestamp', (r) => { r.versions[0].asOf = '2026-10-01'; return r; }, /as-of/],
    ['impossible date', (r) => { r.versions[0].asOf = '2026-02-30T00:00:00.000Z'; return r; }, /as-of/],
    ['createdAt rewritten', (r) => ({ ...r, createdAt: '2026-01-01T00:00:00.000Z' }), /createdAt/],
    ['instrument changed', (r) => { r.versions[1].content.symbol = 'DEMO-BETA'; return r; }, /instrument/],
    ['invalid content', (r) => { r.versions[1].content.timeHorizonDays = 0; return r; }, /timeHorizonDays/],
    ['no versions', (r) => ({ ...r, versions: [] }), /no versions/],
    ['bad id', (r) => ({ ...r, id: '' }), /id/]
  ];
  for (const [label, tamper, expected] of cases) {
    const result = validateThesis(tamper(json()));
    assert.ok(!result.ok && expected.test(result.errors.join(' ')), label);
  }
});
