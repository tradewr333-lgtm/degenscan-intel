process.env.DB_PATH = ":memory:";
import { describe, it, expect } from "vitest";
import { recordCall, weeklyMetrics, addOwnerMark, isOwnerPayer, ownerSet } from "../src/store/db.js";
import { createKey } from "../src/server/keys.js";

describe("owner marks", () => {
  it("owner keys and IPs are counted apart from customers", () => {
    const sum = () => weeklyMetrics(new Date(Date.now() - 86_400_000).toISOString(), []).reduce((a, x) => ({ k: a.k + x.calls_api_key, f: a.f + x.calls_free, ok: a.ok + x.excluded_owner_usage.calls_api_key, of: a.of + x.excluded_owner_usage.calls_free }), { k: 0, f: 0, ok: 0, of: 0 });
    const b = sum();
    const owner = createKey({ plan: "enterprise", label: "owner chatgpt" });
    const cust = createKey({ plan: "hobby", label: "cliente" });
    addOwnerMark("ip", "203.0.113.77", "casa");
    recordCall("pulse", `key:${owner.id}`, 0, true);
    recordCall("pulse", `key:${cust.id}`, 0, true);
    recordCall("pulse", "203.0.113.77", 0, true);
    recordCall("pulse", "198.51.100.9", 0, true);
    expect(isOwnerPayer("operator")).toBe(true);
    expect(ownerSet().keys.has(owner.id)).toBe(true);
    const a = sum();
    expect({ k: a.k - b.k, f: a.f - b.f, ok: a.ok - b.ok, of: a.of - b.of }).toEqual({ k: 1, f: 1, ok: 1, of: 1 });
  });
});
