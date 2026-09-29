# How the Degenscan Intel Oracle produces a probability

*Methodology page for `/docs/oracle-methodology`. Information and analytics only — not investment advice.*

## What you get

Ask a binary question about a market outcome ("Will BTC close above 100,000 USD on 2026-10-31?") and the oracle returns a **calibrated probability of YES** together with everything you need to decide whether to trust it: an 80 % interval, how much the simulated futures disagree, the reference-class **base rate**, the matching prediction-market price and the oracle's **edge** against it, the drivers, the ways the YES and NO worlds break, and a **commitment hash** written before the event resolves. Every forecast is scored publicly once the question resolves.

## Step 1 — Ground the question in live data

The oracle never reasons blind. Before anything else it assembles a *market context* from Intel's own feeds: spot price, 30-day realized volatility, perp funding and open interest, the calendar of scheduled events in the horizon (FOMC, CPI, NFP…), recent primary-source events that touch the asset, and — when a Polymarket market asks the same question — its current YES price. The context is returned in the response (`context_used`) so you can audit exactly which numbers the forecast saw. Sources that failed are listed in `sources_unavailable`; they are never silently invented.

## Step 2 — Compute the base rate

For price-threshold questions the oracle computes what the asset's **own volatility** implies with zero directional view: the probability that a driftless lognormal walk ends above (or, for "touches at any point", ever crosses) the target within the horizon. This is the *reference class*, not a forecast. It is reported as `base_rate` with the z-distance in sigmas, so you can see immediately whether a question is a coin flip (z ≈ 0), a stretch (z ≈ 1.5) or a tail (z ≥ 3). For questions that map to a listed market, the market price plays the same anchoring role.

## Step 3 — Simulate societies

The oracle then builds several independent **societies of LLM agents** (default 6 societies × 20 agents). Each agent has an archetype, wealth, information access, incentives and traits (risk appetite, trust, influence, contrarianism) and a prior anchored on the context. Each society is built through a different *lens* (retail-heavy, institution-heavy, macro-first, derivatives-first, contrarian-dense…) so that societies disagree for structural reasons, not by chance. Over three simulated time steps agents hear their neighbours, react to scheduled or injected news, and update. We record each society's belief trajectory, whether it crossed 50 % (a *tipping point*), how many agents flipped, and the final polarization. A society's forecast is the influence-weighted mean of its agents' final beliefs.

This is the layer that captures what volatility alone cannot: narrative contagion, positioning, who convinces whom, and how confidence turns into doubt.

## Step 4 — Convene the panel

In parallel, five simulated **superforecasters** — outside view, inside view, positioning/trend, event-driven, devil's advocate — each start from the base rate (or market price) and adjust with named evidence, capped at 15 percentage points per adjustment. They are forbidden from outputting 0.5 as a default: if evidence is genuinely absent, the honest answer is the base rate.

## Step 5 — Aggregate and calibrate

A stronger reasoning model receives the base rate, the market price, every society's trajectory and every panelist's number and produces the final probability under one rule: **anchor on the reference class, move with the evidence, and if you differ from the market by more than ten points, name the evidence that justifies the edge.** It also writes the two-sentence summary, the drivers, the failure modes, and a confidence grade (`low` only when data sources were missing or the societies disagree strongly).

The 80 % interval is the spread of society and panel forecasts; `disagreement` is their standard deviation. A wide interval is information, not a defect — it tells you the future is contested.

## Step 6 — Commit, then score

Each forecast is stored with a SHA-256 commitment over its id, question, probability and timestamp, and cannot be altered afterwards. When the question resolves (automatically for price targets and Polymarket markets, by an operator otherwise), the oracle records the outcome and its **Brier score** (0 = perfect, 0.25 = coin flip, ~0.10 = superforecaster level), and, where a market existed, the market's own Brier for the same question. `/v1/oracle/track-record` publishes these for every resolved forecast, overall, by domain, by engine version, and as **beat-the-market rate**. Forecasts made by earlier engine versions are labelled and never mixed into the current version's numbers.

## How to read a forecast

- `probability` close to `base_rate`: the oracle found no reason to disagree with what volatility already implies. That is a legitimate answer; do not pay for edge that is not there.
- `edge` large and `confidence` medium/high: the societies or the panel found named evidence the market has not priced. Read `drivers` before acting.
- `disagreement` high: futures are contested; treat the probability as a center of mass, not a point.
- `sources_unavailable` non-empty: the number was produced with less grounding than usual.

## What the oracle is not

It is not a price prediction, not a trading signal, and not a substitute for your own risk management. It is a calibrated opinion with a public scorecard. Judge it by the scorecard.
