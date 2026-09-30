// Apify Actor wrapping Degenscan Intel (https://intel.degenscan.io). Pay-per-event: one charged event per tool run.
// Configure on Apify: env secret INTEL_API_KEY (a channel key minted by the operator), and pay-per-event prices
// with event names equal to the tool ids below. Information and analytics only — not investment advice.
import { Actor } from "apify";

const BASE = process.env.INTEL_BASE_URL ?? "https://intel.degenscan.io";
await Actor.init();
const input = (await Actor.getInput()) ?? {};
const tool = input.tool ?? "token_verdict";
const enc = encodeURIComponent;
const routes = {
  token_verdict: () => ["GET", `/v1/token/verdict/${enc(input.address ?? "")}?chain=${enc(input.chain ?? "base")}`],
  price_for: () => ["GET", `/v1/price/${enc(input.symbol ?? "BTC")}`],
  funding_alerts: () => ["GET", `/v1/funding/alerts`],
  whale_moves: () => ["GET", `/v1/whales`],
  polymarket_top: () => ["GET", `/v1/polymarket/top`],
  derivs_for: () => ["GET", `/v1/derivs/${enc(input.symbol ?? "BTC")}`],
  events_since: () => ["GET", `/v1/events?since=${enc(input.since ?? "4h")}${input.universe ? `&universe=${enc(input.universe)}` : ""}`],
  impact_for: () => ["GET", `/v1/impact/${enc(input.symbol ?? "BTC")}?since=${enc(input.since ?? "24h")}`],
  oracle_board: () => ["GET", `/v1/oracle/board`],
  oracle_forecast: () => ["POST", `/v1/oracle/forecast`],
};
if (!routes[tool]) { await Actor.fail(`unknown tool ${tool}`); }
const key = process.env.INTEL_API_KEY;
if (!key) { await Actor.fail("INTEL_API_KEY is not configured on this Actor"); }
const headers = { "X-API-KEY": key, "content-type": "application/json", "user-agent": "degenscan-intel-apify/0.1" };
const [method, path] = routes[tool]();
let res, body;
try {
  res = await fetch(BASE + path, { method, headers, body: method === "POST" ? JSON.stringify({ question: input.question, resolves_at: input.resolves_at }) : undefined, signal: AbortSignal.timeout(30000) });
  body = await res.json();
  // oracle_forecast is async: poll the free status route until done (max ~6 min)
  if (tool === "oracle_forecast" && res.status === 202 && body.forecast_id) {
    for (let i = 0; i < 72; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const p = await fetch(`${BASE}/v1/oracle/forecast/${body.forecast_id}`, { headers }).then(r => r.json());
      if (p.status === "done" || p.probability != null) { body = p; break; }
      if (p.status === "failed") { body = p; break; }
    }
  }
} catch (e) { body = { error: String(e?.message ?? e) }; }
const ok = !!res && res.ok && !body?.error;
if (ok) { try { await Actor.charge({ eventName: tool }); } catch { /* not a pay-per-event run (e.g. developer test) */ } }
await Actor.pushData({ tool, ok, status: res?.status ?? null, result: ok ? body : null, error: ok ? null : (body?.error ?? `HTTP ${res?.status}`) });
await Actor.exit();
