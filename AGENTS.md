# Repository Guidelines

## Commands

- `bun run dev` starts the Vite app and local same-origin RPC middleware.
- `bun run test` runs the accounting, tracker, export, UI, and RPC tests.
- `bun run lint` checks TypeScript and configuration files with Biome.
- `bun run build` type-checks and creates the production bundle.

## Architecture

- `src/App.tsx` owns the React shell and tracker markup.
- `src/lib/` contains the source-visible accounting, chain reconstruction, rendering, and export logic.
- `server/flexRpc.ts` is the shared RPC allowlist and provider fallback implementation.
- `api/flex-rpc.ts` adapts that shared boundary to Vercel.
- Tracked wallets live in browser `localStorage`; `RPC_URL_1` remains server-only.

## Data rules

- Never turn unavailable PPS, debt, or valuation data into zero.
- Preserve observed, derived, estimated, and unavailable states separately.
- Chain reads occur only on page load or explicit refresh.
- Do not add transaction signing or wallet connection without explicit scope.
