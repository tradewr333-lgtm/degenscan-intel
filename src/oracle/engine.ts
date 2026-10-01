/** 2Realidade engine: route -> build society -> run rounds -> Monte Carlo -> aggregate. 1:1 port of realidade2/engine.py.
 *
 *  Design choices
 *  - Time is event-driven (rounds), not tick-by-tick: cheap and enough for opinion dynamics.
 *  - Agents are updated in BATCHES (one LLM call per batch per round), not one call per agent.
 *  - The router decides the method. Social simulation only where humans drive the outcome;
 *    physical questions go to an expert panel and are labelled low-confidence rather than faked.
 *  The prompts below (TASK: route|population|round|panel|aggregate) are the product — copied verbatim from the Python. */
import { createHash, randomUUID } from "node:crypto";
import { buildContext, contextToPrompt, type DataProvider, type MarketContext } from "./context.js";
import { chatJson, newUsage, type Usage } from "./llm.js";
import { GROUNDING_RULE, ground, groundingToPrompt, UnverifiedPremise, type Fetcher, type Grounding } from "./grounding.js";
import { Rng } from "./rng.js";
import { DISCLAIMER, ENGINE_VERSION, ENGINE_VERSION_GROUNDED, type Agent, type Forecast, type ForecastRequest, type Intervention, type Routing, type RunResult } from "./schema.js";

// each Monte Carlo run builds its society through a different lens -> forced diversity between runs
export const LENSES = [
  "retail-heavy: most agents are small holders, social-media driven, momentum chasers",
  "institution-heavy: funds, market makers, treasuries, risk committees, slow and rules-based",
  "bear-tilted: half the agents entered the year expecting a drawdown; sceptics of narratives",
  "bull-tilted: half the agents hold a structural adoption thesis; dismiss macro noise",
  "macro-first: agents read Fed, rates, dollar and liquidity before anything asset-specific",
  "on-chain/derivatives-first: agents read funding, OI, liquidations, ETF flows, whale moves",
  "policy/regulatory-first: agents track regulators, court cases, elections and legislation",
  "contrarian-dense: 40% of agents are trained to bet against the visible consensus",
];
const BATCH = 8;      // agents per round LLM call
const POP_CHUNK = 8;  // personas per population LLM call

export const SYS = "You are the simulation kernel of 2Realidade, a forecasting oracle used by other AI agents. " +
  "You never flatter, you quantify, you surface disagreement instead of hiding it.";
/** 0.3.5-ts: grounded requests carry the fact-base rule in the SYSTEM prompt (Architect no.6); board (0.3.3-ts) prompts are unchanged. */
const GROUNDED = new WeakSet<object>();
const sysOf = (req: object) => GROUNDED.has(req) ? SYS + " " + GROUNDING_RULE : SYS;

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const pstdev = (xs: number[]) => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const logit = (p: number) => { const q = clamp(p, 0.005, 0.995); return Math.log(q / (1 - q)); };
export const logitMean = (xs: number[]) => 1 / (1 + Math.exp(-mean(xs.map(logit))));
const num = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ---------------------------------------------------------------- routing
export async function route(req: ForecastRequest, usage: Usage): Promise<Routing> {
  if (req.method) return { domain: "forced", method: req.method, human_driven: req.method !== "expert_panel", binary: true, rationale: "method forced by caller" };
  const out = await chatJson(sysOf(req), `TASK: route\nQuestion: ${req.question}\nContext: ${req.context.slice(0, 2000)}\n` +
    "Classify. domain in [crypto, finance, prediction_market, society, product, politics, weather, " +
    "sports, tech, general]. method: 'social_sim' when the outcome is driven by aggregate human " +
    "behaviour (adoption, votes, narratives, market resolution), 'expert_panel' when it is a physical " +
    "or data-driven system (weather, mechanics), 'hybrid' when both matter. " +
    "Return {domain, method, human_driven, binary, rationale}.", { temperature: 0.0, seed: 1 }, usage);
  const method = ["social_sim", "expert_panel", "hybrid"].includes(out?.method) ? out.method : "hybrid";
  return { domain: String(out?.domain ?? "general"), method, human_driven: out?.human_driven ?? true, binary: out?.binary ?? true, rationale: String(out?.rationale ?? "") };
}

// ---------------------------------------------------------------- society
export async function buildPopulation(req: ForecastRequest, routing: Routing, seed: number, usage: Usage): Promise<Agent[]> {
  const n = req.population;
  const raw: any[] = [];
  for (let start = 0; start < n; start += POP_CHUNK) {  // chunked so one reply never overflows the output limit
    const k = Math.min(POP_CHUNK, n - start);
    const lens = LENSES[seed % LENSES.length];
    const out = await chatJson(sysOf(req), `TASK: population N=${k}\nQuestion: ${req.question}\nDomain: ${routing.domain}\n` +
      `Society lens for THIS run: ${lens}\n${req.context.slice(0, 3500)}\n` +
      "Priors must be anchored on the MARKET CONTEXT numbers (distance to target, implied move, " +
      "base_rate, market_odds), each persona deviating according to its own bias.\n" +
      `Create ${k} DISTINCT personas (ids a${start}..a${start + k - 1}) who plausibly shape or bet on ` +
      "this outcome. Mix archetypes, wealth, information access, incentives; include contrarians " +
      `and low-information actors. Already created: ${JSON.stringify(raw.slice(-10).map(a => a?.archetype))} — ` +
      "do not repeat them. Each: {id, name, archetype (<=5 words), " +
      "traits:{risk,trust,influence,contrarian in 0..1}, prior (probability 0..1 for YES), " +
      `stance ('yes'|'no'|'undecided'), connections: 2-4 agent indices in 0..${n - 1}}. ` +
      "Return {agents:[...]}.", { temperature: 1.0, seed: seed * 10 + start }, usage);
    raw.push(...(Array.isArray(out?.agents) ? out.agents : []).slice(0, k));
  }
  const agents: Agent[] = [];
  raw.slice(0, n).forEach((a: any, i: number) => {
    const prior = clamp(num(a?.prior, 0.5), 0.01, 0.99);
    const traits: Record<string, number> = {};
    for (const [k, v] of Object.entries(a?.traits ?? {})) traits[k] = num(v, 0.5);
    agents.push({ id: String(a?.id ?? `a${i}`), name: String(a?.name ?? `Persona ${i}`), archetype: String(a?.archetype ?? "participant"), traits, prior, belief: prior,
      stance: String(a?.stance ?? "undecided"), connections: (Array.isArray(a?.connections) ? a.connections : []).filter((c: unknown) => Number.isInteger(c) && (c as number) >= 0 && (c as number) < n && c !== i).slice(0, 4), memory: [] });
  });
  const rng = new Rng(seed);
  while (agents.length < n) {  // model returned fewer than asked
    const i = agents.length;
    agents.push({ id: `a${i}`, name: `Persona ${i}`, archetype: "filler", traits: {}, prior: 0.5, belief: 0.5, stance: "undecided", connections: rng.sample([...Array(n).keys()], Math.min(3, n - 1)), memory: [] });
  }
  return agents;
}

function audience(agents: Agent[], kind: Intervention["audience"], rng: Rng): Set<string> {
  if (kind === "all") return new Set(agents.map(a => a.id));
  if (kind === "half") return new Set(rng.sample(agents, Math.floor(agents.length / 2)).map(a => a.id));
  if (kind === "influencers") return new Set([...agents].sort((a, b) => (b.traits.influence ?? 0) - (a.traits.influence ?? 0)).slice(0, Math.max(1, Math.floor(agents.length / 5))).map(a => a.id));
  if (kind === "skeptics") return new Set(agents.filter(a => a.belief < 0.4).map(a => a.id));
  return new Set();
}

export async function runSociety(req: ForecastRequest, routing: Routing, seed: number, usage: Usage): Promise<RunResult> {
  const rng = new Rng(seed);
  const agents = await buildPopulation(req, routing, seed, usage);
  const byId = new Map(agents.map(a => [a.id, a]));
  const traj: number[] = [mean(agents.map(a => a.belief))];
  const notes: string[] = [];
  let tipping: number | null = null;

  for (let r = 1; r <= req.rounds; r++) {
    const shocks = req.interventions.filter(iv => iv.round === r);
    const shockAudience = new Map<string, string[]>();
    for (const iv of shocks) {
      for (const aid of audience(agents, iv.audience, rng)) { const l = shockAudience.get(aid) ?? []; l.push(iv.news); shockAudience.set(aid, l); }
      notes.push(`round ${r}: '${iv.news}' -> ${iv.audience}`);
    }
    // each agent hears the current view of its neighbours (the social graph)
    const order = rng.shuffle([...agents]);
    for (let b = 0; b < order.length; b += BATCH) {
      const batch = order.slice(b, b + BATCH);
      const payload = batch.map(a => {
        const neigh = a.connections.map(c => agents[c]).filter(Boolean);
        return { id: a.id, archetype: a.archetype, traits: a.traits, belief: Math.round(a.belief * 1000) / 1000, recent_memory: a.memory.slice(-3),
          neighbours: neigh.map(n => ({ archetype: n.archetype, belief: Math.round(n.belief * 100) / 100 })), news_heard: shockAudience.get(a.id) ?? [] };
      });
      const out = await chatJson(sysOf(req), `TASK: round ${r}/${req.rounds}\nQuestion: ${req.question}\n${req.context.slice(0, 2500)}\n` +
        `Simulated time step ${r}. For EACH agent below decide how its probability for YES moves ` +
        "after hearing neighbours and any news it personally heard (others did not hear it). " +
        "Respect traits: high 'contrarian' resists consensus, low 'trust' discounts news, high " +
        "'influence' is stubborn. Moves are usually small (|delta| < 0.15) unless news is decisive. " +
        "Return {updates:[{id, belief_delta, message (<=15 words, what it says to peers), talks_to}]}.\n" +
        `Agents: ${JSON.stringify(payload)}`, { temperature: 0.8, seed: seed * 100 + r }, usage);
      for (const u of (Array.isArray(out?.updates) ? out.updates : [])) {
        const a = byId.get(String(u?.id)); if (!a) continue;
        const d = clamp(num(u?.belief_delta, 0), -0.5, 0.5);
        a.belief = clamp(a.belief + d, 0.01, 0.99);
        if (u?.message) a.memory.push(`r${r}: ${u.message}`);
        a.stance = a.belief > 0.55 ? "yes" : a.belief < 0.45 ? "no" : "undecided";
      }
    }
    const m = mean(agents.map(a => a.belief));
    if (tipping === null && (m - 0.5) * (traj[0] - 0.5) < 0) tipping = r;
    traj.push(m);
  }
  const finals = agents.map(a => a.belief);
  // a run's forecast: influence-weighted mean of final beliefs
  const w = agents.map(a => 0.5 + (a.traits.influence ?? 0.5));
  const p = finals.reduce((s, b, i) => s + b * w[i], 0) / w.reduce((a, b) => a + b, 0);
  const flipped = agents.filter(a => (a.prior > 0.5) !== (a.belief > 0.5)).length;
  return { seed, probability: r4(p), belief_trajectory: traj.map(r4), polarization: r4(pstdev(finals)), flipped, tipping_round: tipping, notes };
}

// ---------------------------------------------------------------- expert panel
export async function expertPanel(req: ForecastRequest, routing: Routing, seed: number, usage: Usage): Promise<Record<string, any>[]> {
  const out = await chatJson(sysOf(req), `TASK: panel\nQuestion: ${req.question}\nDomain: ${routing.domain}\n` +
    `${req.context.slice(0, 4500)}\nResolves: ${req.resolves_at ?? "None"}\n` +
    // Architect 30/09 (tail-bias fix): odds-ratio rule for tails.
    "TAIL RULE: when the anchor is below 0.20 or above 0.80, express every adjustment as an odds " +
    "ratio and keep it within x0.5..x2.0 of the anchor's odds (e.g. anchor 0.15 -> stay within " +
    "0.08..0.26) unless a named reason in calendar/positioning/market justifies more. Never add " +
    "'a few points for uncertainty' to a tail — uncertainty is already in the base rate.\n" +
    "Convene 5 superforecasters. Each MUST start from the reference class in MARKET CONTEXT " +
    "(base_rate if present, else market_odds, else an explicit historical frequency they state) and " +
    "then adjust with named evidence (each adjustment <= 15 percentage points, justified). Methods: " +
    "outside view / reference class, inside view, trend & positioning (funding, OI, flows), " +
    "event-driven (calendar), devil's advocate. Never output 0.5 as a default; if evidence is " +
    "genuinely absent, output the base rate. " +
    // Architect 29/09 (§2.2): let the panel move when it has a named reason — up to 25 pp cumulatively.
    "The base rate is your starting point, not your answer. If the calendar, positioning or a listed market give you a named reason, move — up to 25 points cumulatively — and say which. " +
    "Named reasons that justify moving: (a) a scheduled event inside the horizon that appears in upcoming_events, (b) extreme positioning in funding_8h (|rate| > 0.05%) or open interest, (c) market_odds that differ from base_rate by more than 10 points — the market knows something volatility does not. " +
    "Return {experts:[{name, method, anchor, probability, " +
    "reasoning, key_uncertainty}]}.", { temperature: 0.7, seed }, usage);
  return (Array.isArray(out?.experts) ? out.experts : []).slice(0, 7).map((e: any) => ({ ...e, probability: clamp(num(e?.probability, 0.5), 0.01, 0.99) }));
}

// ---------------------------------------------------------------- orchestration
export function ci80(xs: number[]): [number, number] {
  if (xs.length < 2) return [Math.max(0, xs[0] - 0.15), Math.min(1, xs[0] + 0.15)];
  const s = [...xs].sort((a, b) => a - b);
  return [r4(s[Math.floor(0.10 * (s.length - 1))]), r4(s[Math.ceil(0.90 * (s.length - 1))])];
}

/** grounding: "on" (0.3.5-ts — everything outside the board), "shadow" (election board rows until 28/10: premises recorded, not
 *  injected), "off" (board, 0.3.3-ts frozen). refuseUnverified: human surfaces (the /app) never publish an unverifiable number. */
export type GroundingMode = "on" | "shadow" | "off";
export async function forecast(req0: ForecastRequest, opts: { baseSeed?: number; provider?: DataProvider | null; id?: string; configCapped?: boolean; grounding?: GroundingMode; refuseUnverified?: boolean; fetch?: Fetcher; pregrounded?: Grounding | null } = {}): Promise<Forecast> {
  const baseSeed = opts.baseSeed ?? 42;
  const usage = newUsage();
  const mode: GroundingMode = opts.grounding ?? "off";
  const now = new Date();
  // v0.3.5: FACT BASE FIRST — what must be true today for the question to be well-posed? Verified live, never from memory.
  let grd: Grounding | null = null;
  if (mode !== "off") {
    grd = opts.pregrounded ?? await ground(req0.question, { now, resolvesAt: req0.resolves_at ? new Date(req0.resolves_at) : null, fetch: opts.fetch, usage });
    if (mode === "on" && (opts.refuseUnverified || req0.require_verified) && grd.status === "unverified") throw new UnverifiedPremise(grd);
  }
  const on = mode === "on" && grd != null;
  // v0.3: never simulate blind — assemble market context first and inject it everywhere
  const mctx: MarketContext = await buildContext(req0.question, opts.provider ?? null, new Date(), on ? req0.resolves_at ?? null : null);  // resolves_at as horizon fallback only on 0.3.5-ts (board unchanged)
  if (on && grd!.actuarial_base_rate != null && mctx.base_rate == null) { mctx.base_rate = grd!.actuarial_base_rate; mctx.base_rate_note = grd!.actuarial_note; }
  const factBlock = on && grd!.status !== "none_needed" ? groundingToPrompt(grd!, now) + "\n" : "";
  const callerCtx = req0.context;
  const req: ForecastRequest = { ...req0, question: on ? (grd!.corrected_question ?? req0.question) : req0.question,
    context: factBlock + contextToPrompt(mctx) + (callerCtx ? "\nCALLER CONTEXT: " + callerCtx : "") };
  if (on) GROUNDED.add(req);
  let routing = await route(req, usage);
  if (routing.method === "social_sim") routing = { ...routing, method: "hybrid" };  // panel is always on since v0.3
  const runs: RunResult[] = [];
  let panel: Record<string, any>[] = [];
  if (routing.method === "social_sim" || routing.method === "hybrid") for (let k = 0; k < req.runs; k++) runs.push(await runSociety(req, routing, baseSeed + k, usage));
  if (routing.method === "expert_panel" || routing.method === "hybrid") panel = await expertPanel(req, routing, baseSeed, usage);

  const samples = [...runs.map(r => r.probability), ...panel.map(e => e.probability as number)];
  // tail-bias fix (Architect 30/09): average in LOG-ODDS, not in probability — the arithmetic mean of [0.02, 0.03, 0.15]
  // is 0.067, the log-odds mean ≈ 0.046. Disagreement stays in probability units for readability.
  const pNaive = samples.length ? logitMean(samples) : 0.5;
  const disagreement = samples.length > 1 ? pstdev(samples) : 0.3;

  const agg = await chatJson(sysOf(req), "TASK: aggregate\n" +
    `Question: ${req.question}\nRouting: ${JSON.stringify(routing)}\n${factBlock}${contextToPrompt(mctx)}\n` +
    `Run probabilities: ${runs.map(r => `p=${r.probability}`).join(" ")}\n` +
    `Trajectories: ${JSON.stringify(runs.slice(0, 12).map(r => r.belief_trajectory))}\n` +
    `Tipping rounds: ${JSON.stringify(runs.map(r => r.tipping_round))}\nFlips: ${JSON.stringify(runs.map(r => r.flipped))}\n` +
    `Panel: ${JSON.stringify(panel).slice(0, 3000)}\n` +
    `Naive mean=${pNaive.toFixed(3)}, spread=${disagreement.toFixed(3)}.\n` +
    // Architect 29/09 (§2.3): when a listed market matched, it is the primary anchor and base_rate the secondary.
    (mctx.market_odds != null
      ? "Produce the final calibrated probability for YES. Calibration rule: this question matches a listed market — anchor on market_odds first and base_rate second, then move with the simulation and panel evidence. " + "For tails (anchor < 0.20 or > 0.80) reason in odds ratios, not percentage points, and treat the log-odds mean of runs/panel (Naive mean above) as the centre — do not drift upward just because some societies are optimistic. " + "0.5 is NOT a default and must never be used as a fallback. If your number differs from market_odds by more than 10 points, name the specific evidence that justifies the edge. "
      : "Produce the final calibrated probability for YES. Calibration rule: anchor on base_rate, then move with the simulation and panel evidence. " + "For tails (anchor < 0.20 or > 0.80) reason in odds ratios, not percentage points, and treat the log-odds mean of runs/panel (Naive mean above) as the centre — do not drift upward just because some societies are optimistic. " + "0.5 is NOT a default and must never be used as a fallback. If your number differs from base_rate by more than 10 points, name the specific evidence that justifies the move. ") +
    "Societies that diverge from the panel are information: keep that divergence visible in drivers, do not smooth it away. " +
    "Also give a 2-sentence summary, top drivers, failure_modes (how the YES/NO world breaks), " +
    "confidence in [low, medium, high] (low only when sources_unavailable is long or spread > 0.15). " +
    "Return {probability, summary, drivers, failure_modes, confidence}.", { strong: true, seed: baseSeed }, usage);
  const p = clamp(num(agg?.probability, pNaive), 0.01, 0.99);
  let conf = String(agg?.confidence ?? "medium");
  if (routing.method === "expert_panel" && !routing.human_driven) conf = "low";  // honesty: no data-backed model behind it
  if (on && (grd!.status === "unverified" || grd!.status === "partial" || grd!.premises.some(x => x.verified === false))) conf = "low";  // any premise left unverified → low (Construtor 01/10, Atlântida case)  // a premise the answer depends on could not be verified live
  if (!["low", "medium", "high"].includes(conf)) conf = "medium";

  const fid = opts.id ?? randomUUID().replace(/-/g, "").slice(0, 12);
  const created = new Date().toISOString();
  const h = createHash("sha256").update(`${fid}|${req0.question}|${p.toFixed(4)}|${created}`).digest("hex");
  const edge = mctx.market_odds != null ? r4(p - mctx.market_odds) : null;
  const edgeVsBase = mctx.base_rate != null ? r4(p - mctx.base_rate) : null;
  return {
    id: fid, question: req0.question, created_at: created, resolves_at: req0.resolves_at ?? null, routing,
    probability: r4(p), ci80: ci80(samples.length ? samples : [p]), disagreement: r4(disagreement), runs, panel,
    summary: String(agg?.summary ?? ""), drivers: (Array.isArray(agg?.drivers) ? agg.drivers : []).slice(0, 6).map(String),
    failure_modes: (Array.isArray(agg?.failure_modes) ? agg.failure_modes : []).slice(0, 6).map(String), confidence: conf as Forecast["confidence"],
    cost: { ...usage }, commitment_hash: h, market_odds: mctx.market_odds, market_ref: mctx.market_ref, edge, base_rate: mctx.base_rate, edge_vs_base: edgeVsBase,
    config: { runs: req0.runs, population: req0.population, rounds: req0.rounds, capped: Boolean(opts.configCapped) },
    context_used: JSON.parse(JSON.stringify(mctx)), engine_version: on ? ENGINE_VERSION_GROUNDED : ENGINE_VERSION, disclaimer: DISCLAIMER,
    ...(on ? { grounding: grd!.status, premises: JSON.parse(JSON.stringify(grd!.premises)), premise_corrected: grd!.corrected_question, warnings: grd!.warnings } : {}),
    ...(mode === "shadow" && grd ? { grounding_shadow: JSON.parse(JSON.stringify(grd)) } : {}),
  };
}
