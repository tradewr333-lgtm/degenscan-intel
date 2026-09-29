/** LLM backends for the oracle: DeepSeek (OpenAI-compatible, plain fetch, no SDK) and a deterministic mock.
 *  1:1 port of realidade2/llm.py. All prompts ask for JSON; `chatJson` parses and repairs it.
 *  `_llm.chat` is injectable (tests / R2_MOCK), same pattern as `_ext.get` in tools.ts. */
import { Rng } from "./rng.js";

export const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com";
export const FAST_MODEL = process.env.R2_FAST_MODEL ?? "deepseek-chat";        // agents / population
export const STRONG_MODEL = process.env.R2_STRONG_MODEL ?? "deepseek-reasoner";  // final aggregation

export interface ChatOpts { strong?: boolean; temperature?: number; seed?: number }
export type ChatFn = (system: string, user: string, opts: ChatOpts, usage: Usage) => Promise<any>;
export interface Usage { prompt: number; completion: number; calls: number }
export const newUsage = (): Usage => ({ prompt: 0, completion: 0, calls: 0 });

export function extractJson(text: string): any {
  text = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) text = fence[1].trim();
  try { return JSON.parse(text); } catch { /* fall through */ }
  for (const [open, close] of [["{", "}"], ["[", "]"]] as const) {
    const i = text.indexOf(open), j = text.lastIndexOf(close);
    if (i !== -1 && j > i) { try { return JSON.parse(text.slice(i, j + 1)); } catch { continue; } }
  }
  throw new Error(`model did not return JSON: ${JSON.stringify(text.slice(0, 200))}`);
}

/** DeepSeek via fetch. max_tokens 8192; response_format json_object on the fast model; the reasoner ignores temperature/response_format. */
export const deepseekChat: ChatFn = async (system, user, opts, usage) => {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("DEEPSEEK_API_KEY not set");
  const model = opts.strong ? STRONG_MODEL : FAST_MODEL;
  let sysMsg = system + "\nRespond with valid, COMPACT JSON only (no markdown, minimal whitespace).";
  for (let attempt = 0; attempt < 2; attempt++) {
    const body: any = { model, max_tokens: 8192, messages: [{ role: "system", content: sysMsg }, { role: "user", content: user }] };
    if (!opts.strong) { body.temperature = opts.temperature ?? 0.7; body.response_format = { type: "json_object" }; }
    const res = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.strong ? 240_000 : 120_000),
    });
    if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const j: any = await res.json();
    if (j.usage) { usage.prompt += j.usage.prompt_tokens ?? 0; usage.completion += j.usage.completion_tokens ?? 0; }
    usage.calls += 1;
    const text: string = j.choices?.[0]?.message?.content ?? "";
    try { return extractJson(text); }
    catch (e) {
      if (attempt === 1) throw e;
      // output was cut off (finish_reason=length) or malformed: ask for a tighter answer once
      sysMsg += " Your previous answer was truncated: keep every string under 12 words.";
    }
  }
};

/** Offline stand-in. Produces plausible-shaped JSON keyed on prompt markers; deterministic given `seed`. */
export function mockChat(baseSeed = 0): ChatFn {
  return async (_system, user, opts, usage) => {
    usage.calls += 1;
    const rng = new Rng((baseSeed * 1_000_003) ^ (opts.seed ?? 0));
    if (user.includes("TASK: route")) {
      const m = /Question: (.*)/.exec(user); const q = (m ? m[1] : user).toLowerCase();
      if (["chuva", "rain", "temperatura", "weather", "clima", "furacão", "hurricane"].some(w => q.includes(w)))
        return { domain: "weather", method: "expert_panel", human_driven: false, binary: true, rationale: "physical system; social simulation adds nothing" };
      if (["polymarket", "kalshi", "eleição", "election", "vote", "adot", "usuários", "users", "preço", "price", "btc", "eth", "crypto", "cripto", "token"].some(w => q.includes(w)))
        return { domain: q.includes("polymarket") || q.includes("kalshi") ? "prediction_market" : ["btc", "eth", "cripto", "crypto", "token"].some(w => q.includes(w)) ? "crypto" : "society",
          method: "social_sim", human_driven: true, binary: true, rationale: "outcome depends on aggregate human behaviour" };
      return { domain: "general", method: "hybrid", human_driven: true, binary: true, rationale: "mixed" };
    }
    if (user.includes("TASK: population")) {
      const n = Number(/N=(\d+)/.exec(user)![1]); const m0 = /ids a(\d+)\.\./.exec(user); const off = m0 ? Number(m0[1]) : 0;
      const archetypes = ["retail trader", "whale", "skeptic journalist", "quant fund PM", "influencer", "long-term holder", "regulator watcher", "degen", "macro analyst", "newcomer"];
      const out: any[] = [];
      for (let i = 0; i < n; i++) {
        const p = rng.random();
        out.push({ id: `a${off + i}`, name: `Persona ${off + i}`, archetype: archetypes[(off + i) % archetypes.length],
          traits: { risk: +rng.random().toFixed(2), trust: +rng.random().toFixed(2), influence: +rng.random().toFixed(2), contrarian: +rng.random().toFixed(2) },
          prior: +(0.2 + 0.6 * p).toFixed(2), stance: p > 0.5 ? "yes" : "no", connections: rng.sample([...Array(n).keys()], Math.min(3, n - 1)).sort((a, b) => a - b) });
      }
      return { agents: out };
    }
    if (user.includes("TASK: round")) {
      const ids = [...user.matchAll(/"id":"(a\d+)"/g)].map(m => m[1]);
      return { updates: ids.map(i => ({ id: i, belief_delta: +rng.gauss(0, 0.08).toFixed(3), message: rng.choice(["holds view", "shifts slightly after talking to peers", "reacts to news", "unmoved"]), talks_to: ids.length > 1 ? rng.choice(ids) : null })) };
    }
    if (user.includes("TASK: panel")) {
      const m = /"base_rate":([0-9.]+)/.exec(user) ?? /"market_odds":([0-9.]+)/.exec(user); const anchor = m ? Number(m[1]) : 0.45;
      return { experts: [0, 1, 2, 3, 4].map(k => ({ name: `Forecaster ${k}`, anchor, probability: +Math.min(0.95, Math.max(0.05, rng.gauss(anchor, 0.08))).toFixed(2), reasoning: "base rate + current signals", key_uncertainty: "data gap" })) };
    }
    if (user.includes("TASK: aggregate")) {
      const probs = [...user.matchAll(/p=([0-9.]+)/g)].map(m => Number(m[1]));
      const m = /"base_rate":([0-9.]+)/.exec(user) ?? /"market_odds":([0-9.]+)/.exec(user); const anchor = m ? Number(m[1]) : 0.5;
      const mean = probs.length ? 0.5 * anchor + 0.5 * (probs.reduce((a, b) => a + b, 0) / probs.length) : anchor;
      return { probability: +mean.toFixed(3), summary: "mock aggregate of scenario runs", drivers: ["peer influence", "news shock"], failure_modes: ["late reversal"], confidence: "medium" };
    }
    return {};
  };
}

/** Backend order: R2_MOCK → DeepSeek key → error (never silently mock in production). Injectable for tests. */
export const _llm = {
  chat: (process.env.R2_MOCK === "1" ? mockChat(0) : deepseekChat) as ChatFn,
  reset() { this.chat = process.env.R2_MOCK === "1" ? mockChat(0) : deepseekChat; },
};
export const chatJson = (system: string, user: string, opts: ChatOpts, usage: Usage) => _llm.chat(system, user, opts, usage);
export const llmConfigured = () => process.env.R2_MOCK === "1" || Boolean(process.env.DEEPSEEK_API_KEY) || _llm.chat !== deepseekChat;
