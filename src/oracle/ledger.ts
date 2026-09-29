/** Append-only forecast ledger with Brier scoring, on Intel's SQLite (persistent /data disk). Port of realidade2/ledger.py.
 *  Every forecast is committed (hash + timestamp) BEFORE the event resolves; the public track record is computed
 *  from resolved rows only. `oracle_jobs` holds the async job state (queued → running → done | failed). */
import { getDb } from "../store/db.js";
import type { Forecast } from "./schema.js";

let ready = false;
export function ensureOracleTables() {
  if (ready) return; ready = true;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS oracle_forecasts (
      id TEXT PRIMARY KEY, question TEXT NOT NULL, created_at TEXT NOT NULL, resolves_at TEXT, domain TEXT, method TEXT,
      probability REAL NOT NULL, ci_lo REAL, ci_hi REAL, disagreement REAL, confidence TEXT, market_odds REAL, edge REAL, base_rate REAL,
      commitment_hash TEXT NOT NULL, payload TEXT NOT NULL, engine_version TEXT, board_slug TEXT,
      outcome INTEGER, resolved_at TEXT, brier REAL, market_brier REAL
    );
    CREATE INDEX IF NOT EXISTS idx_of_created ON oracle_forecasts(created_at);
    CREATE INDEX IF NOT EXISTS idx_of_board ON oracle_forecasts(board_slug, created_at);
    CREATE TABLE IF NOT EXISTS oracle_jobs (
      id TEXT PRIMARY KEY, status TEXT NOT NULL, request TEXT NOT NULL, payer TEXT, created_at TEXT NOT NULL,
      started_at TEXT, finished_at TEXT, error TEXT, board_slug TEXT
    );
  `);
  try { getDb().exec("ALTER TABLE oracle_forecasts ADD COLUMN edge_vs_base REAL"); } catch { /* exists */ }
  try { getDb().exec("ALTER TABLE oracle_forecasts ADD COLUMN legacy_id TEXT"); } catch { /* exists */ }
}

export function putForecast(f: Forecast, boardSlug: string | null = null) {
  ensureOracleTables();
  getDb().prepare(`INSERT OR REPLACE INTO oracle_forecasts (id, question, created_at, resolves_at, domain, method, probability, ci_lo, ci_hi, disagreement, confidence,
    market_odds, edge, base_rate, commitment_hash, payload, engine_version, board_slug, outcome, resolved_at, brier, market_brier, edge_vs_base)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    f.id, f.question, f.created_at, f.resolves_at, f.routing.domain, f.routing.method, f.probability, f.ci80[0], f.ci80[1], f.disagreement, f.confidence,
    f.market_odds, f.edge, f.base_rate, f.commitment_hash, JSON.stringify(f), f.engine_version, boardSlug,
    f.outcome == null ? null : f.outcome ? 1 : 0, f.resolved_at ?? null, f.brier ?? null, f.market_brier ?? null, f.edge_vs_base ?? null);
}

export function getForecast(id: string): Forecast | null {
  ensureOracleTables();
  const row = getDb().prepare("SELECT payload, outcome, resolved_at, brier, market_brier FROM oracle_forecasts WHERE id = ?").get(id) as any;
  if (!row) return null;
  const f = JSON.parse(row.payload) as Forecast;
  if (row.outcome != null) { f.outcome = Boolean(row.outcome); f.resolved_at = row.resolved_at; f.brier = row.brier; f.market_brier = row.market_brier; }
  return f;
}

export function resolveForecast(id: string, outcome: boolean): Forecast | null {
  const f = getForecast(id); if (!f) return null;
  const y = outcome ? 1 : 0;
  const brier = Math.round((f.probability - y) ** 2 * 10000) / 10000;
  const marketBrier = f.market_odds != null ? Math.round((f.market_odds - y) ** 2 * 10000) / 10000 : null;
  const at = new Date().toISOString();
  getDb().prepare("UPDATE oracle_forecasts SET outcome = ?, resolved_at = ?, brier = ?, market_brier = ? WHERE id = ?").run(y, at, brier, marketBrier, id);
  return { ...f, outcome, resolved_at: at, brier, market_brier: marketBrier };
}

export function trackRecord() {
  ensureOracleTables();
  const d = getDb();
  const rows = d.prepare("SELECT domain, method, probability, outcome, brier, engine_version FROM oracle_forecasts WHERE outcome IS NOT NULL").all() as any[];
  const mkt = d.prepare("SELECT brier, market_brier FROM oracle_forecasts WHERE outcome IS NOT NULL AND market_brier IS NOT NULL").all() as any[];
  const edges = (d.prepare("SELECT ABS(edge) AS e FROM oracle_forecasts WHERE edge IS NOT NULL").all() as any[]).map(r => r.e as number);
  const total = (d.prepare("SELECT COUNT(*) AS n FROM oracle_forecasts").get() as any).n as number;
  // retired board rows (question left the board) stay in the ledger but are not "pending" scorecard items
  const pending = (d.prepare("SELECT COUNT(*) AS n FROM oracle_forecasts WHERE outcome IS NULL AND (board_slug IS NULL OR board_slug NOT LIKE 'retired:%')").get() as any).n as number;
  const nextRes = (d.prepare("SELECT MIN(resolves_at) AS t FROM oracle_forecasts WHERE outcome IS NULL AND (board_slug IS NULL OR board_slug NOT LIKE 'retired:%') AND resolves_at > ?").get(new Date().toISOString()) as any)?.t ?? null;
  const retired = (d.prepare("SELECT COUNT(*) AS n FROM oracle_forecasts WHERE board_slug LIKE 'retired:%'").get() as any).n as number;
  const evb = d.prepare("SELECT engine_version AS v, AVG(ABS(edge_vs_base)) AS m, COUNT(edge_vs_base) AS n FROM oracle_forecasts WHERE edge_vs_base IS NOT NULL GROUP BY engine_version").all() as any[];
  const byDomain: Record<string, any> = {};
  const byVersion: Record<string, any> = {};
  for (const r of rows) {
    for (const [key, map] of [[r.domain ?? "general", byDomain], [r.engine_version ?? "unknown", byVersion]] as const) {
      const x = (map[key] ??= { n: 0, brier_sum: 0, hits: 0 });
      x.n++; x.brier_sum += r.brier; x.hits += (r.probability > 0.5) === Boolean(r.outcome) ? 1 : 0;
    }
  }
  for (const map of [byDomain, byVersion]) for (const x of Object.values(map) as any[]) { x.brier = r4(x.brier_sum / x.n); x.hit_rate = Math.round((x.hits / x.n) * 1000) / 1000; delete x.brier_sum; }
  const n = rows.length;
  return {
    forecasts_total: total, resolved: n, pending, n_pending: pending, retired, next_resolves_at: nextRes,
    edge_vs_base_by_version: Object.fromEntries(evb.map(r => [r.v ?? "unknown", { mean_abs: r4(r.m), n: r.n }])),
    brier: n ? r4(rows.reduce((s, r) => s + r.brier, 0) / n) : null,
    brier_reference: { coin_flip: 0.25, good_human_forecaster: 0.15, superforecaster: 0.10 },
    vs_market: {  // the number an agent actually pays for
      n: mkt.length,
      oracle_brier: mkt.length ? r4(mkt.reduce((s, m) => s + m.brier, 0) / mkt.length) : null,
      market_brier: mkt.length ? r4(mkt.reduce((s, m) => s + m.market_brier, 0) / mkt.length) : null,
      beat_market_rate: mkt.length ? Math.round((mkt.filter(m => m.brier < m.market_brier).length / mkt.length) * 1000) / 1000 : null,
      mean_abs_edge_all: edges.length ? r4(edges.reduce((a, b) => a + b, 0) / edges.length) : null,
    },
    by_domain: byDomain, by_engine_version: byVersion,
    method: "Every forecast is committed with a sha256 hash before resolution; Brier = (p − outcome)²; market_brier uses the Polymarket YES price at forecast time.",
  };
}
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export function recentForecasts(limit = 20, boardOnly = false) {
  ensureOracleTables();
  return getDb().prepare(`SELECT id, question, created_at, resolves_at, domain, method, probability, ci_lo, ci_hi, confidence, market_odds, edge, base_rate, commitment_hash, board_slug, engine_version, outcome, brier
    FROM oracle_forecasts ${boardOnly ? "WHERE board_slug IS NOT NULL" : ""} ORDER BY created_at DESC LIMIT ?`).all(Math.min(200, Math.max(1, limit))) as any[];
}

/** Latest forecast per board slug (the daily board). */
export function boardLatest(): any[] {
  ensureOracleTables();
  return getDb().prepare(`SELECT f.id, f.board_slug AS slug, f.question, f.created_at, f.resolves_at, f.probability, f.ci_lo, f.ci_hi, f.disagreement, f.confidence, f.market_odds, f.edge, f.base_rate, f.commitment_hash, f.outcome, f.brier
    FROM oracle_forecasts f JOIN (SELECT board_slug, MAX(created_at) AS mc FROM oracle_forecasts WHERE board_slug IS NOT NULL AND board_slug NOT LIKE 'retired:%' GROUP BY board_slug) m
    ON m.board_slug = f.board_slug AND m.mc = f.created_at ORDER BY f.resolves_at, f.board_slug`).all() as any[];
}

// ---------------------------------------------------------------- jobs
export type JobStatus = "queued" | "running" | "done" | "failed";
export interface JobRow { id: string; status: JobStatus; request: string; payer: string | null; created_at: string; started_at: string | null; finished_at: string | null; error: string | null; board_slug: string | null }
export function insertJob(id: string, request: unknown, payer: string | null, boardSlug: string | null = null) {
  ensureOracleTables();
  getDb().prepare("INSERT INTO oracle_jobs (id, status, request, payer, created_at, board_slug) VALUES (?,?,?,?,?,?)").run(id, "queued", JSON.stringify(request), payer, new Date().toISOString(), boardSlug);
}
export function setJob(id: string, status: JobStatus, error: string | null = null) {
  const now = new Date().toISOString();
  if (status === "running") getDb().prepare("UPDATE oracle_jobs SET status = ?, started_at = ?, error = NULL WHERE id = ?").run(status, now, id);
  else if (status === "queued") getDb().prepare("UPDATE oracle_jobs SET status = ?, error = ? WHERE id = ?").run(status, error, id);
  else getDb().prepare("UPDATE oracle_jobs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(status, now, error, id);
}
export function getJob(id: string): JobRow | null { ensureOracleTables(); return (getDb().prepare("SELECT * FROM oracle_jobs WHERE id = ?").get(id) as any) ?? null; }
export function unfinishedJobs(): JobRow[] { ensureOracleTables(); return getDb().prepare("SELECT * FROM oracle_jobs WHERE status IN ('queued','running') ORDER BY created_at").all() as any[]; }
export function queueDepth(): number { ensureOracleTables(); return (getDb().prepare("SELECT COUNT(*) AS n FROM oracle_jobs WHERE status IN ('queued','running')").get() as any).n; }
