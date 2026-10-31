import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info } from 'lucide-react';
import { D } from '../../../packages/core/src/mtf/decimal.ts';
export const inr = (value: string | null) => {
  if (value === null) return '—';
  const fixed = new D(value).toFixed(2); const [whole, fraction] = fixed.replace('-', '').split('.');
  return `${fixed.startsWith('-') ? '-' : ''}₹${new Intl.NumberFormat('en-IN').format(BigInt(whole))}.${fraction}`;
};
type QuoteState = 'LIVE' | 'DELAYED' | 'EOD' | 'MANUAL' | 'STALE' | 'UNAVAILABLE';
function QuoteTimestamp({ at, source }: { at: string; source: string }) {
  const id = useId();
  const [position, setPosition] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const show = () => {
    const rect = button.current?.getBoundingClientRect();
    if (!rect) return;
    const below = rect.top < 52;
    setPosition({ left: Math.min(window.innerWidth - 132, Math.max(132, rect.left + rect.width / 2)), top: below ? rect.bottom + 8 : rect.top - 8, below });
  };
  useEffect(() => {
    if (!position) return;
    const hide = () => setPosition(null);
    window.addEventListener('scroll', hide, true); window.addEventListener('resize', hide);
    return () => { window.removeEventListener('scroll', hide, true); window.removeEventListener('resize', hide); };
  }, [position]);
  return <>
    <button ref={button} type="button" className="mtf-quote-info" aria-label={`Quote timestamp: ${source}`} aria-describedby={position ? id : undefined}
      onMouseEnter={show} onMouseLeave={() => setPosition(null)} onFocus={show} onBlur={() => setPosition(null)} onClick={show} onKeyDown={event => { if (event.key === 'Escape') setPosition(null); }}>
      <Info size={15} aria-hidden="true"/>
    </button>
    {position && createPortal(<div id={id} role="tooltip" className={`mtf-quote-tooltip${position.below ? ' below' : ''}`} style={{ left: position.left, top: position.top }}>
      {new Date(at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
    </div>, document.body)}
  </>;
}
export function PriceQuote({ price, source, state, at, closed }: { price: string | null; source: string; state: QuoteState; at: string | null; closed: boolean }) {
  if (closed) return <div className="mtf-quote mtf-quote-exited"><strong>—</strong><span>Exited position</span></div>;
  const label = source.startsWith('NSE official MCP') ? 'NSE' : state === 'MANUAL' ? 'Manual entry' : state === 'UNAVAILABLE' ? 'No quote' : 'Market feed';
  const status = { LIVE: 'Live', DELAYED: 'Delayed', EOD: 'LTP', MANUAL: 'Unverified', STALE: 'Stale', UNAVAILABLE: 'Unavailable' }[state];
  return <div className="mtf-quote">
    <strong className="mtf-quote-value">{inr(price)}</strong>
    <div className="mtf-quote-meta">
      {at && <QuoteTimestamp at={at} source={label}/>}
      <span className={`mtf-quote-badge mtf-quote-${state.toLowerCase()}`}>{status}</span>
    </div>
  </div>;
}
