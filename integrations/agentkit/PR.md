# feat(action-providers): add Degenscan Intel provider (TypeScript + Python)

## Description

Adds `degenscan_intel`, a read-only HTTP action provider for **Degenscan Intel** (https://intel.degenscan.io): market data and market-event intelligence for trading agents.

Actions (same names in TypeScript and Python):
- `get_market_pulse`: last-hour event counts by class, high-severity count, venues open ($0.001)
- `get_market_events`: price-moving events from primary sources (SEC EDGAR, Fed and other central banks, Federal Register, FTC/DOJ/FDA/CFTC, USGS, NOAA, Nasdaq halts, DeFi hacks, Polymarket) with per-asset impacts ($0.005)
- `get_asset_brief`: one-call pre-trade brief for one asset ($0.10)
- `get_perp_derivs`: Hyperliquid funding, predicted funding by venue, open interest, premium, flags ($0.003)
- `get_deribit_perps`: funding (8h and annualized), premium, open interest and 24h volume for Deribit perpetuals, the venue Coinbase Advanced / Coinbase for Agents uses for international perps, plus the funding gap vs Hyperliquid; one symbol adds 7 days of hourly funding ($0.002)

Why: AgentKit agents can act on-chain and, through Coinbase for Agents, trade perps, but have no native source of funding/positioning data or of the real-world events that move prices. The provider is paid the agent-native way: per call in USDC via **x402** on Base (CDP facilitator) or Solana, or with a prepaid key bought with USDC (`POST /v1/keys/x402/balance_5`). No card, no account. A free trial (100 calls/day/IP) works with zero configuration.

Pattern: follows `pyth`: no wallet needed, `supportsNetwork = () => true`, zod / pydantic schemas, README, unit tests with a mocked fetch / requests session. Optional config: `apiKey` (or `DEGENSCAN_INTEL_API_KEY`), `baseUrl`, and (TS) `fetchFn` to pass an x402-wrapped fetch from `@x402/fetch`. Exports added to `action-providers/index.ts` and `action_providers/__init__.py`; changeset (patch) and `changelog.d` entry included.

Disclosure: the provider is maintained by the service operator (Marbella Collins LLC). Not affiliated with Coinbase, Deribit or Hyperliquid. Information and analytics only, not investment advice. Written with AI assistance (Claude) and reviewed by the maintainer.

## Tests

Unit tests:
```
typescript/agentkit$ npx jest src/action-providers/degenscanIntel
Tests: 6 passed, 6 total
typescript/agentkit$ npx eslint -c .eslintrc.json "src/action-providers/degenscanIntel/*.ts"   # clean
typescript/agentkit$ npx tsc --noEmit -p .                                                    # clean

python/coinbase-agentkit$ uv run pytest tests/action_providers/degenscan_intel -q
6 passed
python/coinbase-agentkit$ uv run ruff check . && uv run ruff format --check .                  # all checks passed
```

Live call used by `get_deribit_perps` (free trial header):
```
GET https://intel.degenscan.io/v1/deribit/perps?symbols=BTC,SOL  (X-Free-Trial: 1)
→ 200, items[]: { symbol: "BTC", instrument: "BTC-PERPETUAL", funding_apr_pct: 13.62, funding_gap_vs_hyperliquid_apr_pct: 2.67,
                  open_interest_usd: 690691240, ... }, { symbol: "SOL", instrument: "SOL_USDC-PERPETUAL", ... }
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
