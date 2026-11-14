import { describe, it, expect, afterEach } from "vitest";
import { scanCode, minimalProxyTarget, SELECTORS, codeFlags, bytecodeScan, _rpc } from "../src/server/bytecode.js";

const sel = (g: string, sig: string) => SELECTORS[g].find(s => s.sig === sig)!.sel;
const realCall = _rpc.call;
describe("on-chain bytecode scan (13/11)", () => {
  afterEach(() => { _rpc.call = realCall; });
  it("selectors are the real keccak ones", () => {
    expect(sel("pause", "pause()")).toBe("8456cb59");
    expect(sel("ownership", "owner()")).toBe("8da5cb5b");
    expect(sel("mint", "mint(address,uint256)")).toBe("40c10f19");
  });
  it("finds PUSH4 selectors and maps them to flags", () => {
    const code = "0x6080" + "63" + sel("pause", "pause()") + "14" + "63" + sel("blacklist", "setBots(address[],bool)") + "63" + sel("ownership", "owner()") + "00";
    const f = scanCode(code);
    expect(Object.keys(f).sort()).toEqual(["blacklist", "ownership", "pause"]);
    const flags = codeFlags({ has_code: true, proxy: "eip1967", implementation: "0x1", functions: f, code_bytes: 10 });
    expect(flags.map(x => x.id)).toEqual(["code_blacklist", "code_pausable", "code_upgradeable"]);
    expect(scanCode("0x" + sel("pause", "pause()"))).toEqual({});   // without PUSH4 it is not a dispatcher entry
  });
  it("follows proxies to the implementation", async () => {
    const impl = "1111111111111111111111111111111111111111";
    expect(minimalProxyTarget(`0x363d3d373d3d3d363d73${impl}5af43d82803e903d91602b57fd5bf3`)).toBe("0x" + impl);
    _rpc.call = async (_u: string, method: string, params: any[]) => {
      if (method === "eth_getStorageAt") return "0x000000000000000000000000" + impl;
      if (method === "eth_getCode" && params[0] === "0x" + impl) return "0x63" + sel("mint", "mint(address,uint256)");
      return "0x6080604052";
    };
    const r = await bytecodeScan("0x2222222222222222222222222222222222222222", "base");
    expect(r).toMatchObject({ has_code: true, proxy: "eip1967", implementation: "0x" + impl, functions: { mint: ["mint(address,uint256)"] } });
    _rpc.call = async () => "0x";
    expect((await bytecodeScan("0x2222222222222222222222222222222222222222", "base"))?.has_code).toBe(false);
    expect(await bytecodeScan("0x2222222222222222222222222222222222222222", "fantom")).toBeNull();
  });
});
