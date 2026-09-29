/**
 * One real x402 v2 payment against the live server — used to (a) index the service in the Coinbase Bazaar
 * (CDP catalogs a resource on its first CDP-settled payment) and (b) prove the payment path end to end.
 *
 *   TEST_WALLET_PK=... npx tsx scripts/pay-test.ts [baseUrl] [path]
 *
 * Uses the DISCLOSED operator test wallet (listed in /wallets.json, excluded from /v1/metrics). Never a main wallet.
 * Default path: /v1/pulse ($0.001). Without the X-Free-Trial header the server answers 402 immediately.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const BASE_URL = (process.argv[2] ?? "https://intel.degenscan.io").replace(/\/$/, "");
const PATH = process.argv[3] ?? "/v1/pulse";
let pkRaw = (process.env.TEST_WALLET_PK ?? "").trim();
if (pkRaw && !pkRaw.startsWith("0x")) pkRaw = "0x" + pkRaw;
if (!/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) { console.error("Set TEST_WALLET_PK to the disclosed test wallet private key (64 hex chars)."); process.exit(1); }

const account = privateKeyToAccount(pkRaw as `0x${string}`);
console.log(`Payer (disclosed test wallet): ${account.address}\nServer: ${BASE_URL}${PATH}\n`);

// 1. see the 402 (no trial header)
const first = await fetch(`${BASE_URL}${PATH}`);
console.log(`Unpaid request → HTTP ${first.status}`);
const hdr = first.headers.get("payment-required");
if (first.status !== 402 || !hdr) { console.error("Expected 402 with PAYMENT-REQUIRED header. Aborting."); process.exit(1); }
const req: any = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
for (const a of req.accepts ?? []) console.log(`  accepts: ${a.network} ${Number(a.amount) / 1e6} USDC → ${a.payTo}  extra=${JSON.stringify(a.extra ?? {})}`);
console.log(`  resource: ${req.resource?.url ?? req.resource}\n  extensions declared: ${Object.keys(req.extensions ?? {}).join(",") || "none"}\n`);

// 2. pay it (Base only)
const fetchWithPay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
const t0 = Date.now();
const paid = await fetchWithPay(`${BASE_URL}${PATH}`);
const body: any = await paid.json().catch(() => ({}));
console.log(`Paid request → HTTP ${paid.status} in ${Date.now() - t0} ms`);
console.log(`  _billing: ${JSON.stringify(body._billing)}`);
const pr = paid.headers.get("payment-response");
if (pr) { try { const r: any = decodePaymentResponseHeader(pr); console.log(`  settlement: success=${r.success} network=${r.network} tx=${r.transaction}`); console.log(`  basescan: https://basescan.org/tx/${r.transaction}`); } catch { console.log("  payment-response:", pr); } }
else console.log("  (no PAYMENT-RESPONSE header — settlement not confirmed)");

console.log(`\nNext (wait ~10 min): https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000  → search "intel.degenscan.io"`);
