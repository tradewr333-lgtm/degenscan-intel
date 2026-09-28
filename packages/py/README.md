# degenscan-intel

Market-event intelligence for AI trading agents, paid per call in USDC (x402) or with an API key.

One normalized feed of price-moving events from ~40 primary sources — SEC EDGAR (8-K, Form 4, 13D), Federal Reserve, Federal Register, ECB/BoE/BoJ, FTC/DOJ/FDA/CFTC/FCC, USGS earthquakes, NOAA/NHC storms, Nasdaq halts, DefiLlama hacks, Polymarket odds, Hyperliquid perps — scored against an exposure graph into per-asset impacts (`direction`, `confidence`, `path`). Deterministic, sub-200 ms, every event links to its source document.

- Service: `https://intel.degenscan.io` · MCP: `POST https://intel.degenscan.io/mcp` · OpenAPI: `/openapi.json` · Docs for LLMs: `/llms.txt`
- Prices: $0.001–$0.02 per call (brief $0.10). No subscription needed. Free trial: 100 calls/day/IP.
- Operator: Marbella Collins LLC · MIT · Information and analytics only — not investment advice.

## Install

```bash
pip install degenscan-intel            # API key / free trial
pip install "degenscan-intel[x402]"    # + per-call USDC payments from an agent wallet
```

## 20-line trading-agent loop

```python
import os, time
from degenscan_intel import Intel

# Pick ONE:
intel = Intel(private_key=os.environ["AGENT_WALLET_PK"])   # pays USDC on Base per call via x402 (HTTP 402 -> sign -> 200)
# intel = Intel(api_key=os.environ["INTEL_API_KEY"])       # prepaid pack or Stripe plan
# intel = Intel()                                          # free trial, 100 calls/day

book = ["BTC", "ETH", "NVDA", "MSTR", "CL"]

while True:
    p = intel.pulse()                                                    # $0.001 — anything new in the last hour?
    if p["high_severity"]:
        for e in intel.events_since(since="4h", universe=book, min_confidence=0.4)["events"]:   # $0.005
            for imp in (i for i in e["impacts"] if i["asset_id"] in book and i["confidence"] >= 0.5):
                brief = intel.brief(imp["asset_id"])                     # $0.10 — pressure, headlines, filings, derivatives, catalysts
                if not brief["tradable_now"]:
                    continue                                             # venue closed -> wait for next_open
                d = intel.derivs_for(imp["asset_id"]) if imp["asset_id"] in ("BTC", "ETH") else None   # $0.003 — funding/OI/premium
                print(imp["asset_id"], "LONG" if imp["direction"] > 0 else "SHORT", imp["confidence"], e["title"], d and d["flags"])
                # -> your execution logic here
    time.sleep(3600)
```

Async: `from degenscan_intel import AsyncIntel` — same methods, `await`ed.

## Buy a prepaid key with USDC (no human, no card)

```python
intel = Intel(private_key=os.environ["AGENT_WALLET_PK"])
key = intel.buy_pack("pack_1k")["api_key"]     # $5 USDC -> 1,000 calls, lifetime. Also pack_10k ($40), pack_100k ($300)
cheap = Intel(api_key=key)                      # no per-call signatures from here on
cheap.key_status()                              # {"calls_used": ..., "calls_left": ...}
```

## Methods

| Method | REST | Price | Returns |
|---|---|---|---|
| `pulse()` | `GET /v1/pulse` | $0.001 | event counts last hour by class, high-severity count, venues open |
| `events_since(since, universe, min_confidence, limit)` | `GET /v1/events` | $0.005 | events with per-asset impacts, `tradable_now`, `next_open` |
| `impact_for(asset, since)` | `GET /v1/impact/{asset}` | $0.003 | net bias on one asset + driving events |
| `exposure_graph(asset, depth)` | `GET /v1/graph/{asset}` | $0.002 | suppliers, countries, commodities, regulators, indices |
| `regime()` | `GET /v1/regime` | $0.01 | venues open, 24h pressure by asset, top events, prediction markets |
| `explain(event_id)` | `GET /v1/explain/{id}` | $0.02 | reasoning behind one impact |
| `polymarket(market)` | `GET /v1/polymarket/{market}` | $0.01 | current odds + primary events that bear on the question |
| `news_for(ticker)` | `GET /v1/news/{ticker}` | $0.002 | headlines with tier, corroboration, sentiment |
| `filings_for(ticker, forms=[...])` | `GET /v1/filings/{ticker}` | $0.002 | 8-K, Form 4, 13D/G, S-1 |
| `calendar(days, types)` | `GET /v1/calendar` | $0.002 | FOMC, CPI, NFP, PCE, GDP, earnings, auctions |
| `derivs_for(symbol)` | `GET /v1/derivs/{symbol}` | $0.003 | Hyperliquid funding (1h/8h/annualized), predicted funding by venue, OI, premium, 24h volume, flags |
| `brief(asset)` | `GET /v1/brief/{asset}` | $0.10 | everything above for one asset in one call |
| `universe()`, `sources()`, `health()`, `plans()`, `packs()` | — | free | coverage, connector status, card plans, USDC packs |

Every paid response carries `_billing: {tool, price_usd, method}`; x402 responses also carry `_payment_response` (settlement receipt with tx hash).

## How payment works (x402)

1. Agent calls a priced route → server answers **HTTP 402** with `PAYMENT-REQUIRED` (USDC on Base `eip155:8453` or Solana, amount, payTo).
2. The client (Coinbase's `x402` package) signs an EIP-3009 USDC transfer with your wallet — gas is paid by the facilitator (Coinbase CDP / PayAI).
3. The request is retried with the signature → **200** + data + `PAYMENT-RESPONSE` (tx hash).

Use a dedicated agent wallet with a few USDC. Never your main wallet.

## Reading the output

- `direction`: `1` supportive, `-1` negative, `0` unclear. `confidence` (0..1) = source tier × severity/novelty × graph-path weight — a ranking signal, **not a probability**.
- `corroboration.count` = independent sources. Primary sources (SEC, Fed, USGS) originate events; media only corroborates.
- `path` shows the exposure route, e.g. `nat.quake → facility:TSMC-Fab18 → company:TSM → company:NVDA`.
- `universe_version` is stamped on every response for reproducible backtests.

## Also available as

- **MCP server** (Claude Code, Cursor, OpenClaw): `{"mcpServers": {"degenscan-intel": {"url": "https://intel.degenscan.io/mcp"}}}`
- **Agent skill**: `npx skills add tradewr333-lgtm/degenscan-intel`
- **TypeScript/JavaScript**: `npm i @degenscan/intel`
- **Public metrics** (paying wallets, tx hashes, operator wallets excluded): `https://intel.degenscan.io/v1/metrics`

## Limits

US-equity-heavy coverage (top-100 by volume + indices), 15 crypto, main commodities/FX/rates — check `universe()`. No price data, no forecasts. Liquidations are not part of `derivs_for`. Sources marked best-effort in `sources()` may go quiet.

MIT © Marbella Collins LLC · contact@degenscan.io
