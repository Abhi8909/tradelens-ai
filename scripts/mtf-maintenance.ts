import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, scryptSync } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { resolve } from 'node:path';
import { storeFromEnv, assertHttp, newId } from '../apps/api/src/mtf/store.ts';
import { MtfAuth } from '../apps/api/src/mtf/auth.ts';
const [action, destination] = process.argv.slice(2);
const store = await storeFromEnv(process.env);
try {
  if (action === 'backup') {
    assertHttp(destination, 400, 'Provide a private backup path');
    if (process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGSSLMODE: url.searchParams.get('sslmode') ?? 'verify-full' };
      await promisify(execFile)('pg_dump', ['--format=custom','--no-owner','--file',resolve(destination)], { env, maxBuffer: 1024*1024 }); chmodSync(resolve(destination),0o600);
    } else await store.backupTo(resolve(destination));
    console.log('Encrypted portfolio database backup created. Keep the encryption key separately in your secret manager.');
  } else if (action === 'create-user' || action === 'reset-password') {
    const username = process.env.MTF_ADMIN_USERNAME; const password = process.env.MTF_ADMIN_PASSWORD;
    assertHttp(username && password,400,'Provide MTF_ADMIN_USERNAME and MTF_ADMIN_PASSWORD through a private environment');
    if (action === 'create-user') await store.transaction(async tx=>{const user=await new MtfAuth(tx,true).register({username,password});const id=newId();await tx.write(user.id,id,'account',id,{id,label:'My MTF portfolio',broker:'Manual / Zerodha',createdAt:new Date().toISOString()},0,'Administrator provisioned account');});
    else {new MtfAuth(store,true).credentials({username,password});const salt=randomBytes(16).toString('hex');const rows=await store.sql.query<{id:string}>('UPDATE mtf_users SET password=$1 WHERE username=$2 RETURNING id',[`${salt}:${scryptSync(password,salt,64).toString('hex')}`,username.toLowerCase()]);assertHttp(rows.length===1,404,'User not found');await store.sql.query('DELETE FROM mtf_sessions WHERE owner=$1',[rows[0].id]);}
    console.log('Account maintenance completed.');
  } else throw new Error('Supported actions: backup, create-user, reset-password');
} catch { console.error('Maintenance failed. Check private configuration and permissions; no credentials were logged.'); process.exitCode=1; }
finally {await store.close();}
