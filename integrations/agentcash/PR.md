# PR to Merit-Systems/agentcash-skills: add `degenscan-intel` (market-event intelligence, x402, no key required)

Adds a finance/market-data skill pack — the catalog currently has none. Degenscan Intel gives agents primary-source market events (SEC filings, Fed/FOMC, regulators, disasters, Nasdaq halts, DeFi hacks, Polymarket odds, Hyperliquid funding/OI) scored per asset, at $0.001–$0.10 per call, paid via x402 (USDC on Base/Solana) or a prepaid key an agent buys with USDC. Free trial (100 calls/day) needs no signup, so the pack works out of the box.

Files: `skills/degenscan-intel/SKILL.md`, `skills/degenscan-intel/rules/getting-started.md` (mirrored under `mcp/skills/` if the repo layout requires it).

Endpoints agents/indexers read: `/.well-known/x402`, `/openapi.json`, `/llms.txt`, MCP `/mcp`. Public usage metrics with operator wallets excluded: https://intel.degenscan.io/v1/metrics. Open source (MIT): https://github.com/tradewr333-lgtm/degenscan-intel. Maintained by the service operator (Marbella Collins LLC). Information and analytics only — not investment advice.
