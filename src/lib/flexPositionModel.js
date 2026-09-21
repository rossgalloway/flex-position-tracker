export const WAD = 10n ** 18n;
export const FLEX_PRICE_SCALE = 10n ** 36n;
export const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export function decimalToWad(value) {
  const source = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(source)) {
    throw new Error(`Invalid decimal value: ${source}`);
  }

  const negative = source.startsWith("-");
  const unsigned = negative ? source.slice(1) : source;
  const [whole, fraction = ""] = unsigned.split(".");
  const paddedFraction = `${fraction}000000000000000000`.slice(0, 18);
  const result = BigInt(whole) * WAD + BigInt(paddedFraction);
  return negative ? -result : result;
}

export function weeklyApyToApr(apy) {
  const apyNumber = Number(apy) / 1e18;
  if (!Number.isFinite(apyNumber) || apyNumber <= -1) return null;
  const apr = (Math.pow(1 + apyNumber, 1 / 52) - 1) * 52;
  return decimalToWad(apr.toFixed(18));
}

export function annualizeWadReturn(periodReturn, elapsedSeconds) {
  const elapsed = Number(elapsedSeconds);
  const returnNumber = Number(periodReturn) / 1e18;
  if (
    !Number.isFinite(elapsed)
    || elapsed <= 0
    || !Number.isFinite(returnNumber)
    || returnNumber <= -1
  ) {
    return null;
  }

  const annualized = Math.expm1(
    Math.log1p(returnNumber) * (SECONDS_PER_YEAR / elapsed),
  );
  const scaledAnnualized = annualized * 1e18;
  if (!Number.isFinite(scaledAnnualized)) return null;
  return BigInt(Math.round(scaledAnnualized));
}

export function summarizeKongAprHistory(points) {
  const days = new Map();

  for (const point of Array.isArray(points) ? points : []) {
    const time = Number(point?.time);
    const component = String(point?.component || "").toLowerCase();
    if (!Number.isFinite(time) || !["netapr", "netapy"].includes(component)) continue;

    try {
      const day = days.get(time) || { time };
      day[component] = decimalToWad(point.value);
      days.set(time, day);
    } catch {
      // Ignore malformed provider records while retaining valid observations.
    }
  }

  const series = [...days.values()]
    .sort((a, b) => a.time - b.time)
    .map((day) => ({
      time: day.time,
      apr: day.netapr ?? weeklyApyToApr(day.netapy),
      source: day.netapr !== undefined ? "netApr" : "netApy-derived",
    }))
    .filter((day) => day.apr !== null);

  const averageLast = (count) => {
    const selected = series.slice(-count);
    if (!selected.length) return null;
    return selected.reduce((sum, point) => sum + point.apr, 0n) / BigInt(selected.length);
  };

  return {
    series,
    latest: series.at(-1) ?? null,
    trailing7: averageLast(7),
    trailing30: averageLast(30),
    count7: Math.min(series.length, 7),
    count30: Math.min(series.length, 30),
  };
}

export function pow10(decimals) {
  return 10n ** BigInt(decimals);
}

export function splitWords(data) {
  const value = String(data || "").replace(/^0x/u, "");
  if (!value || value.length % 64 !== 0) {
    throw new Error("Invalid ABI word data");
  }

  return value.match(/.{64}/gu) || [];
}

export function decodeAddressWord(word) {
  return `0x${word.slice(-40)}`;
}

export function decodeTroveResult(data) {
  const words = splitWords(data);
  if (words.length < 8) throw new Error("Incomplete Trove result");

  return {
    recordedDebt: BigInt(`0x${words[0]}`),
    collateral: BigInt(`0x${words[1]}`),
    annualInterestRate: BigInt(`0x${words[2]}`),
    lastDebtUpdateTime: Number(BigInt(`0x${words[3]}`)),
    lastDebtIncreaseTime: Number(BigInt(`0x${words[4]}`)),
    lastInterestRateAdjustmentTime: Number(BigInt(`0x${words[5]}`)),
    owner: decodeAddressWord(words[6]),
    statusCode: Number(BigInt(`0x${words[7]}`)),
  };
}

export function decodeOpenTroveLog(data) {
  const words = splitWords(data);
  if (words.length < 4) throw new Error("Incomplete OpenTrove log");

  return {
    collateral: BigInt(`0x${words[0]}`),
    borrowed: BigInt(`0x${words[1]}`),
    upfrontFee: BigInt(`0x${words[2]}`),
    annualInterestRate: BigInt(`0x${words[3]}`),
  };
}

export function decodeCollateralChangeLog(data) {
  const words = splitWords(data);
  if (words.length < 1) throw new Error("Incomplete collateral change log");

  return {
    collateral: BigInt(`0x${words[0]}`),
  };
}

export function decodeBorrowLog(data) {
  const words = splitWords(data);
  if (words.length < 2) throw new Error("Incomplete Borrow log");

  return {
    debtAfterBorrow: BigInt(`0x${words[0]}`),
    upfrontFee: BigInt(`0x${words[1]}`),
  };
}

// Verified Flex borrow overloads. Borrow logs contain total debt, not new principal.
export function decodeBorrowPrincipal(transaction, { manager, troveId, block, transactionHash }) {
  if (!transaction
    || transaction.to?.toLowerCase() !== manager.toLowerCase()
    || transaction.hash?.toLowerCase() !== transactionHash.toLowerCase()
    || Number(BigInt(transaction.blockNumber ?? 0)) !== block) {
    throw new Error("Borrow transaction unavailable or routed through another contract");
  }
  const data = transaction.input?.toLowerCase() ?? "";
  const argumentCounts = { "0xf8e61b69": 5, "0x36a3cf45": 6, "0x5f599c49": 7 };
  const count = argumentCounts[data.slice(0, 10)];
  if (!count || !/^0x[0-9a-f]+$/u.test(data)) throw new Error("Unsupported Borrow calldata");
  const words = splitWords(data.slice(10));
  if ((count < 7 && words.length !== count)
    || (count === 7 && (words.length < 8 || BigInt(`0x${words[6]}`) !== 224n))
    || BigInt(`0x${words[0]}`) !== BigInt(troveId)) {
    throw new Error("Borrow calldata does not match this Trove");
  }
  if (count === 7 && 8n + (BigInt(`0x${words[7]}`) + 31n) / 32n !== BigInt(words.length)) {
    throw new Error("Incomplete Borrow callback data");
  }
  const principal = BigInt(`0x${words[1]}`);
  if (principal <= 0n) throw new Error("Invalid additional borrowed principal");
  return principal;
}

export function decodeRepayLog(data) {
  const words = splitWords(data);
  if (words.length < 1) throw new Error("Incomplete Repay log");

  return {
    debtRepaid: BigInt(`0x${words[0]}`),
  };
}

export function decodeAdjustInterestRateLog(data) {
  const words = splitWords(data);
  if (words.length < 2) throw new Error("Incomplete AdjustInterestRate log");

  return {
    annualInterestRate: BigInt(`0x${words[0]}`),
    upfrontFee: BigInt(`0x${words[1]}`),
  };
}

export function decodeRedeemTroveLog(data) {
  const words = splitWords(data);
  if (words.length < 2) throw new Error("Incomplete RedeemTrove log");

  return {
    collateral: BigInt(`0x${words[0]}`),
    debt: BigInt(`0x${words[1]}`),
  };
}

export function decodeCloseTroveLog(data) {
  const words = splitWords(data);
  if (words.length < 2) throw new Error("Incomplete CloseTrove log");

  return {
    collateral: BigInt(`0x${words[0]}`),
    debt: BigInt(`0x${words[1]}`),
  };
}

export function toTopic(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function encodeUintCall(selector, value) {
  return `${selector}${BigInt(value).toString(16).padStart(64, "0")}`;
}

export function encodeAddressCall(selector, address) {
  return `${selector}${String(address).toLowerCase().replace(/^0x/u, "").padStart(64, "0")}`;
}

export function priceDisplayToRaw(displayPrice, collateralDecimals, borrowDecimals) {
  const decimalDelta = Number(borrowDecimals) - Number(collateralDecimals);
  if (decimalDelta >= 0) {
    return BigInt(displayPrice) * WAD * pow10(decimalDelta);
  }
  return (BigInt(displayPrice) * WAD) / pow10(-decimalDelta);
}

export function priceRawToDisplayWad(rawPrice, collateralDecimals, borrowDecimals) {
  const decimalDelta = Number(borrowDecimals) - Number(collateralDecimals);
  if (decimalDelta >= 0) {
    return BigInt(rawPrice) / WAD / pow10(decimalDelta);
  }
  return (BigInt(rawPrice) * pow10(-decimalDelta)) / WAD;
}

export function calculatePosition(input) {
  const borrowPrecision = pow10(input.borrowDecimals);
  const collateralValueAtOpen = input.open
    ? (input.open.collateral * input.openPrice) / FLEX_PRICE_SCALE
    : null;
  const currentCollateralValue =
    (input.current.collateral * input.currentPrice) / FLEX_PRICE_SCALE;
  const openingDebt = input.open ? input.open.borrowed + input.open.upfrontFee : null;
  const initialCapitalBeforeFee = input.open && collateralValueAtOpen !== null
    ? collateralValueAtOpen - input.open.borrowed
    : null;
  const openingEquity =
    collateralValueAtOpen !== null && openingDebt !== null
      ? collateralValueAtOpen - openingDebt
      : null;
  const currentEquity = currentCollateralValue - input.current.debt;
  const grossAnnualIncome = input.collateralApr == null
    ? null
    : (currentCollateralValue * input.collateralApr) / WAD;
  const annualBorrowCost =
    (input.current.debt * input.current.annualInterestRate) / borrowPrecision;
  const annualNetCarry = grossAnnualIncome === null ? null : grossAnnualIncome - annualBorrowCost;
  const ltv = currentCollateralValue > 0n
    ? (input.current.debt * WAD) / currentCollateralValue
    : null;
  const leverage = currentEquity > 0n
    ? (currentCollateralValue * WAD) / currentEquity
    : null;
  const equityApr = currentEquity > 0n && annualNetCarry !== null
    ? (annualNetCarry * WAD) / currentEquity
    : null;
  const rateSpread = input.collateralApr == null
    ? null
    : input.collateralApr - (input.current.annualInterestRate * WAD) / borrowPrecision;

  const rateAdjustmentFees = input.rateAdjustmentFees ?? 0n;
  const borrowings = input.borrowings ?? [];
  const repayments = input.repayments ?? [];
  const collateralChanges = input.collateralChanges ?? [];
  const principalKnown = borrowings.every((event) => typeof event.principal === "bigint" && event.principal > 0n);
  const additionalBorrowed = principalKnown
    ? borrowings.reduce((sum, event) => sum + event.principal, 0n)
    : null;
  const additionalBorrowFees = borrowings.reduce((sum, event) => sum + event.upfrontFee, 0n);
  const repaidDebt = repayments.reduce((sum, event) => sum + event.debtRepaid, 0n);
  const collateralFlowsKnown = collateralChanges.every((event) =>
    ["deposit", "withdrawal"].includes(event.kind) && typeof event.price === "bigint" && event.price > 0n);
  const collateralFlows = collateralChanges.reduce((totals, event) => {
    const sign = event.kind === "deposit" ? 1n : -1n;
    totals.shares += sign * event.collateral;
    if (collateralFlowsKnown) totals.value += sign * (event.collateral * event.price / FLEX_PRICE_SCALE);
    return totals;
  }, { shares: 0n, value: 0n });
  const netCapitalAdded = principalKnown && collateralFlowsKnown
    ? collateralFlows.value + repaidDebt - additionalBorrowed
    : null;
  const hasCapitalFlows = Boolean(borrowings.length || repayments.length || collateralChanges.length);
  const redemptions = input.redemptions ?? [];
  const closeout = input.closeout ?? null;
  const liquidations = input.liquidations ?? [];
  const liquidationTotals = liquidations.reduce((totals, event) => ({
    collateral: totals.collateral + event.collateral,
    debt: totals.debt + event.debt,
    badDebt: totals.badDebt + (event.badDebt ?? 0n),
    absorbedByFees: totals.absorbedByFees + (event.absorbedByFees ?? 0n),
    value: totals.value + event.collateral * event.price / FLEX_PRICE_SCALE,
  }), { collateral: 0n, debt: 0n, badDebt: 0n, absorbedByFees: 0n, value: 0n });
  const liquidationImpact = liquidationTotals.debt + liquidationTotals.badDebt - liquidationTotals.value;
  const redemptionTotals = redemptions.reduce(
    (totals, redemption) => {
      totals.collateral += redemption.collateral;
      totals.debt += redemption.debt;
      totals.collateralValue += (redemption.collateral * redemption.price) / FLEX_PRICE_SCALE;
      return totals;
    },
    { collateral: 0n, debt: 0n, collateralValue: 0n },
  );
  const closeoutCollateral = closeout?.collateral ?? 0n;
  const closeoutDebt = closeout?.debt ?? 0n;
  const closeoutCollateralValue = closeout
    ? (closeout.collateral * closeout.price) / FLEX_PRICE_SCALE
    : 0n;
  const expectedCurrentCollateral = input.open
    ? input.open.collateral + collateralFlows.shares - redemptionTotals.collateral - liquidationTotals.collateral - closeoutCollateral
    : null;
  const redemptionImpact = redemptionTotals.debt - redemptionTotals.collateralValue;
  const endingValue = closeout
    ? closeoutCollateralValue - closeoutDebt
    : currentEquity;
  const valuationPrice = closeout?.price ?? input.currentPrice;
  const valuationTimestamp = closeout?.timestamp ?? input.currentTimestamp;

  const interestFromDebt = openingDebt !== null && principalKnown
    ? input.current.debt + redemptionTotals.debt + liquidationTotals.debt + liquidationTotals.badDebt + closeoutDebt + repaidDebt
      - openingDebt - additionalBorrowed - additionalBorrowFees - rateAdjustmentFees
    : null;
  const cleanOpenBaseline = Boolean(
    input.open
      && input.openTimestamp
      && expectedCurrentCollateral === input.current.collateral
      && !input.hasPositionChanges
      && principalKnown && collateralFlowsKnown
      && interestFromDebt !== null && interestFromDebt >= 0n,
  );
  const ppsChange = input.openPrice > 0n
    ? ((valuationPrice - input.openPrice) * WAD) / input.openPrice
    : null;
  const collateralValueChange = cleanOpenBaseline && collateralValueAtOpen !== null
    ? currentCollateralValue
      + redemptionTotals.collateralValue
      + liquidationTotals.value
      + closeoutCollateralValue
      - collateralValueAtOpen
      - collateralFlows.value
    : null;
  const accruedInterest = cleanOpenBaseline ? interestFromDebt : null;
  const postOpenPnl = cleanOpenBaseline && openingEquity !== null
    ? endingValue - openingEquity - netCapitalAdded
    : null;
  const upfrontFee = input.open?.upfrontFee ?? null;
  const totalOneTimeFees = upfrontFee === null ? null : upfrontFee + rateAdjustmentFees + additionalBorrowFees;
  const elapsedSeconds = cleanOpenBaseline
    && Number.isFinite(valuationTimestamp)
    && valuationTimestamp > input.openTimestamp
    ? valuationTimestamp - input.openTimestamp
    : null;
  const recurringPnl = collateralValueChange !== null && accruedInterest !== null
    ? collateralValueChange + redemptionImpact + liquidationImpact - accruedInterest
    : null;
  const pnl = collateralValueChange !== null
    && accruedInterest !== null
    && totalOneTimeFees !== null
    ? collateralValueChange + redemptionImpact + liquidationImpact - accruedInterest - totalOneTimeFees
    : null;
  const returnOnOpeningEquity =
    !hasCapitalFlows && postOpenPnl !== null && openingEquity !== null && openingEquity > 0n
      ? (postOpenPnl * WAD) / openingEquity
      : null;
  const returnOnInitialCapital =
    !hasCapitalFlows && pnl !== null && initialCapitalBeforeFee !== null && initialCapitalBeforeFee > 0n
      ? (pnl * WAD) / initialCapitalBeforeFee
      : null;
  const recurringReturnOnInitialCapital =
    !hasCapitalFlows && recurringPnl !== null && initialCapitalBeforeFee !== null && initialCapitalBeforeFee > 0n
      ? (recurringPnl * WAD) / initialCapitalBeforeFee
      : null;
  const upfrontFeeRate =
    upfrontFee !== null && initialCapitalBeforeFee !== null && initialCapitalBeforeFee > 0n
      ? (upfrontFee * WAD) / initialCapitalBeforeFee
      : null;
  const oneTimeFeeRate =
    totalOneTimeFees !== null && initialCapitalBeforeFee !== null && initialCapitalBeforeFee > 0n
      ? (totalOneTimeFees * WAD) / initialCapitalBeforeFee
      : null;
  const annualizedRecurringReturn =
    recurringReturnOnInitialCapital !== null && elapsedSeconds !== null
      ? annualizeWadReturn(recurringReturnOnInitialCapital, elapsedSeconds)
      : null;
  const baselineAnnualizedReturn =
    annualizedRecurringReturn !== null && oneTimeFeeRate !== null
      ? annualizedRecurringReturn - oneTimeFeeRate
      : null;

  const capitalFlows = [
    ...borrowings.map((event) => ({ timestamp: event.timestamp, amount: event.principal === null ? null : -event.principal })),
    ...repayments.map((event) => ({ timestamp: event.timestamp, amount: event.debtRepaid })),
    ...collateralChanges.map((event) => ({ timestamp: event.timestamp,
      amount: event.price == null ? null : (event.kind === "deposit" ? 1n : -1n) * event.collateral * event.price / FLEX_PRICE_SCALE })),
  ];
  const usesDietz = hasCapitalFlows || liquidations.length > 0;
  const dietz = usesDietz ? modifiedDietzReturn(initialCapitalBeforeFee, pnl,
    input.openTimestamp, valuationTimestamp, capitalFlows) : null;
  const feeAdjustedAnnualizedReturn = usesDietz ? dietz?.annualized ?? null : baselineAnnualizedReturn;

  return {
    liquidationImpact,
    liquidatedCollateralValue: liquidationTotals.value,
    liquidationDebtRepaid: liquidationTotals.debt,
    badDebtWrittenOff: liquidationTotals.badDebt,
    badDebtAbsorbedByFees: liquidationTotals.absorbedByFees,
    dietz,
    usesDietz,
    collateralValueAtOpen,
    currentCollateralValue,
    openingDebt,
    currentDebt: input.current.debt,
    initialCapitalBeforeFee,
    openingEquity,
    currentEquity,
    endingValue,
    upfrontFee,
    upfrontFeeRate,
    rateAdjustmentFees,
    additionalBorrowed,
    additionalBorrowFees,
    repaidDebt,
    netCollateralAddedValue: collateralFlowsKnown ? collateralFlows.value : null,
    netCapitalAdded,
    hasCapitalFlows,
    totalOneTimeFees,
    oneTimeFeeRate,
    redeemedCollateral: redemptionTotals.collateral,
    redeemedDebt: redemptionTotals.debt,
    redeemedCollateralValue: redemptionTotals.collateralValue,
    redemptionImpact,
    closeoutCollateral,
    closeoutDebt,
    closeoutCollateralValue,
    closeoutNetValue: closeout ? endingValue : null,
    elapsedSeconds,
    ppsChange,
    collateralValueChange,
    accruedInterest,
    recurringPnl,
    postOpenPnl,
    grossAnnualIncome,
    annualBorrowCost,
    annualNetCarry,
    ltv,
    leverage,
    equityApr,
    rateSpread,
    cleanOpenBaseline,
    pnl,
    returnOnOpeningEquity,
    returnOnInitialCapital,
    recurringReturnOnInitialCapital,
    annualizedRecurringReturn,
    feeAdjustedAnnualizedReturn,
  };
}

export function aggregatePositions(positions) {
  if (!positions.length) return null;

  const borrowSymbols = new Set(positions.map((position) => position.borrowSymbol));
  const borrowDecimals = new Set(positions.map((position) => position.borrowDecimals));
  if (borrowSymbols.size !== 1 || borrowDecimals.size !== 1) return null;

  const totals = positions.reduce(
    (result, position) => {
      result.currentEquity += position.calculation.currentEquity;
      result.endingValue += position.calculation.endingValue;
      result.currentCollateralValue += position.calculation.currentCollateralValue;
      result.currentDebt += position.calculation.currentDebt;
      result.annualNetCarry = result.annualNetCarry === null || position.calculation.annualNetCarry === null
        ? null
        : result.annualNetCarry + position.calculation.annualNetCarry;
      if (
        position.calculation.cleanOpenBaseline
        && position.calculation.openingEquity !== null
        && position.calculation.pnl !== null
      ) {
        result.openingEquity += position.calculation.openingEquity;
        result.initialCapitalBeforeFee += position.calculation.initialCapitalBeforeFee;
        result.upfrontFee += position.calculation.upfrontFee;
        result.rateAdjustmentFees += position.calculation.rateAdjustmentFees;
        result.additionalBorrowFees += position.calculation.additionalBorrowFees;
        result.additionalBorrowed += position.calculation.additionalBorrowed;
        result.repaidDebt += position.calculation.repaidDebt;
        result.netCapitalAdded += position.calculation.netCapitalAdded;
        result.totalOneTimeFees += position.calculation.totalOneTimeFees;
        result.liquidationImpact += position.calculation.liquidationImpact;
        result.badDebtWrittenOff += position.calculation.badDebtWrittenOff;
        result.redeemedDebt += position.calculation.redeemedDebt;
        result.redemptionImpact += position.calculation.redemptionImpact;
        result.collateralValueChange += position.calculation.collateralValueChange;
        result.accruedInterest += position.calculation.accruedInterest;
        result.postOpenPnl += position.calculation.postOpenPnl;
        result.pnl += position.calculation.pnl;
        result.pnlPositionCount += 1;
      }
      return result;
    },
    {
      currentEquity: 0n,
      endingValue: 0n,
      currentCollateralValue: 0n,
      currentDebt: 0n,
      annualNetCarry: 0n,
      openingEquity: 0n,
      initialCapitalBeforeFee: 0n,
      upfrontFee: 0n,
      rateAdjustmentFees: 0n,
      additionalBorrowFees: 0n,
      additionalBorrowed: 0n,
      repaidDebt: 0n,
      netCapitalAdded: 0n,
      totalOneTimeFees: 0n,
      liquidationImpact: 0n,
      badDebtWrittenOff: 0n,
      redeemedDebt: 0n,
      redemptionImpact: 0n,
      collateralValueChange: 0n,
      accruedInterest: 0n,
      postOpenPnl: 0n,
      pnl: 0n,
      pnlPositionCount: 0,
    },
  );

  const fullyReconciled = totals.pnlPositionCount === positions.length;

  return {
    ...totals,
    initialCapitalBeforeFee: fullyReconciled ? totals.initialCapitalBeforeFee : null,
    upfrontFee: fullyReconciled ? totals.upfrontFee : null,
    rateAdjustmentFees: fullyReconciled ? totals.rateAdjustmentFees : null,
    additionalBorrowFees: fullyReconciled ? totals.additionalBorrowFees : null,
    additionalBorrowed: fullyReconciled ? totals.additionalBorrowed : null,
    repaidDebt: fullyReconciled ? totals.repaidDebt : null,
    netCapitalAdded: fullyReconciled ? totals.netCapitalAdded : null,
    totalOneTimeFees: fullyReconciled ? totals.totalOneTimeFees : null,
    liquidationImpact: fullyReconciled ? totals.liquidationImpact : null,
    badDebtWrittenOff: fullyReconciled ? totals.badDebtWrittenOff : null,
    redeemedDebt: fullyReconciled ? totals.redeemedDebt : null,
    redemptionImpact: fullyReconciled ? totals.redemptionImpact : null,
    collateralValueChange: fullyReconciled ? totals.collateralValueChange : null,
    accruedInterest: fullyReconciled ? totals.accruedInterest : null,
    postOpenPnl: fullyReconciled ? totals.postOpenPnl : null,
    pnl: fullyReconciled ? totals.pnl : null,
    borrowSymbol: positions[0].borrowSymbol,
    borrowDecimals: positions[0].borrowDecimals,
    equityApr: totals.currentEquity > 0n && totals.annualNetCarry !== null
      ? (totals.annualNetCarry * WAD) / totals.currentEquity
      : null,
    returnOnOpeningEquity:
      fullyReconciled && !positions.some((position) => position.calculation.hasCapitalFlows) && totals.openingEquity > 0n
        ? (totals.postOpenPnl * WAD) / totals.openingEquity
        : null,
    returnOnInitialCapital:
      fullyReconciled && !positions.some((position) => position.calculation.hasCapitalFlows) && totals.initialCapitalBeforeFee > 0n
        ? (totals.pnl * WAD) / totals.initialCapitalBeforeFee
        : null,
  };
}

export function formatUnits(value, decimals, maximumFractionDigits = 2) {
  if (value === null || value === undefined) return "Unavailable";

  const amount = BigInt(value);
  const negative = amount < 0n;
  const absolute = negative ? -amount : amount;
  const precision = pow10(decimals);
  const whole = absolute / precision;
  const fraction = absolute % precision;
  const visibleDigits = Math.min(Number(decimals), maximumFractionDigits);
  const divisor = pow10(Number(decimals) - visibleDigits);
  const rounded = (fraction + divisor / 2n) / divisor;
  const rollover = rounded >= pow10(visibleDigits);
  const displayWhole = whole + (rollover ? 1n : 0n);
  const displayFraction = rollover ? 0n : rounded;
  const wholeLabel = displayWhole.toLocaleString("en-US");

  if (visibleDigits === 0) return `${negative ? "-" : ""}${wholeLabel}`;
  return `${negative ? "-" : ""}${wholeLabel}.${displayFraction
    .toString()
    .padStart(visibleDigits, "0")}`;
}

export function formatPercent(wadValue, maximumFractionDigits = 2) {
  if (wadValue === null || wadValue === undefined) return "Unavailable";
  return `${formatUnits(BigInt(wadValue) * 100n, 18, maximumFractionDigits)}%`;
}

// Modified Dietz weights each net contribution by the time it was invested.
// Fees are already in P&L; never subtract them a second time.
export function modifiedDietzReturn(initialCapital, pnl, start, end, flows) {
  if (initialCapital === null || pnl === null || !Number.isSafeInteger(start)
    || !Number.isSafeInteger(end) || end <= start) return null;
  const duration = BigInt(end - start);
  let weightedCapital = initialCapital * duration;
  for (const flow of flows) {
    if (typeof flow.amount !== "bigint" || !Number.isSafeInteger(flow.timestamp)
      || flow.timestamp < start || flow.timestamp > end) return null;
    weightedCapital += flow.amount * BigInt(end - flow.timestamp);
  }
  if (weightedCapital <= 0n) return null;
  const periodReturn = pnl * duration * WAD / weightedCapital;
  return { periodReturn, annualized: periodReturn === -WAD ? -WAD : annualizeWadReturn(periodReturn, end - start),
    weightedCapital: weightedCapital / duration };
}
