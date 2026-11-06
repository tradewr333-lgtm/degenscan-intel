/**
 * Parity check (06/11, "Craft Anything" method): our replica vs the competitor's sampled response.
 * Input: a pairs JSON [{ ours: "gas_base", theirs_resource: "https://…/gas", our_response: {...} }] and the
 * x402-scout results.json (competitor schemas: field → type). Output: % of competitor fields we cover, the ones
 * we miss, and the ones only we have. Matching is by normalised field name (snake/camel, units and synonyms).
 * Data only — run it locally; nothing is called on the network.
 *
 *   npx tsx scripts/parity.ts pairs.json results.json > PARIDADE.md
 */
import { readFileSync } from "node:fs";

const SYN: Record<string, string> = { px: "price", price: "price", markpx: "mark", oraclepx: "oracle", midpx: "mid", fetchedat: "asof", generatedat: "asof", checkedat: "asof", refreshedat: "asof", updatedat: "asof", ts: "asof",
  chainid: "chainid", blocknumber: "block", basefeepergas: "basefee", basefeegwei: "basefee", nextbasefeewei: "basefee", gasprice: "gasprice", gaspricewei: "gasprice", priorityfeepergas: "priorityfee", priorityfeegwei: "priorityfee",
  maxfeepergas: "maxfee", maxfeegwei: "maxfee", maxfeewei: "maxfee", maxpriorityfeepergas: "maxpriorityfee", maxpriorityfeegwei: "maxpriorityfee", maxpriorityfeewei: "maxpriorityfee", suggestedfees: "suggested", ethusd: "ethusd",
  estimatedtransfercost: "transfercost", ethtransfer: "transfercost", per8h: "per8h", aprpct: "apr", apr: "apr", fundingrate: "rate", rate: "rate", fundingintervalhours: "intervalhours", intervalhours: "intervalhours", nextfundingtime: "nextfunding",
  predictedfunding: "predictedfunding", markoraclepremiumbps: "premiumbps", markoraclepremiumpct: "premiumpct", impactpremiumpct: "impactpremium", impactpremiumbps: "impactpremium", positivesharepct: "positiveshare", positiveshare7dpct: "positiveshare",
  tvlusd: "tvl", apybase: "apybase", apybasepct: "apybase", apy: "apy", apypct: "apy", apypct30d: "apy30d", apymean30dpct: "apy30d", supplyapypercent: "apy", project: "project", protocol: "project", pool: "poolid", poolid: "poolid",
  balance: "balance", ethbalance: "eth", account: "address", contractaddress: "tokenaddress", events: "items", result: "items", markets: "items", pools: "items", data: "data", meta: "meta", source: "source", sources: "source" };
const norm = (k: string) => { const n = k.toLowerCase().replace(/[^a-z0-9]/g, ""); return SYN[n] ?? n; };
function leaves(o: any, pre = ""): string[] {
  if (Array.isArray(o)) return o.length ? leaves(o[0], pre) : [pre];
  if (o && typeof o === "object") return Object.entries(o).flatMap(([k, v]) => leaves(v, pre ? `${pre}.${k}` : k));
  return [pre];
}
const keyOf = (path: string) => norm(path.split(".").pop() ?? path);

export function parity(theirSchema: any, ours: any) {
  const theirs = [...new Set(leaves(theirSchema).filter(Boolean))], mine = [...new Set(leaves(ours).filter(Boolean))];
  const mineKeys = new Set(mine.map(keyOf).concat(mine.flatMap(p => p.split(".").map(norm))));
  const covered = theirs.filter(p => mineKeys.has(keyOf(p)) || p.split(".").some(seg => mineKeys.has(norm(seg)) && seg === p.split(".").pop()));
  const missing = theirs.filter(p => !covered.includes(p));
  const theirKeys = new Set(theirs.map(keyOf).concat(theirs.flatMap(p => p.split(".").map(norm))));
  return { their_fields: theirs.length, covered: covered.length, coverage_pct: theirs.length ? Math.round(covered.length / theirs.length * 100) : 100, missing, only_ours: mine.filter(p => !theirKeys.has(keyOf(p))) };
}

if (process.argv[2]) {
  const pairs = JSON.parse(readFileSync(process.argv[2], "utf8")); const res = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const out = ["# Paridade das réplicas contra o concorrente", "", "| Nossa ferramenta | Concorrente | Preço deles | Compradores deles | Cobertura | Faltam |", "|---|---|---|---|---|---|"];
  for (const p of pairs) {
    const r = res.find((x: any) => x.resource === p.theirs_resource); if (!r?.schema) { out.push(`| ${p.ours} | ${p.theirs_resource} | — | — | sem amostra | — |`); continue; }
    const q = parity(r.schema, p.our_response);
    out.push(`| ${p.ours} | ${r.service} | $${r.price_catalog} | ${r.payers_30d} | ${q.coverage_pct}% (${q.covered}/${q.their_fields}) | ${q.missing.join(", ") || "—"} |`);
  }
  console.log(out.join("\n"));
}
