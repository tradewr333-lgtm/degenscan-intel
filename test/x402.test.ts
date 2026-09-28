import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Fastify from "fastify";

/**
 * Full x402 v2 flow against a mock facilitator: quota → 402 (PAYMENT-REQUIRED header) → PAYMENT-SIGNATURE → verify → 200 → settle.
 * Also: API key path, free endpoints, MCP handshake free / tools/call priced.
 */
let facilitator: ReturnType<typeof Fastify>;
const settled: any[] = [];

beforeAll(async () => {
  facilitator = Fastify();
  facilitator.get("/supported", async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }, { x402Version: 1, scheme: "exact", network: "base" }, { x402Version: 2, scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", extra: { feePayer: "7aJwHqz3s9qhfZvtvpLS9xH9pYJ9uT9gWvE8xN2yQ1Kc" } }], extensions: ["bazaar"], signers: { "eip155:*": ["0x000000000000000000000000000000000000f00d"] } }));
  facilitator.post("/verify", async (req: any) => ({ isValid: true, payer: req.body?.paymentPayload?.payload?.authorization?.from ?? "0xpayer" }));
  facilitator.post("/settle", async (req: any) => { settled.push(req.body); return { success: true, transaction: "0x" + "ab".repeat(32), network: "eip155:8453", payer: "0xpayer" }; });
  await facilitator.listen({ port: 0, host: "127.0.0.1" });
  const addr = facilitator.server.address() as any;
  process.env.DB_PATH = ":memory:";
  process.env.INTEL_FREE = "0";
  process.env.X402_PAY_TO = "0x000000000000000000000000000000000000dEaD";
  process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${addr.port}`;
  process.env.API_KEYS = "test-key-123";
  process.env.FREE_DAILY_CALLS = "1";
  process.env.X402_PAY_TO_SOLANA = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
});
afterAll(async () => { await facilitator.close(); });

/** Syntactically valid v2 PaymentPayload for the given requirements (signature is fake; the mock facilitator accepts it). */
function fakePayment(req: any) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 2, resource: req.resource, accepted: req.accepts[0],
    payload: { signature: "0x" + "11".repeat(65), authorization: { from: "0x5344722b8D037827A9a5b7cD6312481D215d33BF", to: req.accepts[0].payTo, value: req.accepts[0].amount, validAfter: String(now - 60), validBefore: String(now + 600), nonce: "0x" + "22".repeat(32) } },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("x402 v2 paid mode", () => {
  it("quota → 402 with v2 requirements → paid request verified & settled; API key bypasses; free endpoints stay free", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();

    // no header, no payment → 402 immediately (indexer probes must see a real 402)
    const probe = await app.inject({ method: "GET", url: "/v1/regime" });
    expect(probe.statusCode).toBe(402);
    // opt-in free trial header → quota (1 call in this test), then 402
    const first = await app.inject({ method: "GET", url: "/v1/regime", headers: { "x-free-trial": "1" } });
    expect(first.statusCode).toBe(200);
    expect(first.json()._billing.method).toBe("quota");

    const second = await app.inject({ method: "GET", url: "/v1/regime", headers: { "x-free-trial": "1" } });
    expect(second.statusCode).toBe(402);
    const hdr = second.headers["payment-required"] as string;
    expect(hdr).toBeTruthy();
    const req = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
    expect(req.x402Version).toBe(2);
    expect(req.accepts[0].network).toBe("eip155:8453");
    expect(req.accepts[0].amount).toBe("10000"); // $0.01 in USDC atomic
    expect(req.accepts[0].payTo.toLowerCase()).toBe(process.env.X402_PAY_TO!.toLowerCase());
    expect(req.accepts[0].asset.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"); // USDC on Base
    // second rail: Solana mainnet USDC to the configured Solana address
    const sol = req.accepts.find((a: any) => String(a.network).startsWith("solana:"));
    expect(sol).toBeTruthy();
    expect(sol.payTo).toBe(process.env.X402_PAY_TO_SOLANA);
    expect(sol.amount).toBe("10000");

    const paid = await app.inject({ method: "GET", url: "/v1/regime", headers: { "payment-signature": fakePayment(req) } });
    expect(paid.statusCode).toBe(200);
    expect(paid.json()._billing.method).toBe("x402");
    expect(paid.headers["payment-response"]).toBeTruthy();
    expect(settled.length).toBe(1);

    const keyed = await app.inject({ method: "GET", url: "/v1/regime", headers: { "x-api-key": "test-key-123" } });
    expect(keyed.statusCode).toBe(200);
    expect(keyed.json()._billing.method).toBe("api_key");

    const free = await app.inject({ method: "GET", url: "/v1/universe" });
    expect(free.statusCode).toBe(200);
    const plans = await app.inject({ method: "GET", url: "/v1/plans" });
    expect(plans.json().plans.map((p: any) => p.id)).toEqual(["starter", "pro"]);
  });

  it("MCP: handshake and tools/list are free; tools/call on a priced tool returns 402 after quota; paid call settles", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const list = await app.inject({ method: "POST", url: "/mcp", headers: hdr, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(list.statusCode).toBe(200);
    const freeTool = await app.inject({ method: "POST", url: "/mcp", headers: hdr, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "universe", arguments: {} } } });
    expect(freeTool.statusCode).toBe(200);
    // quota already consumed by the previous test (same IP) → priced tool must 402
    const priced = await app.inject({ method: "POST", url: "/mcp", headers: hdr, payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "regime_snapshot", arguments: {} } } });
    expect(priced.statusCode).toBe(402);
    const req = JSON.parse(Buffer.from(priced.headers["payment-required"] as string, "base64").toString("utf8"));
    expect(req.accepts[0].amount).toBe("10000");
    const before = settled.length;
    const paid = await app.inject({ method: "POST", url: "/mcp", headers: { ...hdr, "payment-signature": fakePayment(req) }, payload: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "regime_snapshot", arguments: {} } } });
    expect(paid.statusCode).toBe(200);
    expect(paid.body).toContain("venues_open");
    await new Promise(r => setTimeout(r, 300));
    expect(settled.length).toBe(before + 1);
  });

  it("prepaid pack: 402 priced per pack in the URL → pay → key returned & activated after settlement → key works and budget decrements", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const noPack = await app.inject({ method: "POST", url: "/v1/keys/x402", payload: {} });
    expect(noPack.statusCode).toBe(400);
    // API key / quota must never bypass the purchase
    const r1 = await app.inject({ method: "POST", url: "/v1/keys/x402/pack_1k", headers: { "x-api-key": "test-key-123", "content-type": "application/json" }, payload: {} });
    expect(r1.statusCode).toBe(402);
    const req = JSON.parse(Buffer.from(r1.headers["payment-required"] as string, "base64").toString("utf8"));
    expect(req.accepts[0].amount).toBe("5000000"); // $5 USDC
    const r10k = await app.inject({ method: "POST", url: "/v1/keys/x402/pack_10k", payload: {} });
    expect(JSON.parse(Buffer.from(r10k.headers["payment-required"] as string, "base64").toString("utf8")).accepts[0].amount).toBe("40000000");
    const before = settled.length;
    const paid = await app.inject({ method: "POST", url: "/v1/keys/x402/pack_1k", headers: { "payment-signature": fakePayment(req), "content-type": "application/json" }, payload: {} });
    expect(paid.statusCode).toBe(200);
    const body = paid.json();
    expect(body.api_key).toMatch(/^dsi_pack_1k_/);
    expect(body.calls).toBe(1000);
    expect(body.payer.toLowerCase()).toBe("0x5344722b8d037827a9a5b7cd6312481d215d33bf");
    expect(settled.length).toBe(before + 1);
    await new Promise(r => setTimeout(r, 50));
    const me = await app.inject({ method: "GET", url: "/v1/keys/me", headers: { "x-api-key": body.api_key } });
    expect(me.json()).toMatchObject({ status: "active", budget: 1000, used: 0, remaining: 1000, period: "lifetime" });
    const call = await app.inject({ method: "GET", url: "/v1/regime", headers: { "x-api-key": body.api_key } });
    expect(call.statusCode).toBe(200);
    expect(call.json()._billing.method).toBe("api_key");
    const me2 = await app.inject({ method: "GET", url: "/v1/keys/me", headers: { "x-api-key": body.api_key } });
    expect(me2.json().remaining).toBe(999);
    // purchase shows up in public metrics as a paid x402 call (owner wallet → excluded column, since 0x5344 is the test wallet)
    const m = (await app.inject({ method: "GET", url: "/v1/metrics" })).json();
    expect(m.weeks.at(-1).excluded_owner_wallets.usdc).toBeGreaterThanOrEqual(5);
  });
});
