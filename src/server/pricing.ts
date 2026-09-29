/** Per-call prices in USD. USDC has 6 decimals → atomic = usd * 1e6. */
export const PRICES: Record<string, number> = {
  events_since: 0.005,
  impact_for: 0.003,
  exposure_graph: 0.002,
  regime_snapshot: 0.01,
  explain: 0.02,
  polymarket_context: 0.01,
  pulse: 0.001,
  news_for: 0.002,
  derivs_for: 0.003,
  price_for: 0.001,
  funding_alerts: 0.001,
  whale_moves: 0.002,
  polymarket_top: 0.002,
  filings_for: 0.002,
  calendar: 0.002,
  brief: 0.10,
  universe: 0,
  sources_status: 0,
  health: 0,
};

export const FREE_DAILY_CALLS_PER_IP = Number(process.env.FREE_DAILY_CALLS ?? 100);

export function priceOf(tool: string) { return PRICES[tool] ?? 0.005; }
export function toAtomicUsdc(usd: number) { return String(Math.round(usd * 1e6)); }
