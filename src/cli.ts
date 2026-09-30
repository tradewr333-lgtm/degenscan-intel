#!/usr/bin/env tsx
import { CONNECTORS, connectorById } from "./ingest/registry.js";
import { runAllOnce, runConnector, startScheduler } from "./ingest/run.js";
import { buildHttp } from "./server/http.js";
import { refreshUniverse, loadUniverse } from "./universe/index.js";
import { invalidateGraph } from "./graph/graph.js";
import { invalidateDict } from "./engine/entities.js";
import { getDb } from "./store/db.js";
import { startBoardScheduler } from "./oracle/board.js";

const [cmd = "serve", ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);
const opt = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };

async function main() {
  getDb();
  switch (cmd) {
    case "serve": {
      const port = Number(process.env.PORT ?? 8787);
      if (!flag("--no-ingest")) startScheduler(ev => { if (ev.severity >= 0.7) console.log(`  !! ${ev.kind} ${ev.title} → ${ev.impacts.slice(0, 3).map(i => `${i.asset_id}${i.direction > 0 ? "▲" : i.direction < 0 ? "▼" : "◆"}${i.confidence}`).join(" ")}`); });
      // nightly universe refresh at ~21:35 ET
      setInterval(async () => { const et = new Date().toLocaleTimeString("en-US", { timeZone: "America/New_York", hour12: false }); if (et.startsWith("21:35")) { await refreshUniverse(); invalidateGraph(); invalidateDict(); } }, 60_000);
      const app = await buildHttp();
      await app.listen({ port, host: "0.0.0.0" });
      if (!flag("--no-ingest")) { startBoardScheduler(); const { startPaperBot } = await import("./bot/paper.js"); const { polymarketEdge } = await import("./server/oracle-routes.js"); startPaperBot(() => polymarketEdge(0, 50).items); }
      console.log(`degenscan-intel listening on :${port}  (MCP: POST /mcp, REST: /v1, universe ${loadUniverse().version}, ${CONNECTORS.length} connectors)`);
      break;
    }
    case "ingest": {
      const only = opt("--only");
      if (only) { const c = connectorById(only); if (!c) throw new Error(`unknown connector ${only}`); const r = await runConnector(c, { dryRun: flag("--dry") }); print([r], flag("--dry")); break; }
      if (flag("--once")) { const rs = await runAllOnce(undefined, { dryRun: flag("--dry") }); print(rs, flag("--dry")); break; }
      startScheduler(); await new Promise(() => {});
      break;
    }
    case "probe": {
      // Hit every connector once (dry run) and report reachability + item counts. Run this on the deploy box.
      const rs = await runAllOnce(undefined, { dryRun: true, concurrency: 4 });
      print(rs, true);
      const ok = rs.filter(r => r.ok).length;
      console.log(`\n${ok}/${rs.length} connectors reachable`);
      break;
    }
    case "universe": { const u = await refreshUniverse(); console.log(`universe ${u.version}: ${u.assets.length} assets (${u.assets.filter(a => a.class === "equity").length} equities)`); break; }
    case "mcp": { // stdio transport for local agents (Claude Desktop, Cursor…)
      const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
      const { buildMcpServer } = await import("./server/mcp.js");
      const s = buildMcpServer(); await s.connect(new StdioServerTransport()); break;
    }
    default: console.log("usage: cli <serve|ingest [--once] [--only id] [--dry]|probe|universe|mcp>");
  }
}

function print(rs: Awaited<ReturnType<typeof runAllOnce>>, dry: boolean) {
  for (const r of rs.sort((a, b) => a.source_id.localeCompare(b.source_id))) {
    console.log(`${r.ok ? "✅" : "❌"} ${r.source_id.padEnd(22)} ${String(r.items).padStart(4)} items ${String(r.new_items).padStart(4)} ${dry ? "scored" : "new"} ${String(r.ms).padStart(6)}ms ${r.error ?? ""}`);
    if (dry) for (const ev of r.new_events.slice(0, 2)) console.log(`     · ${ev.kind} | ${ev.title.slice(0, 90)} → ${ev.impacts.slice(0, 4).map(i => `${i.asset_id}${i.direction > 0 ? "▲" : i.direction < 0 ? "▼" : "◆"}${i.confidence}`).join(" ") || "no impacts"}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
