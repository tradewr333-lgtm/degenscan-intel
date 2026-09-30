/** zod schemas for the 2Realidade oracle inside Intel — 1:1 port of realidade2/models.py. */
import { z } from "zod";

export const Method = z.enum(["social_sim", "expert_panel", "hybrid"]);
export type Method = z.infer<typeof Method>;

export const Intervention = z.object({
  round: z.number().int().min(1).describe("Round at which the shock lands."),
  news: z.string().describe("What happens, e.g. 'SEC sues the largest exchange'."),
  audience: z.enum(["all", "half", "influencers", "skeptics"]).default("all"),
});
export type Intervention = z.infer<typeof Intervention>;

export const ForecastRequest = z.object({
  question: z.string().min(8).max(500).describe("Binary question, e.g. 'Will BTC close above 120k on 2026-10-31?'"),
  resolves_at: z.string().datetime({ offset: true }).optional().describe("When the question resolves (ISO 8601)."),
  context: z.string().max(4000).default("").describe("Extra facts, news, market data the caller already has."),
  population: z.number().int().min(4).max(48).default(24).describe("Agents in each simulated society."),
  rounds: z.number().int().min(1).max(6).default(3).describe("Interaction rounds per run (simulated time steps)."),
  runs: z.number().int().min(1).max(12).default(8).describe("Monte Carlo runs (independent societies)."),
  require_verified: z.boolean().optional().describe("Refuse (HTTP 422, no charge) instead of publishing when a premise the answer depends on cannot be verified live. Human-facing surfaces set this true."),
  interventions: z.array(Intervention).max(6).default([]),
  method: Method.optional().describe("Force a method; default = router decides."),
});
export type ForecastRequest = z.infer<typeof ForecastRequest>;

export interface Agent {
  id: string; name: string; archetype: string;
  traits: Record<string, number>;
  prior: number; belief: number; stance: string;
  connections: number[]; memory: string[];
}

export interface RunResult {
  seed: number; probability: number;
  belief_trajectory: number[];   // mean belief per round
  polarization: number;          // std-dev of final beliefs
  flipped: number;               // agents whose final stance != prior stance
  tipping_round: number | null;  // first round where mean belief crossed 0.5
  notes: string[];
}

export interface Routing { domain: string; method: Method; human_driven: boolean; binary: boolean; rationale: string }

export interface Forecast {
  id: string; question: string; created_at: string; resolves_at: string | null;
  routing: Routing;
  probability: number; ci80: [number, number];
  disagreement: number;          // std-dev across runs; how much simulated futures disagree
  runs: RunResult[]; panel: Record<string, any>[];
  summary: string; drivers: string[]; failure_modes: string[];
  confidence: "low" | "medium" | "high";
  cost: Record<string, number>;
  commitment_hash: string;       // sha256 of (id, question, probability, created_at): tamper-evident record
  market_odds: number | null; market_ref: string | null;
  edge: number | null;           // probability - market_odds: what the caller pays for. null = no listed market
  base_rate: number | null;      // reference-class probability implied by volatility/history, zero directional view
  edge_vs_base: number | null;   // probability - base_rate: what the societies/panel added beyond the lognormal formula
  config: { runs: number; population: number; rounds: number; capped: boolean }; // capped = free-trial reduced config
  context_used: Record<string, any>;
  engine_version: string;
  grounding?: "verified" | "partial" | "unverified" | "contradicted" | "none_needed"; premises?: Record<string, any>[]; premise_corrected?: string | null; warnings?: string[];
  grounding_shadow?: Record<string, any>;  // election board rows until 28/10: premises recorded, not injected
  outcome?: boolean | null; brier?: number | null; market_brier?: number | null; resolved_at?: string | null; resolution_note?: string | null; // e.g. "spot fallback" when the official candle was unavailable
  disclaimer: string;
}

export const DISCLAIMER = "Information and analytics only — not investment advice. Probabilities are model outputs with a public Brier track record at /v1/oracle/track-record.";
export const ENGINE_VERSION = "0.3.3-ts";
/** Forecasts with the live fact-base (grounding) injected — everything outside the daily board (Architect no.6). */
export const ENGINE_VERSION_GROUNDED = "0.3.5-ts";
