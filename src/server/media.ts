/**
 * Media research for content agents (07/11, Renato — "VideRush" post: agents that make documentaries need real images
 * and facts). We never host or resell images: we search OPEN collections and return the link, the licence as published
 * by the source, whether commercial use / derivatives are allowed, and a ready credit line.
 *  - licensed_images : Openverse (CC / public-domain index), Wikimedia Commons, NASA Image Library, Met Museum Open Access.
 *  - topic_timeline  : dated facts about a topic from Wikidata (CC0) + Wikipedia lead summary (CC BY-SA, attributed) +
 *                      audience interest (Wikimedia pageviews, our topic_demand).
 * Licences are reported as each source publishes them; the user must confirm before publishing. Not legal advice.
 */
import { UA } from "../ingest/http.js";

const memo = new Map<string, { at: number; v: any }>();
export const _media = { reset() { memo.clear(); }, fetch: (u: string, init?: any) => fetch(u, { ...init, headers: { "user-agent": `${UA} (contact@degenscan.io)`, accept: "application/json", ...(init?.headers ?? {}) }, signal: AbortSignal.timeout(12_000) }) };
async function getJson(url: string, ttl = 6 * 3600_000): Promise<any> {
  const c = memo.get(url); if (c && Date.now() - c.at < ttl) return c.v;
  try {
    const res = await _media.fetch(url);
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: 502 });
    const v = await res.json(); memo.set(url, { at: Date.now(), v }); return v;
  } catch (e) { if (c) return c.v; throw e; }
}
export const MEDIA_DISCLAIMER = "Licences are reported as published by each source; confirm the licence and any third-party rights (people, trademarks, artworks) before publishing. Information only — not legal advice.";
const strip = (s: unknown) => String(s ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/** Pure: licence label → permissions. Exported for tests. */
export function licenceRights(label: string) {
  const l = String(label ?? "").toLowerCase().replace(/[\s_]+/g, "-");
  const pd = /^(cc0|pdm|public-domain|pd|publicdomain)|public domain|no known copyright|us-gov|nasa/.test(l) || l === "cc0-1.0";
  const nc = /(^|-)nc(-|$)|noncommercial/.test(l), nd = /(^|-)nd(-|$)|noderiv/.test(l);
  const cc = /^cc-?by|^by(-|$)|creative-commons|^cc-by/.test(l) || /^by-sa|^by-nd|^by-nc/.test(l);
  if (pd) return { kind: "public_domain", commercial_ok: true, derivatives_ok: true, attribution_required: false };
  if (cc) return { kind: "creative_commons", commercial_ok: !nc, derivatives_ok: !nd, attribution_required: true };
  return { kind: "unknown", commercial_ok: null as boolean | null, derivatives_ok: null as boolean | null, attribution_required: true };
}
const credit = (title: string | null, creator: string | null, license: string, source: string, page: string | null) =>
  [title ? `"${title}"` : null, creator ? `by ${creator}` : null, license ? `(${license})` : null, `via ${source}`, page].filter(Boolean).join(" ");

export interface Img { title: string | null; image_url: string; thumbnail_url: string | null; page_url: string | null; creator: string | null; license: string; license_url: string | null;
  commercial_ok: boolean | null; derivatives_ok: boolean | null; attribution_required: boolean; credit: string; width: number | null; height: number | null; source: string; date: string | null }

/** Pure mappers (exported for tests). */
export function fromOpenverse(j: any): Img[] {
  return (j?.results ?? []).filter((r: any) => r?.url).map((r: any) => {
    const lic = `${String(r.license ?? "").toUpperCase() === "CC0" || r.license === "pdm" ? String(r.license).toUpperCase() : `CC ${String(r.license ?? "").toUpperCase()}`}${r.license_version ? " " + r.license_version : ""}`.trim();
    const rights = licenceRights(r.license === "pdm" ? "pdm" : r.license === "cc0" ? "cc0" : `cc-${r.license}`);
    return { title: r.title ?? null, image_url: r.url, thumbnail_url: r.thumbnail ?? null, page_url: r.foreign_landing_url ?? null, creator: r.creator ?? null, license: lic, license_url: r.license_url ?? null,
      ...rights, credit: r.attribution ?? credit(r.title, r.creator, lic, r.source ?? "Openverse", r.foreign_landing_url ?? null), width: r.width ?? null, height: r.height ?? null, source: `Openverse/${r.source ?? r.provider ?? "?"}`, date: null } as Img;
  });
}
export function fromCommons(j: any): Img[] {
  const pages = Object.values(j?.query?.pages ?? {}) as any[];
  return pages.map(p => {
    const ii = p.imageinfo?.[0]; if (!ii?.url) return null;
    const m = ii.extmetadata ?? {}; const lic = strip(m.LicenseShortName?.value) || "unknown";
    const creator = strip(m.Artist?.value) || null; const title = String(p.title ?? "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, "") || null;
    const rights = licenceRights(m.Copyrighted?.value === "False" ? "public-domain" : lic);
    return { title, image_url: ii.url, thumbnail_url: ii.thumburl ?? null, page_url: ii.descriptionurl ?? null, creator, license: lic, license_url: strip(m.LicenseUrl?.value) || null,
      ...rights, attribution_required: m.AttributionRequired?.value === "false" ? false : rights.attribution_required,
      credit: credit(title, creator, lic, "Wikimedia Commons", ii.descriptionurl ?? null), width: ii.width ?? null, height: ii.height ?? null, source: "Wikimedia Commons", date: strip(m.DateTimeOriginal?.value) || null } as Img;
  }).filter(Boolean) as Img[];
}
export function fromNasa(j: any): Img[] {
  return (j?.collection?.items ?? []).map((it: any) => {
    const d = it.data?.[0]; const href = it.links?.find((l: any) => l.render === "image")?.href ?? it.links?.[0]?.href; if (!d || !href) return null;
    const lic = "NASA media (generally not copyrighted in the U.S.; check for third-party content)";
    return { title: d.title ?? null, image_url: href.replace(/~thumb\./, "~orig."), thumbnail_url: href, page_url: d.nasa_id ? `https://images.nasa.gov/details/${encodeURIComponent(d.nasa_id)}` : null,
      creator: d.photographer ?? d.center ?? "NASA", license: lic, license_url: "https://www.nasa.gov/nasa-brand-center/images-and-media/", commercial_ok: true, derivatives_ok: true, attribution_required: false,
      credit: credit(d.title, d.photographer ?? d.center ?? "NASA", "courtesy NASA", "NASA Image and Video Library", d.nasa_id ? `https://images.nasa.gov/details/${d.nasa_id}` : null), width: null, height: null, source: "NASA", date: d.date_created ? String(d.date_created).slice(0, 10) : null } as Img;
  }).filter(Boolean) as Img[];
}
export function fromMet(o: any): Img | null {
  if (!o?.isPublicDomain || !o.primaryImage) return null;
  return { title: o.title ?? null, image_url: o.primaryImage, thumbnail_url: o.primaryImageSmall ?? null, page_url: o.objectURL ?? null, creator: o.artistDisplayName || null, license: "CC0 (Met Open Access)", license_url: "https://www.metmuseum.org/policies/image-resources",
    commercial_ok: true, derivatives_ok: true, attribution_required: false, credit: credit(o.title, o.artistDisplayName || null, "CC0", "The Metropolitan Museum of Art", o.objectURL ?? null), width: null, height: null, source: "The Met", date: o.objectDate || null };
}

const SOURCES = ["openverse", "commons", "nasa", "met"] as const;
export async function licensedImages(q: any = {}) {
  const query = String(q.q ?? q.query ?? q.topic ?? "").trim().slice(0, 120);
  if (query.length < 2) throw Object.assign(new Error("q required, e.g. q=apollo 11 launch"), { status: 400 });
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
  const commercialOnly = String(q.commercial_only ?? "true") !== "false";
  const want = new Set(String(q.sources ?? SOURCES.join(",")).toLowerCase().split(",").map(s => s.trim()).filter(s => (SOURCES as readonly string[]).includes(s)));
  const e = encodeURIComponent(query);
  const jobs: Record<string, () => Promise<Img[]>> = {
    openverse: async () => fromOpenverse(await getJson(`https://api.openverse.org/v1/images/?q=${e}&page_size=20${commercialOnly ? "&license_type=commercial" : ""}`)),
    commons: async () => fromCommons(await getJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20&gsrsearch=${e}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=640`)),
    nasa: async () => fromNasa(await getJson(`https://images-api.nasa.gov/search?q=${e}&media_type=image&page_size=20`)).slice(0, 20),
    met: async () => { const s = await getJson(`https://collectionapi.metmuseum.org/public/collection/v1/search?hasImages=true&q=${e}`); const ids: number[] = (s?.objectIDs ?? []).slice(0, 8);
      return (await Promise.all(ids.map(id => getJson(`https://collectionapi.metmuseum.org/public/collection/v1/objects/${id}`, 7 * 86_400_000).catch(() => null)))).map(fromMet).filter(Boolean) as Img[]; },
  };
  const status: Record<string, string> = {};
  const lists = await Promise.all([...want].map(async s => { try { const v = await jobs[s](); status[s] = `ok (${v.length})`; return v; } catch (err) { status[s] = `unavailable: ${(err as Error).message}`; return []; } }));
  // interleave sources so one collection does not crowd the others out
  const seen = new Set<string>(); const items: Img[] = [];
  for (let i = 0; items.length < limit && lists.some(l => l[i]); i++) for (const l of lists) { const it = l[i]; if (!it || seen.has(it.image_url)) continue; if (commercialOnly && it.commercial_ok === false) continue; seen.add(it.image_url); items.push(it); if (items.length >= limit) break; }
  if (!items.length && Object.values(status).every(s => s.startsWith("unavailable"))) throw Object.assign(new Error("image sources unavailable, try again shortly"), { status: 502 });
  return { query, commercial_only: commercialOnly, count: items.length, items, sources_status: status,
    fields: { commercial_ok: "true = the licence allows commercial use; null = licence not machine-readable, check the page", derivatives_ok: "false for ND licences: no cropping/editing", credit: "ready-made attribution line" },
    method: "Search of open collections; we link to the original and never host or resell images.", as_of: new Date().toISOString(), disclaimer: MEDIA_DISCLAIMER };
}

// ── Timeline ──────────────────────────────────────────────────────────────────────────────────────────────────
const DATE_PROPS: Record<string, string> = { P571: "inception / founded", P576: "dissolved", P580: "start", P582: "end", P585: "date", P569: "born", P570: "died", P577: "published", P619: "launched", P620: "landed", P1191: "first performance", P729: "service entry", P730: "service retirement", P1619: "officially opened" };
/** Pure: Wikidata time value → ISO date + precision label. Exported for tests. */
export function wdDate(v: any): { date: string; precision: "year" | "month" | "day" } | null {
  const t = String(v?.time ?? ""); const m = t.match(/^([+-]\d{1,})-(\d{2})-(\d{2})/); if (!m) return null;
  const p = Number(v?.precision); const y = String(Number(m[1])).padStart(4, "0");
  if (p >= 11) return { date: `${y}-${m[2]}-${m[3]}`, precision: "day" };
  if (p === 10) return { date: `${y}-${m[2]}`, precision: "month" };
  return { date: y, precision: "year" };
}
/** Pure: entity claims → dated facts about the entity itself. Exported for tests. */
export function ownDates(entity: any) {
  const out: { date: string; precision: string; event: string; property: string }[] = [];
  for (const [p, label] of Object.entries(DATE_PROPS)) for (const c of entity?.claims?.[p] ?? []) { const d = wdDate(c?.mainsnak?.datavalue?.value); if (d) out.push({ ...d, event: label, property: p }); }
  return out;
}
/** Pure: SPARQL bindings (related items with a date) → events. Exported for tests. */
export function relatedEvents(rows: any[]) {
  const seen = new Set<string>();
  return (rows ?? []).map(b => { const d = String(b.date?.value ?? ""); const m = d.match(/^(-?\d{1,})-(\d{2})-(\d{2})/); if (!m) return null;
    const item = String(b.item?.value ?? "").split("/").pop()!; const k = `${item}|${d.slice(0, 10)}`; if (seen.has(k)) return null; seen.add(k);
    return { date: `${String(Number(m[1])).padStart(4, "0")}-${m[2]}-${m[3]}`, precision: "day", event: b.itemLabel?.value ?? item, relation: b.rel?.value ?? "related", wikidata: `https://www.wikidata.org/wiki/${item}` }; })
    .filter(Boolean) as any[];
}

export async function topicTimeline(q: any = {}) {
  const topic = String(q.q ?? q.topic ?? "").trim().slice(0, 120);
  if (topic.length < 2) throw Object.assign(new Error("q required, e.g. q=Apollo 11 or q=Federal Reserve"), { status: 400 });
  const lang = /^[a-z]{2}$/.test(String(q.lang ?? "")) ? String(q.lang) : "en";
  const s = await getJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&type=item&limit=1&language=${lang}&uselang=${lang}&search=${encodeURIComponent(topic)}`, 86_400_000);
  const hit = s?.search?.[0]; if (!hit?.id) throw Object.assign(new Error(`no Wikidata item found for "${topic}"`), { status: 404 });
  const id = String(hit.id);
  const ej = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${id}.json`, 86_400_000); const ent = ej?.entities?.[id] ?? {};
  const title = ent.sitelinks?.[`${lang}wiki`]?.title ?? ent.sitelinks?.enwiki?.title ?? null;
  const sparql = `SELECT ?item ?itemLabel ?date ?rel WHERE { { ?item wdt:P361 wd:${id} . BIND("part of" AS ?rel) } UNION { ?item wdt:P921 wd:${id} . BIND("about" AS ?rel) } UNION { wd:${id} wdt:P793 ?item . BIND("significant event" AS ?rel) } UNION { ?item wdt:P1344 wd:${id} . BIND("participant" AS ?rel) } ?item (wdt:P585|wdt:P580|wdt:P571|wdt:P577|wdt:P619) ?date . SERVICE wikibase:label { bd:serviceParam wikibase:language "${lang},en". } } LIMIT 60`;
  const [rel, summary, demand] = await Promise.all([
    getJson(`https://query.wikidata.org/sparql?format=json&query=${encodeURIComponent(sparql)}`, 86_400_000).then(j => relatedEvents(j?.results?.bindings ?? [])).catch(() => []),
    title ? getJson(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`, 86_400_000).catch(() => null) : Promise.resolve(null),
    title ? (async () => (await import("./topics.js")).topicDemand({ topics: title, lang }))().then((d: any) => d?.items?.[0] ?? null).catch(() => null) : Promise.resolve(null),
  ]);
  const own = ownDates(ent).map(o => ({ ...o, event: `${hit.label ?? topic}: ${o.event}`, relation: "self", wikidata: `https://www.wikidata.org/wiki/${id}` }));
  const events = [...own, ...rel].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, Math.min(Math.max(Number(q.limit) || 60, 5), 100));
  return { topic, wikidata_id: id, label: hit.label ?? null, description: hit.description ?? null,
    summary: summary?.extract ? { text: String(summary.extract).slice(0, 1200), url: summary.content_urls?.desktop?.page ?? null, license: "CC BY-SA 4.0 — credit Wikipedia contributors and link the article" } : null,
    interest: demand ? { article: demand.article, avg_7d_views: demand.avg_7d, change_30d_pct: demand.change_30d_pct, trend: demand.trend } : null,
    count: events.length, events,
    method: "Dated statements of the Wikidata item (founded, start/end, launched, born/died…) plus related items (part of, about, significant events, participants) that carry a date.",
    sources: ["Wikidata (CC0)", "Wikipedia REST summary (CC BY-SA 4.0)", "Wikimedia pageviews API"], as_of: new Date().toISOString(),
    disclaimer: "Facts as recorded in Wikidata; verify key dates against primary sources before publishing. Information only." };
}
