# Deploying the single-workspace research prototype

Node 22.16+ is required. Run `npm ci`, `npm run typecheck`, `npm test`,
`npm run build`, and `npm run test:e2e` before deployment. CI also runs a high
severity dependency audit and CodeQL. CI results must be checked on the PR;
local checks do not imply a completed remote scan.

## Access and secrets

The API remains stateless. Journals and watchlists remain browser-local. There
are no server-side accounts, tenant records, stored research requests or database.
T7's conditional database/auth-tenancy migration is deliberately deferred until
shared persistence is required. The bearer gate protects one workspace; it is not
multi-user authentication or tenant isolation.

For production set `NODE_ENV=production`, `API_ACCESS_TOKEN` (at least 32 random
non-whitespace characters), and optionally `API_PORT`. Missing or weak tokens
fail startup. Use a hosting secret manager to inject secrets at runtime. Never
use VITE_* for secrets, embed tokens in JS, commit .env files, or log headers.
Rotate by replacing the secret and restarting the process; old tokens immediately
stop working. Keep market and research provider credentials separate.

Serve `apps/web/dist` over HTTPS behind an authenticated reverse proxy / identity
gateway. It must authenticate the user, restrict workspace membership, strip the
incoming Authorization header, and inject `Authorization: Bearer <API_ACCESS_TOKEN>`
on its upstream `/api/` requests. Bind the Node API to loopback (as implemented)
and prevent direct external access. Do not serve this as a public anonymous
proxy. Configure TLS, HSTS, CSP, request size limits, idle timeouts and per-user
rate limits at the gateway. Its `/api/` upstream is `http://127.0.0.1:4000`;
its static root is `apps/web/dist` with an index.html fallback. Verify an
unauthenticated browser cannot access either static files or the API. An
authenticated browser should load instruments and complete Research assistant.
The development Vite proxy does not inject production credentials.

Start the API with `npm run start:api`. Use a process supervisor, an unprivileged
OS account, read-only source/build files, resource limits, and restart-on-failure.
SIGTERM/SIGINT drain requests for up to 10 seconds. API headers/request timeouts
are bounded; research HTTP calls time out after 10 seconds. The API applies a
global 300 authenticated requests/minute limit and a 16-request concurrency limit.
These are per process; use gateway limits for multi-process deployments.

All routes, including `/api/health`, require the bearer token when configured.
Monitor authenticated health, HTTP 5xx/429 rates and latency. Structured stdout
records request ID, method, status and duration only: no URL, thesis, token,
provider response or user data. Centralize these logs with retention limits;
use `x-request-id` for correlation. Alert on repeated research 502s or failed health.

## Research provider contract

`RESEARCH_PROVIDER=mock` is the default and needs no credentials. It performs
no model inference. `POST /api/research` accepts exactly:

```json
{"symbol":"DEMO-ALPHA","thesis":"A directional hypothesis","direction":"rising","action":"argue-against"}
```

Direction is `rising` or `falling`; action is `review` or `argue-against`.
Thesis is 1–2000 characters. The body limit is 16 KiB. A 200 response contains
input, provider, version, provenance, citations, contradictions, limitations and
freshness warnings. Unsupported input gives 400; tool/provider failure gives 502
with no claims. The server retrieves candles and computes SMA20/RSI14; those
calculations are the only evidence tools in this release. Evidence direction
is descriptive, not a prediction. No filings, news or external textual evidence
is ingested. User thesis text is never executed or treated as an instruction.

To use a user-operated model adapter, set `RESEARCH_PROVIDER=http`,
`RESEARCH_URL=https://your-adapter/...` and `RESEARCH_API_KEY` via runtime secrets.
Only configure a trusted endpoint: the request sends the thesis, evidence and
provenance to it. Verify market-data license permits this transfer first.
The adapter receives `{instruction, context}` and must return only
`{"evidenceIds":["<known ID>"]}`. No vendor-specific adapter is bundled.
Redirects, oversized responses (>16 KiB), invalid IDs and additional output
fields are rejected. Only server-rendered factual statements reach the browser;
free-form model claims are rejected. Contrary evidence cannot be suppressed.
No qualifying contrary evidence is explicitly reported as such, not confirmation.

Data versions hash instrument metadata, candles, calculation schema and source
provenance excluding ingestion time, so repeat retrievals of the same data retain
the version. Every citation includes this version and its calculation tool.
Reports show observation/ingestion times, licensing and synthetic/freshness flags.
Reports are returned to the browser, not persisted server-side; retain a response
privately if an audit record is needed. A hash identifies inputs but is not a
backup of an upstream dataset.

## Backups and recovery

There are no database migrations, indexes or database backups because no database
is introduced. Back up deployment configuration without secret values; keep
previous immutable build artifacts for rollback. Rebuild with the committed
lockfile. Roll back code/build together and restart with current secrets. Test
health and the research workflow after rollback. Browser-local journals require
the user's existing export/backup workflow; clearing browser storage loses them.
Before adding server persistence, design migrations, tenant authorization, indexed
access paths, encrypted backups, restore drills and retention together.
