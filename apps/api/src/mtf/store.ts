import { migrateDatabase, postgresDatabase, sqliteDatabase, type SqlDatabase } from './database.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export class MtfHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
export function assertHttp(condition: unknown, status: number, message: string): asserts condition { if (!condition) throw new MtfHttpError(status, message); }
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
type Stored = { owner: string; account: string; kind: string; id: string; version: number; payload: string; updated: string };
export class MtfStore {
  readonly sql: SqlDatabase; readonly key: Buffer;
  constructor(sql: SqlDatabase, key: Buffer) { this.sql = sql; this.key = key; assertHttp(key.length === 32, 500, 'Invalid database encryption key'); }
  async migrate() { await migrateDatabase(this.sql); }
  seal(value: unknown, aad: string): string {
    const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, nonce); cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open<T>(payload: string, aad: string): T {
    const raw = Buffer.from(payload, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  }
  aad(owner: string, kind: string, id: string, version: number) { return JSON.stringify([owner, kind, id, version]); }
  async read<T>(owner: string, kind: string, id: string): Promise<T | null> {
    const [row] = await this.sql.query<Stored>('SELECT * FROM mtf_records WHERE owner=$1 AND kind=$2 AND id=$3', [owner, kind, id]);
    return row ? this.open<T>(row.payload, this.aad(owner, kind, id, row.version)) : null;
  }
  async list<T>(owner: string, kind: string, account?: string): Promise<T[]> {
    const rows = await this.sql.query<Stored>(`SELECT * FROM mtf_records WHERE owner=$1 AND kind=$2${account === undefined ? '' : ' AND account=$3'} ORDER BY updated,id`, account === undefined ? [owner, kind] : [owner, kind, account]);
    return rows.map(row => this.open<T>(row.payload, this.aad(owner, kind, row.id, row.version)));
  }
  async write(owner: string, account: string, kind: string, id: string, value: unknown, expected: number, reason: string, now = new Date().toISOString()) {
    const [current] = await this.sql.query<{ version: number }>('SELECT version FROM mtf_records WHERE owner=$1 AND kind=$2 AND id=$3', [owner, kind, id]);
    assertHttp((current?.version ?? 0) === expected, 409, 'This record changed. Reload before saving.');
    const version = expected + 1; const payload = this.seal(value, this.aad(owner, kind, id, version));
    if (current) {
      const updated = await this.sql.query('UPDATE mtf_records SET version=$1,payload=$2,updated=$3 WHERE owner=$4 AND kind=$5 AND id=$6 AND version=$7 RETURNING id', [version, payload, now, owner, kind, id, expected]);
      assertHttp(updated.length === 1, 409, 'This record changed. Reload before saving.');
    } else await this.sql.query('INSERT INTO mtf_records VALUES($1,$2,$3,$4,$5,$6,$7)', [owner, account, kind, id, version, payload, now]);
    await this.sql.query('INSERT INTO mtf_revisions VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [owner, account, kind, id, version, payload, now, this.seal(reason, `reason:${owner}:${id}:${version}`)]);
  }
  async history<T>(owner: string, kind: string, id: string, limit?: number) {
    const rows = await this.sql.query<Stored & { reason: string }>(`SELECT * FROM mtf_revisions WHERE owner=$1 AND kind=$2 AND id=$3 ORDER BY version DESC${limit === undefined ? '' : ' LIMIT $4'}`, limit === undefined ? [owner, kind, id] : [owner, kind, id, Math.max(1,Math.min(1000,Math.floor(limit)))]);
    return rows.map(row => ({ version: row.version, at: row.updated, reason: this.open<string>(row.reason, `reason:${owner}:${id}:${row.version}`), document: this.open<T>(row.payload, this.aad(owner, kind, id, row.version)) }));
  }
  async transaction<T>(work: (store: MtfStore) => Promise<T>): Promise<T> { return this.sql.transaction(sql => work(new MtfStore(sql, this.key))); }
  async operation<T>(owner: string, key: string, input: unknown, work: (store: MtfStore) => Promise<T>): Promise<T> {
    assertHttp(/^[A-Za-z0-9:_-]{8,150}$/.test(key), 400, 'An idempotency key is required');
    const hash = digest(JSON.stringify(input));
    return this.transaction(async tx => {
      if (tx.sql.dialect === 'postgres') await tx.sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${owner}:${key}`]);
      const [previous] = await tx.sql.query<{ hash: string; payload: string }>('SELECT hash,payload FROM mtf_operations WHERE owner=$1 AND key=$2', [owner, key]);
      if (previous) { assertHttp(previous.hash === hash, 409, 'Idempotency key was already used for another request'); return this.open<T>(previous.payload, `operation:${owner}:${key}`); }
      const result = await work(tx); await tx.sql.query('INSERT INTO mtf_operations VALUES($1,$2,$3,$4)', [owner, key, hash, this.seal(result, `operation:${owner}:${key}`)]); return result;
    });
  }
  async remove(owner: string, kind: string, id: string) {
    await this.transaction(async tx => {
      await tx.sql.query('DELETE FROM mtf_records WHERE owner=$1 AND kind=$2 AND id=$3', [owner, kind, id]);
      await tx.sql.query('DELETE FROM mtf_revisions WHERE owner=$1 AND kind=$2 AND id=$3', [owner, kind, id]);
    });
  }
  async backupTo(path: string) { assertHttp(this.sql.backup, 400, 'Use PostgreSQL pg_dump / managed backups for hosted storage'); await this.sql.backup(path); }
  async close() { await this.sql.close(); }
}

export async function storeFromEnv(env: NodeJS.ProcessEnv): Promise<MtfStore> {
  assertHttp(env.NODE_ENV !== 'production' || !!env.DATABASE_URL, 500, 'Hosted production requires DATABASE_URL (PostgreSQL)');
  const path = env.MTF_DB_PATH ?? resolve('.data/mtf.sqlite');
  let key: Buffer;
  if (env.MTF_ENCRYPTION_KEY) { assertHttp(/^[a-fA-F0-9]{64}$/.test(env.MTF_ENCRYPTION_KEY), 500, 'MTF_ENCRYPTION_KEY must be 64 hex characters'); key = Buffer.from(env.MTF_ENCRYPTION_KEY, 'hex'); }
  else {
    assertHttp(env.NODE_ENV !== 'production', 500, 'Production requires MTF_ENCRYPTION_KEY');
    const keyPath = `${path}.key`; mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    key = readFileSync(keyPath);
  }
  const store = new MtfStore(env.DATABASE_URL ? postgresDatabase(env.DATABASE_URL) : sqliteDatabase(path), key); await store.migrate(); return store;
}
export const newId = () => randomUUID();
