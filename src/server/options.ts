/**
 * Crypto options analytics from Deribit's public market-data API (Renato 17/10, item 2): BTC and ETH.
 * Derived numbers only (we compute them; no order-book redistribution): ATM implied vol term structure, 25-delta risk
 * reversal and butterfly (Black-Scholes deltas from Deribit mark IV), put/call open-interest and volume ratios,
 * max pain per expiry, the DVOL index and its 24 h change. 60 s cache. Market data and analytics only — not investment advice.
 */
import { UA } from "../ingest/http.js";

const DERIBIT = process.env.DERIBIT_URL ?? "https://www.deribit.com/api/v2";
export const OPT_DISCLAIMER = "Derived from Deribit public market data. Market data only — not investment advice.";
export const OPT_CURRENCIES = ["BTC", "ETH"] as const;
const MON: Record<string, number> = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(`${DERIBIT}${path}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`deribit ${r.status}`);
  const j: any = await r.json(); if (j?.error) throw new Error(`deribit ${j.error.message ?? "error"}`);
  return j.result as T;
}
const memo = new Map<string, { at: number; v: any }>();
async function cached<T>(k: string, f: () => Promise<T>, ttl = 60_000): Promise<T> {
  const c = memo.get(k); if (c && Date.now() - c.at < ttl) return c.v as T;
  const v = await f(); memo.set(k, { at: Date.now(), v }); return v;
}

export interface Opt { name: string; expiry: string; exp_ms: number; strike: number; type: "C" | "P"; iv: number | null; oi: number; vol: number; under: number }
/** "BTC-19OCT26-71000-C" → parts; Deribit options expire 08:00 UTC. */
export function parseInstrument(name: string) {
  const m = /^([A-Z]+)-(\d{1,2})([A-Z]{3})(\d{2})-([\d.]+)-([CP])$/.exec(name); if (!m) return null;
  const exp_ms = Date.UTC(2000 + Number(m[4]), MON[m[3]], Number(m[2]), 8);
  return { expiry: `${m[2]}${m[3]}${m[4]}`, exp_ms, strike: Number(m[5]), type: m[6] as "C" | "P" };
}
export function toOpts(rows: any[]): Opt[] {
  const out: Opt[] = [];
  for (const r of rows ?? []) { const p = parseInstrument(String(r?.instrument_name ?? "")); if (!p) continue;
    out.push({ name: r.instrument_name, ...p, iv: Number.isFinite(r.mark_iv) && r.mark_iv > 0 ? r.mark_iv : null, oi: Number(r.open_interest) || 0, vol: Number(r.volume) || 0, under: Number(r.underlying_price) || 0 }); }
  return out;
}

// Black-Scholes call delta with zero rates on the forward (Deribit's underlying_price is the expiry's future)
const ncdf = (x: number) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
export const callDelta = (F: number, K: number, ivPct: number, T: number) => { const s = ivPct / 100; if (!(s > 0 && T > 0)) return F > K ? 1 : 0; return ncdf((Math.log(F / K) + 0.5 * s * s * T) / (s * Math.sqrt(T))); };
const r2 = (x: number | null) => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

/** IV at a target delta by linear interpolation over strikes (calls: delta 0.25; puts: delta −0.25). */
function ivAtDelta(list: Opt[], F: number, T: number, target: number, type: "C" | "P") {
  const pts = list.filter(o => o.type === type && o.iv).map(o => ({ d: type === "C" ? callDelta(F, o.strike, o.iv!, T) : callDelta(F, o.strike, o.iv!, T) - 1, iv: o.iv! })).sort((a, b) => a.d - b.d);
  for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; if ((a.d - target) * (b.d - target) <= 0 && b.d !== a.d) return a.iv + (b.iv - a.iv) * (target - a.d) / (b.d - a.d); }
  return null;
}

/** Max pain: the settlement price (among listed strikes) that minimises the total intrinsic value paid to option holders. */
export function maxPain(list: Opt[]) {
  const strikes = [...new Set(list.map(o => o.strike))].sort((a, b) => a - b); if (!strikes.length) return null;
  let best = strikes[0], bestPay = Infinity;
  for (const S of strikes) { let pay = 0; for (const o of list) pay += o.oi * (o.type === "C" ? Math.max(0, S - o.strike) : Math.max(0, o.strike - S)); if (pay < bestPay) { bestPay = pay; best = S; } }
  return best;
}

export function analyse(currency: string, opts: Opt[], now = Date.now()) {
  const by = new Map<string, Opt[]>(); for (const o of opts) if (o.exp_ms > now) (by.get(o.expiry) ?? by.set(o.expiry, []).get(o.expiry)!).push(o);
  const exps = [...by.entries()].sort((a, b) => a[1][0].exp_ms - b[1][0].exp_ms);
  const term = exps.map(([expiry, list]) => {
    const T = (list[0].exp_ms - now) / (365 * 86_400_000); const F = list.find(o => o.under)?.under ?? 0;
    const atmK = list.reduce((b, o) => Math.abs(o.strike - F) < Math.abs(b - F) ? o.strike : b, list[0].strike);
    const atm = list.filter(o => o.strike === atmK && o.iv).map(o => o.iv!); const atmIv = atm.length ? atm.reduce((a, x) => a + x, 0) / atm.length : null;
    const c25 = ivAtDelta(list, F, T, 0.25, "C"), p25 = ivAtDelta(list, F, T, -0.25, "P");
    const oiC = list.filter(o => o.type === "C").reduce((a, o) => a + o.oi, 0), oiP = list.filter(o => o.type === "P").reduce((a, o) => a + o.oi, 0);
    const mp = maxPain(list);
    return { expiry, expires_at: new Date(list[0].exp_ms).toISOString(), days: r2(T * 365), forward: r2(F), atm_iv: r2(atmIv), rr25: c25 != null && p25 != null ? r2(c25 - p25) : null,
      bf25: c25 != null && p25 != null && atmIv != null ? r2((c25 + p25) / 2 - atmIv) : null, open_interest: { calls: r2(oiC), puts: r2(oiP) }, max_pain: mp, max_pain_distance_pct: mp && F ? r2((mp - F) / F * 100) : null };
  });
  const oiC = opts.filter(o => o.type === "C").reduce((a, o) => a + o.oi, 0), oiP = opts.filter(o => o.type === "P").reduce((a, o) => a + o.oi, 0);
  const vC = opts.filter(o => o.type === "C").reduce((a, o) => a + o.vol, 0), vP = opts.filter(o => o.type === "P").reduce((a, o) => a + o.vol, 0);
  return { term, put_call: { oi_ratio: oiC ? r2(oiP / oiC) : null, volume_24h_ratio: vC ? r2(vP / vC) : null, oi_calls: r2(oiC), oi_puts: r2(oiP), volume_24h_calls: r2(vC), volume_24h_puts: r2(vP), unit: currency },
    top_open_interest: [...opts].sort((a, b) => b.oi - a.oi).slice(0, 5).map(o => ({ instrument: o.name, open_interest: o.oi, iv: o.iv })) };
}

function cur(raw: string) { const c = String(raw ?? "").trim().toUpperCase(); if (!(OPT_CURRENCIES as readonly string[]).includes(c)) throw Object.assign(new Error("currency must be BTC or ETH"), { status: 400 }); return c; }
const book = (c: string) => cached(`book:${c}`, async () => toOpts(await get<any[]>(`/public/get_book_summary_by_currency?currency=${c}&kind=option`)));

export async function optionsSummary(raw: string) {
  const c = cur(raw);
  return cached(`sum:${c}`, async () => {
    const now = Date.now();
    const [opts, dv, idx] = await Promise.all([book(c),
      get<any>(`/public/get_volatility_index_data?currency=${c}&start_timestamp=${now - 26 * 3_600_000}&end_timestamp=${now}&resolution=3600`).catch(() => null),
      get<any>(`/public/get_index_price?index_name=${c.toLowerCase()}_usd`).catch(() => null)]);
    const a = analyse(c, opts, now); const d: any[] = dv?.data ?? [];
    const dvNow = d.length ? d[d.length - 1][4] : null; const dv24 = d.find((x: any[]) => x[0] >= now - 24.5 * 3_600_000)?.[4] ?? null;
    return { currency: c, as_of: new Date(now).toISOString(), index_price: r2(idx?.index_price ?? null), dvol: { now: r2(dvNow), change_24h: dvNow != null && dv24 != null ? r2(dvNow - dv24) : null },
      term_structure: a.term.slice(0, 8), put_call: a.put_call, top_open_interest: a.top_open_interest,
      fields: { atm_iv: "implied vol at the strike nearest the expiry future, %", rr25: "25-delta call IV minus 25-delta put IV (vol points; negative = puts richer)", bf25: "25-delta wings average minus ATM (vol points)", max_pain: "settlement price minimising total payout to option holders" },
      disclaimer: OPT_DISCLAIMER };
  });
}

/** Micro: max pain and open interest for one expiry (default: the next expiry with open interest). */
export async function optionsMaxPain(raw: string, expiryRaw?: unknown) {
  const c = cur(raw);
  const opts = await book(c); const now = Date.now();
  const want = String(expiryRaw ?? "").trim().toUpperCase();
  const a = analyse(c, opts, now).term.filter(t => (t.open_interest.calls ?? 0) + (t.open_interest.puts ?? 0) > 0);
  const t = want ? a.find(x => x.expiry === want) : a[0]; if (!t) return null;
  return { currency: c, expiry: t.expiry, expires_at: t.expires_at, forward: t.forward, max_pain: t.max_pain, max_pain_distance_pct: t.max_pain_distance_pct,
    open_interest: t.open_interest, put_call_oi_ratio: t.open_interest.calls ? r2((t.open_interest.puts ?? 0) / t.open_interest.calls) : null, atm_iv: t.atm_iv,
    next_expiries: a.slice(0, 6).map(x => x.expiry), disclaimer: OPT_DISCLAIMER };
}
