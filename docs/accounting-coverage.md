# Position accounting coverage

## Two accounting views

**Trove P&L** values collateral at historical PPS and borrowing at nominal principal. It includes PPS changes, borrow interest, all borrowing/rate fees, redemptions, liquidation impact and written-off debt. Open balances remain marked at PPS; terminal positions stop at closeout or full liquidation.

**Settlement-adjusted P&L** also includes the difference between nominal borrowed principal and actual funded value, for both opening and later borrowing. It is available only when every funding operation is attributed and settled. Funding is credited to the manager's caller, which can be an operator or router rather than the Trove owner. This is not a whole-wallet realized-profit report: external swaps, gas and subsequent transfers remain outside the boundary.

The statement separates cash paid to recipients, claims exchanged for collateral, pending auction targets and final shortfalls. Auction self-takes consume a proceeds claim to acquire collateral without a USDC payment, so they are credited as non-cash settlement. Pending proceeds are never reported as received. Re-kicks retain the auction ID and cumulative receipts; exhausted auctions can have a final shortfall, while inactive auctions with collateral remaining can still require a re-kick.

## Evidence and reconstruction

The [verified Trove manager](https://eth.blockscout.com/api/v2/smart-contracts/0x41D491d261ad0D34bBFFFb3e2098f57beC4139cE), [Dutch desk](https://eth.blockscout.com/api/v2/smart-contracts/0x1ec26D158aA83B20089Caa15Af1ADB16CFc04c44), and [auction](https://eth.blockscout.com/api/v2/smart-contracts/0xAaCAed2BE3181622b646e87EAFa5e7c9c97B1E95) sources were verified on September 18, 2026.

- `Borrow.debt_amount` is the total debt after borrowing, not incremental principal. Direct calldata is checked against manager, Trove, transaction and block identity.
- Internal/router borrows are reconstructed by ordered event replay. The manager accrues `recordedDebt × annualRate × seconds / secondsPerYear / borrowPrecision`, using integer division, at each debt-changing event. The remaining delta in a Borrow event is principal after removing its fee. Replayed recorded debt, canonical debt, collateral, rate, update time and terminal status must match the snapshot. Valid direct calldata is cross-checked when replay is available.
- Repay uses the actual event amount after the contract's minimum-debt cap. Deposits and withdrawals use event-block PPS. Collateral-only changes do not reset the interest clock.
- Partial liquidation removes seized shares and liquidator-paid debt; the remaining position continues accruing interest. Full liquidation returns residual shares to the owner and ends the position. `BadDebt.loss` is additional cleared debt; `loss_absorbed_by_fees` is a subset of that loss and is never added again.
- Funding is attributed from a simple direct-call receipt or a successful manager call subtree. Reverted subtrees are excluded. Calls are matched to the corresponding Trove event, and funding token/desk/auction addresses come from the manager's on-chain configuration.
- The server allows only a fixed, bounded call tracer. When RPC tracing is unavailable it uses Blockscout's transaction-specific raw trace, preserving call order, parent errors and completeness checks. Missing or incomplete evidence withholds settlement accounting without discarding otherwise reconciled Trove balances.
- AuctionTake events are replayed in order and capped at the auction's maximum. Credited proceeds must match the pinned auction state. This separates receiver cash, self-take credit, pending amounts, and final shortfall.

## Formulas

```
interest = remaining + redeemed + repaid + liquidator-paid + written-off + closed debt
           - opening and additional principal - all one-time fees
PPS gain = remaining + redeemed + seized + returned-at-close + withdrawn collateral value
           - added collateral value - opening collateral value
liquidation impact = liquidator-paid debt + written-off debt - seized collateral value
Trove P&L = PPS gain + redemption impact + liquidation impact - interest - all one-time fees
net capital added = collateral deposits - withdrawals + repayments - additional principal
ending equity/proceeds = initial capital + net capital added + Trove P&L
settlement-adjusted P&L = Trove P&L + delivered funding value - nominal principal
```

Collateral amounts in value formulas use each event's historical PPS. A write-off cancels the borrower's liability; it is not cash paid by the owner or investment income. The associated seizure and loss of equity remain included.

## Returns with capital changes

For positions with external capital changes or liquidation, the statement uses **Modified Dietz**:

```
weighted capital = initial capital + Σ(net contribution × remaining fraction of period)
period return = Trove P&L / weighted capital
annualized return = (1 + period return)^(365 days / observed days) - 1
```

Borrowing is a negative contribution; repayment is positive; share deposits and withdrawals are valued at event PPS. Fees are already included in P&L and are not deducted twice. Dietz is an approximation using time-weighted capital, not transaction-level time-weighted return or XIRR. It uses nominal Trove cash flows, so auction payout timing/shortfalls are confined to the separate settlement view. Non-positive invested capital, missing timing, zero duration, and returns below -100% leave the compounded return unavailable. A total loss is reported as -100%. Normal histories without capital changes retain the existing since-open return convention.

## Pinned examples

Pinned block: **26,006,999**. These values are regression evidence, not current quotes.

### Supplied partial liquidation

- Owner: `0x5555E978E0732c198bc801477DFbccce66252fF5`
- Trove: `33753163019330914265705407780392997351183946878872776921268242701450751963777`
- [Transaction](https://etherscan.io/tx/0x760628050580eafab0cc188b106f467c334784d0ddd442c1d42ce4ec186a426f), block 25,991,798.
- Liquidator: `0x4cDAD2b89e602D5eCaCBAc7DFA315037537C79D5`
- Seized: 2,476.389380367124464489 ysyBOLD; debt repaid: 2,682.350306 USDC.
- Event flag: **partial**, not full. No BadDebt event.
- Seized PPS value: 2,699.938476 USDC; liquidation impact: **−17.588170 USDC**.
- Trove remains active. At the pinned snapshot its Trove and settlement-adjusted P&L are **−35.978471 USDC**.
- This wallet's other closed histories also exercise routed borrowing and auction self-takes, including genuine one-micro-USDC shortfalls.

### Auction-funded borrower

Wallet `0x80c9ac867b2d36b7e8d74646e074c460a008c0cb` borrowed another 16,000 USDC in [this transaction](https://eth.blockscout.com/tx/0xde4232599143c16be80993b87d6aac27eab43c77d4fe948e4ffb9a963dddf405).

Auction #24 paid **15,893.622701 USDC** and exhausted its collateral, leaving **106.377299 USDC** final shortfall. Its opening funding is separately verified through the router trace. At the pinned snapshot Trove P&L is **+379.650933 USDC**, while settlement-adjusted P&L is **+273.273634 USDC**.

## Remaining evidence limits

- Historical `eth_call` returns end-of-block PPS, not transaction-exact PPS if an oracle changes within that block.
- Trace/provider outages, incomplete logs, mismatched state or unfamiliar contract semantics leave affected values unavailable. Replays do not bypass reconciliation failures.
- Auction funding does not certify the owner's later receipt from an operator/router. Gas, swaps, off-Trove transfers and the owner's tax/cost-basis accounting are excluded.
- Only the configured Flex markets and this verified manager/auction behavior are covered; an unknown implementation requires verification before reuse.

## Regression coverage

`flexSettlement.test.js` covers the supplied liquidation and both wallets through full RPC replay, plus synthetic full liquidation, bad debt with fee absorption, same-block borrows, interest epochs, Modified Dietz weighting, total loss, pending/exhausted/capped auction payouts and self-takes. Missing trace evidence must preserve Trove P&L while withholding settlement-adjusted P&L. Server tests reject arbitrary tracers and incomplete/orphaned trace trees.

Fixtures under `src/lib/fixtures/*-settlement-rpc.json` pin requests and results. Block responses retain timestamps. Trace input/output bodies unrelated to funding extraction are truncated, while call ancestry/order, destinations, errors, relevant transfer/kick arguments and opening return IDs are preserved. Existing `80c9-accounting-rpc.json` retains the earlier block 26,006,628 interest regression.
