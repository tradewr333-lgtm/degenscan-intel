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
    for (const raw of raws) {
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

/** Long-running scheduler: each connector on its own cadence, with jitter and a hard per-run timeout. */
export function startScheduler(onNew?: (ev: Event) => void) {
  const timers: NodeJS.Timeout[] = [];
  for (const c of CONNECTORS) {
    if (c.key_env && !process.env[c.key_env]) { console.log(`[sched] skip ${c.id} (missing ${c.key_env})`); continue; }
    const tick = async () => {
      const r = await Promise.race([runConnector(c), new Promise<RunResult>(res => setTimeout(() => res({ source_id: c.id, ok: false, items: 0, new_items: 0, ms: 90_000, error: "timeout", new_events: [] }), 90_000))]);
      if (r.new_items) console.log(`[${new Date().toISOString()}] ${c.id}: +${r.new_items}/${r.items} in ${r.ms}ms`);
      if (!r.ok) console.warn(`[${c.id}] ${r.error}`);
      for (const ev of r.new_events) onNew?.(ev);
    };
    const jitter = Math.random() * Math.min(30_000, c.cadence_s * 1000);
    timers.push(setTimeout(() => { tick(); timers.push(setInterval(tick, c.cadence_s * 1000)); }, jitter));
  }
  console.log(`[sched] ${CONNECTORS.length} connectors scheduled`);
  return () => timers.forEach(clearTimeout);
}
