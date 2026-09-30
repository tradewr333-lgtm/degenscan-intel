# Degenscan Intel — crypto market intelligence for agents (Apify Actor)

Run one Degenscan Intel tool per call and get JSON back. Built for AI agents and trading bots; also callable by agents paying with x402 through Apify.

| Tool | What you get |
|---|---|
| `token_verdict` | Contract risk verdict for a token (Base, Ethereum, BSC, Arbitrum, Polygon, Optimism, Avalanche, Solana): DANGER / HIGH_RISK / CAUTION / LOW_RISK, 0–100 score, named flags (honeypot, taxes, mintable, pausable, blacklist, hidden owner, unverified, proxy, holder concentration, unlocked LP, thin/new liquidity) |
| `price_for`, `derivs_for`, `funding_alerts` | Hyperliquid perp mark, Coinbase spot, funding, open interest, predicted funding by venue |
| `whale_moves` | Large USDC/USDT transfers to/from exchanges on Base and Ethereum |
| `polymarket_top` | Most active Polymarket markets with odds and 24h change |
| `events_since`, `impact_for` | Primary-source market events (SEC, Fed, halts, hacks, on-chain) scored into per-asset impact |
| `oracle_board`, `oracle_forecast` | Calibrated probabilities for binary questions with a public Brier track record |

Same data directly (no Apify): https://intel.degenscan.io — x402 pay-per-call (USDC on Base/Solana), MCP at `/mcp`, docs at `/llms.txt`.

Operator: Marbella Collins LLC · contact@degenscan.io. Information and analytics only — not investment advice.
