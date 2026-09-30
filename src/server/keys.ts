import { CREDITS_SQL } from "./pricing.js";
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../store/db.js";

/** Subscription plans for operators that pay in fiat (Stripe) instead of USDC. */
export const PLANS = {
  hobby: { name: "Hobby", usd_month: 9, monthly_calls: 2_000 },
  starter: { name: "Starter", usd_month: 29, monthly_calls: 10_000 },
  pro: { name: "Pro", usd_month: 199, monthly_calls: 200_000 },
  enterprise: { name: "Enterprise", usd_month: 0, monthly_calls: 10_000_000 },
} as const;
export type Plan = keyof typeof PLANS;

/** Prepaid call packs for autonomous agents: one x402 payment in USDC → API key with a lifetime call budget (no expiry, no human). */
export const PACKS = {
  pack_1k: { name: "1,000 calls", usd: 5, calls: 1_000 },
  pack_10k: { name: "10,000 calls", usd: 40, calls: 10_000 },
  pack_100k: { name: "100,000 calls", usd: 300, calls: 100_000 },
} as const;
export type Pack = keyof typeof PACKS;

export interface ApiKeyRow {
  id: string; key_hash: string; plan: Plan | Pack; monthly_calls: number; status: "active" | "revoked" | "pending";
  stripe_customer: string | null; stripe_subscription: string | null; stripe_session: string | null; email: string | null; created_at: string; label: string | null;
  total_calls: number | null; wallet: string | null; tx: string | null;
}

function ensure() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, plan TEXT NOT NULL, monthly_calls INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', stripe_customer TEXT, stripe_subscription TEXT, stripe_session TEXT UNIQUE,
      email TEXT, label TEXT, created_at TEXT NOT NULL
    );`);
  for (const col of ["total_calls INTEGER", "wallet TEXT", "tx TEXT"]) { try { getDb().exec(`ALTER TABLE api_keys ADD COLUMN ${col}`); } catch { /* exists */ } }
}
const hash = (raw: string) => createHash("sha256").update(raw).digest("hex");

/** Create a key. Returns the raw key exactly once — only the hash is stored. */
export function createKey(opts: { plan: Plan; stripe_customer?: string; stripe_subscription?: string; stripe_session?: string; email?: string; label?: string }): { id: string; key: string } {
  ensure();
  const id = "k_" + randomBytes(6).toString("hex");
  const key = `dsi_${opts.plan}_${randomBytes(24).toString("base64url")}`;
  getDb().prepare(`INSERT INTO api_keys (id, key_hash, plan, monthly_calls, status, stripe_customer, stripe_subscription, stripe_session, email, label, created_at) VALUES (?,?,?,?,'active',?,?,?,?,?,?)`)
    .run(id, hash(key), opts.plan, PLANS[opts.plan].monthly_calls, opts.stripe_customer ?? null, opts.stripe_subscription ?? null, opts.stripe_session ?? null, opts.email ?? null, opts.label ?? null, new Date().toISOString());
  return { id, key };
}

/** Prepaid pack key paid in USDC (x402). Created as `pending`; activated by activatePackKey() once the facilitator settles. */
export function createPackKey(pack: Pack, wallet: string | null): { id: string; key: string } {
  ensure();
  const id = "k_" + randomBytes(6).toString("hex");
  const key = `dsi_${pack}_${randomBytes(24).toString("base64url")}`;
  getDb().prepare(`INSERT INTO api_keys (id, key_hash, plan, monthly_calls, status, total_calls, wallet, label, created_at) VALUES (?,?,?,?,'pending',?,?,?,?)`)
    .run(id, hash(key), pack, PACKS[pack].calls, PACKS[pack].calls, wallet, `x402 ${PACKS[pack].name}`, new Date().toISOString());
  return { id, key };
}
export function activatePackKey(id: string, tx: string | null) { ensure(); return getDb().prepare("UPDATE api_keys SET status = 'active', tx = ? WHERE id = ? AND status = 'pending'").run(tx, id).changes; }
export function dropPendingKey(id: string) { ensure(); return getDb().prepare("DELETE FROM api_keys WHERE id = ? AND status = 'pending'").run(id).changes; }
/** Budget left on a key (for /v1/keys/me). */
export function keyStatus(raw: string) {
  ensure();
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hash(raw)) as unknown as ApiKeyRow | undefined;
  if (!row) return null;
  const used = row.total_calls != null ? lifetimeUsage(row.id) : monthlyUsage(row.id);
  const budget = row.total_calls ?? row.monthly_calls;
  return { id: row.id, plan: row.plan, status: row.status, budget, used, remaining: Math.max(0, budget - used), period: row.total_calls != null ? "lifetime" : "calendar_month", created_at: row.created_at };
}

export function findBySession(session: string): ApiKeyRow | undefined {
  ensure();
  return getDb().prepare("SELECT * FROM api_keys WHERE stripe_session = ?").get(session) as unknown as ApiKeyRow | undefined;
}

export function revokeBySubscription(sub: string) {
  ensure();
  return getDb().prepare("UPDATE api_keys SET status = 'revoked' WHERE stripe_subscription = ?").run(sub).changes;
}

/** Calls this calendar month for a key id (from the billing log). */
export function monthlyUsage(id: string): number {
  const from = new Date(); from.setUTCDate(1); from.setUTCHours(0, 0, 0, 0);
  const r = getDb().prepare(`SELECT COALESCE(${CREDITS_SQL},0) AS n FROM calls WHERE payer = ? AND ts >= ?`).get(`key:${id}`, from.toISOString()) as unknown as { n: number };
  return r.n;
}

export function lifetimeUsage(id: string): number {
  return (getDb().prepare(`SELECT COALESCE(${CREDITS_SQL},0) AS n FROM calls WHERE payer = ?`).get(`key:${id}`) as unknown as { n: number }).n;
}

/** Validate a raw key: active and under quota (monthly for subscriptions, lifetime for prepaid packs). Legacy env API_KEYS (comma-separated) still accepted as unlimited "legacy" keys. */
export function validateKey(raw: string): { id: string; plan: Plan | Pack | "legacy"; remaining: number } | null {
  ensure();
  const legacy = new Set((process.env.API_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (legacy.has(raw)) return { id: `legacy:${raw.slice(0, 6)}`, plan: "legacy", remaining: Number.MAX_SAFE_INTEGER };
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'").get(hash(raw)) as unknown as ApiKeyRow | undefined;
  if (!row) return null;
  const budget = row.total_calls ?? row.monthly_calls;
  const used = row.total_calls != null ? lifetimeUsage(row.id) : monthlyUsage(row.id);
  return { id: row.id, plan: row.plan, remaining: Math.max(0, budget - used) };
}
