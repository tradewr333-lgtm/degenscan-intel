# Getting started with Degenscan Intel (no key required)

1. Probe for free: `curl -H 'X-Free-Trial: 1' https://intel.degenscan.io/v1/pulse` (100 calls/day/IP).
2. Map your tickers once: `GET /v1/universe` (free).
3. Loop: `pulse` ($0.001) → `events?since=4h&universe=BTC,ETH,NVDA` ($0.005) → `brief/{asset}` ($0.10) before sizing → `derivs/{coin}` ($0.003) for perps.
4. Pay without a human: any x402 client (`@x402/fetch`, `x402-axios`, AgentKit) settles USDC on Base or Solana; or `POST /v1/keys/x402/pack_1k` ($5 USDC → 1,000 calls) and send `X-API-KEY`.
5. SDKs: `npm i @degenscan/intel` · `pip install degenscan-intel` · MCP: `https://intel.degenscan.io/mcp` · Docs: `https://intel.degenscan.io/docs`.

Information and analytics only — not investment advice. Operator: Marbella Collins LLC (MIT).
