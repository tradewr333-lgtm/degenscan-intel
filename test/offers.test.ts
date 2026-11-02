import { describe, it, expect, beforeAll } from "vitest";

describe("offers, prepaid balance, carry week (02/11)", () => {
  beforeAll(() => { process.env.DB_PATH = ":memory:"; process.env.INTEL_FREE = "0"; process.env.X402_PAY_TO = "0x000000000000000000000000000000000000dEaD"; });

  it("offers use the same prices the payment routes charge", async () => {
    const { offersFor, offersHeader } = await import("../src/server/offers.js");
    const { BALANCES, CARRY_WEEK } = await import("../src/server/keys.js");
    const o = offersFor("hl_basis", "https://x");
    expect(o.map(x => x.id)).toEqual(["prepaid_balance", "free_trial"]);
    expect(o[0].price_usdc).toBe(BALANCES.balance_5.usd);
    expect(o[0].gives).toContain(`US$${BALANCES.balance_5.credit_usd}`);
    const c = offersFor("carry_funding_matrix", "https://x");
    expect(c.find(x => x.id === "carry_week")!.price_usdc).toBe(CARRY_WEEK.usd);
    const h = offersHeader("hl_basis", "https://x");
    expect(h).toMatch(/^this_call=0\.001USDC; /); expect(h.length).toBeLessThan(1024); expect(/^[\x20-\x7e]+$/.test(h)).toBe(true);
  });

  it("wallet tip only after 20 per-call payments", async () => {
    const { tipFor } = await import("../src/server/offers.js");
    expect(tipFor(19, 0.03)).toBeNull();
    const t = tipFor(25, 0.0412)!; expect(t.calls_30d).toBe(25); expect(t.spent_30d_usd).toBe(0.0412); expect(t.tip).toContain("balance_5");
  });

  it("balance key: 6 USD of credit, each call billed at its normal price, refused when the balance can't cover the call", async () => {
    const { createBalanceKey, activatePackKey, validateKey, keyStatus } = await import("../src/server/keys.js");
    const { recordCall } = await import("../src/store/db.js");
    const { decideAccess } = await import("../src/server/access.js");
    const { PRICES } = await import("../src/server/pricing.js");
    const { id, key } = createBalanceKey("balance_5", "0xabc");
    expect(validateKey(key)).toBeNull();               // pending until settled
    activatePackKey(id, "0xtx");
    expect(validateKey(key)!.remaining).toBe(6);
    const req = (url: string) => ({ url, method: "GET", headers: { "x-api-key": key }, ip: "1.2.3.4" } as any);
    const a = decideAccess(req("/v1/hl/basis/BTC"))!;
    expect(a.method).toBe("api_key"); expect(a.price).toBe(PRICES.hl_basis);  // normal price, not discounted, not credits
    recordCall("hl_basis", a.payer, a.price, true);
    expect(keyStatus(key)!.remaining_usd).toBeCloseTo(6 - PRICES.hl_basis, 9);
    recordCall("oracle_forecast", `key:${id}`, 5.999, true); // drain
    expect(decideAccess(req("/v1/hl/basis/BTC"))).toBeNull();  // → x402 per call again
  });
});
