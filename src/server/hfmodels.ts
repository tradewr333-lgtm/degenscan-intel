/**
 * Open models by task (Renato 03/11, LitServe post): which open models people actually use for each AI task — image
 * classification, speech-to-text, OCR, embeddings, object detection… — from the PRIMARY public Hugging Face Hub API
 * (downloads last 30 days, likes, trending score, license, library). For agents and developers choosing a model to
 * serve behind their own API. No inference, no GPU, no resale of third-party data.
 */
import { UA } from "../ingest/http.js";

export const HF_TASKS: Record<string, string> = {
  "image-classification": "image-classification", "object-detection": "object-detection", "image-segmentation": "image-segmentation",
  "speech-to-text": "automatic-speech-recognition", transcription: "automatic-speech-recognition", asr: "automatic-speech-recognition", "automatic-speech-recognition": "automatic-speech-recognition",
  "text-to-speech": "text-to-speech", tts: "text-to-speech", ocr: "image-to-text", "image-to-text": "image-to-text", "image-text-to-text": "image-text-to-text", vlm: "image-text-to-text",
  embeddings: "feature-extraction", "feature-extraction": "feature-extraction", "sentence-similarity": "sentence-similarity", reranking: "text-ranking", "text-ranking": "text-ranking",
  "text-to-image": "text-to-image", "text-to-video": "text-to-video", translation: "translation", summarization: "summarization",
  "text-classification": "text-classification", sentiment: "text-classification", "zero-shot-classification": "zero-shot-classification", ner: "token-classification", "token-classification": "token-classification",
  "depth-estimation": "depth-estimation", "text-generation": "text-generation", "audio-classification": "audio-classification",
};
/**
 * License classes (07/11, open-source AI post): agents embedding an open model first ask "can I ship this commercially?".
 * permissive = MIT/Apache/BSD-style; copyleft = GPL family (commercial ok, share-alike); open_rail = OpenRAIL/RAIL (commercial
 * ok with use restrictions); restricted = non-commercial / research-only; custom = model-specific licences (Llama, Gemma, Qwen,
 * other) that need a read. commercial_ok is a first-pass label from the license tag, not legal advice.
 */
const PERMISSIVE = /^(mit|apache-2\.0|apache|bsd(-[23]-clause)?|bsd-3-clause-clear|isc|unlicense|cc0-1\.0|cc-by-4\.0|cc-by-3\.0|cc-by-2\.0|zlib|wtfpl|artistic-2\.0|ecl-2\.0|afl-3\.0|bsl-1\.0|pddl|odc-by|mpl-2\.0|postgresql|ms-pl)$/;
export function licenseClass(lic: string | null): { license_class: string; commercial_ok: boolean | null } {
  const l = (lic ?? "").toLowerCase().trim();
  if (!l || l === "unknown") return { license_class: "unknown", commercial_ok: null };
  if (/(^|-)nc(-|$)|non-?commercial|research|academic|cc-by-nc|deepfloyd|afl-research/.test(l)) return { license_class: "restricted", commercial_ok: false };
  if (PERMISSIVE.test(l)) return { license_class: "permissive", commercial_ok: true };
  if (/^(a?gpl|lgpl|cc-by-sa|epl|eupl|osl|cc-by-nd)/.test(l)) return { license_class: "copyleft", commercial_ok: true };
  if (/rail/.test(l)) return { license_class: "open_rail", commercial_ok: true };
  return { license_class: "custom", commercial_ok: null };
}
const LICENSE_FILTERS = ["permissive", "commercial", "copyleft", "open_rail", "restricted", "custom"];
const memo = new Map<string, { at: number; v: any }>();
export const _hf = { reset() { memo.clear(); } };

/** Pure: Hugging Face /api/models rows → normalised items. Exported for tests. */
export function hfItems(rows: any[]) {
  return (rows ?? []).filter(m => m?.id && !m.private).map((m: any) => {
    const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
    return { id: m.id, url: `https://huggingface.co/${m.id}`, author: String(m.id).split("/")[0], downloads_30d: Number(m.downloads ?? 0), likes: Number(m.likes ?? 0),
      trending_score: m.trendingScore ?? null, license: tags.find(t => t.startsWith("license:"))?.slice(8) ?? null, library: m.library_name ?? null,
      ...licenseClass(tags.find(t => t.startsWith("license:"))?.slice(8) ?? null), created_at: m.createdAt ?? null, gated: m.gated ? true : false, servable_via: tags.includes("endpoints_compatible") ? "endpoints_compatible" : null };
  });
}

export async function aiModelsByTask(q: any = {}) {
  const key = String(q.task ?? "image-classification").toLowerCase().trim();
  const task = HF_TASKS[key];
  if (!task) throw Object.assign(new Error(`unknown task "${key}". Tasks: ${Object.keys(HF_TASKS).join(", ")}`), { status: 400 });
  const sort = ["downloads", "likes", "trending"].includes(String(q.sort)) ? String(q.sort) : "downloads";
  const limit = Math.min(Math.max(Number(q.limit) || 15, 1), 50);
  const ck = `${task}:${sort}`; const c = memo.get(ck);
  let rows: any[];
  if (c && Date.now() - c.at < 3600_000) rows = c.v;
  else {
    try {
      const res = await fetch(`https://huggingface.co/api/models?pipeline_tag=${encodeURIComponent(task)}&sort=${sort === "trending" ? "trendingScore" : sort}&direction=-1&limit=50`,
        { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw Object.assign(new Error(`huggingface.co ${res.status}`), { status: 502 });
      rows = await res.json() as any[]; memo.set(ck, { at: Date.now(), v: rows });
    } catch (e) { if (c) rows = c.v; else throw e; }
  }
  let items = hfItems(rows);
  const lf = q.license ? String(q.license).toLowerCase().trim() : "";
  if (lf === "commercial") items = items.filter(i => i.commercial_ok === true);
  else if (LICENSE_FILTERS.includes(lf)) items = items.filter(i => i.license_class === lf);
  else if (lf) items = items.filter(i => i.license && i.license.toLowerCase().includes(lf));
  const all = hfItems(rows); const licence_mix: Record<string, number> = {};
  for (const i of all) licence_mix[i.license_class] = (licence_mix[i.license_class] ?? 0) + 1;
  return { task, asked: key, sort, license_filter: lf || null, n: Math.min(items.length, limit), items: items.slice(0, limit), licence_mix_top50: licence_mix,
    note: "downloads_30d = Hugging Face Hub downloads in the last 30 days. license_class/commercial_ok are a first-pass reading of the license tag (permissive = MIT/Apache/BSD; custom = model-specific terms, read them). license= accepts permissive, commercial, copyleft, open_rail, restricted, custom or any license id (e.g. mit).",
    sources: ["Hugging Face Hub public API (/api/models)"], as_of: new Date().toISOString(), disclaimer: "Information and analytics only — not investment or legal advice." };
}
