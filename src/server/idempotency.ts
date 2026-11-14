/**
 * Idempotent retries for paid REST calls (13/11, Renato — seen in a competitor's x402 docs).
 * An agent that loses the response (timeout, dropped connection) and retries with a NEW payment would pay twice.
 * If it sends `Idempotency-Key: <8–128 chars>` with its payment, a successful paid response is kept for 10 minutes;
 * a retry from the same payer, with the same key, on the same method + URL, gets that response back (header
 * `Idempotent-Replayed: true`) BEFORE any payment is verified or settled — so the retry costs nothing.
 * Only settled 2xx responses are stored. Nothing is stored for free, key or quota calls.
 */
const TTL = 10 * 60_000, MAX = 2000;
type Entry = { at: number; status: number; body: string; contentType: string; paymentResponse: string | null };
const store = new Map<string, Entry>();
export const _idem = { reset() { store.clear(); }, size: () => store.size };

export function idemKeyOf(headers: Record<string, unknown>) {
  const k = String(headers["idempotency-key"] ?? "").trim();
  return /^[A-Za-z0-9_.:-]{8,128}$/.test(k) ? k : null;
}
/** Payer address from an x402 payment header (v2 PAYMENT-SIGNATURE or v1 X-PAYMENT, base64 JSON). Not a verification. */
export function payerOf(headers: Record<string, unknown>) {
  const h = headers["payment-signature"] ?? headers["x-payment"]; if (!h) return null;
  try {
    const j = JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));
    const from = j?.payload?.authorization?.from ?? j?.payload?.from ?? null;
    return typeof from === "string" && from.length >= 20 ? from.toLowerCase() : null;
  } catch { return null; }
}
const keyOf = (payer: string, k: string, method: string, url: string) => `${payer}|${k}|${method}|${url}`;
export function idemGet(payer: string, k: string, method: string, url: string) {
  const e = store.get(keyOf(payer, k, method, url));
  if (!e) return null; if (Date.now() - e.at > TTL) { store.delete(keyOf(payer, k, method, url)); return null; }
  return e;
}
export function idemPut(payer: string, k: string, method: string, url: string, e: Omit<Entry, "at">) {
  if (store.size >= MAX) { const first = store.keys().next().value; if (first) store.delete(first); }
  store.set(keyOf(payer, k, method, url), { ...e, at: Date.now() });
}
