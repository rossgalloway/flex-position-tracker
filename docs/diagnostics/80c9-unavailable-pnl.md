# Unavailable P&L for 0x80c9…08c0cb

Reproduced on 2026-09-18 at Ethereum block **26,006,628**. The live RPC reads succeeded. This is an unsupported accounting path, not an RPC or historical-APR failure.

## Evidence

Wallet: `0x80c9ac867b2d36b7e8d74646e074c460a008c0cb`  
Market: yvUSD / USDC  
Manager: `0x8ee72c388aA73096338EE18CD46a39D98b8983c9`  
Trove: `29112767855437768333518924555727633102556784322185275145844553028501564620475`

The history contains an opening, three redemptions, an interest-rate adjustment, and an additional Borrow at block **25,990,923**, September 16 at 15:25:59 UTC.

[Borrow transaction](https://eth.blockscout.com/tx/0xde4232599143c16be80993b87d6aac27eab43c77d4fe948e4ffb9a963dddf405) / [transaction API](https://eth.blockscout.com/api/v2/transactions/0xde4232599143c16be80993b87d6aac27eab43c77d4fe948e4ffb9a963dddf405)

| Input / observation | USDC |
| --- | ---: |
| Opening principal | 215,582.266934 |
| Opening fee | 16.543133 |
| Debt cancelled by redemptions | 166,568.450540 |
| Additional principal, from Borrow calldata | 16,000.000000 |
| Additional borrowing fee, from Borrow event | 2.174115 |
| Total debt immediately after additional borrowing | 65,951.771472 |
| Canonical current debt at snapshot | 65,971.942474 |

Collateral reconciles exactly: opening 235,272.508286 yvUSD minus 161,823.493653 redeemed = 73,449.014633 current shares. This Borrow did not add collateral.

## Why the tracker withholds P&L

`readPosition` in `src/lib/flexPositionTracker.js` sets `hasPositionChanges` when a log falls outside `BASELINE_EVENT_TOPICS`. Borrow is intentionally outside that set.

`calculatePosition` in `src/lib/flexPositionModel.js` requires `!input.hasPositionChanges` for `cleanOpenBaseline`. When that guard fails, accrued interest, PPS value change, P&L, and annualized lifetime returns remain unavailable. Existing regression tests explicitly enforce this behavior after principal changes.

The supported interest identity currently uses current debt + redeemed/closed debt − opening principal − opening fee − rate-adjustment fees. It does not subtract subsequent borrowed principal or subsequent borrowing fees. Removing the guard alone would misclassify **16,002.174115 USDC** as interest and materially distort P&L.

## Contract verification and diagnostic calculation

The verified implementation is [trove_manager at 0x41D4…39cE](https://eth.blockscout.com/address/0x41D491d261ad0D34bBFFFb3e2098f57beC4139cE?tab=contract), retrieved through [the source API](https://eth.blockscout.com/api/v2/smart-contracts/0x41D491d261ad0D34bBFFFb3e2098f57beC4139cE).

Its `borrow` function increases debt by the requested additional principal plus the upfront fee, after accruing prior interest. The emitted `Borrow.debt_amount` is **new total debt**, not the additional principal. The explorer's generic decoded input uses mismatched parameter names; the amount was checked against the verified Flex ABI and raw calldata.

Accounting for this observed principal change gives a diagnostic cumulative-interest amount at the pinned block:

```
65,971.942474 + 166,568.450540
− 215,582.266934 − 16.543133
− 16,000.000000 − 2.174115
= 939.408832 USDC
```

This is a derived audit result, not an implemented tracker result. Borrow proceeds may be delivered via subsequent auction settlement, and the transaction's immediate token transfers are collateral sent to the Dutch desk/auction. Requested principal alone does not certify wallet cash received or a realized lifetime P&L.

## Required accounting extension

- Reconstruct each additional borrow and repayment separately from interest. Use verified input/event semantics; do not sum emitted total-debt values as principal.
- Include additional borrowing fees in total one-time fees.
- Reconcile collateral changes and value them at their event PPS where applicable.
- Define and verify the treatment of principal proceeds, including deferred auction settlement, before presenting a cash-flow-adjusted lifetime P&L.
- Keep unsupported/incomplete paths unavailable; add pinned replay tests for this Trove and debt/collateral changes before removing the guard.

No accounting formula was changed during this diagnosis. Snapshot evidence is in `80c9-pnl-evidence.json` alongside this report. The separately requested embedded Add address button was implemented.

## Implemented follow-up — September 18, 2026

The original diagnosis above describes the pre-fix behavior. Additional principal and fees are now accounted for, together with actual repayments and collateral movements. The pinned snapshot produces 939.408832 USDC interest and +379.464730 USDC **Trove accounting P&L**. It does not claim verified wallet cash profit from auction settlements. See [accounting coverage](../accounting-coverage.md) for formulas, regression evidence, and the remaining limitations.
