import assert from "node:assert/strict";
import test from "node:test";

import {
  WAD,
  annualizeWadReturn,
  aggregatePositions,
  calculatePosition,
  decimalToWad,
  decodeAdjustInterestRateLog,
  decodeBorrowLog,
  decodeCollateralChangeLog,
  decodeCloseTroveLog,
  decodeOpenTroveLog,
  decodeRepayLog,
  decodeRedeemTroveLog,
  decodeTroveResult,
  encodeAddressCall,
  formatPercent,
  formatUnits,
  priceDisplayToRaw,
  priceRawToDisplayWad,
  summarizeKongAprHistory,
  toTopic,
  weeklyApyToApr,
} from "./flexPositionModel.js";

const ysyBoldFixture = {
  borrowDecimals: 6,
  collateralApr: 50341180506482290n,
  openTimestamp: 1787931215,
  currentTimestamp: 1788017615,
  openPrice: 1090674476272233720000000n,
  currentPrice: 1090789208973471475000000n,
  open: {
    collateral: 79734862154681917534630n,
    borrowed: 76991602025n,
    upfrontFee: 2485457n,
  },
  current: {
    collateral: 79734862154681917534630n,
    debt: 76994938284n,
    annualInterestRate: 20000n,
    lastDebtUpdateTime: 1787931215,
  },
};

const ysyBoldRedemptions = [
  {
    collateral: 35_680_365_551_445_261_221_941n,
    debt: 38_999_061_048n,
    price: 1_093_011_813_227_353_900_000_000n,
  },
  {
    collateral: 34_775_361_984_940_480_714_666n,
    debt: 38_014_777_175n,
    price: 1_093_152_594_398_941_198_000_000n,
  },
];

test("calculates the verified ysyBOLD Flex position", () => {
  const result = calculatePosition(ysyBoldFixture);

  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(formatUnits(result.currentEquity, 6), "9,978.99");
  assert.equal(formatUnits(result.postOpenPnl, 6), "8.30");
  assert.equal(formatUnits(result.pnl, 6), "5.81");
  assert.equal(formatUnits(result.upfrontFee, 6), "2.49");
  assert.equal(
    result.pnl,
    result.collateralValueChange - result.accruedInterest - result.upfrontFee,
  );
  assert.equal(result.currentEquity, result.initialCapitalBeforeFee + result.pnl);
  const reconstructedRecurringReturn = result.returnOnInitialCapital + result.upfrontFeeRate;
  assert.ok(
    result.recurringReturnOnInitialCapital - reconstructedRecurringReturn <= 1n
      && result.recurringReturnOnInitialCapital - reconstructedRecurringReturn >= -1n,
  );
  assert.equal(
    result.feeAdjustedAnnualizedReturn,
    result.annualizedRecurringReturn - result.upfrontFeeRate,
  );
  assert.equal(formatPercent(result.returnOnOpeningEquity), "0.08%");
  assert.equal(formatUnits(result.annualNetCarry, 6), "2,838.47");
  assert.equal(formatPercent(result.equityApr), "28.44%");
});

test("annualizes the elapsed return and deducts an opening fee only once", () => {
  const dailyReturn = 100_000_000_000_000n;
  const annualized = annualizeWadReturn(dailyReturn, 86_400);

  assert.equal(formatPercent(annualized), "3.72%");
  assert.equal(annualizeWadReturn(dailyReturn, 0), null);
  assert.equal(annualizeWadReturn(-WAD, 86_400), null);
});

test("keeps lifetime returns after a rate change and separates its fee", () => {
  const rateAdjustmentFees = 4_052_853n;
  const accruedInterest = 8_259_816n;
  const openingDebt = ysyBoldFixture.open.borrowed + ysyBoldFixture.open.upfrontFee;
  const result = calculatePosition({
    ...ysyBoldFixture,
    current: {
      ...ysyBoldFixture.current,
      debt: openingDebt + rateAdjustmentFees + accruedInterest,
      annualInterestRate: 22_000n,
      lastDebtUpdateTime: ysyBoldFixture.openTimestamp + 168_708,
      lastInterestRateAdjustmentTime: ysyBoldFixture.openTimestamp + 168_708,
    },
    rateAdjustmentFees,
  });

  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(result.rateAdjustmentFees, rateAdjustmentFees);
  assert.equal(result.accruedInterest, accruedInterest);
  assert.equal(result.totalOneTimeFees, ysyBoldFixture.open.upfrontFee + rateAdjustmentFees);
  assert.equal(
    result.pnl,
    result.collateralValueChange - result.accruedInterest - result.totalOneTimeFees,
  );
  assert.equal(
    result.feeAdjustedAnnualizedReturn,
    result.annualizedRecurringReturn - result.oneTimeFeeRate,
  );
});

test("reconciles a partial redemption at its event-block PPS", () => {
  const [redemption] = ysyBoldRedemptions;
  const rateAdjustmentFees = 4_052_853n;
  const current = {
    ...ysyBoldFixture.current,
    collateral: 44_054_496_603_236_656_312_689n,
    debt: 38_011_968_243n,
    annualInterestRate: 22_000n,
    lastDebtUpdateTime: 1_788_186_371,
    lastInterestRateAdjustmentTime: 1_788_186_371,
  };
  const result = calculatePosition({
    ...ysyBoldFixture,
    currentTimestamp: 1_788_186_635,
    currentPrice: 1_093_046_691_901_471_505_000_000n,
    current,
    rateAdjustmentFees,
    redemptions: [redemption],
  });

  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(result.redeemedCollateral, redemption.collateral);
  assert.equal(result.redeemedDebt, redemption.debt);
  assert.equal(result.redeemedCollateralValue, 38_999_061_047n);
  assert.equal(result.redemptionImpact, 1n);
  assert.equal(
    result.accruedInterest,
    current.debt
      + redemption.debt
      - ysyBoldFixture.open.borrowed
      - ysyBoldFixture.open.upfrontFee
      - rateAdjustmentFees,
  );
  assert.equal(
    result.pnl,
    result.collateralValueChange
      + result.redemptionImpact
      - result.accruedInterest
      - result.totalOneTimeFees,
  );
  assert.equal(result.currentEquity, result.initialCapitalBeforeFee + result.pnl);
});

test("keeps a fully redeemed zombie trove as claimable equity", () => {
  const rateAdjustmentFees = 4_052_853n + 2_721_346n;
  const current = {
    ...ysyBoldFixture.current,
    collateral: 9_279_134_618_296_175_598_023n,
    debt: 0n,
    annualInterestRate: 1_000n,
    lastDebtUpdateTime: 1_788_239_891,
    lastInterestRateAdjustmentTime: 1_788_187_559,
  };
  const result = calculatePosition({
    ...ysyBoldFixture,
    currentTimestamp: 1_788_267_263,
    currentPrice: 1_093_486_093_487_916_829_000_000n,
    current,
    rateAdjustmentFees,
    redemptions: ysyBoldRedemptions,
  });

  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(result.currentDebt, 0n);
  assert.equal(result.endingValue, result.currentEquity);
  assert.equal(
    result.redeemedCollateral + current.collateral,
    ysyBoldFixture.open.collateral,
  );
  assert.equal(
    result.accruedInterest,
    result.redeemedDebt
      - ysyBoldFixture.open.borrowed
      - ysyBoldFixture.open.upfrontFee
      - rateAdjustmentFees,
  );
  assert.equal(result.endingValue, result.initialCapitalBeforeFee + result.pnl);
});

test("freezes a closed zombie trove at its final settlement", () => {
  const closeout = {
    collateral: 9_279_134_618_296_175_598_023n,
    debt: 0n,
    price: 1_093_486_093_487_916_829_000_000n,
    timestamp: 1_788_267_263,
  };
  const result = calculatePosition({
    ...ysyBoldFixture,
    currentTimestamp: closeout.timestamp + 86_400,
    currentPrice: closeout.price + 10n,
    current: {
      ...ysyBoldFixture.current,
      collateral: 0n,
      debt: 0n,
      annualInterestRate: 0n,
    },
    rateAdjustmentFees: 4_052_853n + 2_721_346n,
    redemptions: ysyBoldRedemptions,
    closeout,
  });

  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(result.currentEquity, 0n);
  assert.equal(result.closeoutCollateral, closeout.collateral);
  assert.equal(result.closeoutDebt, 0n);
  assert.equal(result.closeoutNetValue, result.closeoutCollateralValue);
  assert.equal(result.endingValue, result.initialCapitalBeforeFee + result.pnl);
  assert.equal(result.elapsedSeconds, closeout.timestamp - ysyBoldFixture.openTimestamp);
  assert.equal(
    result.ppsChange,
    ((closeout.price - ysyBoldFixture.openPrice) * WAD) / ysyBoldFixture.openPrice,
  );
});

test("subtracts debt repaid by a direct CloseTrove settlement", () => {
  const closeout = {
    collateral: ysyBoldFixture.open.collateral,
    debt: ysyBoldFixture.open.borrowed + ysyBoldFixture.open.upfrontFee + 8_000_000n,
    price: ysyBoldFixture.currentPrice,
    timestamp: ysyBoldFixture.currentTimestamp,
  };
  const result = calculatePosition({
    ...ysyBoldFixture,
    current: {
      ...ysyBoldFixture.current,
      collateral: 0n,
      debt: 0n,
      annualInterestRate: 0n,
    },
    closeout,
  });

  assert.equal(result.cleanOpenBaseline, true);
  assert.equal(result.accruedInterest, 8_000_000n);
  assert.equal(result.endingValue, result.closeoutCollateralValue - closeout.debt);
  assert.equal(result.endingValue, result.initialCapitalBeforeFee + result.pnl);
});

test("summarizes Kong net APR history without treating spot APR as history", () => {
  const points = [
    { time: 1, component: "netApr", value: "0.04" },
    { time: 1, component: "netApy", value: "0.0408" },
    { time: 2, component: "netApr", value: "0.06" },
    { time: 3, component: "netApy", value: "0.052558599" },
  ];
  const summary = summarizeKongAprHistory(points);

  assert.equal(summary.series.length, 3);
  assert.equal(summary.series[0].source, "netApr");
  assert.equal(summary.series[2].source, "netApy-derived");
  assert.equal(summary.trailing7, summary.trailing30);
  assert.equal(decimalToWad("0.050341180506482290"), 50341180506482290n);
  assert.ok(weeklyApyToApr(decimalToWad("0.052558599")) > decimalToWad("0.05"));
});

test("withholds lifetime PnL after a principal-changing event", () => {
  const result = calculatePosition({
    ...ysyBoldFixture,
    hasPositionChanges: true,
    current: {
      ...ysyBoldFixture.current,
      lastDebtUpdateTime: ysyBoldFixture.openTimestamp + 100,
    },
  });

  assert.equal(result.cleanOpenBaseline, false);
  assert.notEqual(result.ppsChange, null);
  assert.equal(result.collateralValueChange, null);
  assert.equal(result.accruedInterest, null);
  assert.equal(result.postOpenPnl, null);
  assert.equal(result.pnl, null);
  assert.equal(result.returnOnOpeningEquity, null);
  assert.notEqual(result.annualNetCarry, null);
});

test("aggregates positions only when their accounting unit matches", () => {
  const calculation = calculatePosition(ysyBoldFixture);
  const aggregate = aggregatePositions([
    { borrowSymbol: "USDC", borrowDecimals: 6, calculation },
    { borrowSymbol: "USDC", borrowDecimals: 6, calculation },
  ]);

  assert.ok(aggregate);
  assert.equal(aggregate.currentEquity, calculation.currentEquity * 2n);
  assert.equal(aggregate.endingValue, calculation.endingValue * 2n);
  assert.equal(aggregate.pnl, calculation.pnl * 2n);
  assert.equal(aggregate.upfrontFee, calculation.upfrontFee * 2n);
  assert.equal(aggregate.rateAdjustmentFees, 0n);
  assert.equal(aggregate.totalOneTimeFees, calculation.upfrontFee * 2n);
  assert.equal(aggregate.accruedInterest, calculation.accruedInterest * 2n);
  assert.equal(aggregate.equityApr, calculation.equityApr);
  assert.equal(
    aggregatePositions([
      { borrowSymbol: "USDC", borrowDecimals: 6, calculation },
      { borrowSymbol: "DAI", borrowDecimals: 18, calculation },
    ]),
    null,
  );

  const partial = aggregatePositions([{
    borrowSymbol: "USDC",
    borrowDecimals: 6,
    calculation: calculatePosition({
      ...ysyBoldFixture,
      current: {
        ...ysyBoldFixture.current,
        collateral: ysyBoldFixture.current.collateral + 1n,
      },
    }),
  }]);
  assert.equal(partial.pnl, null);
  assert.equal(partial.accruedInterest, null);
});

test("decodes the Flex Trove event and state ABI shapes", () => {
  const word = (value) => BigInt(value).toString(16).padStart(64, "0");
  const owner = "4449dd09067dcaa55c15f40b465a5173778f8100";
  const trove = decodeTroveResult(
    `0x${word(7)}${word(8)}${word(20_000)}${word(11)}${word(12)}${word(13)}${owner.padStart(64, "0")}${word(1)}`,
  );
  const opened = decodeOpenTroveLog(`0x${word(8)}${word(6)}${word(1)}${word(20_000)}`);
  const collateralChange = decodeCollateralChangeLog(`0x${word(5)}`);
  const borrowed = decodeBorrowLog(`0x${word(12)}${word(2)}`);
  const repaid = decodeRepayLog(`0x${word(3)}`);
  const adjusted = decodeAdjustInterestRateLog(`0x${word(22_000)}${word(4_052_853)}`);
  const redeemed = decodeRedeemTroveLog(`0x${word(35_680)}${word(38_999)}`);
  const closed = decodeCloseTroveLog(`0x${word(9_279)}${word(0)}`);

  assert.equal(trove.collateral, 8n);
  assert.equal(trove.owner.toLowerCase(), `0x${owner}`);
  assert.equal(trove.statusCode, 1);
  assert.deepEqual(opened, {
    collateral: 8n,
    borrowed: 6n,
    upfrontFee: 1n,
    annualInterestRate: 20_000n,
  });
  assert.deepEqual(collateralChange, { collateral: 5n });
  assert.deepEqual(borrowed, { debtAfterBorrow: 12n, upfrontFee: 2n });
  assert.deepEqual(repaid, { debtRepaid: 3n });
  assert.deepEqual(adjusted, {
    annualInterestRate: 22_000n,
    upfrontFee: 4_052_853n,
  });
  assert.deepEqual(redeemed, {
    collateral: 35_680n,
    debt: 38_999n,
  });
  assert.deepEqual(closed, {
    collateral: 9_279n,
    debt: 0n,
  });
});

test("encodes topics, address calls, fallback prices, and displays", () => {
  assert.equal(toTopic(15n), `0x${"f".padStart(64, "0")}`);
  assert.equal(
    encodeAddressCall("0x59d8703d", "0x23346B04a7f55b8760E5860AA5A77383D63491cD"),
    `0x59d8703d${"23346b04a7f55b8760e5860aa5a77383d63491cd".padStart(64, "0")}`,
  );
  assert.equal(
    priceDisplayToRaw(1090788754285188605n, 18, 6),
    1090788754285188605000000n,
  );
  assert.equal(
    priceRawToDisplayWad(1090788754285188605000000n, 18, 6),
    1090788754285188605n,
  );
  assert.equal(formatPercent(WAD / 20n), "5.00%");
  assert.equal(formatUnits(-1234567n, 6), "-1.23");
});


test("missing projection rates do not change historical accounting or fabricate a zero yield", () => {
  const valid = calculatePosition(ysyBoldFixture);
  const missing = calculatePosition({ ...ysyBoldFixture, collateralApr: null });
  for (const key of ["pnl", "currentEquity", "endingValue", "accruedInterest", "initialCapitalBeforeFee", "feeAdjustedAnnualizedReturn"]) {
    assert.equal(missing[key], valid[key]);
  }
  for (const key of ["grossAnnualIncome", "annualNetCarry", "equityApr", "rateSpread"]) {
    assert.equal(missing[key], null);
  }
  const aggregate = aggregatePositions([valid, missing].map((calculation) => ({
    borrowSymbol: "USDC", borrowDecimals: 6, calculation,
  })));
  assert.equal(aggregate.annualNetCarry, null);
  assert.equal(aggregate.equityApr, null);
  assert.equal(aggregate.pnl, valid.pnl * 2n);
});
