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
const SMART_MIN_MOVE = Number(process.env.SMART_MIN_MOVE_USD ?? 50_000);
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
    CREATE TABLE IF NOT EXISTS hl_smart (addr TEXT PRIMARY KEY, rank INTEGER NOT NULL, pnl_30d REAL, roi_30d REAL, vlm_30d REAL, pnl_all REAL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS hl_smart_moves (
      ts INTEGER NOT NULL, addr TEXT NOT NULL, coin TEXT NOT NULL, action TEXT NOT NULL, delta_usd REAL NOT NULL, size_after REAL, value_after REAL, px REAL,
      PRIMARY KEY (addr, coin, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_smv_ts ON hl_smart_moves(ts);
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

/** "Smart money" (Renato 17/10): accounts with the highest 30-day PnL on the public leaderboard, with ≥ US$5M 30-day
 *  volume and positive ROI (filters lucky dust accounts). Ranked by 30-day PnL. */
export function smartAccounts(text: string, n = SMART_N) {
  const out: { a: string; pnl: number; roi: number; vlm: number; all: number }[] = [];
  const re = /"ethAddress":\s*"(0x[0-9a-fA-F]{40})"/g; const idx: { a: string; i: number }[] = []; let m: RegExpExecArray | null;
  while ((m = re.exec(text))) idx.push({ a: m[1].toLowerCase(), i: m.index });
  const w = (name: string) => new RegExp(`"${name}",\\s*\\{\\s*"pnl":\\s*"([0-9.eE+\\-]+)",\\s*"roi":\\s*"([0-9.eE+\\-]+)",\\s*"vlm":\\s*"([0-9.eE+\\-]+)"`);
  const mo = w("month"), al = w("allTime");
  for (let k = 0; k < idx.length; k++) {
    const chunk = text.slice(idx[k].i, k + 1 < idx.length ? idx[k + 1].i : undefined);
    const x = mo.exec(chunk); if (!x) continue;
    const pnl = Number(x[1]), roi = Number(x[2]), vlm = Number(x[3]);
    if (pnl > 0 && roi > 0 && vlm >= SMART_MIN_VLM) out.push({ a: idx[k].a, pnl, roi, vlm, all: Number(al.exec(chunk)?.[1] ?? NaN) });
  }
  return out.sort((x, y) => y.pnl - x.pnl).slice(0, n);
}
const SMART_N = Number(process.env.SMART_ACCOUNTS ?? 100);
const SMART_MIN_VLM = Number(process.env.SMART_MIN_VLM ?? 5_000_000);

let accounts: string[] = []; let accountsAt = 0; let smartSet = new Set<string>();
let last: { at: string | null; accounts: number; positions: number; liquidations: number; ms: number; error?: string } = { at: null, accounts: 0, positions: 0, liquidations: 0, ms: 0 };
export const liqStatus = () => last;

async function refreshAccounts() {
  if (!smartSet.size) smartSet = new Set((getDb().prepare("SELECT addr FROM hl_smart").all() as any[]).map(r => r.addr));
  if (accounts.length && Date.now() - accountsAt < 6 * 3_600_000) return;
  const r = await fetch(LEADERBOARD, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`leaderboard ${r.status}`);
  const text = await r.text();
  const a = topAccounts(text); const sm = smartAccounts(text);
  if (sm.length) {
    const db = getDb(); const now = Date.now(); db.exec("BEGIN");
    try { db.exec("DELETE FROM hl_smart"); const ins = db.prepare("INSERT INTO hl_smart (addr, rank, pnl_30d, roi_30d, vlm_30d, pnl_all, updated) VALUES (?,?,?,?,?,?,?)");
      sm.forEach((x, i) => ins.run(x.a, i + 1, x.pnl, x.roi, x.vlm, Number.isFinite(x.all) ? x.all : null, now)); db.exec("COMMIT"); } catch (e) { db.exec("ROLLBACK"); throw e; }
    smartSet = new Set(sm.map(x => x.a));
  }
  if (a.length) { accounts = [...new Set([...a, ...smartSet])]; accountsAt = Date.now(); }
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
  // smart-money moves: diff of each smart account's positions vs the previous round (only accounts read in both rounds)
  const seenPrev = new Set<string>(JSON.parse((db.prepare("SELECT v FROM hl_liq_meta WHERE k = 'smart_seen'").get() as any)?.v ?? "[]"));
  const mk = await marks().catch(() => new Map<string, { mark: number; oi_usd: number }>());
  const moves: any[] = [];
  const freshBy = new Map<string, any>(); for (const r of fresh) freshBy.set(`${r[0]}|${r[1]}`, r);
  for (const addr of okAddr) {
    if (!smartSet.has(addr) || !seenPrev.has(addr)) continue;
    const coins = new Set<string>(); for (const k of [...prev.keys(), ...freshBy.keys()]) if (k.startsWith(addr + "|")) coins.add(k.slice(addr.length + 1));
    for (const coin of coins) {
      const before = prev.get(`${addr}|${coin}`)?.szi ?? 0; const f = freshBy.get(`${addr}|${coin}`); const after = f ? f[2] : 0;
      if (before === after) continue; const px = mk.get(coin)?.mark ?? f?.[3] ?? null; if (!px) continue;
      const dUsd = (after - before) * px; if (Math.abs(dUsd) < SMART_MIN_MOVE) continue;
      const action = before === 0 ? (after > 0 ? "open_long" : "open_short") : after === 0 ? (before > 0 ? "close_long" : "close_short")
        : Math.sign(before) !== Math.sign(after) ? (after > 0 ? "flip_to_long" : "flip_to_short") : Math.abs(after) > Math.abs(before) ? (after > 0 ? "add_long" : "add_short") : (after > 0 ? "reduce_long" : "reduce_short");
      moves.push([now, addr, coin, action, dUsd, after, Math.abs(after * px), px]);
    }
  }
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
    db.prepare("INSERT OR REPLACE INTO hl_liq_meta (k, v) VALUES ('smart_seen', ?)").run(JSON.stringify([...okAddr].filter(a => smartSet.has(a))));
    const insM = db.prepare("INSERT OR IGNORE INTO hl_smart_moves (ts, addr, coin, action, delta_usd, size_after, value_after, px) VALUES (?,?,?,?,?,?,?,?)");
    for (const m of moves) insM.run(...m);
    db.prepare("DELETE FROM hl_smart_moves WHERE ts < ?").run(now - 7 * 86_400_000);
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  last = { at: new Date(now).toISOString(), accounts: okAddr.size, positions: fresh.length, liquidations: liqs, smart_moves: moves.length, ms: Date.now() - t0 } as any;
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

/* ───────────── Smart money (top 30-day PnL accounts) ───────────── */
export const SMART_DISCLAIMER = "Public Hyperliquid leaderboard accounts with the highest 30-day PnL (≥ US$5M volume, positive ROI). Past PnL says nothing about future results. Market data only — not investment advice.";
function smartMeta() { ensureLiqTables(); return new Map((getDb().prepare("SELECT addr, rank, pnl_30d, roi_30d FROM hl_smart").all() as any[]).map(r => [r.addr, r])); }

/** One coin: how the smart accounts are positioned now and what they did in the last `hours`. */
export async function smartCoin(coinRaw: string, hoursRaw?: unknown) {
  ensureLiqTables();
  const coin = String(decodeURIComponent(coinRaw ?? "")).trim().toUpperCase(); const hours = Math.min(Math.max(Number(hoursRaw) || 24, 1), 168);
  const sm = smartMeta(); if (!sm.size) return { coin, as_of: asOf(), smart_accounts: 0, note: "smart-money set not built yet (first leaderboard pass runs a few minutes after start)", disclaimer: SMART_DISCLAIMER };
  const pos = (getDb().prepare("SELECT addr, szi, entry, value_usd, liq_px, lev FROM hl_liq_pos WHERE coin = ?").all(coin) as any[]).filter(p => sm.has(p.addr));
  const all = getDb().prepare("SELECT szi, value_usd FROM hl_liq_pos WHERE coin = ?").all(coin) as any[];
  const L = pos.filter(p => p.szi > 0), S = pos.filter(p => p.szi < 0);
  const sum = (a: any[]) => usd(a.reduce((x, p) => x + p.value_usd, 0));
  const avgE = (a: any[]) => { const z = a.reduce((x, p) => x + Math.abs(p.szi), 0); return z ? r2(a.reduce((x, p) => x + Math.abs(p.szi) * (p.entry ?? 0), 0) / z) : null; };
  const allL = all.filter(p => p.szi > 0).reduce((x, p) => x + p.value_usd, 0), allS = all.filter(p => p.szi < 0).reduce((x, p) => x + p.value_usd, 0);
  const mv = getDb().prepare("SELECT ts, addr, action, delta_usd, value_after, px FROM hl_smart_moves WHERE coin = ? AND ts > ? ORDER BY ABS(delta_usd) DESC").all(coin, Date.now() - hours * 3_600_000) as any[];
  const tag = (a: string) => { const m: any = sm.get(a); return { account: short(a), rank_30d_pnl: m?.rank ?? null, pnl_30d_usd: m ? usd(m.pnl_30d) : null }; };
  const mark = (await marks().catch(() => new Map())).get(coin)?.mark ?? null;
  return { coin, dex: "main", as_of: asOf(), mark, smart_accounts: sm.size, smart_in_coin: pos.length,
    smart: { long_positions: L.length, short_positions: S.length, long_usd: sum(L), short_usd: sum(S), net_usd: sum(L) - sum(S), long_avg_entry: avgE(L), short_avg_entry: avgE(S) },
    smart_long_share_pct: sum(L) + sum(S) ? r2(sum(L) / (sum(L) + sum(S)) * 100) : null,
    all_tracked_long_share_pct: allL + allS ? r2(allL / (allL + allS) * 100) : null,
    flow: { hours, net_usd: usd(mv.reduce((x, m) => x + m.delta_usd, 0)), moves: mv.length,
      largest: mv.slice(0, 10).map(m => ({ ts: new Date(m.ts).toISOString(), ...tag(m.addr), action: m.action, delta_usd: usd(m.delta_usd), position_after_usd: usd(m.value_after), px: m.px })) },
    method: "Positions read every 15 min; moves are changes between two consecutive reads (≥ US$50k). Opens and closes inside one 15-min window are not seen.",
    disclaimer: SMART_DISCLAIMER };
}

/** Across coins: where the smart accounts added or cut exposure in the last `hours`, and their biggest net positions now. */
export function smartFlow(hoursRaw?: unknown, nRaw?: unknown) {
  ensureLiqTables();
  const hours = Math.min(Math.max(Number(hoursRaw) || 4, 1), 168); const n = Math.min(Math.max(Number(nRaw) || 10, 1), 25);
  const sm = smartMeta();
  const fl = getDb().prepare("SELECT coin, SUM(delta_usd) AS net, SUM(CASE WHEN delta_usd > 0 THEN delta_usd ELSE 0 END) AS buy, SUM(CASE WHEN delta_usd < 0 THEN -delta_usd ELSE 0 END) AS sell, COUNT(*) AS n, COUNT(DISTINCT addr) AS accts FROM hl_smart_moves WHERE ts > ? GROUP BY coin ORDER BY ABS(SUM(delta_usd)) DESC LIMIT ?").all(Date.now() - hours * 3_600_000, n) as any[];
  const pos = (getDb().prepare("SELECT addr, coin, szi, value_usd FROM hl_liq_pos").all() as any[]).filter(p => sm.has(p.addr));
  const by = new Map<string, { l: number; s: number; nl: number; ns: number }>();
  for (const p of pos) { const t = by.get(p.coin) ?? { l: 0, s: 0, nl: 0, ns: 0 }; if (p.szi > 0) { t.l += p.value_usd; t.nl++; } else { t.s += p.value_usd; t.ns++; } by.set(p.coin, t); }
  return { as_of: asOf(), hours, smart_accounts: sm.size,
    flows: fl.map(f => ({ coin: f.coin, net_usd: usd(f.net), bought_usd: usd(f.buy), sold_usd: usd(f.sell), moves: f.n, accounts: f.accts })),
    positioning: [...by.entries()].map(([coin, t]) => ({ coin, net_usd: usd(t.l - t.s), long_usd: usd(t.l), short_usd: usd(t.s), longs: t.nl, shorts: t.ns }))
      .sort((a, b) => Math.abs(b.net_usd) - Math.abs(a.net_usd)).slice(0, n),
    disclaimer: SMART_DISCLAIMER };
}
