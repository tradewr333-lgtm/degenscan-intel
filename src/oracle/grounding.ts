/** Fact-base grounding (engine 0.3.5-ts, Architect reply no.6, 30/09/2026) — 1:1 port of realidade2/grounding.py.
 *  The oracle never reasons from the model's memory about the present state of the world.
 *
 *  Pipeline (runs BEFORE routing):
 *    0. extractPremises — one fast LLM call: which facts does the answer depend on?
 *    1. verifyPremise   — live lookups: Wikidata (office holders, birth/death), news (Brave if BRAVE_API_KEY, else GDELT),
 *                          Wikipedia summary as last resort. A source failure is an unverified premise, never a crash.
 *    2. inject          — VERIFIED FACTS block into every agent, panelist and the aggregator + GROUNDING_RULE in the system prompt.
 *    3. policy          — contradicted -> question re-grounded (premise_corrected); unverified -> confidence low + warning;
 *                          surfaces that must not publish unverified numbers (human /app) refuse with HTTP 422 and no charge.
 *  Origin: forecast 24be779bfd42 priced an 89-year-old Pope Francis (d. 2025-04-21) instead of Leo XIV (b. 1955-09-14). */
import { chatJson, type Usage } from "./llm.js";
import * as tools from "../server/tools.js";

export type PremiseKind = "office_holder" | "status" | "value" | "scheduled_event" | "other";
export type Fetcher = (url: string, params?: Record<string, string | number> | null) => Promise<any>;

export const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
export const WIKIDATA_SPARQL = "https://query.wikidata.org/sparql";
export const WIKIPEDIA_SUMMARY = (lang: string, title: string) => `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
export const BRAVE_NEWS = "https://api.search.brave.com/res/v1/news/search";
export const GDELT_DOC = "https://api.gdeltproject.org/api/v2/doc/doc";

export const GROUNDING_RULE = "If your memory conflicts with VERIFIED FACTS, VERIFIED FACTS win. Never assume a person's age, " +
  "office, status or a current value from memory: use only what VERIFIED FACTS state. If a fact the " +
  "answer depends on is listed as UNVERIFIED, say so in key_uncertainty and do not invent it.";

export interface Premise {
  claim: string; entity: string; kind: PremiseKind; query: string;
  verified: boolean | "contradicted"; fact: string; source_url: string; retrieved_at: string; data: Record<string, any>;
}
export type GroundingStatus = "verified" | "partial" | "unverified" | "contradicted" | "none_needed";
export interface Grounding {
  premises: Premise[]; status: GroundingStatus; corrected_question: string | null; warnings: string[];
  actuarial_base_rate: number | null; actuarial_note: string;
}

export function groundingToPrompt(g: Grounding, now: Date): string {
  const lines = [`VERIFIED FACTS (as of ${now.toISOString().slice(0, 10)}; these override your memory):`];
  for (const p of g.premises) {
    if (p.verified === true) lines.push(`- ${p.fact}  [source: ${p.source_url}]`);
    else if (p.verified === "contradicted") lines.push(`- CONTRADICTED premise '${p.claim}': ${p.fact}  [source: ${p.source_url}]`);
    else lines.push(`- UNVERIFIED: ${p.claim} (no live source could confirm this)`);
  }
  if (g.actuarial_base_rate != null) lines.push(`- actuarial base rate: ${g.actuarial_base_rate} (${g.actuarial_note})`);
  lines.push(GROUNDING_RULE);
  return lines.join("\n");
}

// ---------------------------------------------------------------- step 0: premises
export async function extractPremises(question: string, now: Date, usage: Usage): Promise<Premise[]> {
  const out = await chatJson("You are the fact-base auditor of a forecasting oracle. You list what must be TRUE TODAY for the question " +
    "to be well-posed, so that each item can be looked up live. You never answer the question.",
    `TASK: premises\nToday: ${now.toISOString().slice(0, 10)}\nQuestion: ${question}\n` +
    "List the factual premises the answer depends on: who currently holds an office mentioned or implied " +
    "('the pope', 'the president of X', 'the CEO of Y'), whether a named person is alive / in office / a " +
    "candidate, the current value of a named quantity (a policy rate, a price), and any scheduled event " +
    "(meeting, election, launch). Skip premises that are pure market data (spot prices of BTC/ETH/SOL/SPX) — " +
    "those are fetched elsewhere. Return {premises:[{claim, entity, kind: office_holder|status|value|" +
    "scheduled_event|other, query}]} with 0-5 items; empty list if the question needs no world facts.",
    { temperature: 0.0, seed: 7 }, usage);
  const kinds: PremiseKind[] = ["office_holder", "status", "value", "scheduled_event", "other"];
  return (Array.isArray(out?.premises) ? out.premises : []).slice(0, 5).map((p: any) => ({
    claim: String(p?.claim ?? ""), entity: String(p?.entity ?? ""), kind: kinds.includes(p?.kind) ? p.kind : "other",
    query: String(p?.query ?? p?.entity ?? ""), verified: false, fact: "", source_url: "", retrieved_at: "", data: {},
  }));
}

// ---------------------------------------------------------------- step 1: verification
const cache = new Map<string, { at: number; v: any }>();
const CACHE_MS = 6 * 3600_000; // Wikidata answers for 6 h: office holders change rarely, and when they do it is news

export const defaultFetcher: Fetcher = async (url, params) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, String(v));
  const key = u.toString(); const wd = url.includes("wikidata.org");
  if (wd) { const c = cache.get(key); if (c && Date.now() - c.at < CACHE_MS) return c.v; }
  const headers: Record<string, string> = { "user-agent": process.env.R2_UA ?? "2Realidade-oracle/0.3 (contact@degenscan.io)", accept: url === WIKIDATA_SPARQL ? "application/sparql-results+json" : "application/json" };
  if (url.includes("brave.com") && process.env.BRAVE_API_KEY) headers["x-subscription-token"] = process.env.BRAVE_API_KEY;
  const r = await fetch(key, { headers, signal: AbortSignal.timeout(url.includes("gdeltproject") ? 15000 : 8000) });  // GDELT is slow (01/10: 8 s timed out)
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const text = await r.text();
  let v: any = null; try { v = JSON.parse(text); } catch { v = null; }
  if (wd && v) cache.set(key, { at: Date.now(), v });
  return v;
};

const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const val = (r: any, k: string): string | undefined => r?.[k]?.value;

/** Label variants: Wikidata English labels are case-sensitive ("pope" vs "Pope", "Chair of the Federal Reserve"). */
export function labelVariants(x: string): string[] {
  const t = x.trim(); const low = t.toLowerCase(); const cap = low.charAt(0).toUpperCase() + low.slice(1);
  const title = low.replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\b(Of|The|And|In|For)\b/g, w => w.toLowerCase());
  return [...new Set([t, low, cap, title])];
}

/** Current holder of an office via SPARQL: P39 (position held) with no P582 (end time), living humans only, latest start first,
 *  then notability (sitelinks). Construtor 01/10: the reference query (exact lowercase label, no alive/human filter, one row)
 *  returned a Palmarian antipope for "pope" against live Wikidata; this version returns Leo XIV (tested live). */
export async function wikidataOfficeHolder(fetch: Fetcher, officeQuery: string): Promise<Record<string, any> | null> {
  const sparql = `SELECT ?person ?personLabel ?start ?birth ?sl WHERE {
  VALUES ?lbl { ${labelVariants(officeQuery).map(v => JSON.stringify(v) + "@en").join(" ")} }
  ?office rdfs:label ?lbl .
  ?person p:P39 ?stmt . ?stmt ps:P39 ?office .
  FILTER NOT EXISTS { ?stmt pq:P582 ?end . }
  FILTER NOT EXISTS { ?person wdt:P570 ?death . }
  ?person wdt:P31 wd:Q5 . ?person wikibase:sitelinks ?sl .
  OPTIONAL { ?stmt pq:P580 ?start . }
  OPTIONAL { ?person wdt:P569 ?birth . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,pt,es" . }
} ORDER BY DESC(?start) DESC(?sl) LIMIT 3`;
  const j = await fetch(WIKIDATA_SPARQL, { query: sparql, format: "json" });
  const rows = j?.results?.bindings ?? [];
  if (!rows.length) return null;
  const r = rows[0];
  const qid = (val(r, "person") ?? "").split("/").pop() ?? "";
  let name = val(r, "personLabel") ?? qid;
  if (/^Q\d+$/.test(name)) name = (await entityLabel(fetch, qid)) ?? name;
  return { name, qid, birth_date: (val(r, "birth") ?? "").slice(0, 10), death_date: null, start_time: (val(r, "start") ?? "").slice(0, 10),
    url: `https://www.wikidata.org/wiki/${qid}`, other_candidates: rows.slice(1).map((x: any) => val(x, "personLabel")).filter(Boolean) };
}

async function entityLabel(fetch: Fetcher, qid: string): Promise<string | null> {
  try { const j = await fetch(WIKIDATA_API, { action: "wbgetentities", ids: qid, props: "labels", languages: "en|pt", format: "json" }); const l = j?.entities?.[qid]?.labels; return l?.en?.value ?? l?.pt?.value ?? null; }
  catch { return null; }
}

/** Birth/death and current positions for a named person. Picks the most notable HUMAN among the top search hits
 *  (live Wikidata: "Lula" first hit is not the president; the human with most sitelinks is). */
export async function wikidataPerson(fetch: Fetcher, name: string): Promise<Record<string, any> | null> {
  const s = await fetch(WIKIDATA_API, { action: "wbsearchentities", search: name, language: "en", format: "json", limit: 7 });
  const hits: any[] = s?.search ?? [];
  if (!hits.length) return null;
  // Only HUMANS count as a person match (live case 01/10: "Atlântida" matched "Atlántida Department", a Uruguayan region).
  const pick = await fetch(WIKIDATA_SPARQL, { query: `SELECT ?p ?sl WHERE { VALUES ?p { ${hits.map(h => "wd:" + h.id).join(" ")} } ?p wdt:P31 wd:Q5 . ?p wikibase:sitelinks ?sl . } ORDER BY DESC(?sl) LIMIT 1`, format: "json" });
  const b = pick?.results?.bindings?.[0];
  if (!b) return null;
  const qid = (val(b, "p") ?? "").split("/").pop() ?? hits[0].id; const label = hits.find(h => h.id === qid)?.label ?? name;
  const sparql = `SELECT ?birth ?death ?posLabel ?start WHERE {
  OPTIONAL { wd:${qid} wdt:P569 ?birth . }
  OPTIONAL { wd:${qid} wdt:P570 ?death . }
  OPTIONAL { wd:${qid} p:P39 ?st . ?st ps:P39 ?pos . FILTER NOT EXISTS { ?st pq:P582 ?e . }
             OPTIONAL { ?st pq:P580 ?start . } }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" . }
} LIMIT 10`;
  const j = await fetch(WIKIDATA_SPARQL, { query: sparql, format: "json" });
  const rows: any[] = j?.results?.bindings ?? [];
  if (!rows.length) return { name: label, qid, url: `https://www.wikidata.org/wiki/${qid}` };
  const positions = [...new Set(rows.map(r => val(r, "posLabel")).filter(Boolean) as string[])].sort();
  return { name: label, qid, birth_date: (val(rows[0], "birth") ?? "").slice(0, 10), death_date: (val(rows[0], "death") ?? "").slice(0, 10) || null,
    current_positions: positions, url: `https://www.wikidata.org/wiki/${qid}` };
}

export async function wikipediaSummary(fetch: Fetcher, title: string, lang = "en"): Promise<Record<string, any> | null> {
  const j = await fetch(WIKIPEDIA_SUMMARY(lang, title), null);
  if (!j || typeof j.extract !== "string") return null;
  return { title: j.title, extract: String(j.extract).slice(0, 600), url: j.content_urls?.desktop?.page ?? "" };
}

export async function newsSearch(fetch: Fetcher, query: string, days = 30): Promise<{ title: string; url: string; age: string }[]> {
  if (process.env.BRAVE_API_KEY) {
    const j = await fetch(BRAVE_NEWS, { q: query, count: 5, freshness: "pm" });
    return (j?.results ?? []).slice(0, 5).map((r: any) => ({ title: r.title, url: r.url, age: r.age }));
  }
  const j = await fetch(GDELT_DOC, { query, mode: "ArtList", maxrecords: 5, format: "json", timespan: `${days}d`, sort: "DateDesc" });
  return (j?.articles ?? []).slice(0, 5).map((a: any) => ({ title: a.title, url: a.url, age: a.seendate }));
}

/** Market assets are fetched by the market context (price, vol, Polymarket); a "premise" about them is not a world fact. */
const MARKET_ENTITY = /\b(bitcoin|btc|ethereum|ether|eth|solana|sol|s&p|spx|s&p 500|nasdaq|crypto market|total crypto market cap|ouro|gold|petr[oó]leo|oil)\b/i;

/** Construtor 01/10: live GDELT/Wikipedia lookups failed from Render for the Copom/Fed cases, so scheduled central-bank meetings are
 *  verified first against official sources we already run: the FOMC calendar (federalreserve.gov dates in tools.calendar) and the
 *  BCB Focus survey (it lists the upcoming Copom meetings, "R7/2026"…) plus SGS 432 for the current Selic target. */
export async function internalCentralBank(fetch: Fetcher, p: Premise): Promise<Premise | null> {
  const t = `${p.claim} ${p.entity} ${p.query}`.toLowerCase();
  if (/\b(fomc|fed|federal reserve|federal funds)\b/.test(t)) {
    const cal: any = tools.calendar({ days: 120, types: ["fomc"] });
    const meets = (cal.items ?? []).filter((e: any) => e.subtype === "fomc").map((e: any) => String(e.at).slice(0, 10));
    if (meets.length) { p.verified = true; p.fact = `FOMC rate decisions scheduled (Federal Reserve calendar): ${meets.join(", ")}`; p.source_url = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"; p.data = { fomc: meets }; return p; }
  }
  if (/\b(copom|selic|banco central do brasil|bcb|central bank of brazil)\b/.test(t)) {
    const sgs = await fetch("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1", { formato: "json" });
    const selic = Number(String(sgs?.[0]?.valor ?? "").replace(",", "."));
    const focus = await fetch("https://olinda.bcb.gov.br/olinda/servico/Expectativas/versao/v1/odata/ExpectativasMercadoSelic", { $top: 24, $orderby: "Data desc", $format: "json" }).catch(() => null);
    const rows: any[] = Array.isArray(focus?.value) ? focus.value : [];
    const latest = rows.map(r => r.Data).sort().pop();
    const meetings = [...new Set(rows.filter(r => r.Data === latest).map(r => String(r.Reuniao)))].sort();
    if (Number.isFinite(selic)) {
      p.verified = true;
      p.fact = `Selic target today: ${selic}% (BCB SGS 432, ${sgs?.[0]?.data ?? "latest"})` + (meetings.length ? `; Copom meetings covered by the latest Focus survey (${latest}): ${meetings.join(", ")}` : "");
      p.source_url = "https://www.bcb.gov.br/controleinflacao/historicotaxasjuros"; p.data = { selic, meetings, focus_date: latest }; return p;
    }
  }
  return null;
}

export function ageOn(birth: string, when: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(birth ?? ""); if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const W = { y: when.getUTCFullYear(), m: when.getUTCMonth() + 1, d: when.getUTCDate() };
  return W.y - y - ((W.m < mo || (W.m === mo && W.d < d)) ? 1 : 0);
}

export async function verifyPremise(p: Premise, fetch: Fetcher, now: Date): Promise<Premise> {
  p.retrieved_at = now.toISOString();
  try {
    if (p.kind === "office_holder") {
      const office = p.query.replace(/^(current holder of office:|holder of|current)\s*/i, "").trim() || p.entity;
      const h = (await wikidataOfficeHolder(fetch, office.toLowerCase())) ?? (await wikidataOfficeHolder(fetch, office));
      if (h?.name) {
        const age = ageOn(h.birth_date ?? "", now); const alive = !h.death_date;
        p.verified = true;
        p.fact = `current ${office}: ${h.name} (born ${h.birth_date || "?"}${age != null ? ", age " + age : ""}; in office since ${h.start_time || "?"}${alive ? "" : "; DECEASED " + h.death_date})`;
        p.source_url = h.url ?? "https://www.wikidata.org"; p.data = h;
        // the claim named a specific person who is no longer the holder -> contradicted
        const named = p.claim.match(/[A-Z][a-z]+(?: [A-Z][a-z]+)+/g) ?? [];
        if (named.length && named.every(n => !String(h.name ?? "").toLowerCase().includes(n.split(" ")[0].toLowerCase()))) p.verified = "contradicted";
        return p;
      }
    }
    if ((p.kind === "status" || p.kind === "office_holder" || p.kind === "other") && p.entity) {
      const person = await wikidataPerson(fetch, p.entity);
      if (person) {
        const age = ageOn(person.birth_date ?? "", now); const dead = Boolean(person.death_date);
        const pos = (person.current_positions ?? []).join(", ") || "no current position recorded";
        p.fact = `${person.name}: born ${person.birth_date || "?"}${age != null ? ", age " + age : ""}; ${dead ? "DECEASED " + person.death_date : "alive"}; current positions: ${pos}`;
        p.source_url = person.url ?? ""; p.data = person;
        const claimL = p.claim.toLowerCase();
        if (dead && /\b(alive|vivo|in office|is president|is ceo|será|will be)\b/.test(claimL)) p.verified = "contradicted";
        else if (/\b(president|ceo|prime minister|chancellor|governor|pope|mayor)\b/.test(claimL) &&
          !["president", "chief executive", "ceo", "prime minister", "chancellor", "governor", "pope", "mayor"].some(k => pos.toLowerCase().includes(k))) p.verified = "contradicted";
        else p.verified = true;
        return p;
      }
    }
    if (p.kind === "value" || p.kind === "scheduled_event") {
      const cb = await internalCentralBank(fetch, p).catch(() => null);
      if (cb) return cb;
      const news = await newsSearch(fetch, p.query || p.entity, p.kind === "value" ? 45 : 90);
      if (news.length) {
        p.verified = true;
        p.fact = `${p.entity}: ${p.kind === "value" ? "latest coverage — " : ""}` + news.slice(0, 3).filter(n => n.title).map(n => `${n.title} (${n.age})`).join("; ");
        p.source_url = news[0].url ?? "";
        return p;
      }
    }
    // last resort: Wikipedia summary — only for people/entities (a generic article cannot verify a value or a scheduled event)
    const wp = p.entity && (p.kind === "status" || p.kind === "office_holder" || p.kind === "other") ? await wikipediaSummary(fetch, p.entity) : null;
    if (wp) { p.verified = true; p.fact = `${wp.title}: ${wp.extract}`; p.source_url = wp.url ?? ""; return p; }
  } catch (e) {
    p.fact = `lookup failed: ${(e as Error)?.name ?? "Error"} ${String((e as Error)?.message ?? "").slice(0, 80)}`;
  }
  p.verified = false;
  return p;
}

// ---------------------------------------------------------------- actuarial base rate (for "alive on <date>")
/** Gompertz-style approximation of adult male annual mortality (developed-country, top-tier care):
 *  ~0.4 % at 50, ~1.2 % at 62, ~3 % at 71, ~8 % at 82, ~15 % at 89, ~25 % at 95. */
export const annualMortality = (age: number) => Math.min(0.6, 0.00005 * Math.exp(0.09 * age));
export const survivalProbability = (age: number, horizonDays: number) => Math.round(Math.exp(-annualMortality(age) * horizonDays / 365) * 10000) / 10000;

/** Injectable fetcher (tests swap in mockFetcher; R2_MOCK=1 uses it too). */
export const _groundFetch: { current: Fetcher } = { current: defaultFetcher };

// ---------------------------------------------------------------- orchestration
export async function ground(question: string, opts: { now?: Date; resolvesAt?: Date | null; fetch?: Fetcher; usage: Usage }): Promise<Grounding> {
  const now = opts.now ?? new Date(); const fetch = opts.fetch ?? _groundFetch.current;
  let premises: Premise[] = [];
  try { premises = await extractPremises(question, now, opts.usage); }
  catch { return { premises: [], status: "unverified", corrected_question: null, warnings: ["premise extraction failed"], actuarial_base_rate: null, actuarial_note: "" }; }
  premises = premises.filter(p => !(MARKET_ENTITY.test(p.entity) && p.kind !== "office_holder" && p.kind !== "status"));
  if (!premises.length) return { premises: [], status: "none_needed", corrected_question: null, warnings: [], actuarial_base_rate: null, actuarial_note: "" };
  for (const p of premises) await verifyPremise(p, fetch, now);
  const g: Grounding = { premises, status: "verified", corrected_question: null, warnings: [], actuarial_base_rate: null, actuarial_note: "" };
  if (premises.some(p => p.verified === "contradicted")) g.status = "contradicted";
  else if (premises.every(p => p.verified === true)) g.status = "verified";
  else if (premises.some(p => p.verified === true)) g.status = "partial";
  else g.status = "unverified";
  for (const p of premises) {
    // implicit office ("the pope") -> re-ground the question on the verified holder
    if (p.kind === "office_holder" && p.verified === true && p.data?.name && !question.toLowerCase().includes(String(p.data.name).toLowerCase()))
      g.corrected_question = `${question}  [grounded: '${p.entity}' = ${p.data.name}]`;
    // survival questions: actuarial reference class from the VERIFIED birth date
    if ((p.verified === true || p.verified === "contradicted") && p.data?.birth_date && /\b(alive|vivo|viva|survive|sobreviv)/i.test(question)) {
      const age = ageOn(p.data.birth_date, now);
      if (age != null && opts.resolvesAt) {
        const days = Math.max(1, Math.floor((opts.resolvesAt.getTime() - now.getTime()) / 86_400_000));
        if (p.data.death_date) { g.actuarial_base_rate = 0; g.actuarial_note = `${p.data.name} is deceased (${p.data.death_date})`; }
        else { g.actuarial_base_rate = survivalProbability(age, days); g.actuarial_note = `survival of a ${age}-year-old over ${days} days, Gompertz approx., annual q=${annualMortality(age).toFixed(3)}`; }
      }
    }
  }
  for (const p of premises) {
    if (p.verified === false) g.warnings.push(`unverified premise: ${p.claim}`);
    else if (p.verified === "contradicted") g.warnings.push(`premise contradicted by live data: ${p.claim} -> ${p.fact}`);
  }
  return g;
}

export class UnverifiedPremise extends Error {
  constructor(public grounding: Grounding) { super("cannot verify the facts this question depends on"); }
}

// ---------------------------------------------------------------- mock fetcher for tests / offline
const PEOPLE: Record<string, any> = {
  pope: { name: "Leo XIV", qid: "Q133153742", birth_date: "1955-09-14", death_date: null, start_time: "2025-05-08", url: "https://www.wikidata.org/wiki/Q133153742" },
  "joe biden": { name: "Joe Biden", qid: "Q6279", birth_date: "1942-11-20", death_date: null, current_positions: [], url: "https://www.wikidata.org/wiki/Q6279" },
  "elon musk": { name: "Elon Musk", qid: "Q317521", birth_date: "1971-06-28", death_date: null, current_positions: ["chief executive officer of Tesla, Inc.", "chief executive officer of SpaceX"], url: "https://www.wikidata.org/wiki/Q317521" },
  "luiz inácio lula da silva": { name: "Luiz Inácio Lula da Silva", qid: "Q37181", birth_date: "1945-10-27", death_date: null, current_positions: ["President of Brazil"], url: "https://www.wikidata.org/wiki/Q37181" },
  lula: { name: "Luiz Inácio Lula da Silva", qid: "Q37181", birth_date: "1945-10-27", death_date: null, current_positions: ["President of Brazil"], url: "https://www.wikidata.org/wiki/Q37181" },
  "pope francis": { name: "Pope Francis", qid: "Q450675", birth_date: "1936-12-17", death_date: "2025-04-21", current_positions: [], url: "https://www.wikidata.org/wiki/Q450675" },
};
/** Answers like Wikidata/Wikipedia/GDELT would on 2026-09-30, for the six acceptance cases (same as MockFetcher in Python). */
export const mockFetcher: Fetcher = async (url, params) => {
  const P: any = params ?? {};
  if (url === WIKIDATA_SPARQL) {
    const q = String(P.query ?? "");
    let m = /VALUES \?lbl \{ "([^"]+)"@en/.exec(q);
    if (m) {
      const h = PEOPLE[m[1].toLowerCase()];
      if (!h) return { results: { bindings: [] } };
      return { results: { bindings: [{ person: { value: h.url }, personLabel: { value: h.name }, birth: { value: h.birth_date }, start: { value: h.start_time }, ...(h.death_date ? { death: { value: h.death_date } } : {}) }] } };
    }
    if (/VALUES \?p \{/.test(q)) { const ids = [...q.matchAll(/wd:(Q\d+)/g)].map(x => x[1]); return { results: { bindings: ids.slice(0, 1).map(id => ({ p: { value: `http://www.wikidata.org/entity/${id}` } })) } }; }
    m = /wd:(Q\d+)/.exec(q);
    for (const h of Object.values(PEOPLE)) if (m && h.qid === m[1]) {
      const pos: (string | null)[] = h.current_positions?.length ? h.current_positions : [null];
      return { results: { bindings: pos.map(p => ({ birth: { value: h.birth_date }, ...(h.death_date ? { death: { value: h.death_date } } : {}), ...(p ? { posLabel: { value: p } } : {}) })) } };
    }
    return { results: { bindings: [] } };
  }
  if (url === WIKIDATA_API) { const h = PEOPLE[String(P.search ?? "").toLowerCase()]; return h ? { search: [{ id: h.qid, label: h.name }] } : { search: [] }; }
  if (url.includes("wikipedia.org")) return null;
  if (url === GDELT_DOC) {
    const q = String(P.query ?? "").toLowerCase();
    if (q.includes("selic") || q.includes("copom")) return { articles: [{ title: "Copom mantém Selic; próxima reunião em 3-4 de novembro", url: "https://example.org/selic", seendate: "20260916" }] };
    return { articles: [] };
  }
  return null;
};

if (process.env.R2_MOCK === "1") _groundFetch.current = mockFetcher;
