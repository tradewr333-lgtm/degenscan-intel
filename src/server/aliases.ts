/**
 * Keyword aliases (rastreio de descoberta, 29/10): agent routers such as Agent402's Smart Order Router rank x402 tools by
 * a deterministic LEXICAL match on slug, name and description (exact slug "treasury-auctions" scores 20; our
 * "v1-treasury-auctions" scored 8). Each alias is a short, keyword-exact root path with query parameters that is
 * rewritten (Fastify rewriteUrl) to the canonical /v1 route — same handler, same price, same x402 payment.
 */
export interface Alias { to: string; params?: string[]; name: string; desc: string }
/** Defaults used when a crawler probes an alias without its parameter: the request still reaches the paid route (HTTP 402), never a 400. */
const DEFAULTS: Record<string, string> = { coin: "BTC", symbol: "BTC", currency: "BTC", ticker: "NVDA", jurisdiction: "eu", address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };

export const ALIASES: Record<string, Alias> = {
  "/funding-rate": { to: "/v1/carry/now/{coin}", params: ["coin"], name: "Funding rate — Hyperliquid perp funding rate now", desc: "Funding rate for one perpetual future on Hyperliquid (any coin, incl. HIP-3 stocks): current funding rate annualised, 8h and 24h average, mark, oracle, open interest." },
  "/funding-rates": { to: "/v1/funding/alerts", name: "Funding rates — extreme perp funding rates now", desc: "Funding rates across perps: coins with the most extreme funding rate now on Hyperliquid plus predicted funding on Binance and Bybit." },
  "/funding-arbitrage": { to: "/v1/carry/top", name: "Funding arbitrage — top funding rate spreads", desc: "Funding arbitrage: top same-ticker funding rate spreads across Hyperliquid dexes and perp-vs-spot funding now." },
  "/perp-basis": { to: "/v1/hl/basis/{coin}", params: ["coin"], name: "Perp basis — premium and predicted funding", desc: "Perp basis and premium: mark vs oracle, impact premium, funding rate now/24h/7d and predicted funding on Hyperliquid, Binance and Bybit." },
  "/token-risk": { to: "/v1/token/risk/{address}", params: ["address"], name: "Token risk — token contract risk check", desc: "Token risk check for a token contract (EVM or Solana): honeypot, buy/sell tax, mint, pause, blacklist, owner, holders, LP lock, liquidity." },
  "/honeypot-check": { to: "/v1/token/risk/{address}", params: ["address"], name: "Honeypot check — token scam and rug check", desc: "Honeypot check and rug check for a token contract: can it be sold, sell tax, mint/pause/blacklist, owner powers, LP lock." },
  "/gas-price": { to: "/v1/gas/base", name: "Gas price — Base gas fees now", desc: "Gas price on Base now: base fee, priority fee percentiles, suggested EIP-1559 fees, transfer and swap cost in USD." },
  "/wallet-balance": { to: "/v1/base/balance/{address}", params: ["address"], name: "Wallet balance — Base ETH, USDC and token balance", desc: "Wallet balance on Base: ETH, USDC and any ERC-20 token balance of an address now." },
  "/crypto-price": { to: "/v1/price/{symbol}", params: ["symbol"], name: "Crypto price — price now", desc: "Crypto price now: Hyperliquid mark/mid/oracle and Coinbase spot price, 24h change, basis, realized volatility." },
  "/candles": { to: "/v1/hl/candles/{coin}", params: ["coin"], name: "Candles — OHLCV price history", desc: "Candles (OHLCV) for any Hyperliquid perp: 1m, 5m, 15m, 1h, 4h, 1d, up to 500 candles, with change, range and VWAP." },
  "/ohlcv": { to: "/v1/hl/candles/{coin}", params: ["coin"], name: "OHLCV — candles price history", desc: "OHLCV candles for any crypto perp on Hyperliquid (incl. HIP-3): open, high, low, close, volume, trades." },
  "/liquidations": { to: "/v1/hl/liquidations/{coin}", params: ["coin"], name: "Liquidations — liquidation map and levels", desc: "Liquidations for one coin: liquidation map, long and short liquidation levels by distance from price, nearest clusters, liquidations in the last 24h." },
  "/smart-money": { to: "/v1/hl/smart-money/{coin}", params: ["coin"], name: "Smart money — top traders positioning", desc: "Smart money positioning for one coin: how the top-PnL Hyperliquid traders are positioned and what they bought or sold recently." },
  "/options-volatility": { to: "/v1/options/{currency}", params: ["currency"], name: "Options volatility — implied volatility and skew", desc: "Options implied volatility for BTC or ETH: ATM IV term structure, 25-delta skew (risk reversal), butterfly, put/call ratio, max pain, DVOL." },
  "/max-pain": { to: "/v1/options/maxpain/{currency}", params: ["currency"], name: "Max pain — options max pain", desc: "Options max pain for BTC or ETH by expiry, open interest and put/call ratio." },
  "/polymarket-leaderboard": { to: "/v1/polymarket/leaderboard", name: "Polymarket leaderboard — top traders", desc: "Polymarket leaderboard: top traders by PnL or volume for day, week, month or all time." },
  "/prediction-markets": { to: "/v1/polymarket/top", name: "Prediction markets — most active Polymarket markets", desc: "Prediction markets: the most active Polymarket markets now with odds, 24h change, volume and liquidity." },
  "/treasury-auctions": { to: "/v1/treasury/auctions", name: "Treasury auctions — US Treasury auction results", desc: "Treasury auctions: US Treasury auction results (high yield, bid-to-cover, bidder split) and upcoming auctions." },
  "/stablecoin-supply": { to: "/v1/stablecoins", name: "Stablecoin supply — supply and net flows", desc: "Stablecoin supply: circulating supply and 1d/7d/30d net change per stablecoin, depegs." },
  "/defi-yields": { to: "/v1/defi/yields", name: "DeFi yields — stablecoin yields APY", desc: "DeFi yields: stablecoin pool APY above a TVL floor, 30-day mean, reward share, outlier flag." },
  "/economic-calendar": { to: "/v1/calendar", name: "Economic calendar — macro and earnings calendar", desc: "Economic calendar: upcoming US macro releases, FOMC, Treasury auctions and earnings." },
  "/market-pulse": { to: "/v1/pulse", name: "Market pulse — market summary now", desc: "Market pulse: last-hour market events by class, top severe events, venues open." },
  "/sec-filings": { to: "/v1/filings/{ticker}", params: ["ticker"], name: "SEC filings — EDGAR filings for a ticker", desc: "SEC filings for one ticker from EDGAR: 8-K, Form 4 insider trades, 13D/G, S-1." },
  "/crypto-news": { to: "/v1/news/{ticker}", params: ["ticker"], name: "Crypto news — headlines for an asset", desc: "Crypto and stock news: headlines touching one asset with source tier, corroboration and sentiment." },
  "/whale-transfers": { to: "/v1/whales", name: "Whale transfers — large stablecoin transfers", desc: "Whale transfers: large USDC and USDT transfers on Base and Ethereum." },
  "/usd-brl": { to: "/v1/br/ptax", name: "USD BRL — dollar real exchange rate", desc: "USD/BRL exchange rate: official BCB PTAX, USDT/BRL and the crypto-dollar premium in Brazil." },
  "/llm-prices": { to: "/v1/ai/models", name: "LLM prices — AI model pricing per token", desc: "LLM prices: price per 1M input and output tokens, context window and capabilities for ~450 AI models (OpenAI, Anthropic, Google, Meta, Mistral, DeepSeek…)." },
  "/cheapest-llm": { to: "/v1/ai/cheapest", name: "Cheapest LLM — cheapest AI model for a task", desc: "Cheapest LLM that supports tools, vision, JSON or reasoning with a minimum context window." },
  "/llm-cost": { to: "/v1/ai/cost", name: "LLM cost — AI cost calculator", desc: "LLM cost calculator: cost of a workload (tokens × calls) on each AI model." },
  "/ai-adoption": { to: "/v1/ai/adoption", name: "AI adoption — AI framework downloads and stars", desc: "AI adoption: weekly downloads and GitHub stars of AI SDKs and frameworks (LangChain, LlamaIndex, CrewAI, MCP…)." },
  "/ai-research": { to: "/v1/ai/research", name: "AI research — arXiv paper trends", desc: "AI research trends: new arXiv papers per topic (RAG, agents, MCP, fine-tuning) in 7 and 30 days." },
  "/ai-regulation": { to: "/v1/ai/regulation/{jurisdiction}", params: ["jurisdiction"], name: "AI regulation — EU AI Act and AI law dates", desc: "AI regulation: EU AI Act deadlines after the Digital Omnibus, Colorado AI law, Brazil AI bill — dates, status, sources." },
  "/stablecoin-yield": { to: "/v1/defi/yields/best", name: "Stablecoin yield — best USDC and USDT yield now", desc: "Stablecoin yield: best supply APY per stablecoin and best USDC/USDT pool per chain, base APY apart from incentives." },
  "/usdc-yield": { to: "/v1/defi/yields/best", name: "USDC yield — best USDC APY by chain", desc: "USDC yield: best USDC supply APY now and by chain (Base, Ethereum, Arbitrum…), base APY apart from incentives." },
  "/coin-snapshot": { to: "/v1/coin/{symbol}", params: ["symbol"], name: "Coin snapshot — everything about one coin", desc: "Coin snapshot in one call: price, funding rate, liquidations, smart money, options and news events for one coin." },
};

/** Rewrites "/funding-rate?coin=BTC&x=1" → "/v1/carry/now/BTC?x=1"; a missing parameter takes its default. Unknown paths pass through. */
export function rewriteAlias(url: string): string {
  const q = url.indexOf("?"); const path = q < 0 ? url : url.slice(0, q);
  const a = ALIASES[path.length > 1 ? path.replace(/\/$/, "") : path]; if (!a) return url;
  const sp = new URLSearchParams(q < 0 ? "" : url.slice(q + 1));
  let to = a.to;
  for (const p of a.params ?? []) { const v = sp.get(p) || DEFAULTS[p]; if (!v) return url; to = to.replace(`{${p}}`, encodeURIComponent(v)); sp.delete(p); }
  if (a.to.startsWith("/v1/token/") && !sp.get("chain")) sp.set("chain", "base");
  const rest = sp.toString(); return rest ? `${to}?${rest}` : to;
}

/** OpenAPI entries for the aliases, copied from the canonical route (price, responses), path params turned into query params. */
export function aliasPaths(paths: Record<string, any>) {
  const out: Record<string, any> = {};
  for (const [alias, a] of Object.entries(ALIASES)) {
    const base = paths[a.to]?.get; if (!base) continue;
    const params = [...(a.params ?? []).map(p => ({ name: p, in: "query", required: false, schema: { type: "string", default: DEFAULTS[p] } })), ...((base.parameters ?? []) as any[]).filter(p => p.in !== "path")];
    out[alias] = { get: { ...base, operationId: alias.slice(1).replace(/-/g, "_"), summary: a.name, description: `${a.desc} Same data and price as ${a.to}. Market data only — not investment advice.`, parameters: params, "x-canonical": a.to } };
  }
  return out;
}
