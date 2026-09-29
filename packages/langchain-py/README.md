# langchain-degenscan

LangChain / LangGraph tools for [Degenscan Intel](https://intel.degenscan.io) — cross-asset market-event intelligence for trading agents: SEC filings, Fed/central-bank releases, regulator actions, earthquakes and storms, Nasdaq halts, DeFi hacks, Polymarket odds, Hyperliquid perp microstructure — normalized into one event schema and scored into per-asset impacts. Paid per call in USDC (x402) or with an API key; free trial 100 calls/day/IP.

```bash
pip install langchain-degenscan            # free trial / API key
pip install "langchain-degenscan[x402]"    # + per-call USDC payments from an agent wallet
```

```python
from langchain_degenscan import DegenscanIntelToolkit
from langchain.agents import create_agent   # or langgraph.prebuilt.create_react_agent

tools = DegenscanIntelToolkit(api_key=os.environ["INTEL_API_KEY"]).get_tools()
# tools = DegenscanIntelToolkit(private_key=os.environ["AGENT_WALLET_PK"]).get_tools()   # pays USDC on Base per call
# tools = DegenscanIntelToolkit().get_tools()                                              # free trial

agent = create_agent("openai:gpt-5", tools, system_prompt="You are a market-event analyst. Check degenscan_market_pulse first; use degenscan_asset_brief before any sizing decision. Information only, not advice.")
agent.invoke({"messages": [{"role": "user", "content": "What moved NVDA and BTC in the last 4 hours, and is funding crowded on BTC?"}]})
```

Tools: `degenscan_market_pulse` ($0.001) · `degenscan_market_events` ($0.005) · `degenscan_asset_brief` ($0.10) · `degenscan_perp_derivs` ($0.003) · `degenscan_news` · `degenscan_filings` · `degenscan_calendar` ($0.002 each) · `degenscan_polymarket` ($0.01). Use `include=[...]` to expose a subset.

Docs: https://intel.degenscan.io/docs · OpenAPI: https://intel.degenscan.io/openapi.json · Python SDK: `pip install degenscan-intel` · MCP: `https://intel.degenscan.io/mcp`.

Information and analytics only — not investment advice. Operator: Marbella Collins LLC. MIT.
