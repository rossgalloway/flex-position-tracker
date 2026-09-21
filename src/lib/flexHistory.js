import {
  decodeOpenTroveLog, decodeBorrowLog, decodeRepayLog, decodeCollateralChangeLog,
  decodeAdjustInterestRateLog, decodeRedeemTroveLog, decodeCloseTroveLog,
  splitWords, decodeAddressWord, SECONDS_PER_YEAR, pow10,
} from "./flexPositionModel.js";
export const EVENT_TOPICS = {
  openTrove: "0x48cc6255485654cd31337a688b4a1e06f8a768af7ec431040b7015bbb57d44b7",
  addCollateral: "0xda18d0b037712b628d658e8fb6f6701086c449aab7cefd33b9f7f95e3a3082b8",
  removeCollateral: "0xb7464e08add10846d62a84243a08bcd31fb4d0c9bb84591709b39de1fad9ae0e",
  borrow: "0xbf608caf5cc20aaeea74ecfce286b511362b0ecbaa0e56ded00f76f7e2e39c44",
  repay: "0xc030da26557a891f33dbaee473c007cdfa269acb9628d7d12e744ec6923ed2b3",
  adjustInterestRate: "0xb5e5fe642ee69e311cafb018acb5d9c4f197ba54a1548f743148a6e717e5bf2a",
  closeTrove: "0x964b676865fdc5f2f6264c1031ea231c957ef38127566ceb9f336ce1458c96a9",
  closeZombieTrove: "0xf696fb34f24a534b48e55d5a6b6a0f2145f131a74e1f09038f758f9e878a30e8",
  badDebt: "0xb41b3c71c8fe47a308d3d6b0d094b240d57503c840484cb61bbc86458a4910b9",
  liquidateTrove: "0xd6e62841f18c721ed3147d9ee5b55f92da1e651ce6f2565d1f7e9915718a20ad",
  redeemTrove: "0x06ba74d0ebb47a34a11d1eafef80d99a580c6e3644549cab6a04fdb357caf4cf",
};
export function decodeHistory(logs, timestamps) {
  const decoders = {
    openTrove: decodeOpenTroveLog, borrow: decodeBorrowLog, repay: decodeRepayLog,
    addCollateral: decodeCollateralChangeLog, removeCollateral: decodeCollateralChangeLog,
    adjustInterestRate: decodeAdjustInterestRateLog, redeemTrove: decodeRedeemTroveLog,
    closeTrove: decodeCloseTroveLog, closeZombieTrove: decodeCloseTroveLog,
  };
  const seen = new Set();
  return [...logs].sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber))
    || Number(BigInt(a.logIndex) - BigInt(b.logIndex))).map((log) => {
    const kind = Object.keys(EVENT_TOPICS).find((key) => EVENT_TOPICS[key] === log.topics[0].toLowerCase());
    const id = `${log.blockNumber}:${log.logIndex}`;
    if (!kind || seen.has(id) || log.removed) throw new Error("Unknown, duplicate or removed history event");
    seen.add(id);
    const block = Number(BigInt(log.blockNumber));
    const event = { kind, block, logIndex: Number(BigInt(log.logIndex)), transactionHash: log.transactionHash,
      timestamp: timestamps.get(block), ...(decoders[kind]?.(log.data) ?? {}) };
    if (kind === "liquidateTrove") {
      const words = splitWords(log.data);
      if (words.length !== 3 || ![0n, 1n].includes(BigInt(`0x${words[2]}`))) throw new Error("Invalid liquidation event");
      Object.assign(event, { collateral: BigInt(`0x${words[0]}`), debt: BigInt(`0x${words[1]}`),
        full: BigInt(`0x${words[2]}`) === 1n, liquidator: decodeAddressWord(log.topics[3]) });
    }
    if (kind === "badDebt") {
      const words = splitWords(log.data);
      if (words.length !== 2) throw new Error("Invalid bad-debt event");
      Object.assign(event, { loss: BigInt(`0x${words[0]}`), absorbedByFees: BigInt(`0x${words[1]}`) });
    }
    return event;
  });
}

// Replay the verified manager's integer interest formula at each debt update.
// This reconstructs internal/router borrows without depending on top-level calldata.
export function reconcileHistory(events, current, timestamp, borrowDecimals) {
  let debt = 0n, shares = 0n, rate = 0n, updated = 0;
  let opened = false, terminal = false, pendingBadDebt = null;
  const history = [];
  const interest = (at) => debt * rate * BigInt(at - updated) / BigInt(SECONDS_PER_YEAR) / pow10(borrowDecimals);
  try {
    for (const source of events) {
      const event = { ...source };
      const at = event.timestamp;
      if (!Number.isSafeInteger(at) || at < updated || terminal) throw new Error("Incomplete or out-of-order event history");
      if (event.kind === "openTrove") {
        if (opened) throw new Error("Duplicate opening event");
        opened = true; debt = event.borrowed + event.upfrontFee; shares = event.collateral;
        rate = event.annualInterestRate; updated = at;
      } else {
        if (!opened) throw new Error("Missing opening event");
        if (event.kind === "addCollateral") shares += event.collateral;
        else if (event.kind === "removeCollateral") shares -= event.collateral;
        else if (event.kind === "badDebt") {
          if (pendingBadDebt || event.absorbedByFees > event.loss) throw new Error("Unmatched bad-debt event");
          pendingBadDebt = event;
        } else {
          debt += interest(at);
          updated = at;
          if (event.kind === "borrow") {
            event.principal = event.debtAfterBorrow - debt - event.upfrontFee;
            if (event.principal <= 0n) throw new Error("Borrow principal does not reconcile");
            debt = event.debtAfterBorrow;
          } else if (event.kind === "repay") debt -= event.debtRepaid;
          else if (event.kind === "adjustInterestRate") { debt += event.upfrontFee; rate = event.annualInterestRate; }
          else if (event.kind === "redeemTrove") { debt -= event.debt; shares -= event.collateral; }
          else if (event.kind === "liquidateTrove") {
            event.badDebt = pendingBadDebt?.loss ?? 0n;
            event.absorbedByFees = pendingBadDebt?.absorbedByFees ?? 0n;
            if (pendingBadDebt && (!event.full || pendingBadDebt.transactionHash !== event.transactionHash)) throw new Error("Bad debt does not match full liquidation");
            debt -= event.debt + event.badDebt; shares -= event.collateral;
            pendingBadDebt = null;
            if (event.full) {
              if (debt !== 0n) throw new Error("Full liquidation debt does not reconcile");
              event.returnedCollateral = shares; shares = 0n; rate = 0n; terminal = true;
            }
          } else if (["closeTrove", "closeZombieTrove"].includes(event.kind)) {
            if (event.debt !== debt || event.collateral !== shares) throw new Error("Closeout does not reconcile");
            debt = 0n; shares = 0n; rate = 0n; terminal = true;
          } else throw new Error("Unsupported debt event");
        }
      }
      if (debt < 0n || shares < 0n) throw new Error("History produces a negative balance");
      history.push(event);
    }
    if (!opened || pendingBadDebt || timestamp < updated) throw new Error("Incomplete debt history");
    const canonicalDebt = terminal ? 0n : debt + interest(timestamp);
    if (shares !== current.collateral || debt !== current.recordedDebt
      || canonicalDebt !== current.debt || rate !== current.annualInterestRate
      || (terminal ? ![4, 8].includes(current.statusCode) : [4, 8].includes(current.statusCode))
      || (!terminal && updated !== current.lastDebtUpdateTime)) throw new Error("Replayed debt/collateral differs from canonical state");
    return { verified: true, events: history, issue: null };
  } catch (error) { return { verified: false, events: [], issue: error.message }; }
}
