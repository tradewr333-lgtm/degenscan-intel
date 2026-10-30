import { describe, it, expect } from "vitest";
import { createCarryKey, isLicenseKey, activatePackKey, CARRY_LICENSE } from "../src/server/keys.js";
import { buildHttp } from "../src/server/http.js";
describe("carry license", () => {
  it("price fixed by Renato", () => { expect(CARRY_LICENSE).toMatchObject({ usd_initial: 1500, usd_month: 300, days: 30 }); });
  it("only license keys open the export", async () => {
    const lic = createCarryKey({ via: "x402", tier: "desk", wallet: "0xabc", label: "carry license carry_license x402" }); activatePackKey(lic.id, "0xtx");
    const desk = createCarryKey({ via: "x402", tier: "desk", wallet: "0xabc" }); activatePackKey(desk.id, "0xtx2");
    expect(isLicenseKey(lic.key)).toBe(true); expect(isLicenseKey(desk.key)).toBe(false);
    const app = await buildHttp();
    expect((await app.inject({ method: "GET", url: "/v1/carry/license/export" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/carry/license/export", headers: { "x-api-key": desk.key } })).statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/v1/carry/license/export", headers: { "x-api-key": lic.key } });
    expect(ok.statusCode).toBe(200); expect(ok.headers["content-type"]).toContain("gzip");
    const w = (await app.inject({ method: "GET", url: "/.well-known/x402" })).json(); expect(w.carry_license.buy.length).toBe(2);
    await app.close();
  });
});
