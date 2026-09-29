# PR: feat(action-providers): add Degenscan Intel (market-event intelligence) provider — TypeScript + Python

## What
Adds `degenscan_intel`, a read-only HTTP action provider for **Degenscan Intel** (https://intel.degenscan.io): cross-asset market-event intelligence for agents — SEC EDGAR filings, Federal Reserve/ECB/BoE/BoJ releases, Federal Register rules, FTC/DOJ/FDA/CFTC actions, USGS earthquakes, NOAA storms, Nasdaq halts, DeFi hacks, Polymarket odds and Hyperliquid perp microstructure, normalized into one event schema and scored into per-asset impacts (direction, confidence, exposure path).

Actions:
- `get_market_pulse` — last-hour event counts by class, high-severity count, venues open
- `get_market_events` — events since a window with per-asset impacts, `tradable_now` / `next_open`
- `get_asset_brief` — one-call pre-trade brief for one asset
- `get_perp_derivs` — Hyperliquid funding, predicted funding by venue, OI, premium, flags

## Why
Agents built with AgentKit can act on-chain but have no native source of *what happened in the world* that moves prices. This provider fills that gap with primary sources and is itself paid the agent-native way: per call in USDC via **x402** on Base (Coinbase CDP facilitator) or Solana, or with a prepaid key an agent buys with USDC (`POST /v1/keys/x402/pack_1k`). No card, no account. A free trial (100 calls/day/IP) works with zero configuration, so the provider is usable out of the box.

## Pattern
Follows the `pyth` provider: no wallet needed, `supportsNetwork = () => true`, zod/pydantic schemas, README, unit tests with a mocked fetch/session. Optional config: `apiKey` (or `DEGENSCAN_INTEL_API_KEY`), `baseUrl`, and (TS) `fetchFn` so users can pass an x402-wrapped fetch from `@x402/fetch`.

## Checklist
- [ ] TS: `pnpm test`, `pnpm run format`, `pnpm run lint:fix`, `pnpm run changeset` (patch: "Added Degenscan Intel action provider")
- [ ] Python: `make test`, `changelog.d/<issue>.feature.md`
- [ ] Export added to `src/action-providers/index.ts` and `action_providers/__init__.py`
- [ ] READMEs updated

## Disclosure
Provider maintained by the service operator (Marbella Collins LLC). The service is MIT-licensed and open source: https://github.com/tradewr333-lgtm/degenscan-intel. Public usage metrics with operator wallets excluded: https://intel.degenscan.io/v1/metrics. Information and analytics only — not investment advice.

## Contribution provenance
Written with AI assistance (Claude) and reviewed by the maintainer; tests run locally.
