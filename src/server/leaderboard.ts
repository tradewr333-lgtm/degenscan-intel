/**
 * Public SEO pages (ordem 05/10 §4): /carry/leaderboard and /carry/coin/{coin}. Server-rendered HTML, no JS required, 1 hour behind
 * the paid API, top 5 rows per table — never the full dataset. No direction words. Disclaimer PT+EN. Regenerated at most every 5 min.
 */
import { carryStats, crossDex, spotPerp, naked, watchdog, coinHistory, fundingMatrix, splitCoin } from "../carry/hl.js";
import { getDb } from "../store/db.js";
import { publicDeskSummary } from "../carry/desk.js";
import { CARRY, CARRY_DESK } from "./keys.js";

const esc = (x: unknown) => String(x ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (x: number | null | undefined, d = 1) => x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`;
const pp = (x: number | null | undefined, d = 2) => x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;
const usd = (x: number | null | undefined) => x == null ? "—" : x >= 1e9 ? `$${(x / 1e9).toFixed(2)}B` : x >= 1e6 ? `$${(x / 1e6).toFixed(1)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(0)}k` : `$${Math.round(x)}`;
const D_EN = "Market data and analytics only — not a signal, not investment advice.";
const D_PT = "Informação e análise, não é recomendação de investimento.";
const BASE = process.env.PUBLIC_URL ?? "https://intel.degenscan.io";

const STYLE = `body{font-family:system-ui,sans-serif;max-width:960px;margin:0 auto;padding:24px 16px;background:#0b0d10;color:#e8eaed;line-height:1.55}a{color:#7cc4ff}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0 4px}td,th{border-bottom:1px solid #232a32;padding:7px 8px;text-align:left}th{color:#9aa0a6;font-weight:600}
.box{border:1px solid #2a2f36;border-radius:14px;padding:16px;margin:18px 0;background:#11151b}.m{color:#9aa0a6}.stats{display:flex;flex-wrap:wrap;gap:18px}.stats b{display:block;font-size:22px}
code,pre{background:#151a21;border-radius:6px}code{padding:1px 5px}pre{padding:10px;overflow:auto}.btn{display:inline-block;background:#4f8cff;color:#fff;padding:10px 14px;border-radius:10px;text-decoration:none;font-weight:600;margin:6px 8px 0 0}`;

function head(title: string, desc: string, canonical: string, jsonld: object[]) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"><link rel="canonical" href="${BASE}${canonical}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${BASE}${canonical}"><meta property="og:image" content="${BASE}/icon.png">
<meta name="twitter:card" content="summary"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}">
${jsonld.map(j => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("")}<style>${STYLE}</style>`;
}
function foot() {
  return `<div class="box"><h2 style="margin-top:0">Get the full history</h2><p>Every perp on every dex, real time, every row — plus hourly history since 13 Sep 2026: <b>Carry Data US$${CARRY.usd_month}/month</b> (flat, unlimited) · <b>Carry Desk US$${CARRY_DESK.usd_month}/month</b> (eligibility filters, capacity, realized carry, after-hours, alerts) · or <b>pay per call</b> in USDC (x402, no account). Free trial key: 200 calls, 7 days.</p>
<a class="btn" href="/carry?lang=en">See plans</a><a class="btn" href="/carry?lang=en#trial" style="background:#22c55e;color:#04120a">Free trial key</a><a class="btn" href="/docs/carry" style="background:#1b2230;color:#aac4ff">API docs</a>
<pre>npm i degenscan-intel        # TypeScript client (x402)
pip install degenscan-intel  # Python client
npx -y degenscan-intel-mcp   # MCP server for Claude / Cursor</pre></div>
<p class="m">${D_EN} ${D_PT} · Operator: Marbella Collins LLC · contact@degenscan.io</p></html>`;
}

let lbCache: { at: number; html: string; etag: string } | null = null;
export function leaderboardPage(): { html: string; etag: string } {
  if (lbCache && Date.now() - lbCache.at < 5 * 60_000) return lbCache;
  const st = carryStats().funding;
  const x = crossDex({ delayH: 1, minVol: 100_000, limit: 5 });
  const sp = spotPerp({ delayH: 1, minVol: 100_000, limit: 5 });
  const nk = naked({ delayH: 1, minVol: 100_000, limit: 5 });
  const wd = watchdog();
  const ds = publicDeskSummary(); const eligibleN = ds.eligible; const ah = ds.afterhours as any;
  const asOf = x.as_of ?? sp.as_of ?? "—";
  const title = "Hyperliquid funding rates leaderboard — all dexes, HIP-3 included | Degenscan Intel";
  const desc = "Hourly funding for every Hyperliquid perp on every dex (xyz, io, para, mkts and main), cross-dex spreads, spot×perp basis and market health. History beyond Hyperliquid's 500-hour window. Market data only — not investment advice.";
  const jsonld = [
    { "@context": "https://schema.org", "@type": "Dataset", name: "Hyperliquid hourly funding rates — all dexes (HIP-3 included)", description: desc, url: `${BASE}/carry/leaderboard`,
      temporalCoverage: `${String(st.first_hour ?? "2026-09-13").slice(0, 10)}/..`, isAccessibleForFree: false, license: `${BASE}/carry`, creator: { "@type": "Organization", name: "Marbella Collins LLC" },
      variableMeasured: ["funding rate", "open interest", "24h volume", "mark price", "oracle price"], distribution: [{ "@type": "DataDownload", encodingFormat: "application/json", contentUrl: `${BASE}/v1/carry/funding-matrix` }] },
    { "@context": "https://schema.org", "@type": "Product", name: "Degenscan Carry Oracle", description: "Hyperliquid funding API: every perp on every dex, cross-dex spreads, spot×perp, hourly history.", brand: "Degenscan Intel",
      offers: [{ "@type": "Offer", name: "Carry Data", price: CARRY.usd_month, priceCurrency: "USD", url: `${BASE}/carry` }, { "@type": "Offer", name: "Carry Desk", price: CARRY_DESK.usd_month, priceCurrency: "USD", url: `${BASE}/carry` }] },
  ];
  const coinLink = (c: string) => `<a href="/carry/coin/${encodeURIComponent(c)}">${esc(c)}</a>`;
  const hoursFor = (c: string) => (getDb().prepare("SELECT COUNT(*) AS n FROM hl_funding WHERE coin = ?").get(c) as any)?.n ?? 0;
  const html = head(title, desc, "/carry/leaderboard", jsonld) + `
<h1>Hyperliquid funding rates, every dex, every hour</h1>
<p class="m">Updated hourly · data as of <b>${esc(asOf)}</b> (1 hour behind the paid API) · top 5 per table.</p>
<div class="box stats"><div><b>${(st.rows ?? 0).toLocaleString("en-US")}</b>hourly funding rows</div><div><b>${st.coins ?? 0}</b>perps</div><div><b>${st.dexes ?? 0}</b>dexes with active markets</div><div><b>${String(st.first_hour ?? "—").slice(0, 10)}</b>history since</div></div>
<p>Hyperliquid's API returns only the last 500 hours of funding. We record every hour for every perp on every Hyperliquid dex — the main dex and the HIP-3 dexes (trade.xyz's <code>xyz</code>, <code>io</code>, <code>para</code>, <code>mkts</code>) — so the <b>Hyperliquid funding rate history</b> keeps growing beyond that window. The same data is available through the <b>Hyperliquid funding API</b> below.</p>

<h2>Cross-dex funding spreads (HIP-3)</h2>
<p>When the same asset is listed on two HIP-3 dexes (for example <b>xyz vs io funding</b> on NBIS or SNDK), each book has its own funding. The spread between them is the raw material of <b>HIP-3 funding</b> analysis; values are annualised.</p>
<table><tr><th>Asset</th><th>Legs (dex)</th><th>Spread 14d</th><th>Spread now</th><th>Basis</th><th>Min liquidity 24h</th><th>Data points</th></tr>
${(x.items as any[]).map(i => `<tr><td>${esc(i.base)}</td><td>${i.legs.map((l: any) => coinLink(l.coin)).join(" · ")}</td><td>${pct(i.spread_apr_14d)}</td><td>${pct(i.spread_apr_now)}</td><td>${pp(i.basis_pct)}</td><td>${usd(i.min_leg_vol24_usd)}</td><td>${hoursFor(i.legs[0].coin)} h</td></tr>`).join("") || `<tr><td colspan="7" class="m">No pair above US$100k daily volume right now.</td></tr>`}</table>

<h2>Spot × perp funding</h2>
<p>Main-dex perps that also have a spot market on Hyperliquid: the perp's funding over 14 days and the perp/spot basis — the inputs any <b>delta neutral Hyperliquid data</b> study starts from.</p>
<table><tr><th>Asset</th><th>Perp</th><th>Funding 14d</th><th>Funding now</th><th>Hours positive 14d</th><th>Basis</th><th>Perp vol 24h</th></tr>
${(sp.items as any[]).map(i => `<tr><td>${esc(i.base)}</td><td>${coinLink(i.perp)}</td><td>${pct(i.funding_apr_14d)}</td><td>${pct(i.funding_apr)}</td><td>${i.hours_positive_14d == null ? "—" : Math.round(i.hours_positive_14d * 100) + "%"}</td><td>${pp(i.basis_pct)}</td><td>${usd(i.perp_vol24_usd)}</td></tr>`).join("")}</table>

<h2>Funding extremes without a hedge</h2>
<p>Perps whose annualised funding is beyond ±50% and that have no hedge leg on Hyperliquid — no spot market and no same-ticker listing on another dex. Shown as data only.</p>
<table><tr><th>Market</th><th>Funding now</th><th>Funding 14d</th><th>Hours beyond ±50% (14d)</th><th>Open interest</th><th>Why no hedge</th></tr>
${(nk.items as any[]).map(i => `<tr><td>${coinLink(i.coin)}</td><td>${pct(i.funding_apr_now, 0)}</td><td>${pct(i.funding_apr_14d, 0)}</td><td>${i.hours_above_threshold_14d}</td><td>${usd(i.oi_usd)}</td><td>${i.why_no_hedge === "no_spot" ? "no spot market" : "no spot, no other-dex listing"}</td></tr>`).join("")}</table>

<h2>Dex health</h2>
<table><tr><th>Dex</th><th>Active markets</th><th>Zero OI</th><th>Delisted</th><th>Open interest</th><th>Volume 24h</th><th>Flags</th></tr>
${(wd.dexes as any[]).map(d => `<tr><td>${esc(d.dex)}</td><td>${d.active}</td><td>${d.zero_oi}</td><td>${d.delisted}</td><td>${usd(d.oi_usd)}</td><td>${usd(d.vol24h_usd)}</td><td>${esc((d.risk_flags ?? []).join(", ") || "—")}</td></tr>`).join("")}</table>

${ah && ah.session === "closed" && ah.n_away_1pct ? `<div class="box"><b>${ah.n_away_1pct}</b> US equities on HIP-3 are trading more than 1% away from the last NYSE close right now (median ${ah.median_abs_pct?.toFixed(1)}%). Full table in Carry Desk.</div>` : ah ? `<div class="box">After-hours: ${ah.n} US equities tracked on HIP-3 dexes against the last NYSE close${ah.session === "open" ? " — US session open now" : ""}. Full table in Carry Desk.</div>` : ""}
<div class="box"><b>${eligibleN}</b> pairs pass the 6-rule carry filter right now (spread, share of positive hours, correlation, basis range, liquidity, fee break-even). <a href="/docs/carry#method">See the rules →</a> Full table, capacity and after-hours premium of US equities on HIP-3: Carry Desk.</div>
<p>Looking for <b>hyperliquid funding arbitrage data</b> or the <b>trade.xyz funding rate</b> history of a single market? Every market has its own page — for example ${coinLink("xyz:NBIS")}, ${coinLink("xyz:TSLA")}, ${coinLink("BTC")}, ${coinLink("HYPE")}.</p>
` + foot();
  const etag = `"lb-${String(asOf)}"`;
  lbCache = { at: Date.now(), html, etag };
  return lbCache;
}

/** Simple server-side SVG line of annualised funding (fraction) over time. */
function svgLine(points: { t: number; v: number }[], w = 900, h = 220) {
  if (points.length < 2) return `<p class="m">Not enough history yet.</p>`;
  const vs = points.map(p => p.v), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), span = hi - lo || 1;
  const x = (i: number) => 40 + (i / (points.length - 1)) * (w - 50), y = (v: number) => 10 + (1 - (v - lo) / span) * (h - 30);
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" role="img" aria-label="Annualised funding, last 7 days"><rect width="${w}" height="${h}" fill="#11151b"/>
<line x1="40" x2="${w - 10}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="#3a4250" stroke-dasharray="4 4"/>
<text x="4" y="${(y(hi) + 4).toFixed(1)}" fill="#9aa0a6" font-size="11">${pct(hi, 0)}</text><text x="4" y="${(y(lo) + 4).toFixed(1)}" fill="#9aa0a6" font-size="11">${pct(lo, 0)}</text>
<path d="${d}" fill="none" stroke="#7cc4ff" stroke-width="1.8"/><text x="40" y="${h - 4}" fill="#9aa0a6" font-size="11">${new Date(points[0].t).toISOString().slice(0, 16).replace("T", " ")}</text><text x="${w - 150}" y="${h - 4}" fill="#9aa0a6" font-size="11">${new Date(points[points.length - 1].t).toISOString().slice(0, 16).replace("T", " ")} UTC</text></svg>`;
}

export function coinPage(coin: string): { html: string; etag: string } | null {
  const h = coinHistory(coin, 24 * 7 + 1);
  if (!h.items.length) return null;
  const cutoff = Date.now() - 3_600_000;
  const pts = h.items.filter((i: any) => Date.parse(i.at) <= cutoff && i.funding_apr != null).map((i: any) => ({ t: Date.parse(i.at), v: i.funding_apr }));
  const last = [...h.items].reverse().find((i: any) => Date.parse(i.at) <= cutoff && i.oi_usd != null) as any;
  const { dex, base } = splitCoin(coin);
  const total = (getDb().prepare("SELECT COUNT(*) AS n, MIN(ts) AS f FROM hl_funding WHERE coin = ?").get(coin) as any);
  const avg7 = pts.length ? pts.reduce((a, p) => a + p.v, 0) / pts.length : null;
  const others = (fundingMatrix({ delayH: 1 }).items as any[]).filter(i => i.base.toUpperCase() === base.toUpperCase() && i.coin !== coin);
  const title = `${coin} funding rate history on Hyperliquid (${dex}) | Degenscan Intel`;
  const desc = `Hourly funding rate history for ${coin} on Hyperliquid's ${dex} dex: last 7 days annualised, open interest and volume, related cross-dex listings. History beyond the 500-hour API window. Market data only — not investment advice.`;
  const jsonld = [{ "@context": "https://schema.org", "@type": "Dataset", name: `${coin} hourly funding rate — Hyperliquid ${dex}`, description: desc, url: `${BASE}/carry/coin/${encodeURIComponent(coin)}`, temporalCoverage: `${new Date(total.f).toISOString().slice(0, 10)}/..`, isAccessibleForFree: false, license: `${BASE}/carry` }];
  const html = head(title, desc, `/carry/coin/${encodeURIComponent(coin)}`, jsonld) + `
<p class="m"><a href="/carry/leaderboard">← Hyperliquid funding leaderboard</a></p>
<h1>${esc(coin)} funding rate history</h1>
<p class="m">Hyperliquid · dex <b>${esc(dex)}</b> · ${total.n.toLocaleString("en-US")} hourly data points since ${new Date(total.f).toISOString().slice(0, 10)} · chart 1 hour behind the paid API.</p>
<h2>Annualised funding, last 7 days</h2>${svgLine(pts)}
<div class="box stats"><div><b>${pct(avg7)}</b>7-day average funding (annualised)</div><div><b>${usd(last?.oi_usd)}</b>open interest</div><div><b>${usd(last?.vol24_usd)}</b>24h volume</div></div>
${others.length ? `<h2>Same asset on other dexes</h2><ul>${others.map(o => `<li><a href="/carry/coin/${encodeURIComponent(o.coin)}">${esc(o.coin)}</a> — funding ${pct(o.funding_apr)} (annualised, 1 h ago)</li>`).join("")}</ul>` : ""}
<p>The full hourly series (funding, premium, mark, open interest, volume) is available at <code>GET /v1/carry/history/${esc(coin)}</code> with a Carry key, or per call in USDC.</p>
` + foot();
  return { html, etag: `"coin-${coin}-${pts.length ? pts[pts.length - 1].t : 0}"` };
}

export function carrySitemapUrls(): string[] {
  try { return (fundingMatrix({}).items as any[]).map(i => `/carry/coin/${encodeURIComponent(i.coin)}`); } catch { return []; }
}
