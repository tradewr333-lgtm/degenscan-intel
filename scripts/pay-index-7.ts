/**
 * Index the routes added after 30/09 in the Coinbase x402 Bazaar (CDP catalogs a resource on its first CDP-settled payment).
 * ONE call per route, once, from the DISCLOSED operator test wallet (Descarte, /wallets.json), which /v1/metrics excludes
 * from customers and revenue. This is indexing, never volume (rule: zero wash). Total ≈ US$0.03.
 *
 *   TEST_WALLET_PK=... npx tsx scripts/pay-index-7.ts [baseUrl]
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

const calls = [
  // 3 that answered 502 right after the 0.10.48 deploy (collector still warming)
  "/v1/hl/smart-money/BTC?hours=24", "/v1/hl/smart-money?hours=4", "/v1/coin/BTC",
  // AI Intel (0.10.49)
  "/v1/ai/models?sort=price&limit=10", "/v1/ai/cheapest?needs=tools", "/v1/ai/cost?input_tokens=2000&output_tokens=500&calls=1000",
  "/v1/ai/adoption", "/v1/ai/research", "/v1/ai/regulation/eu",
];
console.log(`Payer (disclosed test wallet): ${account.address}\nServer: ${BASE}\n${calls.length} routes, ONE call each\n`);
let ok = 0, spent = 0;
for (const path of calls) {
  try {
    const res = await pay(BASE + path);
    const body: any = await res.json().catch(() => ({}));
    const pr = res.headers.get("payment-response");
    let tx = ""; if (pr) { try { tx = (decodePaymentResponseHeader(pr) as any).transaction ?? ""; } catch { /* */ } }
    if (res.ok && tx) { ok++; spent += Number(body?._billing?.price_usd ?? 0) || 0; }
    console.log(`${res.ok && tx ? "OK " : "-- "} GET ${path}  HTTP ${res.status}  ${tx ? "tx " + tx : body?.error ? "error: " + String(body.error).slice(0, 80) : "(no settlement)"}`);
  } catch (e) { console.log(`ERR GET ${path}  ${(e as Error).message.slice(0, 120)}`); }
}
console.log(`\n${ok}/${calls.length} settled, ~US$${spent.toFixed(3)}. The Bazaar picks them up within minutes to a few hours:\nhttps://api.cdp.coinbase.com/platform/v2/x402/discovery/search?q=hyperliquid%20funding`);
