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
  try { getDb().exec("ALTER TABLE oracle_forecasts ADD COLUMN resolution_note TEXT"); } catch { /* exists */ }
  try { getDb().exec("ALTER TABLE oracle_forecasts ADD COLUMN measurement_exclude TEXT"); } catch { /* exists */ }
}

/** Rows kept in the append-only ledger (hash intact) but left out of every public calibration metric (Architect 30/09 no.5 §1–2):
 *  (a) the six 30/09 board rows anchored on a mismatched Polymarket market (bug fixed in v0.10.9);
 *  (b) anything paid by an operator/test wallet — "nothing we paid for enters a public metric, no exceptions". */
const OPERATOR_WALLETS = (process.env.EXCLUDED_WALLETS ?? "0x5344722b8D037827A9a5b7cD6312481D215d33BF,0x21f4A2DA07bccE60878cAb223358D11aD8F11a94").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const MATCH_BUG_SLUGS = ["btc-120k-oct31", "spx-oct-above-sep-2026", "btc-below-73500-202610", "btc-below-78500-202610", "btc-touch-94500-202610", "btc-above-94500-202610"];
export function applyMeasurementExclusions() {
  ensureOracleTables(); const d = getDb();
  d.prepare(`UPDATE oracle_forecasts SET measurement_exclude = 'market_match_bug_v0.10.8' WHERE measurement_exclude IS NULL AND engine_version = '0.3.3-ts'
    AND created_at >= '2026-09-30T00:00:00Z' AND created_at < '2026-10-01T00:00:00Z' AND board_slug IN (${MATCH_BUG_SLUGS.map(() => "?").join(",")})`).run(...MATCH_BUG_SLUGS);
  if (OPERATOR_WALLETS.length) d.prepare(`UPDATE oracle_forecasts SET measurement_exclude = 'operator_wallet' WHERE measurement_exclude IS NULL
    AND id IN (SELECT id FROM oracle_jobs WHERE lower(payer) IN (${OPERATOR_WALLETS.map(() => "?").join(",")}))`).run(...OPERATOR_WALLETS);
  d.prepare("UPDATE oracle_forecasts SET measurement_exclude = 'operator_wallet' WHERE measurement_exclude IS NULL AND id = 'fe7c74b7dddf'").run();
  // Same anti-wash rule for operator-minted keys (the owner's own test key, test keys): label channel:*-owner / channel:test*.
  try {
    d.prepare(`UPDATE oracle_forecasts SET measurement_exclude = 'operator_key' WHERE measurement_exclude IS NULL AND id IN (
      SELECT j.id FROM oracle_jobs j JOIN api_keys k ON j.payer = 'key:' || k.id WHERE k.label LIKE 'channel:%-owner' OR k.label LIKE 'channel:test%')`).run();
  } catch { /* api_keys not created yet */ }
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
  const row = getDb().prepare("SELECT payload, outcome, resolved_at, brier, market_brier, resolution_note FROM oracle_forecasts WHERE id = ?").get(id) as any;
  if (!row) return null;
  const f = JSON.parse(row.payload) as Forecast;
  if (row.outcome != null) { f.outcome = Boolean(row.outcome); f.resolved_at = row.resolved_at; f.brier = row.brier; f.market_brier = row.market_brier; if (row.resolution_note) f.resolution_note = row.resolution_note; }
  return f;
}

export function resolveForecast(id: string, outcome: boolean, note: string | null = null): Forecast | null {
  const f = getForecast(id); if (!f) return null;
  const y = outcome ? 1 : 0;
  const brier = Math.round((f.probability - y) ** 2 * 10000) / 10000;
  const marketBrier = f.market_odds != null ? Math.round((f.market_odds - y) ** 2 * 10000) / 10000 : null;
  const at = new Date().toISOString();
  getDb().prepare("UPDATE oracle_forecasts SET outcome = ?, resolved_at = ?, brier = ?, market_brier = ?, resolution_note = ? WHERE id = ?").run(y, at, brier, marketBrier, note, id);
  return { ...f, outcome, resolved_at: at, brier, market_brier: marketBrier, ...(note ? { resolution_note: note } : {}) };
}

export function trackRecord() {
  applyMeasurementExclusions();
  const d = getDb();
  const rows = d.prepare("SELECT domain, method, probability, outcome, brier, engine_version FROM oracle_forecasts WHERE outcome IS NOT NULL AND measurement_exclude IS NULL").all() as any[];
  const mkt = d.prepare("SELECT brier, market_brier FROM oracle_forecasts WHERE outcome IS NOT NULL AND market_brier IS NOT NULL AND measurement_exclude IS NULL").all() as any[];
  const edges = (d.prepare("SELECT ABS(edge) AS e FROM oracle_forecasts WHERE edge IS NOT NULL AND measurement_exclude IS NULL").all() as any[]).map(r => r.e as number);
  const total = (d.prepare("SELECT COUNT(*) AS n FROM oracle_forecasts").get() as any).n as number;
  // retired board rows (question left the board) stay in the ledger but are not "pending" scorecard items
  const pending = (d.prepare("SELECT COUNT(*) AS n FROM oracle_forecasts WHERE outcome IS NULL AND (board_slug IS NULL OR board_slug NOT LIKE 'retired:%')").get() as any).n as number;
  const nextRes = (d.prepare("SELECT MIN(resolves_at) AS t FROM oracle_forecasts WHERE outcome IS NULL AND (board_slug IS NULL OR board_slug NOT LIKE 'retired:%') AND resolves_at > ?").get(new Date().toISOString()) as any)?.t ?? null;
  const retired = (d.prepare("SELECT COUNT(*) AS n FROM oracle_forecasts WHERE board_slug LIKE 'retired:%'").get() as any).n as number;
  // Architect 30/09 §5b: point agents straight at the first scored forecast (or the next one due) so the scorecard is visibly alive.
  const firstRes = d.prepare("SELECT id, question, board_slug, resolved_at, outcome, brier, market_brier FROM oracle_forecasts WHERE outcome IS NOT NULL ORDER BY resolved_at LIMIT 1").get() as any;
  const nextDue = d.prepare("SELECT id, question, board_slug, resolves_at, probability, market_odds FROM oracle_forecasts WHERE outcome IS NULL AND (board_slug IS NULL OR board_slug NOT LIKE 'retired:%') AND resolves_at > ? ORDER BY resolves_at, created_at DESC LIMIT 1").get(new Date().toISOString()) as any;
  // signed tail-bias metric (Architect 30/09): healthy = frac_positive 0.40–0.60; ~1.0 means a systematic upward artefact
  const evb = d.prepare(`SELECT engine_version AS v, AVG(ABS(edge_vs_base)) AS m, AVG(edge_vs_base) AS sm,
    AVG(CASE WHEN edge_vs_base > 0 THEN 1.0 ELSE 0.0 END) AS fp, COUNT(edge_vs_base) AS n
    FROM oracle_forecasts WHERE edge_vs_base IS NOT NULL AND measurement_exclude IS NULL AND (board_slug IS NULL OR board_slug NOT LIKE 'retired:%') GROUP BY engine_version`).all() as any[];
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
    first_resolution_at: firstRes?.resolved_at ?? null,
    first_resolution: firstRes ? { id: firstRes.id, question: firstRes.question, slug: firstRes.board_slug, resolved_at: firstRes.resolved_at, outcome: Boolean(firstRes.outcome), brier: firstRes.brier, market_brier: firstRes.market_brier, link: `/v1/oracle/forecast/${firstRes.id}` }
      : nextDue ? { upcoming: true, id: nextDue.id, question: nextDue.question, slug: nextDue.board_slug, resolves_at: nextDue.resolves_at, probability: nextDue.probability, market_odds: nextDue.market_odds, link: `/v1/oracle/forecast/${nextDue.id}` } : null,
    edge_vs_base_by_version: Object.fromEntries(evb.map(r => [r.v ?? "unknown", { mean_abs: r4(r.m), mean_signed: r4(r.sm), frac_positive: Math.round(r.fp * 1000) / 1000, n: r.n }])),
    edge_vs_base_healthy_range: { frac_positive: [0.4, 0.6] },
    measurement_excluded: Object.fromEntries((d.prepare("SELECT measurement_exclude AS r, COUNT(*) AS n FROM oracle_forecasts WHERE measurement_exclude IS NOT NULL GROUP BY measurement_exclude").all() as any[]).map(x => [x.r, x.n])),
    measurement_exclusion_rule: "Rows stay in the append-only ledger (hash intact) but are excluded from calibration metrics: forecasts paid by operator/test wallets (/wallets.json) and board rows affected by a data-input bug (named by reason).",
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
  return getDb().prepare(`SELECT f.id, f.board_slug AS slug, f.question, f.created_at, f.resolves_at, f.probability, f.ci_lo, f.ci_hi, f.disagreement, f.confidence, f.market_odds, f.edge, f.base_rate, f.commitment_hash, f.outcome, f.brier, f.measurement_exclude, json_extract(f.payload, '$.market_ref') AS market_ref
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
