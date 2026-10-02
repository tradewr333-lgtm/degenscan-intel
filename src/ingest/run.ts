import { CONNECTORS } from "./registry.js";
import type { Connector } from "./base.js";
import { scoreEvent } from "../engine/impact.js";
import { upsertEvent, recordRun } from "../store/db.js";
import type { Event } from "../schema.js";

export interface RunResult { source_id: string; ok: boolean; items: number; new_items: number; ms: number; error?: string; new_events: Event[] }

/** Run one connector: fetch → score → store. Never throws. */
export async function runConnector(c: Connector, opts: { dryRun?: boolean } = {}): Promise<RunResult> {
  const t0 = Date.now();
  try {
    const raws = await c.run();
    const now = new Date();
    const new_events: Event[] = [];
    let n = 0;
    for (const raw of raws) {
      // yield to the event loop every 10 items so /health and API calls keep answering while a big feed is scored (incident 02/10)
      if (++n % 10 === 0) await new Promise(r => setImmediate(r));
      let ev: Event;
      try { ev = scoreEvent(raw, now); } catch (e) { console.warn(`[${c.id}] score failed for ${raw.native_id}:`, (e as Error).message); continue; }
      if (opts.dryRun) { new_events.push(ev); continue; }
      if (upsertEvent(ev)) new_events.push(ev);
    }
    const r: RunResult = { source_id: c.id, ok: true, items: raws.length, new_items: new_events.length, ms: Date.now() - t0, new_events };
    if (!opts.dryRun) recordRun(r);
    return r;
  } catch (e) {
    const r: RunResult = { source_id: c.id, ok: false, items: 0, new_items: 0, ms: Date.now() - t0, error: (e as Error).message, new_events: [] };
    if (!opts.dryRun) recordRun(r);
    return r;
  }
}

export async function runAllOnce(filter?: (c: Connector) => boolean, opts: { dryRun?: boolean; concurrency?: number } = {}) {
  const list = CONNECTORS.filter(filter ?? (() => true));
  const results: RunResult[] = [];
  const conc = opts.concurrency ?? 6;
  let i = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (i < list.length) { const c = list[i++]; results.push(await runConnector(c, opts)); }
  }));
  return results;
}

/** Max connectors running at the same time (0.5 CPU on Render: 40 parallel parses starved the event loop on 02/10). */
const MAX_PARALLEL = Number(process.env.INGEST_MAX_PARALLEL ?? 4);
let running = 0;
const waiters: (() => void)[] = [];
async function acquire() { if (running < MAX_PARALLEL) { running++; return; } await new Promise<void>(r => waiters.push(r)); running++; }
function release() { running--; const w = waiters.shift(); if (w) w(); }
export const _ingestState = { get running() { return running; }, get waiting() { return waiters.length; }, inflight: new Set<string>(), backoff: new Map<string, number>() };

/** Long-running scheduler: each connector on its own cadence, spread over the first minutes, never overlapping itself,
 *  at most MAX_PARALLEL at once, with exponential backoff (up to 1h) for a source that keeps failing. */
export function startScheduler(onNew?: (ev: Event) => void) {
  const timers: NodeJS.Timeout[] = [];
  const active = CONNECTORS.filter(c => { if (c.key_env && !process.env[c.key_env]) { console.log(`[sched] skip ${c.id} (missing ${c.key_env})`); return false; } return true; });
  const spreadMs = Number(process.env.INGEST_STARTUP_SPREAD_MS ?? 180_000);
  active.forEach((c, idx) => {
    let fails = 0;
    const schedule = (ms: number) => { const t = setTimeout(tick, ms); timers.push(t); };
    const tick = async () => {
      const st = _ingestState;
      if (st.inflight.has(c.id)) { schedule(c.cadence_s * 1000); return; }
      st.inflight.add(c.id);
      await acquire();
      let r: RunResult;
      try {
        r = await Promise.race([runConnector(c), new Promise<RunResult>(res => setTimeout(() => res({ source_id: c.id, ok: false, items: 0, new_items: 0, ms: 90_000, error: "timeout", new_events: [] }), 90_000))]);
      } finally { release(); }
      // the timed-out run may still be finishing in the background: keep the in-flight flag until it really ends
      if (r.error === "timeout") setTimeout(() => st.inflight.delete(c.id), 60_000); else st.inflight.delete(c.id);
      if (r.new_items) console.log(`[${new Date().toISOString()}] ${c.id}: +${r.new_items}/${r.items} in ${r.ms}ms`);
      if (!r.ok) { fails++; if (fails <= 2 || fails % 10 === 0) console.warn(`[${c.id}] ${r.error}${fails > 1 ? ` (fail #${fails})` : ""}`); } else fails = 0;
      for (const ev of r.new_events) onNew?.(ev);
      const base = c.cadence_s * 1000;
      const next = fails ? Math.min(3_600_000, base * 2 ** Math.min(fails - 1, 6)) : base;
      if (fails) st.backoff.set(c.id, next); else st.backoff.delete(c.id);
      schedule(next + Math.random() * Math.min(15_000, base * 0.1));
    };
    // spread first runs evenly over spreadMs (plus jitter), instead of all 40 inside 30s
    schedule(Math.round((idx / Math.max(1, active.length)) * spreadMs + Math.random() * 3_000));
  });
  console.log(`[sched] ${active.length} connectors scheduled (max ${MAX_PARALLEL} parallel, startup spread ${Math.round(spreadMs / 1000)}s)`);
  return () => timers.forEach(clearTimeout);
}

/** Event-loop lag watchdog: logs when the loop is blocked, so the next incident names itself. */
export function startLagMonitor() {
  let last = Date.now();
  const t = setInterval(() => {
    const now = Date.now(); const lag = now - last - 1000; last = now;
    if (lag > 1500) console.warn(`[lag] event loop blocked ${lag}ms; ingest running=${running} waiting=${waiters.length} inflight=${[..._ingestState.inflight].join(",") || "-"}`);
  }, 1000);
  t.unref();
  return () => clearInterval(t);
}
