/**
 * Hyperliquid liquidation map (Renato 17/10, item 1). Public data only:
 *  - the public Hyperliquid leaderboard (stats-data) gives every account's 30-day volume; we track the N most active
 *    (default 300) — the accounts that carry most of the open interest;
 *  - every 15 min we read each tracked account's open perp positions (clearinghouseState: size, entry, liquidation price);
 *  - per coin we aggregate long/short notional, liquidation-price bands by distance from mark and the nearest clusters;
 *  - when a tracked position disappears or shrinks we check that account's fills for Hyperliquid's own `liquidation`
 *    marker, so liquidations_24h lists confirmed liquidations only.
 * Coverage is reported as tracked notional / total open interest — it is a sample of the largest accounts, never the
 * whole book. Main dex only (HIP-3 dexes later). Market data and analytics only — not investment advice.
 */
import { getDb } from "../store/db.js";
import { info } from "./hl.js";
import { UA } from "../ingest/http.js";

const LEADERBOARD = process.env.HL_LEADERBOARD_URL ?? "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";
const N_ACCOUNTS = Number(process.env.LIQ_ACCOUNTS ?? 300);
const ROUND_MS = Number(process.env.LIQ_ROUND_MS ?? 15 * 60_000);
const GAP_MS = Number(process.env.LIQ_GAP_MS ?? 250);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
export const LIQ_DISCLAIMER = "Sample of the most active Hyperliquid accounts, not the whole order book. Market data only — not investment advice.";

let ready = false;
export function ensureLiqTables() {
  if (ready) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS hl_liq_pos (
      addr TEXT NOT NULL, coin TEXT NOT NULL, szi REAL NOT NULL, entry REAL, value_usd REAL, liq_px REAL, lev REAL, ts INTEGER NOT NULL,
      PRIMARY KEY (addr, coin)
    );
    CREATE TABLE IF NOT EXISTS hl_liq_events (
      ts INTEGER NOT NULL, addr TEXT NOT NULL, coin TEXT NOT NULL, side TEXT NOT NULL, size REAL, px REAL, value_usd REAL, tid TEXT,
      PRIMARY KEY (addr, coin, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_liqev_ts ON hl_liq_events(ts);
    CREATE TABLE IF NOT EXISTS hl_liq_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  ready = true;
}

/** Leaderboard text → the N addresses with the highest 30-day volume. Regex over the raw text (the file is ~40 MB;
 *  no JSON.parse of the whole document, so the instance memory stays flat). */
export function topAccounts(text: string, n = N_ACCOUNTS): string[] {
  const out: { a: string; v: number }[] = [];
  const re = /"ethAddress":\s*"(0x[0-9a-fA-F]{40})"/g; const idx: { a: string; i: number }[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) idx.push({ a: m[1].toLowerCase(), i: m.index });
  const mv = /"month",\s*\{\s*"pnl":\s*"[^"]*",\s*"roi":\s*"[^"]*",\s*"vlm":\s*"([0-9.eE+\-]+)"/;
  for (let k = 0; k < idx.length; k++) {
    const chunk = text.slice(idx[k].i, k + 1 < idx.length ? idx[k + 1].i : undefined);
    const v = Number(mv.exec(chunk)?.[1] ?? 0); if (v > 0) out.push({ a: idx[k].a, v });
  }
  return out.sort((x, y) => y.v - x.v).slice(0, n).map(x => x.a);
}

let accounts: string[] = []; let accountsAt = 0;
let last: { at: string | null; accounts: number; positions: number; liquidations: number; ms: number; error?: string } = { at: null, accounts: 0, positions: 0, liquidations: 0, ms: 0 };
export const liqStatus = () => last;

async function refreshAccounts() {
  if (accounts.length && Date.now() - accountsAt < 6 * 3_600_000) return;
  const r = await fetch(LEADERBOARD, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`leaderboard ${r.status}`);
  const a = topAccounts(await r.text()); if (a.length) { accounts = a; accountsAt = Date.now(); }
}

/** One round: positions of every tracked account; confirmed liquidations for positions that vanished or shrank. */
export async function liqRound(now = Date.now()) {
  ensureLiqTables(); const t0 = Date.now();
  await refreshAccounts();
  const db = getDb();
  const prev = new Map<string, { szi: number; liq_px: number | null }>();
  for (const r of db.prepare("SELECT addr, coin, szi, liq_px FROM hl_liq_pos").all() as any[]) prev.set(`${r.addr}|${r.coin}`, { szi: r.szi, liq_px: r.liq_px });
  const fresh: any[] = []; const seen = new Set<string>(); const shrunk: { addr: string; coin: string }[] = []; const okAddr = new Set<string>();
  for (const addr of accounts) {
    try {
      const cs = await info<any>({ type: "clearinghouseState", user: addr }); okAddr.add(addr);
      for (const p of (cs?.assetPositions ?? []) as any[]) {
        const q = p?.position; const szi = num(q?.szi); if (!q?.coin || !szi) continue;
        fresh.push([addr, String(q.coin), szi, num(q.entryPx), Math.abs(num(q.positionValue) ?? 0), num(q.liquidationPx), num(q?.leverage?.value), now]);
        seen.add(`${addr}|${q.coin}`);
        const pv = prev.get(`${addr}|${q.coin}`); if (pv && Math.sign(pv.szi) === Math.sign(szi) && Math.abs(szi) < Math.abs(pv.szi) * 0.8) shrunk.push({ addr, coin: String(q.coin) });
      }
    } catch { /* one account failing never stops the round */ }
    await sleep(GAP_MS);
  }
  for (const k of prev.keys()) { const [addr, coin] = k.split("|"); if (okAddr.has(addr) && !seen.has(k)) shrunk.push({ addr, coin }); }
  // confirmed liquidations: Hyperliquid marks liquidation fills with a `liquidation` object
  let liqs = 0; const since = now - ROUND_MS * 2;
  const insE = db.prepare("INSERT OR IGNORE INTO hl_liq_events (ts, addr, coin, side, size, px, value_usd, tid) VALUES (?,?,?,?,?,?,?,?)");
  const byAddr = new Map<string, Set<string>>(); for (const s of shrunk) (byAddr.get(s.addr) ?? byAddr.set(s.addr, new Set()).get(s.addr)!).add(s.coin);
  for (const [addr, coins] of byAddr) {
    try {
      const fills = await info<any[]>({ type: "userFillsByTime", user: addr, startTime: since });
      for (const f of fills ?? []) {
        if (!f?.liquidation || !coins.has(String(f.coin))) continue;
        const sz = num(f.sz) ?? 0, px = num(f.px) ?? 0;
        // the liquidated side is the position that was closed: a sell closes a long
        insE.run(Number(f.time), addr, String(f.coin), f.side === "A" ? "long" : "short", sz, px, sz * px, String(f.tid ?? "")); liqs++;
      }
    } catch { /* skip */ }
    await sleep(GAP_MS);
  }
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM hl_liq_pos WHERE addr IN (SELECT value FROM json_each(?))").run(JSON.stringify([...okAddr]));
    const ins = db.prepare("INSERT OR REPLACE INTO hl_liq_pos (addr, coin, szi, entry, value_usd, liq_px, lev, ts) VALUES (?,?,?,?,?,?,?,?)");
    for (const r of fresh) ins.run(...r);
    db.prepare("DELETE FROM hl_liq_pos WHERE ts < ?").run(now - 2 * 3_600_000);   // accounts that left the tracked set
    db.prepare("DELETE FROM hl_liq_events WHERE ts < ?").run(now - 7 * 86_400_000);
    db.prepare("INSERT OR REPLACE INTO hl_liq_meta (k, v) VALUES ('last_round', ?)").run(String(now));
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  last = { at: new Date(now).toISOString(), accounts: okAddr.size, positions: fresh.length, liquidations: liqs, ms: Date.now() - t0 };
  return last;
}

export function startLiqCollector() {
  if (process.env.LIQ_COLLECTOR === "0") return;
  ensureLiqTables();
  let running = false;
  const run = () => { if (running) return; running = true; liqRound().catch(e => { last = { ...last, error: (e as Error).message }; console.warn("[liq]", (e as Error).message); }).finally(() => { running = false; }); };
  setTimeout(run, 120_000);
  setInterval(run, ROUND_MS).unref();
  console.log(`[liq] Hyperliquid liquidation map: ${N_ACCOUNTS} most active accounts every ${Math.round(ROUND_MS / 60_000)} min`);
}

/** Fresh marks and open interest for the main dex (60 s cache). */
let ctxCache: { at: number; v: Map<string, { mark: number; oi_usd: number }> } | null = null;
async function marks() {
  if (ctxCache && Date.now() - ctxCache.at < 60_000) return ctxCache.v;
  const m = await info<any[]>({ type: "metaAndAssetCtxs" });
  const v = new Map<string, { mark: number; oi_usd: number }>();
  (m?.[0]?.universe ?? []).forEach((u: any, i: number) => { const c = m?.[1]?.[i] ?? {}; const mk = num(c.markPx); if (mk) v.set(String(u.name), { mark: mk, oi_usd: mk * (num(c.openInterest) ?? 0) }); });
  ctxCache = { at: Date.now(), v }; return v;
}
const r2 = (x: number) => Math.round(x * 100) / 100;
const usd = (x: number) => Math.round(x);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function asOf() { ensureLiqTables(); const r = getDb().prepare("SELECT v FROM hl_liq_meta WHERE k = 'last_round'").get() as any; return r ? new Date(Number(r.v)).toISOString() : null; }

/** Per coin: longs/shorts, liquidation bands (2% steps out to ±20%), nearest clusters, confirmed liquidations 24h. */
export async function liqMap(coinRaw: string, mk?: Map<string, { mark: number; oi_usd: number }>) {
  ensureLiqTables();
  const coin = String(decodeURIComponent(coinRaw ?? "")).trim().toUpperCase();
  const rows = getDb().prepare("SELECT szi, entry, value_usd, liq_px FROM hl_liq_pos WHERE coin = ?").all(coin) as any[];
  const ctx = (mk ?? await marks()).get(coin);
  if (!ctx && !rows.length) return null;
  const mark = ctx?.mark ?? null;
  const side = (s: 1 | -1) => { const r = rows.filter(x => Math.sign(x.szi) === s); const n = r.reduce((a, x) => a + x.value_usd, 0); const sz = r.reduce((a, x) => a + Math.abs(x.szi), 0);
    return { positions: r.length, notional_usd: usd(n), avg_entry: sz ? r2(r.reduce((a, x) => a + Math.abs(x.szi) * (x.entry ?? 0), 0) / sz) : null }; };
  const bands: { side: string; from_pct: number; to_pct: number; price_from: number | null; price_to: number | null; notional_usd: number }[] = [];
  if (mark) for (const s of [1, -1] as const) for (let b = 0; b < 10; b++) {
    const lo = b * 2, hi = lo + 2;
    const n = rows.filter(x => Math.sign(x.szi) === s && x.liq_px).reduce((a, x) => { const d = s === 1 ? (mark - x.liq_px) / mark * 100 : (x.liq_px - mark) / mark * 100; return d >= lo && d < hi ? a + x.value_usd : a; }, 0);
    if (n > 0) bands.push({ side: s === 1 ? "long" : "short", from_pct: s === 1 ? -lo : lo, to_pct: s === 1 ? -hi : hi, price_from: r2(mark * (1 + (s === 1 ? -lo : lo) / 100)), price_to: r2(mark * (1 + (s === 1 ? -hi : hi) / 100)), notional_usd: usd(n) });
  }
  const nearest = (s: 1 | -1) => {
    if (!mark) return null;
    const c = rows.filter(x => Math.sign(x.szi) === s && x.liq_px && (s === 1 ? x.liq_px < mark : x.liq_px > mark)).sort((a, b) => s === 1 ? b.liq_px - a.liq_px : a.liq_px - b.liq_px);
    if (!c.length) return null; const p = c[0].liq_px;
    const cl = c.filter(x => Math.abs(x.liq_px - p) / p <= 0.005);
    return { price: r2(p), distance_pct: r2((p - mark) / mark * 100), cluster_notional_usd: usd(cl.reduce((a, x) => a + x.value_usd, 0)), cluster_positions: cl.length };
  };
  const ev = getDb().prepare("SELECT ts, addr, side, size, px, value_usd FROM hl_liq_events WHERE coin = ? AND ts > ? ORDER BY value_usd DESC").all(coin, Date.now() - 86_400_000) as any[];
  const longs = side(1), shorts = side(-1);
  return { coin, dex: "main", as_of: asOf(), mark, open_interest_usd: ctx ? usd(ctx.oi_usd) : null,
    coverage_pct_of_oi: ctx?.oi_usd ? r2((longs.notional_usd + shorts.notional_usd) / 2 / ctx.oi_usd * 100) : null,
    longs, shorts, nearest_long_liquidation: nearest(1), nearest_short_liquidation: nearest(-1), liquidation_bands: bands,
    liquidations_24h: { count: ev.length, notional_usd: usd(ev.reduce((a, x) => a + x.value_usd, 0)), largest: ev.slice(0, 5).map(e => ({ ts: new Date(e.ts).toISOString(), account: short(e.addr), side: e.side, size: e.size, px: e.px, value_usd: usd(e.value_usd) })) },
    method: "Positions of the most active Hyperliquid accounts by 30-day volume (public leaderboard), refreshed every 15 min; liquidations are fills Hyperliquid marks as liquidation.", disclaimer: LIQ_DISCLAIMER };
}

/** Micro: coins with the most tracked notional within `pct`% of liquidation, plus confirmed liquidations 24h. */
export async function liqNear(pctRaw?: unknown, nRaw?: unknown, mk?: Map<string, { mark: number; oi_usd: number }>) {
  ensureLiqTables();
  const pct = Math.min(Math.max(Number(pctRaw) || 5, 0.5), 20); const n = Math.min(Math.max(Number(nRaw) || 10, 1), 25);
  const m = mk ?? await marks();
  const rows = getDb().prepare("SELECT coin, szi, value_usd, liq_px FROM hl_liq_pos WHERE liq_px IS NOT NULL").all() as any[];
  const by = new Map<string, { long: number; short: number }>();
  for (const r of rows) { const mark = m.get(r.coin)?.mark; if (!mark) continue;
    const d = r.szi > 0 ? (mark - r.liq_px) / mark * 100 : (r.liq_px - mark) / mark * 100; if (d < 0 || d > pct) continue;
    const t = by.get(r.coin) ?? { long: 0, short: 0 }; if (r.szi > 0) t.long += r.value_usd; else t.short += r.value_usd; by.set(r.coin, t); }
  const ev = getDb().prepare("SELECT coin, COUNT(*) AS n, SUM(value_usd) AS v FROM hl_liq_events WHERE ts > ? GROUP BY coin ORDER BY v DESC").all(Date.now() - 86_400_000) as any[];
  return { as_of: asOf(), within_pct: pct,
    items: [...by.entries()].map(([coin, t]) => ({ coin, mark: m.get(coin)?.mark ?? null, longs_near_liq_usd: usd(t.long), shorts_near_liq_usd: usd(t.short) }))
      .sort((a, b) => (b.longs_near_liq_usd + b.shorts_near_liq_usd) - (a.longs_near_liq_usd + a.shorts_near_liq_usd)).slice(0, n),
    liquidations_24h: { count: ev.reduce((a, x) => a + x.n, 0), notional_usd: usd(ev.reduce((a, x) => a + (x.v ?? 0), 0)), top_coins: ev.slice(0, 5).map(x => ({ coin: x.coin, count: x.n, notional_usd: usd(x.v ?? 0) })) },
    disclaimer: LIQ_DISCLAIMER };
}
