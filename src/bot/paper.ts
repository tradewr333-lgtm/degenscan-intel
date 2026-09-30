/**
 * Oracle Edge — a PAPER-trading bot that consumes our own API product (polymarket_edge) and keeps a public, append-only ledger.
 * No real money. Rule set is fixed in code and published at /bot, so the track record cannot be cherry-picked:
 *   - daily at BOT_OPEN_AT (default 08:00 UTC, after the 06:00 board refresh has finished), for every open board question matched to a
 *     Polymarket market with |p − odds| ≥ BOT_MIN_EDGE (default 0.03) and market price in [0.03, 0.97]: open ONE paper position per market
 *     (never re-entered, never averaged), buying the side the oracle says is cheap, fixed stake BOT_STAKE (default $10), 1 % cost haircut;
 *   - hourly: mark every open position to the live Polymarket price (Gamma); settle at the market's own resolution;
 *   - every position stores the forecast_id and commitment_hash it was opened on.
 * Information and analytics only — not investment advice. Paper results are not real returns.
 */
import { createHash, randomBytes } from "node:crypto";
import { getDb } from "../store/db.js";
import { _ext } from "../server/tools.js";

const STAKE = Number(process.env.BOT_STAKE ?? 10);
const MIN_EDGE = Number(process.env.BOT_MIN_EDGE ?? 0.03);
const COST = 0.01;

export function ensureBotTables() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS bot_positions (
    id TEXT PRIMARY KEY, opened_at TEXT NOT NULL, slug TEXT NOT NULL, market_slug TEXT NOT NULL, question TEXT NOT NULL,
    side TEXT NOT NULL, entry_price REAL NOT NULL, stake REAL NOT NULL, shares REAL NOT NULL,
    oracle_p REAL NOT NULL, market_odds REAL NOT NULL, edge REAL NOT NULL, forecast_id TEXT NOT NULL, commitment_hash TEXT NOT NULL,
    mark_price REAL, marked_at TEXT, status TEXT NOT NULL DEFAULT 'open', settled_at TEXT, payout REAL, entry_hash TEXT NOT NULL
  )`);
  getDb().exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_bot_market ON bot_positions(market_slug)");
  getDb().exec("CREATE TABLE IF NOT EXISTS bot_equity (at TEXT PRIMARY KEY, staked REAL NOT NULL, value REAL NOT NULL, open INTEGER NOT NULL, settled INTEGER NOT NULL)");
}

const marketSlugOf = (ref: string | null | undefined) => { const m = String(ref ?? "").match(/polymarket\.com\/(?:market|event)\/([^/?#]+)/); return m ? m[1] : null; };

async function gamma(slug: string): Promise<{ yes: number | null; closed: boolean } | null> {
  const ms = await _ext.get<any[]>(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(slug)}`, { timeoutMs: 8000 }).catch(() => null);
  const m = Array.isArray(ms) ? ms[0] : null; if (!m) return null;
  let yes: number | null = null;
  try { const p = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; yes = Number(p?.[0]); if (!Number.isFinite(yes)) yes = null; } catch { yes = null; }
  return { yes, closed: m.closed === true || m.umaResolutionStatus === "resolved" };
}

/** Open new paper positions from the current edge list (our own product, called in-process). */
export async function openPositions(edgeItems: any[]) {
  ensureBotTables(); const d = getDb(); const opened: any[] = [];
  for (const it of edgeItems) {
    if (Math.abs(it.edge) < MIN_EDGE) continue;
    const mslug = marketSlugOf(it.market_ref); if (!mslug) continue;
    if (it.market_odds < 0.03 || it.market_odds > 0.97) continue;
    if (d.prepare("SELECT 1 FROM bot_positions WHERE market_slug = ?").get(mslug)) continue;
    const side = it.edge > 0 ? "YES" : "NO";
    const entry = side === "YES" ? it.market_odds : 1 - it.market_odds;
    const shares = (STAKE * (1 - COST)) / entry;
    const id = "bp_" + randomBytes(5).toString("hex"); const at = new Date().toISOString();
    const entryHash = createHash("sha256").update(`${id}|${mslug}|${side}|${entry.toFixed(4)}|${it.commitment_hash}|${at}`).digest("hex");
    d.prepare(`INSERT INTO bot_positions (id, opened_at, slug, market_slug, question, side, entry_price, stake, shares, oracle_p, market_odds, edge, forecast_id, commitment_hash, entry_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, at, it.slug, mslug, it.question, side, entry, STAKE, shares, it.probability, it.market_odds, it.edge, it.forecast_id, it.commitment_hash, entryHash);
    opened.push({ id, slug: it.slug, side, entry });
  }
  if (opened.length) console.log(`[bot] opened ${opened.length} paper positions: ${opened.map(o => `${o.slug} ${o.side}@${o.entry.toFixed(3)}`).join(", ")}`);
  return opened;
}

/** Mark open positions to the live Polymarket price; settle closed markets at 0/1. */
export async function markAndSettle() {
  ensureBotTables(); const d = getDb();
  const open = d.prepare("SELECT * FROM bot_positions WHERE status = 'open'").all() as any[];
  for (const p of open) {
    const g = await gamma(p.market_slug); if (!g || g.yes == null) continue;
    const px = p.side === "YES" ? g.yes : 1 - g.yes; const now = new Date().toISOString();
    if (g.closed && (g.yes >= 0.99 || g.yes <= 0.01)) {
      const payout = Math.round(p.shares * (px >= 0.5 ? 1 : 0) * 100) / 100;
      d.prepare("UPDATE bot_positions SET status = 'settled', settled_at = ?, payout = ?, mark_price = ?, marked_at = ? WHERE id = ?").run(now, payout, px >= 0.5 ? 1 : 0, now, p.id);
    } else d.prepare("UPDATE bot_positions SET mark_price = ?, marked_at = ? WHERE id = ?").run(px, now, p.id);
  }
  // hourly equity snapshot for the public curve
  const all = d.prepare("SELECT * FROM bot_positions").all() as any[];
  if (all.length) {
    const staked = all.reduce((s, p) => s + p.stake, 0), value = all.reduce((s, p) => s + (p.status === "settled" ? p.payout : p.shares * (p.mark_price ?? p.entry_price)), 0);
    d.prepare("INSERT OR REPLACE INTO bot_equity (at, staked, value, open, settled) VALUES (?,?,?,?,?)").run(new Date().toISOString().slice(0, 13) + ":00Z", staked, value, all.filter(p => p.status === "open").length, all.filter(p => p.status === "settled").length);
  }
}

export function botReport() {
  ensureBotTables();
  const rows = getDb().prepare("SELECT * FROM bot_positions ORDER BY opened_at DESC").all() as any[];
  const r2 = (x: number) => Math.round(x * 100) / 100;
  let staked = 0, value = 0, realized = 0, wins = 0, settled = 0;
  const positions = rows.map(p => {
    const mark = p.status === "settled" ? p.payout : p.shares * (p.mark_price ?? p.entry_price);
    staked += p.stake; value += mark;
    if (p.status === "settled") { settled++; realized += p.payout - p.stake; if (p.payout > p.stake) wins++; }
    return { id: p.id, opened_at: p.opened_at, question: p.question, board_slug: p.slug, polymarket: `https://polymarket.com/market/${p.market_slug}`, side: p.side,
      entry_price: r2(p.entry_price * 100) / 100, oracle_p: p.oracle_p, market_odds_at_entry: p.market_odds, edge_at_entry: p.edge, stake: p.stake,
      mark_price: p.mark_price, marked_at: p.marked_at, value_now: r2(mark), pnl: r2(mark - p.stake), status: p.status, settled_at: p.settled_at,
      forecast: `/v1/oracle/forecast/${p.forecast_id}`, forecast_commitment_hash: p.commitment_hash, entry_hash: p.entry_hash };
  });
  return {
    name: "Oracle Edge (paper)", as_of: new Date().toISOString(), paper: true,
    rules: { source: "/v1/oracle/edge (our own API)", min_abs_edge: MIN_EDGE, price_band: [0.03, 0.97], stake_usd: STAKE, cost_haircut: COST, entries: "one per market, never re-entered or averaged, held to resolution", marks: "hourly, live Polymarket price", opens: "daily after the 06:00 UTC board" },
    summary: { positions: rows.length, open: rows.length - settled, settled, wins, staked_usd: r2(staked), value_usd: r2(value), pnl_usd: r2(value - staked), pnl_pct: staked ? r2(((value - staked) / staked) * 100) : 0, realized_pnl_usd: r2(realized) },
    positions,
    equity_curve: (getDb().prepare("SELECT at, staked, value FROM bot_equity ORDER BY at").all() as any[]).map(e => ({ at: e.at, pnl_usd: r2(e.value - e.staked), pnl_pct: e.staked ? r2(((e.value - e.staked) / e.staked) * 100) : 0 })),
    disclaimer: "Paper trading with fixed published rules — no real money, not real returns. Information and analytics only — not investment advice.",
  };
}

export function startPaperBot(edge: () => any[]) {
  const [h, m] = (process.env.BOT_OPEN_AT ?? "08:00").split(":").map(Number);
  let last = "";
  const t1 = setInterval(() => {
    const d = new Date(); const key = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === h && d.getUTCMinutes() === m && last !== key) { last = key; openPositions(edge()).catch(e => console.warn("[bot]", (e as Error).message)); }
  }, 60_000);
  const t2 = setInterval(() => markAndSettle().catch(() => {}), 3_600_000);
  setTimeout(() => markAndSettle().catch(() => {}), 120_000);
  console.log(`[bot] Oracle Edge paper bot: opens daily ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC, marks hourly`);
  return () => { clearInterval(t1); clearInterval(t2); };
}
