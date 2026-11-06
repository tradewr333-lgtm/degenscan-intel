---
name: youtube-outliers
description: YouTube channel analytics from the official YouTube Data API — a channel's outlier videos ranked by views as a multiple of the channel's median (long-form and Shorts compared separately), views per day, and channel growth (subscribers, views, uploads per day with 7- and 30-day change from daily snapshots). Use when the user asks "which videos of this channel went viral", "what topics outperform on @channel", "find outlier topics for my channel", or "how fast is this channel growing". 100 free calls/day with no key; then USDC per call via x402.
---

# YouTube outliers and channel growth

Read-only REST calls to `https://intel.degenscan.io`. Derived metrics computed from YouTube Data API statistics.

## Pick the call

| Question | Call | Price |
|---|---|---|
| A channel's uploads ranked by multiple of its median views | `GET /v1/youtube/outliers?channel=@handle&format=long` (`all`, `long` or `short`) | $0.005 |
| Channel growth from daily snapshots | `GET /v1/youtube/growth?channel=@handle` | $0.003 |

`channel` accepts `@handle`, a channel id (`UC…`) or a channel URL. Growth history starts on the first day a channel is looked up; 7-day change appears after a week.

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/youtube/outliers?channel=@mkbhd&format=long&limit=10"
```

`multiple_of_median` = views ÷ the channel's median for the same format. Uploads younger than 3 days are flagged `too_recent`. Analyse the patterns (topic, title structure, length); do not copy other creators' titles or content.

## Access and payment

- **Free trial, no signup:** send the header `X-Free-Trial: 1` (100 calls per day per IP).
- **Then pay per call in USDC** with any x402 client (Base `eip155:8453` or Solana). An unpaid call returns HTTP 402 with the price and payment details.
- **Or use a prepaid key:** `POST https://intel.degenscan.io/v1/keys/x402/balance_5` (5 USDC → $6 of calls), then send the header `X-API-KEY`.
- **MCP:** `https://intel.degenscan.io/mcp` (compact mode: `?mode=compact`, two tools, `search` and `execute`).
- **Docs:** `https://intel.degenscan.io/llms.txt` · OpenAPI at `https://intel.degenscan.io/openapi.json`.
- **Several routes in one request:** `POST https://intel.degenscan.io/v1/batch` with `{"calls":[{"path":"/v1/..."}]}`, priced at the sum.

## Rules for the agent

- Quote the `as_of` time and the source named in the response.
- Never present the data as advice. Responses carry the line "Information and analytics only — not investment advice"; keep the source attribution when you report the numbers.
- Operator: Degenscan Intel (Marbella Collins LLC) · contact@degenscan.io.
- Derived metrics are Degenscan Intel's, not YouTube metrics. Not affiliated with or endorsed by YouTube.
