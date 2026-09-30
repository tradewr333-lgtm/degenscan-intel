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
import { boardLatest, getForecast, getJob, recentForecasts, resolveForecast, trackRecord, ensureOracleTables, putForecast } from "../oracle/ledger.js";
import { llmConfigured, newUsage } from "../oracle/llm.js";
import { ground } from "../oracle/grounding.js";
import { refreshBoard, autoResolve, boardQuestions, eventQuestions } from "../oracle/board.js";
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
    // anyone not paying (trial header, or FREE_MODE) gets the cheap config
    if (method === "quota" || method === "free") { trial = TRIAL_LIMITS; r = { ...r, runs: Math.min(r.runs, TRIAL_LIMITS.runs), population: Math.min(r.population, TRIAL_LIMITS.population), rounds: Math.min(r.rounds, TRIAL_LIMITS.rounds) }; }
    const payer = req.x402Context ? `x402:${(req.x402Context.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}` : req.intelAccess?.payer ?? null;
    // Architect no.6: require_verified (the human /app always sets it) -> verify the fact-base NOW; an unverifiable question is
    // refused with 422 and, because the response is >= 400, it is never billed (onResponse only records 2xx/3xx).
    let pre: any = null;
    if (r.require_verified) {
      pre = await ground(r.question, { resolvesAt: r.resolves_at ? new Date(r.resolves_at) : null, usage: newUsage() });
      if (pre.status === "unverified") {
        reply.code(422);
        return { error: "unverified_premise", message: "cannot verify the facts this question depends on — not charged", message_pt: "Não consigo verificar os fatos de que esta pergunta depende. Esta pergunta não foi cobrada.",
          premises: pre.premises.map((p: any) => ({ claim: p.claim, verified: p.verified, fact: p.fact })), warnings: pre.warnings, disclaimer: DISCLAIMER };
      }
    }
    const job = enqueueForecast(r, payer, { capped: trial != null, grounding: pre });
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
  // polymarket_edge (Architect 30/09 no.5 / PLANO-RECEITA Frente B): where the oracle disagrees most with the listed market, from the
  // daily board cache — no LLM, $0.002. Rows excluded from measurement (bad market match) are left out: their odds are not the market.
  app.get("/v1/oracle/edge", async (req: any) => {
    const minAbs = Math.max(0, Number(req.query.min_abs ?? 0) || 0), limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20) || 20));
    return { as_of: new Date().toISOString(), ...polymarketEdge(minAbs, limit), _billing: billing(req, "polymarket_edge"), disclaimer: DISCLAIMER };
  });
  // Human scorecard page (PLANO-RECEITA Frente A.4): the same board and track record as HTML. Free.
  app.get("/oracle", async (_req, reply) => reply.type("text/html; charset=utf-8").send(oraclePage()));
  // Market-style prediction cards for humans (Renato 30/09): pt at /previsoes, en at /predictions. Free, same data as the board.
  app.get("/previsoes", async (_req, reply) => { const { predictionsPage } = await import("./predictions-page.js"); return reply.type("text/html; charset=utf-8").send(predictionsPage("pt")); });
  app.get("/predictions", async (_req, reply) => { const { predictionsPage } = await import("./predictions-page.js"); return reply.type("text/html; charset=utf-8").send(predictionsPage("en")); });
  // Oracle Edge paper bot: public ledger (free) + operator trigger.
  app.get("/v1/bot", async () => { const { botReport } = await import("../bot/paper.js"); return botReport(); });
  app.get("/bot", async (_req, reply) => { const { botReport } = await import("../bot/paper.js"); return reply.type("text/html; charset=utf-8").send(botPage(botReport(), (_req as any).query?.lang === "en" ? "en" : "pt")); });
  app.post("/v1/admin/bot/open", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const { openPositions, markAndSettle } = await import("../bot/paper.js");
    const opened = await openPositions(polymarketEdge(0, 50).items); await markAndSettle();
    return { ok: true, opened };
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
  // Operator: curated event questions (Lote Eventos) added at runtime, no deploy. Resolution must be machine-checkable.
  eventQuestions(); // registers pinned Polymarket markets at boot
  app.post("/v1/admin/board/questions", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const { slug, question, resolves_at, resolution, source } = req.body ?? {};
    const okRes = resolution && typeof resolution === "object" && typeof resolution.type === "string";
    if (typeof slug !== "string" || !/^[a-z0-9-]{3,64}$/.test(slug) || typeof question !== "string" || question.length < 10 || question.length > 400 || !resolves_at || isNaN(Date.parse(resolves_at)) || !okRes) {
      reply.code(400); return { error: "body { slug:'a-z0-9-', question, resolves_at: ISO, resolution: { type:'polymarket', slug } | ..., source? }" };
    }
    getDb().prepare("INSERT OR REPLACE INTO oracle_board_extra (slug, question, resolves_at, resolution, source, added_at) VALUES (?,?,?,?,?,?)").run(slug, question, new Date(resolves_at).toISOString(), JSON.stringify(resolution), typeof source === "string" ? source : "Lote Eventos", new Date().toISOString());
    eventQuestions();
    return { ok: true, slug, next: "POST /v1/oracle/board/refresh { slugs: [slug] }" };
  });
  app.delete("/v1/admin/board/questions/:slug", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const r = getDb().prepare("DELETE FROM oracle_board_extra WHERE slug = ?").run(String(req.params.slug));
    return { ok: true, removed: Number((r as any).changes ?? 0), note: "existing forecasts stay in the ledger; the row retires at the next refresh" };
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

  // Channel keys for resale marketplaces (Apify Store, etc.): operator-minted, labelled "channel:<name>", shown once.
  app.post("/v1/admin/keys", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const { plan, label } = req.body ?? {};
    if (!["hobby", "starter", "pro", "enterprise"].includes(plan) || typeof label !== "string" || !/^channel:[a-z0-9._-]{2,40}$/i.test(label)) { reply.code(400); return { error: "body { plan: 'starter'|'pro'|'enterprise', label: 'channel:apify' }" }; }
    const { createKey } = await import("./keys.js");
    const { id, key } = createKey({ plan, label });
    return { ok: true, key_id: id, api_key: key, note: "Shown once. Use as X-API-KEY." };
  });

  // Push D — import legacy forecasts (Lote 1, Python v0.2) preserving id, commitment_hash, created_at, probability. Operator only.
  app.post("/v1/admin/oracle/import", async (req: any, reply) => {
    if (!operator(req, reply)) return { error: "operator key required" };
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows) { reply.code(400); return { error: "body { rows: [{ id, question, created_at, resolves_at?, probability, commitment_hash, payload, engine_version?, board_slug? }] }" }; }
    const { createHash } = await import("node:crypto");
    const out: any[] = [];
    for (const r of rows) {
      try {
        const payload = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload ?? {};
        const created = String(r.created_at); const p = Number(r.probability);
        const expect = createHash("sha256").update(`${r.id}|${r.question}|${p.toFixed(4)}|${created}`).digest("hex");
        const hashOk = expect === r.commitment_hash;
        const f: any = { ...payload, id: String(r.id), question: String(r.question), created_at: created, resolves_at: r.resolves_at ?? payload.resolves_at ?? null,
          routing: payload.routing ?? { domain: r.domain ?? "general", method: r.method ?? "hybrid", human_driven: true, binary: true, rationale: "" },
          probability: p, ci80: payload.ci80 ?? [p, p], disagreement: payload.disagreement ?? 0, runs: payload.runs ?? [], panel: payload.panel ?? [],
          summary: payload.summary ?? "", drivers: payload.drivers ?? [], failure_modes: payload.failure_modes ?? [], confidence: payload.confidence ?? "medium", cost: payload.cost ?? {},
          commitment_hash: String(r.commitment_hash), market_odds: payload.market_odds ?? null, market_ref: payload.market_ref ?? null, edge: payload.edge ?? null,
          base_rate: payload.base_rate ?? null, edge_vs_base: null, config: { runs: payload.runs?.length ?? 0, population: 0, rounds: 0, capped: false },
          context_used: payload.context_used ?? {}, engine_version: String(r.engine_version ?? "0.2-nodata"), disclaimer: DISCLAIMER, legacy_id: String(r.id), hash_verified: hashOk };
        if (getForecast(f.id)) { out.push({ id: f.id, status: "exists" }); continue; }
        putForecast(f, r.board_slug ?? null);
        out.push({ id: f.id, status: "imported", hash_verified: hashOk });
      } catch (e) { out.push({ id: r?.id, status: "error", error: (e as Error).message }); }
    }
    return { imported: out.filter(o => o.status === "imported").length, results: out };
  });

  app.get("/v1/oracle/track-record", async () => ({ ...trackRecord(), recent: recentForecasts(20), disclaimer: DISCLAIMER }));
  app.get("/v1/oracle/forecasts", async (req: any) => ({ items: recentForecasts(Number(req.query?.limit ?? 20), String(req.query?.board ?? "") === "1"), disclaimer: DISCLAIMER }));
}

export function polymarketEdge(minAbs = 0, limit = 20) {
  const rows = boardLatest().filter(r => r.market_odds != null && r.probability != null && !r.measurement_exclude && r.outcome == null);
  const items = rows.map(r => ({ slug: r.slug, question: r.question, probability: r.probability, ci80: [r.ci_lo, r.ci_hi], market_odds: r.market_odds, edge: Math.round((r.probability - r.market_odds) * 10000) / 10000,
      side: r.probability > r.market_odds ? "oracle_above_market (YES looks cheap)" : "oracle_below_market (NO looks cheap)", base_rate: r.base_rate, confidence: r.confidence, resolves_at: r.resolves_at,
      market_ref: r.market_ref ?? null, forecast_id: r.id, commitment_hash: r.commitment_hash, forecast_at: r.created_at, detail: `/v1/oracle/board/${r.slug}` }))
    .filter(x => Math.abs(x.edge) >= minAbs).sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge)).slice(0, limit);
  return { count: items.length, items, method: "Latest daily-board forecast per question minus the matched Polymarket YES price at forecast time; sorted by |edge|. Cached, refreshed daily 06:00 UTC.", track_record: "/v1/oracle/track-record" };
}

function esc(s: unknown) { return String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[c]); }
function oraclePage() {
  const rows = boardLatest(); const tr: any = trackRecord();
  const pct = (x: any) => x == null ? "—" : (Number(x) * 100).toFixed(1) + "%";
  const body = rows.map(r => `<tr${r.measurement_exclude ? ' class="ex" title="excluded from measurement: ' + esc(r.measurement_exclude) + '"' : ""}><td>${esc(r.question)}</td><td class="n"><b>${pct(r.probability)}</b></td><td class="n">${pct(r.base_rate)}</td><td class="n">${pct(r.market_odds)}</td><td>${esc(String(r.resolves_at).slice(0, 10))}</td><td class="h"><a href="/v1/oracle/forecast/${esc(r.id)}">${esc(String(r.commitment_hash).slice(0, 10))}…</a></td></tr>`).join("");
  const fr = tr.first_resolution;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Degenscan Oracle — public board</title>
<style>body{font-family:system-ui,sans-serif;max-width:1100px;margin:0 auto;padding:24px 16px;background:#0b0d10;color:#e8eaed}a{color:#7cc4ff}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:8px 6px;border-bottom:1px solid #22272e;text-align:left;vertical-align:top}td.n{text-align:right;white-space:nowrap}td.h{font-family:ui-monospace,monospace;font-size:12px}tr.ex{opacity:.45}.k{display:inline-block;margin:0 16px 8px 0;padding:10px 14px;border:1px solid #2a2f36;border-radius:10px;background:#12161b}.k b{font-size:20px;display:block}.m{color:#9aa0a6}.wrap{overflow-x:auto}</style>
<h1>Degenscan Oracle — public board</h1>
<p class="m">Calibrated probabilities for standing market questions, recomputed daily at 06:00 UTC. Every forecast is committed with a sha256 hash before it resolves, and scored with Brier against the Polymarket price at forecast time. Nothing is edited after the fact.</p>
<div><span class="k"><b>${tr.n_pending}</b>pending</span><span class="k"><b>${tr.resolved}</b>resolved</span><span class="k"><b>${tr.brier ?? "—"}</b>Brier (0.25 = coin flip)</span><span class="k"><b>${fr ? esc(String(fr.resolved_at ?? fr.resolves_at).slice(0, 10)) : "—"}</b>${fr?.upcoming ? "first resolution due" : "first resolution"}</span></div>
<div class="wrap"><table><thead><tr><th>Question</th><th>Oracle</th><th>Base rate</th><th>Market</th><th>Resolves</th><th>Commitment</th></tr></thead><tbody>${body}</tbody></table></div>
<p><a href="/previsoes"><b>→ Visual version (cards, Portuguese): /previsoes</b></a> · <a href="/predictions">English cards</a></p>
<p class="m">Faded rows are kept in the ledger but excluded from calibration metrics (reason on hover). Machine-readable: <a href="/v1/oracle/board">/v1/oracle/board</a> · <a href="/v1/oracle/edge">/v1/oracle/edge</a> · <a href="/v1/oracle/track-record">/v1/oracle/track-record</a> · <a href="/docs/oracle-methodology">methodology</a> · API plans from $9/month: <a href="/pricing">/pricing</a></p>
<p class="m">Operator: Marbella Collins LLC · contact@degenscan.io · Information and analytics only — not investment advice.</p></html>`;
}

function botPage(r: any, lang: "pt" | "en" = "pt") {
  const T = lang === "pt" ? {
    title: "Oracle Edge — robô de previsão (simulação)", lead: "Um robô que opera no Polymarket usando só a nossa API de previsões. Regras fixas e públicas; toda posição fica registrada — as que ganham e as que perdem — ligada ao hash da previsão que a originou. <b>Simulação: sem dinheiro real.</b>",
    pnl: "Resultado", staked: "apostado (simulado)", pos: "posições", open: "abertas", settled: "encerradas", won: "ganhas",
    how: "Como ele decide", s1: "Todo dia às 06:00 UTC o oráculo recalcula a probabilidade de cada pergunta do board.", s2: "Às 08:00 UTC o robô compara com o preço do Polymarket. Se a diferença for de 3 pontos ou mais, compra o lado que o oráculo acha barato (US$10 por mercado, uma única vez).", s3: "Segura até o mercado resolver. O valor é atualizado de hora em hora com o preço real.",
    table: "Todas as posições", h: ["Aberta em", "Mercado", "Posição", "Oráculo × mercado", "Preço agora", "Resultado", "Status", "Prova"],
    empty: "Nenhuma posição ainda. O robô abre posições todo dia às 08:00 UTC, quando o oráculo discorda do mercado em 3 pontos ou mais.",
    curve: "Evolução do resultado", nocurve: "A curva aparece depois das primeiras posições.", st: { open: "aberta", settled: "encerrada" },
    foot: "Dados em JSON: <a href=\"/v1/bot\">/v1/bot</a> · Placar do oráculo: <a href=\"/oracle\">/oracle</a> · API a partir de US$9/mês: <a href=\"/pricing\">/pricing</a> · <a href=\"/bot?lang=en\">English</a>",
    disc: "Simulação com regras fixas publicadas — sem dinheiro real, não é retorno real. Informação e análise, não é recomendação de investimento.",
  } : {
    title: "Oracle Edge — forecasting bot (paper)", lead: "A bot that trades Polymarket using only our forecasting API. Fixed public rules; every position is kept — winners and losers — linked to the hash of the forecast it was opened on. <b>Paper trading: no real money.</b>",
    pnl: "P&L", staked: "staked (paper)", pos: "positions", open: "open", settled: "settled", won: "won",
    how: "How it decides", s1: "Every day at 06:00 UTC the oracle recomputes the probability of each board question.", s2: "At 08:00 UTC the bot compares it with the Polymarket price. If they differ by 3 points or more, it buys the side the oracle thinks is cheap ($10 per market, once).", s3: "It holds to resolution. Value is marked hourly at the live price.",
    table: "All positions", h: ["Opened", "Market", "Position", "Oracle vs market", "Price now", "P&L", "Status", "Proof"],
    empty: "No positions yet. The bot opens daily at 08:00 UTC when the oracle disagrees with the market by 3 points or more.",
    curve: "P&L over time", nocurve: "The curve appears after the first positions.", st: { open: "open", settled: "settled" },
    foot: "JSON: <a href=\"/v1/bot\">/v1/bot</a> · Oracle board: <a href=\"/oracle\">/oracle</a> · API from $9/month: <a href=\"/pricing\">/pricing</a> · <a href=\"/bot?lang=pt\">Português</a>",
    disc: "Paper trading with fixed published rules — no real money, not real returns. Information and analytics only — not investment advice.",
  };
  const money = (x: number) => (x >= 0 ? "+" : "−") + "US$" + Math.abs(x).toFixed(2);
  const s = r.summary; const up = s.pnl_usd >= 0;
  const curve = r.equity_curve as { at: string; pnl_usd: number }[];
  let svg = `<p class="m">${T.nocurve}</p>`;
  if (curve.length >= 2) {
    const W = 800, H = 160, xs = curve.map((_, i) => (i / (curve.length - 1)) * W), vals = curve.map(c => c.pnl_usd);
    const lo = Math.min(0, ...vals), hi = Math.max(0, ...vals), span = hi - lo || 1, y = (v: number) => H - ((v - lo) / span) * H;
    const pts = vals.map((v, i) => `${xs[i].toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:160px;display:block"><line x1="0" x2="${W}" y1="${y(0)}" y2="${y(0)}" stroke="#3a414a" stroke-dasharray="4 4"/><polyline fill="none" stroke="${up ? "#5fd38d" : "#ff7b72"}" stroke-width="2.5" points="${pts}"/></svg><p class="m">${esc(curve[0].at.slice(0, 10))} → ${esc(curve[curve.length - 1].at.slice(0, 16).replace("T", " "))} UTC</p>`;
  }
  const rows = r.positions.map((p: any) => `<tr><td>${esc(String(p.opened_at).slice(0, 10))}</td><td><a href="${esc(p.polymarket)}" target="_blank" rel="noopener">${esc(p.question)}</a></td><td><span class="pill ${p.side === "YES" ? "y" : "n"}">${p.side === "YES" ? (lang === "pt" ? "SIM" : "YES") : (lang === "pt" ? "NÃO" : "NO")}</span> ${(p.entry_price * 100).toFixed(1)}¢</td><td class="num">${(p.oracle_p * 100).toFixed(1)}% × ${(p.market_odds_at_entry * 100).toFixed(1)}%</td><td class="num">${p.mark_price == null ? "—" : (p.mark_price * 100).toFixed(1) + "¢"}</td><td class="num ${p.pnl >= 0 ? "g" : "r"}"><b>${money(p.pnl)}</b></td><td>${esc((T.st as any)[p.status] ?? p.status)}</td><td class="h"><a href="${esc(p.forecast)}">${esc(String(p.forecast_commitment_hash).slice(0, 8))}…</a></td></tr>`).join("");
  return `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Oracle Edge</title>
<style>
:root{--bg:#0b0d10;--card:#12161b;--line:#22272e;--txt:#e8eaed;--mut:#9aa0a6;--g:#5fd38d;--r:#ff7b72;--a:#7cc4ff}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--txt)}
.wrap{max-width:1100px;margin:0 auto;padding:28px 16px}a{color:var(--a)}h1{font-size:28px;margin:0 0 8px}h2{font-size:18px;margin:28px 0 12px}
.lead{color:var(--mut);max-width:760px;line-height:1.5}.hero{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:22px 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}.big{font-size:30px;font-weight:700}.g{color:var(--g)}.r{color:var(--r)}.m{color:var(--mut);font-size:13px}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.step b{display:inline-block;width:26px;height:26px;border-radius:50%;background:#1f2a36;color:var(--a);text-align:center;line-height:26px;margin-right:8px}
.tw{overflow-x:auto;border:1px solid var(--line);border-radius:14px}table{width:100%;border-collapse:collapse;font-size:14px}th{background:#10141a;color:var(--mut);font-weight:600;text-align:left}th,td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
td.num{text-align:right;white-space:nowrap}td.h{font-family:ui-monospace,monospace;font-size:12px}.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700}.pill.y{background:#123524;color:var(--g)}.pill.n{background:#3a1717;color:var(--r)}
.empty{padding:22px;color:var(--mut);text-align:center}.badge{display:inline-block;background:#2a2410;color:#f2cc60;border:1px solid #4a3f14;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;margin-left:8px;vertical-align:middle}
</style><div class="wrap">
<h1>${T.title.split(" — ")[0]} <span class="badge">${lang === "pt" ? "SIMULAÇÃO" : "PAPER"}</span></h1><p class="lead">${T.lead}</p>
<div class="hero"><div class="card"><div class="m">${T.pnl}</div><div class="big ${up ? "g" : "r"}">${money(s.pnl_usd)}</div><div class="m">${s.pnl_pct}% · US$${s.staked_usd.toFixed(0)} ${T.staked}</div></div>
<div class="card"><div class="m">${T.pos}</div><div class="big">${s.positions}</div><div class="m">${s.open} ${T.open} · ${s.settled} ${T.settled}</div></div>
<div class="card"><div class="m">${T.won}</div><div class="big">${s.settled ? s.wins + "/" + s.settled : "—"}</div><div class="m">${T.settled}</div></div></div>
<div class="card"><h2 style="margin-top:0">${T.curve}</h2>${svg}</div>
<h2>${T.how}</h2><div class="steps"><div class="card step"><b>1</b>${T.s1}</div><div class="card step"><b>2</b>${T.s2}</div><div class="card step"><b>3</b>${T.s3}</div></div>
<h2>${T.table}</h2><div class="tw"><table><thead><tr>${T.h.map(x => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows || `<tr><td colspan="8" class="empty">${T.empty}</td></tr>`}</tbody></table></div>
<p class="m" style="margin-top:18px">${T.foot}</p><p class="m">${T.disc} Marbella Collins LLC.</p></div></html>`;
}
