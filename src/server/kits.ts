/**
 * /kits/trading-agents (05/11, Renato — Milk Road post): one page for people building agents that trade perps through
 * Coinbase for Agents (international perps executed on Deribit) or Hyperliquid — e.g. during the Coinbase Champions Cup
 * (04–25/11/2026). Lists the data tools such an agent needs, with prices, one batch call and the MCP setup.
 * Not affiliated with Coinbase, Deribit or Hyperliquid. Information and analytics only — not investment advice.
 */
import { CSS } from "./answers.js";
import { PRICES } from "./pricing.js";

const esc = (s: string) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
export const KIT_TOOLS: { tool: string; path: string; why: string }[] = [
  { tool: "deribit_perps", path: "/v1/deribit/perps?symbols=BTC,ETH,SOL", why: "Funding (8 h and annualised), premium, open interest and volume on the perps Coinbase Advanced executes on Deribit, plus the funding gap vs Hyperliquid." },
  { tool: "hl_basis", path: "/v1/hl/basis/BTC", why: "Hyperliquid funding now, 24 h and 7 d means, predicted funding on Binance and Bybit, mark vs oracle." },
  { tool: "funding_alerts", path: "/v1/funding/alerts", why: "Perps with extreme funding right now: crowded side, who is paying." },
  { tool: "hl_liq_near", path: "/v1/hl/liquidations?within_pct=5", why: "Open positions close to liquidation: where forced selling or buying could start." },
  { tool: "options_summary", path: "/v1/options/BTC", why: "Deribit options: implied vol term structure, 25-delta skew, put/call, max pain, DVOL." },
  { tool: "calendar", path: "/v1/calendar?days=7", why: "Scheduled macro events (FOMC, CPI, payrolls) and crypto unlocks for the next days." },
  { tool: "pulse", path: "/v1/pulse", why: "What happened in the last hour across regulators, central banks, exchanges and hacks." },
  { tool: "polymarket_markets", path: "/v1/polymarket/markets?tag=crypto&q=bitcoin", why: "Prediction-market odds on crypto and macro questions, with spread and liquidity." },
  { tool: "token_risk", path: "/v1/token/risk/0x…?chain=base", why: "Contract risk of a token before trading it on-chain." },
];

export function renderTradingKit(base: string) {
  const rows = KIT_TOOLS.map(t => ({ ...t, price: (PRICES as any)[t.tool] as number | undefined }));
  const total = Math.round(rows.slice(0, 7).reduce((a, r) => a + (r.price ?? 0), 0) * 1000) / 1000;
  const batch = JSON.stringify({ calls: [{ path: "/v1/deribit/perps?symbols=BTC,ETH,SOL" }, { path: "/v1/hl/basis/BTC" }, { path: "/v1/funding/alerts" }, { path: "/v1/calendar?days=2" }] });
  const ld = { "@context": "https://schema.org", "@type": "WebAPI", name: "Degenscan Intel — data kit for trading agents", url: `${base}/kits/trading-agents`, documentation: `${base}/docs`, provider: { "@type": "Organization", name: "Degenscan Intel (Marbella Collins LLC)" },
    description: "Market data for agents that trade perpetuals on Coinbase for Agents (Deribit) or Hyperliquid: funding, open interest, liquidations, options, macro calendar, events. Paid per call in USDC (x402) or prepaid." };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Data kit for trading agents · Degenscan Intel</title><meta name="description" content="The market data an agent needs to trade perps on Coinbase for Agents (Deribit) or Hyperliquid: funding, open interest, liquidations, options, macro calendar. Per call in USDC or prepaid."><link rel="canonical" href="${base}/kits/trading-agents">
<style>${CSS}</style><script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script></head><body><main>
<p class="meta"><a href="${base}/answers">Live answers</a> · <a href="${base}/docs">API docs</a></p>
<h1>Data kit for trading agents</h1>
<p class="ans">Building an agent that trades perpetuals through Coinbase for Agents (Coinbase Advanced executes international perps on Deribit) or on Hyperliquid? These are the data calls it needs before each trade. Every call is paid per request in USDC on Base or Solana (x402), so the agent can pay by itself, including from a Coinbase USDC balance where x402 payments are enabled. No card and no account needed.</p>
<table>${rows.map(r => `<tr><td><code>${esc(r.tool)}</code><br><span class="meta">${esc(r.why)}</span></td><td>${r.price != null ? `$${r.price}` : "—"}</td></tr>`).join("")}</table>
<p class="meta">The first seven calls together cost about $${total}. 100 free calls a day per IP with the header <code>X-Free-Trial: 1</code>.</p>
<h2>One request before each trade</h2><p>Batch up to 10 routes in one request and one payment (sum of the prices):</p>
<pre>curl -X POST -H "content-type: application/json" -H "X-Free-Trial: 1" \\
  -d '${esc(batch)}' ${esc(base)}/v1/batch</pre>
<h2>Connect it to Claude, ChatGPT or Cursor (MCP)</h2><p>Server URL: <code>${esc(base)}/mcp</code>. Compact mode, two tools (search, execute): <code>${esc(base)}/mcp?mode=compact</code>. Pass a key in the <code>X-API-KEY</code> header, or let the agent pay per call.</p>
<h2>Prepaid, for agents that trade all day</h2><ul>
<li>Prepaid balance with 20% bonus, bought with USDC: 5 → $6, 20 → $24, 100 → $120 of calls at the normal prices (<code>POST ${esc(base)}/v1/keys/x402/balance_5</code>).</li>
<li>Carry data for 7 days: 25 USDC (<code>POST ${esc(base)}/v1/keys/x402/carry_week</code>).</li></ul>
<p>Coinbase AgentKit users: a Degenscan Intel action provider (TypeScript and Python) is available in our repository, <a href="https://github.com/tradewr333-lgtm/degenscan-intel/tree/main/integrations/agentkit">integrations/agentkit</a>.</p>
<p class="foot">Not affiliated with or endorsed by Coinbase, Deribit or Hyperliquid. Information and analytics only — not investment advice. Trading derivatives can lose all the money committed. Degenscan Intel · Marbella Collins LLC · <a href="mailto:contact@degenscan.io">contact@degenscan.io</a></p></main></body></html>`;
}
