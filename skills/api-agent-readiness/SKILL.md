---
name: api-agent-readiness
description: Audit how ready a public API is for AI agents — checks OpenAPI, route descriptions, llms.txt, /.well-known/x402, visible prices, A2A agent card, MCP endpoint and robots.txt, and returns a 0–100 score, a grade and the fixes to make. Use when the user asks "is my API agent-ready", "how do agents discover my API", "audit my API for x402 / MCP / llms.txt", or before publishing an API to agent marketplaces. 100 free calls/day with no key; then USDC per call via x402.
---

# API agent-readiness audit

One read-only REST call to `https://intel.degenscan.io`. The audit fetches only public, well-known paths of the target site over HTTPS (port 443, short timeouts, private networks blocked).

## Call

| Question | Call | Price |
|---|---|---|
| Score and fixes for one API | `GET /v1/agent/readiness?url=https://api.example.com` | $0.005 |
| Compare an API with a competitor, check by check | `GET /v1/agent/readiness?url=https://api.example.com&peer=https://competitor.example` | $0.005 |

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/agent/readiness?url=https://api.example.com"
```

Read `score` (0–100), `grade`, `checks[]` (what was found, with points) and `fixes[]` (ordered by points gained). Weights: OpenAPI 25, x402 20, llms.txt 15, visible prices 15, A2A card 10, route descriptions 5, MCP 5, robots 5.

With `peer=`, `comparison.behind_on[]` lists the checks where the competitor scores higher and `comparison.fix_first[]` the fixes that close that gap, largest first.

When helping the user fix their API, work through `fixes[]` in order and re-run the audit after each change.

## Access and payment

- **Free trial, no signup:** send the header `X-Free-Trial: 1` (100 calls per day per IP).
- **Then pay per call in USDC** with any x402 client (Base `eip155:8453` or Solana). An unpaid call returns HTTP 402 with the price and payment details.
- **Or use a prepaid key:** `POST https://intel.degenscan.io/v1/keys/x402/balance_5` (5 USDC → $6 of calls), then send the header `X-API-KEY`.
- **MCP:** `https://intel.degenscan.io/mcp` (compact mode: `?mode=compact`, two tools, `search` and `execute`).
- **Docs:** `https://intel.degenscan.io/llms.txt` · OpenAPI at `https://intel.degenscan.io/openapi.json`.
- **Several routes in one request:** `POST https://intel.degenscan.io/v1/batch` with `{"calls":[{"path":"/v1/..."}]}`, priced at the sum.

## Rules for the agent

- Quote the `as_of` time and the source named in the response.
- The audit is a technical check, not a security assessment.
- Operator: Degenscan Intel (Marbella Collins LLC) · contact@degenscan.io.
