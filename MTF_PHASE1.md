# MTF tracker: architecture audit, phased plan and calculation contract

## Audit before implementation

Read CLAUDE.md, README.md, docs/ARCHITECTURE.md, docs/DATA_POLICY.md,
docs/MTF_TRACKER_SPEC.md and docs/TRADELENS_UI_UX_BLUEPRINT.md. Inspected
shared types/calculations/tests, API configuration/security/providers and the
React portfolio screen. No applicable AGENTS.md or reference CSV was found in
this checkout. The specification's CSV audit is supplied context, not an
independently reproduced import audit. No private source data has been copied
into code, fixtures or this document.

The current stack is React 19 + Vite + TypeScript, a Node HTTP API, and shared
pure domain code. Existing scenarios use numeric ACT/365 illustrative financing;
that formula cannot represent a dated funding ledger. Keep it unchanged and
introduce an isolated MTF module. Market-data provenance concepts are reusable,
but existing daily candle types cannot represent timestamped live quotes or
broker funding records. UI panels, form fields, status/source components and
portfolio navigation are later reuse points; no UI work belongs in Phase 1.

The API has no persisted accounts or financial ledger. Its single-workspace
bearer gate is not tenant authentication. Browser-local thesis/watchlist storage
is not suitable for server-side MTF records. Do not expose private uploads or
holdings until Phase 3 has the appropriate access, encryption and retention
model. Architecture notes predating T6/T7 omit their research API and workspace
gate; implementation was audited against actual code, not those older claims.

## Phased implementation plan

1. **Phase 1, this change:** scoped lot/event/charge/quote/policy models,
   decimal-safe pure replay, dated funding and rates, allocation across partial
   sales/conversions, explicit corporate actions, sourced configuration,
   valuations/break-even, synthetic tests and calculation documentation.
2. **Phase 2:** browser-local strict CSV staging, explicit snapshot metadata,
   preview diagnostics, corrections/confirmation, duplicate detection and
   reconciliation. Preserve raw evidence privately. Test footer/trailing-column
   parsing, missing values, chronology, outliers and export injection separately.
3. **Phase 3:** choose local SQLite vs cloud PostgreSQL from deployment needs;
   scoped persistence, migrations/indexes, immutable/idempotent writes, access
   enforcement, encrypted private data, backup/restore, retention and deletion;
   add the spec's ledger, summary, detail, charges and scenario APIs plus tests.
4. **Phase 4:** premium MTF workspace using existing React/CSS components;
   Open/Closed/Converted/Review views, detail ledger, source/freshness states,
   import UX, accessibility and responsive coverage.
5. **Phase 5:** synthetic quote adapter, snapshots/history, hold scenarios,
   partial/stale coverage, performance measurement and browser E2E tests.
6. **Phase 6, separate explicit opt-in:** licensed read-only broker connection,
   secure per-account sessions, entitlements, official statements and actual
   reconciliation. No order execution.

## Phase 1 interfaces and arithmetic

Import from `packages/core/src/mtf/index.ts` or the core barrel. No API routes,
storage, migrations, credentials or UI screens are introduced. `decimal.js` is a
runtime dependency; domain tests now require `npm ci` before execution. Existing
scenario/backtest calculations are unchanged.

All financial inputs are base-10 strings: no exponent notation, NaN, Infinity,
negative prices or implicitly parsed spreadsheet cells. Price/rate inputs allow
8 fractional digits and at most 15 integer digits. Booked money/principal is
paise-precision. Quantities are positive safe integers bounded at one billion;
remaining quantity may reach zero. The engine uses an isolated 60-significant-
digit Decimal context. Only dates, quantities and bounded iteration counters
use JS numbers. Output currency is paise, per-share values have 4 decimals and
modelled daily interest has 16 decimals for audit. Global Decimal settings cannot
change the engine's arithmetic.

`calculateMtfLot(lot, options)` deterministically replays an explicitly matched
buy lot. It returns a snapshot, daily interest records and separate exit
allocations without mutating inputs. Invalid financial events produce
NEEDS_REVIEW with structured codes and no trusted metrics. Unverified imported
charges also force review, and never enter authoritative calculated costs.
Dates are strict ISO calendar dates and timezone-qualified instants. Calendar
boundaries use Asia/Kolkata irrespective of host timezone; no local clock is read.
The caller supplies asOf, policies, approved rates, freshness threshold and quote.
Ledger replay is limited to 100 years / 20,000 events+charges per lot.

### Interest and funding

- Opening funded principal is explicit or unknown (`null`), never inferred from
  margin percentages, P&L, daily interest imports or gross purchase notional.
  Initial own funds is gross purchase notional less explicit initial funding.
- Funding events explicitly select BORROW/REPAY and an effective calendar date.
  That date means **beginning-of-day balance**; event.at means when the evidence
  became known. An event cannot have a future effective date relative to at.
  Funding cannot become negative or exceed remaining purchase cost at that event.
- Sales/conversions specify actual principal repayments separately from economic
  cost. With includeExitDay=true, interest uses the balance before those
  repayments, and the reduced balance applies next day. With false, same-day
  sale/conversion repayments reduce that day's interest base. Intraday financing
  is not modelled. Start offset is a configurable calendar-day count, not an
  exchange settlement calendar. Weekends and holidays are included.
- Rate windows have inclusive effectiveFrom/effectiveTo dates and cannot overlap.
  Missing applicable rates produce unknown estimates and review; explicit
  zero-funded balances need no rate. Rates are fractions, not percentages.
- Missing funded amounts propagate null interest/cost-adjusted results; gross
  price P&L remains available. Missing funding alone does not invent a closed
  position or prevent showing a partial-data open lot.
- A lot/day's ACTUAL interest entries replace its estimate once their posting
  timestamp is within asOf. Multiple explicit statement lines for the same day
  are additive. Each line needs a unique stable ID; statement deduplication and
  account-to-lot allocation belong to import/reconciliation phases.
- Preserve estimate, selected actual, variance, rate ID/source and statement
  references per day. Actual source assertions require VERIFIED evidence (or
  explicitly DEMO fixtures). This is an evidence assertion supplied by the
  caller, not automatic broker reconciliation.
- DAILY rounding rounds each estimated day to paise. TOTAL retains intermediate
  precision and rounds accrued interest at the reporting/disposal boundary.
  HALF_UP, HALF_EVEN and DOWN are explicit policy choices. Allocations conserve
  the rounded total; rounding residues stay with the remaining/final shares.

### Lifecycle, charges and allocation

One canonical lot corresponds to one original purchase fill. Two same-symbol
buys retain separate identities/timelines. Exits name the lot explicitly; automatic
multi-lot FIFO matching is deferred to import/API phases. `appendMtfEvent` clones
its result, treats identical ID/content retries as no-ops, rejects conflicting IDs
and checks scope. It does not substitute for transactional persistence or
financial validation at confirmation time.

Charges use an effective service date separately from their posting timestamp.
Lot-wide charges and accrued interest are allocated proportionally to shares
held on their service date, before same-day exits. Specific sale/conversion fees
name an exit ID. Later statement postings recompute the relevant historical
allocation only in snapshots after their posting date; prior as-of results are
unchanged. Refunds must reference an earlier positive entry with matching kind,
day, evidence and exit allocation, and cannot exceed that entry. Imported raw
estimates never silently override the calculation ledger.

Explicit lot events derive OPEN_MTF, PARTIALLY_SOLD, CLOSED_SOLD,
CONVERTED_TO_DELIVERY or NEEDS_REVIEW. PARTIALLY_SOLD also denotes a partially
converted lot under the specification's available status enum. A completed mixed
sale/conversion lot is classified CONVERTED_TO_DELIVERY if any shares converted;
individual exit records preserve the full distinction. A fully disposed funded
lot must have zero known principal, otherwise it requires review. Unknown
principal remains unknown. Converted allocations carry destination lot, original
basis and costs, with no sale proceeds or fabricated realized P&L. This does not
create/persist the destination CNC holding yet.

Explicit SPLIT/BONUS ratios transform remaining quantity without changing total
basis, interest or principal. Fractional entitlements require review rather than
rounding away cash-in-lieu. RENAME events carry the new identity and dated alias
history. Quotes before a corporate action cannot value post-action shares.
Merger, dividend cashflow and cash-in-lieu automation are not implemented.

`allocateMtfRequestFee` allocates one supplied per-ISIN/per-purchase-day request
charge across same-account lots by original share quantity. Largest-remainder
paise allocation preserves even tiny totals without creating negative residuals.
It rejects mixed ISIN/exchange/day/account groups. It does not assume a fee per
fill/share, invent requests, or deduplicate separate requests automatically.

### Valuation and fee policy

Original buy price never changes. Remaining share basis plus allocated incurred
costs yields the cost-adjusted price. Gross unrealized P&L excludes costs; adjusted
P&L includes them. Realized P&L exists only for sale fills; financing repayments
are not deducted a second time. Outputs remain DEMO or ESTIMATED for realized
results until a later reconciliation workflow exists. Own-capital ROI is always
null in Phase 1; initial margin alone does not define all equity cashflows.

Fee schedules are explicit, dated, versioned and sourced. Each named line is a
fixed amount plus a turnover fraction, optionally capped, rounded per line.
Applicable GST/statutory items must be supplied as correctly sourced components;
no universal statutory rate table is bundled. A fee model must describe a single
explicit liquidation request/order and all relevant charges for that scenario.
Multi-order/per-request aggregation belongs to the execution/import layer.
Unknown sell costs produce null net liquidation P&L and break-even.

Break-even uses a bounded decimal solver and 4-decimal price grid with a bounded
rounding-neighborhood search. It solves price-sensitive fees rather than adding
a fixed-fee shortcut. The returned tick covers basis and modelled charges; it is
an estimate, not an executable quote. Total variable slopes must be less than 1.

The optional Zerodha **interest-only** template records the source observation
on 2026-10-30, requires a caller-approved effective date and explicit rounding,
and is never applied globally or backdated by inference. Current source checks:

- https://zerodha.com/charges/ — MTF funded interest, T+1 through sale day.
- https://support.zerodha.com/category/trading-and-markets/margins/margin-trading-facility/articles/interest-calculation-for-mtf
- https://support.zerodha.com/category/trading-and-markets/margins/margin-trading-facility/articles/convert-mtf-to-cnc

Conversion processing cutoffs and settlement eligibility must be resolved to an
actual effective conversion event by later broker/import adapters. Phase 1 does
not equate a conversion request to completed conversion. No complete broker tax
schedule or claim of reconciled historical charges is made.

### Quotes, aggregation and audit

Quotes carry account/instrument identity, provider/evidence, market and receive
timestamps, mode and threshold. Missing, mismatched, future, pre-action or stale
quotes produce null market-derived values, never zero. At threshold age the quote
is STALE. A synthetic/manual quote cannot claim LIVE. Snapshots preserve the
quote and each applicable rate's provenance; model and schedule IDs identify
versions. Caller-owned immutable inputs remain the full audit record.

`summarizeMtfPortfolio` consumes the complete unfiltered snapshot list for one
scope and one as-of instant, rejects duplicate lots and mixed dates/accounts,
excludes Closed/Converted/Review, and includes only costs allocated to remaining
shares. Missing figures propagate null totals; partial market value and coverage
are separate. Demo and unverified data are labelled, with verified coverage
reported separately. VERIFIED_TRADES_AND_QUOTES is not ACTUAL/RECONCILED. Consumers must
render those labels and must not call incomplete/demo totals verified/live.

## Validation and acceptance scope

Synthetic fixtures cover eight lots: open, sold, converted, partial, unknown
funding, invalid chronology, stale price and a second same-symbol purchase.
Tests exercise the specification's Phase 1 numerical cases, plus rounding/rate
boundaries, refunds, service-date allocation, conversion history, conservation,
fee break-even, idempotent event retries, timezone and scope validation.

CSV candidate counts and duplicate-import transactions (cases 9/10/19), UI tabs,
filter behavior, screenshots, accessibility and live-status UI (parts of cases
15/16/20) are later-phase acceptance tests. Phase 1 has no new UI/API integration
or E2E tests because it introduces no UI/API surface. The existing suite must
continue to pass. Nothing here is real-time, broker-connected or reconciled.

## Actual Phase 1 verification results

- `npm test`: 143 passed, 0 failed (31 new MTF test cases; 112 existing tests).
- `npm run typecheck`: passed for web, API and core sources/tests.
- `npm run build`: passed, production Vite build.
- `git diff --check`: passed.
- Local non-gating benchmark: 1,000 synthetic lot replays, 365,000 daily interest
  records, 2,188 ms on this execution host. This is not a browser responsiveness
  guarantee. Later UI integration should use a worker/server computation rather
  than replay 1,000 lots on the browser main thread.
- No new API/E2E surfaces were introduced; existing API tests ran in the full
  suite. Browser E2E tests were not run for this domain-only change.

Changed files: `packages/core/src/mtf/{types,decimal,fees,ledger,policies,portfolio,index}.ts`,
`packages/core/src/index.ts`, `packages/core/tests/mtf.test.ts`,
`packages/core/tests/fixtures/mtf.ts`, `package.json`, `package-lock.json`,
`README.md` and this document. No migrations. No private CSV, user holdings,
broker credentials or screenshots are included. The reference CSV was not
available, so its candidate/chronology counts remain unverified by this run.

Next reviewable change is Phase 2's local CSV preview/validation/correction
workflow. API persistence and the premium tracking screen follow Phases 3 and 4.
