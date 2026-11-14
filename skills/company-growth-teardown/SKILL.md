---
name: company-growth-teardown
description: "Reverse-engineer how a company grew from primary public signals — the months where attention jumped (Wikipedia pageviews, Hacker News mentions) lined up with the Show HN / Launch HN posts, top stories, GitHub repos, news and the site's first Wayback capture around them. Use when the user asks \"how did Lovable/Cursor/X get its users\", \"what launch made this company take off\" or wants a competitor's growth timeline before planning their own launch. One call, about $0.01. 100 free calls/day with no key; then USDC per call via x402."
---

# Company growth teardown

Read-only REST call to `https://intel.degenscan.io`. One HTTPS GET returns JSON.

## The call

| Question | Call | Price |
|---|---|---|
| How a company grew: attention jumps and what happened around them | `GET /v1/company/growth?company=Lovable&domain=lovable.dev&github=lovable-dev` | $0.01 |

- `company` is required.
- `domain` adds the first Wayback capture of the site.
- `github` sets the org. If you leave it out, the API guesses it from the domain.
- `wikipedia` sets the exact article title when the company name is ambiguous.
- `months` sets the window, from 6 to 36 (default 24).

## Example

```bash
curl -H "X-Free-Trial: 1" "https://intel.degenscan.io/v1/company/growth?company=Lovable&domain=lovable.dev"
```

## How to turn it into a playbook

1. Start with `attention_jumps[]`. Each item is a month where Wikipedia views or Hacker News story mentions jumped. It carries `events_that_month_or_before`: the launches (`launch_hn`, `show_hn`), top HN stories, repos and news from that month and the month before. These are the candidate moves that worked.
2. Read `timeline[]` in date order to see what came before the first jump, such as an open-source repo, an HN launch or a press wave.
3. For each candidate move, check the linked page yourself before you call it the cause. A jump next to an event is a correlation, not proof.
4. Write the plays for the user: what the company did, when, the evidence (with links), and how the user could adapt it.

## Rules for the agent

- Check `wikipedia.article` and `github.handle`. If either points to a different company, call again with `wikipedia=` or `github=`.
- Report `sources_status` when a source failed.
- This tool has no ad-library, traffic or backlink data. Say so instead of guessing. The user can open the public Meta Ad Library and the Google Ads Transparency Center for ads.
- Quote dates and links. Do not invent numbers that the response does not contain.
- Operator: Degenscan Intel (Marbella Collins LLC) · contact@degenscan.io. Not affiliated with the companies analysed or with the data sources.

## Access and payment

- **Free trial, no signup:** send the header `X-Free-Trial: 1` (100 calls per day per IP).
- **Then pay per call in USDC** with any x402 client (Base `eip155:8453` or Solana). An unpaid call returns HTTP 402 with the price.
- **Or use a prepaid key:** `POST https://intel.degenscan.io/v1/keys/x402/balance_5`, then send the header `X-API-KEY`.
- **MCP:** `https://intel.degenscan.io/mcp`.
- **Docs:** `https://intel.degenscan.io/llms.txt`.
