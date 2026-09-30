/** /previsoes (pt, default) and /predictions (en): a market-style view of the oracle board for humans — one card per question,
 *  oracle probability vs the Polymarket price, category tabs, countdown, result badge once resolved, and the commitment hash as proof.
 *  Same data as /v1/oracle/board (free here, no API key). Rows excluded from measurement are hidden (their market odds are wrong).
 *  Information and analytics only — not investment advice. */
import { boardLatest, trackRecord } from "../oracle/ledger.js";

type Lang = "pt" | "en";
const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" } as any)[c]);

/** Hand-written Portuguese titles for curated rows; generated price rows get a template; Polymarket rows keep their own text. */
const PT_TITLES: Record<string, string> = {
  "br-1t-outright-2026": "Algum candidato vence a eleição já no 1º turno (04/10)?",
  "br-1t-lula-most-votes-2026": "Lula é o mais votado no 1º turno (04/10)?",
  "br-1t-flavio-second-2026": "Flávio Bolsonaro termina em 2º lugar no 1º turno (04/10)?",
  "br-president-lula-2026": "Lula vence a eleição presidencial de 2026?",
  "br-president-flavio-2026": "Flávio Bolsonaro vence a eleição presidencial de 2026?",
  "fed-cut-oct2026": "O Fed corta os juros na reunião de outubro?",
  "copom-cut-nov2026": "O Copom corta a Selic na reunião de novembro?",
  "btc-120k-oct31": "Bitcoin fecha acima de US$120.000 em 31/10?",
  "eth-5k-touch-oct31": "Ethereum passa de US$5.000 antes de 31/10?",
  "sol-vs-eth-rvol-oct31": "Solana termina outubro mais volátil que Ethereum (vol. 30 dias)?",
  "crypto-mcap-up-oct2026": "O mercado cripto total termina outubro maior que em 30/09?",
  "spx-oct-above-sep-2026": "O S&P 500 fecha outubro acima do fechamento de setembro?",
  "btc-ath-oct2026": "Bitcoin faz nova máxima histórica até 31/10?",
};
const COIN: Record<string, string> = { BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana" };
function titleFor(slug: string, question: string, lang: Lang): string {
  if (lang === "en") return question;
  if (PT_TITLES[slug]) return PT_TITLES[slug];
  const ddmm = (iso: string) => iso.slice(8, 10) + "/" + iso.slice(5, 7);
  let m = question.match(/^Will (BTC|ETH|SOL) close (above|below) ([\d,]+) USD on (\d{4}-\d{2}-\d{2})/);
  if (m) return `${COIN[m[1]]} fecha ${m[2] === "above" ? "acima" : "abaixo"} de US$${m[3].replace(/,/g, ".")} em ${ddmm(m[4])}?`;
  m = question.match(/^Will (BTC|ETH|SOL) trade above ([\d,]+) USD at any point before (\d{4}-\d{2}-\d{2})/);
  if (m) return `${COIN[m[1]]} passa de US$${m[2].replace(/,/g, ".")} antes de ${ddmm(m[3])}?`;
  return question;
}
export function categoryOf(slug: string, question: string): "eleicoes" | "juros" | "cripto" | "bolsa" | "outros" {
  const q = question.toLowerCase();
  if (slug.startsWith("br-") || /\b(election|elei|president)/.test(q)) return "eleicoes";
  if (/\b(fed|fomc|interest rate|copom|selic|rate cut|bps)\b/.test(q)) return "juros";
  if (/\b(bitcoin|btc|ethereum|eth|solana|sol|crypto)\b/.test(q)) return "cripto";
  if (/\b(s&p|nasdaq|dow|stock)\b/.test(q)) return "bolsa";
  return "outros";
}
const CAT_LABEL: Record<Lang, Record<string, string>> = {
  pt: { all: "Todas", eleicoes: "Eleições Brasil", juros: "Juros", cripto: "Cripto", bolsa: "Bolsa", outros: "Outras" },
  en: { all: "All", eleicoes: "Brazil election", juros: "Rates", cripto: "Crypto", bolsa: "Stocks", outros: "Other" },
};
const CAT_ORDER = ["eleicoes", "juros", "cripto", "bolsa", "outros"];

export function predictionsPage(lang: Lang = "pt"): string {
  const T = lang === "pt" ? {
    title: "Previsões do Oráculo Degenscan", h1: "Previsões do Oráculo",
    lead: "Probabilidades calculadas por IA para eventos de mercado e política, lado a lado com o preço do Polymarket. Cada número é <b>travado com um código (hash) antes do resultado</b> e depois é julgado em público — acertos e erros.",
    oracle: "Oráculo", market: "Polymarket", nomarket: "sem mercado", resolves: "resolve em", days: (d: number) => d <= 0 ? "hoje" : d === 1 ? "1 dia" : `${d} dias`,
    above: (x: number) => `oráculo ${x} pts acima do mercado`, below: (x: number) => `oráculo ${x} pts abaixo do mercado`, same: "oráculo e mercado concordam",
    proof: "🔒 prova", yes: "✅ Aconteceu", no: "❌ Não aconteceu", updated: "Recalculado todo dia às 06:00 UTC (03:00 de Brasília).",
    stats: ["em aberto", "resolvidas", "nota Brier (0,25 = cara ou coroa)"], how: "Como funciona",
    howItems: ["Várias equipes de IA debatem cada pergunta usando dados reais (preços, volatilidade, Polymarket, Banco Central, Fed).", "O resultado é uma probabilidade — não uma recomendação. 67% quer dizer: em 100 situações assim, esperamos que aconteça ~67 vezes.", "O número é travado com hash antes do evento. Depois do resultado, a nota (Brier) mostra se o oráculo foi melhor ou pior que o mercado."],
    foot: `Robô que opera no papel usando estas previsões: <a href="/bot">/bot</a> · Tabela técnica: <a href="/oracle">/oracle</a> · API para desenvolvedores: <a href="/pricing">/pricing</a> · <a href="/predictions">English</a>`,
    disc: "Informação e análise, não é recomendação de investimento nem de aposta. Operado por Marbella Collins LLC.",
  } : {
    title: "Degenscan Oracle — predictions", h1: "Oracle predictions",
    lead: "AI-computed probabilities for market and political events, side by side with the Polymarket price. Every number is <b>locked with a hash before the outcome</b> and then scored in public — hits and misses.",
    oracle: "Oracle", market: "Polymarket", nomarket: "no market", resolves: "resolves in", days: (d: number) => d <= 0 ? "today" : d === 1 ? "1 day" : `${d} days`,
    above: (x: number) => `oracle ${x} pts above the market`, below: (x: number) => `oracle ${x} pts below the market`, same: "oracle and market agree",
    proof: "🔒 proof", yes: "✅ Happened", no: "❌ Did not happen", updated: "Recomputed daily at 06:00 UTC.",
    stats: ["open", "resolved", "Brier score (0.25 = coin flip)"], how: "How it works",
    howItems: ["Several AI teams debate each question using real data (prices, volatility, Polymarket, central banks).", "The output is a probability — not a recommendation. 67% means: in 100 situations like this, we expect it to happen ~67 times.", "The number is locked with a hash before the event. After the outcome, the Brier score shows whether the oracle beat the market."],
    foot: `Paper bot trading on these forecasts: <a href="/bot?lang=en">/bot</a> · Technical table: <a href="/oracle">/oracle</a> · Developer API: <a href="/pricing">/pricing</a> · <a href="/previsoes">Português</a>`,
    disc: "Information and analytics only — not investment or betting advice. Operated by Marbella Collins LLC.",
  };
  const rows = boardLatest().filter((r: any) => !r.measurement_exclude);
  const tr: any = trackRecord();
  const now = Date.now();
  const pct = (x: number) => Math.round(x * 1000) / 10;
  const fmt = (x: number) => (lang === "pt" ? pct(x).toFixed(1).replace(".", ",") : pct(x).toFixed(1)) + "%";
  const cards = rows.map((r: any) => {
    const cat = categoryOf(String(r.slug), String(r.question));
    const p = Number(r.probability); const mk = r.market_odds == null ? null : Number(r.market_odds);
    const days = Math.ceil((Date.parse(r.resolves_at) - now) / 86_400_000);
    const diff = mk == null ? null : Math.round((p - mk) * 100);
    const diffTxt = diff == null ? "" : Math.abs(diff) < 1 ? T.same : diff > 0 ? T.above(diff) : T.below(-diff);
    const resolved = r.outcome != null;
    const badge = resolved ? `<span class="res ${r.outcome ? "y" : "n"}">${r.outcome ? T.yes : T.no}</span>` : `<span class="due">${T.resolves} ${T.days(days)}</span>`;
    const pmLink = r.market_ref ? `<a href="${esc(r.market_ref)}" rel="noopener" target="_blank">${T.market}</a>` : T.market;
    return `<article class="card" data-cat="${cat}" data-sort="${resolved ? 1 : 0}-${String(r.resolves_at)}">
<div class="top"><span class="chip">${esc(CAT_LABEL[lang][cat])}</span>${badge}</div>
<h3>${esc(titleFor(String(r.slug), String(r.question), lang))}</h3>
<div class="row"><span class="lbl">${T.oracle}</span><div class="bar"><i style="width:${pct(p)}%"></i></div><b class="big">${fmt(p)}</b></div>
<div class="row mk"><span class="lbl">${pmLink}</span><div class="bar"><i style="width:${mk == null ? 0 : pct(mk)}%"></i></div><b>${mk == null ? T.nomarket : fmt(mk)}</b></div>
<div class="foot"><span class="m">${esc(diffTxt)}</span><a class="h" href="/v1/oracle/forecast/${esc(r.id)}" title="sha256 ${esc(r.commitment_hash)}">${T.proof} ${esc(String(r.commitment_hash).slice(0, 8))}</a></div>
</article>`;
  });
  const present = new Set(rows.map((r: any) => categoryOf(String(r.slug), String(r.question))));
  const tabs = [`<button class="on" data-f="all">${CAT_LABEL[lang].all} <small>${rows.length}</small></button>`, ...CAT_ORDER.filter(c => present.has(c as any)).map(c => `<button data-f="${c}">${CAT_LABEL[lang][c]} <small>${rows.filter((r: any) => categoryOf(String(r.slug), String(r.question)) === c).length}</small></button>`)].join("");
  return `<!doctype html><html lang="${lang === "pt" ? "pt-BR" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${T.title}</title>
<meta name="description" content="${lang === "pt" ? "Probabilidades do oráculo de IA vs Polymarket, travadas com hash antes do resultado." : "AI oracle probabilities vs Polymarket, hash-committed before the outcome."}">
<style>
:root{--bg:#0b0d10;--card:#12161b;--line:#232a32;--text:#e8eaed;--mute:#9aa0a6;--acc:#4f8cff;--mk:#8b93a1;--y:#2ecc71;--n:#ff6b6b}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:1180px;margin:0 auto;padding:24px 16px 40px}a{color:#7cc4ff;text-decoration:none}a:hover{text-decoration:underline}
h1{margin:0 0 8px;font-size:28px}.lead{color:var(--mute);max-width:780px;line-height:1.5;margin:0 0 16px}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px;min-width:120px}.stat b{display:block;font-size:22px}.stat span{color:var(--mute);font-size:13px}
.tabs{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;margin-bottom:16px}.tabs button{flex:0 0 auto;background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:999px;padding:8px 14px;font-size:14px;cursor:pointer}.tabs button.on{background:var(--acc);border-color:var(--acc);color:#fff}.tabs small{opacity:.7;margin-left:4px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:10px}
.top{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:12px}.chip{background:#1b2230;color:#aac4ff;border-radius:999px;padding:3px 9px}.due{color:var(--mute)}
.res{font-weight:600;border-radius:999px;padding:3px 9px}.res.y{background:rgba(46,204,113,.15);color:var(--y)}.res.n{background:rgba(255,107,107,.15);color:var(--n)}
h3{margin:0;font-size:16px;line-height:1.35;font-weight:600;min-height:43px}
.row{display:grid;grid-template-columns:86px 1fr 62px;align-items:center;gap:8px;font-size:13px}.row .lbl{color:var(--mute)}.row b{text-align:right}.row b.big{font-size:20px;color:#fff}
.bar{height:8px;background:#1d232b;border-radius:99px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc);border-radius:99px}.mk .bar i{background:var(--mk)}
.foot{display:flex;justify-content:space-between;gap:8px;font-size:12px;border-top:1px solid var(--line);padding-top:8px}.m{color:var(--mute)}.h{font-family:ui-monospace,Menlo,monospace;white-space:nowrap}
.how{margin-top:28px;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.how h2{margin:0 0 8px;font-size:18px}.how li{color:var(--mute);line-height:1.5;margin:4px 0}
.small{color:var(--mute);font-size:13px;margin-top:16px;line-height:1.6}
@media (max-width:420px){h1{font-size:23px}.row{grid-template-columns:74px 1fr 58px}}
</style>
<div class="wrap">
<h1>${T.h1}</h1><p class="lead">${T.lead}</p>
<div class="stats"><div class="stat"><b>${tr.n_pending}</b><span>${T.stats[0]}</span></div><div class="stat"><b>${tr.resolved}</b><span>${T.stats[1]}</span></div><div class="stat"><b>${tr.brier ?? "—"}</b><span>${T.stats[2]}</span></div></div>
<nav class="tabs">${tabs}</nav>
<section class="grid" id="g">${cards.join("")}</section>
<div class="how"><h2>${T.how}</h2><ol>${T.howItems.map(x => `<li>${x}</li>`).join("")}</ol><p class="m">${T.updated}</p></div>
<p class="small">${T.foot}</p><p class="small">${T.disc}</p>
</div>
<script>
(function(){var g=document.getElementById("g");var cs=[].slice.call(g.children);cs.sort(function(a,b){return a.dataset.sort<b.dataset.sort?-1:1});cs.forEach(function(c){g.appendChild(c)});
var bs=document.querySelectorAll(".tabs button");bs.forEach(function(b){b.onclick=function(){bs.forEach(function(x){x.classList.remove("on")});b.classList.add("on");var f=b.dataset.f;cs.forEach(function(c){c.style.display=(f==="all"||c.dataset.cat===f)?"":"none"})}});
var p=new URLSearchParams(location.search).get("cat");if(p){var t=document.querySelector('.tabs button[data-f="'+p+'"]');if(t)t.click()}})();
</script></html>`;
}
