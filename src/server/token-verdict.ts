/**
 * token_verdict — "is this token contract safe to touch?" for agents that trade, snipe or route swaps.
 * Deterministic rules over public, keyless sources (GoPlus token security + DexScreener pairs); no LLM, ~1 s, cached 5 min.
 * Verdict scale deliberately never says "safe": LOW_RISK | CAUTION | HIGH_RISK | DANGER.
 * Information and analytics only — not investment advice.
 */
import { z } from "zod";
import { _ext } from "./tools.js";

export const TokenVerdictArgs = z.object({
  address: z.string().min(20).max(64).describe("Token contract address (0x… for EVM, base58 mint for Solana)"),
  chain: z.string().optional().describe("base (default for 0x), ethereum, bsc, arbitrum, polygon, optimism, avalanche, solana (auto for base58)"),
});

const EVM_CHAINS: Record<string, { goplus: string; dexscreener: string }> = {
  base: { goplus: "8453", dexscreener: "base" }, ethereum: { goplus: "1", dexscreener: "ethereum" }, eth: { goplus: "1", dexscreener: "ethereum" },
  bsc: { goplus: "56", dexscreener: "bsc" }, arbitrum: { goplus: "42161", dexscreener: "arbitrum" }, polygon: { goplus: "137", dexscreener: "polygon" },
  optimism: { goplus: "10", dexscreener: "optimism" }, avalanche: { goplus: "43114", dexscreener: "avalanche" },
};

const cache = new Map<string, { at: number; v: any }>();
export const _tv = { reset() { cache.clear(); } };
const TTL = 5 * 60_000;

type Flag = { id: string; severity: "critical" | "high" | "medium" | "info"; detail: string };
const PENALTY = { critical: 60, high: 20, medium: 8, info: 0 } as const;
const one = (v: any) => String(v ?? "") === "1";
const numOr = (v: any, d: number | null = null) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const r = (x: number | null, d = 4) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

export async function tokenVerdict(a: z.infer<typeof TokenVerdictArgs>) {
  const address = a.address.trim();
  const isEvm = /^0x[0-9a-fA-F]{40}$/.test(address);
  const isSol = !isEvm && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (!isEvm && !isSol) throw new Error("invalid address: expected 0x + 40 hex (EVM) or a base58 Solana mint");
  const chain = (a.chain ?? (isSol ? "solana" : "base")).toLowerCase();
  if (isSol && chain !== "solana") throw new Error("base58 address given with an EVM chain");
  if (isEvm && !EVM_CHAINS[chain]) throw new Error(`unsupported chain ${chain}; use one of ${Object.keys(EVM_CHAINS).filter(c => c !== "eth").join(", ")}, solana`);
  const key = `${chain}:${address.toLowerCase()}`;
  const hit = cache.get(key); if (hit && Date.now() - hit.at < TTL) return { ...hit.v, cached: true };

  const unavailable: string[] = [];
  const gpUrl = isSol
    ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`
    : `https://api.gopluslabs.io/api/v1/token_security/${EVM_CHAINS[chain].goplus}?contract_addresses=${address.toLowerCase()}`;
  const [gp, ds] = await Promise.all([
    _ext.get<any>(gpUrl, { timeoutMs: 8000 }).catch(e => { unavailable.push(`goplus: ${(e as Error).message.slice(0, 80)}`); return null; }),
    _ext.get<any>(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeoutMs: 8000 }).catch(e => { unavailable.push(`dexscreener: ${(e as Error).message.slice(0, 80)}`); return null; }),
  ]);
  const sec: any = gp?.result ? (gp.result[address.toLowerCase()] ?? gp.result[address] ?? Object.values(gp.result)[0] ?? null) : null;
  const dsChain = isSol ? "solana" : EVM_CHAINS[chain].dexscreener;
  const pairs: any[] = (ds?.pairs ?? []).filter((p: any) => p.chainId === dsChain);
  if (!sec && !pairs.length) {
    if (unavailable.length === 2) throw new Error("sources unavailable: " + unavailable.join("; "));
    throw new Error(`token not found on ${chain} (no security record and no DEX pair)`);
  }

  const flags: Flag[] = [];
  const add = (cond: boolean, id: string, severity: Flag["severity"], detail: string) => { if (cond) flags.push({ id, severity, detail }); };

  if (sec && !isSol) {
    const buyTax = numOr(sec.buy_tax), sellTax = numOr(sec.sell_tax);
    add(one(sec.is_honeypot), "honeypot", "critical", "simulated sell fails (honeypot)");
    add(one(sec.cannot_sell_all), "cannot_sell_all", "critical", "holders cannot sell their full balance");
    add(one(sec.cannot_buy), "cannot_buy", "critical", "buying is blocked");
    add(sellTax != null && sellTax >= 0.5, "sell_tax_extreme", "critical", `sell tax ${Math.round((sellTax ?? 0) * 100)}%`);
    add(one(sec.honeypot_with_same_creator), "creator_made_honeypots", "critical", "the same creator deployed honeypots before");
    add(one(sec.selfdestruct), "selfdestruct", "critical", "contract can self-destruct");
    add(one(sec.owner_change_balance), "owner_change_balance", "critical", "owner can change holder balances");
    add(one(sec.hidden_owner), "hidden_owner", "high", "hidden owner / privileged role");
    add(one(sec.can_take_back_ownership), "reclaim_ownership", "high", "renounced ownership can be reclaimed");
    add(one(sec.is_mintable), "mintable", "high", "supply can be minted");
    add(one(sec.transfer_pausable), "pausable", "high", "transfers can be paused");
    add(one(sec.is_blacklisted), "blacklist", "high", "owner can blacklist addresses");
    add(one(sec.slippage_modifiable) || one(sec.personal_slippage_modifiable), "tax_modifiable", "high", "owner can change taxes (globally or per address)");
    add(sellTax != null && sellTax >= 0.1 && sellTax < 0.5, "sell_tax_high", "high", `sell tax ${Math.round((sellTax ?? 0) * 100)}%`);
    add(buyTax != null && buyTax >= 0.1, "buy_tax_high", "high", `buy tax ${Math.round((buyTax ?? 0) * 100)}%`);
    add(sec.is_open_source != null && !one(sec.is_open_source), "not_verified", "high", "source code not verified");
    add(one(sec.is_proxy), "proxy", "medium", "upgradeable proxy: logic can change");
    add(one(sec.external_call), "external_call", "medium", "calls external contracts in transfers");
    add(one(sec.trading_cooldown), "cooldown", "medium", "trading cooldown enforced");
  }
  if (sec && isSol) {
    const st = (x: any) => String(x?.status ?? x ?? "") === "1";
    add(st(sec.mintable), "mintable", "high", "mint authority is active");
    add(st(sec.freezable), "freezable", "high", "freeze authority is active (accounts can be frozen)");
    add(st(sec.closable), "closable", "high", "token accounts can be closed by an authority");
    add(st(sec.balance_mutable_authority), "balance_mutable", "critical", "an authority can change balances");
    add(st(sec.non_transferable), "non_transferable", "critical", "token is non-transferable");
    add(st(sec.transfer_hook), "transfer_hook", "medium", "transfer hook program attached");
    const fee = numOr(sec.transfer_fee?.fee_rate ?? sec.transfer_fee_rate);
    add(fee != null && fee >= 0.1, "transfer_fee_high", "high", `transfer fee ${Math.round((fee ?? 0) * 100)}%`);
  }

  // holder concentration (excluding contracts/locked, when flagged)
  const holders: any[] = sec?.holders ?? [];
  const top10 = holders.filter(h => !one(h.is_contract) && !one(h.is_locked)).slice(0, 10).reduce((s, h) => s + (numOr(h.percent, 0) ?? 0), 0);
  const holderCount = numOr(sec?.holder_count);
  add(holders.length > 0 && top10 > 0.5, "concentrated", "medium", `top-10 non-contract holders own ${Math.round(top10 * 100)}%`);
  add(holderCount != null && holderCount < 100, "few_holders", "medium", `${holderCount} holders`);
  const creatorPct = numOr(sec?.creator_percent);
  add(creatorPct != null && creatorPct > 0.05, "creator_holds", "medium", `creator holds ${Math.round((creatorPct ?? 0) * 100)}%`);
  const lp: any[] = sec?.lp_holders ?? [];
  const lpLocked = lp.reduce((s, h) => s + (one(h.is_locked) || /dead|0x0{40}|burn/i.test(String(h.address ?? "") + String(h.tag ?? "")) ? (numOr(h.percent, 0) ?? 0) : 0), 0);
  // LP-lock only means something for fungible V2-style LP tokens; V3/V4 positions are NFTs and Solana pools report differently
  const v2Pools = (sec?.dex ?? []).some((d: any) => !/v3|v4|cl|concentrated/i.test(String(d.liquidity_type ?? d.name ?? "")));
  add(!isSol && v2Pools && lp.length > 0 && lpLocked < 0.5, "lp_unlocked", "medium", `only ${Math.round(lpLocked * 100)}% of LP locked or burned`);

  // market structure from DexScreener
  const best = pairs.sort((x, y) => (y.liquidity?.usd ?? 0) - (x.liquidity?.usd ?? 0))[0] ?? null;
  const liq = pairs.reduce((s, p) => s + (numOr(p.liquidity?.usd, 0) ?? 0), 0);
  const vol24 = pairs.reduce((s, p) => s + (numOr(p.volume?.h24, 0) ?? 0), 0);
  const ageH = best?.pairCreatedAt ? (Date.now() - Number(best.pairCreatedAt)) / 3_600_000 : null;
  add(pairs.length === 0, "no_dex_pair", "high", "no DEX pair found on this chain");
  add(pairs.length > 0 && liq < 50_000, "thin_liquidity", "medium", `total DEX liquidity $${Math.round(liq).toLocaleString("en-US")}`);
  add(ageH != null && ageH < 24, "new_pair", "medium", `main pair is ${ageH!.toFixed(1)} h old`);
  add(sec != null && one(sec.is_in_cex?.listed ?? sec.is_in_cex), "listed_on_cex", "info", "listed on a centralized exchange");

  const score = Math.max(0, 100 - flags.reduce((s, f) => s + PENALTY[f.severity], 0));
  const verdict = flags.some(f => f.severity === "critical") ? "DANGER" : score < 60 ? "HIGH_RISK" : score < 80 ? "CAUTION" : "LOW_RISK";
  const worst = flags.filter(f => f.severity !== "info").sort((x, y) => PENALTY[y.severity] - PENALTY[x.severity]).slice(0, 3).map(f => f.detail);
  const name = sec?.token_symbol ?? sec?.metadata?.symbol ?? best?.baseToken?.symbol ?? null;
  const summary = `${name ?? "Token"} on ${chain}: ${verdict} (score ${score}/100). ` + (worst.length ? `Main issues: ${worst.join("; ")}.` : "No contract red flags found by the checks run.") + (best ? ` Liquidity $${Math.round(liq).toLocaleString("en-US")}, 24h volume $${Math.round(vol24).toLocaleString("en-US")}.` : "");

  const out = {
    address, chain, symbol: name, name: sec?.token_name ?? best?.baseToken?.name ?? null, as_of: new Date().toISOString(),
    verdict, score, summary, flags,
    contract: sec && !isSol ? {
      verified: sec.is_open_source == null ? null : one(sec.is_open_source), proxy: one(sec.is_proxy), mintable: one(sec.is_mintable),
      owner: sec.owner_address || null, owner_renounced: !sec.owner_address || /^0x0{40}$/i.test(sec.owner_address) || /dead$/i.test(sec.owner_address),
      buy_tax: numOr(sec.buy_tax), sell_tax: numOr(sec.sell_tax), honeypot: one(sec.is_honeypot),
    } : sec && isSol ? { mint_authority_active: String(sec.mintable?.status ?? "") === "1", freeze_authority_active: String(sec.freezable?.status ?? "") === "1" } : null,
    holders: { count: holderCount, top10_non_contract_pct: holders.length ? r(top10, 4) : null, creator_pct: creatorPct, lp_locked_or_burned_pct: lp.length ? r(lpLocked, 4) : null },
    market: best ? { pairs: pairs.length, liquidity_usd: Math.round(liq), volume_24h_usd: Math.round(vol24), price_usd: numOr(best.priceUsd), fdv_usd: numOr(best.fdv), main_pair: { dex: best.dexId, address: best.pairAddress, url: best.url, age_hours: r(ageH, 1) } } : null,
    method: "Deterministic rules over GoPlus token-security and DexScreener pair data; score = 100 − penalties (critical 60, high 20, medium 8). Any critical flag ⇒ DANGER. Absence of flags is not a guarantee.",
    sources: { goplus: gp ? "https://gopluslabs.io (token security API)" : null, dexscreener: ds ? "https://dexscreener.com" : null },
    sources_unavailable: unavailable,
    related: { price: "/v1/price/{symbol}", whales: "/v1/whales", events: "/v1/events?since=4h" },
    disclaimer: "Information and analytics only — not investment advice. Automated checks can miss risks; LOW_RISK is not a guarantee.",
  };
  cache.set(key, { at: Date.now(), v: out });
  return out;
}
