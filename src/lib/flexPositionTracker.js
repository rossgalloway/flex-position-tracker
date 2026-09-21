import { readFunding } from "./flexFunding.js";
import { EVENT_TOPICS, decodeHistory, reconcileHistory } from "./flexHistory.js";
import {
  WAD,
  aggregatePositions,
  calculatePosition,
  decodeAddressWord,
  decodeAdjustInterestRateLog,
  decodeBorrowLog,
  decodeBorrowPrincipal,
  decodeCollateralChangeLog,
  decodeCloseTroveLog,
  decodeOpenTroveLog,
  decodeRepayLog,
  decodeRedeemTroveLog,
  decodeTroveResult,
  encodeUintCall,
  formatPercent,
  formatUnits,
  pow10,
  priceRawToDisplayWad,
  splitWords,
  toTopic,
} from "./flexPositionModel.js";
import {
  buildFlexStatementDocument,
  statementExportFilename,
} from "./flexStatementExport.js";

import { fetchProjectionSnapshot, selectProjection } from "./flexProjection.js";

const RPC_URL = "/api/flex-rpc";
const WALLETS_STORAGE_KEY = "flex-position-tracker:wallets";
const ETHEREUM_ADDRESS = /^0x[0-9a-f]{40}$/i;

const TROVE_EVENT_TOPICS = Object.values(EVENT_TOPICS);
const BASELINE_EVENT_TOPICS = new Set([
  EVENT_TOPICS.openTrove,
  EVENT_TOPICS.adjustInterestRate,
  EVENT_TOPICS.redeemTrove,
  EVENT_TOPICS.closeTrove,
  EVENT_TOPICS.closeZombieTrove,
  EVENT_TOPICS.borrow,
  EVENT_TOPICS.repay,
  EVENT_TOPICS.addCollateral,
  EVENT_TOPICS.removeCollateral,
  EVENT_TOPICS.liquidateTrove,
  EVENT_TOPICS.badDebt,
]);
const TROVE_STATUS = {
  active: 1,
  zombie: 2,
  closed: 4,
  liquidated: 8,
};
const SELECTORS = {
  troves: "0x87553b7e",
  debtAfterInterest: "0x0ff8afc1",
  priceOracle: "0x86fc88d3",
  getPrice: "0x11f37ceb",
};

export const FLEX_MARKETS = [
  {
    key: "ysybold",
    manager: "0xADf4E0226d59aac20272023c04B4DcF5Ade7Fc6E",
    discoveryFromBlock: 25740294,
    collateralToken: "0x23346B04a7f55b8760E5860AA5A77383D63491cD",
    collateralSymbol: "ysyBOLD",
    collateralDecimals: 18,
    borrowSymbol: "USDC",
    borrowDecimals: 6,
  },
  {
    key: "yvusd",
    manager: "0x8ee72c388aA73096338EE18CD46a39D98b8983c9",
    discoveryFromBlock: 25690643,
    collateralToken: "0x696d02Db93291651ED510704c9b286841d506987",
    collateralSymbol: "yvUSD",
    collateralDecimals: 6,
    borrowSymbol: "USDC",
    borrowDecimals: 6,
  },
  {
    key: "yvcrvusd2",
    manager: "0x7582b47486F75F5D675f260d357972cD0DbEeA2E",
    discoveryFromBlock: 25821066,
    collateralToken: "0xBF319dDC2Edc1Eb6FDf9910E39b37Be221C8805F",
    collateralSymbol: "yvcrvUSD-2",
    collateralDecimals: 18,
    borrowSymbol: "USDC",
    borrowDecimals: 6,
  },
];

export function buildPositionGroups(wallets, markets = FLEX_MARKETS) {
  const normalizedWallets = [...new Set(wallets
    .map((wallet) => wallet.trim().toLowerCase())
    .filter((wallet) => ETHEREUM_ADDRESS.test(wallet)))]
    .sort();

  return normalizedWallets.flatMap((wallet) => markets.map((market) => ({
    ...market,
    key: `${market.key}-${wallet.slice(2)}`,
    marketKey: market.key,
    wallet,
  })));
}


let rpcId = 0;

async function rpc(method, params, signal) {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    signal,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Ethereum RPC returned ${response.status}`);
  }
  if (!payload) throw new Error("Ethereum RPC returned an invalid response");
  if (payload.error) throw new Error(payload.error.message || "Ethereum RPC error");
  return payload.result;
}

async function ethCall(to, data, block, signal) {
  return rpc("eth_call", [{ to, data }, block], signal);
}

function decodeUint(data) {
  const [word] = splitWords(data);
  return BigInt(`0x${word}`);
}

export function positionConfigsFromOpenLogs(group, logs) {
  const wallet = group.wallet.toLowerCase();
  const positions = logs
    .filter((log) => log.topics?.[0]?.toLowerCase() === EVENT_TOPICS.openTrove)
    .filter((log) => decodeAddressWord(log.topics[2]).toLowerCase() === wallet)
    .map((log) => {
      const openBlock = Number(BigInt(log.blockNumber));
      const logIndex = Number(BigInt(log.logIndex));
      return {
        ...group,
        groupKey: group.key,
        key: `${group.key}-${openBlock}-${logIndex}`,
        troveId: BigInt(log.topics[1]).toString(),
        openBlock,
        openLogIndex: logIndex,
      };
    })
    .sort((left, right) => left.openBlock - right.openBlock
      || left.openLogIndex - right.openLogIndex);

  return positions.map((position, index) => ({
    ...position,
    troveNumber: index + 1,
    troveCount: positions.length,
  }));
}

export function sortPositionsForReport(positions) {
  return [...positions].sort((left, right) => {
    const statusOrder = Number(["closed", "liquidated"].includes(left.status)) - Number(["closed", "liquidated"].includes(right.status));
    if (statusOrder !== 0) return statusOrder;

    const walletOrder = left.wallet.toLowerCase().localeCompare(right.wallet.toLowerCase());
    if (walletOrder !== 0) return walletOrder;

    const marketOrder = left.collateralSymbol.toLowerCase()
      .localeCompare(right.collateralSymbol.toLowerCase());
    if (marketOrder !== 0) return marketOrder;

    return right.openBlock - left.openBlock || right.openLogIndex - left.openLogIndex;
  });
}

export function groupPositionsByWallet(positions) {
  const groups = new Map();

  for (const position of positions) {
    const key = position.wallet.toLowerCase();
    const group = groups.get(key) ?? { wallet: position.wallet, positions: [] };
    group.positions.push(position);
    groups.set(key, group);
  }

  return [...groups.values()]
    .sort((left, right) => left.wallet.toLowerCase().localeCompare(right.wallet.toLowerCase()))
    .map((group) => ({
      ...group,
      positions: sortPositionsForReport(group.positions),
    }));
}

function eventLogDetails(log) {
  return {
    block: Number(BigInt(log.blockNumber)),
    logIndex: Number(BigInt(log.logIndex)),
    transactionHash: log.transactionHash,
  };
}

export function buildPositionTimeline(logs, timestampByBlock = new Map()) {
  const entries = logs
    .map((log) => ({
      ...log,
      topic: log.topics?.[0]?.toLowerCase(),
      ...eventLogDetails(log),
    }))
    .sort((left, right) => left.block - right.block || left.logIndex - right.logIndex);
  const consumed = new Set();
  const timeline = [];
  const timestampFor = (block) => timestampByBlock instanceof Map
    ? timestampByBlock.get(block)
    : timestampByBlock[block];
  const push = (entry, item) => timeline.push({
    ...item,
    block: entry.block,
    logIndex: entry.logIndex,
    timestamp: timestampFor(entry.block) ?? null,
    transactionHash: entry.transactionHash,
  });

  for (const entry of entries) {
    if (consumed.has(entry)) continue;

    if (entry.topic === EVENT_TOPICS.openTrove) {
      push(entry, { kind: "open", label: "Opened", ...decodeOpenTroveLog(entry.data) });
      continue;
    }

    if (entry.topic === EVENT_TOPICS.addCollateral) {
      const borrow = entries.find((candidate) => !consumed.has(candidate)
        && candidate.topic === EVENT_TOPICS.borrow
        && candidate.transactionHash === entry.transactionHash);
      if (borrow) {
        consumed.add(borrow);
        push(entry, {
          kind: "loop",
          label: "Looped up",
          ...decodeCollateralChangeLog(entry.data),
          ...decodeBorrowLog(borrow.data),
        });
      } else {
        push(entry, {
          kind: "deposit",
          label: "Deposited",
          ...decodeCollateralChangeLog(entry.data),
        });
      }
      continue;
    }

    if (entry.topic === EVENT_TOPICS.removeCollateral) {
      push(entry, {
        kind: "withdrawal",
        label: "Withdrew collateral",
        ...decodeCollateralChangeLog(entry.data),
      });
      continue;
    }

    if (entry.topic === EVENT_TOPICS.borrow) {
      push(entry, { kind: "borrow", label: "Debt increased", ...decodeBorrowLog(entry.data) });
      continue;
    }

    if (entry.topic === EVENT_TOPICS.repay) {
      push(entry, { kind: "repay", label: "Debt repaid", ...decodeRepayLog(entry.data) });
      continue;
    }

    if (entry.topic === EVENT_TOPICS.adjustInterestRate) {
      push(entry, {
        kind: "rate",
        label: "Rate changed",
        ...decodeAdjustInterestRateLog(entry.data),
      });
      continue;
    }

    if (entry.topic === EVENT_TOPICS.redeemTrove) {
      push(entry, { kind: "redeem", label: "Redeemed", ...decodeRedeemTroveLog(entry.data) });
      continue;
    }

    if (entry.topic === EVENT_TOPICS.liquidateTrove || entry.topic === EVENT_TOPICS.badDebt) {
      const event = decodeHistory([entry], new Map())[0];
      push(entry, { ...event, kind: entry.topic === EVENT_TOPICS.badDebt ? "badDebt" : "liquidation",
        label: entry.topic === EVENT_TOPICS.badDebt ? "Debt written off" : event.full ? "Full liquidation" : "Partial liquidation" });
      continue;
    }
    if ([EVENT_TOPICS.closeTrove, EVENT_TOPICS.closeZombieTrove].includes(entry.topic)) {
      push(entry, {
        kind: "close",
        label: "Closed",
        eventName: entry.topic === EVENT_TOPICS.closeZombieTrove
          ? "CloseZombieTrove"
          : "CloseTrove",
        ...decodeCloseTroveLog(entry.data),
      });
    }
  }

  return timeline.sort((left, right) => left.block - right.block || left.logIndex - right.logIndex);
}

export function classifyTimelineRedemptions(timeline, terminalDebt) {
  let finalRedemptionIndex = -1;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index].kind === "redeem") {
      finalRedemptionIndex = index;
      break;
    }
  }

  return timeline.map((event, index) => {
    if (event.kind !== "redeem") return event;
    const isFullRedemption = index === finalRedemptionIndex && terminalDebt === 0n;
    return {
      ...event,
      label: isFullRedemption ? "Full Redemption" : "Partial Redemption",
      redemptionType: isFullRedemption ? "full" : "partial",
    };
  });
}

async function discoverPositionConfigs(groups, snapshotBlock, signal) {
  const markets = new Map();
  for (const group of groups) {
    const key = group.manager.toLowerCase();
    const market = markets.get(key);
    if (!market || group.discoveryFromBlock < market.discoveryFromBlock) {
      markets.set(key, group);
    }
  }

  const logsByManager = new Map(await Promise.all(
    [...markets.values()].map(async (market) => {
      const logs = await rpc("eth_getLogs", [{
        address: market.manager,
        fromBlock: `0x${market.discoveryFromBlock.toString(16)}`,
        toBlock: `0x${snapshotBlock.toString(16)}`,
        topics: [EVENT_TOPICS.openTrove],
      }], signal);
      return [market.manager.toLowerCase(), logs];
    }),
  ));

  return groups.flatMap((group) => positionConfigsFromOpenLogs(
    group,
    logsByManager.get(group.manager.toLowerCase()) ?? [],
  ));
}

function shorten(value, front = 6, back = 4) {
  return `${value.slice(0, front)}…${value.slice(-back)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatMoney(value, decimals, symbol = "USDC", digits = 2) {
  return value === null || value === undefined
    ? "Unavailable"
    : `${formatUnits(value, decimals, digits)} ${symbol}`;
}

function formatSignedMoney(value, decimals, symbol = "USDC", digits = 2) {
  if (value === null || value === undefined) return "Unavailable";
  const amount = BigInt(value);
  const sign = amount > 0n ? "+" : amount < 0n ? "−" : "";
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}${formatUnits(absolute, decimals, digits)} ${symbol}`;
}

function formatDate(timestamp, includeTime = false) {
  if (!timestamp) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit", timeZoneName: "short" } : {}),
  }).format(new Date(timestamp * 1000));
}

async function readPosition(config, snapshotBlock, snapshotTimestamp, projectionSource, signal, projectionSnapshots) {
  const blockTag = `0x${snapshotBlock.toString(16)}`;
  const troveTopic = toTopic(config.troveId);
  const [troveData, debtData, priceOracleData, positionLogs] = await Promise.all([
    ethCall(config.manager, encodeUintCall(SELECTORS.troves, config.troveId), blockTag, signal),
    ethCall(config.manager, encodeUintCall(SELECTORS.debtAfterInterest, config.troveId), blockTag, signal),
    ethCall(config.manager, SELECTORS.priceOracle, blockTag, signal),
    rpc("eth_getLogs", [{
      address: config.manager,
      fromBlock: `0x${config.openBlock.toString(16)}`,
      toBlock: blockTag,
      topics: [TROVE_EVENT_TOPICS, troveTopic],
    }], signal),
  ]);

  const openLog = positionLogs.find(
    (log) => log.topics?.[0]?.toLowerCase() === EVENT_TOPICS.openTrove,
  );
  if (!openLog) throw new Error("Opening event was not found in the trove history");

  const rateAdjustments = positionLogs
    .filter((log) => log.topics?.[0]?.toLowerCase() === EVENT_TOPICS.adjustInterestRate)
    .map((log) => ({
      ...decodeAdjustInterestRateLog(log.data),
      block: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
    }));
  const rateAdjustmentFees = rateAdjustments.reduce(
    (total, adjustment) => total + adjustment.upfrontFee,
    0n,
  );
  const redemptionEvents = positionLogs
    .filter((log) => log.topics?.[0]?.toLowerCase() === EVENT_TOPICS.redeemTrove)
    .map((log) => ({
      ...decodeRedeemTroveLog(log.data),
      block: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
    }));
  const closeoutEvents = positionLogs
    .filter((log) => [EVENT_TOPICS.closeTrove, EVENT_TOPICS.closeZombieTrove]
      .includes(log.topics?.[0]?.toLowerCase()))
    .map((log) => ({
      ...decodeCloseTroveLog(log.data),
      block: Number(BigInt(log.blockNumber)),
      transactionHash: log.transactionHash,
      eventName: log.topics[0].toLowerCase() === EVENT_TOPICS.closeZombieTrove
        ? "CloseZombieTrove"
        : "CloseTrove",
    }));
  if (closeoutEvents.length > 1) throw new Error("Multiple closeout events were found");
  const liquidationEvents = decodeHistory(positionLogs, new Map()).filter((event) => event.kind === "liquidateTrove");
  const finalLiquidation = liquidationEvents.find((event) => event.full);
  if (finalLiquidation && closeoutEvents.length) throw new Error("Conflicting terminal events");
  const closeoutEvent = closeoutEvents[0] ?? (finalLiquidation ? {
    ...finalLiquidation, collateral: 0n, debt: 0n, eventName: "LiquidateTrove",
  } : null);
  let hasPositionChanges = positionLogs.some(
    (log) => !BASELINE_EVENT_TOPICS.has(log.topics?.[0]?.toLowerCase()),
  );
  const borrowingLogs = positionLogs.filter((log) => log.topics[0].toLowerCase() === EVENT_TOPICS.borrow);
  const borrowings = await Promise.all(borrowingLogs.map(async (log) => {
    const event = { ...decodeBorrowLog(log.data), ...eventLogDetails(log) };
    try {
      if (borrowingLogs.filter((other) => other.transactionHash === log.transactionHash).length !== 1) {
        throw new Error("Multiple Borrow events in one transaction require call tracing");
      }
      const transaction = await rpc("eth_getTransactionByHash", [log.transactionHash], signal);
      const principal = decodeBorrowPrincipal(transaction, { ...config, ...event });
      if (event.debtAfterBorrow < principal + event.upfrontFee) throw new Error("Borrow debt does not cover principal and fee");
      return { ...event, principal };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { ...event, principal: null, issue: error.message };
    }
  }));
  const repayments = positionLogs
    .filter((log) => log.topics[0].toLowerCase() === EVENT_TOPICS.repay)
    .map((log) => ({ ...decodeRepayLog(log.data), ...eventLogDetails(log) }));
  const collateralEvents = positionLogs
    .filter((log) => [EVENT_TOPICS.addCollateral, EVENT_TOPICS.removeCollateral].includes(log.topics[0].toLowerCase()))
    .map((log) => ({
      ...decodeCollateralChangeLog(log.data),
      ...eventLogDetails(log),
      kind: log.topics[0].toLowerCase() === EVENT_TOPICS.addCollateral ? "deposit" : "withdrawal",
    }));

  const current = decodeTroveResult(troveData);
  current.debt = decodeUint(debtData);
  const status = current.statusCode === TROVE_STATUS.active
    ? "active"
    : current.statusCode === TROVE_STATUS.zombie
      ? "zombie"
      : current.statusCode === TROVE_STATUS.closed
        ? "closed"
        : current.statusCode === TROVE_STATUS.liquidated ? "liquidated" : "unsupported";
  if (status === "unsupported") {
    throw new Error(`Unsupported trove status ${current.statusCode}`);
  }
  const isTerminal = ["closed", "liquidated"].includes(status);
  if (isTerminal && !closeoutEvent) {
    throw new Error("Closed trove settlement event was not found");
  }

  const openingOwner = decodeAddressWord(openLog.topics[2]).toLowerCase();
  if (openingOwner !== config.wallet.toLowerCase()) {
    throw new Error(`Opening owner mismatch: expected ${config.wallet}, received ${openingOwner}`);
  }
  if (!isTerminal && current.owner.toLowerCase() !== config.wallet.toLowerCase()) {
    throw new Error(`Owner mismatch: expected ${config.wallet}, received ${current.owner}`);
  }

  const [priceOracleWord] = splitWords(priceOracleData);
  const priceOracle = decodeAddressWord(priceOracleWord);
  const valuationEvents = [...redemptionEvents, ...collateralEvents, ...liquidationEvents, ...(closeoutEvent ? [closeoutEvent] : [])];
  const timelineBlocks = [...new Set(positionLogs.map((log) => Number(BigInt(log.blockNumber))))];
  const [currentPriceData, openPriceData, valuationPriceData, timelineBlockData, projectionData] = await Promise.all([
    isTerminal
      ? Promise.resolve(null)
      : ethCall(priceOracle, SELECTORS.getPrice, blockTag, signal),
    ethCall(priceOracle, SELECTORS.getPrice, `0x${config.openBlock.toString(16)}`, signal),
    Promise.all(
      valuationEvents.map((event) => ethCall(
        priceOracle,
        SELECTORS.getPrice,
        `0x${event.block.toString(16)}`,
        signal,
      )),
    ),
    Promise.all(timelineBlocks.map((block) => rpc(
      "eth_getBlockByNumber",
      [`0x${block.toString(16)}`, false],
      signal,
    ))),
    isTerminal ? Promise.resolve(null) : (() => {
      const token = config.collateralToken.toLowerCase();
      if (!projectionSnapshots.has(token)) {
        projectionSnapshots.set(token, fetchProjectionSnapshot(token, signal));
      }
      return projectionSnapshots.get(token);
    })(),
  ]);

  const open = decodeOpenTroveLog(openLog.data);
  const timestampByBlock = new Map(timelineBlocks.map((block, index) => [
    block,
    Number(BigInt(timelineBlockData[index].timestamp)),
  ]));
  const rawTimeline = buildPositionTimeline(positionLogs, timestampByBlock);
  const history = reconcileHistory(decodeHistory(positionLogs, timestampByBlock), current, snapshotTimestamp, config.borrowDecimals);
  const needsReplay = liquidationEvents.length || positionLogs.some((log) => log.topics[0].toLowerCase() === EVENT_TOPICS.badDebt) || borrowings.some((event) => event.principal === null);
  if (needsReplay && !history.verified) hasPositionChanges = true;
  for (const event of borrowings) {
    event.timestamp = timestampByBlock.get(event.block);
    const replayed = history.events.find((item) => item.kind === "borrow" && item.logIndex === event.logIndex && item.block === event.block);
    if (history.verified && replayed) {
      if (event.principal !== null && event.principal !== replayed.principal) {
        event.issue = "Calldata principal differs from reconciled history"; event.principal = null;
        hasPositionChanges = true;
      } else {
        event.principal = replayed.principal;
        event.source = event.issue ? "Reconciled event history" : "Calldata and reconciled history";
        delete event.issue;
      }
    }
  }
  for (const event of repayments) event.timestamp = timestampByBlock.get(event.block);
  if (finalLiquidation) {
    const replayed = history.events.find((event) => event.kind === "liquidateTrove" && event.full);
    if (!replayed) throw new Error(history.issue ?? "Full liquidation could not be reconstructed");
    closeoutEvent.collateral = replayed.returnedCollateral;
  }
  const openTimestamp = timestampByBlock.get(config.openBlock);
  const projection = projectionData ? {
    ...selectProjection(projectionData.snapshot, config.collateralToken, projectionSource),
    sourceUrl: projectionData.url,
    ...(projectionData.error ? { note: projectionData.error } : {}),
  } : null;
  const openPrice = decodeUint(openPriceData);
  const redemptions = redemptionEvents.map((redemption, index) => ({
    ...redemption,
    price: decodeUint(valuationPriceData[index]),
  }));
  const collateralChanges = collateralEvents.map((event, index) => ({
    ...event,
    timestamp: timestampByBlock.get(event.block),
    price: decodeUint(valuationPriceData[redemptionEvents.length + index]),
  }));
  const liquidations = liquidationEvents.map((event, index) => ({
    ...event,
    ...history.events.find((item) => item.kind === "liquidateTrove" && item.block === event.block && item.logIndex === event.logIndex),
    price: decodeUint(valuationPriceData[redemptionEvents.length + collateralEvents.length + index]),
  }));
  const closeout = closeoutEvent
    ? {
      ...closeoutEvent,
      price: decodeUint(valuationPriceData.at(-1)),
      timestamp: timestampByBlock.get(closeoutEvent.block),
    }
    : null;
  const timeline = classifyTimelineRedemptions(
    rawTimeline,
    closeout?.debt ?? current.debt,
  );
  const fundingEvents = decodeHistory(positionLogs, timestampByBlock).map((event) => ({ ...event,
    ...(event.kind === "borrow" ? borrowings.find((borrow) => borrow.block === event.block && borrow.logIndex === event.logIndex) : {}),
  }));
  const funding = await readFunding(fundingEvents, config, snapshotBlock, rpc, ethCall, signal);
  const currentPrice = isTerminal ? closeout.price : decodeUint(currentPriceData);
  const calculation = calculatePosition({
    borrowDecimals: config.borrowDecimals,
    collateralApr: projection?.apr ?? null,
    openTimestamp,
    currentTimestamp: snapshotTimestamp,
    openPrice,
    currentPrice,
    open,
    current,
    rateAdjustmentFees,
    redemptions,
    closeout,
    hasPositionChanges,
    borrowings,
    repayments,
    collateralChanges,
    liquidations,
  });

  return {
    ...config,
    open,
    openTimestamp,
    openTransaction: openLog.transactionHash,
    rateAdjustments,
    redemptions,
    closeout,
    timeline,
    hasPositionChanges,
    borrowings,
    repayments,
    collateralChanges,
    liquidations,
    funding,
    settlementAdjustedPnl: funding.adjustment !== null && calculation.pnl !== null ? calculation.pnl + funding.adjustment : null,
    historyReconciled: history.verified,
    accountingIssue: (needsReplay && !history.verified ? history.issue : null) ?? borrowings.find((event) => event.issue)?.issue
      ?? (hasPositionChanges ? "Unsupported position events" : null)
      ?? (!calculation.cleanOpenBaseline ? "Debt or collateral history does not reconcile" : null),
    status,
    current,
    openPrice,
    currentPrice,
    priceOracle,
    projection,
    calculation,
  };
}

export async function fetchFlexPositionSnapshot({
  groups = [],
  groupKeys = groups.map((group) => group.key),
  projectionSource = "automatic",
  signal,
} = {}) {
  const blockHex = await rpc("eth_blockNumber", [], signal);
  const block = Number(BigInt(blockHex));
  const blockData = await rpc("eth_getBlockByNumber", [blockHex, false], signal);
  const timestamp = Number(BigInt(blockData.timestamp));
  const selectedGroups = groups.filter((group) => groupKeys.includes(group.key));
  const selectedPositions = (await discoverPositionConfigs(selectedGroups, block, signal))
    .sort((left, right) => groups.findIndex((group) => group.key === left.groupKey)
      - groups.findIndex((group) => group.key === right.groupKey)
      || right.openBlock - left.openBlock
      || right.openLogIndex - left.openLogIndex);
  const projectionSnapshots = new Map();
  const positions = sortPositionsForReport(await Promise.all(
    selectedPositions.map((config) => readPosition(config, block, timestamp, projectionSource, signal, projectionSnapshots)),
  ));
  return { block, timestamp, positions };
}

function renderMetric(label, value, note = "") {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
}

function renderStatementRow(label, note, value, { detail = false, result = false } = {}) {
  const classes = [detail ? "is-detail" : "", result ? "is-result" : ""]
    .filter(Boolean)
    .join(" ");
  return `<li${classes ? ` class="${classes}"` : ""}>
    <span>${escapeHtml(label)}</span>
    <small>${escapeHtml(note)}</small>
    <strong>${escapeHtml(value)}</strong>
  </li>`;
}

function formatElapsedPeriod(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "unavailable period";
  const days = seconds / 86_400;
  if (days < 1) return `${(seconds / 3_600).toFixed(1)} hours`;
  return `${days.toFixed(days < 10 ? 2 : 1)} days`;
}

function timelineEventCopy(event, position) {
  const collateral = (value) => `${formatUnits(value, position.collateralDecimals, 4)} ${position.collateralSymbol}`;
  const debt = (value) => formatMoney(value, position.borrowDecimals, position.borrowSymbol);
  const borrowRate = (value) => formatPercent((value * WAD) / pow10(position.borrowDecimals));

  if (event.kind === "open") {
    return {
      summary: `${collateral(event.collateral)} deposited · ${debt(event.borrowed)} borrowed`,
      note: `${borrowRate(event.annualInterestRate)} fixed APR · ${debt(event.upfrontFee)} fee`,
    };
  }
  if (event.kind === "loop") {
    return {
      summary: `${collateral(event.collateral)} added · ${debt(event.debtAfterBorrow)} debt after loop`,
      note: `${debt(event.upfrontFee)} upfront fee`,
    };
  }
  if (event.kind === "deposit" || event.kind === "withdrawal") {
    return { summary: collateral(event.collateral), note: "" };
  }
  if (event.kind === "borrow") {
    return {
      summary: `${debt(event.debtAfterBorrow)} debt after borrowing`,
      note: `${debt(event.upfrontFee)} upfront fee`,
    };
  }
  if (event.kind === "liquidation") return { summary: `${collateral(event.collateral)} seized · ${debt(event.debt)} repaid`, note: `Liquidator ${shorten(event.liquidator)}` };
  if (event.kind === "badDebt") return { summary: `${debt(event.loss)} written off`, note: `${debt(event.absorbedByFees)} absorbed by protocol fees` };
  if (event.kind === "repay") {
    return { summary: debt(event.debtRepaid), note: "" };
  }
  if (event.kind === "rate") {
    return {
      summary: borrowRate(event.annualInterestRate),
      note: event.upfrontFee > 0n ? `${debt(event.upfrontFee)} adjustment fee` : "No adjustment fee",
    };
  }
  if (event.kind === "redeem") {
    return {
      summary: `${collateral(event.collateral)} removed · ${debt(event.debt)} debt cancelled`,
      note: "RedeemTrove",
    };
  }
  if (event.kind === "close") {
    return {
      summary: `${collateral(event.collateral)} returned · ${debt(event.debt)} debt repaid`,
      note: event.eventName,
    };
  }
  return { summary: "", note: "" };
}

function renderTimeline(position) {
  const events = position.timeline ?? [];
  if (!events.length) return "";

  return `<section class="activity" aria-labelledby="${escapeHtml(position.key)}-activity">
    <header class="section-heading">
      <h3 id="${escapeHtml(position.key)}-activity">Activity Timeline</h3>
    </header>
    <ol class="activity-timeline">
      ${events.map((event) => {
    const copy = timelineEventCopy(event, position);
    const transactionUrl = `https://eth.blockscout.com/tx/${event.transactionHash}`;
    const dateTime = event.timestamp
      ? new Date(event.timestamp * 1000).toISOString()
      : "";
    return `<li class="activity-event is-${escapeHtml(event.kind)}">
          <span class="activity-marker" aria-hidden="true"></span>
          <div class="activity-date">
            ${event.timestamp ? `<time datetime="${escapeHtml(dateTime)}">${escapeHtml(formatDate(event.timestamp, true))}</time>` : `<span>Time unavailable</span>`}
            <small>Block ${event.block.toLocaleString("en-US")}</small>
          </div>
          <div class="activity-copy">
            <strong>${escapeHtml(event.label)}</strong>
            <span>${escapeHtml(copy.summary)}</span>
            ${copy.note ? `<small>${escapeHtml(copy.note)}</small>` : ""}
          </div>
          <a href="${escapeHtml(transactionUrl)}" target="_blank" rel="noreferrer" aria-label="View ${escapeHtml(event.label)} transaction">↗</a>
        </li>`;
  }).join("")}
    </ol>
  </section>`;
}

function renderPosition(position, snapshotTimestamp) {
  const { calculation, projection } = position;
  const isZombie = position.status === "zombie";
  const isLiquidated = position.status === "liquidated";
  const isClosed = ["closed", "liquidated"].includes(position.status);
  const openPps = priceRawToDisplayWad(
    position.openPrice,
    position.collateralDecimals,
    position.borrowDecimals,
  );
  const currentPps = priceRawToDisplayWad(
    position.currentPrice,
    position.collateralDecimals,
    position.borrowDecimals,
  );
  const finalAnnualInterestRate = position.rateAdjustments.at(-1)?.annualInterestRate
    ?? position.open.annualInterestRate;
  const currentBorrowApr = ((isClosed ? finalAnnualInterestRate : position.current.annualInterestRate) * WAD)
    / pow10(position.borrowDecimals);
  const openingBorrowApr = (position.open.annualInterestRate * WAD)
    / pow10(position.borrowDecimals);
  const baselineLabel = calculation.cleanOpenBaseline
    ? position.liquidations?.length
      ? "Debt, seized collateral, owner proceeds and any written-off debt reconcile through liquidation"
      : isClosed
      ? `Opening state reconciles through ${position.redemptions.length} redemption${position.redemptions.length === 1 ? "" : "s"} and the final ${position.closeout.eventName} settlement`
      : isZombie
        ? `${position.redemptions.length} redemptions reconcile; remaining collateral is available to close`
        : position.redemptions.length
          ? `Opening collateral and principal reconcile through ${position.redemptions.length} redemption${position.redemptions.length === 1 ? "" : "s"}; historical PPS and fees are included`
          : "Opening collateral and principal reconcile; rate changes and their fees are included"
    : position.accountingIssue ?? "Position history is incomplete";
  const formula = projection?.apr !== null && projection?.apr !== undefined
    ? `${formatMoney(calculation.currentCollateralValue, position.borrowDecimals)} × ${formatPercent(projection.apr)} − ${formatMoney(calculation.currentDebt, position.borrowDecimals)} × ${formatPercent(currentBorrowApr)}`
    : "Unavailable until a projection source has data.";
  const elapsedPeriod = formatElapsedPeriod(calculation.elapsedSeconds);
  const annualizationFormula = calculation.usesDietz
    ? "Modified Dietz: P&L ÷ time-weighted invested capital, compounded to one year; fees included once"
    : `(1 + ${formatPercent(calculation.recurringReturnOnInitialCapital, 4)})^(365 days / ${elapsedPeriod}) − ${formatPercent(calculation.oneTimeFeeRate, 4)} one-time fees`;
  const blockExplorer = `https://eth.blockscout.com/address/${position.manager}`;
  const transactionExplorer = `https://eth.blockscout.com/tx/${position.openTransaction}`;
  const latestRedemption = position.redemptions.at(-1);
  const redemptionExplorer = latestRedemption
    ? `https://eth.blockscout.com/tx/${latestRedemption.transactionHash}`
    : null;
  const closeoutExplorer = position.closeout
    ? `https://eth.blockscout.com/tx/${position.closeout.transactionHash}`
    : null;
  const statusLabel = isClosed
    ? `${isLiquidated ? "Liquidated" : "Closed"} · block ${position.closeout.block.toLocaleString("en-US")}`
    : isZombie
      ? `Redeemed · closeout available · block ${snapshotTimestamp.block.toLocaleString("en-US")}`
      : `${position.liquidations?.length ? "Active · partially liquidated" : "Active"} · block ${snapshotTimestamp.block.toLocaleString("en-US")}`;
  const headlineValueLabel = isClosed
    ? "Final proceeds"
    : isZombie
      ? "Equity remaining"
      : "Current equity";
  const valuationLabel = isClosed ? "Final PPS" : "Current PPS";
  const valuationBlock = isClosed ? position.closeout.block : snapshotTimestamp.block;
  const totalBorrowCosts = calculation.accruedInterest === null
    || calculation.totalOneTimeFees === null
    ? null
    : calculation.accruedInterest + calculation.totalOneTimeFees;
  const troveId = String(position.troveId);
  const shortTroveId = troveId.length > 8 ? shorten(troveId, 4, 4) : troveId;
  const troveLabel = ` · ${position.collateralSymbol} Trove #${shortTroveId}`;
  const summaryValueLabel = isClosed ? "Final proceeds" : headlineValueLabel;
  const positionTitle = shorten(position.wallet, 8, 6);
  const positionKicker = `${position.collateralSymbol} / ${position.borrowSymbol}`;
  const summaryKicker = `${position.collateralSymbol} · Trove #${shortTroveId}`;

  return `
    <article class="position is-${escapeHtml(position.status)}" data-position="${position.key}">
      <button
        class="position-summary"
        type="button"
        data-open-position="${position.key}"
        data-statement-kicker="${escapeHtml(`${positionTitle}${troveLabel}`)}"
        data-statement-title="${escapeHtml(positionKicker)}"
        data-statement-status="${escapeHtml(statusLabel)}"
        data-statement-state="${escapeHtml(position.status)}"
        aria-controls="trove-statement-panel"
        aria-haspopup="dialog"
      >
          <span class="position-summary-identity">
            <span class="eyebrow">${escapeHtml(summaryKicker)}</span>
            <span class="position-summary-title">${escapeHtml(position.collateralSymbol)} / ${escapeHtml(position.borrowSymbol)}</span>
          </span>
          <span class="position-summary-financials" aria-label="${escapeHtml(position.status)} Trove summary">
            <span><small>Initial deposit</small><strong>${escapeHtml(formatMoney(calculation.initialCapitalBeforeFee, position.borrowDecimals, position.borrowSymbol))}</strong></span>
            <span><small>${escapeHtml(summaryValueLabel)}</small><strong>${escapeHtml(formatMoney(calculation.endingValue, position.borrowDecimals, position.borrowSymbol))}</strong></span>
            <span><small>Trove P&amp;L</small><strong>${escapeHtml(formatSignedMoney(calculation.pnl, position.borrowDecimals, position.borrowSymbol))}</strong></span>
          </span>
          <span class="position-summary-status">
            <span class="position-state"><span class="live-dot"></span>${escapeHtml(statusLabel)}</span>
            <span class="disclosure-label">
              <span>View statement</span>
              <span class="disclosure-symbol" aria-hidden="true"></span>
            </span>
          </span>
      </button>
      <template data-position-statement="${position.key}">
        <div class="position-expanded">

      <dl class="headline-metrics">
        ${renderMetric("Initial deposit", formatMoney(calculation.initialCapitalBeforeFee, position.borrowDecimals, position.borrowSymbol))}
        ${renderMetric(headlineValueLabel, formatMoney(calculation.endingValue, position.borrowDecimals, position.borrowSymbol))}
        ${renderMetric("Trove P&L", formatSignedMoney(calculation.pnl, position.borrowDecimals, position.borrowSymbol))}
        ${renderMetric(calculation.usesDietz ? "Annualized Modified Dietz" : "Annualized return", formatPercent(calculation.feeAdjustedAnnualizedReturn))}
      </dl>

      <section class="position-summary-section" aria-labelledby="${position.key}-summary">
        <header class="section-heading">
          <h3 id="${position.key}-summary">Position Summary</h3>
        </header>
        <ol class="statement-rows">
          ${renderStatementRow("Initial deposit", "opening collateral value − borrowed principal", formatMoney(calculation.initialCapitalBeforeFee, position.borrowDecimals, position.borrowSymbol))}
          ${renderStatementRow("Assets borrowed", "OpenTrove", formatMoney(position.open.borrowed, position.borrowDecimals, position.borrowSymbol), { detail: true })}
          ${calculation.hasCapitalFlows ? renderStatementRow("Additional borrowed principal", "nominal debt issued, not verified wallet proceeds", formatMoney(calculation.additionalBorrowed, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${position.repayments?.length ? renderStatementRow("Debt repaid", "actual Repay amounts; excludes redemptions and closeout", formatMoney(calculation.repaidDebt, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${position.collateralChanges?.length ? renderStatementRow("Net collateral added", "deposits − withdrawals valued at event PPS", formatSignedMoney(calculation.netCollateralAddedValue, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${calculation.hasCapitalFlows ? renderStatementRow("Net capital added", "collateral deposits − withdrawals + repayments − additional borrowing", formatSignedMoney(calculation.netCapitalAdded, position.borrowDecimals, position.borrowSymbol)) : ""}
          ${renderStatementRow("Collateral deposited", "OpenTrove", `${formatUnits(position.open.collateral, position.collateralDecimals, 4)} ${position.collateralSymbol}`, { detail: true })}
          ${renderStatementRow("PPS value change", "value earned while each share balance was held", formatSignedMoney(calculation.collateralValueChange, position.borrowDecimals, position.borrowSymbol))}
          ${renderStatementRow("Opening PPS", `block ${position.openBlock.toLocaleString("en-US")}`, `${formatUnits(openPps, 18, 6)} ${position.borrowSymbol}`, { detail: true })}
          ${renderStatementRow(valuationLabel, `block ${valuationBlock.toLocaleString("en-US")}`, `${formatUnits(currentPps, 18, 6)} ${position.borrowSymbol}`, { detail: true })}
          ${renderStatementRow("Borrow costs and fees", "interest plus one-time fees", formatSignedMoney(totalBorrowCosts === null ? null : -totalBorrowCosts, position.borrowDecimals, position.borrowSymbol))}
          ${renderStatementRow("Opening fee", "upfrontFee recorded by OpenTrove", formatSignedMoney(calculation.upfrontFee === null ? null : -calculation.upfrontFee, position.borrowDecimals, position.borrowSymbol), { detail: true })}
          ${position.rateAdjustments.length ? renderStatementRow("Rate adjustment fees", `${position.rateAdjustments.length} AdjustInterestRate event${position.rateAdjustments.length === 1 ? "" : "s"}`, formatSignedMoney(calculation.rateAdjustmentFees === null ? null : -calculation.rateAdjustmentFees, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${position.borrowings?.length ? renderStatementRow("Additional borrowing fees", "Borrow upfront fees", formatSignedMoney(-calculation.additionalBorrowFees, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${renderStatementRow("Accrued borrow interest", "remaining + redeemed + repaid + liquidated + written-off + closed debt − all principal − all fees", formatSignedMoney(calculation.accruedInterest === null ? null : -calculation.accruedInterest, position.borrowDecimals, position.borrowSymbol), { detail: true })}
          ${position.liquidations?.length ? renderStatementRow("Liquidation impact", "debt repaid + debt written off − seized collateral at event PPS", formatSignedMoney(calculation.liquidationImpact, position.borrowDecimals, position.borrowSymbol)) : ""}
          ${position.liquidations?.length ? renderStatementRow("Liquidator debt repayment", "LiquidateTrove; excludes owner contributions", formatMoney(calculation.liquidationDebtRepaid, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${calculation.badDebtWrittenOff > 0n ? renderStatementRow("Debt written off", "BadDebt; lender loss, not an owner payment", formatMoney(calculation.badDebtWrittenOff, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${calculation.badDebtWrittenOff > 0n ? renderStatementRow("Loss absorbed by protocol fees", "part of the write-off, not an additional debt reduction", formatMoney(calculation.badDebtAbsorbedByFees, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${position.redemptions.length ? renderStatementRow("Redemption impact", "debt cancelled − redeemed collateral at event PPS", formatSignedMoney(calculation.redemptionImpact, position.borrowDecimals, position.borrowSymbol, 6)) : ""}
          ${position.redemptions.length ? renderStatementRow("Collateral redeemed", `${position.redemptions.length} RedeemTrove event${position.redemptions.length === 1 ? "" : "s"}`, `${formatUnits(calculation.redeemedCollateral, position.collateralDecimals, 4)} ${position.collateralSymbol}`, { detail: true }) : ""}
          ${position.redemptions.length ? renderStatementRow("Debt cancelled", "RedeemTrove", formatMoney(calculation.redeemedDebt, position.borrowDecimals, position.borrowSymbol), { detail: true }) : ""}
          ${isClosed ? "" : renderStatementRow(isZombie ? "Remaining position" : "Current position", isZombie ? "claimable collateral less canonical debt" : "current collateral value − canonical debt", formatMoney(calculation.endingValue, position.borrowDecimals, position.borrowSymbol))}
          ${isClosed ? "" : renderStatementRow(isZombie ? "Collateral claimable" : "Collateral", "current Trove state", `${formatUnits(position.current.collateral, position.collateralDecimals, 4)} ${position.collateralSymbol}`, { detail: true })}
          ${isClosed ? "" : renderStatementRow(isZombie ? "Claimable value" : "Collateral value", `PPS at block ${valuationBlock.toLocaleString("en-US")}`, formatMoney(calculation.currentCollateralValue, position.borrowDecimals, position.borrowSymbol), { detail: true })}
          ${isClosed ? "" : renderStatementRow("Canonical debt", "get_trove_debt_after_interest", formatMoney(calculation.currentDebt, position.borrowDecimals, position.borrowSymbol), { detail: true })}
          ${isClosed ? "" : renderStatementRow("LTV", "canonical debt ÷ collateral value", formatPercent(calculation.ltv), { detail: true })}
          ${isClosed ? "" : renderStatementRow("Effective leverage", "collateral value ÷ current equity", calculation.leverage === null ? "Unavailable" : `${formatUnits(calculation.leverage, 18, 2)}×`, { detail: true })}
          ${isClosed ? "" : renderStatementRow("Current borrow APR", position.rateAdjustments.length ? `opened at ${formatPercent(openingBorrowApr)} · ${position.rateAdjustments.length} rate change${position.rateAdjustments.length === 1 ? "" : "s"}` : "unchanged since opening", formatPercent(currentBorrowApr), { detail: true })}
          ${renderStatementRow(isClosed ? "Final proceeds" : "Current equity", calculation.hasCapitalFlows ? "initial capital + net capital added + total P&L" : "initial capital + total P&L", formatMoney(calculation.endingValue, position.borrowDecimals, position.borrowSymbol), { result: true })}
        </ol>

        <div class="statement-total">
          <span>Trove P&amp;L after interest and fees</span>
          <strong>${formatSignedMoney(calculation.pnl, position.borrowDecimals, position.borrowSymbol)}</strong>
        </div>
      </section>

      <p class="accounting-note">Trove P&amp;L values collateral at PPS and borrowing at face value. Borrow settlement differences are shown separately below. Swaps, gas, and transfers outside the Trove are excluded.</p>
      ${calculation.usesDietz ? `<p class="accounting-note">Modified Dietz weights contributions and withdrawals by time invested. ${calculation.dietz ? "Fees are included once; annualization extrapolates this observed period." : "Return unavailable: flow timing or positive invested capital could not be established."}</p>` : ""}
      ${renderFunding(position)}
      ${renderTimeline(position)}

      ${isClosed ? "" : `<section class="projection-section" aria-labelledby="${position.key}-projection">
        <header class="section-heading">
          <h3 id="${position.key}-projection">Forward Estimates</h3>
        </header>

        <dl class="projection-metrics">
          ${renderMetric(calculation.usesDietz ? "Annualized Modified Dietz" : "Annualized return on initial capital", formatPercent(calculation.feeAdjustedAnnualizedReturn), `${elapsedPeriod} since-open sample; fees included once`)}
          ${renderMetric("Projected equity APR", formatPercent(calculation.equityApr), projection.label)}
          ${renderMetric("Projected net carry", calculation.annualNetCarry === null ? "Unavailable" : `${formatMoney(calculation.annualNetCarry, position.borrowDecimals, position.borrowSymbol)} / yr`, "income − current borrowing cost")}
          ${renderMetric("Projection source", projection.label, projection.note || (projection.mode === "automatic" ? "Selected automatically by source priority" : "Explicit source; no fallback"))}
          ${renderMetric("Source APY", formatPercent(projection.apy), "net annual percentage yield")}
          ${renderMetric("Projection APR", formatPercent(projection.apr), "APY converted to APR assuming 52 compounding periods per year")}
          ${renderMetric("Projected spread", formatPercent(calculation.rateSpread), "selected net APR − current borrow APR")}
        </dl>

        <div class="formula">
          <span>Annual carry formula</span>
          <code>${escapeHtml(formula)}${calculation.annualNetCarry === null ? "" : ` = ${escapeHtml(formatMoney(calculation.annualNetCarry, position.borrowDecimals, position.borrowSymbol))}`}</code>
        </div>
        <div class="formula">
          <span>Since-open annualization</span>
          <code>${escapeHtml(annualizationFormula)} = ${escapeHtml(formatPercent(calculation.feeAdjustedAnnualizedReturn))}</code>
        </div>
      </section>`}

      <footer class="position-footer">
        <p><strong>${calculation.cleanOpenBaseline ? "Reconciled event history" : "Partial opening baseline"}</strong><span>${escapeHtml(baselineLabel)}</span></p>
        <nav aria-label="${escapeHtml(position.collateralSymbol)} sources">
          <a href="${blockExplorer}" target="_blank" rel="noreferrer">Trove manager ↗</a>
          <a href="${transactionExplorer}" target="_blank" rel="noreferrer">Open transaction ↗</a>
          ${redemptionExplorer ? `<a href="${redemptionExplorer}" target="_blank" rel="noreferrer">Latest redemption ↗</a>` : ""}
          ${closeoutExplorer ? `<a href="${closeoutExplorer}" target="_blank" rel="noreferrer">Closeout transaction ↗</a>` : ""}
          <a href="https://kong.yearn.fi/api/rest/snapshot/1/${position.collateralToken.toLowerCase()}" target="_blank" rel="noreferrer">Projection source ↗</a>
        </nav>
      </footer>
        </div>
      </template>
    </article>`;
}

function renderFunding(position) {
  const funding = position.funding;
  if (!funding) return "";
  const money = (value) => formatMoney(value, position.borrowDecimals, position.borrowSymbol, value > 0n && value < 10n ** BigInt(Math.max(0, position.borrowDecimals - 2)) ? position.borrowDecimals : 2);
  return `<section class="position-summary-section" aria-label="Borrow settlement">
    <header class="section-heading"><h3>Borrow settlement</h3></header>
    <p class="accounting-note">Proceeds belong to the borrowing caller, which may be an operator or router. Auction self-takes consume a claim for collateral without a cash payment. Pending proceeds are not treated as received.</p>
    <ol class="statement-rows">
      ${renderStatementRow("Cash paid to recipients", "immediate funding + auction token payouts", money(funding.cashPaid))}
      ${renderStatementRow("Claims used for collateral", "auction self-takes; non-cash settlement", money(funding.inKindCredit))}
      ${renderStatementRow("Pending auction proceeds", "unpaid target while collateral remains; recovery is not guaranteed", money(funding.pending))}
      ${renderStatementRow("Final funding shortfall", "unallocated principal + exhausted auction shortfalls", money(funding.shortfall))}
      ${renderStatementRow("Settlement-adjusted P&L", "Trove P&L + delivered funding − nominal principal; only after all funding is settled", formatSignedMoney(position.settlementAdjustedPnl, position.borrowDecimals, position.borrowSymbol), { result: true })}
    </ol>
    ${funding.issue ? `<p class="accounting-note">Settlement evidence unavailable: ${escapeHtml(funding.issue)}</p>` : ""}
    <ol class="activity-events">${funding.deliveries.map((event) => `<li>
      <a href="https://eth.blockscout.com/tx/${escapeHtml(event.transactionHash)}" target="_blank" rel="noreferrer">${event.kind === "openTrove" ? "Opening" : "Additional borrowing"} · ${escapeHtml(money(event.principal))} ↗</a>
      <p class="accounting-note">${escapeHtml(event.issue ?? `${event.complete ? "Settled" : "Pending"} · recipient ${event.recipient} · ${event.source}`)}</p>
      ${(event.auctions ?? []).map((auction) => `<p class="accounting-note">Auction #${escapeHtml(auction.id)}: ${escapeHtml(money(auction.credited))} credited, ${escapeHtml(money(auction.pending))} pending, ${escapeHtml(money(auction.shortfall))} shortfall.</p>`).join("")}
    </li>`).join("")}</ol>
  </section>`;
}

function renderWalletGroups(positions, snapshotTimestamp) {
  return groupPositionsByWallet(positions).map((group) => {
    const openCount = group.positions.filter((position) => !["closed", "liquidated"].includes(position.status)).length;
    const closedCount = group.positions.length - openCount;
    const groupId = `wallet-${group.wallet.toLowerCase()}`;
    const counts = [
      `${openCount} open`,
      ...(closedCount ? [`${closedCount} closed`] : []),
    ].join(" · ");

    return `
      <section class="wallet-group" aria-labelledby="${escapeHtml(groupId)}">
        <header class="wallet-group-header">
          <div>
            <p class="eyebrow">Wallet</p>
            <h2 id="${escapeHtml(groupId)}"><svg class="wallet-heading-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M16.583 11.09c-1.518 0-2.75 1.223-2.75 2.728 0 1.506 1.232 2.728 2.75 2.728 1.519 0 2.75-1.222 2.75-2.728 0-1.505-1.231-2.727-2.75-2.727Zm-.916 2.728c0-.501.41-.909.916-.909s.917.408.917.91c0 .5-.41.908-.917.908a.914.914 0 0 1-.916-.909Z" fill="currentColor" /><path fill-rule="evenodd" clip-rule="evenodd" d="M2.833 4.727c0-.501.411-.909.917-.909h16.5a.913.913 0 0 0 .917-.909c0-.502-.41-.909-.917-.909H3.75C2.232 2 1 3.222 1 4.727v12.727C1 19.965 3.052 22 5.583 22H20.25c1.518 0 2.75-1.222 2.75-2.727V8.363c0-1.505-1.232-2.727-2.75-2.727H3.75a.914.914 0 0 1-.917-.909Zm0 12.727V7.3c.287.1.596.156.917.156h16.5c.506 0 .917.407.917.909v10.909c0 .501-.411.909-.917.909H5.583c-1.518 0-2.75-1.221-2.75-2.727Z" fill="currentColor" /></svg><span>${escapeHtml(group.wallet)}</span></h2>
          </div>
          <p>${escapeHtml(`${group.positions.length} Trove${group.positions.length === 1 ? "" : "s"} · ${counts}`)}</p>
        </header>
        <div class="wallet-positions">
          ${group.positions
            .map((position, index) => {
              const startsClosedPositions = ["closed", "liquidated"].includes(position.status) && index > 0
                && !["closed", "liquidated"].includes(group.positions[index - 1].status);
              return `${startsClosedPositions ? '<h3 class="position-state-divider">Closed positions</h3>' : ""}${renderPosition(position, snapshotTimestamp)}`;
            })
            .join("")}
        </div>
      </section>`;
  }).join("");
}

function renderAggregate(positions) {
  const lifetime = aggregatePositions(positions);
  if (!lifetime) return "";
  const openPositions = positions.filter((position) => !["closed", "liquidated"].includes(position.status));
  const open = openPositions.length ? aggregatePositions(openPositions) : null;
  const closedCount = positions.length - openPositions.length;
  const activePositions = positions.filter((position) => position.status === "active");
  const active = aggregatePositions(activePositions);
  const settled = positions.every((position) => position.settlementAdjustedPnl != null);
  const settledPnl = settled ? positions.reduce((sum, position) => sum + position.settlementAdjustedPnl, 0n) : null;
  const fundingKnown = positions.every((position) => position.funding?.known);
  const fundingShortfall = fundingKnown ? positions.reduce((sum, position) => sum + position.funding.shortfall, 0n) : null;
  return `
    <section class="aggregate" aria-labelledby="aggregate-title">
      <header><p class="eyebrow">${positions.length} Trove histories · ${openPositions.length} open</p><h2 id="aggregate-title">Reconciled Position Statistics</h2></header>
      <dl class="aggregate-headlines">
        ${renderMetric("Open Equity", open ? formatMoney(open.endingValue, open.borrowDecimals, open.borrowSymbol) : "None", closedCount ? `${closedCount} closed Trove${closedCount === 1 ? "" : "s"} excluded` : "current positions only")}
        ${renderMetric("Active P&L", active ? formatSignedMoney(active.pnl, active.borrowDecimals, active.borrowSymbol) : "None", active ? `${active.pnlPositionCount}/${activePositions.length} active histories reconciled` : "no active Troves")}
        ${renderMetric("Lifetime P&L", formatSignedMoney(lifetime.pnl, lifetime.borrowDecimals, lifetime.borrowSymbol), `${lifetime.pnlPositionCount}/${positions.length} histories reconciled`)}
      </dl>
      <details class="aggregate-details">
        <summary>Return breakdown</summary>
        <dl class="aggregate-rows">
        ${renderMetric("Settlement-adjusted P&L", formatSignedMoney(settledPnl, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        ${renderMetric("Final funding shortfall", formatMoney(fundingShortfall, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        ${renderMetric("Lifetime PPS value change", formatSignedMoney(lifetime.collateralValueChange, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        ${renderMetric("Lifetime interest accrued", formatSignedMoney(lifetime.accruedInterest === null ? null : -lifetime.accruedInterest, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        ${renderMetric("Debt cancelled", formatMoney(lifetime.redeemedDebt, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        ${renderMetric("Redemption impact", formatSignedMoney(lifetime.redemptionImpact, lifetime.borrowDecimals, lifetime.borrowSymbol, 6))}
        ${positions.some((position) => position.liquidations?.length) ? renderMetric("Liquidation impact", formatSignedMoney(lifetime.liquidationImpact, lifetime.borrowDecimals, lifetime.borrowSymbol)) : ""}
        ${positions.some((position) => position.calculation.badDebtWrittenOff > 0n) ? renderMetric("Debt written off", formatMoney(lifetime.badDebtWrittenOff, lifetime.borrowDecimals, lifetime.borrowSymbol)) : ""}
        ${renderMetric("Opening fees", formatSignedMoney(lifetime.upfrontFee === null ? null : -lifetime.upfrontFee, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        ${positions.some((position) => position.borrowings?.length) ? renderMetric("Additional borrowing fees", formatSignedMoney(lifetime.additionalBorrowFees === null ? null : -lifetime.additionalBorrowFees, lifetime.borrowDecimals, lifetime.borrowSymbol)) : ""}
        ${renderMetric("Rate adjustment fees", formatSignedMoney(lifetime.rateAdjustmentFees === null ? null : -lifetime.rateAdjustmentFees, lifetime.borrowDecimals, lifetime.borrowSymbol))}
        </dl>
      </details>
  </section>`;
}

const normalizeWallets = (wallets) => [...new Set(wallets
  .filter((wallet) => typeof wallet === "string" && ETHEREUM_ADDRESS.test(wallet))
  .map((wallet) => wallet.toLowerCase()))]
  .sort();

function saveWalletPreferences(wallets, selectedWallets) {
  window.localStorage.setItem(WALLETS_STORAGE_KEY, JSON.stringify({
    wallets,
    selectedWallets: [...selectedWallets].filter((wallet) => wallets.includes(wallet)),
  }));
}

async function requestTrackedWallets(method = "GET", address, selection) {
  const stored = window.localStorage.getItem(WALLETS_STORAGE_KEY);
  const saved = stored === null ? [] : JSON.parse(stored);
  // Older versions stored only the wallet array and showed every tracked wallet.
  const wallets = Array.isArray(saved) ? saved : saved?.wallets;
  if (!Array.isArray(wallets)) throw new Error("Saved wallet list is invalid");
  const normalized = normalizeWallets(wallets);
  const savedSelection = Array.isArray(saved) ? normalized : saved.selectedWallets;
  const selectedWallets = Array.isArray(savedSelection)
    ? normalizeWallets(savedSelection).filter((wallet) => normalized.includes(wallet))
    : normalized;
  if (method === "GET") return { wallets: normalized, selectedWallets, changed: false };

  if (!ETHEREUM_ADDRESS.test(address)) {
    throw new Error("Enter a valid 0x-prefixed Ethereum address");
  }
  const normalizedAddress = address.toLowerCase();
  const nextWallets = method === "POST"
    ? [...new Set([...normalized, normalizedAddress])].sort()
    : normalized.filter((wallet) => wallet !== normalizedAddress);
  const nextSelection = new Set(selection ?? selectedWallets);
  if (method === "POST") nextSelection.add(normalizedAddress);
  else nextSelection.delete(normalizedAddress);
  const nextSelectedWallets = [...nextSelection].filter((wallet) => nextWallets.includes(wallet));
  saveWalletPreferences(nextWallets, nextSelectedWallets);
  return {
    wallets: nextWallets,
    selectedWallets: nextSelectedWallets,
    changed: nextWallets.length !== normalized.length,
  };
}

export function mountFlexPositionTracker(root) {
  const positionsRoot = root.querySelector("[data-positions]");
  const summaryRoot = root.querySelector("[data-summary]");
  const status = root.querySelector("[data-status]");
  const refreshButton = root.querySelector("[data-refresh]");
  const projectionSelect = root.querySelector("[data-projection-source]");
  const walletManagerToggle = root.querySelector("[data-wallet-manager-toggle]");
  const walletManager = root.querySelector("[data-wallet-manager]");
  const walletForm = root.querySelector("[data-wallet-form]");
  const walletInput = root.querySelector("[data-wallet-input]");
  const walletList = root.querySelector("[data-wallet-list]");
  const walletMessages = root.querySelectorAll("[data-wallet-message]");
  const statementLayer = root.querySelector("[data-statement-layer]");
  const statementPanel = root.querySelector("[data-statement-panel]");
  const statementContent = root.querySelector("[data-statement-content]");
  const statementKicker = root.querySelector("[data-statement-kicker]");
  const statementTitle = root.querySelector("[data-statement-title]");
  const statementStatus = root.querySelector("[data-statement-status]");
  const statementExportToggle = root.querySelector("[data-statement-export-toggle]");
  const statementExportOptions = root.querySelector("[data-statement-export-options]");
  let controller = null;
  let activeStatementTrigger = null;
  let closeTimer = null;
  let previousPageOverflow = "";
  let trackedWallets = [];
  let selectedWallets = new Set();
  let positionGroups = [];
  let snapshot = null;
  let loadError = null;

  const closeExportOptions = ({ restoreFocus = false } = {}) => {
    statementExportOptions.hidden = true;
    statementExportToggle.setAttribute("aria-expanded", "false");
    if (restoreFocus) statementExportToggle.focus({ preventScroll: true });
  };

  const toggleExportOptions = () => {
    const willOpen = statementExportOptions.hidden;
    statementExportOptions.hidden = !willOpen;
    statementExportToggle.setAttribute("aria-expanded", String(willOpen));
    if (willOpen) {
      statementExportOptions.querySelector("button")?.focus({ preventScroll: true });
    }
  };

  const currentStatementDocument = () => buildFlexStatementDocument({
    title: statementTitle.textContent.trim(),
    kicker: statementKicker.textContent.trim(),
    status: statementStatus.textContent.trim(),
    contentHtml: statementContent.innerHTML,
  });

  const exportStatementHtml = () => {
    const documentHtml = currentStatementDocument();
    const filename = statementExportFilename({
      title: statementTitle.textContent,
      kicker: statementKicker.textContent,
    }, "html");
    const url = URL.createObjectURL(new Blob([documentHtml], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };

  const exportStatementPdf = () => {
    const printWindow = window.open("", "_blank");
    if (!printWindow) {
      statementExportToggle.textContent = "Popup blocked";
      window.setTimeout(() => {
        statementExportToggle.textContent = "Export";
      }, 2_000);
      return;
    }

    printWindow.opener = null;
    printWindow.document.open();
    printWindow.document.write(currentStatementDocument());
    printWindow.document.close();
    printWindow.focus();
    window.setTimeout(() => printWindow.print(), 150);
  };

  const finishStatementClose = ({ restoreFocus = true } = {}) => {
    closeExportOptions();
    statementLayer.hidden = true;
    statementContent.replaceChildren();
    activeStatementTrigger?.closest(".position")?.classList.remove("is-selected");
    if (restoreFocus) activeStatementTrigger?.focus({ preventScroll: true });
    activeStatementTrigger = null;
  };

  const closeStatement = ({ immediate = false, restoreFocus = true } = {}) => {
    if (statementLayer.hidden) return;
    clearTimeout(closeTimer);
    statementLayer.classList.remove("is-open");
    document.documentElement.style.overflow = previousPageOverflow;
    if (immediate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishStatementClose({ restoreFocus });
      return;
    }
    closeTimer = window.setTimeout(() => finishStatementClose({ restoreFocus }), 220);
  };

  const openStatement = (trigger) => {
    const key = trigger.dataset.openPosition;
    const template = [...positionsRoot.querySelectorAll("template[data-position-statement]")]
      .find((candidate) => candidate.dataset.positionStatement === key);
    if (!(template instanceof HTMLTemplateElement)) return;

    clearTimeout(closeTimer);
    closeExportOptions();
    activeStatementTrigger?.closest(".position")?.classList.remove("is-selected");
    activeStatementTrigger = trigger;
    trigger.closest(".position")?.classList.add("is-selected");
    statementKicker.textContent = trigger.dataset.statementKicker;
    statementTitle.textContent = trigger.dataset.statementTitle;
    statementStatus.className = `position-state is-state-${trigger.dataset.statementState}`;
    statementStatus.innerHTML = `<span class="live-dot"></span>${escapeHtml(trigger.dataset.statementStatus)}`;
    statementContent.replaceChildren(template.content.cloneNode(true));
    previousPageOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    statementLayer.hidden = false;
    window.requestAnimationFrame(() => {
      statementLayer.classList.add("is-open");
      statementPanel.querySelector("[data-statement-close]")?.focus({ preventScroll: true });
    });
  };

  const trapStatementFocus = (event) => {
    if (statementLayer.hidden) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!statementExportOptions.hidden) {
        closeExportOptions({ restoreFocus: true });
        return;
      }
      closeStatement();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = [...statementPanel.querySelectorAll("a[href], button:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!statementPanel.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const setLoading = (loading) => {
    root.dataset.loading = loading ? "true" : "false";
    refreshButton.disabled = loading;
    refreshButton.textContent = loading ? "Reading chain…" : "Refresh now";
  };

  const setWalletManagerBusy = (busy) => {
    walletInput.disabled = busy;
    walletForm.querySelector("button").disabled = busy;
    for (const button of walletList.querySelectorAll("button")) button.disabled = busy;
  };

  const syncWalletSelection = () => {
    const allCheckbox = walletList.querySelector('[value="all"]');
    allCheckbox.checked = trackedWallets.length > 0 && selectedWallets.size === trackedWallets.length;
    allCheckbox.indeterminate = selectedWallets.size > 0 && selectedWallets.size < trackedWallets.length;
    allCheckbox.disabled = trackedWallets.length === 0;
    for (const checkbox of walletList.querySelectorAll('input:not([value="all"])')) {
      checkbox.checked = selectedWallets.has(checkbox.value);
    }
  };

  const renderTrackedWallets = (preferredSelection = selectedWallets) => {
    positionGroups = buildPositionGroups(trackedWallets);
    selectedWallets = new Set([...preferredSelection].filter((wallet) => trackedWallets.includes(wallet)));
    walletList.innerHTML = `<li>
        <label>
          <input type="checkbox" value="all" />
          <span>All tracked wallets</span>
        </label>
      </li>` + (trackedWallets.length
      ? trackedWallets.map((wallet) => `<li>
          <label>
            <input type="checkbox" value="${escapeHtml(wallet)}" />
            <code>${escapeHtml(wallet)}</code>
          </label>
          <button type="button" data-remove-wallet="${escapeHtml(wallet)}" aria-label="Remove ${escapeHtml(wallet)}">Remove</button>
        </li>`).join("")
      : "<li class=\"is-empty\">No addresses are being tracked.</li>");
    syncWalletSelection();
  };

  const setWalletMessage = (message, state = "") => {
    for (const walletMessage of walletMessages) {
      walletMessage.textContent = walletManager.contains(walletMessage) === walletManager.open ? message : "";
      walletMessage.className = `wallet-manager-message${state ? ` is-${state}` : ""}`;
    }
  };

  const renderSelectedPositions = () => {
    closeStatement({ immediate: true, restoreFocus: false });
    summaryRoot.innerHTML = "";
    const showEmpty = (title, detail, message) => {
      positionsRoot.innerHTML = `<div class="tracker-empty"><strong>${title}</strong><span>${detail}</span></div>`;
      status.textContent = message;
      status.className = "tracker-status is-ready";
    };
    if (!trackedWallets.length) {
      showEmpty("No tracked addresses.", "Add an Ethereum address, then choose Refresh now.", "No addresses are being tracked.");
      return;
    }
    if (!selectedWallets.size) {
      showEmpty("No wallets selected.", "Select wallets in Manage addresses to show their Troves.", "No wallets are selected.");
      return;
    }
    if (!snapshot) {
      if (loadError) {
        positionsRoot.innerHTML = `<div class="tracker-error"><strong>Live reads are unavailable.</strong><span>${escapeHtml(loadError.message)}</span><button type="button" data-retry>Try again</button></div>`;
        positionsRoot.querySelector("[data-retry]")?.addEventListener("click", refresh);
        status.textContent = "No zero values were substituted. Retry when the public data sources recover.";
        status.className = "tracker-status is-error";
      } else {
        if (root.dataset.loading === "true") {
          showEmpty("Reading live positions…", "Results will appear for the selected wallets.", "Reading one Ethereum block and Kong’s projection data…");
        } else {
          showEmpty("Selected wallets need a refresh.", "Choose Refresh now to load their Troves.", "No data has been loaded for the selected wallets.");
        }
        status.className = "tracker-status is-pending";
      }
      return;
    }
    const { block, timestamp } = snapshot;
    const positions = snapshot.positions.filter((position) => selectedWallets.has(position.wallet.toLowerCase()));
    const missingWallets = [...selectedWallets].filter((wallet) => !snapshot.wallets.includes(wallet));
    summaryRoot.innerHTML = renderAggregate(positions);
    positionsRoot.innerHTML = positions.length
      ? renderWalletGroups(positions, { block, timestamp })
      : missingWallets.length
        ? '<div class="tracker-empty"><strong>Selected wallets need a refresh.</strong><span>Choose Refresh now to load their Troves.</span></div>'
        : '<div class="tracker-empty"><strong>No Troves found.</strong><span>The selected wallets have no history in the configured Flex markets.</span></div>';
    const walletCount = new Set(positions.map((position) => position.wallet.toLowerCase())).size;
    status.textContent = `Updated ${formatDate(timestamp, true)} from Ethereum block ${block.toLocaleString("en-US")}. Showing ${positions.length} Trove histor${positions.length === 1 ? "y" : "ies"} across ${walletCount} wallet${walletCount === 1 ? "" : "s"}.`;
    const pending = [];
    if (root.dataset.loading === "true") pending.push("Refreshing live data…");
    if (missingWallets.length) pending.push(`${missingWallets.length} selected wallet${missingWallets.length === 1 ? " needs" : "s need"} Refresh now to load data; totals include loaded wallets only.`);
    if (snapshot.projectionSource !== projectionSelect.value) pending.push("Choose Refresh now to apply the changed projection rate.");
    status.textContent += pending.length ? ` ${pending.join(" ")}` : " Wallet filters use loaded data; Refresh now fetches fresh data.";
    status.className = `tracker-status ${pending.length ? "is-pending" : "is-ready"}`;
  };

  const refresh = async () => {
    controller?.abort();
    const requestController = new AbortController();
    controller = requestController;
    if (!trackedWallets.length || !selectedWallets.size) {
      setLoading(false);
      renderSelectedPositions();
      return;
    }
    const wallets = [...trackedWallets];
    const projectionSource = projectionSelect.value;
    setLoading(true);
    loadError = null;
    renderSelectedPositions();
    try {
      const result = await fetchFlexPositionSnapshot({
        groups: positionGroups,
        projectionSource,
        signal: requestController.signal,
      });
      if (requestController.signal.aborted) return;
      snapshot = { ...result, wallets, projectionSource };
    } catch (error) {
      if (requestController.signal.aborted) return;
      snapshot = null;
      loadError = error;
    } finally {
      if (controller === requestController) {
        setLoading(false);
        renderSelectedPositions();
      }
    }
  };

  const updateTrackedWallet = async (method, address) => {
    setWalletManagerBusy(true);
    setWalletMessage(method === "POST" ? "Adding address…" : "Removing address…");
    try {
      const result = await requestTrackedWallets(method, address, selectedWallets);
      trackedWallets = result.wallets;
      renderTrackedWallets(result.selectedWallets);
      const action = method === "POST" ? "added" : "removed";
      setWalletMessage(
        result.changed ? `Address ${action}.` : `Address was already ${method === "POST" ? "tracked" : "absent"}.`,
        "ready",
      );
      renderSelectedPositions();
      if (method === "POST") walletInput.value = "";
    } catch (error) {
      setWalletMessage(error.message, "error");
    } finally {
      setWalletManagerBusy(false);
    }
  };

  refreshButton.addEventListener("click", refresh);
  walletList.addEventListener("change", (event) => {
    if (!(event.target instanceof HTMLInputElement) || event.target.type !== "checkbox") return;
    const { value, checked } = event.target;
    const nextSelection = value === "all"
      ? new Set(checked ? trackedWallets : [])
      : new Set(selectedWallets);
    if (value !== "all") {
      if (checked) nextSelection.add(value);
      else nextSelection.delete(value);
    }
    try {
      saveWalletPreferences(trackedWallets, nextSelection);
      selectedWallets = nextSelection;
      setWalletMessage("");
      renderSelectedPositions();
    } catch (error) {
      setWalletMessage(`Could not save wallet selection: ${error.message}. Selection unchanged.`, "error");
    }
    syncWalletSelection();
  });
  projectionSelect.addEventListener("change", renderSelectedPositions);
  walletManagerToggle.addEventListener("click", () => {
    walletManager.showModal();
    walletManagerToggle.setAttribute("aria-expanded", "true");
    walletList.querySelector("input")?.focus({ preventScroll: true });
  });
  walletManager.addEventListener("close", () => {
    walletManagerToggle.setAttribute("aria-expanded", "false");
  });
  walletForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const address = walletInput.value.trim().toLowerCase();
    if (!ETHEREUM_ADDRESS.test(address)) {
      setWalletMessage("Enter a valid 0x-prefixed Ethereum address.", "error");
      walletInput.focus();
      return;
    }
    updateTrackedWallet("POST", address);
  });
  walletList.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest("[data-remove-wallet]")
      : null;
    if (!(button instanceof HTMLButtonElement)) return;
    updateTrackedWallet("DELETE", button.dataset.removeWallet);
  });
  positionsRoot.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element
      ? event.target.closest("[data-open-position]")
      : null;
    if (trigger instanceof HTMLButtonElement) openStatement(trigger);
  });
  statementLayer.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest("[data-statement-close]")) {
      closeStatement();
      return;
    }
    if (event.target.closest("[data-statement-export-toggle]")) {
      toggleExportOptions();
      return;
    }
    const exportButton = event.target.closest("[data-statement-export]");
    if (exportButton instanceof HTMLButtonElement) {
      if (exportButton.dataset.statementExport === "html") exportStatementHtml();
      if (exportButton.dataset.statementExport === "pdf") exportStatementPdf();
      closeExportOptions({ restoreFocus: true });
      return;
    }
    if (!event.target.closest(".statement-export")) {
      closeExportOptions();
    }
  });
  document.addEventListener("keydown", trapStatementFocus);
  requestTrackedWallets()
    .then(({ wallets, selectedWallets: savedSelection }) => {
      trackedWallets = wallets;
      renderTrackedWallets(savedSelection);
    })
    .catch((error) => {
      trackedWallets = [];
      renderTrackedWallets(trackedWallets);
      setWalletMessage(`Saved wallet list unavailable: ${error.message}. No addresses loaded.`, "error");
    })
    .finally(refresh);
}
