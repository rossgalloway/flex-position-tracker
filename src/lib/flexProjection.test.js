import assert from "node:assert/strict";
import test from "node:test";
import { decimalToWad, weeklyApyToApr } from "./flexPositionModel.js";
import { fetchProjectionSnapshot, selectProjection } from "./flexProjection.js";

const ysybold = "0x23346B04a7f55b8760E5860AA5A77383D63491cD";
const yvusd = "0x696d02Db93291651ED510704c9b286841d506987";
const snapshot = (estimated, oracle, weeklyNet, monthlyNet) => ({ performance: {
  estimated: { apy: estimated }, oracle: { netAPY: oracle }, historical: { weeklyNet, monthlyNet },
} });
const near = (actual, value) => assert.ok(actual !== null && (actual - decimalToWad(String(value))) ** 2n < 10000n);

test("automatic falls through estimated, oracle, 7-day PPS, then 30-day PPS", () => {
  for (const [data, source, value] of [
    [snapshot(0.1, 0.2, 0.3, 0.4), "estimated", 0.1],
    [snapshot(null, 0.2, 0.3, 0.4), "oracle", 0.2],
    [snapshot(null, null, 0.3, 0.4), "pps7", 0.3],
    [snapshot(null, null, null, 0.4), "pps30", 0.4],
  ]) {
    const selected = selectProjection(data, yvusd);
    assert.equal(selected.source, source);
    near(selected.apy, value);
    assert.equal(selected.apr, weeklyApyToApr(selected.apy));
  }
});

test("ysyBOLD replaces estimated APY with the maximum of oracle and weekly PPS", () => {
  for (const [oracle, weekly, expected] of [[0.1, 0.2, 0.2], [0.3, 0.2, 0.3], [0, -0.1, 0], [-0.2, -0.1, -0.1]]) {
    for (const mode of ["automatic", "estimated"]) {
      const selected = selectProjection(snapshot(0.9, oracle, weekly, 0.4), ysybold, mode);
      assert.equal(selected.source, "estimated");
      near(selected.apy, expected);
      assert.match(selected.note, /Higher value selected/);
    }
  }
  near(selectProjection(snapshot(0.9, null, 0.2, 0.4), ysybold).apy, 0.2);
  near(selectProjection(snapshot(0.9, 0.3, null, 0.4), ysybold).apy, 0.3);
  assert.match(selectProjection(snapshot(0.9, null, 0.2, 0.4), ysybold).note, /only available input/);
  assert.equal(selectProjection(snapshot(0.9, null, null, 0.4), ysybold).source, "pps30");
});

test("explicit estimated APY uses the ysyBOLD estimate; other sources use their requested input", () => {
  for (const [mode, expected] of [["estimated", 0.3], ["oracle", 0.2], ["pps7", 0.3], ["pps30", 0.4]]) {
    near(selectProjection(snapshot(0.1, 0.2, 0.3, 0.4), ysybold, mode).apy, expected);
  }
  assert.equal(selectProjection(snapshot(null, 0.2, 0.3, 0.4), yvusd, "estimated").apr, null);
  assert.equal(selectProjection(snapshot(0.9, null, null, 0.4), ysybold, "estimated").apr, null);
  near(selectProjection(snapshot(0.1, 0.2, 0.3, 0.4), yvusd, "estimated").apy, 0.1);
});

test("zero and negative APYs remain valid; missing or malformed inputs do not become zero", () => {
  for (const value of [0, -0.1]) {
    const selected = selectProjection(snapshot(value, 0.2, 0.3, 0.4), yvusd);
    assert.equal(selected.source, "estimated");
    near(selected.apy, value);
  }
  for (const value of [null, undefined, "", " ", false, [], {}, NaN, Infinity, "bad", -1]) {
    const selected = selectProjection(snapshot(value, null, null, null), yvusd);
    assert.equal(selected.apy, null);
    assert.equal(selected.apr, null);
  }
});

test("snapshot request failures remain retryable and aborts propagate", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("unavailable", { status: 503 });
    const result = await fetchProjectionSnapshot(yvusd);
    assert.equal(result.snapshot, null);
    assert.match(result.error, /Refresh now to retry/);
    assert.match(result.url, /\/snapshot\/1\/0x696d/);
    globalThis.fetch = async () => { throw new DOMException("aborted", "AbortError"); };
    await assert.rejects(fetchProjectionSnapshot(yvusd), { name: "AbortError" });
  } finally {
    globalThis.fetch = original;
  }
});
