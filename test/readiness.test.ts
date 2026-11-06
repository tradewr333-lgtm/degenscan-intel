import { describe, it, expect } from "vitest";
import { blockedIp, originOf, scoreSurfaces, compareAudits, agentReadiness } from "../src/server/readiness.js";
import { hfItems, HF_TASKS } from "../src/server/hfmodels.js";
import { rewriteAlias } from "../src/server/aliases.js";

describe("agent_readiness (03/11)", () => {
  it("refuses private, loopback, link-local, CGNAT, metadata and non-HTTPS targets (SSRF)", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) expect(blockedIp(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) expect(blockedIp(ip)).toBe(false);
    for (const u of ["http://example.com", "https://127.0.0.1", "https://169.254.169.254/latest", "https://localhost", "https://intranet", "https://x.internal", "https://example.com:8443", "https://u:p@example.com", "nope:://"]) expect(() => originOf(u)).toThrow();
    expect(originOf("example.com/path?q=1")).toBe("https://example.com");
  });
  it("scores surfaces and lists the fixes, biggest first", () => {
    const none = scoreSurfaces("https://x", { openapi: null, llms: null, x402: null, a2a: null, mcp: null, robots: null });
    expect(none.score).toBe(5); expect(none.grade).toBe("F"); expect(none.fixes[0]).toContain("OpenAPI");
    const full = scoreSurfaces("https://x", { openapi: { paths: { "/a": { get: { summary: "A", "x-price-usd": 0.001 } } } }, openapiAt: "/openapi.json",
      llms: { status: 200, type: "text/plain", body: "# X\n> an API for agents with routes, prices and how to pay", url: "" }, x402: { resources: [{ price_usd: 0.001 }] }, a2a: { name: "X", skills: [] }, mcp: { url: "/mcp" }, robots: { status: 200, type: "", body: "User-agent: *\nAllow: /", url: "" } });
    expect(full.score).toBe(100); expect(full.grade).toBe("A"); expect(full.fixes).toEqual([]);
    const blocked = scoreSurfaces("https://x", { openapi: null, llms: null, x402: null, a2a: null, mcp: null, robots: { status: 200, type: "", body: "User-agent: *\nDisallow: /\n", url: "" } });
    expect(blocked.checks.find(c => c.id === "robots_allows")!.ok).toBe(false);
  });
});

describe("agent_readiness peer comparison (06/11)", () => {
  it("lists where the target is behind and what to fix first, largest gap first", () => {
    const a = scoreSurfaces("https://a.example", { openapi: { paths: { "/x": { get: { summary: "x" } } } }, llms: null, x402: null, a2a: null, mcp: null, robots: null });
    const b = scoreSurfaces("https://b.example", { openapi: { paths: { "/x": { get: { summary: "x", "x-price-usd": 0.001 } } } }, llms: { status: 200, body: "# b API\n\nRoutes, prices and how to pay with x402 for agents." } as any, x402: { resources: ["https://b.example/x"] }, a2a: null, mcp: null, robots: null });
    const c = compareAudits(a, b);
    expect(c.verdict).toBe("target behind"); expect(c.score_gap).toBeGreaterThan(0);
    expect(c.behind_on[0]).toBe("x402_discovery"); expect(c.behind_on).toContain("llms_txt");
    expect(c.fix_first.length).toBe(c.behind_on.filter(id => a.checks.find(k => k.id === id)?.fix).length);
    expect(compareAudits(a, a).verdict).toBe("tie");
  });
  it("rejects the same origin as peer", async () => {
    await expect(agentReadiness({ url: "https://a.example", peer: "a.example" })).rejects.toThrow(/different origin/);
  });
});

describe("ai_models_by_task (03/11)", () => {
  it("normalises Hugging Face rows and maps friendly task names", () => {
    const it0 = hfItems([{ id: "openai/whisper-large-v3", downloads: 4e6, likes: 5000, tags: ["license:mit", "endpoints_compatible"], library_name: "transformers" }, { id: "p/x", private: true }])[0];
    expect(it0).toMatchObject({ author: "openai", downloads_30d: 4e6, license: "mit", servable_via: "endpoints_compatible", url: "https://huggingface.co/openai/whisper-large-v3" });
    expect(HF_TASKS["speech-to-text"]).toBe("automatic-speech-recognition"); expect(HF_TASKS.ocr).toBe("image-to-text"); expect(HF_TASKS.embeddings).toBe("feature-extraction");
  });
  it("alias with fixed query default lets the caller's params win", () => {
    expect(rewriteAlias("/speech-to-text-models")).toBe("/v1/ai/models/by-task?task=speech-to-text");
    expect(rewriteAlias("/speech-to-text-models?limit=5")).toBe("/v1/ai/models/by-task?limit=5&task=speech-to-text");
    expect(rewriteAlias("/speech-to-text-models?task=ocr")).toBe("/v1/ai/models/by-task?task=ocr");
  });
});
