import { AlertTriangle } from 'lucide-react';
import type { DataProvenance, ProviderInfo } from '../../../packages/core/src/marketData.ts';

/** Banner copy is derived from the active provider so fixture or licensed data is never labelled as demo, or vice versa. */
export function DataBanner({ provider }: { provider: ProviderInfo | null }) {
  const [title, text] =
    provider === null ? ['Checking data source…', 'Values below are not confirmed until the API reports its provider.']
    : provider.kind === 'demo' ? ['Synthetic market data.', 'All tickers, prices and returns are fictional and generated for testing. Nothing here is live NSE data or investment advice.']
    : provider.kind === 'fixture' ? ['Synthetic fixture data.', 'Test instruments loaded from a local file, including deliberate gaps and bad rows. Not market data or investment advice.']
    : [`Licensed data · ${provider.name} (${provider.exchange}, ${provider.currency}).`, 'Check each instrument’s as-of date and freshness before relying on it. Not investment advice.'];
  return <div className={`demo-banner ${provider?.kind === 'licensed' ? 'licensed' : ''}`} title={provider ? `Licence: ${provider.license}` : undefined}>
    <AlertTriangle size={18}/><span><strong>{title}</strong> {text}</span>
  </div>;
}

const FRESHNESS_LABEL: Record<DataProvenance['freshness'], string> = {
  fresh: 'up to date', stale: 'stale', unknown: 'freshness unknown', 'not-applicable': 'generated data'
};

export const dataKindLabel = (p: DataProvenance | undefined) =>
  !p ? 'data' : p.kind === 'demo' ? 'demo data' : p.kind === 'fixture' ? 'fixture data' : `${p.exchange} data`;

/** One line of provenance plus explicit warnings for stale data, gaps and rejected rows. */
export function ProvenanceLine({ provenance }: { provenance: DataProvenance | undefined }) {
  if (!provenance) return null;
  const warnings = [
    provenance.freshness === 'stale' && 'Data is stale: completed sessions are missing since the last observation.',
    provenance.missingDates.length > 0 && `${provenance.missingDates.length} missing session${provenance.missingDates.length === 1 ? '' : 's'} inside the series.`,
    provenance.rejected.length > 0 && `${provenance.rejected.length} provider row${provenance.rejected.length === 1 ? ' was' : 's were'} rejected as invalid.`
  ].filter((w): w is string => typeof w === 'string');
  return <div className="provenance">
    <p title={`Licence: ${provenance.license} · ingested ${provenance.ingestedAt}`}>
      Source: {provenance.providerId} · {provenance.exchange} · {provenance.currency} · as of {provenance.observedAt ?? 'n/a'} · <span className={`fresh-${provenance.freshness}`}>{FRESHNESS_LABEL[provenance.freshness]}</span>
    </p>
    {warnings.map(w => <p key={w} className="provenance-warning"><AlertTriangle size={12}/> {w}</p>)}
  </div>;
}
