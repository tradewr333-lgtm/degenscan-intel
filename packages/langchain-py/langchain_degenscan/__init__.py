"""langchain-degenscan — LangChain tools for Degenscan Intel (https://intel.degenscan.io).

    from langchain_degenscan import DegenscanIntelToolkit
    tools = DegenscanIntelToolkit(api_key=...).get_tools()     # or private_key=... (x402, USDC on Base) or nothing (free trial)

Tools: degenscan_market_pulse, degenscan_market_events, degenscan_asset_brief, degenscan_perp_derivs,
degenscan_news, degenscan_filings, degenscan_calendar, degenscan_polymarket.
Information and analytics only — not investment advice. Operator: Marbella Collins LLC.
"""
from __future__ import annotations

import json
from typing import Any, Optional, Type

from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field, PrivateAttr

from degenscan_intel import AsyncIntel, Intel

__all__ = ["DegenscanIntelToolkit", "DegenscanIntelTool", "__version__"]
__version__ = "0.1.0"


class _PulseInput(BaseModel):
    """No inputs."""


class _EventsInput(BaseModel):
    since: str = Field("4h", description='Lookback window: "1h", "4h", "24h" or ISO timestamp')
    universe: Optional[list[str]] = Field(None, description="Asset ids to filter, e.g. ['BTC','ETH','NVDA','CL']")
    min_confidence: float = Field(0.4, ge=0, le=1)
    limit: int = Field(30, ge=1, le=200)


class _AssetInput(BaseModel):
    asset_id: str = Field(..., description="Asset id, e.g. BTC, ETH, NVDA, MSTR, CL, GC")
    since: str = Field("24h")


class _SymbolInput(BaseModel):
    symbol: str = Field(..., description="Perp coin on Hyperliquid, e.g. BTC, ETH, SOL, HYPE")


class _TickerInput(BaseModel):
    ticker: str = Field(..., description="Asset id / ticker, e.g. NVDA, COIN, BTC")
    since: str = Field("24h")
    limit: int = Field(25, ge=1, le=100)


class _CalendarInput(BaseModel):
    days: int = Field(7, ge=1, le=90)
    types: Optional[list[str]] = Field(None, description="macro, fomc, earnings, auction")


class _MarketInput(BaseModel):
    market: str = Field(..., description="Polymarket market id, slug or question text")
    since: str = Field("48h")


class _OracleInput(BaseModel):
    question: str = Field(..., description="Binary question, e.g. 'Will Bitcoin close above 120,000 USD on 2026-10-31?'")
    resolves_at: Optional[str] = Field(None, description="ISO-8601 resolution time")


class _OracleGetInput(BaseModel):
    forecast_id: str = Field(..., description="forecast_id returned by degenscan_oracle_forecast")


class _BoardInput(BaseModel):
    slug: Optional[str] = Field(None, description="Optional board slug, e.g. btc-120k-oct31; omit for the whole board")


_SPECS: list[tuple[str, str, Type[BaseModel], str]] = [
    ("degenscan_oracle_forecast", "Calibrated YES-probability for a binary market question (Monte Carlo of LLM agent societies + base-rate-anchored expert panel on live data). ASYNC: returns {forecast_id, eta_s}; then call degenscan_oracle_get every ~20 s until status is done. $0.25/call.", _OracleInput, "oracle_forecast"),
    ("degenscan_oracle_get", "Fetch/poll an oracle forecast by forecast_id (free). When done: probability, ci80, base_rate, market_odds, edge, drivers, failure_modes, commitment_hash.", _OracleGetInput, "oracle_get"),
    ("degenscan_oracle_board", "Daily board of standing calibrated forecasts (BTC/ETH/SOL targets, FOMC, top Polymarket): probability, interval, base rate, edge — no waiting. $0.002/call.", _BoardInput, "oracle_board"),
    ("degenscan_market_pulse", "Cheapest probe ($0.001) of what happened in markets in the last hour: event counts by class, high-severity count, venues open. Call first, on a timer.", _PulseInput, "pulse"),
    ("degenscan_market_events", "Price-moving events since a window from ~40 primary sources (SEC filings, Fed/central banks, regulators, earthquakes, storms, Nasdaq halts, DeFi hacks, Polymarket), each with per-asset impacts: direction (-1/0/1), confidence (0..1), exposure path, tradable_now/next_open. $0.005/call.", _EventsInput, "events_since"),
    ("degenscan_asset_brief", "One-call pre-trade brief for one asset: net event pressure and drivers, headlines with sentiment, SEC filings, exposure map, related Polymarket markets, upcoming catalysts (FOMC, CPI, earnings), perp funding/OI flags (crypto), venue open now. $0.10/call.", _AssetInput, "brief"),
    ("degenscan_perp_derivs", "Hyperliquid perp microstructure for one coin (no key): funding 1h/8h/annualized, predicted funding by venue (Hyperliquid, Binance, Bybit), open interest, premium vs oracle, 24h volume, flags (funding_hot_long/short, premium_rich, oi_heavy_vs_volume) + event pressure. $0.003/call.", _SymbolInput, "derivs_for"),
    ("degenscan_news", "Headlines touching one asset with source tier, corroboration count and heuristic sentiment (-1..1). $0.002/call.", _TickerInput, "news_for"),
    ("degenscan_filings", "SEC EDGAR filings on one issuer: 8-K, Form 4 insider trades, 13D/G activist stakes, S-1 offerings, with impact direction and link. $0.002/call.", _TickerInput, "filings_for"),
    ("degenscan_calendar", "Upcoming scheduled catalysts: FOMC, CPI, NFP, PCE, GDP, Treasury auctions, earnings, with affected assets. $0.002/call.", _CalendarInput, "calendar"),
    ("degenscan_polymarket", "Polymarket market (id, slug or question) → current odds + the primary-source events in the last 48h that bear on it. $0.01/call.", _MarketInput, "polymarket"),
]


class DegenscanIntelTool(BaseTool):
    """One Degenscan Intel endpoint as a LangChain tool."""

    name: str
    description: str
    args_schema: Type[BaseModel]
    method: str
    _sync: Intel = PrivateAttr()
    _async: AsyncIntel = PrivateAttr()

    def __init__(self, sync_client: Intel, async_client: AsyncIntel, **data: Any):
        super().__init__(**data)
        self._sync = sync_client
        self._async = async_client

    def _run(self, **kwargs: Any) -> str:
        return json.dumps(getattr(self._sync, self.method)(**kwargs))

    async def _arun(self, **kwargs: Any) -> str:
        return json.dumps(await getattr(self._async, self.method)(**kwargs))


class DegenscanIntelToolkit:
    """Builds the Degenscan Intel tools.

    Args mirror ``degenscan_intel.Intel``: ``private_key`` (USDC on Base, pays per call via x402),
    ``api_key`` (prepaid USDC pack or Stripe plan), or neither for the free trial (100 calls/day/IP).
    """

    def __init__(self, *, private_key: Optional[str] = None, api_key: Optional[str] = None, base_url: Optional[str] = None,
                 include: Optional[list[str]] = None):
        kw: dict[str, Any] = {"private_key": private_key, "api_key": api_key}
        if base_url:
            kw["base_url"] = base_url
        self._sync = Intel(**kw)
        self._async = AsyncIntel(**kw)
        self.include = set(include) if include else None

    def get_tools(self) -> list[BaseTool]:
        return [DegenscanIntelTool(self._sync, self._async, name=n, description=d, args_schema=s, method=m)
                for n, d, s, m in _SPECS if not self.include or n in self.include]
