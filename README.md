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
