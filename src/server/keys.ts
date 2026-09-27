import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../store/db.js";

/** Subscription plans for agents that pay in fiat (Stripe) instead of USDC. */
export const PLANS = {
  starter: { name: "Starter", usd_month: 29, monthly_calls: 10_000 },
  pro: { name: "Pro", usd_month: 199, monthly_calls: 200_000 },
  enterprise: { name: "Enterprise", usd_month: 0, monthly_calls: 10_000_000 },
} as const;
export type Plan = keyof typeof PLANS;

export interface ApiKeyRow {
  id: string; key_hash: string; plan: Plan; monthly_calls: number; status: "active" | "revoked";
  stripe_customer: string | null; stripe_subscription: string | null; stripe_session: string | null; email: string | null; created_at: string; label: string | null;
}

function ensure() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY, key_hash TEXT UNIQUE NOT NULL, plan TEXT NOT NULL, monthly_calls INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', stripe_customer TEXT, stripe_subscription TEXT, stripe_session TEXT UNIQUE,
      email TEXT, label TEXT, created_at TEXT NOT NULL
    );`);
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
  const r = getDb().prepare("SELECT COUNT(*) AS n FROM calls WHERE payer = ? AND ts >= ?").get(`key:${id}`, from.toISOString()) as unknown as { n: number };
  return r.n;
}

/** Validate a raw key: active and under monthly quota. Legacy env API_KEYS (comma-separated) still accepted as unlimited "legacy" keys. */
export function validateKey(raw: string): { id: string; plan: Plan | "legacy"; remaining: number } | null {
  ensure();
  const legacy = new Set((process.env.API_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean));
  if (legacy.has(raw)) return { id: `legacy:${raw.slice(0, 6)}`, plan: "legacy", remaining: Number.MAX_SAFE_INTEGER };
  const row = getDb().prepare("SELECT * FROM api_keys WHERE key_hash = ? AND status = 'active'").get(hash(raw)) as unknown as ApiKeyRow | undefined;
  if (!row) return null;
  const used = monthlyUsage(row.id);
  if (used >= row.monthly_calls) return { id: row.id, plan: row.plan, remaining: 0 };
  return { id: row.id, plan: row.plan, remaining: row.monthly_calls - used };
}
