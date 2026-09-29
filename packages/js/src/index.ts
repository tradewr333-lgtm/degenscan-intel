/**
 * @degenscan/intel — client for Degenscan Intel (https://intel.degenscan.io)
 *
 * Cross-asset market-event intelligence for AI trading agents: ~40 primary sources
 * (SEC EDGAR, Federal Reserve, Federal Register, ECB/BoE/BoJ, FTC/DOJ/FDA/CFTC, USGS, NOAA,
 * Nasdaq halts, DefiLlama, Polymarket, Hyperliquid…) normalized into one event schema and
 * scored against an exposure graph into per-asset impacts.
 *
 * Three ways to pay, all automatic:
 *   1. `privateKey`  → pays each call in USDC on Base via x402 (HTTP 402 → sign → 200). No account.
 *   2. `apiKey`      → prepaid pack bought with USDC (`buyPack`) or a Stripe subscription.
 *   3. `freeTrial`   → 100 free calls/day per IP (sends `X-Free-Trial: 1`). Default when nothing else is set.
 *
 * Information and analytics only — not investment advice. Operator: Marbella Collins LLC.
 */

export type Direction = -1 | 0 | 1;
export interface Impact { asset_id: string; direction: Direction; confidence: number; horizon?: string; path?: string[]; rationale?: string }
export interface IntelEvent {
  id: string; ts_event: string; kind: string; title: string; summary?: string; severity: number; novelty: number;
  impacts: Impact[]; tradable_now?: string[]; next_open?: Record<string, string>;
  source: { id: string; tier: "primary" | "secondary" | "media" | string }; corroboration: { count: number }; raw_ref?: string;
}
export interface Billing { tool: string; price_usd: number; method: "x402" | "api_key" | "quota" | "free" | string }
export interface EventsSinceOpts { since?: string; universe?: string[]; kinds?: string[]; min_confidence?: number; limit?: number }
export interface IntelOptions {
  /** Base URL of the service. Default https://intel.degenscan.io */
  baseUrl?: string;
  /** Hex private key of a wallet holding USDC on Base (eip155:8453). Pays per call via x402. Use a dedicated agent wallet. */
  privateKey?: string;
  /** API key from `buyPack()` or https://intel.degenscan.io/v1/plans */
  apiKey?: string;
  /** Use the free trial (100 calls/day/IP). Default true when neither privateKey nor apiKey is given. */
  freeTrial?: boolean;
  /** Custom fetch (e.g. already wrapped with an x402 payer for Solana). */
  fetch?: typeof fetch;
  /** Request timeout in ms. Default 20000. */
  timeoutMs?: number;
}

export class IntelError extends Error { constructor(message: string, public status: number, public body?: unknown) { super(message); this.name = "IntelError"; } }

export class Intel {
  readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly freeTrial: boolean;
  private readonly timeoutMs: number;
  private fetchImpl: typeof fetch | null = null;
  private readonly privateKey?: string;
  private readonly customFetch?: typeof fetch;

  constructor(opts: IntelOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://intel.degenscan.io").replace(/\/$/, "");
    this.apiKey = opts.apiKey; this.privateKey = opts.privateKey; this.customFetch = opts.fetch;
    this.freeTrial = opts.freeTrial ?? (!opts.apiKey && !opts.privateKey);
    this.timeoutMs = opts.timeoutMs ?? 20_000;
  }

  /** Lazily build the fetch: plain, or wrapped with an x402 payer when a private key is present. */
  private async f(): Promise<typeof fetch> {
    if (this.fetchImpl) return this.fetchImpl;
    if (this.customFetch) return (this.fetchImpl = this.customFetch);
    if (!this.privateKey) return (this.fetchImpl = fetch);
    const [{ wrapFetchWithPaymentFromConfig }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
      import("@x402/fetch"), import("@x402/evm"), import("viem/accounts"),
    ]);
    let pk = this.privateKey.trim(); if (!pk.startsWith("0x")) pk = "0x" + pk;
    const account = privateKeyToAccount(pk as `0x${string}`);
    this.fetchImpl = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] }) as typeof fetch;
    return this.fetchImpl;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.apiKey) h["x-api-key"] = this.apiKey;
    else if (this.freeTrial && !this.privateKey) h["x-free-trial"] = "1";
    return h;
  }

  /** Low-level request. Returns parsed JSON; throws IntelError on non-2xx (including an unpaid 402). */
  async request<T = any>(path: string, init: { method?: string; query?: Record<string, unknown>; body?: unknown } = {}): Promise<T & { _billing?: Billing }> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) { if (v == null) continue; url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v)); }
    const f = await this.f();
    const res = await f(url.toString(), { method: init.method ?? "GET", headers: this.headers(init.body ? { "content-type": "application/json" } : {}), body: init.body ? JSON.stringify(init.body) : undefined, signal: AbortSignal.timeout(this.timeoutMs) });
    const text = await res.text(); let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!res.ok) {
      const msg = res.status === 402 ? "Payment required — pass privateKey (USDC on Base), apiKey, or freeTrial:true" : (json?.error ?? `HTTP ${res.status}`);
      throw new IntelError(msg, res.status, json);
    }
    const pr = res.headers.get("payment-response"); if (pr && json && typeof json === "object") json._payment_response = pr;
    return json;
  }

  // ---- free -------------------------------------------------------------------------------
  /** Covered assets and ids (map your tickers here first). Free. */
  universe() { return this.request<{ version: string; assets: { id: string; name: string; class: string; tags?: string[] }[] }>("/v1/universe"); }
  /** Connector health / freshness. Free. */
  sources() { return this.request<{ sources: any[] }>("/v1/sources"); }
  /** Service health. Free. */
  health() { return this.request<{ ok: boolean; events: number; connectors: number; at: string }>("/health"); }

  // ---- paid -------------------------------------------------------------------------------
  /** $0.001 — cheapest probe: event counts in the last hour by class + venues open. Call this first / on a timer. */
  pulse() { return this.request("/v1/pulse"); }
  /** $0.005 — all events since `since` ("4h", "24h", ISO) touching your universe, with per-asset impacts. */
  eventsSince(opts: EventsSinceOpts = {}) { return this.request<{ events: IntelEvent[]; universe_version: string }>("/v1/events", { query: opts as any }); }
  /** $0.003 — net pressure on one asset and the events driving it. */
  impactFor(assetId: string, opts: { since?: string; limit?: number } = {}) { return this.request(`/v1/impact/${encodeURIComponent(assetId)}`, { query: opts }); }
  /** $0.002 — second-order exposure graph (suppliers, countries, commodities, regulators, indices). */
  exposureGraph(assetId: string, depth = 2) { return this.request(`/v1/graph/${encodeURIComponent(assetId)}`, { query: { depth } }); }
  /** $0.01 — situational picture: venues open, 24h pressure by asset, top events, prediction markets. */
  regime() { return this.request("/v1/regime"); }
  /** $0.02 — the reasoning behind one impact. */
  explain(eventId: string) { return this.request(`/v1/explain/${encodeURIComponent(eventId)}`); }
  /** $0.01 — Polymarket market (id, slug or question) → current odds + primary-source events that bear on it. */
  polymarket(market: string, opts: { since?: string; limit?: number } = {}) { return this.request(`/v1/polymarket/${encodeURIComponent(market)}`, { query: opts }); }
  /** $0.002 — headlines on one asset with tier, corroboration and heuristic sentiment. */
  newsFor(ticker: string, opts: { since?: string; limit?: number } = {}) { return this.request(`/v1/news/${encodeURIComponent(ticker)}`, { query: opts }); }
  /** $0.002 — SEC filings (8-K, Form 4, 13D/G, S-1) on one issuer. */
  filingsFor(ticker: string, opts: { since?: string; forms?: string[]; limit?: number } = {}) { return this.request(`/v1/filings/${encodeURIComponent(ticker)}`, { query: opts as any }); }
  /** $0.002 — upcoming macro prints, FOMC, earnings, auctions. */
  calendar(opts: { days?: number; types?: string[]; universe?: string[] } = {}) { return this.request("/v1/calendar", { query: opts as any }); }
  /** $0.003 — perp microstructure from Hyperliquid (funding, predicted funding by venue, OI, premium, volume, flags) + event pressure. */
  derivsFor(symbol: string, opts: { since?: string } = {}) { return this.request(`/v1/derivs/${encodeURIComponent(symbol)}`, { query: opts }); }
  /** $0.10 — one-call pre-trade briefing: pressure, headlines, filings, exposure, prediction markets, catalysts, derivatives (crypto), venues. */
  brief(assetId: string, opts: { since?: string } = {}) { return this.request(`/v1/brief/${encodeURIComponent(assetId)}`, { query: opts }); }

  // ---- oracle (2Realidade) ----------------------------------------------------------------
  /** $0.25 — calibrated YES-probability for a binary question (async). Returns { forecast_id, status:"queued", eta_s, poll }; then oracleGet / oracleWait. */
  oracleForecast(req: { question: string; resolves_at?: string; context?: string; runs?: number; population?: number; rounds?: number; interventions?: { round: number; news: string; audience?: "all" | "half" | "influencers" | "skeptics" }[]; method?: "social_sim" | "expert_panel" | "hybrid" }) {
    return this.request<{ forecast_id: string; status: string; eta_s: number; poll: string }>("/v1/oracle/forecast", { method: "POST", body: req });
  }
  /** Free — poll a forecast: { status:"queued"|"running"|"failed" } or the full Forecast when status is "done". */
  oracleGet(forecastId: string) { return this.request<any>(`/v1/oracle/forecast/${encodeURIComponent(forecastId)}`); }
  /** Free — poll until done (default every 20 s, up to 10 min). Resolves with the Forecast; throws on failed/timeout. */
  async oracleWait(forecastId: string, opts: { intervalMs?: number; timeoutMs?: number } = {}) {
    const t0 = Date.now(); const every = opts.intervalMs ?? 20_000, max = opts.timeoutMs ?? 600_000;
    for (;;) {
      const f = await this.oracleGet(forecastId);
      if (f.status === "done") return f;
      if (f.status === "failed") throw new IntelError(`forecast ${forecastId} failed: ${f.error ?? "unknown"}`, 500);
      if (Date.now() - t0 > max) throw new IntelError(`forecast ${forecastId} still ${f.status} after ${max / 1000}s`, 504);
      await new Promise(r => setTimeout(r, every));
    }
  }
  /** $0.002 — daily board of standing forecasts (or one by slug): probability, interval, base rate, market odds, edge, commitment hash. No waiting. */
  oracleBoard(slug?: string) { return this.request<any>(slug ? `/v1/oracle/board/${encodeURIComponent(slug)}` : "/v1/oracle/board"); }
  /** Free — public Brier track record overall, by domain and vs. market. */
  oracleTrackRecord() { return this.request<any>("/v1/oracle/track-record"); }

  // ---- keys -------------------------------------------------------------------------------
  /** Buy a prepaid API key with USDC (requires privateKey). pack_1k $5 · pack_10k $40 · pack_100k $300. Returns { api_key, total_calls }. */
  async buyPack(pack: "pack_1k" | "pack_10k" | "pack_100k" = "pack_1k") {
    if (!this.privateKey && !this.customFetch) throw new IntelError("buyPack needs a paying wallet (privateKey) — it is paid in USDC", 400);
    return this.request<{ api_key: string; total_calls: number; pack: string }>(`/v1/keys/x402/${pack}`, { method: "POST", body: {} });
  }
  /** Available packs and prices. Free. */
  packs() { return this.request("/v1/keys/packs"); }
  /** Remaining budget for the current apiKey. */
  keyStatus() { if (!this.apiKey) throw new IntelError("keyStatus needs apiKey", 400); return this.request("/v1/keys/me"); }
  /** Card plans (for the human operator). Free. */
  plans() { return this.request("/v1/plans"); }
}

export default Intel;
