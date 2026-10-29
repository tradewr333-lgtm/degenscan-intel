import { describe, it, expect } from "vitest";
import { rewriteAlias, aliasPaths, ALIASES } from "../src/server/aliases.js";
import { buildHttp } from "../src/server/http.js";
describe("keyword aliases", () => {
  it("rewrites with params", () => {
    expect(rewriteAlias("/funding-rate?coin=BTC")).toBe("/v1/carry/now/BTC");
    expect(rewriteAlias("/token-risk?address=0xabc&chain=base")).toBe("/v1/token/verdict/0xabc?chain=base");
    expect(rewriteAlias("/candles?coin=xyz:NBIS&interval=1h")).toBe("/v1/hl/candles/xyz%3ANBIS?interval=1h");
    expect(rewriteAlias("/gas-price")).toBe("/v1/gas/base");
    expect(rewriteAlias("/funding-rate")).toBe("/funding-rate");
    expect(rewriteAlias("/v1/pulse?x=1")).toBe("/v1/pulse?x=1");
  });
  it("served: 402 on alias, openapi lists aliases, missing param 400", async () => {
    const app = await buildHttp();
    const r = await app.inject({ method: "GET", url: "/market-pulse" });
    expect([402, 200]).toContain(r.statusCode);
    const c = await app.inject({ method: "GET", url: "/v1/pulse" });
    expect(r.statusCode).toBe(c.statusCode);
    const m = await app.inject({ method: "GET", url: "/funding-rate" });
    expect(m.statusCode).toBe(400);
    const o = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    const missing = Object.keys(ALIASES).filter(a => !o.paths[a]);
    expect(missing).toEqual([]);
    expect(o.paths["/funding-rate"].get["x-price-usd"]).toBe(o.paths["/v1/carry/now/{coin}"].get["x-price-usd"]);
    await app.close();
  });
});
describe("well-known aliases", () => { it("lists aliases as priced resources", async () => {
  const app = await buildHttp(); const w = (await app.inject({ method: "GET", url: "/.well-known/x402" })).json();
  const tr = w.resources.find((r: any) => r.http?.includes("/token-risk?"));
  expect(tr.tool).toBe("token_verdict"); expect(tr.price_usd).toBeGreaterThan(0);
  expect(w.resources.filter((r: any) => r.alias_of && !r.price_usd)).toEqual([]);
  await app.close(); }); });
