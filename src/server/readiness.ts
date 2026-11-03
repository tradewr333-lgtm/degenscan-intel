/**
 * Agent readiness audit (Renato 03/11 — "não só crie, faça eles serem usados"): is a public API discoverable and
 * payable by AI agents? Checks the machine-readable surfaces agents and routers read — OpenAPI, llms.txt, x402
 * discovery, A2A agent card, MCP card, robots.txt, visible prices — and returns a 0–100 score with what to fix.
 * The same checklist that took intel.degenscan.io to the top of the Agent402 router.
 *
 * Fetching user-supplied URLs from our server is an SSRF risk, so: HTTPS only, port 443, the IP is checked at CONNECT
 * time (custom lookup → no DNS-rebinding window) and private, loopback, link-local, CGNAT and multicast ranges are
 * refused; GET only, no cookies or credentials, 6 s timeout, 512 KB cap, at most 2 redirects (each re-validated).
 */
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { UA } from "../ingest/http.js";

const BLOCK = new net.BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) BLOCK.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) BLOCK.addSubnet(a, p, "ipv6");
/** Pure: is this IP literal off-limits? Exported for tests. */
export function blockedIp(ip: string): boolean {
  const v = net.isIP(ip); if (!v) return true;
  if (v === 6) { const m = ip.toLowerCase().match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/); if (m) return blockedIp(m[1]); if (/^(::ffff:|64:ff9b::)/i.test(ip)) return true; }
  return BLOCK.check(ip, v === 4 ? "ipv4" : "ipv6");
}

const safeLookup: any = (host: string, opts: any, cb: any) => {
  dns.lookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    const ok = (addrs as dns.LookupAddress[]).filter(a => !blockedIp(a.address));
    if (!ok.length || ok.length !== (addrs as dns.LookupAddress[]).length) return cb(Object.assign(new Error("address not allowed"), { code: "EBLOCKED" }));
    return opts?.all ? cb(null, ok) : cb(null, ok[0].address, ok[0].family);
  });
};

/** Pure: normalise and validate the audited origin. Exported for tests. */
export function originOf(raw: string): string {
  let u: URL; try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw Object.assign(new Error("invalid url"), { status: 400 }); }
  if (u.protocol !== "https:") throw Object.assign(new Error("https only"), { status: 400 });
  if (u.port && u.port !== "443") throw Object.assign(new Error("port 443 only"), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("no credentials in the url"), { status: 400 });
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(h) ? blockedIp(h) : (!h.includes(".") || /\.(local|internal|localhost|lan|home|corp)$/i.test(h) || h === "localhost")) throw Object.assign(new Error("public hosts only"), { status: 400 });
  return `https://${u.hostname}`;
}

interface Got { status: number; type: string; body: string; url: string }
function getOnce(url: string): Promise<Got> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({ host: u.hostname, path: u.pathname + u.search, method: "GET", port: 443, lookup: safeLookup, timeout: 6000,
      headers: { "user-agent": UA, accept: "application/json, text/plain, text/markdown, */*;q=0.5" } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (c: Buffer) => { size += c.length; if (size > 512 * 1024) { req.destroy(); return; } chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8"), url: String(res.headers.location ?? "") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject); req.end();
  });
}
async function safeGet(url: string): Promise<Got | null> {
  let cur = url;
  for (let i = 0; i < 3; i++) {
    let g: Got; try { g = await getOnce(cur); } catch { return null; }
    if (g.status >= 300 && g.status < 400 && g.url) { try { const nx = new URL(g.url, cur); originOf(nx.origin); cur = nx.toString(); continue; } catch { return null; } }
    return g;
  }
  return null;
}
const json = (g: Got | null) => { if (!g || g.status !== 200) return null; try { return JSON.parse(g.body); } catch { return null; } };

export interface Check { id: string; ok: boolean; points: number; max: number; found?: string; fix?: string }

/** Pure: score the fetched surfaces. Exported for tests. */
export function scoreSurfaces(origin: string, s: { openapi: any; openapiAt?: string; llms: Got | null; x402: any; a2a: any; mcp: any; robots: Got | null }) {
  const checks: Check[] = [];
  const paths = s.openapi?.paths ? Object.keys(s.openapi.paths) : [];
  checks.push({ id: "openapi", max: 25, ok: paths.length > 0, points: paths.length > 0 ? 25 : 0, found: paths.length ? `${s.openapiAt} (${paths.length} paths)` : undefined,
    fix: paths.length ? undefined : "Publish an OpenAPI 3 document at /openapi.json with a summary and description per route — routers and agents read it to pick tools." });
  const descd = paths.length ? paths.filter(p => Object.values(s.openapi.paths[p] ?? {}).some((op: any) => op && (op.summary || op.description))).length / paths.length : 0;
  if (paths.length) checks.push({ id: "openapi_descriptions", max: 5, ok: descd >= 0.8, points: Math.round(descd * 5), found: `${Math.round(descd * 100)}% of paths described`, fix: descd >= 0.8 ? undefined : "Give every route a summary that says what question it answers, with the words an agent would search." });
  const llmsOk = !!s.llms && s.llms.status === 200 && s.llms.body.trim().length > 40 && !/<html/i.test(s.llms.body.slice(0, 200));
  checks.push({ id: "llms_txt", max: 15, ok: llmsOk, points: llmsOk ? 15 : 0, found: llmsOk ? `/llms.txt (${s.llms!.body.length} chars)` : undefined, fix: llmsOk ? undefined : "Add /llms.txt: a short markdown index of what the API does, routes, prices and how to pay." });
  const x402ok = !!s.x402 && typeof s.x402 === "object";
  checks.push({ id: "x402_discovery", max: 20, ok: x402ok, points: x402ok ? 20 : 0, found: x402ok ? "/.well-known/x402" : undefined, fix: x402ok ? undefined : "Publish /.well-known/x402 listing priced resources, networks and payTo, so agents with a wallet can pay without signing up." });
  const priced = paths.filter(p => Object.values(s.openapi.paths[p] ?? {}).some((op: any) => op && (op["x-price-usd"] != null || op.responses?.["402"]))).length;
  const pricesVisible = priced > 0 || (x402ok && JSON.stringify(s.x402).match(/price|amount/i) != null);
  checks.push({ id: "prices_visible", max: 15, ok: pricesVisible, points: pricesVisible ? 15 : 0, found: pricesVisible ? (priced ? `${priced} routes with a price or a 402 response` : "prices in /.well-known/x402") : undefined,
    fix: pricesVisible ? undefined : "Show the price per call in the OpenAPI (x-price-usd or a documented 402 response): agents and routers compare price before calling." });
  const a2aOk = !!s.a2a && typeof s.a2a === "object" && (s.a2a.name || s.a2a.skills);
  checks.push({ id: "a2a_agent_card", max: 10, ok: !!a2aOk, points: a2aOk ? 10 : 0, found: a2aOk ? "/.well-known/agent-card.json" : undefined, fix: a2aOk ? undefined : "Add an A2A agent card at /.well-known/agent-card.json (name, description, skills, url)." });
  const mcpOk = !!s.mcp && typeof s.mcp === "object";
  checks.push({ id: "mcp_card", max: 5, ok: mcpOk, points: mcpOk ? 5 : 0, found: mcpOk ? "/.well-known/mcp.json" : undefined, fix: mcpOk ? undefined : "If you run an MCP server, describe it at /.well-known/mcp.json and list it in the official MCP Registry." });
  const robotsBlocks = !!s.robots && s.robots.status === 200 && /user-agent:\s*\*[\s\S]*?disallow:\s*\/\s*$/im.test(s.robots.body);
  checks.push({ id: "robots_allows", max: 5, ok: !robotsBlocks, points: robotsBlocks ? 0 : 5, found: robotsBlocks ? "robots.txt disallows all" : "not blocking crawlers", fix: robotsBlocks ? "robots.txt blocks every crawler: allow at least /openapi.json, /llms.txt and /.well-known/." : undefined });
  const max = checks.reduce((a, c) => a + c.max, 0), got = checks.reduce((a, c) => a + c.points, 0);
  const score = Math.round(got / max * 100);
  return { origin, score, grade: score >= 85 ? "A" : score >= 70 ? "B" : score >= 50 ? "C" : score >= 30 ? "D" : "F", checks, fixes: checks.filter(c => c.fix).sort((a, b) => b.max - a.max).map(c => c.fix!) };
}

export async function agentReadiness(q: any = {}) {
  const origin = originOf(String(q.url ?? q.domain ?? "").trim() || "intel.degenscan.io");
  const [oa, ob, llms, x402, a2a, a2aOld, mcp, robots] = await Promise.all(["/openapi.json", "/swagger.json", "/llms.txt", "/.well-known/x402", "/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/mcp.json", "/robots.txt"].map(p => safeGet(origin + p)));
  const openapi = json(oa) ?? json(ob);
  return { ...scoreSurfaces(origin, { openapi, openapiAt: json(oa) ? "/openapi.json" : "/swagger.json", llms, x402: json(x402), a2a: json(a2a) ?? json(a2aOld), mcp: json(mcp), robots }),
    checked: ["/openapi.json", "/swagger.json", "/llms.txt", "/.well-known/x402", "/.well-known/agent-card.json", "/.well-known/agent.json", "/.well-known/mcp.json", "/robots.txt"],
    method: "Public GET requests to well-known paths of the origin (HTTPS only). Nothing is stored.", as_of: new Date().toISOString(),
    disclaimer: "Technical audit of public metadata only; not a security review." };
}
