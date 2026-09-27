import { describe, it, expect } from "vitest";

describe("x402 gate (paid mode)", () => {
  it("returns 402 with payment requirements after the free quota is exhausted, accepts API key", async () => {
    process.env.DB_PATH = ":memory:";
    process.env.INTEL_FREE = "0";
    process.env.X402_PAY_TO = "0x000000000000000000000000000000000000dEaD";
    process.env.API_KEYS = "test-key-123";
    process.env.FREE_DAILY_CALLS = "1";
    const { buildHttp } = await import("../src/server/http.js");
    const app = buildHttp();
    const first = await app.inject({ method: "GET", url: "/v1/regime" });
    expect(first.statusCode).toBe(200);
    expect(first.json()._billing.method).toBe("quota");
    const second = await app.inject({ method: "GET", url: "/v1/regime" });
    expect(second.statusCode).toBe(402);
    const req = second.json();
    expect(req.x402Version).toBe(1);
    expect(req.accepts[0].maxAmountRequired).toBe("10000"); // $0.01 in USDC atomic
    expect(req.accepts[0].payTo).toBe(process.env.X402_PAY_TO);
    expect(req.accepts[0].asset).toMatch(/^0x/);
    const keyed = await app.inject({ method: "GET", url: "/v1/regime", headers: { "x-api-key": "test-key-123" } });
    expect(keyed.statusCode).toBe(200);
    expect(keyed.json()._billing.method).toBe("api_key");
    const free = await app.inject({ method: "GET", url: "/v1/universe" });
    expect(free.statusCode).toBe(200);
  });
});
