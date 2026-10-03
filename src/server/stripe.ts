import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { createKey, findBySession, revokeBySubscription, PLANS, PACKS, type Plan, CARRY, createCarryKey } from "./keys.js";

/**
 * Fiat subscriptions for agents/operators without a crypto wallet.
 *
 * Flow: POST /v1/keys/checkout {plan} → Stripe Checkout URL → on success Stripe redirects to
 * GET /v1/keys/claim?session_id=… which mints the API key (once) and returns it.
 * Webhook: customer.subscription.deleted → key revoked.
 *
 * Env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_HOBBY, STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, PUBLIC_URL
 */
export function installStripe(app: FastifyInstance) {
  const secret = process.env.STRIPE_SECRET_KEY;
  const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://intel.degenscan.io";
  const PRICE: Partial<Record<Plan, string | undefined>> = { hobby: process.env.STRIPE_PRICE_HOBBY, starter: process.env.STRIPE_PRICE_STARTER, pro: process.env.STRIPE_PRICE_PRO };

  app.get("/v1/plans", async () => ({
    plans: Object.entries(PLANS).filter(([k]) => k !== "enterprise").map(([id, p]) => ({ id, ...p, checkout: secret && PRICE[id as Plan] ? `${PUBLIC_URL}/v1/keys/checkout?plan=${id}` : null })),
    prepaid_packs: { how: `POST ${PUBLIC_URL}/v1/keys/x402/<pack> and pay the 402 with USDC (x402) — no human, no card`, endpoints: Object.keys(PACKS).map(p => `${PUBLIC_URL}/v1/keys/x402/${p}`), packs: PACKS },
    pay_per_call: "x402 (USDC on Base) — call any priced endpoint without a key to receive payment requirements",
    stripe_enabled: !!secret,
  }));

  // Human pricing page (card via Stripe; agents use x402 or prepaid packs).
  app.get("/pricing", async (req: any, reply) => {
    const pt = req.query?.lang !== "en";
    const human: Record<string, { pt: string; en: string }> = {
      hobby: { pt: "Para você: <b>16 perguntas por mês</b> ao oráculo no navegador (<a href=\"/app\">/app</a>), com probabilidade, motivos em português e prova com hash. Sem programar.", en: "For you: <b>16 questions/month</b> to the oracle in your browser (<a href=\"/app?lang=en\">/app</a>) with probability, reasons and a hash proof. No coding." },
      starter: { pt: "Para quem tem robô ou app: 10.000 chamadas/mês na API e no MCP (≈ 80 perguntas ao oráculo).", en: "For bots and apps: 10,000 API/MCP calls per month (≈ 80 oracle questions)." },
      pro: { pt: "Para equipes e produtos: 200.000 chamadas/mês na API e no MCP.", en: "For teams and products: 200,000 API/MCP calls per month." },
    };
    const rows = Object.entries(PLANS).filter(([k]) => k !== "enterprise").map(([id, p]) => {
      const url = secret && PRICE[id as Plan] ? `${PUBLIC_URL}/v1/keys/checkout?plan=${id}` : null;
      const d = human[id]?.[pt ? "pt" : "en"] ?? `${p.monthly_calls.toLocaleString("en-US")} calls/month`;
      return `<div class="card${id === "hobby" ? " hl" : ""}"><h3>${p.name}</h3><div class="price">US$${p.usd_month}<small>/${pt ? "mês" : "month"}</small></div><p>${d}</p><p class="m">${p.monthly_calls.toLocaleString(pt ? "pt-BR" : "en-US")} ${pt ? "chamadas/mês · a mesma chave vale na API" : "calls/month · the same key works on the API"}</p>${url ? `<a class="btn" href="${url}">${pt ? "Assinar com cartão" : "Subscribe with card"}</a>` : `<span class="soon">${pt ? "em breve" : "coming soon"}</span>`}</div>`;
    }).join("");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="${pt ? "pt-BR" : "en"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${pt ? "Planos — Oráculo Degenscan" : "Degenscan Intel — pricing"}</title>
<style>body{font-family:system-ui,sans-serif;max-width:920px;margin:0 auto;padding:24px 16px;background:#0b0d10;color:#e8eaed}a{color:#7cc4ff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}.card{border:1px solid #2a2f36;border-radius:12px;padding:18px;background:#12161b}.card.hl{border-color:#4f8cff}.price{font-size:32px;font-weight:700}.price small{font-size:14px;color:#9aa0a6}.btn{display:inline-block;margin-top:8px;padding:10px 14px;border-radius:8px;background:#2f7cf6;color:#fff;text-decoration:none}.soon,.m{color:#9aa0a6;font-size:13px}code{background:#1c2128;padding:2px 6px;border-radius:4px}</style>
<h1>${pt ? "Planos" : "Pricing"}</h1><p>${pt ? "Veja as previsões de graça em <a href=\"/previsoes\">/previsoes</a>. Assinando, você faz as suas próprias perguntas ao oráculo. Tem cupom? No pagamento, clique em <b>“Adicionar código”</b>. Cancele quando quiser." : "Free predictions at <a href=\"/predictions\">/predictions</a>. Subscribe to ask your own questions. Have a coupon? Click <b>“Add promotion code”</b> at checkout. Cancel any time."}</p>
<div class="grid">${rows}</div><div class="card" style="margin-top:16px"><h3>Carry Oracle</h3><div class="price">US$100<small>/${pt ? "mês" : "month"}</small></div><p>${pt ? "Funding da Hyperliquid em todos os dexes, spreads entre dexes e histórico hora a hora, via API. Valor fixo, chamadas ilimitadas. Cartão ou USDC." : "Hyperliquid funding on every dex, cross-dex spreads and hourly history via API. Flat fee, unlimited calls. Card or USDC."}</p><p><a href="/carry${pt ? "" : "?lang=en"}">${pt ? "Ver o Carry Oracle →" : "See Carry Oracle →"}</a></p></div>
<h2>${pt ? "Desenvolvedores e agentes de IA" : "Developers and AI agents"}</h2><p>${pt ? "A chave funciona como <code>X-API-KEY</code> em <code>/v1/*</code> e no MCP (Claude, Cursor). Agentes podem pagar por chamada com x402 (USDC na Base ou Solana), sem conta:" : "The key works as <code>X-API-KEY</code> on <code>/v1/*</code> and MCP. Agents can pay per call with x402 (USDC on Base or Solana), no account:"} <a href="/.well-known/x402">/.well-known/x402</a> · <a href="/v1/keys/packs">/v1/keys/packs</a> · <a href="/llms.txt">docs</a></p>
<p><a href="/ajuda${pt ? "" : "?lang=en"}">${pt ? "Ajuda" : "Help"}</a> · <a href="/v1/oracle/track-record">${pt ? "Placar de acertos (JSON)" : "Track record"}</a> · <a href="/v1/metrics">${pt ? "Métricas públicas" : "Public metrics"}</a> · <a href="/pricing?lang=${pt ? "en" : "pt"}">${pt ? "English" : "Português"}</a></p>
<p style="color:#9aa0a6">Marbella Collins LLC · contact@degenscan.io · ${pt ? "Informação e análise, não é recomendação de investimento nem de aposta." : "Information and analytics only — not investment advice."}</p></html>`);
  });

  if (!secret) { console.log("[stripe] STRIPE_SECRET_KEY not set — fiat plans disabled (x402 still works)"); return; }
  const stripe = new Stripe(secret);

  const checkout = async (plan: Plan, email?: string) => {
    const price = PRICE[plan];
    if (!price) throw new Error(`plan ${plan} not configured`);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", line_items: [{ price, quantity: 1 }], customer_email: email || undefined, allow_promotion_codes: true,
      success_url: `${PUBLIC_URL}/v1/keys/claim?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${PUBLIC_URL}/v1/plans`,
      metadata: { plan }, subscription_data: { metadata: { plan } },
    });
    return session.url!;
  };

  app.get("/v1/keys/checkout", async (req: any, reply) => {
    const plan = String(req.query.plan ?? "starter") as Plan;
    if (!(plan in PRICE)) return reply.code(400).send({ error: "unknown plan" });
    return reply.redirect(await checkout(plan, req.query.email));
  });
  app.post("/v1/keys/checkout", async (req: any, reply) => {
    const plan = String(req.body?.plan ?? "starter") as Plan;
    if (!(plan in PRICE)) return reply.code(400).send({ error: "unknown plan" });
    return { url: await checkout(plan, req.body?.email) };
  });

  // Carry Oracle by card: the US$100/month price is looked up by lookup_key and created once if missing (new product, existing
  // prices untouched). No env var or dashboard click needed.
  let carryPriceId: string | null = process.env.STRIPE_PRICE_CARRY ?? null;
  const ensureCarryPrice = async () => {
    if (carryPriceId) return carryPriceId;
    const found = await stripe.prices.list({ lookup_keys: [CARRY.lookup_key], active: true, limit: 1 });
    if (found.data[0]) return (carryPriceId = found.data[0].id);
    const product = await stripe.products.create({ name: CARRY.product_name, description: "Hyperliquid funding on every dex (main + HIP-3), cross-dex spreads and hourly history via API. Flat monthly access, unlimited calls. Data and analytics only — not investment advice." });
    const price = await stripe.prices.create({ product: product.id, unit_amount: CARRY.usd_month * 100, currency: "usd", recurring: { interval: "month" }, lookup_key: CARRY.lookup_key });
    console.log(`[stripe] created Carry Oracle price ${price.id} (US$${CARRY.usd_month}/month)`);
    return (carryPriceId = price.id);
  };
  app.get("/v1/carry/checkout", async (req: any, reply) => {
    const price = await ensureCarryPrice();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", line_items: [{ price, quantity: 1 }], customer_email: req.query?.email || undefined, allow_promotion_codes: false,
      success_url: `${PUBLIC_URL}/v1/keys/claim?session_id={CHECKOUT_SESSION_ID}`, cancel_url: `${PUBLIC_URL}/carry`,
      metadata: { plan: "carry" }, subscription_data: { metadata: { plan: "carry" } },
    });
    return reply.redirect(session.url!);
  });

  /** Mint the key once the session is paid. Idempotent: second call says it was already claimed. */
  app.get("/v1/keys/claim", async (req: any, reply) => {
    const sid = String(req.query.session_id ?? "");
    if (!sid) return reply.code(400).send({ error: "session_id required" });
    if (findBySession(sid)) return reply.code(409).send({ error: "key already claimed for this session — it was shown once; contact contact@degenscan.io to rotate" });
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.payment_status !== "paid" && s.status !== "complete") return reply.code(402).send({ error: "session not paid" });
    if (s.metadata?.plan === "carry") {
      const { id, key } = createCarryKey({ via: "stripe", stripe_customer: String(s.customer ?? ""), stripe_subscription: String(s.subscription ?? ""), stripe_session: sid, email: s.customer_details?.email ?? undefined });
      const body = { api_key: key, key_id: id, plan: "carry", product: `Carry Oracle — US$${CARRY.usd_month}/month, unlimited /v1/carry/* calls`, usage: `send header  X-API-KEY: ${key}  on /v1/carry/*`, docs: `${PUBLIC_URL}/carry`, note: "Shown once. Store it now. Cancelling the subscription revokes the key." };
      if ((req.headers.accept ?? "").includes("text/html")) return reply.type("text/html").send(`<!doctype html><meta charset=utf-8><title>Carry Oracle — API key</title><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h2>Sua chave do Carry Oracle</h2><pre style="background:#111;color:#0f0;padding:16px;border-radius:8px;overflow:auto">${key}</pre><p>Envie no cabeçalho <code>X-API-KEY</code> em <code>/v1/carry/*</code>. <b>Aparece uma vez só — guarde agora.</b></p><p><a href="${PUBLIC_URL}/carry">Documentação</a></p><p style="color:#666">Dados e analítica de mercado, não é recomendação de investimento.</p></body>`);
      return body;
    }
    const plan = ((s.metadata?.plan as Plan) ?? "starter");
    const { id, key } = createKey({ plan, stripe_customer: String(s.customer ?? ""), stripe_subscription: String(s.subscription ?? ""), stripe_session: sid, email: s.customer_details?.email ?? undefined });
    const body = { api_key: key, key_id: id, plan, monthly_calls: PLANS[plan].monthly_calls, usage: `send header  X-API-KEY: ${key}  on /v1/* or POST /mcp`, note: "Shown once. Store it now." };
    if ((req.headers.accept ?? "").includes("text/html")) {
      return reply.type("text/html").send(`<!doctype html><meta charset=utf-8><title>Degenscan Intel — API key</title><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h2>Your Degenscan Intel API key</h2><p>Plan <b>${PLANS[plan].name}</b> — ${PLANS[plan].monthly_calls.toLocaleString()} calls/month.</p><pre style="background:#111;color:#0f0;padding:16px;border-radius:8px;overflow:auto">${key}</pre><p>Use it as <code>X-API-KEY</code> header on <code>/v1/*</code> or <code>POST /mcp</code>. <b>Shown once — store it now.</b></p><p><a href="${PUBLIC_URL}/app#key=${encodeURIComponent(key)}" style="display:inline-block;background:#4f8cff;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:600">Abrir o Oráculo / Open the Oracle →</a></p><p style="color:#666">O botão salva a chave neste navegador. Guarde a chave também em lugar seguro — ela aparece só uma vez. · The button stores the key in this browser; keep a copy, it is shown once.</p><p><a href="${PUBLIC_URL}/ajuda">Ajuda / Help</a> · <a href="${PUBLIC_URL}/llms.txt">Developer docs</a></p></body>`);
    }
    return body;
  });

  // Webhook needs the raw body for signature verification.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/stripe/webhook", async (req: any, reply) => {
      const whsec = process.env.STRIPE_WEBHOOK_SECRET;
      let event: Stripe.Event;
      try { event = whsec ? stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], whsec) : JSON.parse(req.body); }
      catch (e) { return reply.code(400).send({ error: `bad signature: ${(e as Error).message}` }); }
      if (event.type === "customer.subscription.deleted") {
        const n = revokeBySubscription((event.data.object as Stripe.Subscription).id);
        console.log(`[stripe] subscription deleted → ${n} key(s) revoked`);
      }
      return { received: true };
    });
  });
  console.log("[stripe] fiat plans enabled:", Object.entries(PRICE).filter(([, v]) => v).map(([k]) => k).join(", ") || "(no prices configured)");
}
