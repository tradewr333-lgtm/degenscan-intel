import { describe, it, expect, afterEach } from "vitest";
import { idemKeyOf, payerOf, idemGet, idemPut, _idem } from "../src/server/idempotency.js";

const pay = (from: string) => Buffer.from(JSON.stringify({ x402Version: 2, payload: { authorization: { from } } })).toString("base64");
describe("idempotent paid retries (13/11)", () => {
  afterEach(() => _idem.reset());
  it("parses the key and the payer", () => {
    expect(idemKeyOf({ "idempotency-key": "abc" })).toBeNull();
    expect(idemKeyOf({ "idempotency-key": "a1b2c3d4e5f6" })).toBe("a1b2c3d4e5f6");
    expect(payerOf({ "payment-signature": pay("0xAbC0000000000000000000000000000000000001") })).toBe("0xabc0000000000000000000000000000000000001");
    expect(payerOf({ "payment-signature": "not-base64-json" })).toBeNull();
  });
  it("replays only for the same payer, key, method and URL", () => {
    idemPut("0xa", "k1234567", "GET", "/v1/x?a=1", { status: 200, body: "{}", contentType: "application/json", paymentResponse: "pr" });
    expect(idemGet("0xa", "k1234567", "GET", "/v1/x?a=1")?.paymentResponse).toBe("pr");
    expect(idemGet("0xb", "k1234567", "GET", "/v1/x?a=1")).toBeNull();
    expect(idemGet("0xa", "k1234567", "GET", "/v1/x?a=2")).toBeNull();
  });
  it("a stored response is served before the x402 hook (no 402, no second charge)", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const url = "/v1/travel/airfare?from=MIA&to=LGA", from = "0x1234567890123456789012345678901234567890";
    const unpaid = await app.inject({ method: "GET", url, headers: { "payment-signature": pay(from), "idempotency-key": "retry-0001" } });
    expect(unpaid.statusCode).not.toBe(200);                     // nothing stored yet → normal x402 path
    idemPut(from, "retry-0001", "GET", url, { status: 200, body: '{"ok":true}', contentType: "application/json", paymentResponse: "cmVjZWlwdA==" });
    const r = await app.inject({ method: "GET", url, headers: { "payment-signature": pay(from), "idempotency-key": "retry-0001" } });
    expect(r.statusCode).toBe(200); expect(r.headers["idempotent-replayed"]).toBe("true"); expect(r.headers["payment-response"]).toBe("cmVjZWlwdA=="); expect(r.json()).toEqual({ ok: true });
    const other = await app.inject({ method: "GET", url, headers: { "payment-signature": pay("0x9999999999999999999999999999999999999999"), "idempotency-key": "retry-0001" } });
    expect(other.headers["idempotent-replayed"]).toBeUndefined();
  });
});
