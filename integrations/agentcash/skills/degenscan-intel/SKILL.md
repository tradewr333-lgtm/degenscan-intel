---
name: degenscan-intel
description: No key required — market-event intelligence for trading and research agents: SEC filings (8-K, Form 4, 13D), Fed/FOMC and central-bank releases, regulator actions, earthquakes and storms, Nasdaq halts, DeFi hacks, Polymarket odds and resolution-relevant events, Hyperliquid perp funding rate and open interest, whale-scale market pressure — normalized into one feed and scored per asset (stocks, ETFs, crypto, commodities, rates, FX). Use when the task involves "what is moving X", "what happened in the last 4 hours that affects my book", funding rate or open interest before a perp trade, a Polymarket question, an SEC filing on a ticker, or the macro calendar (FOMC, CPI, NFP). 100 free calls/day with no signup; then pays per call in USDC via x402 (Base or Solana) or API key.
---

# Degenscan Intel

**No API key required to start.** Send header `X-Free-Trial: 1` for 100 free calls/day per IP; after that any x402 client pays per call in USDC (Base `eip155:8453` or Solana) — no signup, no card. One normalized feed of price-moving events from ~40 primary sources (SEC EDGAR, Federal Reserve/FOMC, Federal Register, ECB/BoE/BoJ, FTC/DOJ/FDA/CFTC/FCC, USGS, NOAA/NHC, Nasdaq halts, DefiLlama hacks, Polymarket, Hyperliquid perps, press wires) scored against an exposure graph into per-asset impacts. Deterministic, sub-200 ms, auditable (`raw_ref` links to the source document).

Covers the questions trading agents ask most: Polymarket odds vs fresh primary events · perp funding rate / open interest / premium (Hyperliquid, no key) · SEC 8-K and Form 4 by ticker · FOMC/CPI/NFP calendar · headlines with sentiment · cross-asset catalysts with exposure paths (quake → TSMC fab → TSM → NVDA).

- MCP (streamable HTTP): `POST https://intel.degenscan.io/mcp`
- REST: `https://intel.degenscan.io/v1/...`
- Docs for machines: `https://intel.degenscan.io/llms.txt`
- Operator: Marbella Collins LLC · contact@degenscan.io · MIT

## When to use which tool

| You need… | Call | Cost |
|---|---|---|
| Cheapest probe — anything new in the last hour? | `pulse` | $0.001 |
| Everything an operator reads before trading one asset, in one call | `brief(asset_id)` | $0.10 |
| Headlines on one asset with sentiment | `news_for(ticker, since)` | $0.002 |
| Perp funding / open interest / premium / predicted funding by venue for one coin (Hyperliquid, no key) | `derivs_for(symbol)` | $0.003 |
| SEC filings on one issuer (8-K, Form 4, 13D, S-1) | `filings_for(ticker, since)` | $0.002 |
| Upcoming macro prints / FOMC / earnings / auctions | `calendar(days)` | $0.002 |
| Situational picture right now: venues open, next opens, 24h pressure by asset, top events, prediction markets | `regime_snapshot` | $0.01 |
| Everything since *t* that touches my assets (or a backtest window) | `events_since(since, universe, min_confidence)` | $0.005 |
| Net pressure on one asset + its drivers ("why is MSTR down?") | `impact_for(asset_id, since)` | $0.003 |
| Second-order exposure (suppliers, countries, commodities, regulators, indices) | `exposure_graph(asset_id, depth)` | $0.002 |
| The reasoning behind one surprising impact | `explain(event_id)` | $0.02 |
| Evidence pack for a Polymarket/Kalshi-style question (odds + primary events that bear on it) | `polymarket_context(market, since)` | $0.01 |
| Map tickers → asset ids; list what is covered | `universe` | free |
| Is the feed fresh? which sources are best-effort? | `sources_status` | free |

## Recommended loop (every 1–4 h, or before acting)

1. `universe` once per session → map your tickers to asset ids (`NVDA`, `BTC`, `CL`, `US10Y`, `SPX`…).
2. `regime_snapshot` → if nothing high-severity touches your book and venues are closed, stop here.
3. `events_since(since="4h", universe=[...your book...], min_confidence=0.4)` → candidate events.
4. For each asset with |bias| meaningful: `impact_for(asset_id, since="24h")`.
5. Check `tradable_now` / `next_open` on the event before sending an order; if the venue is closed, queue for `next_open`.
6. If an impact looks wrong, `explain(event_id)` before acting; log the rationale.

## Prediction markets

`polymarket_context("Fed rate cut in October?")` (or a slug/id) → current `yes_prob`, `change_24h`, and the primary-source events in the last 48h that match the question, with `tier`, `corroboration`, `relevance`. The signal is a fresh primary event the market has not repriced. Combine with `explain(event_id)` when the direction matters.

## Reading the output

- `direction`: `1` supportive, `-1` negative, `0` unclear. `confidence` (0..1) = source tier × severity/novelty × graph-path weight — a ranking signal, **not a probability**.
- `severity` (0..1) is event magnitude; `novelty` (0..1) drops for repeated/corroborating items.
- `corroboration.count` = how many independent sources reported it. Primary sources (SEC, Fed, USGS) originate events; media only corroborates.
- `path` shows the exposure-graph route (e.g. `nat.quake → facility:TSMC-Fab18 → company:TSM → company:NVDA`).
- `universe_version` is stamped on every response; use it to make backtests reproducible.

## Paying

- **Free trial:** send header `X-Free-Trial: 1` on REST for **100 free calls/day per IP** (MCP `tools/call` gets it automatically). Without it, priced routes return HTTP `402` with x402 v2 requirements (USDC on Base, `eip155:8453`). Any x402 client (`@x402/fetch`, `x402-axios`, Coinbase AgentKit) pays automatically.
- **Prepaid key, no human:** `POST /v1/keys/x402/pack_1k` (answer the 402 with USDC) → `{ api_key }` with 1,000 calls, lifetime. Also `pack_10k` ($40) and `pack_100k` ($300). Check balance: `GET /v1/keys/me` with `X-API-KEY`.
- **Card (for the human operator):** `GET /v1/plans` → Stripe checkout → key.
- Send the key as header `X-API-KEY` on `/v1/*` or `POST /mcp`.

## Examples

SDKs (pay the 402 automatically or send the key): `npm i @degenscan/intel` → `new Intel({ privateKey })`, `pip install degenscan-intel` → `Intel(private_key=...)`.


REST:
```bash
curl 'https://intel.degenscan.io/v1/events?since=4h&universe=NVDA,TSM,BTC&min_confidence=0.4'
curl 'https://intel.degenscan.io/v1/impact/MSTR?since=24h'
curl 'https://intel.degenscan.io/v1/graph/NVDA?depth=2'
curl  https://intel.degenscan.io/v1/regime
```

MCP `tools/call`:
```json
{ "name": "events_since", "arguments": { "since": "4h", "universe": ["NVDA","BTC","CL"], "min_confidence": 0.4, "limit": 30 } }
```

Claude Desktop / Cursor config (remote MCP):
```json
{ "mcpServers": { "degenscan-intel": { "url": "https://intel.degenscan.io/mcp", "headers": { "X-API-KEY": "<optional>" } } } }
```

## Limits and honesty

- Coverage is US-equity-heavy (top-100 by volume + indices), 15 crypto, main commodities/FX/rates. Not every ticker exists — check `universe`.
- Impacts are heuristics over public events; there is no price data in the feed and no forecast. **Information and analytics only — not investment advice.**
- Sources marked best-effort in `sources_status` may go quiet; the feed degrades gracefully.
