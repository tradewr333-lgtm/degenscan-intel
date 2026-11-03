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
const memo = new Map<string, { at: number; v: any }>();
export const _hf = { reset() { memo.clear(); } };

/** Pure: Hugging Face /api/models rows → normalised items. Exported for tests. */
export function hfItems(rows: any[]) {
  return (rows ?? []).filter(m => m?.id && !m.private).map((m: any) => {
    const tags: string[] = Array.isArray(m.tags) ? m.tags : [];
    return { id: m.id, url: `https://huggingface.co/${m.id}`, author: String(m.id).split("/")[0], downloads_30d: Number(m.downloads ?? 0), likes: Number(m.likes ?? 0),
      trending_score: m.trendingScore ?? null, license: tags.find(t => t.startsWith("license:"))?.slice(8) ?? null, library: m.library_name ?? null,
      created_at: m.createdAt ?? null, gated: m.gated ? true : false, servable_via: tags.includes("endpoints_compatible") ? "endpoints_compatible" : null };
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
  if (q.license) items = items.filter(i => i.license && i.license.toLowerCase().includes(String(q.license).toLowerCase()));
  return { task, asked: key, sort, n: Math.min(items.length, limit), items: items.slice(0, limit),
    note: "downloads_30d = Hugging Face Hub downloads in the last 30 days. Check each model's license before commercial use.",
    sources: ["Hugging Face Hub public API (/api/models)"], as_of: new Date().toISOString(), disclaimer: "Information and analytics only — not investment or legal advice." };
}
