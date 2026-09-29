/** Extra grounded facts for the oracle context (Architect 29/09 §2): Selic + Focus (BCB), S&P 500 close + 30d vol (Stooq),
 *  total crypto market cap (CoinGecko), SOL vs ETH realized vols (our own price_for). All public, no key, cached, failures
 *  become `unavailable` entries — never errors. Uses tools._ext.get so tests can mock. */
import * as tools from "../server/tools.js";
import { baseRateThreshold } from "./context.js";

const r = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key); if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn(); cache.set(key, { at: Date.now(), v }); return v;
}
export const _sources = { reset() { cache.clear(); } };

/** Selic target (SGS 432) + Focus median expectation for the next meetings → synthetic odds of a cut. */
export async function selicFacts(): Promise<{ facts: Record<string, unknown>; market_odds: number | null; note: string }> {
  const meta = await cached("selic:meta", 6 * 3_600_000, () => tools._ext.get<any[]>("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json", { timeoutMs: 8000 }));
  const selic = Number(String(meta?.[0]?.valor ?? "").replace(",", "."));
  let focus: any[] = [];
  try {
    const j = await cached("selic:focus", 6 * 3_600_000, () => tools._ext.get<any>("https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoSelic?$top=12&$orderby=Data%20desc&$format=json", { timeoutMs: 10000 }));
    focus = Array.isArray(j?.value) ? j.value : [];
  } catch { focus = []; }
  // latest survey date, first upcoming meeting
  const latestDate = focus.map(f => f.Data).sort().pop();
  const rows = focus.filter(f => f.Data === latestDate).sort((a, b) => String(a.Reuniao).localeCompare(String(b.Reuniao)));
  const next = rows[0];
  const median = next ? Number(next.Mediana) : null;
  const facts: Record<string, unknown> = { selic_target_pct: Number.isFinite(selic) ? selic : null, focus_survey_date: latestDate ?? null, focus_next_meeting: next?.Reuniao ?? null, focus_median_next_pct: median, focus_min_next_pct: next ? Number(next.Minimo) : null, focus_max_next_pct: next ? Number(next.Maximo) : null, focus_respondents: next ? Number(next.numeroRespondentes) : null };
  // synthetic odds of a cut at the next meeting: how far the median sits below the current target, scaled by the survey range
  let odds: number | null = null; let note = "no Focus data";
  if (Number.isFinite(selic) && median != null && next) {
    const lo = Number(next.Minimo), hi = Number(next.Maximo);
    if (median < selic - 0.1) odds = 0.85; else if (median < selic) odds = 0.6; else if (median > selic + 0.1) odds = 0.05; else odds = lo < selic ? 0.25 : 0.1;
    note = `synthetic from Focus: target ${selic}%, median for ${next.Reuniao} = ${median}% (range ${lo}–${hi})`;
  }
  return { facts, market_odds: odds, note };
}

/** S&P 500 daily closes: Yahoo Finance chart JSON (^GSPC, no key) first, Stooq CSV as fallback. Last close, prior month-end close, 30d realized vol. */
export async function spxFacts(): Promise<{ provider?: string; closes?: { d: string; c: number }[]; facts: Record<string, unknown>; spot: number | null; vol: number | null; prevMonthClose: number | null }> {
  const got: { src: string; closes: { d: string; c: number }[] } = await cached("spx:closes", 3_600_000, async () => {
    try {
      const j = await tools._ext.get<any>("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=3mo&interval=1d", { timeoutMs: 10000 });
      const r = j?.chart?.result?.[0]; const ts: number[] = r?.timestamp ?? []; const cl: (number | null)[] = r?.indicators?.quote?.[0]?.close ?? [];
      const out = ts.map((t, i) => ({ d: new Date(t * 1000).toISOString().slice(0, 10), c: Number(cl[i]) })).filter(x => Number.isFinite(x.c));
      if (out.length >= 25) return { src: "yahoo_finance", closes: out };
    } catch { /* fall through */ }
    const csv = await tools._ext.get<string>("https://stooq.com/q/d/l/?s=^spx&i=d", { timeoutMs: 10000, text: true });
    return { src: "stooq", closes: String(csv).trim().split(/\r?\n/).slice(1).map(l => l.split(",")).filter(c => c.length >= 5 && Number.isFinite(Number(c[4]))).map(c => ({ d: c[0], c: Number(c[4]) })) };
  });
  const closes = got.closes;
  if (closes.length < 25) return { facts: { spx: "unavailable" }, spot: null, vol: null, prevMonthClose: null };
  const last = closes[closes.length - 1];
  const win = closes.slice(-31); const lr = win.slice(1).map((x, i) => Math.log(x.c / win[i].c));
  const mean = lr.reduce((a, b) => a + b, 0) / lr.length; const sd = Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / (lr.length - 1));
  const vol = r(sd * Math.sqrt(252));
  const ym = last.d.slice(0, 7);
  const prevMonth = [...closes].reverse().find(x => x.d.slice(0, 7) < ym);
  return { provider: got.src, closes, facts: { spx_close: last.c, spx_close_date: last.d, spx_prev_month_close: prevMonth?.c ?? null, spx_prev_month_close_date: prevMonth?.d ?? null, spx_realized_vol_30d_ann: vol, spx_mtd_pct: prevMonth ? r((last.c / prevMonth.c - 1) * 100, 2) : null }, spot: last.c, vol, prevMonthClose: prevMonth?.c ?? null };
}

/** Total crypto market cap: Coinlore /global (no key, generous limits) first, CoinGecko /global as fallback; BTC 30d realized vol from our own price_for as the vol proxy. */
export async function mcapFacts(): Promise<{ facts: Record<string, unknown>; mcap: number | null; vol: number | null }> {
  const g = await cached("mcap:global", 3_600_000, async () => {
    try { const j = await tools._ext.get<any[]>("https://api.coinlore.net/api/global/", { timeoutMs: 10000 }); const x = Array.isArray(j) ? j[0] : null; if (x?.total_mcap) return { mcap: Number(x.total_mcap), chg24: Number(x.mcap_change), btc_d: Number(x.btc_d), src: "coinlore" }; } catch { /* fall through */ }
    const j = await tools._ext.get<any>("https://api.coingecko.com/api/v3/global", { timeoutMs: 10000 });
    return { mcap: Number(j?.data?.total_market_cap?.usd), chg24: Number(j?.data?.market_cap_change_percentage_24h_usd), btc_d: Number(j?.data?.market_cap_percentage?.btc), src: "coingecko" };
  });
  let vol: number | null = null;
  try { const p: any = await tools.priceFor({ symbol: "BTC" }); vol = p.realized_vol_30d_ann ?? null; } catch { vol = null; }
  const ok = Number.isFinite(g.mcap);
  return { facts: { total_crypto_mcap_usd: ok ? Math.round(g.mcap) : null, mcap_change_24h_pct: Number.isFinite(g.chg24) ? r(g.chg24, 2) : null, btc_share_pct: Number.isFinite(g.btc_d) ? r(g.btc_d, 1) : null, mcap_vol_proxy_btc_30d_ann: vol, mcap_source: g.src }, mcap: ok ? g.mcap : null, vol };
}

/** Dispatcher: which extra facts a question needs. Returns grounded facts and, when possible, a synthetic market_odds or base_rate. */
export async function extraFactsFor(question: string, ctx: { asset: string | null; horizon_days: number | null }) {
  const q = question.toLowerCase();
  const facts: Record<string, unknown> = {}; const sources: string[] = []; const unavailable: string[] = [];
  // label = the datum, provider = who served it (Architect 30/09 §4.1)
  const provider: Record<string, string> = {}; facts.provider = provider;
  let market_odds: number | null | undefined, market_ref: string | null | undefined, base_rate: number | null | undefined, base_rate_note: string | undefined;
  const errName = (e: unknown) => (e instanceof Error ? e.message.slice(0, 60) : String(e));

  if (/\b(copom|selic|bcb|banco central do brasil|brazil'?s central bank)\b/.test(q)) {
    try { const s = await selicFacts(); Object.assign(facts, s.facts); sources.push("selic_focus"); provider.selic_focus = "bcb_sgs_432+focus_olinda"; if (/\b(cut|cortar|corte|reduz|lower)\b/.test(q) && s.market_odds != null) { market_odds = s.market_odds; market_ref = "https://www.bcb.gov.br/controleinflacao/historicotaxasjuros (Focus median)"; facts.selic_note = s.note; } }
    catch (e) { unavailable.push(`selic_focus: ${errName(e)}`); }
  }
  if (ctx.asset === "SPX" || /\b(s&p|spx|s&p 500)\b/.test(q)) {
    try {
      const s = await spxFacts(); Object.assign(facts, s.facts); sources.push("spx_close"); provider.spx_close = s.provider ?? "unknown";
      // "close October above its September close" → threshold = prev month close, horizon = days to month end
      if (s.spot && s.prevMonthClose && s.vol && /\b(above|acima|higher)\b/.test(q) && /\b(close|fecha)\b/.test(q)) {
        const h = ctx.horizon_days ?? Math.max(1, Math.ceil((Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0) - Date.now()) / 86_400_000));
        const dist = (s.prevMonthClose / s.spot - 1) * 100;
        const [br, note] = baseRateThreshold(dist, s.vol, h, false);
        base_rate = br; base_rate_note = `SPX vs prior month-end close (${s.prevMonthClose}) from spot ${s.spot}; ${note}`;
      }
    } catch (e) { unavailable.push(`spx_close: ${errName(e)}`); }
  }
  if (/\b(market cap|mcap|total crypto|capitaliza)/.test(q)) {
    try {
      const m = await mcapFacts(); Object.assign(facts, m.facts); sources.push("crypto_mcap"); provider.crypto_mcap = String(m.facts.mcap_source ?? "unknown");
      if (m.mcap && m.vol && ctx.horizon_days) {
        // "higher on day X than on day Y": the reference level is (approximately) today's level → driftless walk gives ~0.5;
        // the panel moves it with calendar/positioning. Distance 0 by construction until the reference date has passed.
        const [br, note] = baseRateThreshold(0, m.vol, ctx.horizon_days, false);
        base_rate = br; base_rate_note = `total mcap vs reference level ≈ today's (${Math.round(m.mcap / 1e9)}B USD); ${note}`;
      }
    } catch (e) { unavailable.push(`crypto_mcap: ${errName(e)}`); }
  }
  if (/\b(realized vol|realised vol|volatility|rvol)\b/.test(q) && /\b(sol|solana)\b/.test(q) && /\b(eth|ethereum)\b/.test(q)) {
    try {
      const [sol, eth] = await Promise.all([tools.priceFor({ symbol: "SOL" }), tools.priceFor({ symbol: "ETH" })]);
      const vs = (sol as any).realized_vol_30d_ann, ve = (eth as any).realized_vol_30d_ann;
      Object.assign(facts, { sol_realized_vol_30d_ann: vs, eth_realized_vol_30d_ann: ve, sol_minus_eth_vol: vs != null && ve != null ? r(vs - ve) : null }); sources.push("rvol_sol_eth"); provider.rvol_sol_eth = "hyperliquid_1d_candles";
      if (vs != null && ve != null) {
        const h = Math.max(1, ctx.horizon_days ?? 31);
        const per = await rvolPersistence("SOL", "ETH", h).catch(() => null);
        if (per && per.n >= 60) {
          base_rate = vs > ve ? per.persistence : r(1 - per.persistence, 3);
          base_rate_note = `measured persistence of sign(rvol30 SOL − rvol30 ETH) over ${per.h_days}d: ${per.persistence} (n=${per.n} overlapping samples, last ${per.window_days}d of Hyperliquid 1d candles); today SOL ${vs} vs ETH ${ve}`;
          Object.assign(facts, { rvol_persistence: per.persistence, rvol_persistence_n: per.n, rvol_persistence_h_days: per.h_days });
        } else {
          base_rate = vs > ve ? 0.78 : 0.22;
          Object.assign(facts, { rvol_persistence_n: per?.n ?? 0 });
          base_rate_note = `provisional: assumed persistence 0.78 (measured series unavailable); today SOL ${vs} vs ETH ${ve}`;
        }
      }
    } catch (e) { unavailable.push(`rvol_sol_eth: ${errName(e)}`); }
  }
  if (!Object.keys(provider).length) delete facts.provider;
  return { facts, sources, unavailable, market_odds, market_ref, base_rate, base_rate_note };
}

/** Empirical persistence of the realized-vol ranking between two coins (Architect 30/09 §4.2): for each day t in the last
 *  `windowDays`, s(t) = sign(rvol30_A(t) − rvol30_B(t)); persistence = share of t with s(t) == s(t+h). Daily closes from
 *  Hyperliquid candleSnapshot 1d; cached 24 h per (A,B,h). */
export async function rvolPersistence(a: string, b: string, h0: number, windowDays = 180): Promise<{ persistence: number; n: number; window_days: number; h_days: number }> {
  // Architect 30/09 no.3 §2.2(a): persistence depends on h → cache per horizon, h rounded to 5 days
  const h = Math.max(5, Math.round(h0 / 5) * 5);
  return cached(`rvolpers:${a}:${b}:${h}:${windowDays}`, 24 * 3_600_000, async () => {
    const now = Date.now(); const start = now - (windowDays + h + 40) * 86_400_000;
    const load = async (coin: string) => {
      const rows = await tools._hl.post<{ t: number; T: number; c: string }[]>({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: start, endTime: now } });
      return (rows ?? []).filter(x => x.T <= now).map(x => ({ day: new Date(x.t).toISOString().slice(0, 10), c: Number(x.c) })).filter(x => Number.isFinite(x.c));
    };
    const [ca, cb] = await Promise.all([load(a), load(b)]);
    const mb = new Map(cb.map(x => [x.day, x.c]));
    const days = ca.filter(x => mb.has(x.day)).map(x => ({ day: x.day, a: x.c, b: mb.get(x.day)! }));
    const rv = (xs: number[]) => { const lr = xs.slice(1).map((c, i) => Math.log(c / xs[i])); const m = lr.reduce((p, q) => p + q, 0) / lr.length; return Math.sqrt(lr.reduce((p, q) => p + (q - m) ** 2, 0) / (lr.length - 1)); };
    const sign: number[] = [];
    for (let i = 30; i < days.length; i++) { const wa = days.slice(i - 30, i + 1).map(d => d.a), wb = days.slice(i - 30, i + 1).map(d => d.b); sign.push(Math.sign(rv(wa) - rv(wb))); }
    const first = Math.max(0, sign.length - h - windowDays);
    let same = 0, n = 0;
    for (let t = first; t + h < sign.length; t++) { if (sign[t] === 0 || sign[t + h] === 0) continue; n++; if (sign[t] === sign[t + h]) same++; }
    // Laplace smoothing (same+1)/(n+2): overlapping samples are not independent, never report certainty
    return { persistence: r((same + 1) / (n + 2), 3), n, window_days: windowDays, h_days: h };
  });
}
