import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortfolioDocument, dailyBurn, derivePortfolioPosition, projectPosition, summarizeDashboard } from '../src/mtf/dashboard.ts';
const scope={tenantId:'synthetic-owner',accountId:'synthetic-account'};
const now='2026-01-31T12:00:00+05:30';
const input={position:{id:'synthetic',symbol:'SYNTHETIC',boughtDate:'2026-01-01',quantity:100,buyPriceInr:'100',interestPerDayInr:'2.40',otherChargesInr:'20',exitDate:null,manualPrice:{priceInr:'110',at:now}}};
test('dashboard supports explicit flat daily and actual-funded models with separate unknown principal',()=>{
  const flat=createPortfolioDocument(input,scope,'synthetic',now);const a=derivePortfolioPosition(flat,scope,now,null);
  assert.equal(a.metrics!.interestAccruedInr,'72.00');assert.equal(a.metrics!.fundedOutstandingInr,null);assert.equal(a.metrics!.costAdjustedUnrealizedPnlInr,'908.00');
  const funded=createPortfolioDocument({...input,fundedInr:'6000',dailyFraction:'0.0004'},scope,'synthetic',now);const b=derivePortfolioPosition(funded,scope,now,null);assert.equal(b.metrics!.interestAccruedInr,'72.00');assert.equal(b.metrics!.initialOwnFundsInr,'4000.00');
});
test('flat daily model preserves economic exposure through splits and partial sales',()=>{
  const document=createPortfolioDocument(input,scope,'synthetic',now);document.events.push({...scope,id:'synthetic-split',lotId:document.id,at:'2026-01-15T12:00:00+05:30',source:{kind:'MANUAL_UNVERIFIED',reference:'Synthetic split'},kind:'SPLIT',numerator:2,denominator:1});document.position.manualPrice!.priceInr='55';
  const result=derivePortfolioPosition(document,scope,now,null);assert.equal(result.metrics!.interestAccruedInr,'72.00');assert.equal(result.metrics!.quantityOpen,200);assert.equal(result.metrics!.costAdjustedUnrealizedPnlInr,'908.00');assert.equal(dailyBurn(document,result.metrics,'2026-01-31'),'2.40');
});
test('date-effective funded rates preserve earlier interest and update current burn',()=>{
  const document=createPortfolioDocument({...input,fundedInr:'6000',dailyFraction:'0.0004'},scope,'synthetic',now);document.rateChanges=[{id:'new-rate',effectiveFrom:'2026-01-17',dailyFraction:'0.0005',at:now,reference:'Synthetic updated rate'}];
  const result=derivePortfolioPosition(document,scope,now,null);assert.equal(result.metrics!.interestAccruedInr,'81.00');assert.equal(dailyBurn(document,result.metrics,'2026-01-31'),'3.00');assert.equal(result.dailyInterest[0].dailyFraction,'0.0004');
});
test('portfolio filtering cannot change open totals and projections are explicitly hypothetical',()=>{
  const open=createPortfolioDocument(input,scope,'synthetic-open',now);const closed=createPortfolioDocument({...input,position:{...input.position,exitDate:'2026-01-11'}},scope,'synthetic-closed',now);
  assert.equal(summarizeDashboard([open,closed],scope,now,[]).summary.openLots,1);assert.equal(derivePortfolioPosition(closed,scope,now,null).metrics!.realizedPnlInr,null);
  const scenarios=projectPosition(open,scope,now,null);assert.equal(scenarios[0].additionalInterestInr,'16.80');assert.ok(scenarios.every(s=>s.evidence==='PROJECTED'));
});
test('dashboard validates funding pairs, policy injection and future price observations',()=>{
  assert.throws(()=>createPortfolioDocument({...input,fundedInr:'6000'},scope,'synthetic',now));
  assert.throws(()=>createPortfolioDocument({...input,interestPolicy:{flatDailyInr:'999',startOffsetDays:1,includeExitDay:true,rounding:{timing:'DAILY',mode:'HALF_UP'}}},scope,'synthetic',now));
  const document=createPortfolioDocument(input,scope,'synthetic',now);document.position.manualPrice=null;
  const result=derivePortfolioPosition(document,scope,now,{symbol:'SYNTHETIC',priceInr:'999',marketAt:'2026-02-01T00:00:00Z',source:'Synthetic future',mode:'DELAYED'});assert.equal(result.metrics!.grossMarketValueInr,null);
});
test('hold projections never turn a stale observation into a fresh market valuation',()=>{
  const document=createPortfolioDocument(input,scope,'synthetic',now);document.position.manualPrice=null;
  const stale={symbol:'SYNTHETIC',priceInr:'110',marketAt:'2026-01-29T12:00:00+05:30',source:'Synthetic stale feed',mode:'DELAYED' as const};
  assert.equal(derivePortfolioPosition(document,scope,now,stale).quoteState,'STALE');
  assert.ok(projectPosition(document,scope,now,stale).every(s=>s.pnlInr===null));
});
