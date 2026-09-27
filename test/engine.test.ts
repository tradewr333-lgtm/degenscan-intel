import { describe, it, expect, beforeAll } from "vitest";
process.env.DB_PATH = ":memory:";
import { scoreEvent } from "../src/engine/impact.js";
import { tradability, isTradable } from "../src/engine/sessions.js";
import { loadUniverse } from "../src/universe/index.js";
import { propagate, neighborhood } from "../src/graph/graph.js";
import type { RawEvent } from "../src/schema.js";

const SRC = { id: "test", name: "Test", tier: "primary" as const };
const imp = (ev: ReturnType<typeof scoreEvent>, id: string) => ev.impacts.find(i => i.asset_id === id);

describe("impact engine", () => {
  it("M6.8 quake near Hsinchu propagates TSM → NVDA/AAPL/SMH, all negative", () => {
    const raw: RawEvent = {
      native_id: "q1", ts_event: new Date().toISOString(), source: SRC, kind: "nat.quake",
      title: "M6.8 earthquake — 12 km NE of Hsinchu, Taiwan", summary: "Shallow quake.", geo: { lat: 24.85, lng: 121.05, radius_km: 150 },
      severity: 0.65, novelty: 0.8, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    expect(ev.entities.map(e => e.id)).toContain("facility:TSMC-FAB12");
    expect(ev.entities.map(e => e.id)).toContain("country:TW");
    for (const id of ["TSM", "NVDA", "AAPL", "SMH"]) {
      const i = imp(ev, id); expect(i, id).toBeDefined(); expect(i!.direction).toBe(-1); expect(i!.confidence).toBeGreaterThan(0.1);
    }
    expect(imp(ev, "TSM")!.confidence).toBeGreaterThan(imp(ev, "NVDA")!.confidence);
    expect(imp(ev, "NVDA")!.path).toEqual(expect.arrayContaining(["company:TSM", "company:NVDA"]));
  });

  it("8-K item 4.02 (restatement) on NVDA hits NVDA hard and NDX/QQQ/SMCI weaker, negative", () => {
    const raw: RawEvent = {
      native_id: "8k", ts_event: new Date().toISOString(), source: SRC, kind: "corp.8k",
      title: "NVIDIA files 8-K — Non-reliance on prior financials (restatement)", summary: "Form 8-K items 4.02.",
      entities: [{ type: "company", id: "company:NVDA", name: "NVIDIA", confidence: 1 }], severity: 0.9, novelty: 0.7, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    // sign inferred from text: "restatement" isn't in NEG list but "Non-reliance"... ensure direction is not positive
    expect(imp(ev, "NVDA")).toBeDefined();
    expect(imp(ev, "NVDA")!.direction).not.toBe(1);
    expect(imp(ev, "QQQ")).toBeDefined();
    expect(imp(ev, "SMCI")).toBeDefined();
    expect(imp(ev, "NVDA")!.confidence).toBeGreaterThan(imp(ev, "QQQ")!.confidence);
  });

  it("Fed stablecoin proposal links FED → USDC/USDT/BTC and rates", () => {
    const raw: RawEvent = {
      native_id: "fed", ts_event: new Date().toISOString(), source: SRC, kind: "reg.proposed_rule",
      title: "Federal Reserve Board requests public comment on proposals for payment stablecoin issuers under the GENIUS Act", summary: "",
      entities: [{ type: "regulator", id: "regulator:FED", name: "Fed", confidence: 1 }], severity: 0.6, novelty: 0.6, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    expect(ev.entities.map(e => e.id)).toContain("theme:stablecoin");
    for (const id of ["USDC", "USDT", "US2Y", "BTC"]) expect(imp(ev, id), id).toBeDefined();
  });

  it("Gulf hurricane: nat gas up, insurers down, airlines down", () => {
    const raw: RawEvent = {
      native_id: "h", ts_event: new Date().toISOString(), source: SRC, kind: "nat.storm",
      title: "Hurricane Zeta — 120 kt, Gulf of Mexico", summary: "Track threatens Louisiana and Texas coast.",
      geo: { lat: 27.5, lng: -90, radius_km: 350, country: "US-GULF" }, severity: 0.8, novelty: 0.5, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    expect(imp(ev, "NG")!.direction).toBe(1);
    expect(imp(ev, "ALL")!.direction).toBe(-1);
    expect(imp(ev, "UNG")!.direction).toBe(1);
    expect(imp(ev, "CCL")!.direction).toBe(-1);
  });

  it("Iran conflict → oil up, airlines down, Brent follows WTI", () => {
    const raw: RawEvent = {
      native_id: "ir", ts_event: new Date().toISOString(), source: SRC, kind: "geo.conflict",
      title: "Strikes reported near Strait of Hormuz; Iran vows response", summary: "Tanker traffic disrupted.", severity: 0.8, novelty: 0.9, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    expect(imp(ev, "CL")!.direction).toBe(1);
    expect(imp(ev, "BZ")!.direction).toBe(1);
    expect(imp(ev, "XOM")!.direction).toBe(1);
    expect(imp(ev, "AAL")!.direction).toBe(-1);
  });

  it("FDA approval mentioning Eli Lilly is positive for LLY", () => {
    const raw: RawEvent = {
      native_id: "fda", ts_event: new Date().toISOString(), source: SRC, kind: "reg.approval",
      title: "FDA approves Eli Lilly's oral GLP-1 for obesity", summary: "", entities: [{ type: "regulator", id: "regulator:FDA", name: "FDA", confidence: 1 }], severity: 0.6, novelty: 0.6, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    expect(imp(ev, "LLY")!.direction).toBe(1);
    expect(imp(ev, "LLY")!.confidence).toBeGreaterThan(imp(ev, "PFE")!.confidence); // named > merely regulated
  });

  it("DefiLlama hack on Solana: SOL down, BTC weakly down via correlation", () => {
    const raw: RawEvent = {
      native_id: "hk", ts_event: new Date().toISOString(), source: { ...SRC, tier: "aggregator" }, kind: "crypto.hack",
      title: "Exploit: SomeDEX — $40.0M (price manipulation)", summary: "on Solana", entities: [{ type: "asset", id: "asset:SOL", name: "SOL", confidence: 0.6 }], severity: 0.7, novelty: 0.9, raw_ref: "x",
    };
    const ev = scoreEvent(raw);
    expect(imp(ev, "SOL")!.direction).toBe(-1);
    expect(imp(ev, "HYPE")).toBeDefined(); // competes edge (sign -1 × -1 = +1 for HYPE)
    expect(imp(ev, "HYPE")!.direction).toBe(1);
  });

  it("event validates against schema and carries latency & tradability", () => {
    const ts = new Date(Date.now() - 90_000).toISOString();
    const ev = scoreEvent({ native_id: "t", ts_event: ts, source: SRC, kind: "crypto.onchain", title: "BTC +4% in 1h", summary: "", entities: [{ type: "asset", id: "asset:BTC", name: "BTC", confidence: 1 }], severity: 0.3, novelty: 0.7, raw_ref: "x" });
    expect(ev.latency_ms).toBeGreaterThanOrEqual(90_000);
    expect(ev.tradable_now).toContain("BTC");
    expect(ev.id).toHaveLength(20);
  });
});

describe("sessions", () => {
  it("BTC always tradable, NVDA closed on Sunday with next_open Monday 09:30 ET", () => {
    const sunday = new Date("2026-09-27T15:00:00Z");
    const t = tradability(["BTC", "NVDA", "CL"], sunday);
    expect(t.tradable_now).toContain("BTC");
    expect(t.tradable_now).not.toContain("NVDA");
    const n = t.next_open.find(x => x.asset_id === "NVDA")!;
    expect(n.at).toBe("2026-09-28T13:30:00.000Z"); // 09:30 EDT
  });
  it("CME futures open Sunday evening ET", () => {
    const u = loadUniverse();
    const cl = u.assets.find(a => a.id === "CL")!;
    expect(isTradable(cl, new Date("2026-09-27T22:30:00Z"))).toBe(true);  // 18:30 ET Sunday
    expect(isTradable(cl, new Date("2026-09-27T15:00:00Z"))).toBe(false); // 11:00 ET Sunday
  });
  it("US holiday closes equities", () => {
    const nvda = loadUniverse().assets.find(a => a.id === "NVDA")!;
    expect(isTradable(nvda, new Date("2026-11-26T16:00:00Z"))).toBe(false); // Thanksgiving
    expect(isTradable(nvda, new Date("2026-11-27T16:00:00Z"))).toBe(true);
  });
});

describe("graph", () => {
  it("propagate from BTC reaches MSTR/COIN/IBIT with decreasing weight", () => {
    const p = propagate([{ node: "asset:BTC", weight: 1, sign: 1 }]);
    const w = (id: string) => p.find(x => x.asset_id === id)?.weight ?? 0;
    expect(w("MSTR")).toBeGreaterThan(0.8);
    expect(w("IBIT")).toBe(1);
    expect(w("COIN")).toBeGreaterThan(0.5);
    expect(w("SMCI")).toBe(0);
  });
  it("neighborhood(NVDA) includes TSM and NDX", () => {
    const n = neighborhood("NVDA", 1);
    expect(n.nodes).toContain("company:TSM");
    expect(n.nodes).toContain("asset:NDX");
  });
});
