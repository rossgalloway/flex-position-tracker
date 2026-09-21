import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPositionGroups,
  buildPositionTimeline,
  classifyTimelineRedemptions,
  FLEX_MARKETS,
  groupPositionsByWallet,
  POSITION_GROUPS,
  positionConfigsFromOpenLogs,
  sortPositionsForReport,
} from "./flexPositionTracker.js";

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const openTopic = "0x48cc6255485654cd31337a688b4a1e06f8a768af7ec431040b7015bbb57d44b7";
const addCollateralTopic = "0xda18d0b037712b628d658e8fb6f6701086c449aab7cefd33b9f7f95e3a3082b8";
const borrowTopic = "0xbf608caf5cc20aaeea74ecfce286b511362b0ecbaa0e56ded00f76f7e2e39c44";
const adjustRateTopic = "0xb5e5fe642ee69e311cafb018acb5d9c4f197ba54a1548f743148a6e717e5bf2a";
const redeemTopic = "0x06ba74d0ebb47a34a11d1eafef80d99a580c6e3644549cab6a04fdb357caf4cf";
const closeTopic = "0x964b676865fdc5f2f6264c1031ea231c957ef38127566ceb9f336ce1458c96a9";

const eventLog = ({ topic, block, logIndex, transactionHash, values }) => ({
  blockNumber: `0x${block.toString(16)}`,
  logIndex: `0x${logIndex.toString(16)}`,
  transactionHash,
  topics: [topic],
  data: `0x${values.map(word).join("")}`,
});

test("discovers every OpenTrove owned by a tracked wallet", () => {
  const wallet = "0x4449dd09067dcaA55C15F40b465A5173778f8100";
  const ownerTopic = `0x${wallet.slice(2).toLowerCase().padStart(64, "0")}`;
  const group = {
    key: "ysybold",
    wallet,
    manager: "0xmanager",
    discoveryFromBlock: 100,
    collateralSymbol: "ysyBOLD",
  };
  const logs = [
    {
      blockNumber: "0x66",
      logIndex: "0x2",
      topics: [openTopic, `0x${word(22)}`, ownerTopic],
    },
    {
      blockNumber: "0x64",
      logIndex: "0x1",
      topics: [openTopic, `0x${word(11)}`, ownerTopic],
    },
    {
      blockNumber: "0x65",
      logIndex: "0x1",
      topics: [openTopic, `0x${word(99)}`, `0x${"1".padStart(64, "0")}`],
    },
  ];

  const positions = positionConfigsFromOpenLogs(group, logs);

  assert.equal(positions.length, 2);
  assert.deepEqual(positions.map((position) => position.troveId), ["11", "22"]);
  assert.deepEqual(positions.map((position) => position.troveNumber), [1, 2]);
  assert.ok(positions.every((position) => position.troveCount === 2));
  assert.deepEqual(positions.map((position) => position.key), [
    "ysybold-100-1",
    "ysybold-102-2",
  ]);
});

test("tracks the yvcrvUSD-2 Flex market for the supplied wallet", () => {
  const wallet = "0xa7b6f3d18db39f65c8056d0892af76c07d15fc5a";
  const group = POSITION_GROUPS.find(({ marketKey, wallet: owner }) => (
    marketKey === "yvcrvusd2" && owner === wallet
  ));

  assert.deepEqual(group, {
    key: `yvcrvusd2-${wallet.slice(2)}`,
    marketKey: "yvcrvusd2",
    wallet,
    manager: "0x7582b47486F75F5D675f260d357972cD0DbEeA2E",
    discoveryFromBlock: 25821066,
    collateralToken: "0xBF319dDC2Edc1Eb6FDf9910E39b37Be221C8805F",
    collateralSymbol: "yvcrvUSD-2",
    collateralDecimals: 18,
    borrowSymbol: "USDC",
    borrowDecimals: 6,
  });
});

test("discovers the added wallet across every configured Flex market", () => {
  const wallet = "0x80c9ac867b2d36b7e8d74646e074c460a008c0cb";
  const groups = POSITION_GROUPS.filter((group) => group.wallet.toLowerCase() === wallet);

  assert.deepEqual(groups.map(({ marketKey }) => marketKey), ["ysybold", "yvusd", "yvcrvusd2"]);
  assert.deepEqual(groups.map(({ collateralSymbol }) => collateralSymbol), [
    "ysyBOLD",
    "yvUSD",
    "yvcrvUSD-2",
  ]);
  assert.equal(new Set(groups.map(({ manager }) => manager.toLowerCase())).size, 3);
  assert.equal(groups.find(({ marketKey }) => marketKey === "yvusd").discoveryFromBlock, 25690643);
});

test("builds every configured market from its deployment block for a new wallet", () => {
  const wallet = "0x1111111111111111111111111111111111111111";
  const groups = buildPositionGroups([wallet, wallet.toUpperCase().replace("0X", "0x"), "invalid"]);

  assert.equal(groups.length, FLEX_MARKETS.length);
  assert.deepEqual(groups.map(({ wallet: owner }) => owner), Array(FLEX_MARKETS.length).fill(wallet));
  assert.deepEqual(groups.map(({ discoveryFromBlock }) => discoveryFromBlock), [
    25740294,
    25690643,
    25821066,
  ]);
});

test("sorts open Troves by wallet address before closed Troves", () => {
  const positions = [
    { key: "closed-a7", status: "closed", wallet: "0xA7", collateralSymbol: "yvUSD", openBlock: 4, openLogIndex: 0 },
    { key: "open-a7-yvusd", status: "active", wallet: "0xA7", collateralSymbol: "yvUSD", openBlock: 3, openLogIndex: 0 },
    { key: "open-44", status: "active", wallet: "0x44", collateralSymbol: "ysyBOLD", openBlock: 2, openLogIndex: 0 },
    { key: "open-a7-crvusd", status: "active", wallet: "0xA7", collateralSymbol: "yvcrvUSD-2", openBlock: 1, openLogIndex: 0 },
    { key: "closed-44", status: "closed", wallet: "0x44", collateralSymbol: "ysyBOLD", openBlock: 5, openLogIndex: 0 },
  ];

  assert.deepEqual(sortPositionsForReport(positions).map(({ key }) => key), [
    "open-44",
    "open-a7-crvusd",
    "open-a7-yvusd",
    "closed-44",
    "closed-a7",
  ]);
  assert.equal(positions[0].key, "closed-a7");
});

test("groups Troves by wallet with open entries before closed entries", () => {
  const positions = [
    { key: "closed-a7", status: "closed", wallet: "0xA7", collateralSymbol: "yvUSD", openBlock: 4, openLogIndex: 0 },
    { key: "open-44", status: "active", wallet: "0x44", collateralSymbol: "ysyBOLD", openBlock: 2, openLogIndex: 0 },
    { key: "open-a7", status: "active", wallet: "0xA7", collateralSymbol: "yvcrvUSD-2", openBlock: 1, openLogIndex: 0 },
    { key: "closed-44", status: "closed", wallet: "0x44", collateralSymbol: "ysyBOLD", openBlock: 5, openLogIndex: 0 },
  ];

  const groups = groupPositionsByWallet(positions);

  assert.deepEqual(groups.map(({ wallet }) => wallet), ["0x44", "0xA7"]);
  assert.deepEqual(groups.map(({ positions: entries }) => entries.map(({ key }) => key)), [
    ["open-44", "closed-44"],
    ["open-a7", "closed-a7"],
  ]);
  assert.equal(positions[0].key, "closed-a7");
});

test("builds a chronological event timeline and combines loop-up logs", () => {
  const logs = [
    eventLog({ topic: closeTopic, block: 140, logIndex: 2, transactionHash: "0xclose", values: [7, 8] }),
    eventLog({ topic: openTopic, block: 100, logIndex: 3, transactionHash: "0xopen", values: [10, 6, 1, 20_000] }),
    eventLog({ topic: addCollateralTopic, block: 105, logIndex: 2, transactionHash: "0xdeposit", values: [4] }),
    eventLog({ topic: borrowTopic, block: 110, logIndex: 6, transactionHash: "0xloop", values: [12, 2] }),
    eventLog({ topic: addCollateralTopic, block: 110, logIndex: 5, transactionHash: "0xloop", values: [5] }),
    eventLog({ topic: adjustRateTopic, block: 120, logIndex: 1, transactionHash: "0xrate", values: [22_000, 3] }),
    eventLog({ topic: redeemTopic, block: 130, logIndex: 4, transactionHash: "0xredeem", values: [4, 5] }),
  ];
  const timeline = buildPositionTimeline(logs, new Map([
    [100, 1_000],
    [105, 1_050],
    [110, 1_100],
    [120, 1_200],
    [130, 1_300],
    [140, 1_400],
  ]));

  assert.deepEqual(timeline.map(({ kind }) => kind), ["open", "deposit", "loop", "rate", "redeem", "close"]);
  assert.equal(timeline[1].collateral, 4n);
  assert.equal(timeline[2].collateral, 5n);
  assert.equal(timeline[2].debtAfterBorrow, 12n);
  assert.equal(timeline[2].upfrontFee, 2n);
  assert.equal(timeline[2].timestamp, 1_100);
  assert.equal(timeline[4].debt, 5n);
  assert.equal(timeline[5].eventName, "CloseTrove");
});

test("flags only the final zero-debt redemption as full", () => {
  const timeline = [
    { kind: "open", label: "Opened" },
    { kind: "redeem", label: "Redeemed", debt: 4n },
    { kind: "rate", label: "Rate changed" },
    { kind: "redeem", label: "Redeemed", debt: 5n },
    { kind: "close", label: "Closed" },
  ];

  assert.deepEqual(
    classifyTimelineRedemptions(timeline, 0n)
      .filter(({ kind }) => kind === "redeem")
      .map(({ label, redemptionType }) => ({ label, redemptionType })),
    [
      { label: "Partial Redemption", redemptionType: "partial" },
      { label: "Full Redemption", redemptionType: "full" },
    ],
  );
  assert.deepEqual(
    classifyTimelineRedemptions(timeline, 1n)
      .filter(({ kind }) => kind === "redeem")
      .map(({ label }) => label),
    ["Partial Redemption", "Partial Redemption"],
  );
});
