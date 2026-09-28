# Event-driven trading agent (example)

A minimal autonomous agent that watches **primary-source market events** — SEC filings, Fed/ECB releases, regulator actions, earthquakes and storms, Nasdaq halts, DeFi hacks, Polymarket repricing — and turns them into trading signals, paying for data **per call in USDC** (x402) with no account or card.

```bash
git clone https://github.com/tradewr333-lgtm/degenscan-intel && cd degenscan-intel/examples/trading-agent
npm i && cp .env.example .env     # put an agent wallet key (a few USDC on Base) — or leave empty for the free trial
npm run once                      # one pass
npm start                         # hourly loop
```

What it does each hour: `pulse` ($0.001) → if anything high-severity, `events_since` on your book ($0.005) → for each impact ≥ MIN_CONFIDENCE, `brief` ($0.10) → for perps, `derivs_for` ($0.003) to avoid crowded funding → `execute(signal)`, which **you** implement against your venue. Typical cost: a few cents per hour.

Data: [Degenscan Intel](https://intel.degenscan.io) · SDK: `npm i @degenscan/intel` · Python: `pip install degenscan-intel` · MCP: `https://intel.degenscan.io/mcp`.

Information and analytics only — not investment advice. Operator: Marbella Collins LLC. MIT.
