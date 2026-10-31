import { DatabaseSync, backup } from 'node:sqlite';
import { Pool, type PoolClient } from 'pg';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
export type SqlRow = Record<string, unknown>;
export interface SqlDatabase {
  dialect: 'postgres' | 'sqlite';
  query<T extends SqlRow = SqlRow>(sql: string, values?: unknown[]): Promise<T[]>;
  transaction<T>(work: (sql: SqlDatabase) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  backup?(path: string): Promise<void>;
}
export function postgresDatabase(url: string): SqlDatabase {
  const pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000 });
  const clientDb = (client: PoolClient): SqlDatabase => ({ dialect: 'postgres',
    async query<T extends SqlRow>(sql: string, values: unknown[] = []) { return (await client.query(sql, values)).rows as T[]; },
    async transaction() { throw new Error('Nested transaction is not supported'); }, async close() {},
  });
  return { dialect: 'postgres',
    async query<T extends SqlRow>(sql: string, values: unknown[] = []) { return (await pool.query(sql, values)).rows as T[]; },
    async transaction(work) {
      const client = await pool.connect();
      try { await client.query('BEGIN'); const result = await work(clientDb(client)); await client.query('COMMIT'); return result; }
      catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    }, async close() { await pool.end(); },
  };
}
/** Development/test adapter. Hosted production must configure DATABASE_URL. */
export function sqliteDatabase(path: string): SqlDatabase {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path); if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  let queue = Promise.resolve();
  const lock = <T>(work: () => Promise<T>) => { const result = queue.then(work); queue = result.then(() => {}, () => {}); return result; };
  const direct: SqlDatabase = { dialect: 'sqlite',
    async query<T extends SqlRow>(sql: string, values: unknown[] = []) {
      const statement = db.prepare(sql.replace(/\$\d+/g, '?'));
      return statement.all(...values as (string | number | null)[]) as T[];
    }, async transaction() { throw new Error('Nested transaction is not supported'); }, async close() {},
  };
  return { dialect: 'sqlite',
    query: (sql, values) => lock(() => direct.query(sql, values)),
    transaction: work => lock(async () => { db.exec('BEGIN IMMEDIATE'); try { const result = await work(direct); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } }),
    close: () => lock(async () => db.close()), backup: path => lock(async () => { await backup(db, path); chmodSync(path, 0o600); }),
  };
}
export async function migrateDatabase(sql: SqlDatabase) {
  await sql.transaction(async tx => {
    // A transaction plus a PostgreSQL advisory lock serializes rolling-deployment migrations.
    // SQLite already serializes writers with BEGIN IMMEDIATE.
    if (tx.dialect === 'postgres') await tx.query('SELECT pg_advisory_xact_lock(84732101)');
    for (const statement of [
      'CREATE TABLE IF NOT EXISTS mtf_migrations(version INTEGER PRIMARY KEY, applied TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mtf_users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, created TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS mtf_sessions(token TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES mtf_users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires BIGINT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS mtf_sessions_expiry ON mtf_sessions(expires)',
      'CREATE TABLE IF NOT EXISTS mtf_rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires BIGINT NOT NULL)',
      'CREATE INDEX IF NOT EXISTS mtf_rate_limits_expiry ON mtf_rate_limits(expires)',
      'CREATE TABLE IF NOT EXISTS mtf_records(owner TEXT NOT NULL REFERENCES mtf_users(id) ON DELETE CASCADE, account TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(owner,kind,id))',
      'CREATE INDEX IF NOT EXISTS mtf_records_account ON mtf_records(owner,account,kind,updated)',
      'CREATE TABLE IF NOT EXISTS mtf_revisions(owner TEXT NOT NULL REFERENCES mtf_users(id) ON DELETE CASCADE, account TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, payload TEXT NOT NULL, updated TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(owner,kind,id,version))',
      'CREATE INDEX IF NOT EXISTS mtf_revisions_account ON mtf_revisions(owner,account,id,updated)',
      'CREATE TABLE IF NOT EXISTS mtf_operations(owner TEXT NOT NULL REFERENCES mtf_users(id) ON DELETE CASCADE, key TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,key))',
    ]) await tx.query(statement);
    await tx.query('INSERT INTO mtf_migrations VALUES($1,$2) ON CONFLICT(version) DO NOTHING', [1, new Date().toISOString()]);
  });
}
