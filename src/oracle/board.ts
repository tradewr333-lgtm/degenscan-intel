/** Daily oracle board: standing binary questions recomputed once a day by the scheduler, served from the DB for $0.002
 *  (tx count × tiny price — what agents actually buy). Also resolves board forecasts automatically when the source allows:
 *  price targets via priceFor() at/after resolves_at, Polymarket markets via Gamma once closed. Everything else stays
 *  `manual` for the operator (POST /v1/oracle/forecast/{id}/resolve). */
import * as tools from "../server/tools.js";
import { getDb } from "../store/db.js";
import { enqueueForecast, waitFor } from "./queue.js";
import { ensureOracleTables, resolveForecast } from "./ledger.js";
import { llmConfigured } from "./llm.js";

export type Resolution =
  | { type: "price_close_above"; symbol: string; target: number }          // spot at/after resolves_at > target
  | { type: "price_close_below"; symbol: string; target: number }          // spot at/after resolves_at < target
  | { type: "price_touch_above"; symbol: string; target: number }          // any daily high ≥ target before resolves_at (checked daily)
  | { type: "price_touch_below"; symbol: string; target: number }          // any daily low ≤ target before resolves_at (checked daily)
  | { type: "polymarket"; slug: string }                                   // Gamma market closed → outcomePrices
  | { type: "polymarket_event_any"; event_slug: string; match: string }    // YES if any market of the event whose question matches /match/ resolves YES; NO once all matching markets closed NO
  | { type: "spx_month_above_prev"; month: string }                        // last close of `month` (YYYY-MM) > last close of the previous month (Yahoo ^GSPC)
  | { type: "rvol_above"; a: string; b: string; date: string }             // rvol30(a) > rvol30(b) on `date` (YYYY-MM-DD), Hyperliquid 1d closes up to date inclusive
  | { type: "selic_cut"; meeting_date: string }                            // SGS 432 target on the first day after the meeting < target on the meeting day
  | { type: "manual"; note: string };
export interface BoardQuestion { slug: string; question: string; resolves_at: string; resolution: Resolution; source?: string }

/** Lote 1 (29/09/2026) — the eight questions the Architect committed to; slugs are stable identifiers for /v1/oracle/board/{slug}. */
export const LOTE_1: BoardQuestion[] = [
  { slug: "btc-120k-oct31", question: "Will Bitcoin close above 120,000 USD on 2026-10-31 (Coinbase daily close, UTC)?", resolves_at: "2026-10-31T23:59:59Z", resolution: { type: "price_close_above", symbol: "BTC", target: 120_000 } },
  { slug: "eth-5k-touch-oct31", question: "Will Ethereum trade above 5,000 USD at any point before 2026-10-31?", resolves_at: "2026-10-31T23:59:59Z", resolution: { type: "price_touch_above", symbol: "ETH", target: 5_000 } },
  { slug: "fed-cut-oct2026", question: "Will the US Federal Reserve cut the federal funds rate at its October 2026 FOMC meeting?", resolves_at: "2026-10-28T19:00:00Z", resolution: { type: "polymarket_event_any", event_slug: "fed-decision-in-october-20260617190323537", match: "decrease" } },
  { slug: "sol-vs-eth-rvol-oct31", question: "Will Solana close above Ethereum in 30-day realized volatility on 2026-10-31?", resolves_at: "2026-10-31T23:59:59Z", resolution: { type: "rvol_above", a: "SOL", b: "ETH", date: "2026-10-31" } },
  { slug: "crypto-mcap-up-oct2026", question: "Will total crypto market cap be higher on 2026-10-31 than on 2026-09-30 (CoinGecko)?", resolves_at: "2026-10-31T23:59:59Z", resolution: { type: "manual", note: "CoinGecko global market cap, 2026-10-31 vs 2026-09-30" } },
  { slug: "spx-oct-above-sep-2026", question: "Will the S&P 500 close October 2026 above its September 2026 close?", resolves_at: "2026-10-30T21:00:00Z", resolution: { type: "spx_month_above_prev", month: "2026-10" } },
  { slug: "copom-cut-nov2026", question: "Will Brazil's central bank (Copom) cut the Selic rate at its November 2026 meeting?", resolves_at: "2026-11-04T22:00:00Z", resolution: { type: "selic_cut", meeting_date: "2026-11-04" } },
  { slug: "btc-ath-oct2026", question: "Will a new all-time high for Bitcoin be set between 2026-09-30 and 2026-10-31?", resolves_at: "2026-10-31T23:59:59Z", resolution: { type: "manual", note: "prior ATH from Coinbase history; touch check daily" } },
];

/** Standing crypto targets regenerated from the live spot: ±10% and ±20% by month-end → four questions per coin. */
/** Lote 2 (Architect 29/09 §4) — generated, not hand-written: for BTC/ETH/SOL, targets at ±0.5σ and ±1σ of the spot at freeze
 *  time (σ = 30d realized vol × √days-to-month-end), rounded, in three variants (close_above, close_below, touch_above), pruned to
 *  ≤ 24 lines. These targets have base rates in ~0.16–0.69 — where the Brier score discriminates. Frozen for the month: once the
 *  slugs for <sym>-<month> exist in oracle_board they are reused (a moving spot must not rename questions mid-month). */
export const LOTE2_SIGMAS = [0.5, 1.0];
export async function dynamicPriceQuestions(now = new Date()): Promise<BoardQuestion[]> {
  const out: BoardQuestion[] = [];
  let end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)); // last day of this month
  if (end.getTime() - now.getTime() < 7 * 86_400_000) end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 0, 23, 59, 59)); // < 7 days left → next month-end
  const ym = end.toISOString().slice(0, 7).replace("-", "");
  const days = Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
  const endDate = end.toISOString().slice(0, 10);
  getDb().exec("CREATE TABLE IF NOT EXISTS oracle_board (slug TEXT PRIMARY KEY, question TEXT NOT NULL, resolves_at TEXT NOT NULL, resolution TEXT NOT NULL, source TEXT, updated_at TEXT NOT NULL)");
  for (const sym of ["BTC", "ETH", "SOL"]) {
    // only Lote-2 (σ-based) rows count as frozen; the earlier ±10/20% rows are superseded and get retired by refreshBoard()
    const frozen = getDb().prepare("SELECT slug, question, resolves_at, resolution, source FROM oracle_board WHERE slug LIKE ? AND source LIKE '%σ%' ORDER BY slug").all(`${sym.toLowerCase()}-%-${ym}`) as any[];
    if (frozen.length >= 4) { for (const f of frozen) out.push({ slug: f.slug, question: f.question, resolves_at: f.resolves_at, resolution: JSON.parse(f.resolution), source: f.source ?? undefined }); continue; }
    let spot: number | null = null, vol: number | null = null;
    try { const p: any = await tools.priceFor({ symbol: sym }); spot = p.spot?.price ?? p.perp?.mark ?? null; vol = p.realized_vol_30d_ann ?? null; } catch { spot = null; }
    if (!spot) continue;
    const sigma = (vol ?? 0.6) * Math.sqrt(days / 365); // fall back to 60% ann. vol if the candle source is down
    const round = (x: number) => x >= 10_000 ? Math.round(x / 500) * 500 : x >= 1000 ? Math.round(x / 50) * 50 : x >= 100 ? Math.round(x / 5) * 5 : Math.round(x);
    const lines: BoardQuestion[] = [];
    for (const k of LOTE2_SIGMAS) {
      const up = round(spot * Math.exp(k * sigma)), dn = round(spot * Math.exp(-k * sigma));
      const src = (sign: string) => `${sign}${k}σ from spot ${Math.round(spot!)} (vol ${vol ?? "n/a"}, ${days}d)`;
      lines.push({ slug: `${sym.toLowerCase()}-above-${up}-${ym}`, question: `Will ${sym} close above ${up.toLocaleString("en-US")} USD on ${endDate} (Coinbase daily close, UTC)?`, resolves_at: end.toISOString(), resolution: { type: "price_close_above", symbol: sym, target: up }, source: src("+") });
      lines.push({ slug: `${sym.toLowerCase()}-below-${dn}-${ym}`, question: `Will ${sym} close below ${dn.toLocaleString("en-US")} USD on ${endDate} (Coinbase daily close, UTC)?`, resolves_at: end.toISOString(), resolution: { type: "price_close_below", symbol: sym, target: dn }, source: src("-") });
      lines.push({ slug: `${sym.toLowerCase()}-touch-${up}-${ym}`, question: `Will ${sym} trade above ${up.toLocaleString("en-US")} USD at any point before ${endDate}?`, resolves_at: end.toISOString(), resolution: { type: "price_touch_above", symbol: sym, target: up }, source: src("+") + " touch" });
    }
    // prune to 8 per asset (24 total): drop the 0.5σ touch (closest to a coin flip with the reflection doubling) and the 1σ touch first
    const pruned = lines.filter(l => !(l.resolution.type === "price_touch_above" && l.source?.includes(`${LOTE2_SIGMAS[0]}σ`))).slice(0, 8);
    out.push(...pruned);
  }
  return out;
}

/** Top Polymarket markets by 24h volume (ending within 60 days) → board questions with automatic resolution. */
const PM_MARKET_RE = /\b(bitcoin|btc|ethereum|eth|solana|sol|crypto|stablecoin|etf|fed|fomc|rate cut|rates?|inflation|cpi|gdp|recession|tariff|oil|brent|gold|s&p|nasdaq|dow|treasury|yield|dollar|dxy|unemployment|jobs|nfp|debt ceiling|shutdown|sec\b|coinbase|binance|microstrategy|nvidia|tesla|apple)/i;
const PM_EXCLUDE_RE = /\b(vs\.?|game ?\d|match|win on|score|nba|nfl|mlb|nhl|ufc|dota|league of legends|cs2|valorant|esports|premier league|la liga|serie a|bundesliga|champions league|world cup|wta|atp|grand prix|f1)\b/i;
/** Top Polymarket markets by 24h volume that are about markets/macro/crypto (not sports/esports) and resolve in 7–45 days (Lote 2: these are the only lines that produce market_brier). */
export async function polymarketQuestions(limit = 15): Promise<BoardQuestion[]> {
  try {
    const [all, crypto] = await Promise.all([tools.polymarketTop({ sort: "volume_24h", limit: 50 }), tools.polymarketTop({ sort: "volume_24h", limit: 30, tag: "crypto" }).catch(() => ({ markets: [] }))]);
    const seen = new Set<string>(); const min = Date.now() + 7 * 86_400_000, max = Date.now() + 45 * 86_400_000;
    const pick = [...((crypto as any).markets ?? []), ...((all as any).markets ?? [])].filter((m: any) => {
      if (!m.slug || !m.question || !m.end_date || seen.has(m.slug)) return false;
      const t = new Date(m.end_date).getTime(); if (t < min || t > max) return false;
      if (PM_EXCLUDE_RE.test(m.question) || PM_EXCLUDE_RE.test(m.slug)) return false;
      if (!PM_MARKET_RE.test(m.question)) return false;
      seen.add(m.slug); return true;
    });
    return pick.slice(0, limit).map((m: any) => ({ slug: `pm-${String(m.slug).slice(0, 60)}`, question: String(m.question), resolves_at: new Date(m.end_date).toISOString(), resolution: { type: "polymarket", slug: String(m.slug) } as Resolution, source: m.url }));
  } catch { return []; }
}

export async function boardQuestions(): Promise<BoardQuestion[]> {
  const seen = new Set<string>(); const all = [...LOTE_1, ...(await dynamicPriceQuestions()), ...(await polymarketQuestions())];
  return all.filter(q => { if (seen.has(q.slug)) return false; seen.add(q.slug); return true; });
}

// ---------------------------------------------------------------- refresh
let refreshing = false;
/** Recompute every board question not yet forecast today (UTC). Sequential enqueue; the queue bounds concurrency. */
export async function refreshBoard(opts: { force?: boolean; onlySlugs?: string[]; runs?: number; population?: number; rounds?: number } = {}) {
  if (refreshing) return { skipped: "already running" };
  if (!llmConfigured()) return { skipped: "LLM backend not configured" };
  refreshing = true;
  const started = Date.now(); const queued: string[] = []; const skipped: string[] = [];
  try {
    ensureOracleTables();
    const today = new Date().toISOString().slice(0, 10);
    const allQs = await boardQuestions();
    // Retire unresolved board rows whose question left the board (e.g. a market that no longer qualifies): they stay in the
    // append-only ledger (hash intact) but leave /v1/oracle/board and are no longer auto-resolved.
    const live = new Set(allQs.map(q => q.slug));
    const stale = (getDb().prepare("SELECT DISTINCT board_slug AS slug FROM oracle_forecasts WHERE board_slug IS NOT NULL AND board_slug NOT LIKE 'retired:%' AND outcome IS NULL").all() as any[]).map(r => r.slug).filter(sl => !live.has(sl));
    for (const sl of stale) { getDb().prepare("UPDATE oracle_forecasts SET board_slug = ? WHERE board_slug = ? AND outcome IS NULL").run(`retired:${sl}`, sl); getDb().prepare("DELETE FROM oracle_board WHERE slug = ?").run(sl); }
    if (stale.length) console.log(`[oracle/board] retired ${stale.length} question(s): ${stale.join(", ")}`);
    const qs = allQs.filter(q => !opts.onlySlugs || opts.onlySlugs.includes(q.slug));
    for (const q of qs) {
      if (new Date(q.resolves_at).getTime() < Date.now() + 86_400_000) { skipped.push(`${q.slug}: resolves within 24h`); continue; }
      const last = getDb().prepare("SELECT created_at FROM oracle_forecasts WHERE board_slug = ? ORDER BY created_at DESC LIMIT 1").get(q.slug) as any;
      if (!opts.force && last && String(last.created_at).slice(0, 10) === today) { skipped.push(`${q.slug}: already today`); continue; }
      const job = enqueueForecast({ question: q.question, resolves_at: q.resolves_at, context: `Today is ${today}. Standing board question; resolution rule: ${JSON.stringify(q.resolution)}.`, runs: opts.runs ?? 6, population: opts.population ?? 20, rounds: opts.rounds ?? 3, interventions: [] }, "board", { boardSlug: q.slug });
      queued.push(job.forecast_id);
      upsertBoardMeta(q);
    }
    for (const id of queued) await waitFor(id, 900_000);
    console.log(`[oracle/board] refreshed ${queued.length} question(s) in ${Math.round((Date.now() - started) / 1000)}s; skipped ${skipped.length}`);
    return { queued: queued.length, skipped, seconds: Math.round((Date.now() - started) / 1000) };
  } finally { refreshing = false; }
}

function upsertBoardMeta(q: BoardQuestion) {
  getDb().exec("CREATE TABLE IF NOT EXISTS oracle_board (slug TEXT PRIMARY KEY, question TEXT NOT NULL, resolves_at TEXT NOT NULL, resolution TEXT NOT NULL, source TEXT, updated_at TEXT NOT NULL)");
  getDb().prepare("INSERT OR REPLACE INTO oracle_board (slug, question, resolves_at, resolution, source, updated_at) VALUES (?,?,?,?,?,?)").run(q.slug, q.question, q.resolves_at, JSON.stringify(q.resolution), q.source ?? null, new Date().toISOString());
}

// ---------------------------------------------------------------- automatic resolution
/** Resolve unresolved board forecasts whose rule can be checked mechanically. Returns what changed. */
export async function autoResolve(): Promise<{ resolved: { id: string; slug: string; outcome: boolean }[]; pending: number }> {
  ensureOracleTables();
  getDb().exec("CREATE TABLE IF NOT EXISTS oracle_board (slug TEXT PRIMARY KEY, question TEXT NOT NULL, resolves_at TEXT NOT NULL, resolution TEXT NOT NULL, source TEXT, updated_at TEXT NOT NULL)");
  const rows = getDb().prepare(`SELECT f.id, f.board_slug AS slug, f.resolves_at, f.created_at, b.resolution FROM oracle_forecasts f JOIN oracle_board b ON b.slug = f.board_slug WHERE f.outcome IS NULL AND f.board_slug IS NOT NULL`).all() as any[];
  // Legacy Lote-1 rows (Push D, board_slug NULL) resolve with the same rule as the board question they share the text with.
  const legacy = getDb().prepare(`SELECT f.id, b.slug AS slug, b.resolves_at AS resolves_at, f.created_at, b.resolution FROM oracle_forecasts f JOIN oracle_board b ON b.question = f.question WHERE f.outcome IS NULL AND f.board_slug IS NULL`).all() as any[];
  rows.push(...legacy.map(l => ({ ...l, slug: `legacy:${l.slug}` })));
  const out: { id: string; slug: string; outcome: boolean }[] = []; let pending = 0;
  const now = Date.now(); const cache = new Map<string, any>();
  for (const r of rows) {
    const rule: Resolution = JSON.parse(r.resolution);
    let outcome: boolean | null = null; let note: string | null = null;
    try {
      if (rule.type === "price_close_above" || rule.type === "price_close_below") {
        if (new Date(r.resolves_at).getTime() <= now) {
          const ck = `close:${rule.symbol}:${r.resolves_at}`;
          const close: { v: number; note: string | null } | null = cache.has(ck) ? cache.get(ck) : await dailyClose(rule.symbol, r.resolves_at); cache.set(ck, close);
          if (close != null) { outcome = rule.type === "price_close_above" ? close.v > rule.target : close.v < rule.target; note = close.note; }
        }
      } else if (rule.type === "price_touch_above" || rule.type === "price_touch_below") {
        const up = rule.type === "price_touch_above";
        const x = await extremeSince(rule.symbol, r.created_at, up ? "high" : "low", cache);
        if (x != null && (up ? x.v >= rule.target : x.v <= rule.target)) { outcome = true; note = x.note; }
        else if (new Date(r.resolves_at).getTime() <= now && x != null) { outcome = false; note = x.note; }
      } else if (rule.type === "polymarket_event_any") {
        const ev = await tools._ext.get<any[]>(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(rule.event_slug)}`, { timeoutMs: 8000 });
        const re = new RegExp(rule.match, "i");
        const ms = (ev?.[0]?.markets ?? []).filter((m: any) => re.test(String(m.question ?? "")));
        const yesOf = (m: any) => { try { const p = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; return Number(p?.[0]); } catch { return NaN; } };
        const closed = (m: any) => m.closed === true || m.umaResolutionStatus === "resolved";
        if (ms.some((m: any) => closed(m) && yesOf(m) >= 0.5)) outcome = true;
        else if (ms.length && ms.every((m: any) => closed(m))) outcome = false;
      } else if (rule.type === "spx_month_above_prev") {
        if (new Date(r.resolves_at).getTime() + 3 * 3_600_000 <= now) {
          const { spxFacts } = await import("./sources.js");
          const f = cache.get("spx") ?? await spxFacts(); cache.set("spx", f);
          const closes: { d: string; c: number }[] = f.closes ?? [];
          const [y, mo] = rule.month.split("-").map(Number); const prev = new Date(Date.UTC(y, mo - 2, 1)).toISOString().slice(0, 7);
          const lastOf = (ym: string) => [...closes].reverse().find(x => x.d.slice(0, 7) === ym);
          const cur = lastOf(rule.month), pv = lastOf(prev);
          // require a close dated in the following month, so the month's last session is final
          const hasNext = closes.some(x => x.d.slice(0, 7) > rule.month);
          if (cur && pv && (hasNext || now > Date.UTC(y, mo, 2))) outcome = cur.c > pv.c;
        }
      } else if (rule.type === "rvol_above") {
        const end = Date.parse(rule.date + "T23:59:59Z");
        if (end + 2 * 3_600_000 <= now) {
          const rv = async (coin: string) => {
            const rows = await tools._hl.post<{ t: number; T: number; c: string }[]>({ type: "candleSnapshot", req: { coin, interval: "1d", startTime: end - 40 * 86_400_000, endTime: end } });
            const cl = (rows ?? []).filter(x => x.T <= end + 1000).map(x => Number(x.c)).filter(Number.isFinite).slice(-31);
            if (cl.length < 25) return null;
            const lr = cl.slice(1).map((c, i) => Math.log(c / cl[i])); const m = lr.reduce((a, b) => a + b, 0) / lr.length;
            return Math.sqrt(lr.reduce((a, b) => a + (b - m) ** 2, 0) / (lr.length - 1));
          };
          const [va, vb] = await Promise.all([rv(rule.a), rv(rule.b)]);
          if (va != null && vb != null) outcome = va > vb;
        }
      } else if (rule.type === "selic_cut") {
        // Copom decides at the end of day 2 (~21:30 UTC); the new target shows in SGS 432 from D+1. Window: D−2 vs D+1..D+7.
        const md = Date.parse(rule.meeting_date + "T12:00:00Z");
        if (md + 86_400_000 <= now) {
          const rows = await tools._ext.get<any[]>("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/40?formato=json", { timeoutMs: 8000 });
          const pts = (rows ?? []).map((x: any) => { const [d, m, y] = String(x.data).split("/").map(Number); return { t: Date.UTC(y, m - 1, d), v: Number(String(x.valor).replace(",", ".")) }; }).filter(x => Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
          const before = [...pts].reverse().find(x => x.t <= md - 2 * 86_400_000);
          const after = [...pts].reverse().find(x => x.t <= md + 7 * 86_400_000 && x.t > md);
          if (before && after) outcome = after.v < before.v;
        }
      } else if (rule.type === "polymarket") {
        const ms = await tools._ext.get<any[]>(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(rule.slug)}`, { timeoutMs: 8000 });
        const m = Array.isArray(ms) ? ms[0] : null;
        if (m && (m.closed === true || m.umaResolutionStatus === "resolved")) { const prices = (typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices ?? []).map(Number); if (prices.length) outcome = prices[0] >= 0.5; }
      }
    } catch (e) { console.warn(`[oracle/board] resolve ${r.slug}: ${(e as Error).message}`); }
    if (outcome == null) { pending++; continue; }
    resolveForecast(r.id, outcome, note); out.push({ id: r.id, slug: r.slug, outcome });
  }
  if (out.length) console.log(`[oracle/board] auto-resolved ${out.length}: ${out.map(o => `${o.slug}=${o.outcome ? "YES" : "NO"}`).join(", ")}`);
  return { resolved: out, pending };
}

/** Coinbase daily close (UTC candle) for the calendar day of `at`; falls back to the current spot only within 6 h of that day's end. */
async function dailyClose(symbol: string, at: string): Promise<{ v: number; note: string | null } | null> {
  const day = at.slice(0, 10); const start = `${day}T00:00:00Z`; const end = `${day}T23:59:59Z`;
  try {
    const rows = await tools._ext.get<any[]>(`https://api.exchange.coinbase.com/products/${symbol}-USD/candles?granularity=86400&start=${start}&end=${end}`, { timeoutMs: 8000 });
    // [time, low, high, open, close, volume]
    const c = (rows ?? []).find((x: any) => new Date(Number(x[0]) * 1000).toISOString().slice(0, 10) === day);
    if (c && Date.now() > Date.parse(end)) return { v: Number(c[4]), note: null };
  } catch { /* fall back */ }
  if (Date.now() > Date.parse(end) && Date.now() - Date.parse(end) < 6 * 3_600_000) {
    const p: any = await tools.priceFor({ symbol }); const v = p.spot?.price ?? p.perp?.mark ?? null;
    return v == null ? null : { v, note: "spot fallback" };  // Architect 30/09 no.3 §3: an auditor must see when the official candle was not used
  }
  return null;
}
/** Highest daily high (touch above) or lowest daily low (touch below) since `from` — Hyperliquid 1d candles, today's live candle
 *  included. If the candle series is unavailable the live price is used and flagged "spot fallback". */
async function extremeSince(symbol: string, from: string, side: "high" | "low", cache: Map<string, any>): Promise<{ v: number; note: string | null } | null> {
  const key = `${side}:${symbol}:${from.slice(0, 10)}`; if (cache.has(key)) return cache.get(key);
  let out: { v: number; note: string | null } | null = null;
  try {
    const rows = await tools._hl.post<{ t: number; h: string; l: string }[]>({ type: "candleSnapshot", req: { coin: symbol, interval: "1d", startTime: Date.parse(from), endTime: Date.now() } });
    const xs = (rows ?? []).map(x => Number(side === "high" ? x.h : x.l)).filter(Number.isFinite);
    if (xs.length) out = { v: side === "high" ? Math.max(...xs) : Math.min(...xs), note: null };
  } catch { /* fall back */ }
  if (!out) { const p: any = await tools.priceFor({ symbol }).catch(() => null); const v = p?.perp?.mark ?? p?.spot?.price ?? null; out = v == null ? null : { v, note: "spot fallback" }; }
  cache.set(key, out); return out;
}

// ---------------------------------------------------------------- scheduler
/** Daily cron "M H * * *" (UTC) from ORACLE_BOARD_CRON; other fields ignored. Also runs autoResolve hourly and, when the board is empty at boot, one refresh. */
export function startBoardScheduler() {
  const cron = (process.env.ORACLE_BOARD_CRON ?? "0 6 * * *").trim().split(/\s+/);
  const minute = Number(cron[0]), hour = Number(cron[1]);
  let lastRun = "";
  const tick = () => {
    const d = new Date(); const key = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === hour && d.getUTCMinutes() === minute && lastRun !== key) { lastRun = key; autoResolve().then(() => refreshBoard()).catch(e => console.warn("[oracle/board]", (e as Error).message)); }
  };
  const t1 = setInterval(tick, 60_000);
  const t2 = setInterval(() => autoResolve().catch(() => {}), 3_600_000);
  // Extra sweeps at fixed instants (Architect 30/09 §5a): the FOMC scorecard should update in minutes, not up to an hour.
  const at = (process.env.ORACLE_RESOLVE_AT ?? "2026-10-28T19:05:00Z,2026-10-28T19:35:00Z,2026-10-29T19:05:00Z").split(",").map(x => Date.parse(x.trim())).filter(Number.isFinite);
  const fired = new Set<number>();
  const t3 = setInterval(() => { const now = Date.now(); for (const t of at) if (!fired.has(t) && now >= t && now - t < 10 * 60_000) { fired.add(t); console.log(`[oracle/board] scheduled resolve sweep ${new Date(t).toISOString()}`); autoResolve().catch(() => {}); } }, 30_000);
  setTimeout(() => {
    ensureOracleTables();
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM oracle_forecasts WHERE board_slug IS NOT NULL").get() as any).n;
    if (n === 0 && process.env.ORACLE_BOARD_BOOTSTRAP !== "0") { console.log("[oracle/board] empty board → bootstrapping"); refreshBoard().catch(e => console.warn("[oracle/board]", (e as Error).message)); }
  }, 90_000);
  console.log(`[oracle/board] scheduler: daily at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} UTC, auto-resolve hourly`);
  return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3); };
}
