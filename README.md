# Flex Position Tracker

Standalone, read-only return statements for Flex Troves on Ethereum.

The app reconstructs each tracked Trove from Ethereum events and contract reads, then separates observed return components from forward-looking APR estimates. Tracked addresses and the selected wallets to show are stored together in the current browser's `localStorage`; they are never sent anywhere except as filters in read-only Ethereum log requests.

## Stack

This project follows the Yearn Powerglove frontend stack:

- React 18 and TypeScript
- Vite and Bun
- TanStack Router
- Tailwind CSS
- Biome
- Vitest and Testing Library
- Vercel static hosting with a same-origin serverless RPC boundary

## Local development

1. Copy `.env.example` to `.env`.
2. Set `RPC_URL_1` to an Ethereum JSON-RPC endpoint.
3. Install and run:

```bash
bun install
bun run dev
```

The Vite plugin serves `/api/flex-rpc` locally. The browser never receives `RPC_URL_1`.

## Validation

```bash
bun run test
bun run lint
bun run build
```

## Deployment

Deploy the repository to Vercel and configure the server-only `RPC_URL_1` environment variable. `api/flex-rpc.ts` exposes only the read methods used by the tracker and falls back to Blockscout when the primary provider is unavailable.

New browsers start with an empty wallet list. The tracked-wallet list lives in browser `localStorage`, so each visitor controls their own addresses without a database.

## Accounting boundary

- Ethereum is authoritative for openings, collateral and debt changes, rate changes, redemptions, closeouts, canonical debt, ownership, and status.
- Kong supplies current estimated/oracle APYs and annualized 7-day/30-day PPS yields for projections.
- Additional borrowing uses verified calldata or canonical-state-checked event replay. Repayments, collateral movements, partial/full liquidations and bad debt are reconciled separately.
- Auction funding uses receipts and successful call traces, with a bounded Blockscout fallback. Settled cash, self-take credits, pending proceeds and shortfalls are separate; settlement-adjusted P&L requires complete evidence.
- Positions with capital changes or liquidation use Modified Dietz returns. See [accounting coverage](docs/accounting-coverage.md) for formulas, examples and evidence limits.
- Missing or unsupported values remain unavailable and are never converted to zero.
- The app is read-only: it does not connect wallets or sign transactions.

## Projection sources

The Advanced options selector defaults to **Automatic**. Each collateral vault is queried from Kong's `/api/rest/snapshot/1/{collateralToken}` once per refresh. Automatic uses the first available net APY:

1. `performance.estimated.apy`
2. `performance.oracle.netAPY`
3. `performance.historical.weeklyNet` (annualized 7-day PPS return)
4. `performance.historical.monthlyNet` (annualized 30-day PPS return)

For ysyBOLD, step 1 is replaced by the maximum of oracle net APY and 7-day PPS APY. If only one of those inputs exists, it is used; if neither exists, the remaining fallbacks apply. Explicit sources do not fall back. Selecting Estimated APY explicitly also uses this ysyBOLD estimate; it is not a separate source option. Other vaults use Kong estimated APY. Valid zero and negative yields remain valid inputs.

Statements disclose the source APY and the APR used for carry: `APR = 52 × ((1 + APY)^(1/52) − 1)`, preserving the tracker’s weekly compounding assumption. Source changes apply on **Refresh now**. Missing projection data leaves forward values unavailable without discarding reconstructed balances, P&L, or since-open returns.
