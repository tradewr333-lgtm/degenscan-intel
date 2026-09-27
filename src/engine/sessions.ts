import type { Asset, Session } from "../schema.js";
import { loadUniverse } from "../universe/index.js";

/** US market holidays (NYSE) — extend yearly. YYYY-MM-DD in America/New_York. */
const US_HOLIDAYS = new Set([
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
]);

function partsIn(tz: string, at: Date) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(f.formatToParts(at).map(x => [x.type, x.value]));
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday);
  const hour = Number(p.hour) % 24;
  return { wd, minutes: hour * 60 + Number(p.minute), ymd: `${p.year}-${p.month}-${p.day}` };
}
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };

export function sessionOpen(s: Session, at: Date): boolean {
  if (s.always) return true;
  const { wd, minutes, ymd } = partsIn(s.tz, at);
  if (s.tz === "America/New_York" && US_HOLIDAYS.has(ymd)) return false;
  const o = toMin(s.open), c = toMin(s.close);
  if (o < c) return s.days.includes(wd) && minutes >= o && minutes < c;
  // overnight session (e.g. CME 17:00 → 16:00 next day)
  if (minutes >= o) return s.days.includes(wd);
  const prev = (wd + 6) % 7;
  return s.days.includes(prev) && minutes < c;
}

export function isTradable(a: Asset, at = new Date()): boolean {
  return a.sessions.some(s => sessionOpen(s, at));
}

/** Next open time for the asset's first session, searching forward up to 7 days in 5-min steps. */
export function nextOpen(a: Asset, at = new Date()): string | null {
  if (isTradable(a, at)) return null;
  const step = 5 * 60_000;
  for (let t = at.getTime() + step; t < at.getTime() + 7 * 86_400_000; t += step) {
    if (isTradable(a, new Date(t))) return new Date(t).toISOString();
  }
  return null;
}

export function tradability(assetIds: string[], at = new Date()) {
  const u = loadUniverse();
  const tradable_now: string[] = [];
  const next_open: { asset_id: string; at: string }[] = [];
  for (const id of assetIds) {
    const a = u.assets.find(x => x.id === id);
    if (!a) continue;
    if (isTradable(a, at)) tradable_now.push(id);
    else { const n = nextOpen(a, at); if (n) next_open.push({ asset_id: id, at: n }); }
  }
  return { tradable_now, next_open };
}

export function openVenues(at = new Date()) {
  const u = loadUniverse();
  const venues = new Map<string, boolean>();
  for (const a of u.assets) venues.set(a.venue, (venues.get(a.venue) ?? false) || isTradable(a, at));
  return Object.fromEntries(venues);
}
