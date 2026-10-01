/** "Pergunte ao Oráculo" — the human product (Renato 30/09): a browser app on top of the same API key a subscriber gets from Stripe.
 *    GET  /app  (/app?lang=en)          page: paste/remember key, ask a yes/no question with a date, see result, history
 *    GET  /v1/me                        X-API-KEY → plan, calls left this month, forecasts left (forecast = 125 credits)
 *    GET  /v1/me/forecasts              X-API-KEY → this key's forecasts (newest first) with status
 *    GET  /v1/oracle/forecast/:id/pt    free → Portuguese rendering of summary / drivers / failure modes (cached; presentation only,
 *                                        the committed forecast and its hash are untouched)
 *  Nothing here places bets, connects wallets or acts for the user. Information and analytics only — not investment advice. */
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { validateKey, PLANS, PACKS } from "./keys.js";
import { creditsFor } from "./pricing.js";
import { getDb } from "../store/db.js";
import { getForecast, getJob, ensureOracleTables } from "../oracle/ledger.js";
import { deepseekChat, extractJson, newUsage } from "../oracle/llm.js";

const keyOf = (req: any) => String(req.headers["x-api-key"] ?? "").trim();

export function installAppRoutes(app: FastifyInstance) {
  ensureOracleTables();
  getDb().exec("CREATE TABLE IF NOT EXISTS oracle_translations (id TEXT NOT NULL, lang TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (id, lang))");

  app.get("/v1/me", async (req: any, reply) => {
    const v = validateKey(keyOf(req));
    if (!v) { reply.code(401); return { error: "invalid or inactive API key" }; }
    const plan = getDb().prepare("SELECT plan, monthly_calls, total_calls, email, created_at FROM api_keys WHERE id = ?").get(v.id) as any;
    const per = creditsFor("oracle_forecast");
    const pid = String(plan?.plan ?? v.plan); const pname = (PLANS as any)[pid]?.name ?? (PACKS as any)[pid]?.name ?? pid;
    return { key_id: v.id, plan: pid, plan_name: pname, calls_left: v.remaining, forecasts_left: Math.floor(v.remaining / per), credits_per_forecast: per,
      budget: plan?.total_calls ?? plan?.monthly_calls ?? null, period: plan?.total_calls != null ? "lifetime" : "month", since: plan?.created_at ?? null };
  });

  app.get("/v1/me/forecasts", async (req: any, reply) => {
    const v = validateKey(keyOf(req)) ?? invalidButKnown(keyOf(req));
    if (!v) { reply.code(401); return { error: "invalid API key" }; }
    const jobs = getDb().prepare("SELECT id, status, request, created_at, error FROM oracle_jobs WHERE payer = ? ORDER BY created_at DESC LIMIT 100").all(`key:${v.id}`) as any[];
    return { items: jobs.map(j => {
      const f = getForecast(j.id); let q = ""; try { q = JSON.parse(j.request).question; } catch { /* */ }
      return f ? { id: j.id, status: "done", question: f.question, created_at: f.created_at, resolves_at: f.resolves_at, probability: f.probability, market_odds: f.market_odds, commitment_hash: f.commitment_hash, outcome: (f as any).outcome ?? null }
               : { id: j.id, status: j.status, question: q, created_at: j.created_at, error: j.error };
    }) };
  });

  app.get("/v1/oracle/forecast/:id/pt", async (req: any, reply) => {
    const id = String(req.params.id); const f = getForecast(id);
    if (!f) { reply.code(404); return { error: getJob(id) ? "forecast not finished yet" : "unknown forecast_id" }; }
    const cached = getDb().prepare("SELECT body FROM oracle_translations WHERE id = ? AND lang = 'pt'").get(id) as any;
    if (cached) return JSON.parse(cached.body);
    const src = { question: f.question, summary: f.summary, drivers: f.drivers ?? [], failure_modes: f.failure_modes ?? [] };
    let out: any = src;
    if (process.env.DEEPSEEK_API_KEY) {
      try {
        const raw = await deepseekChat("You translate forecasting reports into Brazilian Portuguese. Keep numbers, names and meaning exactly; do not add advice. Return JSON with the same keys.", JSON.stringify(src), { temperature: 0 }, newUsage());
        const j = typeof raw === "string" ? extractJson(raw) : raw;
        if (j && typeof j.summary === "string") out = { question: String(j.question ?? src.question), summary: j.summary, drivers: Array.isArray(j.drivers) ? j.drivers.map(String) : src.drivers, failure_modes: Array.isArray(j.failure_modes) ? j.failure_modes.map(String) : src.failure_modes };
      } catch { out = src; }
    }
    if (out !== src) getDb().prepare("INSERT OR REPLACE INTO oracle_translations (id, lang, body, created_at) VALUES (?,?,?,?)").run(id, "pt", JSON.stringify(out), new Date().toISOString());
    return { ...out, translated: out !== src };
  });

  app.get("/app", async (req: any, reply) => reply.type("text/html; charset=utf-8").send(appPage(req.query?.lang === "en" ? "en" : "pt")));
}

/** History must stay readable after the monthly quota runs out: accept an active key even with 0 remaining. */
function invalidButKnown(raw: string): { id: string } | null {
  if (!raw) return null;
  const row = getDb().prepare("SELECT id FROM api_keys WHERE key_hash = ? AND status = 'active'").get(createHash("sha256").update(raw).digest("hex")) as any;
  return row ? { id: row.id } : null;
}

export function appPage(lang: "pt" | "en" = "pt"): string {
  const pt = lang === "pt";
  const T = pt ? {
    title: "Pergunte ao Oráculo — Degenscan", h1: "Pergunte ao Oráculo",
    lead: "Escreva uma pergunta de <b>sim ou não</b> com data. Em poucos minutos o oráculo devolve a <b>probabilidade</b>, os motivos e uma prova travada com hash. Não é recomendação: é a chance estimada de acontecer.",
    keyH: "Sua chave de acesso", keyP: "Cole a chave que apareceu depois da assinatura (começa com <code>dsi_</code>). Ela fica salva só neste navegador.", keySave: "Salvar chave", noKey: "Ainda não assina?", sub: "Ver planos",
    plan: "Plano", left: "perguntas restantes este mês", change: "trocar chave",
    qL: "Sua pergunta", qPh: "Ex.: O Bitcoin fecha outubro de 2026 acima de US$ 100.000?", dL: "Resolve em (data)", ask: "Perguntar ao oráculo",
    tips: ["Faça perguntas com resposta clara de sim ou não e uma data.", "O oráculo tem dados ao vivo para cripto (BTC, ETH, SOL), juros (Fed, Copom/Selic), S&P 500 e mercados do Polymarket (ex.: eleições). Fora desses temas ele pode usar informação desatualizada.", "Cada pergunta usa 1 das suas perguntas do mês."],
    running: "O oráculo está analisando… (leva de 1 a 4 minutos; pode deixar esta página aberta)", queued: "Na fila…", failed: "Não foi possível concluir. Tente de novo ou escreva para contact@degenscan.io com o código:",
    prob: "Probabilidade de SIM", range: "faixa provável", market: "Polymarket", nomarket: "Sem mercado equivalente no Polymarket", why: "Por que", risks: "O que pode fazer errar", proof: "Prova (hash)", conf: { low: "confiança baixa", medium: "confiança média", high: "confiança alta" },
    hist: "Suas perguntas", histEmpty: "Você ainda não fez perguntas.", pend: "aguardando resultado", see: "ver",
    errKey: "Chave inválida ou sem saldo este mês.",
    facts: "Fatos verificados ao vivo", src: "fonte", dHint: "Data preenchida a partir da sua pergunta — confira.",
    checking: "Verificando os fatos da pergunta ao vivo (Wikidata, notícias)…",
    unver: "Não consigo verificar os fatos de que esta pergunta depende, então não vou dar um número. Esta pergunta NÃO foi descontada do seu plano. Tente reformular citando nomes, cargos ou valores concretos.",
    stale: "⚠️ Tema sem dados ao vivo: o oráculo não encontrou preço, mercado do Polymarket nem dado oficial para esta pergunta e pode ter usado informação desatualizada (por exemplo, sobre quem ocupa um cargo hoje). Use com cautela.", errQ: "A caixa da pergunta está vazia — o texto cinza é só um exemplo. Clique num dos exemplos azuis acima ou escreva a sua pergunta.",
    exH: "Toque num exemplo para preencher (depois é só clicar em Perguntar):",
    ex: [["Bitcoin acima de US$ 100 mil em 31/10?", "O Bitcoin fecha em 31/10/2026 acima de US$ 100.000?", "2026-10-31"], ["Selic cai em dezembro?", "O Copom corta a taxa Selic na reunião de dezembro de 2026?", "2026-12-10"], ["Fed corta em dezembro?", "O Federal Reserve corta os juros na reunião de dezembro de 2026?", "2026-12-10"], ["S&P 500 sobe em outubro?", "O S&P 500 fecha outubro de 2026 acima do fechamento de setembro?", "2026-10-30"], ["Ethereum acima de US$ 5.000?", "O Ethereum passa de US$ 5.000 antes de 31/12/2026?", "2026-12-31"]], errQuota: "Suas perguntas deste mês acabaram. Elas renovam no dia 1º.",
    links: `Placar público: <a href="/previsoes">/previsoes</a> · Robô (simulação): <a href="/bot">/bot</a> · Dúvidas: <a href="/ajuda">/ajuda</a> · <a href="/app?lang=en">English</a>`,
    disc: "Informação e análise, não é recomendação de investimento nem de aposta. O Degenscan não opera, não aposta e não acessa carteira em seu nome. Operado por Marbella Collins LLC.",
  } : {
    title: "Ask the Oracle — Degenscan", h1: "Ask the Oracle",
    lead: "Write a <b>yes/no</b> question with a date. In a few minutes the oracle returns the <b>probability</b>, its reasons and a hash-locked proof. Not a recommendation: an estimated chance.",
    keyH: "Your access key", keyP: "Paste the key shown after you subscribed (starts with <code>dsi_</code>). It is stored only in this browser.", keySave: "Save key", noKey: "Not subscribed yet?", sub: "See plans",
    plan: "Plan", left: "questions left this month", change: "change key",
    qL: "Your question", qPh: "E.g. Will Bitcoin close October 2026 above $100,000?", dL: "Resolves on (date)", ask: "Ask the oracle",
    tips: ["Ask questions with a clear yes/no answer and a date.", "Live data covers crypto (BTC, ETH, SOL), rates (Fed, Copom/Selic), the S&P 500 and Polymarket markets (e.g. elections). Outside these topics it may rely on outdated information.", "Each question uses 1 of your monthly questions."],
    running: "The oracle is working… (1–4 minutes; you can keep this page open)", queued: "Queued…", failed: "Could not finish. Try again or email contact@degenscan.io with this id:",
    prob: "Probability of YES", range: "likely range", market: "Polymarket", nomarket: "No matching Polymarket market", why: "Why", risks: "What could make it wrong", proof: "Proof (hash)", conf: { low: "low confidence", medium: "medium confidence", high: "high confidence" },
    hist: "Your questions", histEmpty: "No questions yet.", pend: "awaiting outcome", see: "view",
    errKey: "Invalid key or no quota left this month.",
    facts: "Facts verified live", src: "source", dHint: "Date filled in from your question — please check.",
    checking: "Checking the question's facts live (Wikidata, news)…",
    unver: "I cannot verify the facts this question depends on, so I will not give a number. This question was NOT charged. Try rephrasing with concrete names, offices or values.",
    stale: "⚠️ No live data for this topic: the oracle found no price, Polymarket market or official data for this question and may have used outdated information (e.g. who holds an office today). Use with care.", errQ: "The question box is empty — the grey text is only an example. Tap one of the blue examples above or write your own.",
    exH: "Tap an example to fill it in (then click Ask):",
    ex: [["Bitcoin above $100k on Oct 31?", "Will Bitcoin close above $100,000 on 2026-10-31?", "2026-10-31"], ["Fed cuts in December?", "Will the Federal Reserve cut rates at its December 2026 meeting?", "2026-12-10"], ["S&P 500 above 7,000?", "Will the S&P 500 close 2026 above 7,000?", "2026-12-31"], ["Ethereum above $5,000?", "Will Ethereum trade above $5,000 before 2026-12-31?", "2026-12-31"]], errQuota: "You used all questions for this month. They renew on the 1st.",
    links: `Public board: <a href="/predictions">/predictions</a> · Paper bot: <a href="/bot?lang=en">/bot</a> · Help: <a href="/ajuda?lang=en">/help</a> · <a href="/app">Português</a>`,
    disc: "Information and analytics only — not investment or betting advice. Degenscan does not trade, bet or access any wallet on your behalf. Operated by Marbella Collins LLC.",
  };
  const J = JSON.stringify({ ...T, conf: T.conf, pt });
  return `<!doctype html><html lang="${pt ? "pt-BR" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${T.title}</title>
<style>
:root{--bg:#0b0d10;--card:#12161b;--line:#232a32;--text:#e8eaed;--mute:#9aa0a6;--acc:#4f8cff;--mk:#8b93a1;--y:#2ecc71;--n:#ff6b6b}
*{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:760px;margin:0 auto;padding:24px 16px 48px}a{color:#7cc4ff}h1{margin:0 0 8px;font-size:28px}.lead{color:var(--mute);line-height:1.5;margin:0 0 18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:0 0 14px}.card h2{margin:0 0 10px;font-size:17px}
label{display:block;font-size:13px;color:var(--mute);margin:10px 0 6px}input,textarea{width:100%;background:#0e1216;color:var(--text);border:1px solid var(--line);border-radius:10px;padding:11px 12px;font:inherit}textarea{min-height:84px;resize:vertical}
button{background:var(--acc);color:#fff;border:0;border-radius:10px;padding:11px 16px;font:inherit;font-weight:600;cursor:pointer;margin-top:12px}button[disabled]{opacity:.5;cursor:default}button.ghost{background:transparent;color:#7cc4ff;padding:0;margin:0;font-weight:400}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;justify-content:space-between}.m{color:var(--mute);font-size:13px}.err{color:var(--n);font-size:14px;margin-top:10px}
ul.tips{margin:10px 0 0;padding-left:18px;color:var(--mute);font-size:13px;line-height:1.5}
.big{font-size:44px;font-weight:700;line-height:1}.bar{height:10px;background:#1d232b;border-radius:99px;overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:var(--acc)}.mk .bar i{background:var(--mk)}
.res h3{margin:0 0 12px;font-size:17px;line-height:1.35}.res ul{color:var(--mute);line-height:1.5;padding-left:18px}.hash{font-family:ui-monospace,Menlo,monospace;font-size:12px;word-break:break-all;color:var(--mute)}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:s 1s linear infinite;vertical-align:-2px;margin-right:8px}@keyframes s{to{transform:rotate(360deg)}}
.hist a{display:flex;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid var(--line);color:var(--text);text-decoration:none}.hist a:first-child{border-top:0}.hist b{white-space:nowrap}
.small{color:var(--mute);font-size:13px;line-height:1.6;margin-top:14px}.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 4px}.chip{background:#1b2230;color:#aac4ff;border:1px solid #2b3a55;border-radius:999px;padding:8px 12px;font-weight:500;margin:0;font-size:14px}.chip:hover{background:#243049}.hide{display:none}
</style>
<div class="wrap">
<h1>${T.h1}</h1><p class="lead">${T.lead}</p>
<section class="card hide" id="keyBox"><h2>${T.keyH}</h2><p class="m">${T.keyP}</p><input id="key" placeholder="dsi_..." autocomplete="off"><button id="saveKey">${T.keySave}</button><div class="err hide" id="keyErr"></div><p class="m" style="margin-top:12px">${T.noKey} <a href="/pricing">${T.sub}</a></p></section>
<section class="hide" id="main">
<div class="card"><div class="row"><div><span class="m">${T.plan}</span> <b id="plan">—</b></div><div><b id="left">—</b> <span class="m">${T.left}</span></div><button class="ghost" id="chg">${T.change}</button></div></div>
<div class="card"><div class="m">${T.exH}</div><div class="chips">${T.ex.map((e, i) => `<button type="button" class="chip" data-i="${i}">${e[0]}</button>`).join("")}</div><label for="q">${T.qL}</label><textarea id="q" maxlength="500" placeholder="${T.qPh}"></textarea><label for="d">${T.dL}</label><input type="date" id="d"><div class="m hide" id="dHint" style="margin-top:6px">${T.dHint}</div><button id="ask">${T.ask}</button><div class="err hide" id="askErr"></div><ul class="tips">${T.tips.map(t => `<li>${t}</li>`).join("")}</ul></div>
<div class="card res hide" id="out"></div>
<div class="card"><h2>${T.hist}</h2><div class="hist" id="hist"><p class="m">${T.histEmpty}</p></div></div>
</section>
<p class="small">${T.links}</p><p class="small">${T.disc}</p>
</div>
<script>
(function(){var T=${J};var $=function(i){return document.getElementById(i)};var K=null;
function get(){try{return localStorage.getItem("dsi_key")}catch(e){return null}}function put(k){try{k?localStorage.setItem("dsi_key",k):localStorage.removeItem("dsi_key")}catch(e){}}
var h=new URLSearchParams(location.hash.slice(1)).get("key");if(h){put(h);history.replaceState(null,"",location.pathname+location.search)}
function api(p,o){o=o||{};o.headers=Object.assign({"x-api-key":K},o.headers||{});return fetch(p,o).then(function(r){return r.json().then(function(j){j._s=r.status;return j})})}
function pct(x){return x==null?"—":(Math.round(x*1000)/10).toFixed(1).replace(".",T.pt?",":".")+"%"}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function showKey(msg){$("main").classList.add("hide");$("keyBox").classList.remove("hide");if(msg){$("keyErr").textContent=msg;$("keyErr").classList.remove("hide")}}
function me(){return api("/v1/me").then(function(j){if(j._s!==200){showKey(T.errKey);return false}$("keyBox").classList.add("hide");$("main").classList.remove("hide");$("plan").textContent=j.plan_name||j.plan;$("left").textContent=j.forecasts_left;$("ask").disabled=j.forecasts_left<1;if(j.forecasts_left<1){$("askErr").textContent=T.errQuota;$("askErr").classList.remove("hide")}return true})}
function hist(){api("/v1/me/forecasts").then(function(j){var it=(j.items||[]);if(!it.length)return;$("hist").innerHTML=it.map(function(f){var r=f.status!=="done"?'<span class="m">'+(f.status==="failed"?"✖":"…")+'</span>':f.outcome==null?'<b>'+pct(f.probability)+'</b>':'<b>'+pct(f.probability)+' '+(f.outcome?"✅":"❌")+'</b>';return '<a href="#" data-id="'+esc(f.id)+'"><span>'+esc(f.question)+'<br><span class="m">'+esc(String(f.created_at).slice(0,10))+(f.resolves_at?' → '+esc(String(f.resolves_at).slice(0,10)):'')+'</span></span>'+r+'</a>'}).join("");[].forEach.call($("hist").querySelectorAll("a"),function(a){a.onclick=function(e){e.preventDefault();poll(a.dataset.id)}})})}
function render(f,tr){var o=$("out");var t=tr||f;var c=T.conf[f.confidence]||"";
var src=((f.context_used||{}).sources||[]).filter(function(x){return x!=="calendar"&&x!=="impact_for"});if(f.grounding==="verified"||f.grounding==="contradicted")src=[1];
var facts=(f.premises||[]).map(function(p){return '<li>'+(p.verified===true?'✅ ':p.verified==="contradicted"?'⚠️ ':'❔ ')+esc(p.fact||p.claim)+(p.source_url?' — <a href="'+esc(p.source_url)+'" target="_blank" rel="noopener">'+T.src+'</a>':'')+'</li>'}).join("");
o.innerHTML=(src.length?'':'<p class="err" style="margin:0 0 12px">'+T.stale+'</p>')+'<h3>'+esc(t.question||f.question)+'</h3><div class="m">'+T.prob+'</div><div class="big">'+pct(f.probability)+'</div><div class="bar"><i style="width:'+Math.round(f.probability*100)+'%"></i></div><div class="m">'+T.range+': '+pct(f.ci80&&f.ci80[0])+' – '+pct(f.ci80&&f.ci80[1])+(c?' · '+c:'')+'</div>'+
(f.market_odds!=null?'<div class="mk" style="margin-top:12px"><div class="m">'+(f.market_ref?'<a href="'+esc(f.market_ref)+'" target="_blank" rel="noopener">'+T.market+'</a>':T.market)+': <b>'+pct(f.market_odds)+'</b></div><div class="bar"><i style="width:'+Math.round(f.market_odds*100)+'%"></i></div></div>':'<p class="m">'+T.nomarket+'</p>')+
(facts?'<h2 style="margin-top:14px">'+T.facts+'</h2><ul>'+facts+'</ul>':'')+((f.warnings||[]).length&&f.grounding!=="verified"?'<p class="m">'+f.warnings.map(esc).join('<br>')+'</p>':'')+'<h2 style="margin-top:14px">'+T.why+'</h2><p>'+esc(t.summary)+'</p>'+((t.drivers||[]).length?'<ul>'+t.drivers.map(function(x){return'<li>'+esc(x)+'</li>'}).join("")+'</ul>':'')+
((t.failure_modes||[]).length?'<h2>'+T.risks+'</h2><ul>'+t.failure_modes.map(function(x){return'<li>'+esc(x)+'</li>'}).join("")+'</ul>':'')+
'<h2>'+T.proof+'</h2><div class="hash"><a href="/v1/oracle/forecast/'+esc(f.id)+'" target="_blank">'+esc(f.commitment_hash)+'</a></div>';o.classList.remove("hide")}
function poll(id){var o=$("out");o.classList.remove("hide");o.innerHTML='<p><span class="spin"></span>'+T.queued+'</p>';o.scrollIntoView({behavior:"smooth"});
(function tick(){fetch("/v1/oracle/forecast/"+encodeURIComponent(id)).then(function(r){return r.json()}).then(function(f){if(f.status==="done"){if(T.pt){fetch("/v1/oracle/forecast/"+encodeURIComponent(id)+"/pt").then(function(r){return r.json()}).then(function(t){render(f,t)}).catch(function(){render(f)})}else render(f);hist();me();return}
if(f.status==="failed"){o.innerHTML='<p class="err">'+T.failed+' '+esc(id)+'</p>';hist();return}o.innerHTML='<p><span class="spin"></span>'+(f.status==="running"?T.running:T.queued)+'</p>';setTimeout(tick,12000)}).catch(function(){setTimeout(tick,15000)})})()}
[].forEach.call(document.querySelectorAll(".chip"),function(b){b.onclick=function(){var e=T.ex[+b.dataset.i];$("q").value=e[1];$("d").value=e[2];$("askErr").classList.add("hide");$("q").focus()}});
$("saveKey").onclick=function(){var k=$("key").value.trim();if(!k)return;put(k);K=k;$("keyErr").classList.add("hide");me().then(function(ok){if(ok)hist()})};
$("chg").onclick=function(){put(null);K=null;$("key").value="";showKey()};
var dd=new Date(Date.now()+30*864e5);$("d").value=dd.toISOString().slice(0,10);$("d").min=new Date(Date.now()+864e5).toISOString().slice(0,10);
function dateFrom(q){var m=/\\b(\\d{1,2})\\/(\\d{1,2})\\/(20\\d{2})\\b/.exec(q);if(m)return m[3]+"-"+("0"+m[2]).slice(-2)+"-"+("0"+m[1]).slice(-2);m=/\\b(20\\d{2})-(\\d{2})-(\\d{2})\\b/.exec(q);if(m)return m[0];var M={janeiro:1,fevereiro:2,"março":3,marco:3,abril:4,maio:5,junho:6,julho:7,agosto:8,setembro:9,outubro:10,novembro:11,dezembro:12,january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};var r=/\\b(janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro|january|february|march|april|may|june|july|august|september|october|november|december)\\b(?:\\s+de)?\\s+(20\\d{2})/i.exec(q);if(r){var mo=M[r[1].toLowerCase()];var last=new Date(Date.UTC(+r[2],mo,0)).getUTCDate();return r[2]+"-"+("0"+mo).slice(-2)+"-"+("0"+last).slice(-2)}r=/\\b(?:fecha|fim de|end of|close)\\s+(20\\d{2})\\b|\\bem\\s+(20\\d{2})\\b|\\bin\\s+(20\\d{2})\\b/i.exec(q);if(r){var y=r[1]||r[2]||r[3];return y+"-12-31"}return null}
$("q").addEventListener("input",function(){var d=dateFrom($("q").value);if(d&&new Date(d+"T23:59:59Z").getTime()>Date.now()){$("d").value=d;$("dHint").classList.remove("hide")}});
$("ask").onclick=function(){var q=$("q").value.trim(),d=$("d").value;$("askErr").classList.add("hide");if(q.length<8||!d||new Date(d+"T23:59:59Z").getTime()<Date.now()){$("askErr").textContent=T.errQ;$("askErr").classList.remove("hide");return}
$("ask").disabled=true;$("askErr").innerHTML='<span class="m"><span class="spin"></span>'+T.checking+'</span>';$("askErr").classList.remove("hide");api("/v1/oracle/forecast",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:q,resolves_at:d+"T23:59:59Z",require_verified:true})}).then(function(j){$("ask").disabled=false;$("askErr").classList.add("hide");if(j._s===202&&j.forecast_id){$("q").value="";poll(j.forecast_id);hist()}else if(j._s===422){$("askErr").innerHTML=esc(T.unver)+((j.warnings||[]).length?'<br><span class="m">'+j.warnings.map(esc).join("<br>")+'</span>':"");$("askErr").classList.remove("hide")}else{$("askErr").textContent=(j._s===402?T.errQuota:(j.error||T.errKey));$("askErr").classList.remove("hide")}}).catch(function(){$("ask").disabled=false})};
K=get();if(K){me().then(function(ok){if(ok)hist()})}else showKey();})();
</script></html>`;
}
