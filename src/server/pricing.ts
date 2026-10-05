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
  token_verdict: 0.01,
  oracle_board: 0.002,
  polymarket_edge: 0.002,
  oracle_forecast: 0.25,
  oracle_get: 0,
  oracle_track_record: 0,
  universe: 0,
  sources_status: 0,
  health: 0,
  keys_trial: 0,
  // Carry Data routes/tools (Renato 04/10, seller's order): pay per call in USDC OR the flat US$100/month subscription (unlimited).
  // Prices cross US$100 around 3,000 calls/month so heavy use converges to the subscription. Desk routes are subscription-only.
  carry_funding_matrix: 0.03, carry_xdex: 0.05, carry_spot_perp: 0.03, carry_history: 0.02, carry_naked: 0.01, carry_watchdog: 0.01,
};

export const FREE_DAILY_CALLS_PER_IP = Number(process.env.FREE_DAILY_CALLS ?? 100);

export function priceOf(tool: string) { return PRICES[tool] ?? 0.005; }
export function toAtomicUsdc(usd: number) { return String(Math.round(usd * 1e6)); }

/** Prepaid-pack credits consumed per call (1 credit = one $0.002-class call). oracle_forecast = 0.25 / 0.002 = 125. */
export const CARRY_CREDITS: Record<string, number> = { carry_funding_matrix: 30, carry_xdex: 50, carry_spot_perp: 30, carry_history: 20, carry_naked: 10, carry_watchdog: 10 };
export function creditsFor(tool: string) { return tool === "oracle_forecast" ? 125 : (CARRY_CREDITS[tool] ?? 1); }
export const CREDITS_SQL = "SUM(CASE WHEN tool = 'oracle_forecast' THEN 125 " + Object.entries(CARRY_CREDITS).map(([t, c]) => `WHEN tool = '${t}' THEN ${c} `).join("") + "ELSE 1 END)";
