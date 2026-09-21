import { splitWords, decodeAddressWord, encodeUintCall, toTopic } from "./flexPositionModel.js";
import { EVENT_TOPICS } from "./flexHistory.js";
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const KICK = '0x0617b7d1025dcb79895511800028509eff7b9531012457c418e9a0c0f8564637';
const TAKE = '0x191d59a248e27b796e2bfc44962dd12966bfd584b3d29eeb55f8b280a08c5d5f';
const OPEN = ['0xf70d8c11','0x18ee2f0a','0x58821e76'];
const BORROW = ['0xf8e61b69','0x36a3cf45','0x5f599c49'];
const lower = (value) => String(value).toLowerCase();
const uint = (data) => BigInt(`0x${splitWords(data)[0]}`);

export function summarizeAuction(stateData, logs) {
  const words = splitWords(stateData);
  if (words.length !== 9) throw new Error('Invalid auction state');
  const remaining = BigInt(`0x${words[2]}`), maximum = BigInt(`0x${words[3]}`), credited = BigInt(`0x${words[4]}`);
  const recipient = decodeAddressWord(words[7]);
  let total = 0n, cashPaid = 0n, inKindCredit = 0n;
  const seen = new Set();
  for (const log of [...logs].sort((a,b) => Number(BigInt(a.blockNumber)-BigInt(b.blockNumber)) || Number(BigInt(a.logIndex)-BigInt(b.logIndex)))) {
    const id = `${log.blockNumber}:${log.logIndex}`;
    if (seen.has(id) || log.removed) throw new Error('Duplicate or removed auction event');
    seen.add(id);
    const data = splitWords(log.data);
    if (data.length !== 5) throw new Error('Invalid AuctionTake');
    const needed = BigInt(`0x${data[2]}`);
    const received = needed < maximum - total ? needed : maximum - total;
    if (decodeAddressWord(data[3]) === recipient) inKindCredit += received;
    else cashPaid += received;
    total += received;
  }
  if (total !== credited || credited > maximum) throw new Error('Auction payments do not reconcile to state');
  const pending = remaining > 0n ? maximum - credited : 0n;
  return { recipient, maximum, credited, cashPaid, inKindCredit, remaining, pending,
    shortfall: remaining === 0n ? maximum - credited : 0n, complete: pending === 0n };
}

function successfulCalls(frame, result = []) {
  if (!frame || frame.error || frame.revertReason) return result;
  result.push(frame);
  for (const child of frame.calls ?? []) successfulCalls(child, result);
  return result;
}

// Extract calls made by this manager, including calls nested below a clone delegatecall.
export function fundingFromTrace(trace, receipt, event, config, metadata) {
  const calls = successfulCalls(trace);
  const isOpen = event.kind === 'openTrove';
  const topic = isOpen ? EVENT_TOPICS.openTrove : EVENT_TOPICS.borrow;
  const matchingLogs = receipt.logs.filter((log) => lower(log.address) === lower(config.manager)
    && lower(log.topics[0]) === topic && BigInt(log.topics[1]) === BigInt(config.troveId));
  const occurrence = matchingLogs.findIndex((log) => Number(BigInt(log.logIndex)) === event.logIndex);
  const matchingCalls = calls.filter((call) => call.type === 'CALL' && lower(call.to) === lower(config.manager)
    && (isOpen ? OPEN : BORROW).includes(call.input?.slice(0,10))
    && (isOpen ? call.output && uint(call.output) === BigInt(config.troveId)
      : uint(`0x${call.input.slice(10)}`) === BigInt(config.troveId)));
  if (occurrence < 0 || matchingCalls.length !== matchingLogs.length) throw new Error('Borrow calls cannot be matched to events');
  const frame = matchingCalls[occurrence], children = successfulCalls(frame);
  let immediate = 0n;
  const auctionIds = [];
  for (const call of children) {
    if (call.type !== 'CALL') continue;
    const input = call.input ?? '';
    if (lower(call.from) === lower(config.manager) && lower(call.to) === metadata.token && input.startsWith('0x23b872dd')) {
      const words = splitWords(`0x${input.slice(10)}`);
      if (decodeAddressWord(words[0]) === metadata.lender && decodeAddressWord(words[1]) === lower(frame.from)) immediate += BigInt(`0x${words[2]}`);
    }
    if (lower(call.from) === metadata.desk && lower(call.to) === metadata.auction && input.startsWith('0x3bd8c8dc')) {
      auctionIds.push(uint(`0x${input.slice(10)}`));
    }
  }
  return { immediate, recipient: lower(frame.from), auctionIds, source: 'Call trace' };
}

function fundingFromDirectReceipt(tx, receipt, event, config, metadata) {
  const isOpen = event.kind === 'openTrove', input = tx?.input ?? '';
  if (!tx || !/^0x[0-9a-f]{40}$/i.test(tx.from ?? '') || lower(tx.hash) !== lower(event.transactionHash)
    || Number(BigInt(tx.blockNumber ?? 0)) !== event.block) return null;
  if (lower(tx?.to) !== lower(config.manager) || !(isOpen ? OPEN : BORROW).includes(input.slice(0,10))) return null;
  const words = splitWords(`0x${input.slice(10)}`);
  if (isOpen ? BigInt(`0x${words[2]}`) !== event.principal : BigInt(`0x${words[0]}`) !== BigInt(config.troveId)) return null;
  // Non-empty callbacks can make extra token transfers; use a call trace for those.
  const dynamic = input.startsWith('0x58821e76') ? 11 : input.startsWith('0x5f599c49') ? 7 : null;
  if (dynamic && (words.length !== dynamic + 1 || BigInt(`0x${words[dynamic]}`) !== 0n)) return null;
  const operations = receipt.logs.filter((log) => lower(log.address) === lower(config.manager)
    && [EVENT_TOPICS.openTrove, EVENT_TOPICS.borrow].includes(lower(log.topics[0])));
  if (operations.length !== 1 || Number(BigInt(operations[0].logIndex)) !== event.logIndex) return null;
  let immediate = 0n;
  const auctionIds = [];
  for (const log of receipt.logs) {
    if (lower(log.address) === metadata.token && lower(log.topics[0]) === TRANSFER
      && decodeAddressWord(log.topics[1]) === metadata.lender && decodeAddressWord(log.topics[2]) === lower(tx.from)) immediate += uint(log.data);
    if (lower(log.address) === metadata.auction && lower(log.topics[0]) === KICK && BigInt(log.topics[2]) === 0n) auctionIds.push(BigInt(log.topics[1]));
  }
  return { immediate, recipient: lower(tx.from), auctionIds, source: 'Direct call receipt' };
}

export async function readFunding(events, config, snapshotBlock, rpc, ethCall, signal) {
  const funding = events.filter((event) => ['openTrove','borrow'].includes(event.kind))
    .map((event) => ({ ...event, principal: event.kind === 'openTrove' ? event.borrowed : event.principal }));
  try {
    const blockTag = `0x${snapshotBlock.toString(16)}`;
    const [lender, token, desk] = await Promise.all(['0xbcead63e','0x4e530b42','0x99bb3333'].map(async (selector) =>
      decodeAddressWord(splitWords(await ethCall(config.manager, selector, blockTag, signal))[0])));
    const auction = decodeAddressWord(splitWords(await ethCall(desk, '0x7d9f6db5', blockTag, signal))[0]);
    const metadata = { lender, token, desk, auction };
    const receipts = new Map(), transactions = new Map(), traces = new Map();
    const cachedRpc = (cache, method, hash, extra = []) => {
      if (!cache.has(hash)) cache.set(hash, rpc(method, [hash, ...extra], signal));
      return cache.get(hash);
    };
    const deliveries = await Promise.all(funding.map(async (event) => {
      try {
        if (typeof event.principal !== 'bigint') throw new Error('Principal unavailable');
        const [tx, receipt] = await Promise.all([
          cachedRpc(transactions, 'eth_getTransactionByHash', event.transactionHash),
          cachedRpc(receipts, 'eth_getTransactionReceipt', event.transactionHash),
        ]);
        if (!receipt || receipt.status !== '0x1' || lower(receipt.transactionHash) !== lower(event.transactionHash)
          || Number(BigInt(receipt.blockNumber)) !== event.block) throw new Error('Funding receipt unavailable or mismatched');
        let observed = fundingFromDirectReceipt(tx, receipt, event, config, metadata);
        if (!observed) observed = fundingFromTrace(await cachedRpc(traces, 'debug_traceTransaction', event.transactionHash,
          [{ tracer: 'callTracer', timeout: '10s' }]), receipt, event, config, metadata);
        if (new Set(observed.auctionIds.map(String)).size !== observed.auctionIds.length) throw new Error('Duplicate auction attribution');
        const auctions = await Promise.all(observed.auctionIds.map(async (id) => {
          const [state, logs] = await Promise.all([
            ethCall(auction, encodeUintCall('0x571a26a0', id), blockTag, signal),
            rpc('eth_getLogs', [{ address: auction, fromBlock: `0x${event.block.toString(16)}`, toBlock: blockTag, topics: [TAKE,toTopic(id)] }], signal),
          ]);
          const value = summarizeAuction(state, logs);
          if (value.recipient !== observed.recipient) throw new Error('Auction recipient mismatch');
          return { id: String(id), address: auction, ...value };
        }));
        const maximum = auctions.reduce((sum, value) => sum + value.maximum, 0n);
        if (observed.immediate + maximum > event.principal) throw new Error('Funding exceeds issued principal');
        return { ...event, ...observed, auctions, complete: auctions.every((value) => value.complete),
          delivered: observed.immediate + auctions.reduce((sum,value) => sum + value.credited,0n),
          cashPaid: observed.immediate + auctions.reduce((sum,value) => sum + value.cashPaid,0n),
          inKindCredit: auctions.reduce((sum,value) => sum + value.inKindCredit,0n),
          pending: auctions.reduce((sum,value) => sum + value.pending,0n),
          shortfall: event.principal - observed.immediate - maximum + auctions.reduce((sum,value) => sum + value.shortfall,0n), issue: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        return { ...event, complete: false, issue: error.message };
      }
    }));
    const known = deliveries.every((event) => !event.issue);
    const sum = (field) => known ? deliveries.reduce((total, event) => total + event[field], 0n) : null;
    const complete = known && deliveries.every((event) => event.complete);
    return { deliveries, known, complete, cashPaid: sum('cashPaid'), inKindCredit: sum('inKindCredit'), pending: sum('pending'), shortfall: sum('shortfall'),
      adjustment: complete ? deliveries.reduce((total,event) => total + event.delivered - event.principal,0n) : null };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { deliveries: [], known: false, complete: false, adjustment: null, issue: error.message };
  }
}
