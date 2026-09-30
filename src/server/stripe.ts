import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import { createKey, findBySession, revokeBySubscription, PLANS, PACKS, type Plan } from "./keys.js";

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
  app.get("/pricing", async (_req, reply) => {
    const rows = Object.entries(PLANS).filter(([k]) => k !== "enterprise").map(([id, p]) => {
      const url = secret && PRICE[id as Plan] ? `${PUBLIC_URL}/v1/keys/checkout?plan=${id}` : null;
      return `<div class="card"><h3>${p.name}</h3><div class="price">$${p.usd_month}<small>/month</small></div><p>${p.monthly_calls.toLocaleString("en-US")} calls/month · all tools incl. token verdicts, oracle board and forecasts (a forecast = 125 calls)</p>${url ? `<a class="btn" href="${url}">Subscribe with card</a>` : `<span class="soon">coming soon</span>`}</div>`;
    }).join("");
    return reply.type("text/html; charset=utf-8").send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Degenscan Intel — pricing</title>
<style>body{font-family:system-ui,sans-serif;max-width:920px;margin:0 auto;padding:24px 16px;background:#0b0d10;color:#e8eaed}a{color:#7cc4ff}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}.card{border:1px solid #2a2f36;border-radius:12px;padding:18px;background:#12161b}.price{font-size:32px;font-weight:700}.price small{font-size:14px;color:#9aa0a6}.btn{display:inline-block;margin-top:8px;padding:10px 14px;border-radius:8px;background:#2f7cf6;color:#fff;text-decoration:none}.soon{color:#9aa0a6}code{background:#1c2128;padding:2px 6px;border-radius:4px}</style>
<h1>Degenscan Intel pricing</h1><p>Market-event intelligence, token risk verdicts and calibrated forecasts for trading bots and AI agents. You get an <code>X-API-KEY</code> right after checkout.</p>
<div class="grid">${rows}</div>
<h2>Agents (no account)</h2><p>Pay per call with x402 (USDC on Base or Solana): just call any route and answer the 402. Prices: <a href="/.well-known/x402">/.well-known/x402</a>. Or buy a prepaid key with USDC: <a href="/v1/keys/packs">/v1/keys/packs</a> ($5 = 1,000 calls).</p>
<p><a href="/llms.txt">Docs</a> · <a href="/v1/oracle/track-record">Public forecast track record</a> · <a href="/v1/metrics">Public usage metrics</a></p>
<p style="color:#9aa0a6">Operator: Marbella Collins LLC · contact@degenscan.io · Information and analytics only — not investment advice.</p></html>`);
  });

  if (!secret) { console.log("[stripe] STRIPE_SECRET_KEY not set — fiat plans disabled (x402 still works)"); return; }
  const stripe = new Stripe(secret);

  const checkout = async (plan: Plan, email?: string) => {
    const price = PRICE[plan];
    if (!price) throw new Error(`plan ${plan} not configured`);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", line_items: [{ price, quantity: 1 }], customer_email: email || undefined,
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

  /** Mint the key once the session is paid. Idempotent: second call says it was already claimed. */
  app.get("/v1/keys/claim", async (req: any, reply) => {
    const sid = String(req.query.session_id ?? "");
    if (!sid) return reply.code(400).send({ error: "session_id required" });
    if (findBySession(sid)) return reply.code(409).send({ error: "key already claimed for this session — it was shown once; contact contact@degenscan.io to rotate" });
    const s = await stripe.checkout.sessions.retrieve(sid);
    if (s.payment_status !== "paid" && s.status !== "complete") return reply.code(402).send({ error: "session not paid" });
    const plan = ((s.metadata?.plan as Plan) ?? "starter");
    const { id, key } = createKey({ plan, stripe_customer: String(s.customer ?? ""), stripe_subscription: String(s.subscription ?? ""), stripe_session: sid, email: s.customer_details?.email ?? undefined });
    const body = { api_key: key, key_id: id, plan, monthly_calls: PLANS[plan].monthly_calls, usage: `send header  X-API-KEY: ${key}  on /v1/* or POST /mcp`, note: "Shown once. Store it now." };
    if ((req.headers.accept ?? "").includes("text/html")) {
      return reply.type("text/html").send(`<!doctype html><meta charset=utf-8><title>Degenscan Intel — API key</title><body style="font-family:system-ui;max-width:640px;margin:40px auto;padding:0 16px"><h2>Your Degenscan Intel API key</h2><p>Plan <b>${PLANS[plan].name}</b> — ${PLANS[plan].monthly_calls.toLocaleString()} calls/month.</p><pre style="background:#111;color:#0f0;padding:16px;border-radius:8px;overflow:auto">${key}</pre><p>Use it as <code>X-API-KEY</code> header on <code>/v1/*</code> or <code>POST /mcp</code>. <b>Shown once — store it now.</b></p><p><a href="${PUBLIC_URL}/llms.txt">Docs</a></p></body>`);
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
