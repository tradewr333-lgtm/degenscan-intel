/** /ajuda (pt) and /ajuda?lang=en (also /help): plain-language FAQ for subscribers who are not developers (Renato 30/09). */
import type { FastifyInstance } from "fastify";

const QA_PT: [string, string][] = [
  ["O que é o Oráculo Degenscan?", "Um sistema de IA que calcula a <b>probabilidade</b> de um evento acontecer — por exemplo, “o Fed corta os juros em dezembro?” ou “quem vence a eleição?”. Várias equipes de IA analisam a pergunta com dados reais (preços, volatilidade, Polymarket, bancos centrais) e o resultado é um número de 0% a 100%."],
  ["Isso é recomendação de investimento ou de aposta?", "<b>Não.</b> O oráculo diz a chance estimada de algo acontecer; não diz o que você deve comprar, vender ou apostar. O Degenscan não opera, não aposta e não acessa nenhuma carteira em seu nome."],
  ["Onde vejo as previsões de graça?", "Em <a href=\"/previsoes\">intel.degenscan.io/previsoes</a>: o placar público com as perguntas do dia (eleições, juros, cripto, bolsa), a previsão do oráculo ao lado do preço do Polymarket e, depois, se acertou ou errou. Não precisa de cadastro."],
  ["O que eu ganho assinando?", "Você passa a fazer <b>as suas próprias perguntas</b> em <a href=\"/app\">intel.degenscan.io/app</a>. No plano Hobby são 16 perguntas por mês. Cada resposta vem com a probabilidade, os motivos em português, o que pode fazer o oráculo errar e uma prova travada com código (hash)."],
  ["Como uso, passo a passo?", "1) Assine em <a href=\"/pricing\">/pricing</a> (se tiver cupom, clique em “Adicionar código” no pagamento). 2) Na tela seguinte, clique em <b>“Abrir o Oráculo”</b> — sua chave fica salva no navegador. 3) Escreva uma pergunta de sim ou não, escolha a data em que ela se resolve e clique em <b>“Perguntar ao oráculo”</b>. Em 1 a 4 minutos a resposta aparece. Suas perguntas ficam no histórico, na mesma página."],
  ["Que tipo de pergunta funciona melhor?", "Perguntas com resposta clara de <b>sim ou não</b> e uma <b>data</b>. Bons exemplos: “O Bitcoin fecha outubro de 2026 acima de US$ 100 mil?”, “O Copom corta a Selic em dezembro de 2026?”, “O S&amp;P 500 fecha 2026 acima de 7.000 pontos?”. Evite perguntas vagas (“o mercado vai bem?”) ou sem data."],
  ["Sobre quais temas ele tem dados ao vivo?", "Cripto (Bitcoin, Ethereum, Solana), juros (Fed, Copom/Selic), S&amp;P 500 e mercados listados no Polymarket (por exemplo, eleições). Nesses temas ele consulta preços, volatilidade, dados oficiais e o Polymarket no momento da pergunta. Fora deles (esportes, pessoas, notícias gerais) ele pode partir de informação desatualizada — a página avisa quando isso acontece."],
  ["O que é a “prova (hash)”?", "É um código gerado no momento da previsão a partir da pergunta, da probabilidade e da hora. Se alguém mudasse o número depois, o código não bateria. É o que permite dizer que a previsão foi feita <b>antes</b> do resultado."],
  ["O oráculo acerta?", "Ninguém acerta tudo — e o objetivo não é esse. O objetivo é ser <b>bem calibrado</b>: das coisas a que ele dá 70%, cerca de 70% devem acontecer. O placar público mede isso com a nota Brier (quanto menor, melhor; 0,25 é o mesmo que chutar). As primeiras resoluções públicas são em outubro de 2026."],
  ["Posso usar junto com o Polymarket?", "Cada cartão mostra o preço do Polymarket e tem um link para o mercado, só para comparação. O Polymarket é um site independente, não disponível em todos os países; o Degenscan não tem relação com ele e não indica apostas."],
  ["Perdi a chave. E agora?", "A chave aparece uma vez só, por segurança. Escreva para <a href=\"mailto:contact@degenscan.io\">contact@degenscan.io</a> com o e-mail usado na assinatura que geramos uma nova."],
  ["Como cancelo?", "Quando quiser, sem multa: responda o recibo da assinatura ou escreva para <a href=\"mailto:contact@degenscan.io\">contact@degenscan.io</a>. O acesso continua até o fim do mês já pago."],
  ["As perguntas acabaram. O que acontece?", "Elas renovam no dia 1º de cada mês. O placar público em /previsoes continua liberado."],
  ["Sou desenvolvedor. Tem API?", "Sim: a mesma chave funciona na API (<code>X-API-KEY</code>) e no MCP para Claude/Cursor. Documentação em <a href=\"/llms.txt\">/llms.txt</a> e <a href=\"/docs\">/docs</a>. Agentes de IA também podem pagar por chamada em USDC (x402), sem assinatura."],
];
const QA_EN: [string, string][] = [
  ["What is the Degenscan Oracle?", "An AI system that estimates the <b>probability</b> of an event — e.g. “will the Fed cut in December?”. Several AI teams analyse the question with real data (prices, volatility, Polymarket, central banks); the output is a number from 0% to 100%."],
  ["Is this investment or betting advice?", "<b>No.</b> It estimates a chance; it does not tell you what to buy, sell or bet. Degenscan does not trade, bet or access any wallet on your behalf."],
  ["Where can I see forecasts for free?", "At <a href=\"/predictions\">/predictions</a>: the public board with today’s questions, the oracle next to the Polymarket price, and later whether it was right."],
  ["What do I get by subscribing?", "You can ask <b>your own questions</b> at <a href=\"/app?lang=en\">/app</a> — 16 per month on Hobby — each with probability, reasons, failure modes and a hash-locked proof."],
  ["How do I use it?", "1) Subscribe at <a href=\"/pricing\">/pricing</a>. 2) On the next screen click <b>“Open the Oracle”</b> — the key is stored in your browser. 3) Write a yes/no question, pick the date it resolves, click <b>“Ask the oracle”</b>. The answer appears in 1–4 minutes and stays in your history."],
  ["What is the hash proof?", "A code computed at forecast time from the question, probability and time. Changing the number later would break it — proof the forecast came <b>before</b> the outcome."],
  ["Lost key / cancel?", "Email <a href=\"mailto:contact@degenscan.io\">contact@degenscan.io</a>. Cancel any time; access runs to the end of the paid month."],
  ["Developer API?", "Same key works on the REST API (<code>X-API-KEY</code>) and MCP. Docs: <a href=\"/llms.txt\">/llms.txt</a>. AI agents can also pay per call in USDC (x402)."],
];

export function helpPage(lang: "pt" | "en" = "pt"): string {
  const pt = lang === "pt"; const qa = pt ? QA_PT : QA_EN;
  return `<!doctype html><html lang="${pt ? "pt-BR" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pt ? "Ajuda — Oráculo Degenscan" : "Help — Degenscan Oracle"}</title>
<style>body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d10;color:#e8eaed}.wrap{max-width:760px;margin:0 auto;padding:24px 16px 48px}a{color:#7cc4ff}h1{font-size:28px;margin:0 0 6px}
details{background:#12161b;border:1px solid #232a32;border-radius:12px;padding:12px 14px;margin:0 0 10px}summary{cursor:pointer;font-weight:600;line-height:1.4}details p{color:#c3c7cc;line-height:1.6;margin:10px 0 2px}.m{color:#9aa0a6;font-size:13px;line-height:1.6}
.cta{display:flex;gap:10px;flex-wrap:wrap;margin:14px 0 20px}.cta a{background:#4f8cff;color:#fff;text-decoration:none;padding:10px 14px;border-radius:10px;font-weight:600}.cta a.alt{background:#1b2230;color:#aac4ff}</style>
<div class="wrap"><h1>${pt ? "Ajuda" : "Help"}</h1><p class="m">${pt ? "Tudo o que você precisa para usar o Oráculo — sem programar." : "Everything you need to use the Oracle — no coding."}</p>
<div class="cta"><a href="${pt ? "/app" : "/app?lang=en"}">${pt ? "Perguntar ao oráculo" : "Ask the oracle"}</a><a class="alt" href="${pt ? "/previsoes" : "/predictions"}">${pt ? "Ver previsões grátis" : "Free predictions"}</a><a class="alt" href="/pricing">${pt ? "Planos" : "Plans"}</a></div>
${qa.map(([q, a], i) => `<details${i < 2 ? " open" : ""}><summary>${q}</summary><p>${a}</p></details>`).join("")}
<p class="m">${pt ? "Informação e análise, não é recomendação de investimento nem de aposta. Operado por Marbella Collins LLC · contact@degenscan.io · <a href=\"/ajuda?lang=en\">English</a>" : "Information and analytics only — not investment or betting advice. Operated by Marbella Collins LLC · contact@degenscan.io · <a href=\"/ajuda\">Português</a>"}</p></div></html>`;
}

export function installHelpRoutes(app: FastifyInstance) {
  app.get("/ajuda", async (req: any, reply) => reply.type("text/html; charset=utf-8").send(helpPage(req.query?.lang === "en" ? "en" : "pt")));
  app.get("/help", async (_req, reply) => reply.type("text/html; charset=utf-8").send(helpPage("en")));
}
