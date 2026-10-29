import { describe, it, expect } from "vitest";
import { normModels, filterModels, weekly, aiRegulation } from "../src/server/aiintel.js";
const rows = [
  { id: "a/cheap", name: "Cheap", created: 1790000000, context_length: 128000, pricing: { prompt: "0.0000001", completion: "0.0000004" }, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, supported_parameters: ["tools"], top_provider: { max_completion_tokens: 8000 } },
  { id: "b/pricey", name: "Pricey", created: 1791000000, context_length: 200000, pricing: { prompt: "0.000003", completion: "0.000015" }, architecture: { input_modalities: ["text"] }, supported_parameters: ["tools", "reasoning"] },
  { id: "c/free", name: "Free", context_length: 32000, pricing: { prompt: "0", completion: "0" }, architecture: { input_modalities: ["text"] } },
  { id: "openrouter/auto", name: "Auto", pricing: { prompt: "-1", completion: "-1" } },
];
describe("ai intel", () => {
  it("normalises OpenRouter rows", () => {
    const m = normModels(rows); expect(m.length).toBe(3);
    expect(m[0]).toMatchObject({ provider: "a", input_per_1m: 0.1, output_per_1m: 0.4, tools: true, max_output: 8000 });
    expect(m[2].free).toBe(true);
  });
  it("filters by needs", () => {
    const m = normModels(rows);
    expect(filterModels(m, { needs: "tools,vision" }).map(x => x.id)).toEqual(["a/cheap"]);
    expect(filterModels(m, { needs: "reasoning", min_context: 150000 }).map(x => x.id)).toEqual(["b/pricey"]);
    expect(filterModels(m, {}).map(x => x.id)).not.toContain("c/free");
  });
  it("weekly WoW", () => {
    const s = Array.from({ length: 14 }, (_, i) => ({ day: `2026-10-${String(i + 10).padStart(2, "0")}`, downloads: i < 7 ? 100 : 110 }));
    expect(weekly(s)).toMatchObject({ last_7d: 770, prior_7d: 700, wow_pct: 10 });
  });
  it("regulation", () => {
    const r = aiRegulation("eu"); expect(r.jurisdictions.eu.milestones.length).toBeGreaterThan(5);
    expect(() => aiRegulation("xx")).toThrow();
    expect(Object.keys(aiRegulation().jurisdictions)).toEqual(["eu", "us_colorado", "brazil"]);
  });
});
import { countRecent } from "../src/server/aiintel.js";
describe("arxiv count", () => { it("counts recent published", () => {
  const now = Date.parse("2026-10-29T00:00:00Z"); const x = ["2026-10-28", "2026-10-25", "2026-10-10", "2026-09-01"].map(d => `<published>${d}T10:00:00Z</published>`).join("");
  expect(countRecent(x, now, 1000)).toEqual({ d7: 2, d30: 3, capped_30d: false });
  expect(countRecent(x.split("<published>2026-09-01")[0], now, 3).capped_30d).toBe(true); }); });
