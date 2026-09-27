/**
 * End-to-end x402 payment test against a live degenscan-intel server.
 *
 *   TEST_WALLET_PK=0x... npx tsx scripts/pay-test.ts [baseUrl]
 *
 * Uses a THROWAWAY wallet holding a few cents of USDC on Base. Never use a main wallet.
 * 1. Burns the free daily quota with plain requests until the server answers 402.
 * 2. Prints the payment requirements the server advertises.
 * 3. Pays ONE call ($0.01) with x402-fetch (EIP-3009 signature; facilitator pays gas) and prints the settlement.
 */
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { wrapFetchWithPayment, decodeXPaymentResponse } from "x402-fetch";

const BASE_URL = process.argv[2] ?? "https://degenscan-intel.onrender.com";
const PK = process.env.TEST_WALLET_PK as `0x${string}` | undefined;
if (!PK || !/^0x[0-9a-fA-F]{64}$/.test(PK)) { console.error("Set TEST_WALLET_PK to a throwaway wallet private key (0x + 64 hex)."); process.exit(1); }

const account = privateKeyToAccount(PK);
console.log(`Payer (throwaway): ${account.address}`);
console.log(`Server: ${BASE_URL}\n`);

// 1. exhaust free quota
let status = 0, tries = 0, body: any = null;
while (status !== 402 && tries < 120) {
  const r = await fetch(`${BASE_URL}/v1/regime?n=${tries}`);
  status = r.status; body = await r.json().catch(() => null);
  if (status === 200) process.stdout.write(`\rfree call ${++tries} (${body?._billing?.method})   `);
  else break;
}
console.log();
if (status !== 402) { console.error(`Expected 402 after quota, got ${status}. Is INTEL_FREE=0 and X402_PAY_TO set?`); process.exit(1); }

// 2. requirements
const req = body.accepts?.[0];
console.log("402 received. Payment requirements:");
console.log(`  network   ${req.network}\n  asset     ${req.asset}\n  amount    ${Number(req.maxAmountRequired) / 1e6} USDC\n  payTo     ${req.payTo}\n  resource  ${req.resource}\n`);

// 3. pay one call
const client = createWalletClient({ account, chain: base, transport: http() });
const fetchWithPay = wrapFetchWithPayment(fetch, client as any, BigInt(50_000)); // cap: 0.05 USDC
const t0 = Date.now();
const paid = await fetchWithPay(`${BASE_URL}/v1/regime?paid=1`, { method: "GET" });
const ms = Date.now() - t0;
const data: any = await paid.json();
console.log(`Paid call → HTTP ${paid.status} in ${ms} ms`);
console.log(`  _billing: ${JSON.stringify(data._billing)}`);
console.log(`  events_24h: ${data.events_24h}, venues_open: ${JSON.stringify(data.venues_open)}`);
const xpr = paid.headers.get("x-payment-response");
if (xpr) { try { console.log("  settlement:", JSON.stringify(decodeXPaymentResponse(xpr))); } catch { console.log("  x-payment-response:", xpr); } }
else console.log("  (settlement runs right after the response; check the payTo wallet on basescan in ~10 s)");
console.log(`\nCheck: https://basescan.org/address/${req.payTo}#tokentxns`);
