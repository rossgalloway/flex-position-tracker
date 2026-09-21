import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { calculatePosition, aggregatePositions, decodeBorrowPrincipal, FLEX_PRICE_SCALE } from "./flexPositionModel.js";

const evidence = JSON.parse(readFileSync(new URL("../../docs/diagnostics/80c9-pnl-evidence.json", import.meta.url), "utf8"));
const position = JSON.parse(JSON.stringify(evidence.snapshot.positions[0]), (_, value) =>
  typeof value === "string" && /^\d+$/u.test(value) ? BigInt(value) : value);
const tx = { ...evidence.borrowTransaction, blockNumber: `0x${evidence.borrowTransaction.block.toString(16)}` };
const context = { manager: position.manager, troveId: position.troveId, block: evidence.borrowTransaction.block, transactionHash: tx.hash };
const base = {
  borrowDecimals: 6, collateralApr: null, openTimestamp: 100, currentTimestamp: 200,
  openPrice: FLEX_PRICE_SCALE, currentPrice: FLEX_PRICE_SCALE,
  open: { collateral: 2000n, borrowed: 1000n, upfrontFee: 10n },
  current: { collateral: 2000n, debt: 1020n, annualInterestRate: 0n },
};
const moneyIdentity = (result) => assert.equal(result.endingValue,
  result.initialCapitalBeforeFee + result.netCapitalAdded + result.pnl);

test("pinned 80c9 snapshot separates 16,000 principal and 2.174115 fee from 939.408832 interest", () => {
  const principal = decodeBorrowPrincipal(tx, context);
  assert.equal(principal, 16_000_000000n);
  const result = calculatePosition({ ...position, currentTimestamp: evidence.snapshot.timestamp,
    collateralApr: null, rateAdjustmentFees: 0n, hasPositionChanges: false,
    borrowings: [{ principal, upfrontFee: 2_174115n }],
  });
  assert.equal(result.accruedInterest, 939_408832n);
  assert.equal(result.totalOneTimeFees, 18_717248n);
  assert.equal(result.netCapitalAdded, -16_000_000000n);
  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(result.feeAdjustedAnnualizedReturn, null);
  moneyIdentity(result);
});

test("direct borrow overloads decode principal and reject wrong Trove, manager, block, hash or incomplete input", () => {
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  const args = tx.input.slice(10);
  assert.equal(decodeBorrowPrincipal({ ...tx, input: `0x36a3cf45${args}${word(5)}` }, context), 16_000_000000n);
  assert.equal(decodeBorrowPrincipal({ ...tx, input: `0x5f599c49${args}${word(5)}${word(224)}${word(3)}${'ab'.repeat(3).padEnd(64, '0')}` }, context), 16_000_000000n);
  for (const override of [ { to: "0xrouter" }, { hash: "0xwrong" }, { blockNumber: "0x1" },
    { input: "0xf8e61b69" }, { input: `0xf8e61b69${word(1)}${args.slice(64)}` },
    { input: `0x5f599c49${args}${word(5)}${word(224)}${word(100)}` }, { input: `0xdeadbeef${args}` } ]) {
    assert.throws(() => decodeBorrowPrincipal({ ...tx, ...override }, context));
  }
  assert.throws(() => decodeBorrowPrincipal(null, context));
});

test("repeated borrowing and fees do not turn principal into interest or loss", () => {
  const result = calculatePosition({ ...base,
    borrowings: [{ principal: 500n, upfrontFee: 3n }, { principal: 200n, upfrontFee: 2n }],
    current: { ...base.current, debt: 1725n },
  });
  assert.equal(result.accruedInterest, 10n);
  assert.equal(result.pnl, -25n);
  assert.equal(result.additionalBorrowed, 700n);
  assert.equal(result.feeAdjustedAnnualizedReturn, null);
  moneyIdentity(result);
});

test("actual repayment is a capital contribution, not income", () => {
  const result = calculatePosition({ ...base,
    repayments: [{ debtRepaid: 200n }], current: { ...base.current, debt: 820n },
  });
  assert.equal(result.accruedInterest, 10n);
  assert.equal(result.pnl, -20n);
  assert.equal(result.netCapitalAdded, 200n);
  moneyIdentity(result);
});

test("collateral flows at different PPS measure gain only while shares were held", () => {
  const result = calculatePosition({ ...base, currentPrice: 2n * FLEX_PRICE_SCALE,
    current: { ...base.current, collateral: 2200n },
    collateralChanges: [
      { kind: "deposit", collateral: 500n, price: FLEX_PRICE_SCALE },
      { kind: "withdrawal", collateral: 300n, price: 2n * FLEX_PRICE_SCALE },
    ],
  });
  assert.equal(result.netCollateralAddedValue, -100n);
  assert.equal(result.collateralValueChange, 2500n);
  assert.equal(result.pnl, 2480n);
  moneyIdentity(result);
});

test("borrow with collateral, repayment, redemption, rate fee and closeout reconcile without double counting", () => {
  const result = calculatePosition({ ...base,
    borrowings: [{ principal: 500n, upfrontFee: 3n }], repayments: [{ debtRepaid: 100n }],
    collateralChanges: [{ kind: "deposit", collateral: 600n, price: FLEX_PRICE_SCALE }],
    rateAdjustmentFees: 2n,
    redemptions: [{ collateral: 200n, debt: 200n, price: FLEX_PRICE_SCALE }],
    closeout: { collateral: 2400n, debt: 1225n, price: FLEX_PRICE_SCALE, timestamp: 180 },
    current: { ...base.current, collateral: 0n, debt: 0n },
  });
  assert.equal(result.accruedInterest, 10n);
  assert.equal(result.totalOneTimeFees, 15n);
  assert.equal(result.pnl, -25n);
  assert.equal(result.endingValue, 1175n);
  moneyIdentity(result);
  const aggregate = aggregatePositions([{ borrowSymbol: "USDC", borrowDecimals: 6, calculation: result }]);
  assert.equal(aggregate.additionalBorrowFees, 3n);
  assert.equal(aggregate.pnl, -25n);
  assert.equal(aggregate.returnOnInitialCapital, null);
});

test("missing principal, price, unknown event, collateral mismatch and impossible negative interest stay unavailable", () => {
  for (const change of [
    { borrowings: [{ principal: null, upfrontFee: 3n }] },
    { collateralChanges: [{ kind: "deposit", collateral: 1n, price: null }] },
    { hasPositionChanges: true },
    { current: { ...base.current, collateral: 3000n } },
    { current: { ...base.current, debt: 500n } },
  ]) {
    const result = calculatePosition({ ...base, ...change });
    assert.equal(result.pnl, null);
    assert.equal(result.accruedInterest, null);
    assert.notEqual(result.currentEquity, null);
  }
});

test("pinned RPC replay carries Borrow principal through the tracker; missing/routed calldata falls back to exact event replay", async () => {
  const { fetchFlexPositionSnapshot, buildPositionGroups, FLEX_MARKETS } = await import("./flexPositionTracker.js");
  const fixtures = JSON.parse(readFileSync(new URL("./fixtures/80c9-accounting-rpc.json", import.meta.url), "utf8"));
  const fetchBefore = globalThis.fetch;
  let transactionMode = "valid";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://kong.yearn.fi")) return new Response(JSON.stringify({ performance: {} }));
    const request = JSON.parse(init.body);
    const fixture = fixtures.find((item) => item.method === request.method
      && JSON.stringify(item.params).toLowerCase() === JSON.stringify(request.params).toLowerCase());
    assert.ok(fixture, `Missing fixture: ${JSON.stringify(request)}`);
    let result = fixture.result;
    if (request.method === "eth_getTransactionByHash") {
      if (transactionMode === "missing") result = null;
      if (transactionMode === "routed") result = { ...result, to: "0xrouter" };
      if (transactionMode === "failure") return new Response(JSON.stringify({ error: { message: "Historical transaction unavailable" } }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  };
  try {
    const groups = buildPositionGroups([position.wallet], FLEX_MARKETS.filter((market) => market.key === "yvusd"));
    const snapshot = await fetchFlexPositionSnapshot({ groups });
    assert.equal(snapshot.positions.length, 1);
    const actual = snapshot.positions[0];
    assert.equal(actual.borrowings[0].principal, 16_000_000000n);
    assert.equal(actual.calculation.accruedInterest, 939_408832n);
    assert.equal(actual.accountingIssue, null);
    moneyIdentity(actual.calculation);
    for (const mode of ["missing", "routed", "failure"]) {
      transactionMode = mode;
      const partial = (await fetchFlexPositionSnapshot({ groups })).positions[0];
      assert.equal(partial.calculation.pnl, actual.calculation.pnl);
      assert.equal(partial.historyReconciled, true);
      assert.equal(partial.accountingIssue, null);
      assert.equal(partial.borrowings[0].source, "Reconciled event history");
    }
  } finally {
    globalThis.fetch = fetchBefore;
  }
});
