---
name: polymarket-odds
description: Search and read Polymarket prediction markets — current YES odds, best bid/ask and spread, 24 h change, volume, liquidity, closing date, events with all their outcomes and open interest, and the top traders by PnL. Use when the user asks "what are the odds of X on Polymarket", "find Polymarket markets about bitcoin / the Fed / an election", "which markets close this week", or "who are the best Polymarket traders". 100 free calls/day with no key; then USDC per call via x402.
---

# Polymarket odds

Read-only REST calls to `https://intel.degenscan.io`, sourced from Polymarket's public Gamma and data APIs.

## Pick the call

| Question | Call | Price |
|---|---|---|
| Find markets by words, tag, closing window or liquidity | `GET /v1/polymarket/markets?q=bitcoin&tag=crypto&ends_within_days=7&min_liquidity=10000` | $0.002 |
| Event groups with their top outcomes and open interest | `GET /v1/polymarket/events?q=fed` | $0.002 |
| Most active markets right now | `GET /v1/polymarket/top?sort=volume_24h` | $0.002 |
| Top traders by PnL or volume | `GET /v1/polymarket/leaderboard?period=week&by=pnl&limit=20` | $0.002 |
| One market with primary-source events that bear on it | `GET /v1/polymarket/{market-slug}?since=48h` | $0.01 |

Tags are Polymarket tag slugs, such as `crypto`, `politics` or `sports`. The text search requires every word of `q` to appear in the question.

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/polymarket/markets?q=bitcoin&tag=crypto&limit=10"
```

`yes_prob` is the last YES price (0–1). `spread` is best ask minus best bid; a wide spread means the price is less reliable. Report the odds as market prices, not as forecasts of your own.

## Access and payment

- **Free trial, no signup:** send the header `X-Free-Trial: 1` (100 calls per day per IP).
- **Then pay per call in USDC** with any x402 client (Base `eip155:8453` or Solana). An unpaid call returns HTTP 402 with the price and payment details.
- **Or use a prepaid key:** `POST https://intel.degenscan.io/v1/keys/x402/balance_5` (5 USDC → $6 of calls), then send the header `X-API-KEY`.
- **MCP:** `https://intel.degenscan.io/mcp` (compact mode: `?mode=compact`, two tools, `search` and `execute`).
- **Docs:** `https://intel.degenscan.io/llms.txt` · OpenAPI at `https://intel.degenscan.io/openapi.json`.
- **Several routes in one request:** `POST https://intel.degenscan.io/v1/batch` with `{"calls":[{"path":"/v1/..."}]}`, priced at the sum.

## Rules for the agent

- Quote the `as_of` time and the source named in the response.
- Never present the data as advice. Responses carry the line "Information and analytics only — not investment advice"; keep it when you report the numbers.
- Operator: Degenscan Intel (Marbella Collins LLC) · contact@degenscan.io.
- Not affiliated with Polymarket.
