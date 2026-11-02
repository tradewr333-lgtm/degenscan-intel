/**
 * Live answer pages (Renato 02/11, "YouTube/Google/IA são buscadores"; Koray — topical authority; Mike King — how AI
 * picks what to cite). One indexable page per question agents and developers actually ask ("What is the BTC funding rate
 * on Hyperliquid right now?"), answered with the live number, the time, the primary source and the API call that returns
 * it. Server-rendered HTML + JSON-LD (FAQPage + Dataset), so search engines and AI answer engines can read and cite it.
 * Data comes from our own routes through an internal request (no payment, nothing billed). Market data only.
 */
export interface AnswerDef { slug: string; q: string; path: string; tool: string; source: string; topic: "funding" | "onchain" | "ai" | "macro" | "options" | "prediction";
  render: (j: any) => { answer: string; rows: [string, string][] } }

const n = (x: any, d = 2) => x == null || !Number.isFinite(Number(x)) ? "—" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
const usd = (x: any, d = 2) => x == null || !Number.isFinite(Number(x)) ? "—" : "$" + n(x, d);
const big = (x: any) => { const v = Number(x); if (!Number.isFinite(v)) return "—"; return v >= 1e9 ? `$${n(v / 1e9, 2)}B` : v >= 1e6 ? `$${n(v / 1e6, 1)}M` : usd(v, 0); };
const pct = (x: any, d = 2) => x == null || !Number.isFinite(Number(x)) ? "—" : `${n(x, d)}%`;

const funding = (coin: string): AnswerDef => ({
  slug: `${coin.toLowerCase()}-funding-rate-hyperliquid`, q: `What is the ${coin} funding rate on Hyperliquid right now?`, path: `/v1/hl/basis/${coin}`, tool: "hl_basis", topic: "funding",
  source: "Hyperliquid info API (metaAndAssetCtxs, predictedFundings) + Degenscan hourly funding history",
  render: j => ({
    answer: `${coin} perpetual funding on Hyperliquid is ${pct(j.funding?.apr_pct)} a year right now (${n((j.funding?.hourly ?? 0) * 100, 5)}% per hour), ${j.funding?.hourly > 0 ? "longs paying shorts" : j.funding?.hourly < 0 ? "shorts paying longs" : "flat"}. The 7-day mean is ${pct(j.funding?.apr_7d_mean_pct)} a year and funding was positive ${pct(j.funding?.positive_share_7d_pct, 1)} of the hours.`,
    rows: [["Funding now (annualised)", pct(j.funding?.apr_pct)], ["24 h mean (annualised)", pct(j.funding?.apr_24h_mean_pct)], ["7 d mean (annualised)", pct(j.funding?.apr_7d_mean_pct)],
      ...((j.predicted_funding ?? []) as any[]).map(p => [`Predicted next funding — ${p.venue}`, pct(p.apr_pct)] as [string, string]),
      ["Mark price", usd(j.mark, 2)], ["Mark vs oracle premium", `${n(j.mark_oracle_premium_bps, 2)} bps`], ["Open interest", big(j.open_interest_usd)]] }),
});

export const ANSWERS: AnswerDef[] = [
  funding("BTC"), funding("ETH"), funding("SOL"), funding("HYPE"),
  { slug: "extreme-funding-rates-now", q: "Which crypto perps have the most extreme funding rates right now?", path: "/v1/funding/alerts?limit=10&min_abs_rate_1h=0.0001", tool: "funding_alerts", topic: "funding",
    source: "Hyperliquid info API + predicted funding on Binance and Bybit",
    render: j => { const a = (j.alerts ?? []) as any[]; return {
      answer: a.length ? `The most extreme perp funding on Hyperliquid right now is ${a[0].symbol} at ${pct(a[0].annualized_pct, 1)} a year (${a[0].side_paying} paying). ${a.length} perps are above ${n((j.threshold_abs_rate_1h ?? 0) * 100, 3)}% per hour.` : "No Hyperliquid perp is above the extreme-funding threshold right now.",
      rows: a.slice(0, 10).map(x => [`${x.symbol} (${x.side_paying} pay)`, `${pct(x.annualized_pct, 1)} / yr · OI ${big(x.open_interest_usd)}`] as [string, string]) }; } },
  { slug: "base-gas-price-now", q: "What is the gas price on Base right now?", path: "/v1/gas/base", tool: "gas_base", topic: "onchain", source: "Base public RPC (eth_feeHistory, last 20 blocks) + Coinbase ETH-USD spot",
    render: j => ({ answer: `Base gas is ${n(j.base_fee_gwei, 4)} gwei base fee right now. An ETH transfer costs about ${usd(j.l2_execution_cost?.eth_transfer?.usd, 4)} and an ERC-20 transfer about ${usd(j.l2_execution_cost?.erc20_transfer?.usd, 4)} in L2 execution.`,
      rows: [["Base fee", `${n(j.base_fee_gwei, 4)} gwei`], ["Next base fee", `${n(j.next_base_fee_gwei, 4)} gwei`], ["Priority fee p50", `${n(j.priority_fee_gwei?.p50, 4)} gwei`],
        ["Suggested max fee (medium)", `${n(j.suggested?.medium?.max_fee_gwei, 4)} gwei`], ["ETH transfer", usd(j.l2_execution_cost?.eth_transfer?.usd, 4)], ["ERC-20 transfer", usd(j.l2_execution_cost?.erc20_transfer?.usd, 4)], ["ETH/USD", usd(j.eth_usd, 0)]] }) },
  { slug: "cheapest-llm-api-with-tool-use", q: "What is the cheapest LLM API that supports tool use?", path: "/v1/ai/cheapest?needs=tools&min_context=32000&limit=10", tool: "ai_cheapest", topic: "ai", source: "OpenRouter public models API (prices as published by each provider)",
    render: j => { const it = (j.items ?? []) as any[]; return { answer: it.length ? `The cheapest LLM with tool use and at least 32k context is ${it[0].id} at ${usd(it[0].input_per_1m, 4)} per 1M input tokens and ${usd(it[0].output_per_1m, 4)} per 1M output tokens.` : "No model matched.",
      rows: it.slice(0, 10).map(m => [m.id, `in ${usd(m.input_per_1m, 4)} · out ${usd(m.output_per_1m, 4)} per 1M · ctx ${n(m.context, 0)}`] as [string, string]) }; } },
  { slug: "newest-llm-models-and-prices", q: "Which LLM models were released most recently, and what do they cost?", path: "/v1/ai/models?sort=newest&limit=12", tool: "ai_models", topic: "ai", source: "OpenRouter public models API",
    render: j => { const it = (j.items ?? []) as any[]; return { answer: it.length ? `The newest LLM listed is ${it[0].id} (${it[0].provider}), at ${usd(it[0].input_per_1m, 4)} input and ${usd(it[0].output_per_1m, 4)} output per 1M tokens. ${n(j.n_total, 0)} models are tracked.` : "No models.",
      rows: it.slice(0, 12).map(m => [m.id, `in ${usd(m.input_per_1m, 4)} · out ${usd(m.output_per_1m, 4)} per 1M · ctx ${n(m.context, 0)}`] as [string, string]) }; } },
  { slug: "best-usdc-yield-now", q: "What is the best USDC yield right now?", path: "/v1/defi/yields/best", tool: "stable_yield_best", topic: "onchain", source: "DefiLlama yields API (pool APY, base vs reward)",
    render: j => { const u = ((j.best_by_asset ?? []) as any[]).find(a => a.asset === "USDC")?.best; const ch = (j.usdc_by_chain ?? []) as any[]; return {
      answer: u ? `The best USDC supply yield right now is ${pct(u.apy_pct)} APY on ${u.project} (${u.chain}), of which ${pct(u.apy_base_pct)} is base yield and the rest incentives; TVL ${big(u.tvl_usd)}.` : "No USDC pool above the TVL floor right now.",
      rows: ch.slice(0, 10).map(p => [`${p.chain} — ${p.project}`, `${pct(p.apy_pct)} APY`] as [string, string]) }; } },
  { slug: "us-treasury-auction-results", q: "What were the latest US Treasury auction results?", path: "/v1/treasury/auctions", tool: "treasury_auctions", topic: "macro", source: "US Treasury Fiscal Data API (auctions query)",
    render: j => { const r = (j.results ?? []) as any[]; return { answer: r.length ? `The latest US Treasury auction was the ${r[0].security_term} on ${r[0].auction_date}: high yield ${pct(r[0].high_yield_pct, 3)}, bid-to-cover ${n(r[0].bid_to_cover, 2)}, indirect bidders ${pct(r[0].indirect_pct, 1)}.` : "No auction results in the window.",
      rows: r.slice(0, 10).map(a => [`${a.auction_date} · ${a.security_term}`, `yield ${pct(a.high_yield_pct, 3)} · bid-to-cover ${n(a.bid_to_cover, 2)}`] as [string, string]) }; } },
  { slug: "btc-options-implied-volatility", q: "What is Bitcoin's options implied volatility right now?", path: "/v1/options/BTC", tool: "options_summary", topic: "options", source: "Deribit public API (DVOL, options book)",
    render: j => { const t = ((j.term_structure ?? []) as any[])[0]; return { answer: `Bitcoin's 30-day implied volatility index (DVOL) is ${n(j.dvol?.now, 2)} right now${t ? `; the nearest expiry (${t.expiry}) trades at ${pct(t.atm_iv, 1)} ATM IV with a 25-delta risk reversal of ${n(t.rr25, 2)}` : ""}.`,
      rows: [["DVOL", n(j.dvol?.now, 2)], ["DVOL change 24 h", n(j.dvol?.change_24h, 2)], ["Index price", usd(j.index_price, 0)], ["Put/call OI ratio", n(j.put_call?.oi_ratio, 2)],
        ...((j.term_structure ?? []) as any[]).slice(0, 6).map(x => [`${x.expiry} (${n(x.days, 1)} d)`, `ATM IV ${pct(x.atm_iv, 1)} · RR25 ${n(x.rr25, 2)} · max pain ${usd(x.max_pain, 0)}`] as [string, string])] }; } },
  { slug: "usd-brl-ptax-today", q: "What is the official USD/BRL PTAX rate today, and the crypto-dollar premium?", path: "/v1/br/ptax", tool: "br_ptax", topic: "macro", source: "Banco Central do Brasil PTAX (official API) + Mercado Bitcoin USDT/BRL",
    render: j => ({ answer: `The official BCB PTAX is R$ ${n(j.ptax_usd_brl, 4)} per US dollar (${j.ptax_date}). USDT trades at R$ ${n(j.usdt_brl, 4)}, a ${pct(j.usdt_premium_vs_ptax_pct, 2)} premium over PTAX.`,
      rows: [["PTAX USD/BRL", `R$ ${n(j.ptax_usd_brl, 4)}`], ["PTAX date", String(j.ptax_date ?? "—")], ["USDT/BRL", `R$ ${n(j.usdt_brl, 4)}`], ["USDT premium vs PTAX", pct(j.usdt_premium_vs_ptax_pct, 3)], ["BTC premium vs PTAX", pct(j.btc_premium_vs_ptax_pct, 3)]] }) },
  { slug: "polymarket-top-traders-this-week", q: "Who are the top Polymarket traders this week?", path: "/v1/polymarket/leaderboard?period=week&by=pnl&limit=10", tool: "polymarket_leaderboard", topic: "prediction", source: "Polymarket public data API (leaderboard)",
    render: j => { const it = (j.items ?? []) as any[]; return { answer: it.length ? `The top Polymarket trader by PnL this week is ${it[0].name ?? it[0].wallet} with ${usd(it[0].pnl_usd, 0)} on ${big(it[0].volume_usd)} volume.` : "Leaderboard unavailable.",
      rows: it.slice(0, 10).map(x => [`#${x.rank} ${x.name ?? x.wallet}`, `PnL ${usd(x.pnl_usd, 0)} · volume ${big(x.volume_usd)}`] as [string, string]) }; } },
];

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const CSS = `:root{--bg:#fcfcfb;--fg:#0b0b0b;--mut:#52514e;--line:#e6e5e1;--acc:#2a78d6;--card:#fff}@media(prefers-color-scheme:dark){:root{--bg:#1a1a19;--fg:#f0efec;--mut:#c3c2b7;--line:#33322f;--acc:#3987e5;--card:#222220}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}main{max-width:760px;margin:0 auto;padding:28px 16px 48px}
a{color:var(--acc)}h1{font-size:1.6rem;line-height:1.25;margin:.2em 0 .6em}.ans{font-size:1.1rem;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px}
table{width:100%;border-collapse:collapse;margin:18px 0}td{padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.meta,.foot{color:var(--mut);font-size:.9rem}pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;overflow-x:auto;font-size:.85rem}ul{padding-left:1.2em}`;

export function renderPage(a: AnswerDef, j: any, base: string, price: number | undefined) {
  const { answer, rows } = a.render(j); const at = String(j.as_of ?? new Date().toISOString());
  const url = `${base}/answers/${a.slug}`; const api = `${base}${a.path}`;
  const ld = [{ "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: a.q, acceptedAnswer: { "@type": "Answer", text: `${answer} (as of ${at}; source: ${a.source})` } }] },
    { "@context": "https://schema.org", "@type": "Dataset", name: a.q, description: answer, url, dateModified: at, creator: { "@type": "Organization", name: "Degenscan Intel (Marbella Collins LLC)", url: base },
      isAccessibleForFree: false, distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: api }], isBasedOn: a.source }];
  const related = ANSWERS.filter(x => x.slug !== a.slug && x.topic === a.topic).concat(ANSWERS.filter(x => x.topic !== a.topic)).slice(0, 6);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(a.q)} — live answer · Degenscan Intel</title><meta name="description" content="${esc(answer.slice(0, 155))}"><link rel="canonical" href="${url}">
<style>${CSS}</style><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script></head><body><main>
<p class="meta"><a href="${base}/answers">Live answers</a> · updated <time datetime="${esc(at)}">${esc(at.replace("T", " ").slice(0, 16))} UTC</time></p>
<h1>${esc(a.q)}</h1><p class="ans">${esc(answer)}</p>
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
<p class="meta">Source: ${esc(a.source)}. Recomputed every few minutes.</p>
<h2>Get this by API</h2><p>One call, ${price != null ? `US$${price}` : "priced per call"} in USDC (x402, Base or Solana), or with an X-API-KEY. 100 free calls/day with the header <code>X-Free-Trial: 1</code>.</p>
<pre>curl -H "X-Free-Trial: 1" "${esc(api)}"</pre><p>MCP: <code>${esc(base)}/mcp</code> → tool <code>${esc(a.tool)}</code>. Docs: <a href="${base}/docs">${esc(base)}/docs</a> · <a href="${base}/llms.txt">llms.txt</a></p>
<h2>Related</h2><ul>${related.map(r => `<li><a href="${base}/answers/${r.slug}">${esc(r.q)}</a></li>`).join("")}</ul>
<p class="foot">Market data and analytics only — not investment advice. Degenscan Intel · Marbella Collins LLC · <a href="mailto:contact@degenscan.io">contact@degenscan.io</a></p></main></body></html>`;
}

export function renderIndex(base: string) {
  const groups: Record<string, string> = { funding: "Funding rates", onchain: "On-chain", ai: "AI models", macro: "Macro", options: "Options", prediction: "Prediction markets" };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Live market answers · Degenscan Intel</title>
<meta name="description" content="Live answers with the number, the time and the primary source: Hyperliquid funding rates, Base gas, cheapest LLM APIs, USDC yields, Treasury auctions, BTC implied volatility."><link rel="canonical" href="${base}/answers"><style>${CSS}</style></head><body><main>
<h1>Live answers</h1><p>Each page answers one question with the live number, the time and the primary source, plus the API call that returns it.</p>
${Object.entries(groups).map(([g, t]) => { const xs = ANSWERS.filter(a => a.topic === g); return xs.length ? `<h2>${t}</h2><ul>${xs.map(a => `<li><a href="${base}/answers/${a.slug}">${esc(a.q)}</a></li>`).join("")}</ul>` : ""; }).join("")}
<p class="foot">Market data and analytics only — not investment advice. <a href="${base}/docs">API docs</a></p></main></body></html>`;
}
