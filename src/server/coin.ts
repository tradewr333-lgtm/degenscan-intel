/**
 * Coin snapshot (Renato 17/10, item 2): everything we know about one coin in ONE call — price and basis, funding,
 * liquidation map, smart-money positioning, options (BTC/ETH) and event pressure. Built for agents that want one
 * answer per decision instead of six calls. Each block degrades to null on its own. Market data only — not investment advice.
 */
import { priceFor, impactFor } from "./tools.js";
import { carryNow } from "./micro.js";
import { liqMap, smartCoin } from "../carry/liq.js";
import { optionsSummary, OPT_CURRENCIES } from "./options.js";

const safe = async <T>(f: () => Promise<T> | T): Promise<T | null> => { try { return await f(); } catch { return null; } };

export async function coinSnapshot(raw: string) {
  const sym = String(decodeURIComponent(raw ?? "")).trim().toUpperCase().replace(/-PERP$|USDT?$|USDC$|-USD$/i, "");
  if (!/^[A-Z0-9]{1,15}$/.test(sym)) throw Object.assign(new Error("symbol like BTC, ETH, SOL, HYPE"), { status: 400 });
  const [px, fund, liq, smart, opt, ev] = await Promise.all([
    safe(() => priceFor({ symbol: sym })),
    safe(() => carryNow(sym)),
    safe(() => liqMap(sym)),
    safe(() => smartCoin(sym, 24)),
    (OPT_CURRENCIES as readonly string[]).includes(sym) ? safe(() => optionsSummary(sym)) : Promise.resolve(null),
    safe(() => impactFor({ asset_id: sym, since: "24h", limit: 3 })),
  ]);
  if (!px && !fund) return null;
  const p: any = px, f: any = fund, l: any = liq, s: any = smart, o: any = opt, e: any = ev;
  const t0 = o?.term_structure?.[0];
  return {
    symbol: sym, as_of: new Date().toISOString(),
    price: p ? { mark: p.perp?.mark ?? null, spot: p.spot?.price ?? null, change_24h_pct: p.perp?.change_24h_pct ?? null, basis_pct: p.basis_pct, realized_vol_30d_ann: p.realized_vol_30d_ann, volume_24h_usd: p.perp?.volume_24h_usd ?? null } : null,
    funding: f ? { apr_now: f.funding_apr, apr_8h: f.funding_apr_8h, apr_24h: f.funding_apr_24h, open_interest_usd: f.oi_usd } : null,
    liquidations: l ? { coverage_pct_of_oi: l.coverage_pct_of_oi, nearest_long: l.nearest_long_liquidation, nearest_short: l.nearest_short_liquidation, last_24h: { count: l.liquidations_24h.count, notional_usd: l.liquidations_24h.notional_usd } } : null,
    smart_money: s?.smart ? { accounts_in_coin: s.smart_in_coin, net_usd: s.smart.net_usd, long_share_pct: s.smart_long_share_pct, all_tracked_long_share_pct: s.all_tracked_long_share_pct, flow_24h_net_usd: s.flow.net_usd, moves_24h: s.flow.moves } : null,
    options: o ? { dvol: o.dvol.now, dvol_change_24h: o.dvol.change_24h, next_expiry: t0?.expiry ?? null, atm_iv: t0?.atm_iv ?? null, rr25: t0?.rr25 ?? null, max_pain: t0?.max_pain ?? null, put_call_oi: o.put_call.oi_ratio } : null,
    events_24h: e ? { n: e.n_events, bias: e.bias, top: (e.top ?? []).slice(0, 3).map((x: any) => ({ ts: x.ts_event, kind: x.kind, title: x.title, direction: x.impact?.direction ?? null })) } : null,
    more: { liquidations: `/v1/hl/liquidations/${sym}`, smart_money: `/v1/hl/smart-money/${sym}`, funding: `/v1/carry/now/${sym}`, options: o ? `/v1/options/${sym}` : null, events: `/v1/impact/${sym}` },
    disclaimer: "Market data and analytics only — not a signal, not investment advice.",
  };
}
