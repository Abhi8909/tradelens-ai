import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { AlertTriangle, History, Lock, NotebookPen, Plus, Save } from 'lucide-react';
import { changedFields, createThesis, latestVersion, reviseThesis } from '../../../packages/core/src/thesis.ts';
import { backupAndResetThesisStore, loadThesisStore, updateThesisStore, type ThesisStore, type ThesisStoreLoad } from '../../../packages/core/src/thesisStore.ts';
import type { StockSummary, Thesis, ThesisContent, ThesisVersion } from '../../../packages/core/src/types.ts';

type Draft = { symbol: string; hypothesis: string; supporting: string; opposing: string; invalidation: string; horizon: string; changeNote: string };
type JournalLoad = ThesisStoreLoad | { status: 'unavailable' };
const FIELD_LABELS: Record<keyof ThesisContent, string> = {
  symbol: 'instrument', hypothesis: 'hypothesis', supportingEvidence: 'supporting evidence',
  opposingEvidence: 'opposing evidence', invalidationCriteria: 'invalidation criteria', timeHorizonDays: 'time horizon'
};
const dateTime = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
const AsOf = ({ iso }: { iso: string }) => <time dateTime={iso} title={iso}>{dateTime.format(new Date(iso))}</time>;

function toDraft(content: ThesisContent | undefined, symbol: string): Draft {
  return content
    ? { symbol: content.symbol, hypothesis: content.hypothesis, supporting: content.supportingEvidence.join('\n'), opposing: content.opposingEvidence.join('\n'), invalidation: content.invalidationCriteria, horizon: String(content.timeHorizonDays), changeNote: '' }
    : { symbol, hypothesis: '', supporting: '', opposing: '', invalidation: '', horizon: '90', changeNote: '' };
}
function toInput(draft: Draft) {
  return {
    symbol: draft.symbol, hypothesis: draft.hypothesis, invalidationCriteria: draft.invalidation,
    supportingEvidence: draft.supporting.split('\n'), opposingEvidence: draft.opposing.split('\n'),
    timeHorizonDays: draft.horizon.trim() === '' ? NaN : Number(draft.horizon)
  };
}
function initialLoad(): JournalLoad {
  try { return loadThesisStore(localStorage); } catch { return { status: 'unavailable' }; }
}
const byLatest = (a: Thesis, b: Thesis) => latestVersion(b).asOf.localeCompare(latestVersion(a).asOf);

function VersionView({ version }: { version: ThesisVersion }) {
  const c = version.content;
  const list = (items: string[]) => items.length ? <ul>{items.map((item, i) => <li key={i}>{item}</li>)}</ul> : <p className="muted">None recorded.</p>;
  return <div className="thesis-readonly">
    <p className="readonly-banner"><Lock size={14}/> Version {version.version} · as of <AsOf iso={version.asOf}/> · read-only</p>
    {version.changeNote && <p className="muted">Change note: {version.changeNote}</p>}
    <dl>
      <dt>Instrument</dt><dd>{c.symbol}</dd>
      <dt>Hypothesis</dt><dd>{c.hypothesis}</dd>
      <dt>Supporting evidence</dt><dd>{list(c.supportingEvidence)}</dd>
      <dt>Opposing evidence</dt><dd>{list(c.opposingEvidence)}</dd>
      <dt>Invalidation criteria</dt><dd>{c.invalidationCriteria}</dd>
      <dt>Time horizon</dt><dd>{c.timeHorizonDays} days</dd>
    </dl>
  </div>;
}

export default function ThesisJournal({ stocks, defaultSymbol }: { stocks: StockSummary[]; defaultSymbol: string }) {
  const [load, setLoad] = useState<JournalLoad>(initialLoad);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [baseline, setBaseline] = useState<Draft>(() => toDraft(undefined, defaultSymbol));
  const [draft, setDraft] = useState<Draft>(baseline);
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState('');

  const theses = useMemo(() => load.status === 'ok' ? [...load.store.theses].sort(byLatest) : [], [load]);
  const selected = theses.find(t => t.id === selectedId);
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  const symbols = useMemo(() => [...new Set([...stocks.map(s => s.symbol), draft.symbol])], [stocks, draft.symbol]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function open(thesis: Thesis | null) {
    if (dirty && !window.confirm('Discard your unsaved thesis edits?')) return;
    const next = toDraft(thesis ? latestVersion(thesis).content : undefined, defaultSymbol);
    setSelectedId(thesis?.id ?? null); setViewing(null); setBaseline(next); setDraft(next); setErrors([]); setNotice('');
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const now = new Date();
    const input = toInput(draft);
    const baseVersion = selected ? latestVersion(selected).version : 0;
    const id = selectedId ?? crypto.randomUUID();
    let result;
    try {
      result = updateThesisStore(localStorage, (store: ThesisStore) => {
        if (!selectedId) {
          const created = createThesis(input, { id, now, changeNote: draft.changeNote });
          return created.ok ? { ok: true, value: { ...store, theses: [...store.theses, created.value] } } : created;
        }
        const current = store.theses.find(t => t.id === selectedId);
        if (!current) return { ok: false, errors: ['this thesis is no longer in browser storage'] };
        if (latestVersion(current).version !== baseVersion) return { ok: false, errors: ['this thesis was updated in another tab; copy your edits, then reload the page'] };
        const revised = reviseThesis(current, input, { now, changeNote: draft.changeNote });
        return revised.ok ? { ok: true, value: { ...store, theses: store.theses.map(t => t.id === selectedId ? revised.value : t) } } : revised;
      });
    } catch {
      result = { ok: false as const, errors: ['browser storage is unavailable'] };
    }
    if (!result.ok) { setErrors(result.errors); setNotice(''); return; }
    const saved = result.value.theses.find(t => t.id === id)!;
    const next = toDraft(latestVersion(saved).content, defaultSymbol);
    setLoad({ status: 'ok', store: result.value }); setSelectedId(id); setViewing(null);
    setBaseline(next); setDraft(next); setErrors([]);
    setNotice(`Saved version ${latestVersion(saved).version}. Earlier versions are kept unchanged.`);
  }

  function resetCorrupt(raw: string) {
    if (!window.confirm('Back up the unreadable journal data in browser storage and start an empty journal?')) return;
    const result = backupAndResetThesisStore(localStorage, raw, new Date());
    if (!result.ok) { setErrors(result.errors); return; }
    setLoad(initialLoad()); setErrors([]); setNotice(`Previous data backed up under the browser storage key "${result.value}".`);
  }

  const field = (key: keyof Draft, label: string, rows: number, helper?: string) =>
    <label className="form-field thesis-field"><span>{label}</span>
      <textarea rows={rows} value={draft[key]} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}/>
      {helper && <small>{helper}</small>}
    </label>;

  if (load.status !== 'ok') {
    return <div className="panel thesis-blocked" role="alert"><AlertTriangle size={20}/>
      {load.status === 'unavailable'
        ? <p>Browser storage is unavailable (for example, in a private window with storage blocked), so theses cannot be saved here.</p>
        : <div><p><strong>Your saved journal could not be read:</strong> {load.reason}.</p>
          <p className="muted">It has been left untouched and saving is disabled so it is not overwritten. You can download the raw data, then back it up and start a new journal.</p>
          <div className="thesis-actions">
            <a className="text-btn" download="tradelens-thesis-journal.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(load.raw)}`}>Download raw data</a>
            <button className="text-btn" onClick={() => resetCorrupt(load.raw)}>Back up and start new journal</button>
          </div>
          {errors.map(error => <p key={error} className="error">{error}</p>)}</div>}
    </div>;
  }

  const viewed = selected && viewing !== null ? selected.versions.find(v => v.version === viewing) : undefined;
  return <div className="thesis-layout">
    <div className="panel thesis-list">
      <div className="section-head"><div><p className="eyebrow">MY THESES</p><h3>{theses.length} saved</h3></div>
        <button className="text-btn" onClick={() => open(null)}><Plus size={15}/> New</button></div>
      {theses.length === 0 && <p className="muted">No theses yet. Write down a hypothesis, the evidence for and against it, and what would prove it wrong.</p>}
      {theses.map(t => { const latest = latestVersion(t); return <button key={t.id} className={`thesis-item ${t.id === selectedId ? 'active' : ''}`} onClick={() => open(t)}>
        <strong>{latest.content.symbol}</strong><span>{latest.content.hypothesis.slice(0, 90)}{latest.content.hypothesis.length > 90 ? '…' : ''}</span>
        <small>v{latest.version} · updated <AsOf iso={latest.asOf}/></small>
      </button>; })}
    </div>

    <div className="panel thesis-editor">
      <div className="section-head"><div><p className="eyebrow">{selected ? `REVISING · CREATED ${dateTime.format(new Date(selected.createdAt)).toUpperCase()}` : 'NEW THESIS'}</p>
        <h3>{selected ? `${selected.versions[0].content.symbol} thesis` : 'Write a trade thesis'}</h3></div><span className="tag"><NotebookPen size={12}/> Your notes · this browser only</span></div>
      {viewed ? <><VersionView version={viewed}/><button className="text-btn" onClick={() => setViewing(null)}>Back to editing the latest version</button></> :
      <form onSubmit={save}>
        <label className="form-field thesis-field"><span>Instrument</span>
          <select value={draft.symbol} disabled={!!selected} onChange={e => setDraft(d => ({ ...d, symbol: e.target.value }))}>{symbols.map(s => <option key={s} value={s}>{s}</option>)}</select>
          <small>{selected ? 'Fixed for an existing thesis. Start a new thesis for another instrument.' : 'Synthetic demo instruments only.'}</small>
        </label>
        {field('hypothesis', 'Hypothesis', 3)}
        <div className="thesis-two">
          {field('supporting', 'Supporting evidence', 4, 'One item per line')}
          {field('opposing', 'Opposing evidence', 4, 'One item per line. What would a sceptic say?')}
        </div>
        {field('invalidation', 'Invalidation criteria', 2, 'What observation would show this thesis is wrong?')}
        <div className="thesis-two">
          <label className="form-field thesis-field"><span>Time horizon (days)</span><input type="number" min="1" max="3650" step="1" value={draft.horizon} onChange={e => setDraft(d => ({ ...d, horizon: e.target.value }))}/></label>
          <label className="form-field thesis-field"><span>Change note (optional)</span><input value={draft.changeNote} maxLength={280} onChange={e => setDraft(d => ({ ...d, changeNote: e.target.value }))} placeholder={selected ? 'Why are you revising?' : 'Initial version'}/></label>
        </div>
        {errors.length > 0 && <div role="alert" className="error"><ul>{errors.map(error => <li key={error}>{error}</li>)}</ul></div>}
        {notice && <p role="status" className="thesis-notice">{notice}</p>}
        <div className="thesis-actions">
          <button className="primary" type="submit" disabled={!dirty}><Save size={16}/> {selected ? `Save as version ${latestVersion(selected).version + 1}` : 'Save thesis'}</button>
          {dirty && <span className="muted">Unsaved changes</span>}
        </div>
        <p className="tiny-note"><AlertTriangle size={14}/> A thesis records your own reasoning at a point in time. TradeLens does not evaluate it, and it is not investment advice. Saving never edits earlier versions.</p>
      </form>}
    </div>

    {selected && <div className="panel thesis-history">
      <div className="section-head"><div><p className="eyebrow">VERSION HISTORY</p><h3>{selected.versions.length} version{selected.versions.length === 1 ? '' : 's'}</h3></div><History size={18} color="#86a4e6"/></div>
      <ol reversed>{[...selected.versions].reverse().map(v => {
        const previous = selected.versions[v.version - 2];
        const changes = previous ? changedFields(previous.content, v.content).map(f => FIELD_LABELS[f]).join(', ') : 'original thesis';
        return <li key={v.version}><button className={`history-item ${viewing === v.version ? 'active' : ''}`} onClick={() => setViewing(v.version)} aria-label={`View version ${v.version} read-only`}>
          <strong>v{v.version}{v.version === 1 ? ' · Original' : ''}</strong><small>as of <AsOf iso={v.asOf}/></small><span>{changes}</span>{v.changeNote && <em>“{v.changeNote}”</em>}
        </button></li>;
      })}</ol>
    </div>}
  </div>;
}
