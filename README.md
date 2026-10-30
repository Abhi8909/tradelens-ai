# TradeLens AI — Stock Research Workspace

**A real, extendable full-stack coding project.**

TradeLens AI is a developer starter for a transparent stock research workspace. It includes a responsive React dashboard, deterministic technical indicators, a rule-based stock screener, a hypothetical trade-scenario calculator, and a working Node API.

## Quick start

Requirements: **Node.js 22.16+**, npm 10+.

```bash
# From the repository root
npm install
npm run dev
```

- Web UI: http://localhost:5173
- API health: http://localhost:4000/api/health
- Demo API: http://localhost:4000/api/stocks

Alternatively run these commands in separate terminals:

```bash
npm run dev:api
npm run dev:web
```

Note: The frontend uses Vite's dev proxy `/api` → `127.0.0.1:4000`, so no credentials or cross-origin configuration is needed locally. `npm install` requires package-registry access.

## Test and build

```bash
npm test                    # backend + domain unit/integration tests; no network/API keys
npm run typecheck           # after npm install
npm run build               # after npm install, builds the web frontend
```

The Node API and domain tests run independently of external packages, using Node 22's experimental TypeScript type stripping (you may see an experimental warning). The web app depends on React/Vite from npm.

## Thesis journal (browser-local)

The **Thesis journal** tab records a user-written trade thesis: instrument, hypothesis, supporting and opposing evidence, invalidation criteria and time horizon. Each save appends a new version with its own as-of timestamp; earlier versions, including the original, are never rewritten and can be viewed read-only.

- Stored only in this browser's `localStorage` under `tradelens-thesis-journal` (schema version 1). Nothing is sent to the API.
- If stored data can't be read, or was written by a newer schema version, the app leaves it untouched and disables saving until you choose to back it up (copied to a `tradelens-thesis-journal.backup.<timestamp>` key) and start a new journal.
- Domain rules and storage handling live in `packages/core/src/thesis.ts` and `packages/core/src/thesisStore.ts`.
- A thesis is the user's own reasoning. TradeLens does not evaluate it, and it is not investment advice.

## Repository layout

```text
apps/
  api/src/                 # Node HTTP API and deterministic fake market source
  api/tests/               # HTTP integration tests
  web/src/                 # React dashboard and scenario lab
packages/core/src/         # Shared domain types, RSI/SMA, financial calculations
packages/core/tests/       # Pure calculation unit tests
CLAUDE.md                  # Claude Code context and contributor guardrails
docs/ARCHITECTURE.md       # Request/data flow and design decisions
docs/ROADMAP.md            # Planned development milestones and issue briefs
docs/DATA_POLICY.md        # Licensing, privacy and financial-product boundaries
.github/workflows/ci.yml   # Tests, frontend typecheck/build
```

## API examples

```bash
curl http://127.0.0.1:4000/api/health
curl 'http://127.0.0.1:4000/api/stocks?trend=above-sma&minRsi=40'
curl http://127.0.0.1:4000/api/stocks/DEMO-ALPHA/candles
curl 'http://127.0.0.1:4000/api/stocks/DEMO-ALPHA/candles?limit=20'
curl -X POST http://127.0.0.1:4000/api/scenarios \
  -H 'content-type: application/json' \
  -d '{"budget":100000,"entryPrice":125,"movePct":-10,"holdingDays":60,"borrowedAmount":30000,"annualInterestPct":14,"estimatedFees":100}'
```

`GET /api/stocks/:symbol/candles` accepts an optional `limit` (plain integer, 1–90, default 90) and returns the latest `limit` synthetic sessions, oldest first, as `{ source, symbol, requested, count, candles }`. `count` can be lower than `requested` when history is sparse. Any other `limit` value returns `400` with no candle data.

### Portfolio risk simulator

`POST /api/portfolio-scenarios` is stateless: it validates a hypothetical long-only portfolio, compares up to 6 price scenarios and checks your own optional risk limits. Nothing is stored.

```bash
curl -X POST http://127.0.0.1:4000/api/portfolio-scenarios \
  -H 'content-type: application/json' \
  -d '{"portfolio":{"capital":100000,"positions":[{"symbol":"DEMO-ALPHA","sector":"Industrials","quantity":100,"entryPrice":200,"stopPrice":180,"borrowedAmount":10000,"estimatedFees":40}]},
       "scenarios":[{"name":"Market -10%","marketMovePct":-10,"sectorMovesPct":{},"holdingDays":30,"annualInterestPct":12}],
       "limits":{"maxPositionPct":20,"maxTotalRiskPct":5,"requireStops":true}}'
```

- **Request:** `portfolio` (capital and 1–50 positions, unique symbols), `scenarios` (0–6), `limits` (each optional; `null` or missing means not set). The body limit is 64 KB.
- **Response:** `{ source, analysis, scenarios, worstScenario, checks }`. Invalid input returns `400 { error, details[] }`.
- **Conventions:**
  - Positions are valued at their entry price, a planning view rather than live marking to market.
  - Weights are shown both as % of capital (used for the limits) and as % of gross exposure (used for HHI and effective positions).
  - Risk to stop includes fees.
  - Financing is simple interest, ACT/365, the same as `/api/scenarios`.
  - Price moves resolve symbol, then sector, then market.
  - Ending cash = capital + net P&L. `lossExceedsCapital` and per-position `loanShortfall` flag leveraged losses.
- **Limits:** a limit that can't be checked (for example, risk per position when a stop is missing) is reported as `not-evaluable`, not as passing.
