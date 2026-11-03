/**
 * Product research from OFFICIAL sources (Renato 03/11, Amazon FBA post) — never Amazon/SmartScout/Alibaba data:
 *  - product_recalls : U.S. CPSC recalls (SaferProducts.gov REST API, public domain) by keyword — units, hazard,
 *    remedy, country of manufacture, importer, where it was sold. Avoid categories that get recalled.
 *  - import_trends   : U.S. Census International Trade API (public domain) — monthly U.S. imports of an HS code:
 *    value, quantity, average unit value, top origin countries, 12-month change. Needs env CENSUS_API_KEY (free).
 *  - product_brief   : topic demand (Wikipedia) + recalls + imports in one call.
 * Information and analytics only — not business, legal or investment advice.
 */
import { UA } from "../ingest/http.js";

const memo = new Map<string, { at: number; v: any }>();
export const _products = { reset() { memo.clear(); } };
async function cached<T>(k: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const c = memo.get(k); if (c && Date.now() - c.at < ttl) return c.v as T;
  try { const v = await f(); memo.set(k, { at: Date.now(), v }); return v; } catch (e) { if (c) return c.v as T; throw e; }
}
async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (res.status === 204) return [];
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: 502 });
  const t = await res.text(); if (!t.trim()) return [];
  try { return JSON.parse(t); } catch { throw Object.assign(new Error(`${new URL(url).host} returned non-JSON`), { status: 502 }); }
}
const DISC = "Information and analytics only — not business, legal or investment advice.";

// ── Recalls (CPSC) ────────────────────────────────────────────────────────────────────────────────────────────
/** Pure: "About 2 million (In addition, about 250,000 …)" → 2000000. Exported for tests. */
export function unitsOf(s: unknown): number | null {
  const t = String(s ?? "").toLowerCase().split("(")[0];
  const m = t.match(/([\d.,]+)\s*(million|thousand)?/); if (!m) return null;
  const n = Number(m[1].replace(/,/g, "")); if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] === "million" ? 1e6 : m[2] === "thousand" ? 1e3 : 1));
}
/** Pure: CPSC recall rows → normalised items + summary. Exported for tests. */
export function recallsFrom(rows: any[], since?: string) {
  const items = (rows ?? []).map((r: any) => {
    const units = (r.Products ?? []).map((p: any) => unitsOf(p.NumberOfUnits)).filter((x: any) => x != null) as number[];
    const retail = (r.Retailers ?? []).map((x: any) => String(x.Name ?? "")).join(" ");
    return { recall_number: r.RecallNumber ?? null, date: String(r.RecallDate ?? "").slice(0, 10) || null, title: r.Title ?? null,
      products: (r.Products ?? []).map((p: any) => p.Name).filter(Boolean), units_us: units.length ? units.reduce((a, b) => a + b, 0) : null,
      hazard: (r.Hazards ?? []).map((h: any) => h.Name).filter(Boolean).join(" ").slice(0, 400) || null,
      injuries: (r.Injuries ?? []).map((h: any) => h.Name).filter(Boolean).join(" ").slice(0, 300) || null,
      remedy: (r.RemedyOptions ?? []).map((o: any) => o.Option).filter(Boolean),
      made_in: (r.ManufacturerCountries ?? []).map((c: any) => c.Country).filter(Boolean),
      importers: (r.Importers ?? []).map((x: any) => String(x.Name ?? "").split(",")[0]).filter(Boolean),
      sold_on_amazon: /amazon/i.test(retail), url: r.URL ?? null };
  }).filter(i => !since || (i.date ?? "") >= since).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const by = (f: (i: any) => string[]) => { const m: Record<string, number> = {}; for (const i of items) for (const k of f(i)) m[k] = (m[k] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => ({ k, n })); };
  return { count: items.length, units_us_total: items.reduce((a, i) => a + (i.units_us ?? 0), 0), sold_on_amazon: items.filter(i => i.sold_on_amazon).length,
    by_country_of_manufacture: by(i => i.made_in), by_year: by(i => i.date ? [i.date.slice(0, 4)] : []), items };
}
export async function productRecalls(q: any = {}) {
  const kw = String(q.q ?? q.product ?? q.keyword ?? "").trim().slice(0, 80);
  if (kw.length < 3) throw Object.assign(new Error("q required: a product keyword, e.g. q=air fryer"), { status: 400 });
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(q.since ?? "")) ? String(q.since) : undefined;
  const rows = await cached(`rc:${kw.toLowerCase()}`, 6 * 3600_000, () => getJson(`https://www.saferproducts.gov/RestWebServices/Recall?format=json&ProductName=${encodeURIComponent(kw)}`));
  const r = recallsFrom(Array.isArray(rows) ? rows : [], since);
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 100);
  return { query: kw, since: since ?? null, ...r, items: r.items.slice(0, limit), sources: ["U.S. Consumer Product Safety Commission — SaferProducts.gov Recalls REST API (public domain)"],
    as_of: new Date().toISOString(), disclaimer: DISC };
}

// ── Imports (U.S. Census International Trade) ─────────────────────────────────────────────────────────────────
// Census country codes: individual countries are 4 digits 1000–7999; groupings are 0xxx (EU, OPEC, NAFTA…) or "1XXX"-style continent totals.
/** Pure: Census rows (header first) → monthly totals + top origins + 12-month change. Exported for tests. */
export function importsFrom(table: any[][]) {
  if (!Array.isArray(table) || table.length < 2) return null;
  const h = table[0] as string[], ix = (k: string) => h.indexOf(k);
  const rows = table.slice(1).map(r => ({ cty: String(r[ix("CTY_CODE")] ?? ""), name: String(r[ix("CTY_NAME")] ?? ""), time: String(r[ix("time")] ?? ""),
    value: Number(r[ix("GEN_VAL_MO")]) || 0, qty: Number(r[ix("GEN_QY1_MO")]) || 0, unit: String(r[ix("UNIT_QY1")] ?? ""), desc: String(r[ix("I_COMMODITY_SDESC")] ?? "") }));
  const isTotal = (r: any) => r.cty === "-" || /TOTAL FOR ALL COUNTRIES/i.test(r.name);
  const isCountry = (r: any) => !isTotal(r) && /^\d{4}$/.test(r.cty) && !r.cty.startsWith("0");
  const months = [...new Set(rows.map(r => r.time))].sort();
  const totalOf = (m: string) => { const t = rows.find(r => r.time === m && isTotal(r)); if (t) return { value: t.value, qty: t.qty }; const cs = rows.filter(r => r.time === m && isCountry(r)); return { value: cs.reduce((a, r) => a + r.value, 0), qty: cs.reduce((a, r) => a + r.qty, 0) }; };
  const monthly = months.map(m => { const t = totalOf(m); return { month: m, value_usd: t.value, quantity: t.qty || null, unit_value_usd: t.qty ? Math.round(t.value / t.qty * 100) / 100 : null }; });
  const last = months[months.length - 1], yearAgo = months.find(m => m === `${Number(last.slice(0, 4)) - 1}${last.slice(4)}`);
  const sum = (ms: string[]) => ms.reduce((a, m) => a + totalOf(m).value, 0);
  const last12 = months.slice(-12), prev12 = months.slice(-24, -12);
  const top = rows.filter(r => r.time === last && isCountry(r)).sort((a, b) => b.value - a.value);
  const tv = totalOf(last).value || top.reduce((a, r) => a + r.value, 0);
  const pct = (a: number, b: number) => b ? Math.round((a / b - 1) * 1000) / 10 : null;
  return { description: rows.find(r => r.desc)?.desc ?? null, unit: rows.find(r => r.unit)?.unit ?? null, last_month: last,
    last_month_value_usd: totalOf(last).value, yoy_month_pct: yearAgo ? pct(totalOf(last).value, totalOf(yearAgo).value) : null,
    last_12m_value_usd: sum(last12), last_12m_vs_prior_12m_pct: prev12.length === 12 ? pct(sum(last12), sum(prev12)) : null,
    top_origins_last_month: top.slice(0, 10).map(r => ({ country: r.name, value_usd: r.value, share_pct: tv ? Math.round(r.value / tv * 1000) / 10 : null, unit_value_usd: r.qty ? Math.round(r.value / r.qty * 100) / 100 : null })),
    monthly: monthly.slice(-24) };
}
export async function importTrends(q: any = {}) {
  const key = process.env.CENSUS_API_KEY; if (!key) throw Object.assign(new Error("U.S. import data is not configured on this deployment yet"), { status: 503 });
  const hs = String(q.hs ?? q.code ?? "").replace(/\D/g, ""); if (![2, 4, 6, 10].includes(hs.length)) throw Object.assign(new Error("hs required: an HS code with 2, 4, 6 or 10 digits, e.g. hs=9503 (toys) or hs=851660 (ovens, cookers)"), { status: 400 });
  const from = new Date(); from.setUTCMonth(from.getUTCMonth() - 27); const fm = from.toISOString().slice(0, 7);
  const table = await cached(`im:${hs}`, 12 * 3600_000, () => getJson(`https://api.census.gov/data/timeseries/intltrade/imports/hs?get=CTY_CODE,CTY_NAME,GEN_VAL_MO,GEN_QY1_MO,UNIT_QY1,I_COMMODITY_SDESC&I_COMMODITY=${hs}&time=from+${fm}&key=${encodeURIComponent(key)}`));
  const r = importsFrom(table);
  if (!r) throw Object.assign(new Error(`no U.S. import data for HS ${hs}`), { status: 404 });
  return { hs, ...r, method: "General imports, monthly customs value (USD) and first quantity unit; unit_value = value ÷ quantity.", sources: ["U.S. Census Bureau — International Trade API, imports by HS (public domain)"], as_of: new Date().toISOString(), disclaimer: DISC };
}

// ── One-call brief ───────────────────────────────────────────────────────────────────────────────────────────
export async function productBrief(q: any = {}) {
  const kw = String(q.q ?? q.product ?? "").trim();
  if (kw.length < 3) throw Object.assign(new Error("q required, e.g. q=air fryer (optional hs=851660)"), { status: 400 });
  const [demand, recalls, imports] = await Promise.all([
    (async () => (await import("./topics.js")).topicDemand({ topics: kw, lang: q.lang ?? "en" }))().catch(e => ({ error: String((e as Error).message) })),
    productRecalls({ q: kw, limit: 5 }).catch(e => ({ error: String((e as Error).message) })),
    q.hs ? importTrends({ hs: q.hs }).catch(e => ({ error: String((e as Error).message) })) : Promise.resolve(null),
  ]);
  const d: any = (demand as any)?.items?.[0];
  return { query: kw, interest: d ? { article: d.article, avg_7d: d.avg_7d, change_7d_pct: d.change_7d_pct, change_30d_pct: d.change_30d_pct, trend: d.trend } : demand,
    recalls: (recalls as any)?.error ? recalls : { count: (recalls as any).count, units_us_total: (recalls as any).units_us_total, sold_on_amazon: (recalls as any).sold_on_amazon, latest: (recalls as any).items },
    imports: imports ?? { note: "add hs=<HS code> for U.S. import value, origins and unit value" },
    sources: ["Wikimedia pageviews API", "U.S. CPSC SaferProducts.gov", "U.S. Census International Trade API"], as_of: new Date().toISOString(), disclaimer: DISC };
}
