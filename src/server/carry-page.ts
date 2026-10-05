import { CARRY, CARRY_DESK, deskSeats } from "./keys.js";
import { trialForm } from "./trial-form.js";
import { carryStats, fundingMatrix, crossDex, spotPerp, coinHistory, naked, watchdog } from "../carry/hl.js";

/** Public page for the Carry Oracle (pt default, ?lang=en). Flat US$100/month — card or USDC. */
export function carryPage(lang: "pt" | "en" = "pt"): string {
  const pt = lang === "pt";
  let st: any = null; try { st = carryStats(); } catch { /* table not ready */ }
  const f = st?.funding ?? {};
  const since = f.first_hour ? String(f.first_hour).slice(0, 10) : "—";
  const T = pt ? {
    title: "Carry Oracle — funding da Hyperliquid em todos os dexes",
    lead: "Os dados que um bot de carry precisa, prontos via API: funding de cada perp em cada dex da Hyperliquid (principal e HIP-3), o mesmo ativo comparado entre dexes, spot × perp, e o histórico hora a hora guardado sem janela — a própria Hyperliquid só devolve 500 horas.",
    price: "US$ 100/mês", priceSub: "valor fixo · chamadas ilimitadas · sem medição por requisição",
    card: "Assinar com cartão", usdc: "Pagar 100 USDC (30 dias)",
    usdcHow: "Agentes e carteiras: <code>POST /v1/keys/x402/carry_month</code> e responda o 402 com x402 (USDC na Base). Sem conta, sem cartão.",
    what: "O que vem na assinatura",
    items: ["<b>/v1/carry/funding-matrix</b> — funding atual anualizado de todos os perps de todos os dexes, com OI, volume e o spot quando existe",
      "<b>/v1/carry/xdex</b> — o mesmo ativo em 2 ou mais dexes HIP-3: spread de funding agora e em 14 dias, % de horas positivas, basis e liquidez da perna menor",
      "<b>/v1/carry/spot-perp</b> — spot × perp no dex principal: funding agora e em 14 dias, % de horas positivas, basis perp/spot e liquidez das duas pernas",
      "<b>/v1/carry/history/{coin}</b> — série horária (funding, premium, mark, OI, volume) desde o início da coleta; HIP-3 com prefixo, ex.: <code>xyz:NBIS</code>",
      "<b>/v1/carry/naked</b> — extremos de funding sem perna de hedge na Hyperliquid (sem spot e sem o mesmo ativo noutro dex) — dado bruto",
      "<b>/v1/carry/watchdog</b> — saúde de cada mercado e dex: ativo / sem OI / deslistado, OI e volume com variação de 7 dias, flags de risco",
      "Também como ferramentas MCP (<code>carry_*</code>) em <code>/mcp</code>. Tudo em tempo real, atualizado de hora em hora. Exemplos reais em <a href=\"/docs/carry\">/docs/carry</a>"],
    data: "O dataset hoje", rows: "linhas de funding", coins: "perps", dexes: "dexes", from: "desde",
    use: "Como usar", useTxt: "Envie a sua chave no cabeçalho <code>X-API-KEY</code>. Exemplo:",
    not: "O que não é", notTxt: "Não é sinal de compra ou venda, não é recomendação e não promete retorno. É dado de mercado verificável (qualquer valor pode ser conferido na API pública da Hyperliquid), organizado e guardado.",
    disc: "Informação e análise, não é recomendação de investimento.",
  } : {
    title: "Carry Oracle — Hyperliquid funding on every dex",
    lead: "The data a carry bot needs, via API: funding for every perp on every Hyperliquid dex (main and HIP-3), the same asset compared across dexes, spot × perp, and the hourly history kept without a window — Hyperliquid itself only returns 500 hours.",
    price: "US$100/month", priceSub: "flat · unlimited calls · no per-request metering",
    card: "Subscribe by card", usdc: "Pay 100 USDC (30 days)",
    usdcHow: "Agents and wallets: <code>POST /v1/keys/x402/carry_month</code> and answer the 402 with x402 (USDC on Base). No account, no card.",
    what: "What the subscription includes",
    items: ["<b>/v1/carry/funding-matrix</b> — current annualised funding for every perp on every dex, with OI, volume and spot when it exists",
      "<b>/v1/carry/xdex</b> — the same asset on 2+ HIP-3 dexes: funding spread now and over 14 days, % positive hours, basis and the thinner leg's liquidity",
      "<b>/v1/carry/spot-perp</b> — spot × perp on the main dex: funding now and over 14 days, % positive hours, perp/spot basis and both legs' liquidity",
      "<b>/v1/carry/history/{coin}</b> — hourly series (funding, premium, mark, OI, volume) since collection began; HIP-3 coins are prefixed, e.g. <code>xyz:NBIS</code>",
      "<b>/v1/carry/naked</b> — funding extremes with no hedge leg on Hyperliquid (no spot, no same-ticker listing on another dex) — raw data",
      "<b>/v1/carry/watchdog</b> — health of every market and dex: active / zero OI / delisted, OI and volume with 7-day change, risk flags",
      "Also as MCP tools (<code>carry_*</code>) at <code>/mcp</code>. All real time, refreshed hourly. Real examples at <a href=\"/docs/carry\">/docs/carry</a>"],
    data: "The dataset today", rows: "funding rows", coins: "perps", dexes: "dexes", from: "since",
    use: "How to use", useTxt: "Send your key in the <code>X-API-KEY</code> header. Example:",
    not: "What it is not", notTxt: "Not a buy/sell signal, not advice, no promised return. Verifiable market data (every value can be checked on Hyperliquid's public API), organised and stored.",
    disc: "Market data and analytics only — not investment advice.",
  };
  return `<!doctype html><html lang="${pt ? "pt-BR" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${T.title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;background:#0b0d10;color:#e8eaed;line-height:1.55}a{color:#7cc4ff}code,pre{background:#151a21;border-radius:6px}code{padding:1px 5px}pre{padding:12px;overflow:auto;font-size:13px}
.box{border:1px solid #2a2f36;border-radius:14px;padding:18px;margin:18px 0;background:#11151b}.price{font-size:34px;font-weight:700}.sub{color:#9aa0a6}.btn{display:inline-block;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600;margin:8px 8px 0 0}
.b1{background:#4f8cff;color:#fff}.b2{background:#1b2230;color:#aac4ff;border:1px solid #2b3a55}.stats{display:flex;flex-wrap:wrap;gap:18px}.stats div{min-width:120px}.stats b{font-size:22px;display:block}li{margin:6px 0}</style>
<h1>${T.title}</h1><p>${T.lead}</p>
${trialForm(pt)}
<p style="color:#9aa0a6">${pt ? "Ver uma amostra pública (top 5, 1 h de atraso):" : "Public sample (top 5, 1 h delay):"} <a href="/carry/leaderboard">/carry/leaderboard</a></p>
<div class="box"><div class="price">${T.price}</div><div class="sub">${T.priceSub}</div>
<a class="btn b1" href="/v1/carry/checkout">${T.card}</a><a class="btn b2" href="#usdc">${T.usdc}</a>
<p id="usdc" class="sub">${T.usdcHow}</p><p class="sub">${pt ? "Agentes também podem pagar por chamada em USDC (x402), sem assinatura: de US$ 0,01 a 0,05 por chamada — veja <a href=\"/docs/carry\">/docs/carry</a>." : "Agents can also pay per call in USDC (x402), no subscription: US$0.01–0.05 per call — see <a href=\"/docs/carry\">/docs/carry</a>."}</p></div>
${(() => { let st: { total: number; used: number; available: number; open: boolean } = { total: CARRY_DESK.default_seats, used: 0, available: CARRY_DESK.default_seats, open: false }; try { st = deskSeats(); } catch { /* */ }
  const live = st.open && st.available > 0;
  return `<div class="box" id="desk"><h2 style="margin-top:0">Carry Desk</h2><div class="price">US$ ${CARRY_DESK.usd_month}<small style="font-size:16px">/${pt ? "mês" : "month"}</small></div><div class="sub">${pt ? `ou US$ ${CARRY_DESK.usd_year}/ano (2 meses grátis) · assentos limitados: ${st.available} de ${st.total} disponíveis` : `or US$${CARRY_DESK.usd_year}/year (2 months free) · limited seats: ${st.available} of ${st.total} available`}</div>
<p>${pt ? "Tudo do Carry Data e mais: <b>/v1/carry/eligible</b> (cada regra de elegibilidade com valor medido e limiar, ajustáveis por você), <b>/v1/carry/capacity</b> (quanto capital cabe por par, pela liquidez real do livro, OI e volume — e quanto do seu capital fica de fora), <b>/v1/carry/realized</b> (carry realizado líquido de taxas e deriva do basis em 7/14/30 dias — retorno passado, não garante futuro), <b>/v1/carry/afterhours</b> (prêmio das ações HIP-3 contra o último fechamento da bolsa americana) e <b>alertas por webhook</b> (par ficou/deixou de ficar elegível, extremos de funding, flags de risco, prêmio after-hours)." : "Everything in Carry Data plus: <b>/v1/carry/eligible</b> (every eligibility rule with measured value and threshold, which you can override), <b>/v1/carry/capacity</b> (how much capital fits per pair from real book depth, OI and volume — and how much of yours is left out), <b>/v1/carry/realized</b> (net realized carry after fees and basis drift over 7/14/30 days — past performance, no guarantee), <b>/v1/carry/afterhours</b> (HIP-3 equity premium vs the last US close) and <b>webhook alerts</b> (pair became/stopped being eligible, funding extremes, risk flags, after-hours premium)."}</p>
${live ? `<a class="btn b1" href="/v1/carry/desk/checkout">${pt ? "Assinar mensal" : "Subscribe monthly"}</a><a class="btn b2" href="/v1/carry/desk/checkout?interval=year">${pt ? "Assinar anual" : "Subscribe yearly"}</a><p class="sub">USDC: <code>POST /v1/keys/x402/carry_desk_month</code> (${CARRY_DESK.usd_month} USDC = 30 ${pt ? "dias" : "days"})</p>` : `<p class="sub"><b>${st.open ? (pt ? "Assentos esgotados nesta onda." : "This wave is full.") : (pt ? "Abertura em breve, por ondas." : "Opening soon, in waves.")}</b> ${pt ? "Entre na lista de espera abaixo." : "Join the waitlist below."}</p>`}</div>`; })()}
<h2>${T.what}</h2><ul>${T.items.map(i => `<li>${i}</li>`).join("")}</ul>
<h2>${T.data}</h2><div class="box stats"><div><b>${(f.rows ?? 0).toLocaleString(pt ? "pt-BR" : "en-US")}</b>${T.rows}</div><div><b>${f.coins ?? 0}</b>${T.coins}</div><div><b>${f.dexes ?? 0}</b>${T.dexes}</div><div><b>${since}</b>${T.from}</div></div>
<h2>${T.use}</h2><p>${T.useTxt}</p><pre>curl -H "X-API-KEY: dsi_carry_…" https://intel.degenscan.io/v1/carry/xdex</pre>
<h2>${pt ? "Lista de espera do Carry Desk" : "Carry Desk waitlist"}</h2>
<p>${pt ? "O tier Desk (filtros de elegibilidade, capacidade por par, carry realizado líquido, prêmio after-hours e alertas) abre por ondas, com assentos limitados. Deixe o seu contato e avisamos no lançamento. Sem cobrança, sem promessa de data." : "The Desk tier (eligibility filters, per-pair capacity, net realized carry, after-hours premium and alerts) opens in waves with limited seats. Leave your contact and we will tell you when it launches. No charge, no launch date promised."}</p>
<form id="wl" class="box" style="display:grid;gap:8px;max-width:520px">
<input name="name" placeholder="${pt ? "Nome" : "Name"}" maxlength="120" style="padding:10px;border-radius:8px;border:1px solid #2a2f36;background:#0b0d10;color:#e8eaed">
<input name="email" type="email" required placeholder="E-mail" style="padding:10px;border-radius:8px;border:1px solid #2a2f36;background:#0b0d10;color:#e8eaed">
<select name="profile" style="padding:10px;border-radius:8px;background:#0b0d10;color:#e8eaed"><option value="dev">${pt ? "Perfil: desenvolvedor / bot próprio" : "Profile: developer / own bot"}</option><option value="vault">Vault</option><option value="fund">${pt ? "Fundo / gestora" : "Fund"}</option><option value="agent">${pt ? "Agente de IA" : "AI agent"}</option><option value="data_provider">${pt ? "Provedor de dados" : "Data provider"}</option><option value="other">${pt ? "Outro" : "Other"}</option></select>
<select name="capital_range" style="padding:10px;border-radius:8px;background:#0b0d10;color:#e8eaed"><option value="n/a">${pt ? "Capital aproximado (opcional)" : "Approx. capital (optional)"}</option><option>&lt;10k</option><option>10k-100k</option><option>100k-1M</option><option>&gt;1M</option></select>
<input name="venues" placeholder="${pt ? "Venues que opera (opcional)" : "Venues you trade (optional)"}" maxlength="300" style="padding:10px;border-radius:8px;border:1px solid #2a2f36;background:#0b0d10;color:#e8eaed">
<select name="tier_interest" style="padding:10px;border-radius:8px;background:#0b0d10;color:#e8eaed"><option value="desk">${pt ? "Interesse: Desk" : "Interest: Desk"}</option><option value="data">Data (US$100)</option><option value="enterprise">Enterprise</option></select>
<input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px" aria-hidden="true">
<button class="btn b1" type="submit" style="border:0;cursor:pointer">${pt ? "Entrar na lista" : "Join the waitlist"}</button><div id="wlmsg" class="sub"></div></form>
<script>document.getElementById("wl").onsubmit=async function(e){e.preventDefault();var f=new FormData(this),b={};f.forEach(function(v,k){b[k]=v});b.lang="${pt ? "pt" : "en"}";b.source="carry_page";var r=await fetch("/v1/carry/waitlist",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});document.getElementById("wlmsg").textContent=r.ok?"${pt ? "Pronto — avisaremos no lançamento." : "Done — we will let you know at launch."}":"${pt ? "Não foi possível registrar. Confira o e-mail." : "Could not register. Check the e-mail."}";if(r.ok)this.reset()};</script>
<h2>${T.not}</h2><p>${T.notTxt}</p>
<p><a href="/carry${pt ? "?lang=en" : ""}">${pt ? "English" : "Português"}</a> · <a href="/v1/carry/stats">/v1/carry/stats</a> · <a href="/pricing${pt ? "" : "?lang=en"}">${pt ? "Outros planos" : "Other plans"}</a></p>
<p class="sub">Marbella Collins LLC · contact@degenscan.io · ${T.disc} US$${CARRY.usd_month}/${pt ? "mês" : "month"}.</p></html>`;
}


// ------------------------------------------------------------------ /docs/carry: real (truncated) responses + field dictionary
let docsCache: { at: number; html: string } | null = null;
const escH = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function carryDocsPage(): string {
  if (docsCache && Date.now() - docsCache.at < 10 * 60_000) return docsCache.html;
  const D = "Market data and analytics only — not a signal, not investment advice. Informação e análise, não é recomendação de investimento.";
  const cut = (o: any, n: number) => ({ ...o, items: (o.items ?? []).slice(0, n), ...(o.count != null ? { count: o.count } : {}), disclaimer: D });
  let ex: Record<string, any> = {};
  try {
    ex = {
      "funding-matrix": cut(fundingMatrix({ minVol: 1_000_000 }), 4),
      "xdex": cut(crossDex({}), 2),
      "spot-perp": cut(spotPerp({}), 3),
      "history/BTC?hours=4": coinHistory("BTC", 4),
      "naked": cut(naked({}), 3),
      "watchdog": (() => { const w = watchdog(); return { as_of: w.as_of, note: w.note, dexes: w.dexes, markets: (w.markets ?? []).slice(0, 3), disclaimer: D }; })(),
    };
  } catch { /* tables not ready */ }
  const dict: [string, string, string, string][] = [
    ["funding_1h", "funding rate paid per hour (positive: longs pay shorts)", "fraction per hour", "Hyperliquid metaAndAssetCtxs / fundingHistory"],
    ["funding_apr / funding_apr_now", "funding_1h × 24 × 365", "fraction (0.31 = 31 % a year)", "derived"],
    ["funding_apr_14d", "mean hourly funding over the last 336 h, annualised", "fraction", "our hourly history"],
    ["hours_positive_14d", "share of the last 336 h with positive funding", "0–1", "our hourly history"],
    ["spread_apr_now / spread_apr_14d", "funding of the highest-funding leg minus the lowest (xdex)", "fraction", "derived"],
    ["basis_pct", "mark of the first leg / mark of the second − 1 (xdex), or perp / spot − 1 (spot-perp)", "%", "markPx"],
    ["min_leg_vol24_usd", "24 h notional volume of the thinner leg", "USD", "dayNtlVlm"],
    ["oi_usd", "open interest × mark", "USD", "openInterest × markPx"],
    ["vol24_usd / vol24h_usd", "24 h notional volume", "USD", "dayNtlVlm"],
    ["spot.mark / spot_mark", "spot price of the same asset (U-tokens mapped: UBTC→BTC, UETH→ETH…)", "USD", "spotMetaAndAssetCtxs"],
    ["hours_above_threshold_14d", "hours in the last 336 with |funding| above the threshold (naked)", "hours", "our hourly history"],
    ["why_no_hedge", "no_spot (main dex) or no_spot_no_xdex_pair (HIP-3)", "enum", "derived"],
    ["status", "active · zero_oi · delisted (watchdog)", "enum", "meta + our snapshots"],
    ["oi_change_7d_pct / vol_change_7d_pct", "change versus the snapshot 7 days earlier (null until 7 days of snapshots exist)", "%", "our snapshots"],
    ["src", "snapshot (recorded by us at :03 every hour) or history (recovered from Hyperliquid's 500 h window)", "enum", "—"],
  ];
  const blocks = Object.entries(ex).map(([r, v]) => `<h3><code>GET /v1/carry/${escH(r)}</code></h3><pre>${escH(JSON.stringify(v, null, 2))}</pre>`).join("");
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Carry Oracle docs — Degenscan Intel</title>
<style>body{font-family:system-ui,sans-serif;max-width:920px;margin:0 auto;padding:24px 16px;background:#0b0d10;color:#e8eaed;line-height:1.55}a{color:#7cc4ff}pre{background:#151a21;border-radius:8px;padding:12px;overflow:auto;font-size:12.5px;max-height:420px}code{background:#151a21;padding:1px 5px;border-radius:5px}table{border-collapse:collapse;width:100%;font-size:14px}td,th{border:1px solid #2a2f36;padding:6px 8px;text-align:left;vertical-align:top}</style>
<h1>Carry Oracle — API docs</h1>
<p>Hourly funding for every perp on every Hyperliquid dex (main + HIP-3), kept beyond the 500 h the Hyperliquid API returns. Below: <b>real responses</b> from the latest hourly snapshot, truncated to a few rows (subscribers get every row, in real time).</p>
<p><b>Free trial key:</b> <code>POST /v1/keys/trial {"email":"you@example.com"}</code> → <code>dsi_trial_…</code>, 200 calls, 7 days, no card (or the form on <a href="/carry#trial">/carry</a>). Leaderboard (public, 1 h delay): <a href="/carry/leaderboard">/carry/leaderboard</a>.</p>
<p><b>Access:</b> header <code>X-API-KEY: dsi_carry_…</code>. <b>Price:</b> US$100/month flat, unlimited calls. Card: <a href="/v1/carry/checkout">/v1/carry/checkout</a> · USDC (x402, Base or Solana): <code>POST /v1/keys/x402/carry_month</code> = 30 days. MCP tools <code>carry_*</code> at <code>/mcp</code>. Without a key every route answers <code>402</code> with how to pay. Free: <a href="/v1/carry/stats">/v1/carry/stats</a>. Product page: <a href="/carry">/carry</a>.</p>
<p><b>Query parameters:</b> funding-matrix <code>?dex=xyz&amp;min_vol=</code> · xdex / spot-perp <code>?min_vol=100000&amp;limit=50</code> · history <code>/{coin}?hours=720</code> (HIP-3 coins prefixed, e.g. <code>xyz:NBIS</code>) · naked <code>?min_abs_apr=0.5&amp;min_vol=</code>.</p>
${blocks || "<p>(samples appear after the first hourly snapshot)</p>"}
<h2>Pay per call (USDC, x402) — no subscription</h2><table><tr><th>route</th><th>US$ per call</th><th>prepaid-pack credits</th></tr><tr><td>funding-matrix</td><td>0.03</td><td>30</td></tr><tr><td>xdex</td><td>0.05</td><td>50</td></tr><tr><td>spot-perp</td><td>0.03</td><td>30</td></tr><tr><td>history/{coin}</td><td>0.02</td><td>20</td></tr><tr><td>naked</td><td>0.01</td><td>10</td></tr><tr><td>watchdog</td><td>0.01</td><td>10</td></tr></table><p>Call without a key, answer the 402 with USDC on Base or Solana. Around 3,000 calls/month the flat US$100 subscription is cheaper.</p>
<h2>Carry Desk routes (subscription only: US$450/month · US$4,500/year · limited seats)</h2>
<ul><li><code>GET /v1/carry/eligible</code> — per pair: <code>checks{}</code> (value, threshold, pass) for spread_apr_14d ≥ entry_apr (0.10), share_positive_14d ≥ 0.65, corr_1h_14d ≥ 0.90 (xdex), basis_range_pct ≤ 4, min_liquidity_usd ≥ 1M, breakeven_days_taker ≤ 7; <code>eligible</code>, <code>score</code>, <code>rank</code>, <code>since</code>. Override: <code>?entry_apr=0.12&amp;min_corr=0.95&amp;fee_bps=4.5&amp;only=eligible</code>.</li>
<li><code>GET /v1/carry/capacity?capital=100000&amp;lev=3&amp;max_pairs=4</code> — per leg cap = min(1% × vol24h, 25% × depth within 20 bps on the side the leg hits, 5% × OI); pair notional and margin at 1/2/3/5x; allocation with <code>unallocated_by_liquidity_usd</code>.</li>
<li><code>GET /v1/carry/realized</code> · <code>/v1/carry/realized/{pair_key}</code> — 168/336/720 h: funding received, four taker fees, basis drift, net % of notional and of margin at 3x, max adverse basis. Past performance; no guarantee.</li>
<li><code>GET /v1/carry/afterhours</code> · <code>/v1/carry/afterhours/{coin}</code> — HIP-3 perps vs the last US regular-session close (NYSE calendar): reference, premium now, hourly premium series since the close, funding in the window.</li>
<li><code>POST /v1/carry/alerts</code> <code>{type, filter, channel:"webhook", target:"https://…"}</code> · <code>GET /v1/carry/alerts</code> · <code>DELETE /v1/carry/alerts/{id}</code> — types: eligible_on, eligible_off, naked_extreme (<code>filter.min_abs_apr</code>), watchdog_flag, afterhours_premium (<code>filter.min_abs_premium_pct</code>); filter by <code>pair</code>/<code>coin</code>/<code>dex</code>. Webhooks are signed: <code>X-Carry-Signature</code> = hex HMAC-SHA256(secret, raw body). Evaluated after each hourly snapshot.</li></ul>
<h2 id="method">Method</h2><ul>
<li><b>Spread</b> (xdex): hourly funding of the higher-funding leg (short) minus the lower (long), from our hourly store; spot-perp: perp funding (short perp, hold spot — negative funding is not carry because spot cannot be shorted on Hyperliquid).</li>
<li><b>Correlation and basis</b>: 1h candle closes of both legs over 336 h (Hyperliquid candleSnapshot); basis = ln(short/long) × 100; range = max − min; σ = standard deviation.</li>
<li><b>Break-even</b>: four taker fills (fee_bps each, default 4.5) ÷ (spread_apr_14d ÷ 365).</li>
<li><b>Score</b>: (spread_apr_14d − 2σ_basis × 365/30) × share_positive_14d, × 0.6 for spot-perp. A ranking aid, not a forecast.</li>
<li><b>Realized</b>: Σ hourly spread − four fees − basis drift (end − start of ln ratio); margin at 3x = net × 3/2 (xdex) or × 3/4 (spot-perp).</li>
<li><b>After-hours reference</b>: Hyperliquid oracle at the snapshot taken at/just before the US close (the oracle tracks the underlying during the session) — an approximation of the official close; fallback: 1h mark candle at the close.</li></ul>
<h2>Field dictionary</h2><table><tr><th>field</th><th>meaning</th><th>unit</th><th>source</th></tr>${dict.map(r => `<tr>${r.map(c => `<td>${escH(c)}</td>`).join("")}</tr>`).join("")}</table>
<p style="color:#9aa0a6">Every value can be checked against Hyperliquid's public API. Marbella Collins LLC · contact@degenscan.io · ${D}</p></html>`;
  docsCache = { at: Date.now(), html };
  return html;
}
