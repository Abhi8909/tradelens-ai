import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { MtfDomainError, amount, instant, istDay } from '../../../../packages/core/src/mtf/decimal.ts';
import { createPortfolioDocument, derivePortfolioPosition, projectPosition, type MtfAccount, type PortfolioDocument, type PortfolioPrice } from '../../../../packages/core/src/mtf/dashboard.ts';
import type { MtfCharge, MtfEvent } from '../../../../packages/core/src/mtf/types.ts';
import { CalculationPool } from './calculationPool.ts';
import { MtfAuth, hashPassword, type Identity } from './auth.ts';
import { assertHttp, digest, MtfHttpError, MtfStore, newId } from './store.ts';
import type { BrokerHolding, KiteCredentials, KiteReadOnlyClient } from './kite.ts';
import type { MtfQuoteFeed } from '../mtfQuotes.ts';

type Options = { store: MtfStore; origin?: string; production?: boolean; allowRegistration?: boolean; kite?: KiteReadOnlyClient; quotes?: MtfQuoteFeed };
export class MtfService {
  readonly calculations = new CalculationPool();
  readonly options: Options; readonly store: MtfStore; readonly auth: MtfAuth;
  constructor(options: Options) { this.options = options; this.store = options.store; this.auth = new MtfAuth(this.store, !!options.production, options.origin); }
  async account(owner: string, id: string, store = this.store) { const account = await store.read<MtfAccount>(owner, 'account', id); assertHttp(account, 404, 'Account not found'); return account; }
  async documents(owner: string, account: string, store = this.store) { await this.account(owner, account, store); return store.list<PortfolioDocument>(owner, 'position', account); }
  async prices(owner: string, account: string, asOf?: string) {
    const current = await this.store.list<PortfolioPrice>(owner, 'quote', account);
    if (!asOf) return current;
    return (await Promise.all(current.map(async quote => {
      if (instant(quote.marketAt) <= instant(asOf)) return quote;
      const history = await this.store.history<PortfolioPrice>(owner, 'quote', `quote:${account}:${digest(quote.symbol)}`);
      return history.map(r => r.document).filter(q => instant(q.marketAt) <= instant(asOf)).sort((a,b) => instant(b.marketAt)-instant(a.marketAt))[0] ?? null;
    }))).filter((q): q is PortfolioPrice => q !== null);
  }
  async summary(owner: string, account: string, asOf = new Date().toISOString()) {
    const documents = await this.documents(owner, account); const prices = await this.prices(owner, account, asOf);
    const result = await this.calculations.calculate([documents.filter(d => d.position.boughtDate <= istDay(asOf)), { tenantId: owner, accountId: account }, asOf, prices]);
    return { ...result, rows: result.rows.map(row => ({ ...row, snapshot: { ...row.snapshot, dailyInterest: [], exits: [] } })) };
  }
  async snapshot(owner: string, account: string) {
    const summary = await this.summary(owner, account); const at = new Date().toISOString(); const id = `snapshot:${account}:${istDay(at)}`;
    await this.store.transaction(async tx => {
      const current = await tx.read<{ version: number }>(owner, 'snapshot', id);
      await tx.write(owner, account, 'snapshot', id, { id, version: (current?.version ?? 0) + 1, at, summary: summary.summary }, current?.version ?? 0, 'Observed portfolio snapshot', at);
    }); return summary;
  }
  async refresh(owner: string, account: string) {
    const docs = await this.documents(owner, account); const now = new Date().toISOString();
    const symbols = [...new Set(docs.filter(d => { const s = derivePortfolioPosition(d, { tenantId: owner, accountId: account }, now, null); return (s.metrics?.quantityOpen ?? 0) > 0; }).map(d => d.position.symbol))];
    let quoteWarning: string | null = null;
    if (symbols.length && !this.options.quotes) quoteWarning = 'Automatic quote feed is disabled; manual and saved quotes are retained.';
    if (symbols.length && this.options.quotes) {
      try {
      const batches: PortfolioPrice[] = [];
      for (let start = 0; start < symbols.length; start += 50) batches.push(...await this.options.quotes.getQuotes(symbols.slice(start, start + 50)));
      await this.store.transaction(async tx => {
        for (const q of batches) {
          const id = `quote:${account}:${digest(q.symbol)}`; const prior = await tx.read<PortfolioPrice & { version: number }>(owner, 'quote', id);
          if (prior?.marketAt === q.marketAt && prior.priceInr === q.priceInr) continue;
          await tx.write(owner, account, 'quote', id, { ...q, version: (prior?.version ?? 0) + 1 }, prior?.version ?? 0, 'Quote observation', now);
        }
      });
      } catch { quoteWarning = 'Quote service unavailable; only valid saved/manual prices are used.'; }
    }
    return { ...await this.snapshot(owner, account), quoteWarning };
  }
  async handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean> {
    if (!url.pathname.startsWith('/api/mtf/') || url.pathname === '/api/mtf/quotes') return false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); response.end(JSON.stringify(body)); };
    const body = async () => {
      assertHttp(request.headers['content-type']?.startsWith('application/json'), 415, 'Expected application/json');
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { size += chunk.length; assertHttp(size <= 1_048_576, 413, 'Request too large'); chunks.push(Buffer.from(chunk)); }
      try { const parsed = JSON.parse(Buffer.concat(chunks).toString()); assertHttp(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'Expected a JSON object'); return parsed as Record<string, unknown>; } catch { throw new MtfHttpError(400, 'Invalid JSON'); }
    };
    const path = url.pathname.replace('/api/mtf/', ''); const method = request.method;
    try {
      if (path === 'workspace' && method === 'POST') {
        this.auth.checkOrigin(request);
        const existing = await this.auth.user(request);
        if (existing) { await this.auth.renewWorkspace(request, response); send(200, { user: existing }); return true; }
        await this.auth.throttle(request, 'automatic-workspace');
        const user = await this.store.transaction(async tx => {
          const id = newId(); const username = `workspace_${id}`;
          // An opaque browser session owns the ledger until app-wide identity is added.
          // There are no public/shared credentials and existing portfolios are never reassigned.
          await tx.sql.query('INSERT INTO mtf_users VALUES($1,$2,$3,$4)', [id, username, await hashPassword(randomBytes(32).toString('hex')), new Date().toISOString()]);
          const accountId = newId();
          await tx.write(id, accountId, 'account', accountId, { id: accountId, label: 'My MTF portfolio', broker: 'Manual / Zerodha', createdAt: new Date().toISOString() }, 0, 'Automatic workspace created');
          return { id, username };
        });
        send(200, { user: await this.auth.session(user, response, 365 * 86_400) }); return true;
      }
      if (path === 'session' && method === 'GET') { send(200, { user: await this.auth.user(request), registrationAllowed: this.options.allowRegistration ?? !this.options.production }); return true; }
      if ((path === 'login' || path === 'register') && method === 'POST') {
        this.auth.checkOrigin(request); const input = await body(); await this.auth.throttle(request, input.username);
        let user: { id: string; username: string };
        if (path === 'register') {
          assertHttp(this.options.allowRegistration ?? !this.options.production, 403, 'New registrations are disabled');
          assertHttp(input.consent === true, 400, 'Consent to private portfolio storage is required');
          user = await this.store.transaction(async tx => {
            const created = await new MtfAuth(tx, !!this.options.production, this.options.origin).register(input);
            const id = newId(); await tx.write(created.id, id, 'account', id, { id, label: 'My MTF portfolio', broker: 'Manual / Zerodha', createdAt: new Date().toISOString() }, 0, 'Account created'); return created;
          });
        } else user = await this.auth.login(input);
        send(200, { user: await this.auth.session(user, response) }); return true;
      }
      const user = await this.auth.user(request); assertHttp(user, 401, 'Sign in to your private MTF workspace');
      if (method !== 'GET') this.auth.writeAccess(request, user);
      if (path === 'logout' && method === 'POST') { await this.auth.logout(request, response); send(200, { ok: true }); return true; }
      if (path === 'password' && method === 'POST') {
        const input = await body(); await this.auth.login({ username: user.username, password: input.currentPassword });
        const temp = new MtfAuth(this.store, !!this.options.production, this.options.origin); temp.credentials({ username: user.username, password: input.password });
        await this.store.sql.query('UPDATE mtf_users SET password=$1 WHERE id=$2', [await hashPassword(input.password as string), user.id]);
        await this.store.sql.query('DELETE FROM mtf_sessions WHERE owner=$1', [user.id]); send(200, { user: await this.auth.session(user, response) }); return true;
      }
      if (path === 'accounts' && method === 'GET') { send(200, { accounts: await this.store.list<MtfAccount>(user.id, 'account') }); return true; }
      const input = method === 'GET' ? {} : await body();
      const accountId = String(input.accountId ?? url.searchParams.get('accountId') ?? (path === 'broker/callback' ? url.searchParams.get('state')?.split(':')[0] : '') ?? '');
      if (path === 'accounts' && method === 'POST') {
        const label = String(input.label ?? '').trim(); assertHttp(label.length > 0 && label.length <= 80, 400, 'Account label is required');
        assertHttp((await this.store.list(user.id, 'account')).length < 20, 400, 'Account limit reached');
        const id = newId(); const account = { id, label, broker: 'Manual / Zerodha', createdAt: new Date().toISOString() };
        const created = await this.store.operation(user.id, String(request.headers['idempotency-key'] ?? ''), input, async tx => { await tx.write(user.id, id, 'account', id, account, 0, 'Account created'); return account; }); send(201, { account: created }); return true;
      }
      if (path === 'profile' && method === 'DELETE') { await this.store.sql.query('DELETE FROM mtf_users WHERE id=$1', [user.id]); await this.auth.logout(request, response); send(200, { ok: true }); return true; }
      await this.account(user.id, accountId);
      const scope = { tenantId: user.id, accountId }; const now = new Date().toISOString();
      const idempotency = () => String(request.headers['idempotency-key'] ?? '');
      const asOf = url.searchParams.get('asOf') ?? now; assertHttp(instant(asOf) <= instant(now), 400, 'As-of time cannot be in the future');
      if (path === 'summary' && method === 'GET') { send(200, await this.summary(user.id, accountId, asOf)); return true; }
      if (path === 'refresh' && method === 'POST') { send(200, await this.refresh(user.id, accountId)); return true; }
      if (path === 'history' && method === 'GET') { send(200, { history: await this.store.list(user.id, 'snapshot', accountId) }); return true; }
      if (path === 'export' && method === 'GET') {
        const documents = await this.documents(user.id, accountId); const prices = await this.prices(user.id, accountId, asOf);
        const ledgers = documents.map(d => ({ id: d.id, snapshot: derivePortfolioPosition(d, scope, asOf, prices.find(p => p.symbol === d.position.symbol) ?? null) }));
        const revisions = await Promise.all(documents.map(async d => ({ id: d.id, revisions: await this.store.history(user.id, 'position', d.id) })));
        send(200, { version: 2, asOf, account: await this.account(user.id, accountId), documents, ledgers, revisions, history: await this.store.list(user.id, 'snapshot', accountId), evidence: 'PRIVATE_UNRECONCILED_LEDGER' }); return true;
      }
      if (path === 'positions' && method === 'GET') {
        const summary = await this.summary(user.id, accountId, asOf); const status = url.searchParams.get('status'); const search = (url.searchParams.get('q') ?? '').toUpperCase();
        const rows = summary.rows.filter(r => (!status || r.snapshot.status === status) && r.document.position.symbol.includes(search));
        const page = Math.max(1, Math.min(10000, Number(url.searchParams.get('page') ?? 1) || 1)); send(200, { count: rows.length, rows: rows.slice((page - 1) * 50, page * 50), summary: summary.summary }); return true;
      }
      if ((path === 'positions' || path === 'migrate') && method === 'POST') {
        const items = path === 'migrate' ? input.positions : [input]; assertHttp(Array.isArray(items) && items.length > 0 && items.length <= 500, 400, 'Expected 1–500 positions');
        const documents = await this.store.operation(user.id, idempotency(), input, async tx => {
          assertHttp((await this.documents(user.id, accountId, tx)).length + items.length <= 1000, 400, 'Portfolio limit reached');
          const created: PortfolioDocument[] = [];
          for (const item of items) { const requested = item?.position?.id; const id = typeof requested === 'string' && /^[0-9a-f-]{36}$/.test(requested) ? requested : newId(); assertHttp(!await tx.read(user.id, 'position', id), 409, 'This position was already saved'); const document = createPortfolioDocument(item, scope, id, now); await tx.write(user.id, accountId, 'position', document.id, document, 0, path === 'migrate' ? 'Browser data migration (unverified)' : 'Position created', now); created.push(document); } return created;
        }); send(201, { documents }); return true;
      }
      const match = /^positions\/([A-Za-z0-9-]+)(?:\/(events|charges|history|scenarios))?$/.exec(path);
      if (match) {
        const document = await this.store.read<PortfolioDocument>(user.id, 'position', match[1]); assertHttp(document && document.accountId === accountId, 404, 'Position not found');
        const quoteHistory = await this.store.history<PortfolioPrice>(user.id, 'quote', `quote:${accountId}:${digest(document.position.symbol)}`, 500);
        const price = (await this.prices(user.id, accountId, asOf)).find(q => q.symbol === document.position.symbol) ?? null;
        if (method === 'GET') {
          if (match[2] === 'history') send(200, { revisions: await this.store.history(user.id, 'position', document.id) });
          else if (match[2] === 'scenarios') send(200, { scenarios: projectPosition(document, scope, asOf, price) });
          else { const snapshot = derivePortfolioPosition(document, scope, asOf, price); send(200, { document, snapshot, scenarios: projectPosition(document, scope, asOf, price), quoteHistory: quoteHistory.slice(0, 500).map(q => q.document) }); } return true;
        }
        if (method === 'PATCH' || method === 'POST') {
          const reason = String(input.reason ?? '').trim(); assertHttp(reason.length > 0 && reason.length <= 500, 400, 'A change reason is required');
          const updated = await this.store.operation(user.id, idempotency(), input, async tx => {
            const latest = await tx.read<PortfolioDocument>(user.id, 'position', document.id); assertHttp(latest && latest.accountId === accountId, 404, 'Position not found');
            assertHttp(input.version === latest.version, 409, 'Position changed. Reload before saving.');
            let next = structuredClone(latest);
            if (!match[2]) {
              assertHttp(!latest.events.length && !latest.rateChanges?.length, 400, 'Positions with ledger events must be corrected through new events');
              next = { ...createPortfolioDocument(input, scope, latest.id, now), createdAt: latest.createdAt, charges: latest.charges };
            } else if (match[2] === 'events') {
              assertHttp(input.event && typeof input.event === 'object', 400, 'Event required');
              const event = { ...(input.event as MtfEvent), ...scope, id: newId(), lotId: document.id, source: { kind: 'MANUAL_UNVERIFIED', reference: reason } } as MtfEvent;
              assertHttp(instant(event.at) <= instant(now), 400, 'Future events are not allowed');
              const raw = input.event as Record<string, unknown>;
              if (raw.kind === 'RATE_CHANGE') {
                assertHttp(latest.dailyFraction !== null,400,'A funded-principal model is required for rate changes'); const rate = amount(String(raw.dailyFraction)); assertHttp(rate.lte(1),400,'Invalid daily rate'); const date=istDay(String(raw.at)); assertHttp(date>latest.position.boughtDate,400,'Rate change must follow purchase date');
                next.rateChanges=[...(next.rateChanges??[]),{id:newId(),effectiveFrom:date,dailyFraction:rate.toFixed(),at:now,reference:reason}];
              } else next.events.push(event);
            } else if (match[2] === 'charges') {
              const raw = input.charge as MtfCharge; assertHttp(raw && typeof raw === 'object', 400, 'Charge required');
              const reference = String(input.reference ?? '').trim(); assertHttp(reference.length >= 3 && reference.length <= 200, 400, 'Statement reference required');
              assertHttp(!latest.charges.some(c => c.source.reference === reference), 409, 'This statement reference is already recorded');
              const charge = { ...raw, ...scope, id: newId(), lotId: document.id, at: now, source: { kind: raw.evidence === 'ACTUAL' ? 'VERIFIED' : 'MANUAL_UNVERIFIED', reference } } as MtfCharge;
              amount(charge.amountInr, true); next.charges.push(charge);
            } else throw new MtfHttpError(405, 'Method not allowed');
            next.version = latest.version + 1; next.updatedAt = now;
            const snapshot = derivePortfolioPosition(next, scope, now, price); assertHttp(snapshot.metrics, 400, snapshot.issues[0]?.code ?? 'Invalid ledger event');
            await tx.write(user.id, accountId, 'position', next.id, next, latest.version, reason, now); return next;
          }); send(200, { document: updated }); return true;
        }
      }
      if (path.startsWith('broker/')) { await this.broker(path, method ?? '', user, accountId, input, url, response, send); return true; }
      send(404, { error: 'MTF endpoint not found' }); return true;
    } catch (error) {
      const conflict = typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
      const status = error instanceof MtfHttpError ? error.status : error instanceof MtfDomainError ? 400 : conflict ? 409 : 500;
      send(status, { error: error instanceof MtfHttpError || error instanceof MtfDomainError ? error.message : conflict ? 'Record already exists. Refresh before retrying.' : 'Could not complete the private portfolio request' }); return true;
    }
  }
  async broker(path: string, method: string, user: Identity, account: string, input: Record<string, unknown>, url: URL, response: ServerResponse, send: (status: number, body: unknown) => void) {
    const client = this.options.kite; const id = `broker:${account}`;
    const current = await this.store.read<{ version: number; credentials?: KiteCredentials; pending?: { state: string; expires: number }; lastSync?: string; holdings?: BrokerHolding[] }>(user.id, 'broker', id);
    if (method === 'GET' && path === 'broker/status') { send(200, { configured: !!client, connected: !!current?.credentials && Date.parse(current.credentials.expiresAt) > Date.now(), expiresAt: current?.credentials?.expiresAt ?? null, lastSync: current?.lastSync ?? null, holdings: current?.holdings ?? [] }); return; }
    assertHttp(client, 503, 'Kite connection needs your server-side developer API credentials');
    if (path === 'broker/connect' && method === 'POST') {
      assertHttp(input.consent === true, 400, 'Read-only access consent is required');
      const state = randomBytes(32).toString('hex');
      await this.store.transaction(async tx => { await tx.write(user.id, account, 'broker', id, { version: (current?.version ?? 0) + 1, pending: { state: digest(state), expires: Date.now() + 300_000 } }, current?.version ?? 0, 'User consented to read-only broker connection'); });
      send(200, { url: client.loginUrl(`${account}:${state}`) }); return;
    }
    if (path === 'broker/callback' && method === 'GET') {
      const state = url.searchParams.get('state') ?? ''; const token = url.searchParams.get('request_token') ?? '';
      assertHttp(current?.pending && current.pending.expires > Date.now() && digest(state.split(':').at(-1) ?? '') === current.pending.state, 403, 'Broker login state is invalid or expired');
      await this.store.transaction(async tx => { await tx.write(user.id, account, 'broker', id, { version: current.version + 1 }, current.version, 'Broker callback consumed'); });
      const credentials = await client.exchange(token);
      await this.store.transaction(async tx => { await tx.write(user.id, account, 'broker', id, { version: current.version + 2, credentials }, current.version + 1, 'Broker session connected'); });
      response.writeHead(303, { location: `${this.options.origin ?? '/'}${this.options.origin ? '/' : ''}#mtf`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); response.end(); return;
    }
    if (path === 'broker/disconnect' && method === 'POST') { let warning: string | null=null; if(current?.credentials)try{await client.revoke(current.credentials);}catch{warning='Connection deleted locally; broker session revocation could not be confirmed. Sign out of your broker if needed.';} await this.store.remove(user.id, 'broker', id); send(200, { ok: true, warning }); return; }
    if (path === 'broker/sync' && method === 'POST') {
      assertHttp(current?.credentials, 401, 'Connect your broker first'); const holdings = await client.holdings(current.credentials);
      await this.store.transaction(async tx => { await tx.write(user.id, account, 'broker', id, { ...current, version: current.version + 1, holdings, lastSync: new Date().toISOString() }, current.version, 'Read-only broker snapshot; funding and trade history need review'); });
      send(200, { holdings, evidence: 'BROKER_SNAPSHOT_NEEDS_REVIEW' }); return;
    }
    throw new MtfHttpError(404, 'Broker endpoint not found');
  }
  startSnapshots(interval = 150_000) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return; running = true;
      try { const owners = await this.store.sql.query<{ id: string }>('SELECT id FROM mtf_users'); for (const owner of owners) for (const account of await this.store.list<MtfAccount>(owner.id, 'account')) { try { await this.refresh(owner.id, account.id); } catch { /* next scheduled run retries; no private data logged */ } } } catch { /* database outage: next scheduled run retries */ } finally { running = false; }
    }, interval); timer.unref(); return () => clearInterval(timer);
  }
}
