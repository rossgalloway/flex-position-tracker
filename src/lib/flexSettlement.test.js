import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EVENT_TOPICS, reconcileHistory } from './flexHistory.js';
import { summarizeAuction } from './flexFunding.js';
import { calculatePosition, modifiedDietzReturn, WAD, FLEX_PRICE_SCALE as PRICE, SECONDS_PER_YEAR as YEAR } from './flexPositionModel.js';
import { fetchFlexPositionSnapshot, buildPositionGroups, FLEX_MARKETS } from './flexPositionTracker.js';
const word = (n) => BigInt(n).toString(16).padStart(64,'0');
const abi = (...values) => '0x'+values.map(word).join('');
const recipient='0x'+word(1).slice(-40), taker='0x'+word(2).slice(-40);
const base = { borrowDecimals:6, collateralApr:null, openTimestamp:100, currentTimestamp:100+YEAR,
  openPrice:PRICE, currentPrice:PRICE, open:{collateral:2000n,borrowed:1000n,upfrontFee:10n,annualInterestRate:0n},
  current:{collateral:2000n,debt:1010n,recordedDebt:1010n,annualInterestRate:0n,lastDebtUpdateTime:100,statusCode:1} };
const openEvent={kind:'openTrove',timestamp:100,...base.open};
const endState=(collateral,debt,statusCode=1)=>({...base.current,collateral,debt,recordedDebt:debt,statusCode});

test('partial liquidation reduces debt and collateral, and continues accruing interest',()=>{
 const opening={...openEvent,annualInterestRate:100000n};
 const events=[opening,{kind:'liquidateTrove',timestamp:100+YEAR,collateral:500n,debt:400n,full:false}];
 const current={...endState(1500n,782n),recordedDebt:711n,annualInterestRate:100000n,lastDebtUpdateTime:100+YEAR};
 const replay=reconcileHistory(events,current,100+2*YEAR,6);
 assert.equal(replay.verified,true);
 const result=calculatePosition({...base,currentTimestamp:100+2*YEAR,current,
   liquidations:[{...replay.events[1],price:PRICE}]});
 assert.equal(result.accruedInterest,172n);
 assert.equal(result.liquidationImpact,-100n);
 assert.equal(result.pnl,-282n);
 assert.equal(result.endingValue,718n);
});

test('full liquidation returns excess collateral to owner and stops valuation at liquidation',()=>{
 const event={kind:'liquidateTrove',timestamp:200,collateral:1020n,debt:1010n,full:true};
 const replay=reconcileHistory([openEvent,event],endState(0n,0n,8),100+YEAR,6);
 assert.equal(replay.verified,true);
 assert.equal(replay.events[1].returnedCollateral,980n);
 const result=calculatePosition({...base,current:endState(0n,0n,8),liquidations:[{...replay.events[1],price:PRICE}],
   closeout:{collateral:980n,debt:0n,price:PRICE,timestamp:200}});
 assert.equal(result.pnl,-20n);
 assert.equal(result.endingValue,980n);
 assert.equal(result.elapsedSeconds,100);
});

test('underwater liquidation clears written-off debt exactly once, including fee absorption',()=>{
 const events=[{...openEvent,collateral:900n},
  {kind:'badDebt',timestamp:200,transactionHash:'tx',loss:610n,absorbedByFees:500n},
  {kind:'liquidateTrove',timestamp:200,transactionHash:'tx',collateral:900n,debt:400n,full:true}];
 const replay=reconcileHistory(events,endState(0n,0n,8),100+YEAR,6);
 assert.equal(replay.verified,true);
 const result=calculatePosition({...base,open:{...base.open,collateral:900n},openPrice:2n*PRICE,
  current:endState(0n,0n,8),currentPrice:PRICE/2n,
  liquidations:[{...replay.events[2],price:PRICE/2n}],closeout:{collateral:0n,debt:0n,price:PRICE/2n,timestamp:200}});
 assert.equal(result.initialCapitalBeforeFee,800n);
 assert.equal(result.badDebtWrittenOff,610n);
 assert.equal(result.badDebtAbsorbedByFees,500n);
 assert.equal(result.accruedInterest,0n);
 assert.equal(result.pnl,-800n);
 assert.equal(result.dietz.periodReturn,-WAD);
 assert.equal(result.dietz.annualized,-WAD);
});

test('same-block internal borrows, repayment and rate fee preserve integer interest epochs',()=>{
 const ts=100+YEAR;
 const events=[{...openEvent,annualInterestRate:100000n},
  {kind:'addCollateral',timestamp:ts,collateral:500n},
  {kind:'borrow',timestamp:ts,debtAfterBorrow:1416n,upfrontFee:5n},
  {kind:'borrow',timestamp:ts,debtAfterBorrow:1618n,upfrontFee:2n},
  {kind:'repay',timestamp:ts,debtRepaid:100n},
  {kind:'adjustInterestRate',timestamp:ts,annualInterestRate:50000n,upfrontFee:2n}];
 const current={...endState(2500n,1558n),recordedDebt:1520n,lastDebtUpdateTime:ts,annualInterestRate:50000n};
 const replay=reconcileHistory(events,current,ts+YEAR/2,6);
 assert.equal(replay.verified,true);
 assert.deepEqual(replay.events.filter(e=>e.kind==='borrow').map(e=>e.principal),[300n,200n]);
 assert.equal(reconcileHistory(events,{...current,debt:1559n},ts+YEAR/2,6).verified,false);
 assert.equal(reconcileHistory(events.slice(1),current,ts+YEAR/2,6).verified,false);
});

test('Modified Dietz weights timed contributions and withdrawals and rejects invalid capital',()=>{
 const added=modifiedDietzReturn(1000n,150n,100,100+YEAR,[{timestamp:100+YEAR/2,amount:1000n}]);
 assert.equal(added.weightedCapital,1500n);
 assert.equal(added.periodReturn,WAD/10n);
 const removed=modifiedDietzReturn(1000n,75n,100,100+YEAR,[{timestamp:100+YEAR/2,amount:-500n}]);
 assert.equal(removed.periodReturn,WAD/10n);
 assert.equal(modifiedDietzReturn(1000n,0n,100,200,[{timestamp:100,amount:-1000n}]),null);
 assert.equal(modifiedDietzReturn(1000n,0n,100,200,[{timestamp:201,amount:1n}]),null);
});

test('auction self-takes are non-cash; proceeds cap at maximum; pending and exhausted shortfalls differ',()=>{
 const log=(index,needed,self=false)=>({blockNumber:'0x1',logIndex:'0x'+index.toString(16),data:abi(10,10,needed,self?recipient:taker,taker)});
 const state=(remaining,credited)=>abi(0,100,remaining,100,credited,0,0,recipient,taker);
 const pending=summarizeAuction(state(10,70),[log(1,40),log(2,30,true)]);
 assert.equal(pending.cashPaid,40n);assert.equal(pending.inKindCredit,30n);assert.equal(pending.pending,30n);assert.equal(pending.complete,false);
 const short=summarizeAuction(state(0,70),[log(1,40),log(2,30,true)]);
 assert.equal(short.shortfall,30n);assert.equal(short.complete,true);
 const capped=summarizeAuction(state(0,100),[log(1,140)]);
 assert.equal(capped.cashPaid,100n);
 assert.throws(()=>summarizeAuction(state(0,100),[log(1,30)]));
 assert.throws(()=>summarizeAuction(state(0,70),[log(1,35),log(1,35)]));
});

for (const [name,wallet,market] of [['liquidation','0x5555e978e0732c198bc801477dfbccce66252ff5','ysybold'],['funding','0x80c9ac867b2d36b7e8d74646e074c460a008c0cb','yvusd']]) {
 test(`pinned ${name} RPC replay includes liquidation, routed borrowing, and reconciled settlement`,async()=>{
  const fixtures=JSON.parse(readFileSync(new URL(`./fixtures/${name}-settlement-rpc.json`,import.meta.url),'utf8'));
  const nativeFetch=globalThis.fetch;let failTrace=false;
  globalThis.fetch=async(url,opts)=>{
   if(String(url).startsWith('https://kong.yearn.fi'))return new Response(JSON.stringify({performance:{}}));
   const q=JSON.parse(opts.body);
   if(failTrace && q.method==='debug_traceTransaction')return new Response(JSON.stringify({error:{message:'Trace unavailable'}}));
   const found=fixtures.find(f=>f.method===q.method&&JSON.stringify(f.params).toLowerCase()===JSON.stringify(q.params).toLowerCase());
   assert.ok(found,JSON.stringify(q));
   return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result:found.result}));
  };
  try{
   const groups=buildPositionGroups([wallet],FLEX_MARKETS.filter(m=>m.key===market));
   const snapshot=await fetchFlexPositionSnapshot({groups});
   if(name==='liquidation'){
    const p=snapshot.positions.find(p=>p.troveId.startsWith('337531'));
    assert.equal(p.status,'active');assert.equal(p.historyReconciled,true);
    assert.equal(p.calculation.liquidationImpact,-17_588170n);
    assert.equal(p.calculation.pnl,-35_978471n);
    assert.equal(p.liquidations[0].collateral,2476389380367124464489n);
    assert.equal(p.liquidations[0].debt,2682350306n);
    assert.equal(p.funding.complete,true);
    assert.ok(snapshot.positions.some(p=>p.borrowings[0]?.source==='Reconciled event history'));
    assert.ok(snapshot.positions.some(p=>p.funding.inKindCredit>0n));
   }else{
    const p=snapshot.positions[0];
    assert.equal(p.funding.shortfall,106_377299n);
    assert.equal(p.funding.deliveries[1].delivered,15_893_622701n);
    assert.equal(p.settlementAdjustedPnl,273_273634n);
    assert.ok(p.calculation.dietz.annualized>0n);
    failTrace=true;
    const incomplete=(await fetchFlexPositionSnapshot({groups})).positions[0];
    assert.equal(incomplete.settlementAdjustedPnl,null);
    assert.equal(incomplete.calculation.pnl,p.calculation.pnl);
   }
  }finally{globalThis.fetch=nativeFetch;}
 });
}
