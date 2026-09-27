import Parser from "rss-parser";

/** SEC and several agencies require an identifying User-Agent. Set INTEL_UA="Degenscan Intel contact@degenscan.io". */
export const UA = process.env.INTEL_UA ?? "degenscan-intel/0.1 (+https://degenscan.io; contact@degenscan.io)";

export async function fetchText(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<string> {
  const { timeoutMs = 20_000, headers, ...rest } = init;
  const res = await fetch(url, { ...rest, headers: { "user-agent": UA, accept: "*/*", ...(headers as Record<string, string> ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

export async function fetchJson<T = unknown>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const txt = await fetchText(url, { ...init, headers: { accept: "application/json", ...(init.headers as Record<string, string> ?? {}) } });
  return JSON.parse(txt) as T;
}

const parser = new Parser({
  timeout: 20_000,
  headers: { "user-agent": UA },
  customFields: { item: [["content:encoded", "contentEncoded"], ["dc:date", "dcDate"], ["category", "categories", { keepArray: true }]] },
});

export interface RssItem {
  guid: string; title: string; link?: string; isoDate?: string; content?: string; contentSnippet?: string; categories?: string[]; raw: Record<string, unknown>;
}

/** rss-parser sometimes yields objects ({_: text, $: attrs}) for guid/link/title; flatten safely. */
export function txt(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return txt(v[0]);
  if (typeof v === "object") { const o = v as any; return txt(o._ ?? o["#text"] ?? o.href ?? o.$?.href ?? o.value ?? Object.values(o).find(x => typeof x === "string")); }
  return "";
}

export async function fetchRss(url: string): Promise<RssItem[]> {
  const xml = await fetchText(url, { timeoutMs: 12_000, headers: { accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
  const feed = await parser.parseString(xml);
  return (feed.items ?? []).map((it: any) => {
    const title = txt(it.title).trim();
    const link = txt(it.link) || undefined;
    let isoDate: string | undefined = it.isoDate;
    if (!isoDate) { const d = new Date(txt(it.pubDate) || txt(it.dcDate) || txt(it.updated) || txt(it.published)); if (!isNaN(d.getTime())) isoDate = d.toISOString(); }
    return {
      guid: txt(it.guid) || txt(it.id) || link || title,
      title, link, isoDate,
      content: txt(it.contentEncoded) || txt(it.content) || undefined,
      contentSnippet: txt(it.contentSnippet) || txt(it.summary) || undefined,
      categories: Array.isArray(it.categories) ? it.categories.map(txt) : undefined,
      raw: it,
    };
  });
}

/** Google News RSS restricted to a site — the universal fallback for agencies that block bots. */
export function gnews(site: string, extra = "") {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`site:${site} ${extra}`.trim())}&hl=en-US&gl=US&ceid=US:en`;
}

export function stripHtml(s: string | undefined): string {
  return (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
}
