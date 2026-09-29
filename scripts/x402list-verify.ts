/**
 * Trigger x402-list's "verified" badge: they pay a real call to our endpoint and check it delivers.
 * Their endpoint itself is x402-priced ($0.25 handling + our endpoint price), so we pay it with the disclosed test wallet.
 *   TEST_WALLET_PK=... npx tsx scripts/x402list-verify.ts
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const URL_ = "https://x402-list.com/api/v1/services/degenscan-intel/verify-live";
let pk = (process.env.TEST_WALLET_PK ?? "").trim(); if (pk && !pk.startsWith("0x")) pk = "0x" + pk;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { console.error("Set TEST_WALLET_PK."); process.exit(1); }
const account = privateKeyToAccount(pk as `0x${string}`);
console.log(`Payer: ${account.address}\nPOST ${URL_}\n`);
const probe = await fetch(URL_, { method: "POST" });
console.log(`Unpaid → HTTP ${probe.status}`);
const hdr = probe.headers.get("payment-required");
if (hdr) { const req: any = JSON.parse(Buffer.from(hdr, "base64").toString("utf8")); for (const a of req.accepts ?? []) console.log(`  accepts: ${a.network} ${Number(a.amount) / 1e6} USDC → ${a.payTo}`); }
else { console.log(await probe.text()); if (probe.status !== 402) process.exit(0); }
const f = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
const res = await f(URL_, { method: "POST" });
console.log(`Paid → HTTP ${res.status}`); console.log(await res.text());
const pr = res.headers.get("payment-response"); if (pr) { try { const r: any = decodePaymentResponseHeader(pr); console.log(`settlement tx=${r.transaction}`); } catch {} }
console.log("\nCheck: https://x402-list.com/services/degenscan-intel");
