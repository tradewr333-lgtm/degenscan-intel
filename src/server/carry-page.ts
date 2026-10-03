import { CARRY } from "./keys.js";
import { carryStats } from "../carry/hl.js";

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
      "<b>/v1/carry/xdex</b> — o mesmo ativo em 2 ou mais dexes: spread de funding agora e em 14 dias, % de horas positivas, basis e liquidez da perna menor",
      "<b>/v1/carry/history/{coin}</b> — série horária (funding, premium, mark, OI, volume) desde o início da coleta; HIP-3 com prefixo, ex.: <code>xyz:NBIS</code>",
      "Tudo em tempo real, atualizado de hora em hora"],
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
      "<b>/v1/carry/xdex</b> — the same asset on 2+ dexes: funding spread now and over 14 days, % positive hours, basis and the thinner leg's liquidity",
      "<b>/v1/carry/history/{coin}</b> — hourly series (funding, premium, mark, OI, volume) since collection began; HIP-3 coins are prefixed, e.g. <code>xyz:NBIS</code>",
      "All real time, refreshed hourly"],
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
<div class="box"><div class="price">${T.price}</div><div class="sub">${T.priceSub}</div>
<a class="btn b1" href="/v1/carry/checkout">${T.card}</a><a class="btn b2" href="#usdc">${T.usdc}</a>
<p id="usdc" class="sub">${T.usdcHow}</p></div>
<h2>${T.what}</h2><ul>${T.items.map(i => `<li>${i}</li>`).join("")}</ul>
<h2>${T.data}</h2><div class="box stats"><div><b>${(f.rows ?? 0).toLocaleString(pt ? "pt-BR" : "en-US")}</b>${T.rows}</div><div><b>${f.coins ?? 0}</b>${T.coins}</div><div><b>${f.dexes ?? 0}</b>${T.dexes}</div><div><b>${since}</b>${T.from}</div></div>
<h2>${T.use}</h2><p>${T.useTxt}</p><pre>curl -H "X-API-KEY: dsi_carry_…" https://intel.degenscan.io/v1/carry/xdex</pre>
<h2>${T.not}</h2><p>${T.notTxt}</p>
<p><a href="/carry${pt ? "?lang=en" : ""}">${pt ? "English" : "Português"}</a> · <a href="/v1/carry/stats">/v1/carry/stats</a> · <a href="/pricing${pt ? "" : "?lang=en"}">${pt ? "Outros planos" : "Other plans"}</a></p>
<p class="sub">Marbella Collins LLC · contact@degenscan.io · ${T.disc} US$${CARRY.usd_month}/${pt ? "mês" : "month"}.</p></html>`;
}
