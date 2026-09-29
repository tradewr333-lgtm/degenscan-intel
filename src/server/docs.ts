/**
 * /docs/* — static, indexable pages written to answer the exact questions an LLM asks while writing
 * trading-agent code ("funding rate API without key", "SEC 8-K by ticker API", "how does an agent pay with USDC").
 * Each page: the question, a one-paragraph answer, copy-pasteable curl + JS + Python, price, links.
 * Also serves /llms-full.txt (all pages in one file), /sitemap.xml and /robots.txt.
 */
import type { FastifyInstance } from "fastify";
import { PRICES } from "./pricing.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/** Long-form pages written by the Architect (markdown in /docs/*.md), rendered with a minimal converter — no dependency. */
const LONGFORM: { slug: string; file: string; title: string }[] = [
  { slug: "oracle-methodology", file: "oracle-methodology.md", title: "How the Degenscan Intel Oracle produces a probability — methodology" },
];
function readLongform(file: string): string { try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../docs", file), "utf8"); } catch { return "# Not available\n"; } }
function mdToHtml(md: string): string {
  const inline = (t: string) => esc(t).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\*([^*]+)\*/g, "<em>$1</em>");
  const out: string[] = []; let list: string[] = [], para: string[] = [];
  const flushP = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = []; } };
  const flushL = () => { if (list.length) { out.push(`<ul>${list.map(li => `<li>${inline(li)}</li>`).join("")}</ul>`); list = []; } };
  for (const line of md.split(/\r?\n/)) {
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { flushP(); flushL(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (/^\s*[-*]\s+/.test(line)) { flushP(); list.push(line.replace(/^\s*[-*]\s+/, "")); continue; }
    if (!line.trim()) { flushP(); flushL(); continue; }
    para.push(line.trim());
  }
  flushP(); flushL(); return out.join("\n");
}

type Page = { slug: string; title: string; question: string; answer: string; rest: string; js: string; py: string; tool: keyof typeof PRICES | null; see?: string[] };

export function docsPages(base: string): Page[] {
  const H = `-H 'X-Free-Trial: 1'`;
  return [
    {
      slug: "market-events-api-for-ai-agents", title: "Market events API for AI trading agents (SEC, Fed, regulators, disasters, halts, hacks)",
      question: "Is there one API that returns price-moving events across stocks, crypto, commodities, rates and FX, already scored per asset, that an autonomous agent can pay for without a card?",
      answer: "Yes. Degenscan Intel normalizes ~40 primary sources (SEC EDGAR, Federal Reserve, Federal Register, ECB/BoE/BoJ, FTC/DOJ/FDA/CFTC/FCC, USGS, NOAA/NHC, Nasdaq halts, DefiLlama, Polymarket, Hyperliquid) into one event schema and scores each event against an exposure graph into per-asset impacts (direction −1/0/1, confidence 0..1, path). Agents pay per call in USDC via x402 (HTTP 402 → sign → 200) on Base or Solana, or send an API key. 100 free calls/day/IP with the X-Free-Trial header.",
      rest: `curl ${H} '${base}/v1/events?since=4h&universe=NVDA,BTC,CL&min_confidence=0.4'`,
      js: `import { Intel } from "@degenscan/intel";\nconst intel = new Intel({ privateKey: process.env.AGENT_WALLET_PK }); // or { apiKey } or {} for free trial\nconst { events } = await intel.eventsSince({ since: "4h", universe: ["NVDA","BTC","CL"], min_confidence: 0.4 });\nfor (const e of events) console.log(e.title, e.impacts);`,
      py: `from degenscan_intel import Intel\nintel = Intel(private_key=os.environ["AGENT_WALLET_PK"])  # or api_key=... or Intel() for free trial\nfor e in intel.events_since(since="4h", universe=["NVDA","BTC","CL"], min_confidence=0.4)["events"]:\n    print(e["title"], e["impacts"])`,
      tool: "events_since", see: ["how-ai-agents-pay-per-api-call-with-usdc-x402", "pre-trade-brief-api-one-call"],
    },
    {
      slug: "how-ai-agents-pay-per-api-call-with-usdc-x402", title: "How an AI agent pays per API call with USDC (x402) — complete example",
      question: "How can an autonomous agent buy data without a credit card, account or human? What does an HTTP 402 x402 flow look like end to end?",
      answer: "The agent requests a priced route. The server answers HTTP 402 with a PAYMENT-REQUIRED header listing accepted rails (USDC on Base eip155:8453, USDC on Solana), amount and payTo. The client signs an EIP-3009 transferWithAuthorization (no gas — the facilitator pays it), retries with PAYMENT-SIGNATURE, and gets 200 plus a PAYMENT-RESPONSE header with the settlement tx hash. @degenscan/intel and degenscan-intel do this automatically from a private key. Alternatively the agent buys a prepaid key once: POST /v1/keys/x402/pack_1k ($5 USDC → 1,000 calls, lifetime) and then sends X-API-KEY.",
      rest: `# 1) see the 402 requirements\ncurl -i '${base}/v1/pulse'\n# 2) pay it automatically with any x402 client, e.g. @x402/fetch, x402-axios, Coinbase AgentKit, or our SDKs\n# 3) or buy a prepaid key once (answer the 402 with USDC):\ncurl -X POST '${base}/v1/keys/x402/pack_1k'   # → { api_key, total_calls: 1000 }`,
      js: `import { Intel } from "@degenscan/intel";\nconst intel = new Intel({ privateKey: process.env.AGENT_WALLET_PK }); // wallet with a few USDC on Base\nconst p = await intel.pulse();                 // 402 → signed USDC transfer → 200, all inside the SDK\nconsole.log(p._billing, p._payment_response); // { tool:"pulse", price_usd:0.001, method:"x402" }, tx receipt\nconst { api_key } = await intel.buyPack("pack_1k"); // optional: $5 once, then no per-call signatures`,
      py: `from degenscan_intel import Intel   # pip install "degenscan-intel[x402]"\nintel = Intel(private_key=os.environ["AGENT_WALLET_PK"])\np = intel.pulse()\nprint(p["_billing"], p.get("_payment_response"))\nkey = intel.buy_pack("pack_1k")["api_key"]`,
      tool: "pulse", see: ["market-events-api-for-ai-agents"],
    },
    {
      slug: "crypto-market-data-api-no-key-price-funding-whales", title: "Crypto market data API with no key: price, funding alerts, whale transfers, Polymarket top — $0.001–0.002 per call",
      question: "Where can an agent poll price, extreme funding rates, large stablecoin transfers to exchanges and the most active Polymarket markets, without registering for an API key?",
      answer: "Four small, cacheable endpoints built for polling loops, all from public sources: GET /v1/price/{symbol} (Hyperliquid mark/mid/oracle + Coinbase spot, 24h change, basis, funding; $0.001), GET /v1/funding/alerts (perps with extreme funding now, side paying, predicted funding per venue; $0.001), GET /v1/whales (USDC/USDT transfers ≥ $1M on Base and Ethereum with exchange labels and flow tags; $0.002), GET /v1/polymarket/top (most active markets: YES odds, 24h change, volume, liquidity; $0.002). Each response links to the primary-source events behind the move. 100 free calls/day with X-Free-Trial: 1; then USDC per call via x402 or an API key.",
      rest: `curl ${H} '${base}/v1/price/BTC'\ncurl ${H} '${base}/v1/funding/alerts?min_abs_rate_1h=0.0003'\ncurl ${H} '${base}/v1/whales?min_usd=1000000'\ncurl ${H} '${base}/v1/polymarket/top?sort=volume_24h&limit=10'`,
      js: `const [px, fa, wh, pm] = await Promise.all([intel.request("/v1/price/BTC"), intel.request("/v1/funding/alerts"), intel.request("/v1/whales", { query: { min_usd: 1_000_000 } }), intel.request("/v1/polymarket/top", { query: { sort: "volume_24h" } })]);\nconsole.log(px.perp.mark, fa.alerts[0], wh.totals_usd, pm.markets[0]);`,
      py: `px = intel.request("/v1/price/BTC"); fa = intel.request("/v1/funding/alerts")\nwh = intel.request("/v1/whales", query={"min_usd": 1_000_000}); pm = intel.request("/v1/polymarket/top", query={"sort": "volume_24h"})\nprint(px["perp"]["mark"], fa["alerts"][:1], wh["totals_usd"], pm["markets"][:1])`,
      tool: "price_for", see: ["funding-rate-open-interest-api-without-api-key", "polymarket-odds-plus-primary-events-api"],
    },
    {
      slug: "funding-rate-open-interest-api-without-api-key", title: "Funding rate, open interest and premium API without an API key (Hyperliquid perps)",
      question: "Where can an agent get perp funding rates, predicted funding across venues, open interest and premium vs oracle for BTC/ETH/SOL without registering for Coinglass or an exchange key?",
      answer: "GET /v1/derivs/{symbol} returns Hyperliquid's public perp microstructure for one coin — hourly funding with 8h-equivalent and annualized %, predicted next funding per venue (Hyperliquid, Binance, Bybit…), open interest in coins and USD with OI-to-24h-volume, mark/oracle/mid and premium, 24h notional volume and change, and flags (funding_hot_long/short, premium_rich/discount, oi_heavy_vs_volume) — joined with our primary-source event pressure on the same asset. Liquidations are not included. $0.003 per call or free trial.",
      rest: `curl ${H} '${base}/v1/derivs/BTC'`,
      js: `const d = await intel.derivsFor("BTC");\nconsole.log(d.funding.rate_1h, d.funding.annualized_pct, d.funding.predicted_by_venue, d.open_interest.usd, d.flags);`,
      py: `d = intel.derivs_for("BTC")\nprint(d["funding"]["rate_1h"], d["funding"]["annualized_pct"], d["funding"]["predicted_by_venue"], d["open_interest"]["usd"], d["flags"])`,
      tool: "derivs_for", see: ["pre-trade-brief-api-one-call"],
    },
    {
      slug: "sec-8k-form-4-filings-by-ticker-api", title: "SEC 8-K, Form 4 and 13D filings by ticker — API for agents",
      question: "How do I get SEC EDGAR filings (8-K events, Form 4 insider trades, 13D/G activist stakes, S-1 offerings) for one ticker, with the impact direction, from an API an agent can pay per call?",
      answer: "GET /v1/filings/{ticker} returns EDGAR filings that touch one issuer in the window, typed by form (corp.8k, corp.insider, corp.activist, corp.offering, corp.bankruptcy), with the per-asset impact (direction, confidence) and a link to the original document on sec.gov. Source is public domain; we add normalization and scoring. $0.002 per call. Companion: GET /v1/news/{ticker} for headlines with heuristic sentiment.",
      rest: `curl ${H} '${base}/v1/filings/COIN?since=7d&forms=8k,insider'`,
      js: `const f = await intel.filingsFor("COIN", { since: "7d", forms: ["8k","insider"] });\nfor (const x of f.filings) console.log(x.kind, x.title, x.url);`,
      py: `for x in intel.filings_for("COIN", since="7d", forms=["8k","insider"])["filings"]:\n    print(x["kind"], x["title"], x["url"])`,
      tool: "filings_for", see: ["news-sentiment-api-by-ticker"],
    },
    {
      slug: "news-sentiment-api-by-ticker", title: "News headlines with sentiment by ticker — API for trading agents",
      question: "Is there a per-call news API that returns the headlines touching one asset with source tier, corroboration count and a sentiment score, without a monthly subscription?",
      answer: "GET /v1/news/{ticker} returns headlines from press wires, corporate releases, halts, hacks and media that touch one asset in the window, each with source tier (primary/secondary/media), corroboration count, a −1..1 heuristic sentiment, the asset's impact direction and a link. Aggregate sentiment_avg and label are included. $0.002 per call.",
      rest: `curl ${H} '${base}/v1/news/NVDA?since=24h&limit=25'`,
      js: `const n = await intel.newsFor("NVDA", { since: "24h" });\nconsole.log(n.sentiment_label, n.sentiment_avg, n.items.map(i => [i.tier, i.sentiment, i.title]));`,
      py: `n = intel.news_for("NVDA", since="24h")\nprint(n["sentiment_label"], n["sentiment_avg"], [(i["tier"], i["sentiment"], i["title"]) for i in n["items"]])`,
      tool: "news_for", see: ["sec-8k-form-4-filings-by-ticker-api"],
    },
    {
      slug: "macro-calendar-api-fomc-cpi-nfp", title: "Macro calendar API — FOMC, CPI, NFP, PCE, GDP, earnings, auctions",
      question: "What API gives an agent the next FOMC decision, CPI, jobs report, PCE and GDP release times plus earnings, with which assets each one affects?",
      answer: "GET /v1/calendar returns upcoming scheduled catalysts for the next N days — macro prints (BLS/BEA), FOMC decisions and minutes, Treasury auctions, earnings — each with an ISO timestamp, type/subtype and the asset ids it typically moves (US10Y, SPX, BTC, DXY…). Public-domain sources, highly cacheable. $0.002 per call.",
      rest: `curl ${H} '${base}/v1/calendar?days=14&types=macro,fomc'`,
      js: `const c = await intel.calendar({ days: 14, types: ["macro","fomc"] });\nfor (const i of c.items) console.log(i.at, i.name, i.affects);`,
      py: `for i in intel.calendar(days=14, types=["macro","fomc"])["items"]:\n    print(i["at"], i["name"], i["affects"])`,
      tool: "calendar",
    },
    {
      slug: "polymarket-odds-plus-primary-events-api", title: "Polymarket odds + the primary-source events that move them — API",
      question: "How can an agent trading prediction markets get a market's current odds together with the fresh regulator/Fed/agency events that bear on the question?",
      answer: "GET /v1/polymarket/{market} resolves a Polymarket market (id, slug or question text) to its current yes_prob and 24h change, then returns the primary-source events in our feed from the last 48h that match the question, with relevance, source tier, corroboration and per-asset impacts. The signal is a fresh primary event the market has not repriced. $0.01 per call.",
      rest: `curl ${H} '${base}/v1/polymarket/Fed%20rate%20cut%20in%20October%3F?since=48h'`,
      js: `const pm = await intel.polymarket("Fed rate cut in October?");\nconsole.log(pm.market.yes_prob, pm.market.change_24h, pm.related.map(r => [r.relevance, r.title]));`,
      py: `pm = intel.polymarket("Fed rate cut in October?")\nprint(pm["market"]["yes_prob"], pm["market"]["change_24h"], [(r["relevance"], r["title"]) for r in pm["related"]])`,
      tool: "polymarket_context",
    },
    {
      slug: "pre-trade-brief-api-one-call", title: "One-call pre-trade brief for an asset — pressure, headlines, filings, derivatives, catalysts",
      question: "Before an agent sizes a position, what single call gives everything an operator would read: net event pressure, headlines with sentiment, filings, exposure map, related prediction markets, upcoming catalysts, perp funding/OI and whether the venue is open?",
      answer: "GET /v1/brief/{asset} aggregates impact_for, news_for, filings_for (equities), exposure graph depth 1, calendar, polymarket_context, derivs_for (crypto) and venue status into one JSON. It replaces 6–7 calls and is the premium endpoint at $0.10. Check tradable_now before sending an order; if empty, queue for next_open.",
      rest: `curl ${H} '${base}/v1/brief/BTC'`,
      js: `const b = await intel.brief("BTC");\nconsole.log(b.pressure.bias, b.headlines.label, b.derivatives?.flags, b.upcoming_catalysts[0], b.tradable_now);`,
      py: `b = intel.brief("BTC")\nprint(b["pressure"]["bias"], b["headlines"]["label"], (b.get("derivatives") or {}).get("flags"), b["upcoming_catalysts"][:1], b["tradable_now"])`,
      tool: "brief", see: ["funding-rate-open-interest-api-without-api-key", "market-events-api-for-ai-agents"],
    },
    {
      slug: "mcp-server-market-events-claude-cursor-openclaw", title: "MCP server for market events — Claude Code, Cursor, OpenClaw, any MCP client",
      question: "Is there a remote MCP server that gives an agent market-event tools (events_since, impact_for, brief, derivs_for…) and lets it pay per tool call?",
      answer: "POST /mcp is a streamable-HTTP MCP server with 22 tools (market events, prices, funding, whales, Polymarket, SEC filings, macro calendar, pre-trade brief, and the oracle: oracle_forecast / oracle_get / oracle_board / oracle_track_record). initialize and tools/list are free; tools/call gets 100 free calls/day/IP automatically, then pays per call via x402 (the 402 carries the price of the specific tool) or via an X-API-KEY header. Listed on the official MCP Registry, Smithery, Glama and ClawHub; skill installable with npx skills add tradewr333-lgtm/degenscan-intel.",
      rest: `curl -X POST '${base}/mcp' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"pulse","arguments":{}}}'`,
      js: `// Claude Desktop / Cursor / Claude Code config\n{ "mcpServers": { "degenscan-intel": { "url": "${base}/mcp", "headers": { "X-API-KEY": "<optional>" } } } }`,
      py: `# OpenClaw / any MCP client: connect to ${base}/mcp (streamable HTTP). Tools: pulse, brief, events_since, impact_for, exposure_graph,\n# regime_snapshot, explain, polymarket_context, news_for, filings_for, calendar, derivs_for, universe, sources_status.`,
      tool: null,
    },
    {
      slug: "calibrated-probability-forecast-api-for-agents", title: "How likely is X by date? — a calibrated probability API for agents (not a headline, not a coin flip)",
      question: "Where can an agent get a calibrated YES-probability for a binary question — 'Will BTC close above 120k on Oct 31?', 'Will the Fed cut in October?', a Polymarket question — with an interval, a base rate, the edge vs. the market and a public track record?",
      answer: `POST /v1/oracle/forecast ($${PRICES.oracle_forecast}, async) runs the 2Realidade oracle inside Intel: it first assembles live context (spot, 30-day realized volatility, funding, open interest, Polymarket odds, macro calendar, recent primary-source events) and computes a volatility base rate — what the market's own vol implies with zero directional view. Then it simulates several LLM agent societies (distinct personas, social graph, optional news shocks) and convenes a five-forecaster panel anchored on that base rate; a reasoning model aggregates with one rule: 0.5 is never a default. You get 202 + forecast_id at once; poll GET /v1/oracle/forecast/{id} (free) for 1–3 minutes. The result carries probability, ci80, disagreement, base_rate, market_odds, edge, drivers, failure_modes, confidence, every run's belief trajectory, the panel, and a sha256 commitment hash written before resolution. GET /v1/oracle/board ($${PRICES.oracle_board}) is the daily set of standing questions (BTC/ETH/SOL vs targets, next FOMC, top Polymarket markets) with no waiting. GET /v1/oracle/track-record (free) is the public Brier score, overall and vs. the market.`,
      rest: `curl -X POST ${H} '${base}/v1/oracle/forecast' -H 'content-type: application/json' \\\n  -d '{"question":"Will Bitcoin close above 120,000 USD on 2026-10-31?","resolves_at":"2026-10-31T23:59:00Z"}'\n# → 202 { forecast_id, poll }\ncurl '${base}/v1/oracle/forecast/<forecast_id>'      # free; repeat until status = done\ncurl ${H} '${base}/v1/oracle/board'                  # daily standing forecasts, $0.002\ncurl '${base}/v1/oracle/track-record'                # public Brier record, free`,
      js: `const job = await intel.oracleForecast({ question: "Will Bitcoin close above 120,000 USD on 2026-10-31?", resolves_at: "2026-10-31T23:59:00Z" });\nconst f = await intel.oracleWait(job.forecast_id);   // polls every 20 s (free) until done\nconsole.log(f.probability, f.ci80, f.base_rate, f.market_odds, f.edge, f.commitment_hash);\nconst board = await intel.oracleBoard();            // $0.002: standing forecasts, no waiting`,
      py: `job = intel.oracle_forecast("Will Bitcoin close above 120,000 USD on 2026-10-31?", resolves_at="2026-10-31T23:59:00Z")\nf = intel.oracle_wait(job["forecast_id"])          # polls (free) until done\nprint(f["probability"], f["ci80"], f["base_rate"], f["edge"], f["commitment_hash"])\nboard = intel.oracle_board()                       # $0.002`,
      tool: "oracle_forecast", see: ["polymarket-odds-plus-primary-events-api", "how-ai-agents-pay-per-api-call-with-usdc-x402"],
    },
  ];
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const STYLE = `body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#111}pre{background:#f5f5f5;padding:.8rem;overflow:auto;border-radius:6px;font-size:14px}code{font-family:ui-monospace,Menlo,Consolas,monospace}h1{font-size:1.6rem}small{color:#555}nav a{margin-right:.8rem}footer{margin-top:3rem;color:#555;font-size:14px}`;

function pageHtml(p: Page, base: string, all: Page[]) {
  const price = p.tool ? `$${PRICES[p.tool]} per call · free trial 100/day with X-Free-Trial: 1` : "initialize/tools/list free · tools/call priced per tool";
  const see = (p.see ?? []).map(s => all.find(x => x.slug === s)).filter(Boolean).map(x => `<li><a href="/docs/${x!.slug}">${esc(x!.title)}</a></li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(p.title)} — Degenscan Intel</title><meta name="description" content="${esc(p.answer.slice(0, 300))}"><link rel="canonical" href="${base}/docs/${p.slug}"><link rel="icon" href="/favicon.ico"><style>${STYLE}</style>
<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: p.question, acceptedAnswer: { "@type": "Answer", text: p.answer } }] })}</script></head><body>
<nav><a href="/">Degenscan Intel</a><a href="/docs">Docs</a><a href="/openapi.json">OpenAPI</a><a href="/llms.txt">llms.txt</a><a href="/skill.md">Agent skill</a><a href="https://github.com/tradewr333-lgtm/degenscan-intel">GitHub</a></nav>
<h1>${esc(p.title)}</h1><p><strong>${esc(p.question)}</strong></p><p>${esc(p.answer)}</p><p><small>Price: ${esc(price)}. Pay in USDC (Base or Solana) via x402, or send X-API-KEY.</small></p>
<h2>curl</h2><pre><code>${esc(p.rest)}</code></pre>
<h2>JavaScript / TypeScript — <code>npm i @degenscan/intel</code></h2><pre><code>${esc(p.js)}</code></pre>
<h2>Python — <code>pip install degenscan-intel</code></h2><pre><code>${esc(p.py)}</code></pre>
${see ? `<h2>See also</h2><ul>${see}</ul>` : ""}
<footer>Operator: Marbella Collins LLC · contact@degenscan.io · MIT · Information and analytics only — not investment advice. Public metrics: <a href="/v1/metrics">/v1/metrics</a> · Our own wallets (excluded): <a href="/wallets.json">/wallets.json</a></footer></body></html>`;
}

export function installDocs(app: FastifyInstance, base: string) {
  const pages = docsPages(base);
  app.get("/docs", async (_req, reply) => reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Docs — Degenscan Intel: market-event API for AI trading agents</title><link rel="icon" href="/favicon.ico"><style>${STYLE}</style></head><body><nav><a href="/">Degenscan Intel</a><a href="/openapi.json">OpenAPI</a><a href="/llms.txt">llms.txt</a><a href="/llms-full.txt">llms-full.txt</a></nav><h1>Degenscan Intel — docs for agents and the models that write them</h1><p>Each page answers one question with copy-pasteable curl, JavaScript and Python. Pay per call in USDC (x402) or with an API key; 100 free calls/day/IP.</p><ul>${pages.map(p => `<li><a href="/docs/${p.slug}">${esc(p.title)}</a></li>`).join("")}${LONGFORM.map(l => `<li><a href="/docs/${l.slug}">${esc(l.title)}</a></li>`).join("")}</ul><footer>Marbella Collins LLC · MIT · not investment advice</footer></body></html>`));
  for (const p of pages) app.get(`/docs/${p.slug}`, async (_req, reply) => reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=3600").send(pageHtml(p, base, pages)));
  for (const lf of LONGFORM) app.get(`/docs/${lf.slug}`, async (_req, reply) => {
    const md = readLongform(lf.file);
    reply.type("text/html; charset=utf-8").header("cache-control", "public, max-age=3600").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(lf.title)} — Degenscan Intel</title><meta name="description" content="How the oracle grounds a question in live data, computes a volatility base rate, simulates agent societies and an expert panel, aggregates, commits a hash and publishes its Brier score."><link rel="canonical" href="${base}/docs/${lf.slug}"><link rel="icon" href="/favicon.ico"><style>${STYLE}</style></head><body><nav><a href="/">Degenscan Intel</a><a href="/docs">Docs</a><a href="/v1/oracle/track-record">Track record</a><a href="/docs/calibrated-probability-forecast-api-for-agents">Oracle API</a></nav><article>${mdToHtml(md)}</article><footer>Marbella Collins LLC · MIT · Information and analytics only — not investment advice</footer></body></html>`);
  });
  // Public record of the Lote-1 commitments made by the Python v0.2 engine (imported into the ledger via Push D).
  app.get("/docs/lote1-v0.2.json", async (_req, reply) => reply.type("application/json").send(readLongform("lote1-v0.2.json")));
  for (const lf of LONGFORM) app.get(`/docs/${lf.slug}.md`, async (_req, reply) => reply.type("text/markdown; charset=utf-8").send(readLongform(lf.file)));
  app.get("/llms-full.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").send(
    `# Degenscan Intel — full docs for LLMs\n> Cross-asset market-event intelligence for AI trading agents. REST ${base}/v1 · MCP POST ${base}/mcp · pay per call in USDC (x402, Base or Solana) or X-API-KEY · 100 free calls/day/IP with header X-Free-Trial: 1.\n> SDKs: npm i @degenscan/intel · pip install degenscan-intel · skill: npx skills add tradewr333-lgtm/degenscan-intel\n\n## Prices (USD per call)\n${Object.entries(PRICES).map(([t, p]) => `- ${t}: ${p}`).join("\n")}\n\n` +
    pages.map(p => `## ${p.title}\nQ: ${p.question}\nA: ${p.answer}\n\ncurl:\n${p.rest}\n\nJavaScript:\n${p.js}\n\nPython:\n${p.py}\n`).join("\n---\n\n") +
    LONGFORM.map(l => `\n---\n\n${readLongform(l.file)}\n`).join("") +
    `\n## Operator\nMarbella Collins LLC · contact@degenscan.io · MIT · Information and analytics only — not investment advice. Public metrics ${base}/v1/metrics; our own wallets ${base}/wallets.json.\n`));
  app.get("/sitemap.xml", async (_req, reply) => reply.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${["", "/docs", "/llms.txt", "/llms-full.txt", "/openapi.json", "/skill.md", "/v1/metrics", ...pages.map(p => `/docs/${p.slug}`), ...LONGFORM.map(l => `/docs/${l.slug}`)].map(u => `<url><loc>${base}${u}</loc></url>`).join("")}</urlset>`));
  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`));
  return pages.length;
}
