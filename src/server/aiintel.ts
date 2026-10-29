/**
 * AI Intel (Renato 29/10, briefing "API de Serviços de IA"): the parts of that briefing we can build from PRIMARY,
 * public, machine-readable sources — never by reselling Gartner/IDC/Forrester/Sequoia reports:
 *  - ai_models / ai_cheapest / ai_cost : LLM vendor intelligence — price per 1M tokens, context, modalities, tool use,
 *    for ~450 models from OpenRouter's public models API (prices as published by each provider through OpenRouter).
 *  - ai_adoption : tool/framework adoption — weekly downloads (npm + PyPI) with week-over-week change, GitHub stars.
 *  - ai_research : research momentum — new arXiv papers per topic (7 d / 30 d) from the arXiv API.
 *  - ai_regulation : AI law milestones (EU AI Act after Omnibus 2026/1744, Colorado SB 26-189, Brazil PL 2338/2023),
 *    curated with sources and an as_of date. Information only — not legal advice.
 */
import { UA } from "../ingest/http.js";

export const AI_DISCLAIMER = "Information and analytics only — not investment or legal advice.";
const memo = new Map<string, { at: number; v: any }>();
async function cached<T>(k: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const c = memo.get(k); if (c && Date.now() - c.at < ttl) return c.v as T;
  try { const v = await f(); memo.set(k, { at: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v as T; throw e; }   // serve stale on upstream failure
}
export const _ai = { reset() { memo.clear(); } };
const r = (x: number | null | undefined, d = 4) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
async function getJson<T = any>(url: string, timeout = 20_000): Promise<T> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Models ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Model { id: string; name: string; provider: string; created: string | null; context: number | null; max_output: number | null;
  input_per_1m: number | null; output_per_1m: number | null; cache_read_per_1m: number | null; modalities_in: string[]; modalities_out: string[];
  tools: boolean; structured_outputs: boolean; reasoning: boolean; free: boolean }
const per1m = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? r(n * 1e6, 4) : null; };
/** Pure: OpenRouter /models rows → normalised models. Exported for tests. */
export function normModels(rows: any[]): Model[] {
  return (rows ?? []).filter(m => m?.id && !String(m.id).includes("auto")).map((m: any) => {
    const sp: string[] = m.supported_parameters ?? []; const p = m.pricing ?? {};
    const inp = per1m(p.prompt), out = per1m(p.completion);
    return { id: String(m.id), name: String(m.name ?? m.id), provider: String(m.id).split("/")[0], created: m.created ? new Date(Number(m.created) * 1000).toISOString().slice(0, 10) : null,
      context: Number(m.context_length) || null, max_output: Number(m.top_provider?.max_completion_tokens) || null,
      input_per_1m: inp != null && inp < 0 ? null : inp, output_per_1m: out != null && out < 0 ? null : out, cache_read_per_1m: per1m(p.input_cache_read),
      modalities_in: m.architecture?.input_modalities ?? [], modalities_out: m.architecture?.output_modalities ?? [],
      tools: sp.includes("tools"), structured_outputs: sp.includes("structured_outputs") || sp.includes("response_format"), reasoning: sp.includes("reasoning") || sp.includes("include_reasoning"),
      free: inp === 0 && out === 0 };
  });
}
const models = () => cached("models", 30 * 60_000, async () => normModels((await getJson<any>("https://openrouter.ai/api/v1/models", 30_000)).data));
const blended = (m: Model, inTok = 3, outTok = 1) => m.input_per_1m == null || m.output_per_1m == null ? Infinity : (m.input_per_1m * inTok + m.output_per_1m * outTok) / (inTok + outTok);
const parseNeeds = (raw: unknown) => new Set(String(raw ?? "").toLowerCase().split(/[,\s]+/).filter(Boolean));
export function filterModels(all: Model[], q: { provider?: unknown; needs?: unknown; min_context?: unknown; include_free?: unknown }) {
  const prov = q.provider ? String(q.provider).toLowerCase() : null; const needs = parseNeeds(q.needs); const minCtx = Number(q.min_context) || 0;
  return all.filter(m => (!prov || m.provider === prov) && (m.context ?? 0) >= minCtx && (String(q.include_free) === "1" || !m.free)
    && (!needs.has("tools") || m.tools) && (!needs.has("json") || m.structured_outputs) && (!needs.has("reasoning") || m.reasoning)
    && (!needs.has("vision") || m.modalities_in.includes("image")) && (!needs.has("audio") || m.modalities_in.includes("audio")) && (!needs.has("pdf") || m.modalities_in.includes("file")));
}
export async function aiModels(q: any = {}) {
  const all = await models(); const list = filterModels(all, { ...q, include_free: q.include_free ?? "1" });
  const sort = String(q.sort ?? "newest"); const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 100);
  const sorted = [...list].sort(sort === "price" ? (a, b) => blended(a) - blended(b) : sort === "context" ? (a, b) => (b.context ?? 0) - (a.context ?? 0) : (a, b) => String(b.created).localeCompare(String(a.created)));
  const byProv = new Map<string, number>(); for (const m of all) byProv.set(m.provider, (byProv.get(m.provider) ?? 0) + 1);
  return { n_total: all.length, n_matched: list.length, sort, items: sorted.slice(0, limit),
    providers_top: [...byProv.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([provider, models]) => ({ provider, models })),
    fields: { input_per_1m: "USD per 1M input tokens", output_per_1m: "USD per 1M output tokens", needs: "filter: tools, json, reasoning, vision, audio, pdf" },
    source: "OpenRouter public models API (provider list prices)", as_of: new Date().toISOString(), disclaimer: AI_DISCLAIMER };
}
export async function aiCheapest(q: any = {}) {
  const list = filterModels(await models(), q).filter(m => Number.isFinite(blended(m)));
  const items = list.sort((a, b) => blended(a) - blended(b)).slice(0, Math.min(Math.max(Number(q.limit) || 10, 1), 25))
    .map(m => ({ id: m.id, name: m.name, input_per_1m: m.input_per_1m, output_per_1m: m.output_per_1m, blended_per_1m: r(blended(m), 4), context: m.context, tools: m.tools, vision: m.modalities_in.includes("image") }));
  return { needs: [...parseNeeds(q.needs)], min_context: Number(q.min_context) || 0, n_matched: list.length, items, blended: "3:1 input:output tokens",
    source: "OpenRouter public models API", as_of: new Date().toISOString(), disclaimer: AI_DISCLAIMER };
}
/** Cost of a workload on each requested model (default: 5 popular). */
export async function aiCost(q: any = {}) {
  const all = await models(); const inTok = Math.max(Number(q.input_tokens) || 2000, 0), outTok = Math.max(Number(q.output_tokens) || 500, 0), calls = Math.max(Number(q.calls) || 1000, 1);
  const want = String(q.models ?? "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 12);
  const pick = want.length ? want.map(w => all.find(m => m.id.toLowerCase() === w) ?? all.find(m => m.id.toLowerCase().includes(w))).filter(Boolean) as Model[]
    : ["openai/", "anthropic/", "google/", "meta-llama/", "mistralai/", "deepseek/"].map(p => all.filter(m => m.id.startsWith(p) && !m.free && m.input_per_1m != null).sort((a, b) => String(b.created).localeCompare(String(a.created)))[0]).filter(Boolean) as Model[];
  if (!pick.length) return null;
  const items = pick.map(m => { const per = m.input_per_1m == null || m.output_per_1m == null ? null : (m.input_per_1m * inTok + m.output_per_1m * outTok) / 1e6;
    return { id: m.id, name: m.name, usd_per_call: r(per, 6), usd_total: per == null ? null : r(per * calls, 4), input_per_1m: m.input_per_1m, output_per_1m: m.output_per_1m, context: m.context, fits_context: m.context == null ? null : inTok + outTok <= m.context }; })
    .sort((a, b) => (a.usd_per_call ?? Infinity) - (b.usd_per_call ?? Infinity));
  return { workload: { input_tokens: inTok, output_tokens: outTok, calls }, items, cheapest: items[0]?.id ?? null, note: "List prices; caching, batch and volume discounts not applied.",
    source: "OpenRouter public models API", as_of: new Date().toISOString(), disclaimer: AI_DISCLAIMER };
}

// ── Adoption ───────────────────────────────────────────────────────────────────────────────────────────────────
export const ADOPTION: { name: string; npm?: string; pypi?: string; repo?: string; kind: string }[] = [
  { name: "OpenAI SDK", npm: "openai", pypi: "openai", repo: "openai/openai-python", kind: "model_sdk" },
  { name: "Anthropic SDK", npm: "@anthropic-ai/sdk", pypi: "anthropic", repo: "anthropics/anthropic-sdk-python", kind: "model_sdk" },
  { name: "Google GenAI SDK", npm: "@google/genai", pypi: "google-genai", repo: "googleapis/python-genai", kind: "model_sdk" },
  { name: "Mistral SDK", npm: "@mistralai/mistralai", pypi: "mistralai", kind: "model_sdk" },
  { name: "LangChain", npm: "langchain", pypi: "langchain", repo: "langchain-ai/langchain", kind: "framework" },
  { name: "LangGraph", npm: "@langchain/langgraph", pypi: "langgraph", repo: "langchain-ai/langgraph", kind: "agents" },
  { name: "LlamaIndex", npm: "llamaindex", pypi: "llama-index", repo: "run-llama/llama_index", kind: "rag" },
  { name: "CrewAI", pypi: "crewai", repo: "crewAIInc/crewAI", kind: "agents" },
  { name: "AutoGen", pypi: "autogen-agentchat", repo: "microsoft/autogen", kind: "agents" },
  { name: "Vercel AI SDK", npm: "ai", repo: "vercel/ai", kind: "framework" },
  { name: "MCP SDK", npm: "@modelcontextprotocol/sdk", pypi: "mcp", repo: "modelcontextprotocol/python-sdk", kind: "agents" },
  { name: "DSPy", pypi: "dspy", repo: "stanfordnlp/dspy", kind: "framework" },
  { name: "Hugging Face Transformers", pypi: "transformers", repo: "huggingface/transformers", kind: "models" },
  { name: "vLLM", pypi: "vllm", repo: "vllm-project/vllm", kind: "serving" },
  { name: "Ollama", npm: "ollama", pypi: "ollama", repo: "ollama/ollama", kind: "serving" },
  { name: "Chroma", npm: "chromadb", pypi: "chromadb", repo: "chroma-core/chroma", kind: "vector_db" },
  { name: "Qdrant client", npm: "@qdrant/js-client-rest", pypi: "qdrant-client", repo: "qdrant/qdrant", kind: "vector_db" },
  { name: "pgvector", pypi: "pgvector", repo: "pgvector/pgvector", kind: "vector_db" },
  { name: "x402", npm: "x402", pypi: "x402", repo: "coinbase/x402", kind: "agent_payments" },
];
/** Pure: daily series [{day, downloads}] → last 7 d, prior 7 d, WoW %. Exported for tests. */
export function weekly(series: { day: string; downloads: number }[]) {
  const s = [...series].sort((a, b) => a.day.localeCompare(b.day)); if (s.length < 7) return null;
  const sum = (a: typeof s) => a.reduce((t, x) => t + (Number(x.downloads) || 0), 0);
  const last = sum(s.slice(-7)), prev = s.length >= 14 ? sum(s.slice(-14, -7)) : null;
  return { last_7d: last, prior_7d: prev, wow_pct: prev ? r((last - prev) / prev * 100, 1) : null, through: s[s.length - 1].day };
}
async function npmWeekly(pkg: string) {
  const j = await getJson<any>(`https://api.npmjs.org/downloads/range/last-month/${encodeURIComponent(pkg).replace("%40", "@")}`);
  return weekly((j.downloads ?? []).map((d: any) => ({ day: d.day, downloads: d.downloads })));
}
async function pypiWeekly(pkg: string) {
  const j = await getJson<any>(`https://pypistats.org/api/packages/${encodeURIComponent(pkg)}/overall?mirrors=false`);
  return weekly((j.data ?? []).filter((d: any) => d.category === "without_mirrors").map((d: any) => ({ day: d.date, downloads: d.downloads })).slice(-30));
}
async function ghStars(repo: string) { const j = await getJson<any>(`https://api.github.com/repos/${repo}`); return { stars: j.stargazers_count ?? null, pushed_at: j.pushed_at ?? null }; }
const pause = (ms: number) => new Promise(res => setTimeout(res, ms));
let adoptionBusy = false;
async function fillAdoption() {
  if (adoptionBusy) return; adoptionBusy = true;
  try { await cached("adoption", 6 * 3_600_000, adoptionFetch); } catch { /* keep last */ } finally { adoptionBusy = false; }
}
const warming = () => Object.assign(new Error("warming up: first collection running, retry in ~60 s"), { status: 503 });
export function aiAdoption(q: any = {}) {
  const kind = q.kind ? String(q.kind).toLowerCase() : null;
  const c = memo.get("adoption"); if (!c || Date.now() - c.at > 6 * 3_600_000) { void fillAdoption(); if (!c) return Promise.reject(warming()); }
  return Promise.resolve(c!.v).then((all: any[]) => {
    const items = (kind ? all.filter((x: any) => x.kind === kind) : all).sort((a: any, b: any) => b.downloads_7d_total - a.downloads_7d_total);
    return { kind, n: items.length, items, kinds: [...new Set(ADOPTION.map(a => a.kind))], sources: ["npm downloads API", "pypistats.org (PyPI, without mirrors)", "GitHub REST API"],
      collected_at: new Date(c!.at).toISOString(), as_of: new Date().toISOString(), disclaimer: AI_DISCLAIMER };
  });
}
async function adoptionFetch() {
  {
    const items: any[] = [];
    for (const t of ADOPTION) {   // sequential + small pause: pypistats and GitHub (unauthenticated) rate limits
      const [npm, pypi, gh] = await Promise.all([t.npm ? npmWeekly(t.npm).catch(() => null) : null, t.pypi ? pypiWeekly(t.pypi).catch(() => null) : null, t.repo ? ghStars(t.repo).catch(() => null) : null]);
      items.push({ name: t.name, kind: t.kind, npm: t.npm ? { package: t.npm, ...npm } : null, pypi: t.pypi ? { package: t.pypi, ...pypi } : null, github: t.repo ? { repo: t.repo, ...gh } : null,
        downloads_7d_total: (npm?.last_7d ?? 0) + (pypi?.last_7d ?? 0) });
      await pause(400);
    }
    return items;
  }
}

// ── Research momentum (arXiv) ──────────────────────────────────────────────────────────────────────────────────
export const TOPICS: Record<string, string> = {
  rag: 'abs:"retrieval augmented generation" OR abs:"retrieval-augmented generation"', agents: 'abs:"LLM agent" OR abs:"language model agent" OR abs:"agentic"',
  fine_tuning: 'abs:"fine-tuning" AND abs:"language model"', mcp: 'abs:"model context protocol"', evaluation: 'abs:"LLM evaluation" OR abs:"benchmark" AND abs:"large language model"',
  quantization: 'abs:"quantization" AND abs:"language model"', multimodal: 'abs:"multimodal large language model"', reasoning: 'abs:"reasoning" AND abs:"large language model"',
  safety: 'abs:"alignment" AND abs:"language model"', inference: 'abs:"inference" AND abs:"serving" AND abs:"LLM"',
};
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "") + "0000";
let researchBusy = false;
export async function fillResearch() {
  if (researchBusy) return; researchBusy = true;
  try {
    for (const t of Object.keys(TOPICS)) {
      const c = memo.get(`arxiv:${t}`); if (c && Date.now() - c.at < 12 * 3_600_000) continue;
      try { const { d7, d30, capped_30d } = await arxivRecent(TOPICS[t]); await pause(3100);
        memo.set(`arxiv:${t}`, { at: Date.now(), v: { topic: t, papers_7d: d7, papers_30d: d30, papers_30d_is_lower_bound: capped_30d, weekly_pace_vs_30d: d30 && !capped_30d ? r(d7 / (d30 / (30 / 7)), 2) : null } }); } catch { await pause(3100); }
    }
  } finally { researchBusy = false; }
}
/** Warm the slow collections at boot and keep them fresh (called from cli.ts). */
export function startAiCollector() {
  const run = () => { void fillAdoption(); void fillResearch(); };
  setTimeout(run, 90_000).unref?.(); setInterval(run, 6 * 3_600_000).unref?.();
}
/** Pure: count <published> dates inside the last 7/30 days. Exported for tests. arXiv's submittedDate range filter
 *  answers HTTP 500 (29/10), so we sort by submittedDate and count the newest entries instead. */
export function countRecent(xml: string, now: number, max: number) {
  const ds = [...xml.matchAll(/<published>([^<]+)<\/published>/g)].map(m => Date.parse(m[1])).filter(Number.isFinite);
  const c = (d: number) => ds.filter(t => t >= now - d * 86_400_000).length;
  const oldest = ds.length ? Math.min(...ds) : null;
  return { d7: c(7), d30: c(30), capped_30d: ds.length >= max && oldest != null && oldest >= now - 30 * 86_400_000 };
}
async function arxivRecent(query: string) {
  const max = 1000;
  const res = await fetch(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${max}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`arxiv ${res.status}`);
  return countRecent(await res.text(), Date.now(), max);
}
export async function aiResearch(q: any = {}) {
  const topic = q.topic ? String(q.topic).toLowerCase() : null;
  if (topic && !TOPICS[topic]) throw Object.assign(new Error(`topic one of ${Object.keys(TOPICS).join(", ")}`), { status: 400 });
  const list = topic ? [topic] : Object.keys(TOPICS);
  const stale = Object.keys(TOPICS).some(t => { const c = memo.get(`arxiv:${t}`); return !c || Date.now() - c.at > 12 * 3_600_000; });
  if (stale) void fillResearch();
  const items = list.map(t => memo.get(`arxiv:${t}`)?.v).filter(Boolean) as any[];
  if (!items.length) throw warming();
  return { items: items.sort((a, b) => (b.papers_7d ?? 0) - (a.papers_7d ?? 0)), topics: Object.keys(TOPICS), fields: { weekly_pace_vs_30d: ">1 = last week above the 30-day weekly average" },
    source: "arXiv API (newest 1,000 matches by submission date, abstract match)", as_of: new Date().toISOString(), disclaimer: AI_DISCLAIMER };
}

// ── Regulation milestones (curated; verified 29/10/2026) ─────────────────────────────────────────────────────────
export const REG_AS_OF = "2026-10-29";
export const REGULATION: Record<string, any> = {
  eu: { law: "EU AI Act — Regulation (EU) 2024/1689, as amended by the Digital Omnibus on AI, Regulation (EU) 2026/1744", status: "in force (phased application)",
    milestones: [
      { date: "2024-08-01", what: "Entry into force" },
      { date: "2025-02-02", what: "Prohibited AI practices and AI literacy obligations apply" },
      { date: "2025-08-02", what: "General-purpose AI (GPAI) model obligations, governance and penalties apply" },
      { date: "2026-08-02", what: "General application date (incl. Article 50 transparency for systems placed on the market from this date)" },
      { date: "2026-12-02", what: "New prohibitions added by the Omnibus (non-consensual intimate imagery / CSAM generation) and Article 50(2) for generative systems already on the market" },
      { date: "2027-12-02", what: "High-risk obligations for Annex III systems (moved from 2026-08-02 by the Omnibus)" },
      { date: "2028-08-02", what: "High-risk obligations for Annex I systems (AI in regulated products)" },
      { date: "2030-08-02", what: "High-risk systems used by public authorities must comply" }],
    sources: ["https://eur-lex.europa.eu/eli/reg/2024/1689/oj", "https://eur-lex.europa.eu/eli/reg/2026/1744/oj", "https://www.orrick.com/en/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes"] },
  us_colorado: { law: "Colorado SB 26-189 (repealed and replaced SB 24-205, the Colorado AI Act)", status: "enacted 2026-05-14; effective 2027-01-01; enforcement after Attorney General rulemaking",
    milestones: [{ date: "2026-05-14", what: "SB 26-189 signed" }, { date: "2027-01-01", what: "Effective: notice duties for automated decision-making tools in consequential decisions, adverse-decision disclosure within 30 days, 3-year record retention" }, { date: "2030-01-01", what: "End of the 60-day cure period" }],
    sources: ["https://www.eckertseamans.com/legal-updates/colorado-repeals-and-replaces-its-landmark-ai-statute-what-businesses-need-to-know"] },
  brazil: { law: "PL 2338/2023 (Marco Legal da Inteligência Artificial)", status: "bill — not law: passed the Senate 2024-12-10; in the Chamber's special committee awaiting the rapporteur's report; vote announced for after the October 2026 elections",
    milestones: [{ date: "2024-12-10", what: "Senate approved the substitute text" }, { date: "2025-03-17", what: "Received by the Chamber of Deputies (priority)" }, { date: "2025-05-20", what: "Special committee installed; rapporteur designated" }, { date: "2026-08-24", what: "Rapporteur postponed the vote to after the October 2026 elections" }],
    other_rules: ["LGPD (Lei 13.709/2018) applies to personal data used by AI systems"],
    sources: ["https://www.camara.leg.br/proposicoesWeb/fichadetramitacao?idProposicao=2487262", "https://monitor.lcfconsulting.com.br/proposicoes/pl-2338-2023/"] },
};
export function aiRegulation(raw?: unknown) {
  const j = raw ? String(raw).toLowerCase().replace(/[^a-z_]/g, "") : null;
  const pick = j ? (REGULATION[j] ? { [j]: REGULATION[j] } : null) : REGULATION;
  if (!pick) throw Object.assign(new Error(`jurisdiction one of ${Object.keys(REGULATION).join(", ")}`), { status: 400 });
  const today = new Date().toISOString().slice(0, 10);
  const out = Object.fromEntries(Object.entries(pick).map(([k, v]: any) => [k, { ...v, next_milestone: v.milestones.find((m: any) => m.date >= today) ?? null }]));
  return { as_of: REG_AS_OF, jurisdictions: out, available: Object.keys(REGULATION), disclaimer: "Curated summary of public sources with dates; verify against the official texts. Information only — not legal advice." };
}
