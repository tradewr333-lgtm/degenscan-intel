/**
 * Offers (Renato 02/11): agents only see the 402 of the call they make, never /v1/plans. Every 402 and every x402-paid
 * response now says how to buy access without a card. Honest by construction: prices and credits come from the same
 * constants the payment routes charge, so the offer can't drift from what is billed. Per-call prices are unchanged.
 */
import { PRICES, CARRY_CREDITS } from "./pricing.js";
import { BALANCES, CARRY, CARRY_DESK, CARRY_WEEK, TRIAL } from "./keys.js";
import { getDb } from "../store/db.js";

export interface Offer { id: string; how: string; price_usdc: number | null; gives: string }

/** Pure: the offers relevant to one tool (carry tools also get the Carry subscriptions). Exported for tests. */
export function offersFor(tool: string | null | undefined, base: string): Offer[] {
  const b = BALANCES.balance_5;
  const out: Offer[] = [
    { id: "prepaid_balance", how: `POST ${base}/v1/keys/x402/balance_5 (answer the 402 with USDC on Base or Solana)`, price_usdc: b.usd, gives: `US$${b.credit_usd} of usage for ${b.usd} USDC (20% more), each call at its normal price, one X-API-KEY, no per-call signature, no expiry. Also balance_20 → US$${BALANCES.balance_20.credit_usd}, balance_100 → US$${BALANCES.balance_100.credit_usd}` },
    { id: "free_trial", how: `POST ${base}/v1/keys/trial {"email": "..."}`, price_usdc: 0, gives: `${TRIAL.calls} calls over ${TRIAL.days} days, no card, then send X-API-KEY` },
  ];
  const isCarry = !!tool && (tool.startsWith("carry_") || tool in CARRY_CREDITS);
  if (isCarry) {
    out.push({ id: "carry_week", how: `POST ${base}/v1/keys/x402/carry_week`, price_usdc: CARRY_WEEK.usd, gives: `${CARRY_WEEK.days} days of unlimited Carry Oracle calls` });
    out.push({ id: "carry_month", how: `POST ${base}/v1/keys/x402/carry_month`, price_usdc: CARRY.usd_month, gives: "30 days of unlimited Carry Oracle calls (all Hyperliquid dexes, history beyond 500 h)" });
    out.push({ id: "carry_desk_month", how: `POST ${base}/v1/keys/x402/carry_desk_month`, price_usdc: CARRY_DESK.usd_month, gives: "30 days of Carry Desk: eligibility filters, per-pair capacity, realized carry, webhook alerts" });
  }
  return out;
}

/** Compact one-line header value (ASCII, < 1 KB) for 402 responses, where we don't own the body. */
export function offersHeader(tool: string | null | undefined, base: string): string {
  const parts = offersFor(tool, base).map(o => `${o.id}=${o.price_usdc ?? "?"}USDC`);
  const price = tool ? PRICES[tool] : undefined;
  return `${price != null ? `this_call=${price}USDC; ` : ""}${parts.join("; ")}; balance_5_gives=${BALANCES.balance_5.credit_usd}USD; all=${base}/v1/plans`;
}

/** Pure: the tip shown to a wallet that has paid per call at least `min` times in 30 days. Exported for tests. */
export function tipFor(calls: number, spentUsd: number, min = 20): { calls_30d: number; spent_30d_usd: number; tip: string } | null {
  if (calls < min) return null;
  const s = Math.round(spentUsd * 1e4) / 1e4;
  return { calls_30d: calls, spent_30d_usd: s, tip: `You paid ${calls} calls (US$${s}) one signature at a time in 30 days. A prepaid balance gives 20% more: ${BALANCES.balance_5.usd} USDC → US$${BALANCES.balance_5.credit_usd} of usage, POST /v1/keys/x402/balance_5.` };
}
/** Per-call spending of one wallet in the last 30 days (x402 payments recorded in the billing log). */
export function walletTip(wallet: string | null | undefined) {
  if (!wallet) return null;
  try {
    const r = getDb().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(price_usd),0) AS s FROM calls WHERE payer = ? AND ts >= ?").get(`x402:${wallet}`, new Date(Date.now() - 30 * 86_400_000).toISOString()) as any;
    return tipFor(Number(r?.n ?? 0), Number(r?.s ?? 0));
  } catch { return null; }
}
