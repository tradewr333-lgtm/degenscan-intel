# Integration listing request: langchain-degenscan

**Package:** `langchain-degenscan` (PyPI) — https://pypi.org/project/langchain-degenscan/
**Component type:** tools / toolkit
**Provider:** Degenscan Intel — https://intel.degenscan.io (operator Marbella Collins LLC; service is MIT and open source: https://github.com/tradewr333-lgtm/degenscan-intel)
**Source:** https://github.com/tradewr333-lgtm/degenscan-intel/tree/main/packages/langchain-py

**What it does:** `DegenscanIntelToolkit().get_tools()` exposes 8 tools that give an agent cross-asset market-event intelligence from ~40 primary sources (SEC EDGAR filings, Federal Reserve and other central banks, Federal Register, FTC/DOJ/FDA/CFTC, USGS earthquakes, NOAA storms, Nasdaq halts, DeFi hacks, Polymarket odds, Hyperliquid perp funding/OI), normalized into one event schema and scored into per-asset impacts (direction, confidence, exposure path). Tools: market pulse, market events, asset brief, perp derivatives, news, SEC filings, macro calendar, Polymarket context.

**Auth:** none required for the free trial (100 calls/day/IP); `api_key` for prepaid/Stripe; `private_key` to pay per call in USDC via x402 (agent-native, no card).

**Docs:** https://intel.degenscan.io/docs · README in the package. Information and analytics only — not investment advice.
