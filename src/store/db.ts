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

export function recordCall(tool: string, payer: string | null, price: number, ok: boolean) {
  getDb().prepare("INSERT INTO calls (ts, tool, payer, price_usd, ok) VALUES (?,?,?,?,?)").run(new Date().toISOString(), tool, payer, price, ok ? 1 : 0);
}

export function getEvent(id: string): Event | undefined {
  const r = getDb().prepare("SELECT json FROM events WHERE id = ?").get(id) as unknown as { json: string } | undefined;
  return r ? JSON.parse(r.json) : undefined;
}
