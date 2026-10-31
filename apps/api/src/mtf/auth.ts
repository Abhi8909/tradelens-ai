import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { MtfStore, assertHttp, digest, newId } from './store.ts';
const derivePassword = (password: string, salt: string) => new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function hashPassword(password: string) { const salt=randomBytes(16).toString('hex'); return `${salt}:${(await derivePassword(password,salt)).toString('hex')}`; }
export type Identity = { id: string; username: string; csrf: string };
export class MtfAuth {
  readonly store: MtfStore; readonly secure: boolean; readonly origin?: string;
  constructor(store: MtfStore, secure: boolean, origin?: string) { this.store = store; this.secure = secure; this.origin = origin?.trim() || undefined; }
  checkOrigin(request: IncomingMessage) {
    let actual: URL;
    try { actual = new URL(String(request.headers.origin)); } catch { assertHttp(false, 403, 'Same-origin request required'); }
    const expected = this.origin ?? `http://${request.headers.host}`;
    assertHttp(actual.origin === expected, 403, 'Origin not allowed');
    if (!this.origin) assertHttp(['127.0.0.1', 'localhost', '[::1]'].includes(actual.hostname), 403, 'Configure the application origin before remote access');
  }
  async user(request: IncomingMessage): Promise<Identity | null> {
    const token = /(?:^|;\s*)mtf_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
    if (!token) return null;
    const [row] = await this.store.sql.query<Identity>('SELECT u.id,u.username,s.csrf FROM mtf_sessions s JOIN mtf_users u ON u.id=s.owner WHERE s.token=$1 AND s.expires>$2', [digest(token), Date.now()]);
    return row ?? null;
  }
  writeAccess(request: IncomingMessage, identity: Identity) {
    this.checkOrigin(request); const supplied = request.headers['x-mtf-csrf'];
    assertHttp(typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && supplied.length === identity.csrf.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(identity.csrf)), 403, 'Invalid request token');
  }
  credentials(raw: unknown): { username: string; password: string } {
    const input = raw as Record<string, unknown>;
    assertHttp(input && typeof input.username === 'string' && /^[A-Za-z0-9_.-]{3,60}$/.test(input.username) && typeof input.password === 'string' && input.password.length >= 12 && input.password.length <= 128, 400, 'Use a 3–60 character username and password of 12–128 characters');
    return { username: input.username.toLowerCase(), password: input.password };
  }
  async throttle(request: IncomingMessage, username: unknown) {
    const now=Date.now(); const bucket=Math.floor(now/60_000); const address=request.socket.remoteAddress??'unknown';
    const name=typeof username==='string'?username.toLowerCase().slice(0,60):'unknown';
    for(const [key,limit] of [[digest(`ip:${address}:${bucket}`),100],[digest(`name:${address}:${name}:${bucket}`),10]] as const){
      const [row]=await this.store.sql.query<{count:number}>('INSERT INTO mtf_rate_limits VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=mtf_rate_limits.count+1 RETURNING count',[key,now+120_000]);
      assertHttp(row.count<=limit,429,'Too many sign-in attempts. Try again in a minute.');
    }
    await this.store.sql.query('DELETE FROM mtf_rate_limits WHERE expires<$1',[now]);
  }
  async register(raw: unknown) {
    const { username, password } = this.credentials(raw);
    assertHttp(!(await this.store.sql.query('SELECT 1 FROM mtf_users WHERE username=$1', [username])).length, 409, 'Username is not available');
    const hash = await hashPassword(password); const id = newId();
    await this.store.sql.query('INSERT INTO mtf_users VALUES($1,$2,$3,$4)', [id, username, hash, new Date().toISOString()]); return { id, username };
  }
  async login(raw: unknown) {
    const { username, password } = this.credentials(raw);
    const [row] = await this.store.sql.query<{ id: string; username: string; password: string }>('SELECT * FROM mtf_users WHERE username=$1', [username]);
    const [salt, expected] = row?.password.split(':') ?? ['synthetic-constant-salt', '0'.repeat(128)];
    const hash = await derivePassword(password, salt); assertHttp(timingSafeEqual(hash, Buffer.from(expected, 'hex')) && !!row, 401, 'Invalid username or password');
    return { id: row.id, username: row.username };
  }
  async session(user: { id: string; username: string }, response: ServerResponse, maxAge = 43_200): Promise<Identity> {
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex');
    await this.store.sql.query('DELETE FROM mtf_sessions WHERE expires<=$1', [Date.now()]);
    await this.store.sql.query('INSERT INTO mtf_sessions VALUES($1,$2,$3,$4)', [digest(token), user.id, csrf, Date.now() + maxAge * 1000]);
    response.setHeader('set-cookie', `mtf_session=${token}; HttpOnly; SameSite=Lax; Path=/api/mtf; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`);
    return { ...user, csrf };
  }
  async renewWorkspace(request: IncomingMessage, response: ServerResponse) {
    const token = /(?:^|;\s*)mtf_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
    assertHttp(token, 401, 'Workspace session is unavailable');
    const maxAge = 365 * 86_400;
    await this.store.sql.query('UPDATE mtf_sessions SET expires=$1 WHERE token=$2', [Date.now() + maxAge * 1000, digest(token)]);
    response.setHeader('set-cookie', `mtf_session=${token}; HttpOnly; SameSite=Lax; Path=/api/mtf; Max-Age=${maxAge}${this.secure ? '; Secure' : ''}`);
  }
  async logout(request: IncomingMessage, response: ServerResponse) {
    const token = /mtf_session=([a-f0-9]{64})/.exec(request.headers.cookie ?? '')?.[1]; if (token) await this.store.sql.query('DELETE FROM mtf_sessions WHERE token=$1', [digest(token)]);
    response.setHeader('set-cookie', `mtf_session=; HttpOnly; SameSite=Lax; Path=/api/mtf; Max-Age=0${this.secure ? '; Secure' : ''}`);
  }
}
