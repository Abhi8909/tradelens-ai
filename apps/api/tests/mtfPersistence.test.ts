import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { MtfAuth } from '../src/mtf/auth.ts';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.ts';
import { MtfStore, digest } from '../src/mtf/store.ts';
import { sqliteDatabase, postgresDatabase } from '../src/mtf/database.ts';
import { MtfService } from '../src/mtf/service.ts';
import { KiteReadOnlyClient } from '../src/mtf/kite.ts';

type Login = { cookie: string; csrf: string; account: string; userId: string };
async function withMtf(run: (ctx: { base: string; store: MtfStore; request: (path: string, data?: unknown, user?: Login, method?: string, key?: string) => Promise<Response>; register: () => Promise<Login> }) => Promise<void>, postgres = false, kite?: KiteReadOnlyClient) {
  const db = postgres ? postgresDatabase(process.env.MTF_TEST_DATABASE_URL!) : sqliteDatabase(':memory:');
  const store = new MtfStore(db, randomBytes(32)); await store.migrate();
  const mtf = new MtfService({ store, allowRegistration: true, kite }); const server = createApp(undefined, { mtf }); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const address=server.address();assert.ok(address&&typeof address!=='string');const base=`http://127.0.0.1:${address.port}`;
  const request = (path:string,data?:unknown,user?:Login,method=data===undefined?'GET':'POST',key:string=randomUUID()) => fetch(`${base}/api/mtf/${path}`,{method,headers:{origin:base,...(data===undefined?{}:{'content-type':'application/json','idempotency-key':key}),...(user?{cookie:user.cookie,'x-mtf-csrf':user.csrf}:{})},body:data===undefined?undefined:JSON.stringify(data)});
  const owners: string[]=[];
  async function register(){const response=await request('register',{username:`synthetic_${randomUUID().slice(0,8)}`,password:'synthetic-password-123',consent:true});assert.equal(response.status,200);const json=await response.json();owners.push(json.user.id);const cookie=response.headers.get('set-cookie')!.split(';')[0];const user={cookie,csrf:json.user.csrf,account:'',userId:json.user.id};const accounts=await(await request('accounts',undefined,user)).json();user.account=accounts.accounts[0].id;return user;}
  try { await run({base,store,request,register}); }
  finally {await new Promise<void>(resolve=>server.close(()=>resolve()));await mtf.calculations.close();for(const owner of owners)await store.sql.query('DELETE FROM mtf_users WHERE id=$1',[owner]);await store.close();}
}
function input(accountId:string, overrides:Record<string,unknown>={}) { return { accountId,position:{id:randomUUID(),symbol:'SYNTHETIC',boughtDate:'2026-01-01',quantity:100,buyPriceInr:'100',interestPerDayInr:'2.40',otherChargesInr:'20',exitDate:null,manualPrice:{priceInr:'110',at:new Date().toISOString()},...overrides} }; }

test('MTF database API enforces authentication, ownership, CSRF/origin and secure session attributes',async()=>withMtf(async({request,register,base})=>{
  assert.equal((await request('accounts')).status,401);const alice=await register();const bob=await register();
  assert.equal((await request(`summary?accountId=${alice.account}`,undefined,bob)).status,404);
  assert.equal((await request('positions',input(alice.account),{...alice,csrf:'0'.repeat(64)})).status,403);
  const wrong=await fetch(`${base}/api/mtf/positions`,{method:'POST',headers:{origin:'https://other.example','content-type':'application/json',cookie:alice.cookie,'x-mtf-csrf':alice.csrf},body:JSON.stringify(input(alice.account))});assert.equal(wrong.status,403);
  const created=await request('positions',input(alice.account),alice);assert.equal(created.status,201);const id=(await created.json()).documents[0].id;
  assert.equal((await request(`positions/${id}?accountId=${bob.account}`,undefined,bob)).status,404);
  const response=await request('login',{username:'no_such_user',password:'synthetic-password-123'});assert.equal(response.status,401);
}));

test('MTF transactions persist revisions, reject stale edits and preserve original documents',async()=>withMtf(async({request,register,store})=>{
  const user=await register();const payload=input(user.account);const created=await(await request('positions',payload,user)).json();const document=created.documents[0];
  const updated=await request(`positions/${document.id}`,{...payload,position:{...payload.position,otherChargesInr:'30'},version:1,reason:'Synthetic fee correction'},user,'PATCH');assert.equal(updated.status,200);
  assert.equal((await request(`positions/${document.id}`,{...payload,version:1,reason:'Stale change'},user,'PATCH')).status,409);
  const history=await(await request(`positions/${document.id}/history?accountId=${user.account}`,undefined,user)).json();assert.equal(history.revisions.length,2);assert.equal(history.revisions[1].document.position.otherChargesInr,'20');
  const rows=await store.sql.query<{payload:string}>('SELECT payload FROM mtf_records WHERE owner=$1',[user.userId]);assert.ok(rows.every(r=>!r.payload.includes('SYNTHETIC')));
}));

test('MTF repeated and concurrent idempotency keys create one position',async()=>withMtf(async({request,register})=>{
  const user=await register();const payload=input(user.account);const key=randomUUID();const responses=await Promise.all([request('positions',payload,user,'POST',key),request('positions',payload,user,'POST',key)]);assert.ok(responses.every(r=>r.status===201));
  const ids=await Promise.all(responses.map(async r=>(await r.json()).documents[0].id));assert.equal(ids[0],ids[1]);
  assert.equal((await request('positions',{...payload,position:{...payload.position,quantity:50}},user,'POST',key)).status,409);
  const data=await(await request(`positions?accountId=${user.account}`,undefined,user)).json();assert.equal(data.count,1);
}));

test('MTF partial sales and conversions preserve basis and disappear from open totals',async()=>withMtf(async({request,register})=>{
  const user=await register();const document=(await(await request('positions',input(user.account),user)).json()).documents[0];
  const sale=await request(`positions/${document.id}/events`,{accountId:user.account,version:1,reason:'Synthetic partial sale',event:{kind:'SELL',at:'2026-01-11T12:00:00+05:30',quantity:40,priceInr:'110',principalRepaidInr:null}},user);assert.equal(sale.status,200);
  let detail=await(await request(`positions/${document.id}?accountId=${user.account}`,undefined,user)).json();assert.equal(detail.snapshot.status,'PARTIALLY_SOLD');assert.equal(detail.snapshot.metrics.quantityOpen,60);assert.equal(detail.snapshot.exits[0].originalCostInr,'4000.00');
  const converted=await request(`positions/${document.id}/events`,{accountId:user.account,version:2,reason:'Synthetic delivery conversion',event:{kind:'CONVERT',at:'2026-01-21T12:00:00+05:30',quantity:60,destinationLotId:'synthetic-cnc',principalRepaidInr:null}},user);assert.equal(converted.status,200);
  detail=await(await request(`positions/${document.id}?accountId=${user.account}`,undefined,user)).json();assert.equal(detail.snapshot.status,'CONVERTED_TO_DELIVERY');
  const summary=await(await request(`summary?accountId=${user.account}`,undefined,user)).json();assert.equal(summary.summary.openLots,0);assert.equal(summary.rows.length,1);
}));

test('MTF statement interest replaces an estimate, records variance and rejects duplicate references',async()=>withMtf(async({request,register})=>{
  const user=await register();const doc=(await(await request('positions',input(user.account),user)).json()).documents[0];
  const payload={accountId:user.account,version:1,reason:'Synthetic statement line',reference:'synthetic-statement-line-1',charge:{kind:'INTEREST',effectiveDate:'2026-01-02',amountInr:'3',evidence:'ACTUAL',exitId:null,refundOf:null}};
  assert.equal((await request(`positions/${doc.id}/charges`,payload,user)).status,200);
  const detail=await(await request(`positions/${doc.id}?accountId=${user.account}`,undefined,user)).json();assert.equal(detail.snapshot.dailyInterest[0].actualInr,'3.00');assert.equal(detail.snapshot.dailyInterest[0].varianceInr,'0.60');
  assert.equal((await request(`positions/${doc.id}/charges`,{...payload,version:2},user)).status,409);
}));

test('MTF migration is all-or-nothing, date-only exits stay closed and do not invent realized proceeds',async()=>withMtf(async({request,register})=>{
  const user=await register();const valid=input(user.account);const invalid=input(user.account,{quantity:0});
  assert.equal((await request('migrate',{accountId:user.account,positions:[valid,invalid]},user)).status,400);
  assert.equal((await(await request(`positions?accountId=${user.account}`,undefined,user)).json()).count,0);
  const result=await request('positions',input(user.account,{exitDate:'2026-01-11'}),user);assert.equal(result.status,201);const id=(await result.json()).documents[0].id;
  const detail=await(await request(`positions/${id}?accountId=${user.account}`,undefined,user)).json();assert.equal(detail.snapshot.status,'CLOSED_SOLD');assert.equal(detail.snapshot.metrics.realizedPnlInr,null);assert.equal(detail.snapshot.metrics.interestAccruedInr,'24.00');
}));

test('MTF snapshots, export and per-account projections remain private and exclude future as-of dates',async()=>withMtf(async({request,register})=>{
  const user=await register();const doc=(await(await request('positions',input(user.account),user)).json()).documents[0];
  assert.equal((await request('refresh',{accountId:user.account},user)).status,200);
  const timeline=await(await request(`history?accountId=${user.account}`,undefined,user)).json();assert.equal(timeline.history.length,1);
  const scenarios=await(await request(`positions/${doc.id}/scenarios?accountId=${user.account}`,undefined,user)).json();assert.equal(scenarios.scenarios.length,5);assert.equal(scenarios.scenarios[0].additionalInterestInr,'16.80');
  const report=await(await request(`export?accountId=${user.account}`,undefined,user)).json();assert.equal(report.documents.length,1);assert.equal(report.documents[0].position.symbol,'SYNTHETIC');
  assert.equal((await request(`summary?accountId=${user.account}&asOf=2099-01-01T00:00:00Z`,undefined,user)).status,400);
}));

test('MTF disk encryption, restart persistence and backup/restore use the same secret key',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'tradelens-mtf-'));const path=join(directory,'private.sqlite');const key=randomBytes(32);
  let store=new MtfStore(sqliteDatabase(path),key);
  try{await store.migrate();await store.sql.query('INSERT INTO mtf_users VALUES($1,$2,$3,$4)',['synthetic-owner','synthetic-user','unused-test-password',new Date().toISOString()]);await store.transaction(tx=>tx.write('synthetic-owner','a','account','a',{label:'PRIVATE-SYNTHETIC-LABEL'},0,'Synthetic test'));
    const backup=join(directory,'backup.sqlite');await store.backupTo(backup);await store.close();store=new MtfStore(sqliteDatabase(path),key);assert.deepEqual(await store.read('synthetic-owner','account','a'),{label:'PRIVATE-SYNTHETIC-LABEL'});
    assert.equal((await readFile(path)).includes(Buffer.from('PRIVATE-SYNTHETIC-LABEL')),false);
    const restored=new MtfStore(sqliteDatabase(backup),key);assert.deepEqual(await restored.read('synthetic-owner','account','a'),{label:'PRIVATE-SYNTHETIC-LABEL'});await restored.close();
  }finally{await store.close();await rm(directory,{recursive:true,force:true});}
});

test('Kite read-only client validates token exchange, checks expiry and cannot call order endpoints',async()=>{
  const calls:{url:string;options:RequestInit|undefined}[]=[];
  const client=new KiteReadOnlyClient({apiKey:'synthetic-key',apiSecret:'synthetic-secret',redirectUrl:'https://app.example/api/mtf/broker/callback'},async(url,options)=>{calls.push({url:String(url),options});return Response.json({status:'success',data:String(url).endsWith('/portfolio/positions')?{net:[{exchange:'NSE',product:'MTF',tradingsymbol:'SYNTHNET',quantity:5,average_price:200},{exchange:'NSE',product:'MIS',tradingsymbol:'NOTMTF',quantity:5,average_price:100}]}:String(url).endsWith('/session/token')?{access_token:'synthetic-token',user_id:'synthetic-broker-user'}:[{exchange:'NSE',tradingsymbol:'SYNTHETIC',isin:'SYNTHETIC001',mtf:{quantity:10,average_price:100}}]});});
  const credentials=await client.exchange('synthetic-request-token');assert.ok(Date.parse(credentials.expiresAt)>Date.now());const holdings=await client.holdings(credentials);assert.equal(holdings[0].fundedOutstandingInr,null);assert.equal(holdings[0].needsReview,true);assert.equal(holdings.length,2);assert.equal(holdings[1].origin,'NET_POSITION');assert.equal(holdings[1].isin,'');
  await assert.rejects(client.request('/orders/regular',credentials.accessToken));await assert.rejects(client.holdings({...credentials,expiresAt:'2020-01-01T00:00:00Z'}));
  assert.ok(calls.every(call=>!call.url.includes('/orders')));assert.ok(!client.loginUrl('synthetic-state').includes('synthetic-secret'));
});

test('PostgreSQL production adapter exercises scoped encrypted persistence and idempotency', {skip:!process.env.MTF_TEST_DATABASE_URL}, async()=>withMtf(async({request,register})=>{
  const user=await register();const payload=input(user.account);const key=randomUUID();const first=await request('positions',payload,user,'POST',key);assert.equal(first.status,201);
  const second=await request('positions',payload,user,'POST',key);assert.equal(second.status,201);assert.equal((await first.json()).documents[0].id,(await second.json()).documents[0].id);
  const summary=await(await request(`summary?accountId=${user.account}`,undefined,user)).json();assert.equal(summary.summary.openLots,1);
},true));

test('funded rate changes, account creation retries, logout and deletion enforce private scope',async()=>withMtf(async({request,register})=>{
  const user=await register();const key=randomUUID();const body={label:'Synthetic second account'};const first=await(await request('accounts',body,user,'POST',key)).json();const second=await(await request('accounts',body,user,'POST',key)).json();assert.equal(first.account.id,second.account.id);
  const doc=(await(await request('positions',{...input(user.account),fundedInr:'6000',dailyFraction:'0.0004'},user)).json()).documents[0];
  const result=await request(`positions/${doc.id}/events`,{accountId:user.account,version:1,reason:'Synthetic rate change',event:{kind:'RATE_CHANGE',at:'2026-01-17T00:00:01+05:30',dailyFraction:'0.0005'}},user);assert.equal(result.status,200);
  const detail=await(await request(`positions/${doc.id}?accountId=${user.account}`,undefined,user)).json();assert.equal(detail.snapshot.dailyInterest[0].dailyFraction,'0.0004');assert.equal(detail.snapshot.dailyInterest[15].dailyFraction,'0.0005');
  assert.equal((await request('profile',{},user,'DELETE')).status,200);assert.equal((await request('accounts',undefined,user)).status,401);
}));

test('Kite callback is owner-scoped and one-use; disconnect erases secrets and supports reconnection',async()=>{
  let exchanges=0;let revokes=0;
  const kite=new KiteReadOnlyClient({apiKey:'synthetic-key',apiSecret:'synthetic-secret',redirectUrl:'http://localhost/api/mtf/broker/callback'},async(url,options)=>{
    if(options?.method==='DELETE'){revokes++;return Response.json({status:'success',data:true});}
    if(options?.method==='POST'){exchanges++;return Response.json({status:'success',data:{access_token:'synthetic-private-token',user_id:'synthetic-broker'}});}
    if(String(url).endsWith('/portfolio/positions'))return Response.json({status:'success',data:{net:[]}});
    return Response.json({status:'success',data:[{exchange:'NSE',tradingsymbol:'SYNTHETIC',isin:'SYNTHETIC001',mtf:{quantity:10,average_price:100}}]});
  });
  await withMtf(async({request,register,base,store})=>{
    const alice=await register();const bob=await register();
    const connection=await(await request('broker/connect',{accountId:alice.account,consent:true},alice)).json();
    const redirectParams=new URLSearchParams(new URL(connection.url).searchParams.get('redirect_params')!);const state=redirectParams.get('state')!;
    const callback=`broker/callback?state=${encodeURIComponent(state)}&request_token=synthetic-request-token`;
    assert.equal((await request(callback,undefined,bob)).status,404);
    const connected=await fetch(`${base}/api/mtf/${callback}`,{headers:{cookie:alice.cookie},redirect:'manual'});assert.equal(connected.status,303);assert.equal(exchanges,1);
    assert.equal((await request(callback,undefined,alice)).status,403);assert.equal(exchanges,1);
    const status=await(await request(`broker/status?accountId=${alice.account}`,undefined,alice)).json();assert.equal(status.connected,true);assert.ok(!JSON.stringify(status).includes('synthetic-private-token'));
    const sync=await(await request('broker/sync',{accountId:alice.account},alice)).json();assert.equal(sync.holdings.length,1);assert.equal(sync.evidence,'BROKER_SNAPSHOT_NEEDS_REVIEW');
    assert.equal((await(await request(`positions?accountId=${alice.account}`,undefined,alice)).json()).count,0);
    assert.equal((await request('broker/disconnect',{accountId:alice.account},alice)).status,200);assert.equal(revokes,1);
    assert.equal((await store.history(alice.userId,'broker',`broker:${alice.account}`)).length,0);
    assert.equal((await request('broker/connect',{accountId:alice.account,consent:true},alice)).status,200);
  },false,kite);
});

test('historical valuation selects the recorded quote before as-of and export contains full audit/ledger',async()=>withMtf(async({request,register,store})=>{
  const user=await register();const document=(await(await request('positions',input(user.account,{manualPrice:null}),user)).json()).documents[0];
  const id=`quote:${user.account}:${digest('SYNTHETIC')}`;
  await store.transaction(async tx=>{await tx.write(user.userId,user.account,'quote',id,{symbol:'SYNTHETIC',priceInr:'110',marketAt:'2026-01-30T12:00:00+05:30',source:'Synthetic feed',mode:'DELAYED',version:1},0,'Synthetic observation');await tx.write(user.userId,user.account,'quote',id,{symbol:'SYNTHETIC',priceInr:'120',marketAt:'2026-01-31T12:00:00+05:30',source:'Synthetic feed',mode:'DELAYED',version:2},1,'Synthetic observation');});
  const query=`accountId=${user.account}&asOf=${encodeURIComponent('2026-01-30T12:01:00+05:30')}`;
  const historical=await(await request(`summary?${query}`,undefined,user)).json();assert.equal(historical.rows[0].snapshot.metrics.grossMarketValueInr,'11000.00');
  const report=await(await request(`export?${query}`,undefined,user)).json();assert.equal(report.revisions[0].id,document.id);assert.ok(report.ledgers[0].snapshot.dailyInterest.length>0);
}));

test('automatic workspace preserves database scope, existing sessions and CSRF without signup',async()=>withMtf(async({request,register,base})=>{
  const response=await request('workspace',{});assert.equal(response.status,200);
  const cookieHeader=response.headers.get('set-cookie')!;assert.match(cookieHeader,/HttpOnly/);assert.match(cookieHeader,/Max-Age=31536000/);
  const identity=(await response.json()).user;const guest:Login={cookie:cookieHeader.split(';')[0],csrf:identity.csrf,userId:identity.id,account:''};
  guest.account=(await(await request('accounts',undefined,guest)).json()).accounts[0].id;
  const created=await request('positions',input(guest.account),guest);assert.equal(created.status,201);
  const resumed=await request('workspace',{},guest);assert.match(resumed.headers.get('set-cookie')!,/Max-Age=31536000/);const reopened=await resumed.json();assert.equal(reopened.user.id,guest.userId);assert.equal(reopened.user.csrf,guest.csrf);
  assert.equal((await(await request(`positions?accountId=${guest.account}`,undefined,guest)).json()).count,1);
  const other=await request('workspace',{});const otherIdentity=(await other.json()).user;
  const otherGuest={cookie:other.headers.get('set-cookie')!.split(';')[0],csrf:otherIdentity.csrf,userId:otherIdentity.id,account:''};
  assert.notEqual(otherIdentity.id,guest.userId);assert.equal((await request(`summary?accountId=${guest.account}`,undefined,otherGuest)).status,404);
  assert.equal((await request('positions',input(guest.account),{...guest,csrf:'0'.repeat(64)})).status,403);
  const existing=await register();assert.equal((await(await request('workspace',{},existing)).json()).user.id,existing.userId);
  const crossOrigin=await fetch(`${base}/api/mtf/workspace`,{method:'POST',headers:{origin:'https://other.example','content-type':'application/json'},body:'{}'});assert.equal(crossOrigin.status,403);
}));


test('origin checks support unconfigured local proxies without relaxing host or production matching',async()=>withMtf(async({store})=>{
  const request=(origin:string,host:string)=>({headers:{origin,host}} as IncomingMessage);
  const local=new MtfAuth(store,false,'  ');
  assert.doesNotThrow(()=>local.checkOrigin(request('http://localhost:5173','localhost:5173')));
  assert.doesNotThrow(()=>local.checkOrigin(request('http://127.0.0.1:5197','127.0.0.1:5197')));
  assert.throws(()=>local.checkOrigin(request('http://localhost:5174','localhost:5173')));
  assert.throws(()=>local.checkOrigin(request('https://other.example','localhost:5173')));
  const production=new MtfAuth(store,true,'https://app.example');
  assert.doesNotThrow(()=>production.checkOrigin(request('https://app.example','internal-api:4000')));
  assert.throws(()=>production.checkOrigin(request('http://localhost:5173','localhost:5173')));
}));
