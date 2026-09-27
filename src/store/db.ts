import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
// Loaded via getBuiltinModule so bundlers/test runners that don't know node:sqlite yet leave it alone.
const { DatabaseSync } = (process as any).getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
type DatabaseSync = DatabaseSyncT;
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Event } from "../schema.js";

const DB_PATH = process.env.DB_PATH ?? "data/intel.db";
let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  if (DB_PATH !== ":memory:") mkdirSync(dirname(DB_PATH), { recursive: true });
  db = new DatabaseSync(DB_PATH);
  if (DB_PATH !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      ts_event TEXT NOT NULL,
      ts_observed TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_id TEXT NOT NULL,
      severity REAL NOT NULL,
      title TEXT NOT NULL,
      fingerprint TEXT,
      json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts_event);
    CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
    CREATE INDEX IF NOT EXISTS idx_events_fp ON events(fingerprint);
    CREATE TABLE IF NOT EXISTS impacts (
      event_id TEXT NOT NULL,
      asset_id TEXT NOT NULL,
      direction INTEGER NOT NULL,
      confidence REAL NOT NULL,
      ts_event TEXT NOT NULL,
      PRIMARY KEY (event_id, asset_id)
    );
    CREATE INDEX IF NOT EXISTS idx_impacts_asset_ts ON impacts(asset_id, ts_event);
    CREATE TABLE IF NOT EXISTS source_runs (
      source_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      ok INTEGER NOT NULL,
      items INTEGER NOT NULL,
      new_items INTEGER NOT NULL,
      ms INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_src_ts ON source_runs(source_id, ts);
    CREATE TABLE IF NOT EXISTS calls (
      ts TEXT NOT NULL, tool TEXT NOT NULL, payer TEXT, price_usd REAL NOT NULL, ok INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(id UNINDEXED, title, summary);
  `);
  try { db.exec("ALTER TABLE calls ADD COLUMN tx TEXT"); } catch { /* column exists */ }
  return db;
}

/** Cheap fingerprint for cross-source corroboration: normalized title tokens sorted. */
export function fingerprint(title: string): string {
  const stop = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "or", "by", "at", "with", "from", "as", "is", "are", "its", "inc", "corp"]);
  return title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2 && !stop.has(w)).sort().slice(0, 8).join("_");
}

/** Insert if new. Returns true when inserted. If a same-fingerprint event exists within 6h from another source, bump its corroboration instead. */
export function upsertEvent(ev: Event): boolean {
  const d = getDb();
  const exists = d.prepare("SELECT 1 FROM events WHERE id = ?").get(ev.id);
  if (exists) return false;
  const fp = fingerprint(ev.title);
  const twin = fp ? d.prepare(
    "SELECT id, json FROM events WHERE fingerprint = ? AND source_id != ? AND abs(julianday(ts_event) - julianday(?)) < 0.25 LIMIT 1",
  ).get(fp, ev.source.id, ev.ts_event) as unknown as { id: string; json: string } | undefined : undefined;
  if (twin) {
    const t = JSON.parse(twin.json) as Event;
    if (!t.corroboration.sources.includes(ev.source.id)) {
      t.corroboration.sources.push(ev.source.id);
      t.corroboration.count = t.corroboration.sources.length;
      d.prepare("UPDATE events SET json = ? WHERE id = ?").run(JSON.stringify(t), t.id);
    }
    return false;
  }
  d.exec("BEGIN");
  try {
    d.prepare("INSERT INTO events (id, ts_event, ts_observed, kind, source_id, severity, title, fingerprint, json) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(ev.id, ev.ts_event, ev.ts_observed, ev.kind, ev.source.id, ev.severity, ev.title, fp, JSON.stringify(ev));
    d.prepare("INSERT INTO events_fts (id, title, summary) VALUES (?,?,?)").run(ev.id, ev.title, ev.summary);
    const ins = d.prepare("INSERT OR REPLACE INTO impacts (event_id, asset_id, direction, confidence, ts_event) VALUES (?,?,?,?,?)");
    for (const i of ev.impacts) ins.run(ev.id, i.asset_id, i.direction, i.confidence, ev.ts_event);
    d.exec("COMMIT");
  } catch (e) { d.exec("ROLLBACK"); throw e; }
  return true;
}

export interface EventQuery {
  since: string; until?: string; kinds?: string[]; assets?: string[]; min_severity?: number; min_confidence?: number; q?: string; limit?: number;
}

export function queryEvents(q: EventQuery): Event[] {
  const d = getDb();
  const where: string[] = ["e.ts_event >= ?"]; const params: unknown[] = [q.since];
  if (q.until) { where.push("e.ts_event <= ?"); params.push(q.until); }
  if (q.kinds?.length) { where.push(`(${q.kinds.map(() => "e.kind LIKE ?").join(" OR ")})`); params.push(...q.kinds.map(k => k.endsWith(".") || !k.includes(".") ? `${k}%` : k)); }
  if (q.min_severity != null) { where.push("e.severity >= ?"); params.push(q.min_severity); }
  let join = ""; const joinParams: unknown[] = [];
  if (q.assets?.length) {
    join += ` JOIN impacts i ON i.event_id = e.id AND i.asset_id IN (${q.assets.map(() => "?").join(",")})`;
    joinParams.push(...q.assets);
    if (q.min_confidence != null) { where.push("i.confidence >= ?"); params.push(q.min_confidence); }
  }
  if (q.q) { join += " JOIN events_fts f ON f.id = e.id"; where.push("events_fts MATCH ?"); params.push(q.q); }
  const sql = `SELECT DISTINCT e.json FROM events e${join} WHERE ${where.join(" AND ")} ORDER BY e.ts_event DESC LIMIT ?`;
  params.push(Math.min(q.limit ?? 100, 500));
  return (d.prepare(sql).all(...(joinParams as any[]), ...(params as any[])) as unknown as { json: string }[]).map(r => JSON.parse(r.json));
}

export function impactsForAsset(assetId: string, since: string, limit = 100) {
  const d = getDb();
  const rows = d.prepare(
    `SELECT i.direction, i.confidence, e.json FROM impacts i JOIN events e ON e.id = i.event_id
     WHERE i.asset_id = ? AND i.ts_event >= ? ORDER BY i.confidence DESC, e.ts_event DESC LIMIT ?`,
  ).all(assetId, since, limit) as unknown as { direction: number; confidence: number; json: string }[];
  const events = rows.map(r => JSON.parse(r.json) as Event);
  const net = rows.reduce((s, r) => s + r.direction * r.confidence, 0);
  const abs = rows.reduce((s, r) => s + r.confidence, 0);
  return {
    asset_id: assetId, since, n_events: rows.length,
    net_score: Math.round(net * 1000) / 1000,             // −∑c … +∑c
    bias: abs ? Math.round((net / abs) * 1000) / 1000 : 0, // −1 … +1
    top: events.map(e => ({ event_id: e.id, ts_event: e.ts_event, kind: e.kind, title: e.title, impact: e.impacts.find(i => i.asset_id === assetId) })),
  };
}

export function recordRun(r: { source_id: string; ok: boolean; items: number; new_items: number; ms: number; error?: string }) {
  getDb().prepare("INSERT INTO source_runs (source_id, ts, ok, items, new_items, ms, error) VALUES (?,?,?,?,?,?,?)")
    .run(r.source_id, new Date().toISOString(), r.ok ? 1 : 0, r.items, r.new_items, r.ms, r.error ?? null);
}

export function sourcesStatus() {
  return getDb().prepare(`
    SELECT source_id, MAX(ts) AS last_run, SUM(ok) AS ok_runs, COUNT(*) AS runs, SUM(new_items) AS new_items_total,
           AVG(ms) AS avg_ms, (SELECT error FROM source_runs s2 WHERE s2.source_id = s.source_id ORDER BY ts DESC LIMIT 1) AS last_error
    FROM source_runs s GROUP BY source_id ORDER BY source_id`).all();
}

export function recordCall(tool: string, payer: string | null, price: number, ok: boolean, tx?: string | null) {
  getDb().prepare("INSERT INTO calls (ts, tool, payer, price_usd, ok, tx) VALUES (?,?,?,?,?,?)").run(new Date().toISOString(), tool, payer, price, ok ? 1 : 0, tx ?? null);
}

/** Public usage metrics, one row per week since `since` (ISO date). Wallets in `exclude` (owner/test wallets) are
 *  reported separately and never counted as customers. payer format: "x402:<wallet>" | "key:<id>" | "<ip>" (quota). */
export function weeklyMetrics(since: string, exclude: string[]) {
  const ex = new Set(exclude.map(a => a.toLowerCase()));
  const rows = getDb().prepare("SELECT ts, payer, price_usd, ok, tx FROM calls WHERE ts >= ? AND ok = 1 ORDER BY ts").all(since) as unknown as { ts: string; payer: string | null; price_usd: number; ok: number; tx: string | null }[];
  const start = new Date(since).getTime(); const W = 7 * 86_400_000;
  const weeks = new Map<number, { week_start: string; week_end: string; calls_free: number; calls_api_key: number; calls_x402: number; calls_x402_excluded: number; wallets: Set<string>; wallets_excluded: Set<string>; usdc_revenue: number; usdc_excluded: number; txs: string[]; txs_excluded: string[] }>();
  const bucket = (ts: string) => { const i = Math.max(0, Math.floor((new Date(ts).getTime() - start) / W)); if (!weeks.has(i)) { const ws = new Date(start + i * W); const we = new Date(start + (i + 1) * W - 1); weeks.set(i, { week_start: ws.toISOString().slice(0, 10), week_end: we.toISOString().slice(0, 10), calls_free: 0, calls_api_key: 0, calls_x402: 0, calls_x402_excluded: 0, wallets: new Set(), wallets_excluded: new Set(), usdc_revenue: 0, usdc_excluded: 0, txs: [], txs_excluded: [] }); } return weeks.get(i)!; };
  for (const r of rows) {
    const w = bucket(r.ts); const p = r.payer ?? "";
    if (p.startsWith("x402:")) {
      const wallet = p.slice(5).toLowerCase();
      if (ex.has(wallet)) { w.calls_x402_excluded++; w.wallets_excluded.add(wallet); w.usdc_excluded += r.price_usd; if (r.tx) w.txs_excluded.push(r.tx); }
      else { w.calls_x402++; w.wallets.add(wallet); w.usdc_revenue += r.price_usd; if (r.tx) w.txs.push(r.tx); }
    } else if (p.startsWith("key:")) w.calls_api_key++;
    else w.calls_free++;
  }
  // make sure every week from `since` to now exists, even with zero calls
  for (let i = 0; i <= Math.floor((Date.now() - start) / W); i++) bucket(new Date(start + i * W).toISOString());
  let active = 0;
  try { active = (getDb().prepare("SELECT COUNT(*) AS n FROM api_keys WHERE status = 'active' AND stripe_subscription IS NOT NULL AND stripe_subscription != ''").get() as unknown as { n: number }).n; } catch { /* no keys table yet */ }
  return [...weeks.entries()].sort((a, b) => a[0] - b[0]).map(([, w]) => ({
    week_start: w.week_start, week_end: w.week_end, calls_free: w.calls_free, calls_api_key: w.calls_api_key, calls_paid_x402: w.calls_x402,
    unique_paying_wallets: w.wallets.size, usdc_revenue: Math.round(w.usdc_revenue * 1e6) / 1e6, tx_hashes: w.txs,
    stripe_active_subscriptions: active,
    excluded_owner_wallets: { calls: w.calls_x402_excluded, wallets: [...w.wallets_excluded], usdc: Math.round(w.usdc_excluded * 1e6) / 1e6, tx_hashes: w.txs_excluded },
  }));
}

export function getEvent(id: string): Event | undefined {
  const r = getDb().prepare("SELECT json FROM events WHERE id = ?").get(id) as unknown as { json: string } | undefined;
  return r ? JSON.parse(r.json) : undefined;
}
