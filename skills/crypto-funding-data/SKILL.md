---
name: crypto-funding-data
description: Live perpetual-futures data for crypto trading agents — funding rates (now, 24 h, 7 d, annualised), predicted funding on Hyperliquid, Binance and Bybit, Deribit perps (the venue Coinbase Advanced uses for international perps), funding gaps between venues, open interest, premium vs oracle, liquidation maps and BTC/ETH options. Use when the user asks "what is the BTC funding rate", "which perps have extreme funding", "where is funding higher, Hyperliquid or Coinbase/Deribit", "how close are positions to liquidation", or needs these numbers before opening or sizing a perp. 100 free calls/day with no key; then USDC per call via x402.
---

# Crypto funding and perp data

Read-only REST calls to `https://intel.degenscan.io`. Every call is one HTTPS GET that returns JSON.

## Pick the call

| Question | Call | Price |
|---|---|---|
| Funding, premium and predicted funding for one Hyperliquid perp | `GET /v1/hl/basis/{coin}` (e.g. BTC, ETH, HYPE) | $0.001 |
| Perps with extreme funding right now | `GET /v1/funding/alerts` | $0.001 |
| Deribit perps (Coinbase Advanced international venue) with the gap vs Hyperliquid | `GET /v1/deribit/perps?symbols=BTC,SOL&sort=gap` (one symbol adds 7 days of hourly funding) | $0.002 |
| Funding for any Hyperliquid perp, including HIP-3 dexes (xyz:NVDA) | `GET /v1/carry/now/{coin}` | $0.001 |
| Coins with the most open notional near liquidation | `GET /v1/hl/liquidations?within_pct=5` | $0.001 |
| Liquidation map for one coin | `GET /v1/hl/liquidations/{coin}` | $0.002 |
| BTC/ETH options: implied vol, skew, put/call, max pain | `GET /v1/options/{BTC|ETH}` | $0.002 |
| Funding, OI, flags and event pressure for one coin | `GET /v1/derivs/{symbol}` | $0.003 |

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/hl/basis/BTC"
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/deribit/perps?symbols=BTC,ETH&sort=gap"
```

Read `funding.apr_pct` (annualised; positive means longs pay shorts), `predicted_funding[]` per venue and `open_interest_usd`. In `/v1/deribit/perps`, `funding_gap_vs_hyperliquid_apr_pct` is Deribit minus Hyperliquid. A gap excludes fees, borrowing and execution costs, so do not call it a profit.

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
- Not affiliated with Hyperliquid, Coinbase or Deribit.
