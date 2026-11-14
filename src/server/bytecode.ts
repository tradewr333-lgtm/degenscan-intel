/**
 * On-chain bytecode scan (13/11, Renato — BRAINIAC cold e-mail selling a $0.04 "pause/blacklist in Base bytecode" check).
 * PRIMARY source: the token's own deployed code, read with eth_getCode from a public RPC (follows EIP-1967 and EIP-1167
 * proxies to the implementation). We look for the 4-byte function selectors of admin powers that trap buyers:
 * pause, blacklist/bot lists, trading switches, fee/tax setters, mint, max-tx/wallet limits.
 * Used inside token_verdict / token_risk as an independent second source next to GoPlus, and as the fallback when
 * GoPlus is down. A selector being present means the function exists, not that it was or will be used.
 */
import { toFunctionSelector } from "viem";

export const RPC: Record<string, string> = {
  base: "https://base-rpc.publicnode.com", ethereum: "https://ethereum-rpc.publicnode.com", eth: "https://ethereum-rpc.publicnode.com",
  bsc: "https://bsc-rpc.publicnode.com", arbitrum: "https://arbitrum-one-rpc.publicnode.com", polygon: "https://polygon-bor-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com", avalanche: "https://avalanche-c-chain-rpc.publicnode.com",
};
const GROUPS: Record<string, string[]> = {
  pause: ["pause()", "unpause()", "setPaused(bool)", "togglePause()"],
  trading_switch: ["enableTrading()", "openTrading()", "setTradingEnabled(bool)", "setTrading(bool)", "startTrading()", "tradingStatus(bool)"],
  blacklist: ["blacklist(address)", "addToBlacklist(address)", "addBlacklist(address)", "setBlacklist(address,bool)", "blacklistAddress(address,bool)", "isBlacklisted(address)",
    "addBot(address)", "addBots(address[])", "setBots(address[],bool)", "blockBots(address[])", "setBot(address,bool)", "isBot(address)"],
  fee_setter: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxes(uint256,uint256)", "setBuyFee(uint256)", "setSellFee(uint256)", "setBuyTax(uint256)", "setSellTax(uint256)",
    "updateFees(uint256,uint256)", "updateBuyFees(uint256,uint256,uint256)", "updateSellFees(uint256,uint256,uint256)", "setTaxFeePercent(uint256)"],
  mint: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)"],
  limits: ["setMaxTxAmount(uint256)", "setMaxWalletSize(uint256)", "setMaxWallet(uint256)", "updateMaxTxnAmount(uint256)", "setMaxTxPercent(uint256)"],
  ownership: ["owner()", "renounceOwnership()", "transferOwnership(address)"],
};
export const SELECTORS: Record<string, { sig: string; sel: string }[]> = Object.fromEntries(Object.entries(GROUPS).map(([g, sigs]) => [g, sigs.map(sig => ({ sig, sel: toFunctionSelector(sig).slice(2) }))]));
// EIP-1967 implementation slot, then the older OpenZeppelin/zeppelinos slot (used by Circle's FiatTokenProxy, i.e. USDC)
const IMPL_SLOTS: [string, string][] = [["eip1967", "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"], ["zeppelinos", "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3"]];

/** Pure: runtime bytecode hex → selector groups found (PUSH4 + selector). Exported for tests. */
export function scanCode(code: string) {
  const hex = String(code ?? "").toLowerCase().replace(/^0x/, "");
  const found: Record<string, string[]> = {};
  for (const [g, list] of Object.entries(SELECTORS)) {
    const hits = list.filter(s => hex.includes("63" + s.sel)).map(s => s.sig);
    if (hits.length) found[g] = hits;
  }
  return found;
}
/** Pure: EIP-1167 minimal proxy → implementation address. */
export function minimalProxyTarget(code: string) {
  const m = String(code ?? "").toLowerCase().match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3/);
  return m ? "0x" + m[1] : null;
}

export const _rpc = {
  call: async (url: string, method: string, params: unknown[]) => {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "curl/8.5.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`rpc ${res.status}`);
    const j = await res.json() as any; if (j.error) throw new Error(`rpc ${j.error.message ?? "error"}`); return j.result as string;
  },
};

export async function bytecodeScan(address: string, chain: string) {
  const url = RPC[chain]; if (!url) return null;
  let code = await _rpc.call(url, "eth_getCode", [address, "latest"]);
  if (!code || code === "0x") return { has_code: false, proxy: null, implementation: null, functions: {}, code_bytes: 0 };
  let impl = minimalProxyTarget(code), proxy: string | null = impl ? "eip1167" : null;
  for (const [kind, s] of IMPL_SLOTS) {
    if (impl) break;
    const slot = await _rpc.call(url, "eth_getStorageAt", [address, s, "latest"]).catch(() => null);
    if (slot && !/^0x0*$/.test(slot)) { impl = "0x" + slot.slice(-40); proxy = kind; }
  }
  if (impl) { const c2 = await _rpc.call(url, "eth_getCode", [impl, "latest"]).catch(() => null); if (c2 && c2 !== "0x") code = c2; }
  return { has_code: true, proxy, implementation: impl, functions: scanCode(code), code_bytes: (code.length - 2) / 2 };
}

/** Pure: scan → flags in token_verdict's format (used only when GoPlus is unavailable, to avoid double counting). */
export function codeFlags(scan: Awaited<ReturnType<typeof bytecodeScan>>) {
  if (!scan?.has_code) return [];
  const f = scan.functions, out: { id: string; severity: "critical" | "high" | "medium" | "info"; detail: string }[] = [];
  const owned = !!f.ownership;
  if (f.blacklist) out.push({ id: "code_blacklist", severity: "high", detail: `contract has a blacklist/bot-list function (${f.blacklist[0]})` });
  if (f.pause) out.push({ id: "code_pausable", severity: "high", detail: `contract can pause transfers (${f.pause[0]})` });
  if (f.trading_switch) out.push({ id: "code_trading_switch", severity: "medium", detail: `owner controls a trading on/off switch (${f.trading_switch[0]})` });
  if (f.fee_setter) out.push({ id: "code_fee_setter", severity: "medium", detail: `fees/taxes can be changed (${f.fee_setter[0]})` });
  if (f.mint) out.push({ id: "code_mintable", severity: "medium", detail: `supply can be minted (${f.mint[0]})` });
  if (f.limits) out.push({ id: "code_tx_limits", severity: "info", detail: `max transaction/wallet limits can be changed (${f.limits[0]})` });
  if (scan.proxy) out.push({ id: "code_upgradeable", severity: "medium", detail: `upgradeable proxy (${scan.proxy}); the logic can be replaced` });
  if (!owned && out.length) out.push({ id: "code_no_owner_fn", severity: "info", detail: "no owner() function found; admin powers may use another access-control scheme" });
  return out;
}
