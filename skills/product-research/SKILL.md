---
name: product-research
description: Product research from official U.S. sources — CPSC product recalls by keyword (units, hazard, injuries, country of manufacture, importer, sold on Amazon), U.S. import trends by HS code from the Census Bureau (monthly value, unit value, top origin countries, 12-month change), topic demand from Wikipedia pageviews, and a one-call product brief. Use when the user researches a product to sell (Amazon FBA, e-commerce, importing), asks "has this product been recalled", "how much of X does the U.S. import and from where", or "is interest in X rising". 100 free calls/day with no key; then USDC per call via x402.
---

# Product research (official sources)

Read-only REST calls to `https://intel.degenscan.io`. Data comes only from public-domain government sources and Wikimedia, never from marketplace scraping.

## Pick the call

| Question | Call | Price |
|---|---|---|
| Recalls for a product keyword | `GET /v1/products/recalls?q=air fryer&since=2023-01-01` | $0.002 |
| U.S. imports of an HS code | `GET /v1/products/imports?hs=9503` (2, 4, 6 or 10 digits) | $0.003 |
| Interest trend for topics (Wikipedia pageviews) | `GET /v1/topics/demand?topics=Air fryer,Pickleball` | $0.002 |
| All of the above in one call | `GET /v1/products/brief?q=air fryer&hs=851660` | $0.006 |

If you do not know the HS code, ask the user or look it up in the U.S. HTS (hts.usitc.gov) before calling `/imports`.

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/products/brief?q=air%20fryer&hs=851660"
```

Use the numbers as inputs to the user's decision. Do not tell the user a product is safe or profitable; say what the recalls and imports show.

## Access and payment

- **Free trial, no signup:** send the header `X-Free-Trial: 1` (100 calls per day per IP).
- **Then pay per call in USDC** with any x402 client (Base `eip155:8453` or Solana). An unpaid call returns HTTP 402 with the price and payment details.
- **Or use a prepaid key:** `POST https://intel.degenscan.io/v1/keys/x402/balance_5` (5 USDC → $6 of calls), then send the header `X-API-KEY`.
- **MCP:** `https://intel.degenscan.io/mcp` (compact mode: `?mode=compact`, two tools, `search` and `execute`).
- **Docs:** `https://intel.degenscan.io/llms.txt` · OpenAPI at `https://intel.degenscan.io/openapi.json`.
- **Several routes in one request:** `POST https://intel.degenscan.io/v1/batch` with `{"calls":[{"path":"/v1/..."}]}`, priced at the sum.

## Rules for the agent

- Quote the `as_of` time and the source named in the response.
- Never present the data as advice. Responses carry the line "Information and analytics only — not business, legal or investment advice"; keep it when you report the numbers.
- Operator: Degenscan Intel (Marbella Collins LLC) · contact@degenscan.io.
