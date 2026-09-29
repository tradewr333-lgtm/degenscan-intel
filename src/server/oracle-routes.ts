/** REST routes for the 2Realidade oracle inside Intel. Async job pattern (a forecast is 60–80 LLM calls, 1–3 min):
 *    POST /v1/oracle/forecast            paid ($0.25)   → 202 { forecast_id, status:"queued", eta_s, poll }
 *    GET  /v1/oracle/forecast/:id        free           → { status:"queued"|"running"|"failed" } | full Forecast (status:"done")
 *    GET  /v1/oracle/board               paid ($0.002)  → latest standing forecasts (daily board, cache — no LLM)
 *    GET  /v1/oracle/board/:slug         paid ($0.002)  → one board forecast, full payload
 *    POST /v1/oracle/forecast/:id/resolve operator only (X-OPERATOR-KEY) → outcome, Brier, market_brier
 *    GET  /v1/oracle/track-record        free           → Brier overall / by domain / vs market (the marketing)
 *    GET  /v1/oracle/forecasts           free           → recent commitments (id, hash, probability) */
import type { FastifyInstance } from "fastify";
import { ForecastRequest, DISCLAIMER } from "../oracle/schema.js";
import { enqueueForecast, recoverJobs, _queue } from "../oracle/queue.js";
import { boardLatest, getForecast, getJob, recentForecasts, resolveForecast, trackRecord, ensureOracleTables } from "../oracle/ledger.js";
import { llmConfigured } from "../oracle/llm.js";
import { refreshBoard, autoResolve, boardQuestions } from "../oracle/board.js";
import { getDb } from "../store/db.js";

/** Free-trial forecasts are real LLM spend on our side: cap them to a cheap configuration (~US$0.01). */
const TRIAL_LIMITS = { runs: 2, population: 8, rounds: 2 } as const;

export function installOracleRoutes(app: FastifyInstance, billing: (req: any, tool: string) => any) {
  ensureOracleTables();
  getDb().exec("CREATE TABLE IF NOT EXISTS oracle_board (slug TEXT PRIMARY KEY, question TEXT NOT NULL, resolves_at TEXT NOT NULL, resolution TEXT NOT NULL, source TEXT, updated_at TEXT NOT NULL)");
  recoverJobs();

  app.post("/v1/oracle/forecast", async (req: any, reply) => {
    if (!llmConfigured()) { reply.code(503); return { error: "oracle temporarily unavailable: LLM backend not configured", disclaimer: DISCLAIMER }; }
    const parsed = ForecastRequest.safeParse(req.body ?? {});
    if (!parsed.success) { reply.code(400); return { error: "invalid request", issues: parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) }; }
    let r = parsed.data; let trial: typeof TRIAL_LIMITS | null = null;
    const method = req.x402Context ? "x402" : req.intelAccess?.method ?? "free";
    if (method === "quota") { trial = TRIAL_LIMITS; r = { ...r, runs: Math.min(r.runs, TRIAL_LIMITS.runs), population: Math.min(r.population, TRIAL_LIMITS.population), rounds: Math.min(r.rounds, TRIAL_LIMITS.rounds) }; }
    const payer = req.x402Context ? `x402:${(req.x402Context.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}` : req.intelAccess?.payer ?? null;
    const job = enqueueForecast(r, payer);
    reply.code(202);
    return { ...job, question: r.question, config: { runs: r.runs, population: r.population, rounds: r.rounds }, trial_limits: trial, note: "Poll `poll` (free) until status is done. The forecast_id is yours forever; the result is committed with a sha256 hash before resolution.", _billing: billing(req, "oracle_forecast"), disclaimer: DISCLAIMER };
  });

  app.get("/v1/oracle/forecast/:id", async (req: any, reply) => {
    const id = String(req.params.id);
    const f = getForecast(id);
    if (f) return { status: "done", ...f };
    const j = getJob(id);
    if (!j) { reply.code(404); return { error: "unknown forecast_id" }; }
    if (j.status === "failed") { reply.code(200); return { status: "failed", forecast_id: id, error: j.error, created_at: j.created_at, note: "Contact contact@degenscan.io with this id for a re-run." }; }
    return { status: j.status, forecast_id: id, created_at: j.created_at, started_at: j.started_at, queue: { active: _queue.active, pending: _queue.pending }, poll: `/v1/oracle/forecast/${id}`, retry_after_s: 20 };
  });

  app.get("/v1/oracle/board", async (req: any) => {
    const items = boardLatest();
    const meta = new Map<string, any>((getDb().prepare("SELECT slug, resolution, source FROM oracle_board").all() as any[]).map(r => [r.slug, { resolution: JSON.parse(r.resolution), source: r.source }]));
    return { as_of: new Date().toISOString(), count: items.length, items: items.map(i => ({ ...i, outcome: i.outcome == null ? null : Boolean(i.outcome), ...(meta.get(i.slug) ?? {}), detail: `/v1/oracle/board/${i.slug}` })), refresh: "daily (ORACLE_BOARD_CRON)", track_record: "/v1/oracle/track-record", _billing: billing(req, "oracle_board"), disclaimer: DISCLAIMER };
  });
  app.get("/v1/oracle/board/:slug", async (req: any, reply) => {
    const slug = String(req.params.slug);
    const row = getDb().prepare("SELECT id FROM oracle_forecasts WHERE board_slug = ? ORDER BY created_at DESC LIMIT 1").get(slug) as any;
    if (!row) { reply.code(404); return { error: `unknown board slug ${slug}`, board: "/v1/oracle/board" }; }
    const f = getForecast(row.id)!;
    const history = getDb().prepare("SELECT id, created_at, probability, market_odds, commitment_hash FROM oracle_forecasts WHERE board_slug = ? ORDER BY created_at DESC LIMIT 30").all(slug);
    return { slug, ...f, history, _billing: billing(req, "oracle_board") };
  });

  // Operator: force a board refresh (all or some slugs) / run automatic resolution now. Both need X-OPERATOR-KEY.
  const operator = (req: any, reply: any) => { const key = process.env.ORACLE_OPERATOR_KEY; if (!key || String(req.headers["x-operator-key"] ?? "") !== key) { reply.code(401); return false; } return true; };
  app.post("/v1/oracle/board/refresh", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const b = req.body ?? {};
    void refreshBoard({ force: Boolean(b.force), onlySlugs: Array.isArray(b.slugs) ? b.slugs.map(String) : undefined, runs: b.runs, population: b.population, rounds: b.rounds });
    reply.code(202); return { status: "refreshing", questions: (await boardQuestions()).map(q => q.slug), note: "runs in background; poll GET /v1/oracle/board" };
  });
  app.post("/v1/oracle/board/resolve", async (req: any, reply) => { if (!operator(req, reply)) return { error: "operator key required" }; return autoResolve(); });
  app.get("/v1/oracle/board/questions", async () => ({ items: await boardQuestions(), disclaimer: DISCLAIMER }));

  app.post("/v1/oracle/forecast/:id/resolve", async (req: any, reply) => {
    const key = process.env.ORACLE_OPERATOR_KEY;
    if (!key || String(req.headers["x-operator-key"] ?? "") !== key) { reply.code(401); return { error: "operator key required" }; }
    const outcome = req.body?.outcome;
    if (typeof outcome !== "boolean") { reply.code(400); return { error: "body { outcome: true|false }" }; }
    const f = resolveForecast(String(req.params.id), outcome);
    if (!f) { reply.code(404); return { error: "unknown forecast_id" }; }
    return { id: f.id, outcome: f.outcome, brier: f.brier, market_brier: f.market_brier, resolved_at: f.resolved_at, probability: f.probability, market_odds: f.market_odds };
  });

  // Operator-managed well-known files (domain-proof tokens for directories such as x402-list), stored in the DB so no redeploy is needed.
  getDb().exec("CREATE TABLE IF NOT EXISTS well_known (name TEXT PRIMARY KEY, body TEXT NOT NULL, content_type TEXT NOT NULL, updated_at TEXT NOT NULL)");
  app.post("/v1/admin/well-known", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const { name, body, content_type } = req.body ?? {};
    if (typeof name !== "string" || !/^[a-z0-9._-]{1,64}$/i.test(name) || typeof body !== "string" || body.length > 4096) { reply.code(400); return { error: "body { name: 'x402list.txt', body: '<token>', content_type? }" }; }
    getDb().prepare("INSERT OR REPLACE INTO well_known (name, body, content_type, updated_at) VALUES (?,?,?,?)").run(name, body, typeof content_type === "string" ? content_type : "text/plain; charset=utf-8", new Date().toISOString());
    return { ok: true, url: `/.well-known/${name}` };
  });
  for (const name of ["x402list.txt", "x402-list.txt"]) app.get(`/.well-known/${name}`, async (_req, reply) => {
    const row = (getDb().prepare("SELECT body, content_type FROM well_known WHERE name IN (?, 'x402list.txt', 'x402-list.txt') ORDER BY CASE WHEN name = ? THEN 0 ELSE 1 END LIMIT 1").get(name, name) as any);
    if (!row) { reply.code(404); return "not set"; }
    return reply.type(row.content_type).send(row.body);
  });

  app.get("/v1/oracle/track-record", async () => ({ ...trackRecord(), recent: recentForecasts(20), disclaimer: DISCLAIMER }));
  app.get("/v1/oracle/forecasts", async (req: any) => ({ items: recentForecasts(Number(req.query?.limit ?? 20), String(req.query?.board ?? "") === "1"), disclaimer: DISCLAIMER }));
}
