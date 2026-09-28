// Event-driven trading agent — Degenscan Intel example
// Loop: pulse ($0.001) → events_since ($0.005) → brief ($0.10) per hit → derivs_for ($0.003) for perps → signal.
// It never places orders by itself: implement `execute()` against your venue (Hyperliquid, Binance, IBKR, Alpaca…).
// Information and analytics only — not investment advice.
import { Intel } from "@degenscan/intel";

const env = process.env;
const intel = new Intel(env.AGENT_WALLET_PK ? { privateKey: env.AGENT_WALLET_PK } : env.INTEL_API_KEY ? { apiKey: env.INTEL_API_KEY } : {});
const BOOK = (env.BOOK ?? "BTC,ETH,NVDA").split(",").map(s => s.trim().toUpperCase());
const MIN_CONF = Number(env.MIN_CONFIDENCE ?? 0.5), LOOKBACK = env.LOOKBACK ?? "4h", INTERVAL = Number(env.INTERVAL_MIN ?? 60) * 60_000;
const PERPS = new Set(["BTC", "ETH", "SOL", "HYPE", "DOGE", "XRP", "AVAX", "LINK"]);
const seen = new Set();

async function execute(signal) {
  // ← your venue adapter here. `signal` = { asset, side, confidence, event, brief, derivs }
  console.log(`[signal] ${signal.asset} ${signal.side} conf=${signal.confidence} :: ${signal.event.title}`);
  if (signal.derivs?.flags?.length) console.log(`         derivs flags: ${signal.derivs.flags.join(", ")} funding_1h=${signal.derivs.funding?.rate_1h}`);
}

async function tick() {
  const t0 = Date.now();
  const pulse = await intel.pulse();
  console.log(`[pulse] ${new Date().toISOString()} events_1h=${pulse.events} high_sev=${pulse.high_severity} venues=${JSON.stringify(pulse.venues_open)} paid=${pulse._billing?.method}`);
  if (!pulse.high_severity && !pulse.events) return;

  const { events } = await intel.eventsSince({ since: LOOKBACK, universe: BOOK, min_confidence: MIN_CONF, limit: 50 });
  for (const e of events) {
    if (seen.has(e.id)) continue; seen.add(e.id);
    for (const imp of e.impacts) {
      if (!BOOK.includes(imp.asset_id) || imp.confidence < MIN_CONF || imp.direction === 0) continue;
      const brief = await intel.brief(imp.asset_id, { since: LOOKBACK });
      if (!brief.tradable_now?.length) { console.log(`[skip] ${imp.asset_id}: venue closed, next_open=${JSON.stringify(brief.venues_open)}`); continue; }
      const derivs = PERPS.has(imp.asset_id) ? await intel.derivsFor(imp.asset_id).catch(() => null) : null;
      // simple gate: don't add to a crowded side
      if (derivs?.flags?.includes(imp.direction > 0 ? "funding_hot_long" : "funding_hot_short")) { console.log(`[skip] ${imp.asset_id}: funding already crowded on our side`); continue; }
      await execute({ asset: imp.asset_id, side: imp.direction > 0 ? "LONG" : "SHORT", confidence: imp.confidence, event: e, brief, derivs });
    }
  }
  console.log(`[tick] done in ${Date.now() - t0} ms`);
}

if (process.argv.includes("--once")) { await tick(); process.exit(0); }
await tick(); setInterval(() => tick().catch(err => console.error("[tick error]", err.message)), INTERVAL);
