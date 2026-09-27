import type { FastifyRequest, FastifyReply } from "fastify";
import { priceOf, toAtomicUsdc, FREE_DAILY_CALLS_PER_IP } from "./pricing.js";
import { recordCall } from "../store/db.js";

/**
 * x402 payment gate (https://x402.org). Flow:
 *   1. Client calls without X-PAYMENT → 402 + JSON "accepts" describing price/asset/payTo.
 *   2. Client signs an EIP-3009 USDC transferWithAuthorization and retries with X-PAYMENT (base64 JSON).
 *   3. We POST it to the facilitator /verify, serve the response, then /settle (async).
 *
 * Config (env):
 *   X402_PAY_TO           receiving address (Base). Required for paid mode.
 *   X402_FACILITATOR_URL  default https://x402.org/facilitator (Coinbase-hosted; Base mainnet needs CDP keys — see README)
 *   X402_NETWORK          base | base-sepolia (default base)
 *   API_KEYS              comma-separated keys accepted as an alternative to x402 (Stripe subscribers)
 *   INTEL_FREE=1          dev mode: everything free
 */
const NETWORK = process.env.X402_NETWORK ?? "base";
const USDC: Record<string, string> = {
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "base-sepolia": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
};
const PAY_TO = process.env.X402_PAY_TO;
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator";
const API_KEYS = new Set((process.env.API_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean));
const FREE_MODE = process.env.INTEL_FREE === "1" || !PAY_TO;

const freeCounter = new Map<string, { day: string; n: number }>();
function freeQuota(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const c = freeCounter.get(ip);
  if (!c || c.day !== day) { freeCounter.set(ip, { day, n: 1 }); return true; }
  c.n++; return c.n <= FREE_DAILY_CALLS_PER_IP;
}

export interface PaymentContext { payer: string | null; method: "free" | "api_key" | "x402" | "quota"; price: number }

export function paymentRequirements(tool: string, resource: string) {
  return {
    x402Version: 1,
    error: "X-PAYMENT header is required",
    accepts: [{
      scheme: "exact", network: NETWORK, maxAmountRequired: toAtomicUsdc(priceOf(tool)), resource, description: `degenscan-intel ${tool}`,
      mimeType: "application/json", payTo: PAY_TO, maxTimeoutSeconds: 60, asset: USDC[NETWORK], extra: { name: "USD Coin", version: "2" },
    }],
  };
}

/** Returns a PaymentContext when the call may proceed, or sends a 402/401 and returns null. */
export async function gate(tool: string, req: FastifyRequest, reply: FastifyReply): Promise<PaymentContext | null> {
  const price = priceOf(tool);
  if (price === 0 || FREE_MODE) return { payer: null, method: "free", price: 0 };

  const key = (req.headers["x-api-key"] as string | undefined)?.trim();
  if (key && API_KEYS.has(key)) { recordCall(tool, `key:${key.slice(0, 6)}`, price, true); return { payer: `key:${key.slice(0, 6)}`, method: "api_key", price }; }

  const payment = req.headers["x-payment"] as string | undefined;
  const resource = `${req.protocol}://${req.hostname}${req.url}`;
  if (!payment) {
    if (freeQuota(req.ip)) return { payer: req.ip, method: "quota", price: 0 };
    reply.code(402).send(paymentRequirements(tool, resource));
    return null;
  }
  const reqs = paymentRequirements(tool, resource).accepts[0];
  try {
    const decoded = JSON.parse(Buffer.from(payment, "base64").toString("utf8"));
    const v = await fetch(`${FACILITATOR}/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 1, paymentPayload: decoded, paymentRequirements: reqs }), signal: AbortSignal.timeout(15_000) });
    const vr = await v.json() as { isValid: boolean; invalidReason?: string; payer?: string };
    if (!vr.isValid) { reply.code(402).send({ ...paymentRequirements(tool, resource), error: vr.invalidReason ?? "invalid payment" }); return null; }
    // settle after response (fire-and-forget; log failures)
    reply.raw.on("finish", () => {
      fetch(`${FACILITATOR}/settle`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ x402Version: 1, paymentPayload: decoded, paymentRequirements: reqs }), signal: AbortSignal.timeout(30_000) })
        .then(r => r.json()).then((s: any) => { recordCall(tool, vr.payer ?? null, price, !!s.success); if (!s.success) console.warn("[x402] settle failed", s); })
        .catch(e => console.warn("[x402] settle error", e.message));
    });
    return { payer: vr.payer ?? null, method: "x402", price };
  } catch (e) {
    reply.code(402).send({ ...paymentRequirements(tool, resource), error: `payment verification failed: ${(e as Error).message}` });
    return null;
  }
}
