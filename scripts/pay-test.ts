/**
 * End-to-end x402 v2 payment test against a live degenscan-intel server.
 *
 *   TEST_WALLET_PK=... npx tsx scripts/pay-test.ts [baseUrl]
 *
 * Uses a THROWAWAY wallet holding a few cents of USDC on Base. Never use a main wallet.
 * 1. Burns the free daily quota with plain requests until the server answers 402.
 * 2. Decodes the v2 PAYMENT-REQUIRED header the server advertises.
 * 3. Pays ONE call ($0.01) with @x402/fetch (EIP-3009 signature; facilitator pays gas) and prints the settlement receipt.
 * 4. Does the same through MCP (tools/call regime_snapshot) to prove agents can pay per tool.
 */
import { privateKeyToAccount } from "viem/accounts";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";

const BASE_URL = process.argv[2] ?? "https://degenscan-intel.onrender.com";
let pkRaw = (process.env.TEST_WALLET_PK ?? "").trim();
if (pkRaw && !pkRaw.startsWith("0x")) pkRaw = "0x" + pkRaw;   // MetaMask exports without the 0x prefix
if (!/^0x[0-9a-fA-F]{64}$/.test(pkRaw)) { console.error("Set TEST_WALLET_PK to a throwaway wallet private key (64 hex chars)."); process.exit(1); }

const account = privateKeyToAccount(pkRaw as `0x${string}`);
console.log(`Payer (throwaway): ${account.address}\nServer: ${BASE_URL}\n`);

// 1. exhaust free quota
let status = 0, tries = 0, last: Response | null = null;
while (status !== 402 && tries < 120) {
  last = await fetch(`${BASE_URL}/v1/regime?n=${tries}`);
  status = last.status;
  if (status === 200) { const b: any = await last.json().catch(() => null); process.stdout.write(`\rfree call ${++tries} (${b?._billing?.method})   `); } else break;
}
console.log();
if (status !== 402 || !last) { console.error(`Expected 402 after quota, got ${status}. Is INTEL_FREE=0 and X402_PAY_TO set?`); process.exit(1); }

// 2. requirements (v2 header)
const hdr = last.headers.get("payment-required");
if (!hdr) { console.error("402 without PAYMENT-REQUIRED header — server not on x402 v2?"); process.exit(1); }
const req: any = JSON.parse(Buffer.from(hdr, "base64").toString("utf8"));
const a = req.accepts[0];
console.log("402 received (x402 v" + req.x402Version + "). Payment requirements:");
console.log(`  network   ${a.network}\n  asset     ${a.asset}\n  amount    ${Number(a.amount) / 1e6} USDC\n  payTo     ${a.payTo}\n  resource  ${req.resource?.url ?? req.resource}\n`);

// 3. pay one REST call
const fetchWithPay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(account) }] });
let t0 = Date.now();
const paid = await fetchWithPay(`${BASE_URL}/v1/regime?paid=1`);
const data: any = await paid.json();
console.log(`REST paid call → HTTP ${paid.status} in ${Date.now() - t0} ms`);
console.log(`  _billing: ${JSON.stringify(data._billing)}`);
console.log(`  events_24h: ${data.events_24h}, venues_open: ${JSON.stringify(data.venues_open)}`);
const pr = paid.headers.get("payment-response");
if (pr) { try { const r: any = decodePaymentResponseHeader(pr); console.log(`  settlement: success=${r.success} tx=${r.transaction} network=${r.network}`); } catch { console.log("  payment-response:", pr); } }

// 4. pay one MCP tool call
t0 = Date.now();
const mcp = await fetchWithPay(`${BASE_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "regime_snapshot", arguments: {} } }) });
const txt = await mcp.text();
console.log(`MCP paid tool call → HTTP ${mcp.status} in ${Date.now() - t0} ms, ${txt.length} bytes${txt.includes("venues_open") ? " (regime_snapshot payload ok)" : ""}`);
console.log(`\nCheck: https://basescan.org/address/${a.payTo}#tokentxns`);
