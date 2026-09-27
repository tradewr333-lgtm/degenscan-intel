import { describe, it, expect } from "vitest";
process.env.DB_PATH = ":memory:";
process.env.INTEL_FREE = "1";

describe("public metrics", () => {
  it("separates owner/test wallets from customers and lists tx hashes", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const { recordCall } = await import("../src/store/db.js");
    const app = await buildHttp();
    recordCall("regime_snapshot", "x402:0x5344722b8D037827A9a5b7cD6312481D215d33BF", 0.01, true, "0xowner");   // owner test wallet
    recordCall("events_since", "x402:0xABCDEF0000000000000000000000000000000001", 0.005, true, "0xcust1"); // customer
    recordCall("events_since", "x402:0xabcdef0000000000000000000000000000000001", 0.005, true, "0xcust2"); // same customer, other case
    recordCall("impact_for", "1.2.3.4", 0, true);                                                             // free quota
    recordCall("explain", "x402:0xfail", 0.02, false, null);                                                // failed settlement → ignored
    const r = await app.inject({ method: "GET", url: "/v1/metrics" });
    if (r.statusCode !== 200) console.log(r.body); expect(r.statusCode).toBe(200);
    const m = r.json();
    expect(m.excluded_owner_wallets).toContain("0x5344722b8D037827A9a5b7cD6312481D215d33BF");
    const w = m.weeks.at(-1);
    expect(w.calls_paid_x402).toBe(2);
    expect(w.unique_paying_wallets).toBe(1);
    expect(w.usdc_revenue).toBe(0.01);
    expect(w.tx_hashes).toEqual(["0xcust1", "0xcust2"]);
    expect(w.calls_free).toBe(1);
    expect(w.excluded_owner_wallets.calls).toBe(1);
    expect(w.excluded_owner_wallets.tx_hashes).toEqual(["0xowner"]);
    const csv = await app.inject({ method: "GET", url: "/v1/metrics.csv" });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toContain("unique_paying_wallets");
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.json().operator).toContain("Marbella Collins LLC");
    expect(root.json().disclaimer).toContain("not investment advice");
  });
});
