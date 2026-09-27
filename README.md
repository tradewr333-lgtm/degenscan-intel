# degenscan-intel

**Cross-asset event intelligence for autonomous agents.** One normalized feed of everything that moves prices — natural events, regulators, central banks, federal rules, corporate filings, trading halts, on-chain shocks, prediction-market shifts — scored against an exposure graph into per-asset impacts, and sold **per call in USDC via [x402](https://x402.org)** or by API key.

> Agents don't want a 3D globe. They want `events_since("4h", universe=["NVDA","BTC","CL"])` for half a cent.

Spec and rationale: [`docs/SPEC.md`](docs/SPEC.md).

## Quick start

```bash
npm install                     # Node ≥ 22.13 required (node:sqlite)
cp .env.example .env            # optional; runs keyless in free mode by default
npm run probe                   # hit every connector once, dry-run, report reachability + sample scored events
npm run dev                     # ingest scheduler + MCP (POST /mcp) + REST (/v1) on :8787
```

```bash
curl 'localhost:8787/v1/events?since=4h&universe=NVDA,TSM,BTC&min_confidence=0.2'
curl  localhost:8787/v1/impact/NVDA?since=24h
curl  localhost:8787/v1/graph/MSTR
curl  localhost:8787/v1/regime
curl  localhost:8787/v1/sources
```

MCP (streamable HTTP, stateless): `POST http://host:8787/mcp`. Stdio for local agents: `npm run mcp:stdio`.

## What's inside

| Layer | File(s) | Notes |
|---|---|---|
| Schema | `src/schema.ts` | `Event`, `Impact`, `Asset`, `Universe` (zod) — the contract agents consume |
| Universe | `src/universe/` | ~110 curated equities (tags: sector/hq/rev/input/reg/theme) + ETFs, indices, 15 crypto, commodities, FX, rates. Daily top-100-by-volume refresh (Nasdaq screener → Yahoo fallback → seed) |
| Exposure graph | `src/graph/` | ~230 curated edges + tag-derived edges + 30 critical facilities with lat/lng (fabs, ports, straits, refineries). `propagate()` = weighted BFS depth 3 |
| Engine | `src/engine/` | entity linking (tickers, names, countries, regulators, commodities, themes, geo→facility), deterministic direction inference, session calendar (`tradable_now`, `next_open`, US holidays) |
| Connectors | `src/ingest/connectors/` | **40 keyless sources**: USGS, GDACS, EONET, NHC, NWS, SWPC · SEC EFTS 8-K by item, EDGAR Atom (Form 4/13D/S-1), SEC/Fed/ECB/BoE/BoJ press, Fed speeches, **Federal Register API**, FTC, DOJ, FDA, CFTC, FCC, White House, EU Commission, CISA KEV, OFAC, TreasuryDirect · Nasdaq halts, Nasdaq earnings, PR Newswire, Business Wire, GlobeNewswire, Google News per ticker, NHTSA · DefiLlama hacks + stablecoin supply, CoinGecko abnormal moves, Binance announcements, Coinbase status, mempool fees, Polymarket, GDELT DOC |
| Store | `src/store/db.ts` | SQLite via `node:sqlite` (built into Node ≥ 22.13, zero native builds) + FTS5; cross-source corroboration by title fingerprint; per-asset impact index; source health; billing log |
| Server | `src/server/` | Fastify REST + MCP; `x402.ts` payment gate (402 → verify → settle via facilitator), API keys, free daily quota; `pricing.ts` |

## Tools & pricing

| Tool | Price | What it answers |
|---|---|---|
| `events_since` | $0.005 | what happened since *t* that touches my universe (past *t* = backtest) |
| `impact_for` | $0.003 | net directional pressure on one asset + source events |
| `exposure_graph` | $0.002 | who/what an asset is exposed to |
| `regime_snapshot` | $0.01 | venues open, 24h pressure ranking, high-severity events, prediction markets |
| `explain` | $0.02 | rationale for one event |
| `universe`, `sources_status` | free | discovery & transparency |

Free quota: 100 calls/day/IP without payment. Then `402` with x402 requirements, or `X-API-KEY`.

## Configuration

See `.env.example`. Nothing is required to run. For paid mode set `X402_PAY_TO` (Base address) and, for Base mainnet, a facilitator that supports it (Coinbase CDP or self-hosted). `INTEL_UA` **must** include a contact e-mail — SEC blocks anonymous clients.

## Deploy (Render)

`render.yaml` defines one web service (server + scheduler in-process, persistent disk for SQLite). `Dockerfile` for anywhere else.

## Design principles

1. **Primary sources first.** SEC, Fed, USGS, Nasdaq before any news site. Media is corroboration (`corroboration.count`), never origin.
2. **Deterministic hot path.** No LLM between event and impact — latency < 200 ms, cost ≈ 0. `explain` is the only place a model may be used.
3. **Everything auditable.** `raw_ref` points at the source document; `path` shows the graph route; `sources_status` is public.
4. **Universe is versioned.** Every response carries `universe_version` so backtests are reproducible.
5. **Legal by construction.** Only public/government/issuer data; no real-time equity quote redistribution; unofficial APIs (Nasdaq, Yahoo, Reddit) isolated as best-effort connectors.

## Roadmap

See SPEC §8. Next: deploy + live probe → real x402 settlement → registries (Smithery, Glama, x402 Bazaar) → 10-K-driven graph expansion → webhooks → Degenscan bot integration.

## Credits

Event-source ideas and the supplier-overlay concept trace to [OSIRIS](https://github.com/simplifaisoul/osiris) by simplifaisoul (MIT). This project shares no code with it and no UI; it is the data/agent layer OSIRIS never had.

License: MIT — © 2026 Edutech Wise FZCO / degenscan.io
