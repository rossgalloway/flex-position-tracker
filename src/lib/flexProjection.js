import { decimalToWad, formatPercent, weeklyApyToApr } from "./flexPositionModel.js";

const YSYBOLD = "0x23346b04a7f55b8760e5860aa5a77383d63491cd";
const LABELS = {
  estimated: "Estimated APY",
  oracle: "Oracle APY",
  pps7: "7-day PPS APY",
  pps30: "30-day PPS APY",
};

function readApy(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= -1) return null;
  try {
    const apy = decimalToWad(number.toFixed(18));
    return weeklyApyToApr(apy) === null ? null : apy;
  } catch {
    return null;
  }
}

export function selectProjection(snapshot, collateralToken, mode = "automatic") {
  const performance = snapshot?.performance;
  const candidates = {
    estimated: readApy(performance?.estimated?.apy),
    oracle: readApy(performance?.oracle?.netAPY),
    pps7: readApy(performance?.historical?.weeklyNet),
    pps30: readApy(performance?.historical?.monthlyNet),
  };
  const isYsyBold = collateralToken.toLowerCase() === YSYBOLD;
  const overrideInputs = ["oracle", "pps7"].filter((source) => candidates[source] !== null);
  const overrideWinner = overrideInputs.reduce((winner, source) => (
    winner === null || candidates[source] > candidates[winner] ? source : winner
  ), null);
  if (isYsyBold) candidates.estimated = overrideWinner ? candidates[overrideWinner] : null;

  const source = mode === "automatic"
    ? ["estimated", "oracle", "pps7", "pps30"]
      .find((key) => candidates[key] !== null)
    : mode;
  const apy = candidates[source] ?? null;
  const label = LABELS[source] ?? "Automatic";
  let note = "";
  if (apy === null) {
    note = mode === "automatic"
        ? "No usable projection APY is available from Kong."
        : `${label} is unavailable. Choose another source or Automatic.`;
  } else if (source === "estimated" && isYsyBold) {
    note = `Oracle APY ${formatPercent(candidates.oracle)}; 7-day PPS APY ${formatPercent(candidates.pps7)}. ${overrideInputs.length === 2 ? "Higher value selected" : "Using the only available input"}: ${LABELS[overrideWinner]}.`;
  }
  return {
    mode,
    source: apy === null ? null : source,
    label,
    apy,
    apr: apy === null ? null : weeklyApyToApr(apy),
    note,
  };
}

export async function fetchProjectionSnapshot(collateralToken, signal) {
  const url = `https://kong.yearn.fi/api/rest/snapshot/1/${collateralToken.toLowerCase()}`;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Kong returned ${response.status}`);
    const snapshot = await response.json();
    return { snapshot, url, error: null };
  } catch (error) {
    if (signal?.aborted || error.name === "AbortError") throw error;
    return { snapshot: null, url, error: "Kong projection data could not be loaded. Choose Refresh now to retry." };
  }
}
