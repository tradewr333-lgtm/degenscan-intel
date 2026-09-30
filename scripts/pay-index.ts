/**
 * Index EVERY priced route in the Coinbase x402 Bazaar: CDP catalogs a resource only after a CDP-settled payment whose
 * payload echoes the route's `bazaar` extension (the @x402 client does this automatically). /v1/pulse is already indexed
 * (29/09); this pays ONE call per remaining route, once, from the DISCLOSED operator test wallet (/wallets.json),
 * which /v1/metrics excludes from customers and revenue. Total ≈ US$0.43.
 *
 *   TEST_WALLET_PK=... npx tsx scripts/pay-index.ts [baseUrl]
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const BASE = (process.argv[2] ?? "https://intel.degenscan.io").replace(/\/$/, "");
let pk = (process.env.TEST_WALLET_PK ?? "").trim(); if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error("Set TEST_WALLET_PK to the disclosed test wallet private key."); process.exit(1); }
const account = privateKeyToAccount(pk as `0x${string}`);
if (account.address.toLowerCase() !== "0x5344722b8d037827a9a5b7cd6312481d215d33bf") { console.error(`Refusing: ${account.address} is not the disclosed test wallet (Descarte).`); process.exit(1); }
const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });

// free-trial lookups for ids the paid calls need (no payment)
const trial = (p: string) => fetch(BASE + p, { headers: { "X-Free-Trial": "1" } }).then(r => r.json()).catch(() => ({}));
const ev: any = await trial("/v1/events?since=48h&limit=1");
const eventId = ev?.events?.[0]?.id;
const pm: any = await trial("/v1/polymarket/top?limit=1");
const market = pm?.markets?.[0]?.slug;
const board: any = await fetch(BASE + "/v1/oracle/board/questions").then(r => r.json()).catch(() => ({}));
const slug = (board?.questions ?? [])[0]?.slug ?? "btc-120k-oct31";

const calls: { method: "GET" | "POST"; path: string; body?: any }[] = [
  { method: "GET", path: "/v1/price/BTC" },
  { method: "GET", path: "/v1/funding/alerts" },
  { method: "GET", path: "/v1/whales" },
  { method: "GET", path: "/v1/polymarket/top" },
  { method: "GET", path: "/v1/derivs/BTC" },
  { method: "GET", path: "/v1/news/BTC" },
  { method: "GET", path: "/v1/filings/NVDA" },
  { method: "GET", path: "/v1/calendar?days=7" },
  { method: "GET", path: "/v1/events?since=4h&universe=BTC,NVDA" },
  { method: "GET", path: "/v1/impact/BTC" },
  { method: "GET", path: "/v1/graph/NVDA" },
  { method: "GET", path: "/v1/regime" },
  ...(eventId ? [{ method: "GET" as const, path: `/v1/explain/${eventId}` }] : []),
  ...(market ? [{ method: "GET" as const, path: `/v1/polymarket/${market}` }] : []),
  { method: "GET", path: "/v1/token/verdict/0x4ed4e862860bed51a9570b96d89af5e1b0efefed?chain=base" },
  { method: "GET", path: "/v1/oracle/board" },
  { method: "GET", path: `/v1/oracle/board/${slug}` },
  { method: "GET", path: "/v1/brief/BTC" },
  { method: "POST", path: "/v1/oracle/forecast", body: { question: "Will Bitcoin close above 100,000 USD on 2026-10-31 (Coinbase daily close, UTC)?", resolves_at: "2026-10-31T23:59:59Z" } },
];

console.log(`Payer (disclosed test wallet): ${account.address}\nServer: ${BASE}\n${calls.length} routes\n`);
let ok = 0, spent = 0;
for (const c of calls) {
  try {
    const init: RequestInit = c.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c.body) } : {};
    const res = await pay(BASE + c.path, init);
    const body: any = await res.json().catch(() => ({}));
    const pr = res.headers.get("payment-response");
    let tx = ""; if (pr) { try { tx = (decodePaymentResponseHeader(pr) as any).transaction ?? ""; } catch { /* */ } }
    const usd = body?._billing?.price_usd ?? body?._billing?.price ?? 0;
    if (res.ok && tx) { ok++; spent += Number(usd) || 0; }
    console.log(`${res.ok && tx ? "OK " : "-- "} ${c.method} ${c.path}  HTTP ${res.status}  ${tx ? "tx " + tx : body?.error ? "error: " + String(body.error).slice(0, 80) : "(no settlement)"}`);
  } catch (e) { console.log(`ERR ${c.method} ${c.path}  ${(e as Error).message.slice(0, 120)}`); }
}
console.log(`\n${ok}/${calls.length} settled, ~US$${spent.toFixed(3)}. Bazaar picks them up in ~10 min:\nhttps://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000`);
