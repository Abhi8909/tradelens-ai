import { useEffect, useRef, useState } from "react";
import { Download, Info, RefreshCw, X } from "lucide-react";
import type {
  Metric,
  MetricKey,
  RolloverAggregate,
  RolloverDataset,
  RolloverRow,
  RolloverViewRow,
} from "../../../packages/core/src/rolloverTypes.ts";
import "./rollovers.css";
type Month = RolloverDataset["months"][number];
type Payload = {
  selected: Month;
  lastComplete: string | null;
  summary: RolloverAggregate;
  sectors: (RolloverAggregate & { sector: string })[];
  total: number;
  page: number;
  rows: RolloverViewRow[];
  window: string[];
  trend: (RolloverAggregate & { month: string })[];
  matrix: {
    symbol: string;
    average: RolloverViewRow["average"];
    values: { month: string; rollover: Metric; spread: Metric }[];
  }[];
};
type History = {
  symbol: string;
  history: { month: string; row: RolloverRow | null }[];
};
const format = (v: number | null | undefined, digits = 2) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-IN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(v);
const percentage = (v: number | null | undefined) =>
  v == null ? "—" : format(v) + "%";
const monthName = (month: string) =>
  new Date(month + "-01T00:00:00Z").toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const signed = (n: number | null | undefined) =>
  n == null ? "" : n > 0 ? "up" : n < 0 ? "down" : "";
const definitions: Record<MetricKey, string> = {
  spot: "EQ cash close on the exact snapshot date.",
  momPct:
    "100 × (current spot − previous calendar-month spot) / previous spot. Same snapshot policy.",
  nearClose: "Close of the exact contract expiring in the selected month.",
  nextClose: "Close of the next chronological expiry.",
  basisInr: "Near futures close − cash close, on the same date.",
  basisPct:
    "100 × (near close − cash close) / cash close. This is not roll spread.",
  nearOi: "Open interest of the actual expiring near-month contract.",
  nextOi: "Open interest of the next expiry.",
  farOi: "Far OI. Zero only when contract absence is confirmed.",
  totalOi: "Near OI + next OI + far OI, in the same unit.",
  rolloverPct:
    "100 × (next OI + far OI) / total OI. An OI distribution proxy, not traced trader transactions.",
  spreadInr: "Next close − near close.",
  spreadPct:
    "100 × (next close − near close) / near close. Actual calendar roll spread.",
};
type Column = {
  key: MetricKey | "average" | "delta" | "basisAverage" | "spreadAverage";
  label: string;
  compact?: boolean;
};
const columns: Column[] = [
  { key: "spot", label: "Spot close", compact: true },
  { key: "momPct", label: "Spot MoM %", compact: true },
  { key: "nearClose", label: "Near close" },
  { key: "nextClose", label: "Next close" },
  { key: "basisInr", label: "Basis ₹" },
  { key: "basisPct", label: "Basis %" },
  { key: "nearOi", label: "Near OI" },
  { key: "nextOi", label: "Next OI" },
  { key: "farOi", label: "Far OI" },
  { key: "totalOi", label: "Total OI" },
  { key: "rolloverPct", label: "Rollover %", compact: true },
  { key: "average", label: "6M avg. %", compact: true },
  { key: "delta", label: "Δ vs avg. (pp)", compact: true },
  { key: "spreadPct", label: "Roll spread %", compact: true },
  { key: "basisAverage", label: "6M avg. basis %" },
  { key: "spreadAverage", label: "6M avg. spread %" },
];
function valueFor(row: RolloverViewRow, key: Column["key"]): Metric {
  if (key === "average")
    return {
      value: row.average.value,
      reason:
        row.average.count + "/6 valid months: " + row.average.months.join(", "),
    };
  if (key === "basisAverage")
    return { value: row.basisAverage.value, reason: row.basisAverage.reason };
  if (key === "spreadAverage")
    return { value: row.spreadAverage.value, reason: row.spreadAverage.reason };
  return key === "delta" ? row.deltaPp : row.metrics[key];
}
function TrendChart({
  points,
  label,
}: {
  points: { month: string; value: number | null }[];
  label: string;
}) {
  const valid = points.filter((p) => p.value !== null);
  if (!valid.length)
    return <p className="roll-empty">No valid observations for this window.</p>;
  const min = Math.min(...valid.map((p) => p.value!)),
    max = Math.max(...valid.map((p) => p.value!));
  const range = max - min || 1;
  const x = (i: number) => 45 + (i * 510) / Math.max(points.length - 1, 1),
    y = (n: number) => 140 - ((n - min) / range) * 105;
  const segments: string[][] = [];
  let segment: string[] = [];
  points.forEach((p, i) => {
    if (p.value === null) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(x(i) + "," + y(p.value));
  });
  if (segment.length) segments.push(segment);
  return (
    <figure className="roll-chart">
      <svg role="img" aria-label={label} viewBox="0 0 600 185">
        <text x="5" y="25">
          {format(max)}%
        </text>
        <text x="5" y="150">
          {format(min)}%
        </text>
        {[35, 87, 140].map((v) => (
          <line key={v} x1="45" x2="560" y1={v} y2={v} stroke="#26374e" />
        ))}
        {segments.map((s, i) => (
          <polyline
            key={i}
            points={s.join(" ")}
            fill="none"
            stroke="#8cb5ff"
            strokeWidth="2.5"
          />
        ))}
        {points.map((p, i) => (
          <g key={p.month}>
            {p.value !== null && (
              <circle cx={x(i)} cy={y(p.value)} r="4" fill="#a5c8ff">
                <title>
                  {monthName(p.month)}: {percentage(p.value)}
                </title>
              </circle>
            )}
            <text x={x(i)} y="175" textAnchor="middle">
              {p.month.slice(5)} / {p.month.slice(2, 4)}
            </text>
          </g>
        ))}
      </svg>
      <figcaption>{label} · gaps remain blank</figcaption>
    </figure>
  );
}
function SymbolDrawer({
  symbol,
  month,
  onClose,
}: {
  symbol: string;
  month: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<History | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    fetch(
      "/api/rollovers/" +
        encodeURIComponent(symbol) +
        "/history?month=" +
        month,
      { signal: controller.signal },
    )
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        setData(body);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [symbol, month]);
  const selected = data?.history.find((h) => h.month === month)?.row;
  return (
    <dialog
      className="roll-dialog"
      ref={dialog}
      onClose={onClose}
      aria-labelledby="roll-symbol-title"
    >
      <header>
        <div>
          <span className="roll-demo">DEMO · SYNTHETIC</span>
          <h2 id="roll-symbol-title">{symbol}</h2>
          <p>{monthName(month)} · no real NSE observations</p>
        </div>
        <button aria-label="Close rollover details" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading history…</p>}
      {data && (
        <>
          {(["rolloverPct", "basisPct", "spreadPct"] as const).map((key) => (
            <TrendChart
              key={key}
              label={
                key === "rolloverPct"
                  ? "Six-month rollover"
                  : key === "basisPct"
                    ? "Six-month futures–spot basis"
                    : "Six-month next–near roll spread"
              }
              points={data.history.map((h) => ({
                month: h.month,
                value: h.row?.metrics[key].value ?? null,
              }))}
            />
          ))}
          <h3>Exact contract inputs</h3>
          <p>
            OI units: {selected?.contracts[0]?.oiUnit ?? "Unavailable"}. Close
            prices used consistently.
          </p>
          <div className="roll-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tenor</th>
                  <th>Expiry</th>
                  <th>Trade date</th>
                  <th>Close ₹</th>
                  <th>Open interest</th>
                </tr>
              </thead>
              <tbody>
                {selected?.contracts.map((c, i) => (
                  <tr key={c.expiry}>
                    <td>{["Near", "Next", "Far"][i]}</td>
                    <td>{c.expiry}</td>
                    <td>{c.tradeDate}</td>
                    <td>{format(c.close)}</td>
                    <td>{format(c.oi, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Reproduce the calculation</h3>
          {selected ? (
            <>
              <p>
                Rollover = ({format(selected.metrics.nextOi.value, 0)} +{" "}
                {format(selected.metrics.farOi.value, 0)}) ÷{" "}
                {format(selected.metrics.totalOi.value, 0)} × 100 ={" "}
                {percentage(selected.metrics.rolloverPct.value)}
              </p>
              <p>
                Basis = {format(selected.metrics.nearClose.value)} −{" "}
                {format(selected.metrics.spot.value)} = ₹
                {format(selected.metrics.basisInr.value)}
              </p>
              <p>
                Next–near spread = {format(selected.metrics.nextClose.value)} −{" "}
                {format(selected.metrics.nearClose.value)} = ₹
                {format(selected.metrics.spreadInr.value)} (
                {percentage(selected.metrics.spreadPct.value)})
              </p>
              <p>
                Version: {selected.calculationVersion} · {selected.policy}
              </p>
            </>
          ) : (
            <p>No observation for the selected month.</p>
          )}
          <h3>Sources & gaps</h3>
          {selected?.sources.map((source) => (
            <details key={source.id}>
              <summary>
                {source.segment} · {source.reportDate} · {source.evidence}
              </summary>
              <p>{source.reference}</p>
              <p>
                Schema: {source.schemaVersion} · received {source.receivedAt}
              </p>
              <code>SHA-256: {source.sha256 ?? "Not recorded"}</code>
            </details>
          ))}
          <ul>
            {data.history
              .filter((h) => !h.row || h.row.status !== "COMPLETE")
              .map((h) => (
                <li key={h.month}>
                  {h.month}:{" "}
                  {h.row?.issues.join("; ") ??
                    "Monthly source reports unavailable"}
                </li>
              ))}
          </ul>
          <h3>History values</h3>
          <div className="roll-scroll">
            <table>
              <thead>
                <tr>
                  <th>Month</th>
                  <th>Rollover %</th>
                  <th>Basis %</th>
                  <th>Spread %</th>
                </tr>
              </thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={h.month}>
                    <td>{h.month}</td>
                    {(["rolloverPct", "basisPct", "spreadPct"] as const).map(
                      (k) => (
                        <td key={k}>{percentage(h.row?.metrics[k].value)}</td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </dialog>
  );
}
export default function RolloverDashboard() {
  const [months, setMonths] = useState<Month[]>([]);
  const [month, setMonth] = useState("");
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [detailed, setDetailed] = useState(false);
  const [view, setView] = useState("stocks");
  const [matrixMetric, setMatrixMetric] = useState<"rollover" | "spread">(
    "rollover",
  );
  const emptyFilters = {
    q: "",
    sector: "",
    min: "",
    max: "",
    spread: "all",
    compare: "all",
    missing: "include",
    sort: "symbol",
    direction: "asc",
    page: "1",
  };
  const [filters, setFilters] = useState(emptyFilters);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/rollovers/months", { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        setMonths(body.months);
        setMonth(
          (current) =>
            current || body.latestComplete || body.months.at(-1)?.month || "",
        );
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [reload]);
  const query = new URLSearchParams({ month, ...filters }).toString();
  useEffect(() => {
    if (!month) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(null);
    fetch("/api/rollovers?" + query, { signal: controller.signal })
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error);
        setData(body);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [month, query, reload]);
  function filter(key: keyof typeof filters, value: string) {
    setFilters((f) => ({ ...f, [key]: value, page: "1" }));
  }
  function sort(key: string) {
    setFilters((f) => ({
      ...f,
      sort: key,
      direction: f.sort === key && f.direction === "asc" ? "desc" : "asc",
      page: "1",
    }));
  }
  const visibleColumns = columns.filter((c) => detailed || c.compact);
  const summary = data?.summary;
  return (
    <div className="roll-dashboard">
      <section className="roll-intro">
        <div>
          <p className="eyebrow">EXPIRY RESEARCH</p>
          <h2>Follow the shift in open interest.</h2>
          <p>
            Compare monthly rollover, futures basis and the true calendar
            spread.
          </p>
        </div>
        <span className="roll-demo">DEMO · SYNTHETIC DATA</span>
      </section>
      <p className="roll-notice">
        <Info size={18} />
        All prices, OI, dates and sectors here are fictional fixtures. No
        official NSE reports have been imported. Rollover is an OI distribution
        proxy, not a prediction or proof that individual trades rolled.
      </p>
      <section className="panel roll-controls">
        <label>
          Expiry month
          <select
            aria-label="Rollover expiry month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setFilters((f) => ({ ...f, page: "1" }));
              setSelected(null);
            }}
          >
            {[...months].reverse().map((m) => (
              <option value={m.month} key={m.month}>
                {monthName(m.month)} · {m.status.toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="roll-date">
          <span>Snapshot · T−1 trading session</span>
          <strong>{data?.selected.snapshotDate ?? "—"}</strong>
        </div>
        <div className="roll-date">
          <span>Actual expiry · synthetic calendar</span>
          <strong>{data?.selected.actualExpiry ?? "—"}</strong>
        </div>
        <button
          className="roll-button"
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
        >
          <RefreshCw size={15} />
          Reload fixtures
        </button>
        <a
          className="roll-button"
          href={"/api/rollovers/export?" + query}
          download
        >
          <Download size={15} />
          Download CSV
        </a>
      </section>
      {error && (
        <div className="error-panel" role="alert">
          {error}
          <button
            className="roll-button"
            onClick={() => setReload((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      )}
      {loading && <p role="status">Calculating the selected snapshot…</p>}
      {data && data.selected.status !== "COMPLETE" && (
        <p className="roll-warning" role="status">
          {data.selected.status}: {data.selected.issues.join("; ")}. Last
          complete synthetic month: {data.lastComplete ?? "none"}. No earlier
          data is substituted for this month.
        </p>
      )}
      <section className="roll-kpis" aria-label="Rollover snapshot totals">
        {[
          [
            "Eligible stocks",
            summary ? summary.eligible + " / " + summary.total : "—",
            "Complete rows / tracked universe",
          ],
          [
            "Avg. stock rollover",
            percentage(summary?.equalWeight),
            "Equal-weight stock average",
          ],
          [
            "Aggregate OI rollover",
            percentage(summary?.oiWeighted),
            "Same-unit open interest only",
          ],
          [
            "Avg. true roll spread",
            percentage(summary?.averageSpread),
            "Next close vs near close",
          ],
          [
            "Incomplete rows",
            summary ? String(summary.total - summary.eligible) : "—",
            "Excluded from aggregate metrics",
          ],
        ].map(([label, value, note]) => (
          <div className="panel" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>{note}</small>
          </div>
        ))}
      </section>
      <div className="roll-two-col">
        <section className="panel roll-trend">
          <h3>Six-month market context</h3>
          <p>
            Equal-weight rollover · selected month and five preceding calendar
            months
          </p>
          <TrendChart
            label="Synthetic equal-weight market rollover"
            points={
              data?.trend.map((p) => ({
                month: p.month,
                value: p.equalWeight,
              })) ?? []
            }
          />
        </section>
        <section className="panel roll-method">
          <h3>Compare the right measures</h3>
          <dl>
            <div>
              <dt>Rollover %</dt>
              <dd>(Next OI + far OI) ÷ total OI</dd>
            </div>
            <div>
              <dt>Futures–spot basis %</dt>
              <dd>(Near close − spot close) ÷ spot close</dd>
            </div>
            <div>
              <dt>True roll spread %</dt>
              <dd>(Next close − near close) ÷ near close</dd>
            </div>
          </dl>
          <p>
            All ratios × 100. 6M averages use up to six valid observations
            including the selected month; coverage is disclosed. Delta is in
            percentage points.
          </p>
        </section>
      </div>
      <section className="panel roll-results">
        <div className="roll-result-head">
          <div className="roll-tabs" role="tablist" aria-label="Rollover views">
            {[
              ["stocks", "Stocks"],
              ["sectors", "Sectors"],
              ["matrix", "Six-month matrix"],
              ["sources", "Source status"],
            ].map(([key, label]) => (
              <button
                role="tab"
                aria-selected={view === key}
                key={key}
                onClick={() => setView(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <span>{data?.total ?? 0} matching stocks</span>
        </div>
        <div className="roll-filters">
          <label>
            Find symbol
            <input
              aria-label="Find rollover symbol"
              placeholder="Search DEMO symbols"
              value={filters.q}
              onChange={(e) => filter("q", e.target.value)}
            />
          </label>
          <label>
            Sector
            <select
              value={filters.sector}
              onChange={(e) => filter("sector", e.target.value)}
            >
              <option value="">All sectors</option>
              {data?.sectors.map((s) => (
                <option key={s.sector}>{s.sector}</option>
              ))}
            </select>
          </label>
          <label>
            Min rollover %
            <input
              type="number"
              min="0"
              max="100"
              value={filters.min}
              onChange={(e) => filter("min", e.target.value)}
            />
          </label>
          <label>
            Max rollover %
            <input
              type="number"
              min="0"
              max="100"
              value={filters.max}
              onChange={(e) => filter("max", e.target.value)}
            />
          </label>
          <label>
            Roll spread
            <select
              value={filters.spread}
              onChange={(e) => filter("spread", e.target.value)}
            >
              <option value="all">All spreads</option>
              <option value="positive">Positive</option>
              <option value="negative">Negative</option>
            </select>
          </label>
          <label>
            Vs 6M average
            <select
              value={filters.compare}
              onChange={(e) => filter("compare", e.target.value)}
            >
              <option value="all">All stocks</option>
              <option value="above">Above average</option>
              <option value="below">Below average</option>
            </select>
          </label>
          <label>
            Data coverage
            <select
              value={filters.missing}
              onChange={(e) => filter("missing", e.target.value)}
            >
              <option value="include">Include incomplete</option>
              <option value="exclude">Complete only</option>
              <option value="only">Incomplete only</option>
            </select>
          </label>
          <button
            className="roll-button"
            onClick={() => setFilters(emptyFilters)}
          >
            Reset filters
          </button>
        </div>
        {view === "stocks" && (
          <>
            <div className="roll-table-controls">
              <p>
                Summary metrics use the full eligible universe. Click a symbol
                for inputs and history.
              </p>
              <button
                className="roll-button"
                aria-pressed={detailed}
                onClick={() => setDetailed((v) => !v)}
              >
                {detailed ? "Compact table" : "All metrics"}
              </button>
            </div>
            <div className="roll-scroll">
              <table className="roll-stock-table">
                <caption>
                  {month ? monthName(month) : "Monthly"} snapshot · DEMO ·
                  missing values are shown as —
                </caption>
                <thead>
                  <tr>
                    <th>
                      <button onClick={() => sort("symbol")}>
                        Symbol / sector ↕
                      </button>
                    </th>
                    {visibleColumns.map((c) => (
                      <th key={c.key}>
                        <button
                          title={
                            c.key in definitions
                              ? definitions[c.key as MetricKey]
                              : c.key === "delta"
                                ? "Current rollover minus inclusive 6M average, in percentage points."
                                : "Up to six valid observations; see row coverage."
                          }
                          onClick={() =>
                            sort(c.key === "delta" ? "deltaPp" : c.key)
                          }
                        >
                          {c.label} ↕
                        </button>
                      </th>
                    ))}
                    <th>Quality</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.rows.map((row) => (
                    <tr key={row.symbol}>
                      <td>
                        <button
                          className="roll-symbol"
                          onClick={() => setSelected(row.symbol)}
                        >
                          {row.symbol}
                        </button>
                        <small>{row.sector}</small>
                      </td>
                      {visibleColumns.map((c) => {
                        const m = valueFor(row, c.key);
                        return (
                          <td
                            key={c.key}
                            title={
                              m.reason ??
                              (c.key in definitions
                                ? definitions[c.key as MetricKey]
                                : "")
                            }
                            className={
                              c.key === "rolloverPct"
                                ? "roll-emphasis"
                                : ["delta", "momPct", "spreadPct"].includes(
                                      c.key,
                                    )
                                  ? signed(m.value)
                                  : ""
                            }
                          >
                            {c.key.includes("Oi")
                              ? format(m.value, 0)
                              : c.key === "delta"
                                ? (m.value !== null && m.value > 0 ? "+" : "") +
                                  format(m.value)
                                : c.key.includes("Pct") ||
                                    [
                                      "average",
                                      "basisAverage",
                                      "spreadAverage",
                                    ].includes(c.key)
                                  ? percentage(m.value)
                                  : format(m.value)}
                            {c.key === "average" && (
                              <small>{row.average.count}/6 valid months</small>
                            )}
                          </td>
                        );
                      })}
                      <td>
                        <span
                          className={
                            "roll-quality " +
                            (row.status === "COMPLETE"
                              ? "complete"
                              : "incomplete")
                          }
                          title={
                            row.issues.join("; ") ||
                            "Valid synthetic inputs; not verified NSE data"
                          }
                        >
                          {row.status === "COMPLETE"
                            ? "Demo complete"
                            : "Needs review"}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data && !data.rows.length && (
              <p className="roll-empty">
                No observations match this month and these filters.
              </p>
            )}
            <div className="roll-pagination">
              <button
                className="roll-button"
                disabled={!data || data.page <= 1}
                onClick={() =>
                  setFilters((f) => ({
                    ...f,
                    page: String(Number(f.page) - 1),
                  }))
                }
              >
                Previous
              </button>
              <span>
                Page {data?.page ?? 1} · {data?.total ?? 0} results
              </span>
              <button
                className="roll-button"
                disabled={!data || data.page * 25 >= data.total}
                onClick={() =>
                  setFilters((f) => ({
                    ...f,
                    page: String(Number(f.page) + 1),
                  }))
                }
              >
                Next
              </button>
            </div>
          </>
        )}
        {view === "sectors" && (
          <>
            <p className="roll-help">
              Sector metrics use the full selected-month universe. Stock filters
              affect Stocks and the matrix.
            </p>
            <div className="roll-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Sector</th>
                    <th>Coverage</th>
                    <th>Equal-weight rollover</th>
                    <th>OI-weighted rollover</th>
                    <th>Average true spread</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.sectors.map((s) => (
                    <tr key={s.sector}>
                      <td>{s.sector}</td>
                      <td>
                        {s.eligible}/{s.total}
                      </td>
                      <td>{percentage(s.equalWeight)}</td>
                      <td>{percentage(s.oiWeighted)}</td>
                      <td>{percentage(s.averageSpread)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {view === "matrix" && (
          <>
            <label className="roll-matrix-select">
              Matrix metric
              <select
                value={matrixMetric}
                onChange={(e) =>
                  setMatrixMetric(e.target.value as typeof matrixMetric)
                }
              >
                <option value="rollover">Rollover %</option>
                <option value="spread">True roll spread %</option>
              </select>
            </label>
            <div className="roll-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    {data?.window.map((m) => (
                      <th key={m}>{monthName(m)}</th>
                    ))}
                    <th>Valid 6M average</th>
                  </tr>
                </thead>
                <tbody>
                  {data?.matrix.map((r) => (
                    <tr key={r.symbol}>
                      <td>
                        <button
                          className="roll-symbol"
                          onClick={() => setSelected(r.symbol)}
                        >
                          {r.symbol}
                        </button>
                      </td>
                      {r.values.map((v) => (
                        <td
                          key={v.month}
                          title={
                            v[matrixMetric].reason ?? "Synthetic observation"
                          }
                        >
                          {percentage(v[matrixMetric].value)}
                        </td>
                      ))}
                      <td>
                        {percentage(
                          matrixMetric === "rollover"
                            ? r.average.value
                            : data.rows.find((row) => row.symbol === r.symbol)
                                ?.spreadAverage.value,
                        )}
                        <small>
                          {matrixMetric === "rollover"
                            ? r.average.count + "/6 valid"
                            : ""}
                        </small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {view === "sources" && (
          <section className="roll-source-status">
            <h3>Fixture mode · real import and automation disabled</h3>
            <p>
              Calendar: synthetic sessions and expiry dates. No official holiday
              calendar has been verified. No last verified NSE month exists.
            </p>
            <p>
              Fixture timestamp:{" "}
              {data?.selected.lastSync ?? "No report available"}. There is no
              running NSE download or monthly scheduler.
            </p>
            <p>
              Next stages require verified UDiFF headers, authorized source
              access, safe manual ZIP upload, persisted hashes and monitored
              idempotent jobs.
            </p>
            <div className="roll-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Snapshot</th>
                    <th>Expiry</th>
                    <th>Source status</th>
                  </tr>
                </thead>
                <tbody>
                  {[...months].reverse().map((m) => (
                    <tr key={m.month}>
                      <td>{monthName(m.month)}</td>
                      <td>{m.snapshotDate}</td>
                      <td>{m.actualExpiry}</td>
                      <td title={m.issues.join("; ")}>{m.status} · DEMO</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </section>
      {selected && (
        <SymbolDrawer
          symbol={selected}
          month={month}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
