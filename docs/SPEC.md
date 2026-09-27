# degenscan-intel — Spec v0.1 (27/set/2026)

**Feed de eventos cross-asset, estruturado e pago por chamada, para agentes autônomos.**
Tese: mercados "ultra-eficientes" — qualquer agente, por centavos, sabe em segundos *o que aconteceu no mundo e qual ativo isso afeta*. O humano não é o cliente; o cliente é o agente que opera (Alpaca, IBKR, Hyperliquid, Binance, Polymarket).

---

## 1. O que reaproveitar do Osiris (e o que não)

Analisado o fork `simplifaisoul/osiris` (MIT, Next.js 16, TypeScript, MapLibre, ~290 arquivos TS).

**Reaproveitar (lógica de dados, ~15% do repo):**
- `src/lib/gdeltEvents.ts` — parser do export 15-min do GDELT 2.0 (eventos geocodificados, CAMEO codes, Goldstein scale). É o melhor sensor geopolítico gratuito que existe.
- `src/lib/sourceCache.ts`, `httpJson.ts`, `fetch-pool.ts`, `ssrf-guard.ts` — cache por fonte com stale-while-revalidate, pool de fetch com timeout, proteção SSRF. Infra madura.
- `src/app/api/scm-suppliers/route.ts` — a *ideia* do overlay "ameaça física × fábrica de fornecedor Tier 1/2" (TSMC Hsinchu, Samsung Giheung, Bosch Stuttgart…). Vira a semente do **grafo de exposição**.
- `src/app/api/country-risk/route.ts` — tabela de bolsas com fuso/horário (NYSE, LSE, TSE, HKEX…). Vira o **calendário de sessão** (`tradable_now`).
- `src/lib/sanctions.ts` — OpenSanctions/OFAC.
- Fetchers de USGS, GDACS, NASA EONET/FIRMS, NOAA SWPC.
- `src/app/api/markets/route.ts` — padrão de quote via Yahoo v8 chart (não-oficial; usar só pra contexto, não redistribuir).

**Descartar:** globo 3D, ~700 webcams, satélites/TLE, rádio/ADS-B, painel de notícias-TV, Telegram OSINT de guerra, RECON toolkit (port scanner, WHOIS). Custo de manutenção alto, valor zero pra precificação de ativos.

**Alerta de marca:** vários forks virais do Osiris trazem endereço de token pump.fun no título. Citar sempre o autor original (simplifaisoul) e manter o `LICENSE` MIT. Nome do produto: **Degenscan Intel** (não "Palantir").

---

## 2. Universo de ativos (v0)

Recalculado **diariamente às 21:30 ET** (após o fechamento) e versionado (`universe_version`).

| Bloco | Conteúdo | Fonte da lista |
|---|---|---|
| **Equities** | Top 100 ações por volume médio (20d) em NYSE+Nasdaq | Nasdaq screener API (keyless) → fallback Yahoo `most_actives` |
| **Índices/ETFs** | SPY, QQQ, IWM, DIA, VIX, TLT, HYG, GLD, SLV, USO, UNG, XLE, XLF, XLK, SMH | estático |
| **Cripto** | BTC, ETH, SOL + top 20 por volume (CoinGecko) | CoinGecko |
| **Proxies cripto listados** | MSTR, COIN, HOOD, MARA, RIOT, CLSK, IBIT, ETHA | estático |
| **Commodities/FX/Rates** | CL, BZ, NG, GC, SI, HG, ZW, ZC; DXY, EURUSD, USDJPY, USDBRL; US2Y, US10Y, US30Y | estático |

Cada ativo carrega: `id`, `class`, `venue`, `sessions[]` (horários de pregão em IANA tz), `cik` (se SEC), `coingecko_id`, `tags[]` (setor, país-sede, países de receita, commodities de input, reguladores).

---

## 3. Catálogo brute-force de fontes (o "ataque")

Princípio: **fonte primária > agregador > mídia**. Quanto mais perto do emissor do fato (SEC, Fed, USGS), menor a latência e maior a confiança. Mídia entra como *corroboração*, não como origem.

Legenda de status: ✅ validado hoje via fetch real · 🔑 chave gratuita · 💲 pago · ⏳ a validar no deploy (sandbox bloqueou egress) · ⚠️ instável/ToS

### 3.1 Físico / natural
| Fonte | Endpoint | Cadência | Status | Ativos típicos |
|---|---|---|---|---|
| USGS Earthquakes | `earthquake.usgs.gov/.../all_hour.geojson` | 1 min | ⏳ | via grafo: fábricas (TSM→NVDA/AAPL/AMD), seguradoras, resseguro |
| GDACS (ONU/UE) | `gdacs.org/xml/rss.xml` | 15 min | ⏳ | agro (ZW/ZC), energia, seguradoras |
| NASA EONET | `eonet.gsfc.nasa.gov/api/v3/events` | 15 min | ⏳ | incêndios, vulcões, tempestades |
| NASA FIRMS | `firms.modaps.eosdis.nasa.gov` | 15 min | 🔑 | incêndios × infra (refinarias, datacenters) |
| NOAA NHC | `nhc.noaa.gov/CurrentStorms.json` | 15 min | ⏳ | CL, NG, XLE, seguradoras (ALL, TRV), HD/LOW |
| NWS alerts | `api.weather.gov/alerts/active` | 5 min | ⏳ | NG (frio), utilities, aéreas |
| NOAA SWPC | `services.swpc.noaa.gov/products/alerts.json` | 5 min | ⏳ | satélites, utilities, GPS-dependentes |
| Smithsonian GVP | `volcano.si.edu/news/WeeklyVolcanoRSS.xml` | diário | ⏳ | aéreas, seguradoras |
| ReliefWeb | `api.reliefweb.int/v1/disasters` | 15 min | ⏳ | humanitário → soft commodities |

### 3.2 Reguladores e agências estatais (EUA)
| Fonte | Endpoint | Cadência | Status | Uso |
|---|---|---|---|---|
| **SEC EDGAR full-text (EFTS)** | `efts.sec.gov/LATEST/search-index?q=…&forms=8-K` | 1 min | ✅ | 8-K por item: 1.01 (contrato material), 1.03 (falência), 2.02 (resultado), 2.05 (reestruturação), 5.02 (CEO/CFO sai), 7.01, 8.01; Form 4 (insiders), 13D/G (ativistas), S-1, 424B (ofertas) |
| SEC EDGAR recent (Atom) | `sec.gov/cgi-bin/browse-edgar?action=getcurrent&output=atom` | 1 min | ⏳ (exige User-Agent) | stream bruto de filings |
| SEC press/enforcement | `sec.gov/news/pressreleases.rss` | 5 min | ⏳ | processos contra emissores |
| **Federal Reserve press** | `federalreserve.gov/feeds/press_all.xml` | 1 min | ✅ | FOMC statements, enforcement, GENIUS Act stablecoin rules (visto hoje!) |
| Fed speeches | `federalreserve.gov/feeds/speeches.xml` | 5 min | ⏳ | tom hawk/dove |
| **Federal Register API** | `federalregister.gov/api/v1/documents.json` | 15 min | ✅ | **toda norma federal** publicada (rules, proposed rules, executive orders, notices) com agência e data |
| Treasury yields XML | `home.treasury.gov/.../xml?data=daily_treasury_yield_curve` | diário | ⏳ | curva |
| TreasuryDirect auctions | `treasurydirect.gov/TA_WS/securities/announced` | diário | ⏳ | leilões (oferta de duration) |
| FRED | `api.stlouisfed.org/fred/…` | evento | 🔑 | calendário de releases + séries |
| BLS API | `api.bls.gov/publicAPI/v2/…` | evento | 🔑 | CPI, NFP, PPI no segundo da publicação |
| BEA API | `apps.bea.gov/api` | evento | 🔑 | PIB, PCE |
| EIA API | `api.eia.gov/v2/petroleum/…` | semanal | 🔑 | estoques de petróleo (CL, XLE) |
| USDA WASDE | `usda.gov/oce/commodity/wasde/latest.json` | mensal | ⏳ | grãos |
| FTC press | `ftc.gov/feeds/press-release.xml` | 5 min | ⏳ | M&A bloqueado, antitruste (META, GOOG, AMZN, MSFT) |
| DOJ press | `justice.gov/feeds/opa/justice-news.xml` | 5 min | ⏳ | antitruste, indiciamentos |
| FDA press + approvals | `fda.gov/.../press-releases/rss.xml` | 5 min | ⏳ | biotech/pharma (LLY, PFE, MRK, NVO) |
| CFTC press | `cftc.gov/RSS/RSSGP/rssgp.xml` | 5 min | ⏳ | derivativos, cripto |
| FCC | `fcc.gov/news-events/headlines.rss` | 15 min | ⏳ | telecom (T, VZ, TMUS), espectro |
| CISA KEV | `cisa.gov/.../known_exploited_vulnerabilities.json` | 15 min | ⏳ | CRWD, PANW, MSFT, ORCL quando vendor citado |
| NHTSA recalls | `api.nhtsa.gov/recalls` | diário | ⏳ | TSLA, GM, F, RIVN |
| OFAC / OpenSanctions | `data.opensanctions.org/datasets/latest/us_ofac_sdn` | 1h | ⏳ | sanções × contrapartes, cripto |
| CourtListener (RECAP) | `courtlistener.com/api/rest/v4/search/?type=r` | 15 min | ⏳ | novas ações judiciais contra emissores |
| USPTO PatentsView | `search.patentsview.org/api/v1/patent/` | diário | ⏳ | patentes concedidas |
| White House | `whitehouse.gov/feed/` | 5 min | ⏳ | ordens executivas, tarifas |
| Congress.gov | `api.congress.gov/v3` | 1h | 🔑 | projetos de lei (cripto, tech, farmácia) |
| SCOTUS | `supremecourt.gov/opinions/slipopinion/25` | evento | ⏳ | decisões |
| **Nasdaq trade halts** | `nasdaqtrader.com/rss.aspx?feed=tradehalts` | 30 s | ✅ | halt = notícia iminente (T1) ou volatilidade (LULD) |
| NYSE halts | `nyse.com/api/trade-halts/current/download` | 30 s | ⏳ | idem |
| FINRA short interest | `api.finra.org/data/group/otcMarket/…` | quinzenal | ⏳ | short squeeze context |

### 3.3 Reguladores e bancos centrais (resto do mundo)
ECB press (`ecb.europa.eu/rss/press.html`), ECB Data API, BoE, BoJ, PBoC (scrape), BCB Copom (`bcb.gov.br/api/servico/sitebcb/copom/atas`), CVM, EU Commission presscorner RSS (multas a big tech, DMA/DSA), EUR-Lex (Official Journal), ESMA, BaFin, FCA UK, MAS, SFC HK, FSA JP. Todos ⏳, todos RSS/JSON keyless.

### 3.4 Corporativo
| Fonte | Uso |
|---|---|
| 8-K/Form 4/13D via EFTS (acima) | **fonte primária** de decisão corporativa |
| Nasdaq earnings calendar `api.nasdaq.com/api/calendar/earnings?date=` | agenda de resultados (⏳; bloqueia bots sem headers) |
| PR Newswire / BusinessWire / GlobeNewswire RSS | press releases 1–3 min antes da mídia |
| IR RSS por empresa (100 feeds, gerados a partir do universo) | guidance, buyback, dividendos |
| Google News RSS `news.google.com/rss/search?q=<ticker>+when:1h` | corroboração, geral |
| GDELT DOC API `api.gdeltproject.org/api/v2/doc/doc` | menções globais por entidade (⚠️ rate-limit agressivo; usar export 15-min como base) |
| Wikimedia pageviews | *attention spike* por empresa (sinal de atenção retail) |
| Reddit r/wallstreetbets, r/stocks JSON | atenção retail (⚠️ ToS: só leitura pública) |
| App Store/Play rankings, job postings, web traffic | 💲 fase 2 (Sensor Tower, Similarweb) |

### 3.5 Cripto / on-chain
CoinGecko (preços/volume), DefiLlama (`api.llama.fi/hacks` — **hacks em tempo real**, TVL, stablecoins supply), mempool.space (fees, mempool), Blockstream, Blockscout (transferências de baleias, mint/burn USDT/USDC), Hyperliquid `info` (OI, funding, liquidações), Binance announcements API (listings/delistings), Coinbase status, Farside (fluxos de ETF spot), Whale Alert (🔑). Todos ⏳ exceto Polymarket ✅.

### 3.6 Geopolítica / macro-risco
GDELT 2.0 export 15-min (do Osiris), ACLED (🔑), UN press RSS, ReliefWeb, NetBlocks (apagões de internet), Cloudflare Radar (🔑), OpenSky (voos — só como sinal de anomalia: jatos de governo, NOTAMs), aisstream (💲 navios — Ormuz, Suez, Taiwan Strait), **Polymarket/Kalshi** (✅ — probabilidade de mercado de eventos: Fed cut, shutdown, tarifa, eleição; é o "preço do evento").

### 3.7 Mídia (só corroboração)
CNBC RSS, WSJ RSS (`feeds.a.dj.com`), FT RSS (headlines), BBC, Al Jazeera, Reuters via Google News, Bloomberg (💲, não usar).

**Total v0: ~70 fontes keyless, ~10 com chave gratuita, 3–4 pagas (fase 2).**

---

## 4. Schema do evento (o produto de verdade)

```ts
Event {
  id: string                 // sha1(source_id + native_id)
  ts_event: ISO8601          // quando aconteceu (UTC)
  ts_observed: ISO8601       // quando nós vimos
  latency_ms: number         // ts_observed - ts_event
  source: { id, name, tier: 'primary'|'aggregator'|'media', url }
  kind: EventKind            // ver taxonomia
  title: string
  summary: string            // ≤ 280 chars, factual
  entities: Entity[]         // {type: company|country|commodity|regulator|person|facility|protocol, id, name, confidence}
  geo?: { lat, lng, country, radius_km }
  severity: 0..1             // magnitude intrínseca (Mw, $ do hack, tamanho da multa, item do 8-K)
  novelty: 0..1              // quão inesperado vs. calendário/consenso
  impacts: Impact[]          // ← o que o agente paga pra ver
  corroboration: { count, sources[] }
  tradable_now: string[]     // ids de ativos negociáveis AGORA
  next_open: {asset_id, at}[]// pra quem só abre depois
  raw_ref: string            // ponteiro pro payload bruto (auditável)
}
Impact {
  asset_id: string
  direction: -1|0|1          // baixa / incerto / alta
  confidence: 0..1
  horizon: 'intraday'|'days'|'weeks'
  path: string[]             // caminho no grafo: ['USGS:M6.8 Hsinchu','facility:TSMC-Fab12','company:TSM','supplies:NVDA']
  rationale: string          // 1 frase
}
```

**Taxonomia `EventKind` (v0):** `nat.quake | nat.storm | nat.fire | nat.volcano | nat.space_weather | reg.rule | reg.proposed_rule | reg.enforcement | reg.approval | reg.sanction | reg.antitrust | cb.decision | cb.speech | cb.minutes | macro.release | macro.auction | corp.8k.<item> | corp.insider | corp.activist | corp.earnings | corp.guidance | corp.mna | corp.halt | corp.recall | corp.lawsuit | corp.press | mkt.prediction_shift | crypto.hack | crypto.listing | crypto.stablecoin_mint | crypto.liquidation_cascade | crypto.outage | geo.conflict | geo.protest | geo.election | geo.outage | media.spike`.

---

## 5. Grafo de exposição

Grafo dirigido e ponderado, versionado em JSON/SQLite, editável.

**Nós:** `asset`, `company` (com CIK, sede, países de receita), `facility` (fábrica/porto/datacenter com lat/lng — semente do `scm-suppliers` do Osiris, expandida), `country`, `commodity`, `sector`, `regulator`, `person` (CEO/CFO/chair Fed), `protocol` (DeFi), `index` (SPX, NDX com pesos).

**Arestas (tipo, peso, direção do impacto):** `supplies(TSM→NVDA, 0.9, +)`, `revenue_from(AAPL→CN, 0.19)`, `input(AAL→CL, -)`, `regulated_by(META→FTC)`, `correlated(MSTR↔BTC, 0.85)`, `constituent(NVDA∈NDX, 0.08)`, `located_in(facility→country)`, `competes(AMD↔NVDA)`, `holds(MSTR→BTC, qty)`, `pegged(USDT→US2Y)`.

**Seed v0 (curado à mão, ~400 arestas):** Mag-7 + semis + energia + financeiras + cripto-proxies. Depois: extração automática de 10-K (item 1A Risk Factors, geographic revenue) via LLM → sugestão de aresta → revisão.

**Motor de impacto (determinístico, sem LLM no caminho quente):**
1. Evento → entidades (regex/dicionário de CIK, tickers, países, commodities; geo → facilities num raio).
2. BFS até profundidade 3 no grafo, multiplicando pesos; corta em `confidence < 0.15`.
3. Direção = produto dos sinais das arestas × sinal intrínseco do evento (tabela por `kind`: `reg.enforcement → -`, `reg.approval → +`, `nat.quake → -` pra facility…).
4. `severity × novelty × peso_acumulado` → `confidence`.
5. LLM só *opcional* e pago à parte (`explain=true`) pra rationale em linguagem natural.

Isso mantém latência < 200 ms por evento e custo ~zero por chamada.

---

## 6. Interface pra agentes

### 6.1 MCP server (streamable HTTP + stdio) e REST espelhado
| Tool | Args | Retorna | Preço (USDC via x402) |
|---|---|---|---|
| `events_since` | `since` (ISO/`4h`), `universe?`, `kinds?`, `min_severity?`, `limit≤200` | `Event[]` | **$0.005** |
| `impact_for` | `asset_id`, `since` | `Impact[]` agregados + eventos-fonte | $0.003 |
| `exposure_graph` | `asset_id`, `depth≤3` | subgrafo | $0.002 |
| `regime_snapshot` | — | VIX, curva, DXY, BTC dom., funding, Polymarket Fed/shutdown, sessões abertas | $0.01 |
| `universe` | `version?` | lista de ativos + sessões | grátis |
| `sources_status` | — | saúde/latência de cada fonte | grátis |
| `subscribe` | `webhook_url`, filtros | stream push | $49/mês (fiat ou x402 mensal) |
| `explain` | `event_id` | rationale LLM | $0.02 |

### 6.2 Pagamento
- **x402** (HTTP 402 + assinatura EIP-3009 USDC em Base) — agente paga sem cadastro. Facilitator: Coinbase (`x402.org`) v0; próprio depois.
- **API key + Stripe** pra agentes de ações que não têm wallet: Starter $29/mês (10k calls), Pro $199/mês (200k + webhook), Enterprise (SLA, fontes 💲).
- **Grátis:** `universe`, `sources_status`, 100 calls/dia por IP (isca + índice em registries MCP).
- Distribuição: registries MCP (Smithery, Glama, mcp.so, Anthropic directory), Coinbase x402 Bazaar, listagem em agent frameworks (LangChain tool, CrewAI, Eliza plugin), `llms.txt` + OpenAPI.

### 6.3 O que torna isso pagável e não copiável
1. **Latência**: polling agressivo em fontes primárias + dedupe → média < 60 s do fato.
2. **Normalização**: 70 formatos → 1 schema.
3. **Grafo de exposição curado** — o ativo intangível; cresce com uso.
4. **Histórico auditável**: `raw_ref` + replay → agentes fazem backtest (`events_since` com `since` no passado = mesma tool, mesmo preço).
5. **Cobertura cripto + Wall Street no mesmo feed** — ninguém oferece keyless.

---

## 7. Arquitetura

```
[ingest workers]  →  [normalize + dedupe]  →  [SQLite/Postgres events + FTS]
  70 conectores        entity linking             ↓
  (cron 30s–1h)        impact engine          [MCP/REST server (Fastify)]
                       (grafo)                    ↓ x402 / API key
                                              agentes · webhooks · painel (fase 2)
```
- **Runtime:** Node 22 + TypeScript; monorepo (`packages/core`, `packages/ingest`, `apps/api`).
- **Store:** SQLite (better-sqlite3) em v0 → Postgres+Timescale quando > 5M eventos.
- **Deploy:** Render (mesma conta do degenscan) — 1 worker + 1 web. Custo ~$25/mês.
- **Observabilidade:** `sources_status` público (transparência = confiança).
- **Jurídico:** só eventos e dados públicos de emissores estatais; cotações de ações apenas com 15 min de atraso e para contexto interno (sem redistribuição real-time → sem licença de bolsa). ToS: Reddit/Yahoo/Nasdaq API são não-oficiais → isolar em conectores "best-effort", nunca no caminho crítico. Termos de uso do produto: "informational, not investment advice" (Marbella Collins LLC).

---

## 8. Roadmap (dias, não semanas)

- **D0 (hoje):** repo `degenscan-intel` com schema, grafo seed, 20 conectores, motor de impacto, MCP server, x402 stub, testes com fixtures. ✅ (ver repo)
- **D1:** deploy no Render; `probe` real das 70 fontes; ajustar headers/UA (SEC exige `User-Agent` com e-mail).
- **D2:** x402 real (facilitator Coinbase, USDC Base); API keys + Stripe; publicar em 3 registries MCP.
- **D3–D5:** grafo → 1.500 arestas (extração de 10-K via LLM + revisão); conectores com chave (FRED, BLS, EIA, FIRMS).
- **D6–D7:** webhook/stream; integração nos bots do Degenscan (TradeMind consome `impact_for`); vídeo de lançamento no canal ("construí um Palantir pra agentes de IA e ele cobra em USDC").
- **Semana 2+:** painel humano (Osiris despido, só camadas de mercado) como isca; white-label; dados pagos (AIS, Whale Alert); backtests públicos como marketing ("o feed avisou X min antes do movimento").

---

## 9. Métricas que importam
- Latência mediana fato→evento por fonte (meta < 60 s primárias).
- % de eventos com ≥1 impacto de `confidence ≥ 0.5`.
- *Hit-rate*: em 30/60 min após evento, o ativo se moveu na direção prevista acima de 1σ? (publicar — é o marketing).
- Calls pagas/dia; receita/dia em USDC; agentes únicos (por wallet).
