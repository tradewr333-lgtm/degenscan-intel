# @degenscan/intel

Market-event intelligence for AI trading agents, paid per call in USDC (x402) or with an API key.

One normalized feed of price-moving events from ~40 primary sources — SEC EDGAR (8-K, Form 4, 13D), Federal Reserve, Federal Register, ECB/BoE/BoJ, FTC/DOJ/FDA/CFTC/FCC, USGS earthquakes, NOAA/NHC storms, Nasdaq halts, DefiLlama hacks, Polymarket odds, Hyperliquid perps — scored against an exposure graph into per-asset impacts (`direction`, `confidence`, `path`). Deterministic, sub-200 ms, every event links to its source document.

- Service: `https://intel.degenscan.io` · MCP: `POST https://intel.degenscan.io/mcp` · OpenAPI: `/openapi.json` · Docs for LLMs: `/llms.txt`
- Prices: $0.001–$0.02 per call (brief $0.10). No subscription needed. Free trial: 100 calls/day/IP.
- Operator: Marbella Collins LLC · MIT · Information and analytics only — not investment advice.

## Install

```bash
npm i @degenscan/intel
```

## 20-line trading-agent loop

```ts
import { Intel } from "@degenscan/intel";

// Pick ONE:
const intel = new Intel({ privateKey: process.env.AGENT_WALLET_PK }); // pays USDC on Base per call via x402 (HTTP 402 → sign → 200)
// const intel = new Intel({ apiKey: process.env.INTEL_API_KEY });    // prepaid pack or Stripe plan
// const intel = new Intel();                                          // free trial, 100 calls/day

const book = ["BTC", "ETH", "NVDA", "MSTR", "CL"];

setInterval(async () => {
  const p = await intel.pulse();                                        // $0.001 — anything new in the last hour?
  if (p.high_severity === 0) return;

  const { events } = await intel.eventsSince({ since: "4h", universe: book, min_confidence: 0.4 }); // $0.005
  for (const e of events) {
    for (const imp of e.impacts.filter(i => book.includes(i.asset_id) && i.confidence >= 0.5)) {
      const brief = await intel.brief(imp.asset_id);                    // $0.10 — pressure, headlines, filings, derivatives, catalysts
      if (!brief.tradable_now.length) continue;                         // venue closed → wait for next_open
      const d = imp.asset_id === "BTC" || imp.asset_id === "ETH" ? await intel.derivsFor(imp.asset_id) : null; // $0.003 — funding/OI/premium
      console.log(imp.asset_id, imp.direction > 0 ? "LONG bias" : "SHORT bias", imp.confidence, e.title, d?.flags);
      // → your execution logic here
    }
  }
}, 60 * 60 * 1000);
```

## Buy a prepaid key with USDC (no human, no card)

```ts
const intel = new Intel({ privateKey: process.env.AGENT_WALLET_PK });
const { api_key } = await intel.buyPack("pack_1k");   // $5 USDC → 1,000 calls, lifetime. Also pack_10k ($40), pack_100k ($300)
const cheap = new Intel({ apiKey: api_key });          // no per-call signatures from here on
await cheap.keyStatus();                               // { calls_used, calls_left, ... }
```

## Methods

| Method | REST | Price | Returns |
|---|---|---|---|
| `pulse()` | `GET /v1/pulse` | $0.001 | event counts last hour by class, high-severity count, venues open |
| `eventsSince({since, universe, min_confidence, limit})` | `GET /v1/events` | $0.005 | events with per-asset impacts, `tradable_now`, `next_open` |
| `impactFor(asset, {since})` | `GET /v1/impact/{asset}` | $0.003 | net bias on one asset + driving events |
| `exposureGraph(asset, depth)` | `GET /v1/graph/{asset}` | $0.002 | suppliers, countries, commodities, regulators, indices |
| `regime()` | `GET /v1/regime` | $0.01 | venues open, 24h pressure by asset, top events, prediction markets |
| `explain(eventId)` | `GET /v1/explain/{id}` | $0.02 | reasoning behind one impact |
| `polymarket(market)` | `GET /v1/polymarket/{market}` | $0.01 | current odds + primary events that bear on the question |
| `newsFor(ticker)` | `GET /v1/news/{ticker}` | $0.002 | headlines with tier, corroboration, sentiment |
| `filingsFor(ticker, {forms})` | `GET /v1/filings/{ticker}` | $0.002 | 8-K, Form 4, 13D/G, S-1 |
| `calendar({days, types})` | `GET /v1/calendar` | $0.002 | FOMC, CPI, NFP, PCE, GDP, earnings, auctions |
| `derivsFor(symbol)` | `GET /v1/derivs/{symbol}` | $0.003 | Hyperliquid funding (1h/8h/annualized), predicted funding by venue, OI, premium, 24h volume, flags |
| `brief(asset)` | `GET /v1/brief/{asset}` | $0.10 | everything above for one asset in one call |
| `universe()`, `sources()`, `health()`, `plans()`, `packs()` | — | free | coverage, connector status, card plans, USDC packs |

Every paid response carries `_billing: { tool, price_usd, method }`; x402 responses also carry `_payment_response` (settlement receipt with tx hash).

## How payment works (x402)

1. Agent calls a priced route → server answers **HTTP 402** with `PAYMENT-REQUIRED` (USDC on Base `eip155:8453` or Solana, amount, payTo).
2. `@degenscan/intel` (via `@x402/fetch`) signs an EIP-3009 USDC transfer with your wallet — gas is paid by the facilitator (Coinbase CDP / PayAI).
3. The request is retried with the signature → **200** + data + `PAYMENT-RESPONSE` (tx hash).

Use a dedicated agent wallet with a few USDC. Never your main wallet.

## Reading the output

- `direction`: `1` supportive, `-1` negative, `0` unclear. `confidence` (0..1) = source tier × severity/novelty × graph-path weight — a ranking signal, **not a probability**.
- `corroboration.count` = independent sources. Primary sources (SEC, Fed, USGS) originate events; media only corroborates.
- `path` shows the exposure route, e.g. `nat.quake → facility:TSMC-Fab18 → company:TSM → company:NVDA`.
- `universe_version` is stamped on every response for reproducible backtests.

## Also available as

- **MCP server** (Claude Code, Cursor, OpenClaw): `{ "mcpServers": { "degenscan-intel": { "url": "https://intel.degenscan.io/mcp" } } }`
- **Agent skill**: `npx skills add tradewr333-lgtm/degenscan-intel`
- **Python**: `pip install degenscan-intel`
- **Public metrics** (paying wallets, tx hashes, operator wallets excluded): `https://intel.degenscan.io/v1/metrics`

## Limits

US-equity-heavy coverage (top-100 by volume + indices), 15 crypto, main commodities/FX/rates — check `universe()`. No price data, no forecasts. Liquidations are not part of `derivsFor`. Sources marked best-effort in `sources()` may go quiet.

MIT © Marbella Collins LLC · contact@degenscan.io
