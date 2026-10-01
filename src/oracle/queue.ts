/** In-memory job queue for forecasts (WEB_CONCURRENCY=1 → one process owns it). Concurrency = ORACLE_CONCURRENCY (DeepSeek
 *  rate limit). Job state lives in SQLite; on boot, jobs left `queued`/`running` by a restart are re-enqueued — the x402
 *  payment already settled, so the buyer must still get a result. */
import { randomUUID } from "node:crypto";
import { forecast } from "./engine.js";
import { _provider } from "./context.js";
import { getJob, insertJob, putForecast, setJob, unfinishedJobs, queueDepth } from "./ledger.js";
import { ForecastRequest } from "./schema.js";

const CONCURRENCY = Math.max(1, Number(process.env.ORACLE_CONCURRENCY ?? 2));
/** Seconds one forecast typically takes (runs × rounds × ⌈population/8⌉ LLM calls + panel + aggregate). */
export function etaSeconds(req: ForecastRequest, ahead: number) {
  const calls = req.runs * (Math.ceil(req.population / 8) * (1 + req.rounds)) + 3;
  return Math.round((calls * 6 + 60) * (1 + ahead / CONCURRENCY));
}

const pending: string[] = [];      // board / background jobs
const userPending: string[] = [];  // paying callers (/app, API): served first, plus one reserved slot (Construtor 01/10: a user question waited 10+ min behind the 06:00 board)
let active = 0;
const listeners = new Map<string, Set<() => void>>();

export function enqueueForecast(req: ForecastRequest, payer: string | null, opts: { boardSlug?: string | null; id?: string; capped?: boolean; grounding?: unknown } = {}): { forecast_id: string; status: "queued"; eta_s: number; poll: string } {
  const id = opts.id ?? randomUUID().replace(/-/g, "").slice(0, 12);
  insertJob(id, { ...req, _capped: Boolean(opts.capped), ...(opts.grounding ? { _grounding: opts.grounding } : {}) }, payer, opts.boardSlug ?? null);
  (opts.boardSlug ? pending : userPending).push(id); void pump();
  return { forecast_id: id, status: "queued", eta_s: etaSeconds(req, queueDepth() - 1), poll: `/v1/oracle/forecast/${id}` };
}

async function pump() {
  while ((userPending.length && active < CONCURRENCY + 1) || (pending.length && active < CONCURRENCY)) {
    const id = (userPending.length ? userPending.shift() : pending.shift())!; active++;
    run(id).finally(() => { active--; listeners.get(id)?.forEach(fn => fn()); listeners.delete(id); void pump(); });
  }
}

async function run(id: string) {
  const job = getJob(id); if (!job || job.status === "done") return;
  setJob(id, "running");
  try {
    const raw = JSON.parse(job.request);
    const req = ForecastRequest.parse(raw);
    // Architect no.6: fact-base ON outside the board (0.3.5-ts), SHADOW on the election rows (br-*), OFF on the frozen board.
    const bs = job.board_slug; const mode = !bs ? "on" : bs.startsWith("br-") ? "shadow" : "off";
    const f = await forecast(req, { provider: _provider.current, id, configCapped: Boolean(raw._capped), grounding: mode, pregrounded: raw._grounding ?? null });
    putForecast(f, job.board_slug);
    setJob(id, "done");
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    console.warn(`[oracle] job ${id} failed: ${msg}`);
    setJob(id, "failed", msg.slice(0, 500));
  }
}

/** Await a job (tests / board scheduler). Resolves when the job leaves the queue, whatever the outcome. */
export function waitFor(id: string, timeoutMs = 600_000): Promise<void> {
  return new Promise((resolve) => {
    const j = getJob(id); if (!j || j.status === "done" || j.status === "failed") return resolve();
    const set = listeners.get(id) ?? new Set(); listeners.set(id, set);
    const t = setTimeout(() => { set.delete(done); resolve(); }, timeoutMs);
    const done = () => { clearTimeout(t); resolve(); };
    set.add(done);
  });
}

/** Re-enqueue jobs interrupted by a restart. Call once at boot. */
export function recoverJobs() {
  const rows = unfinishedJobs();
  for (const j of rows) { if (j.status === "running") setJob(j.id, "queued", "requeued after restart"); (j.board_slug ? pending : userPending).push(j.id); }
  if (rows.length) console.log(`[oracle] requeued ${rows.length} unfinished forecast job(s)`);
  void pump();
}
export const _queue = { get active() { return active; }, get pending() { return pending.length + userPending.length; }, concurrency: CONCURRENCY };
