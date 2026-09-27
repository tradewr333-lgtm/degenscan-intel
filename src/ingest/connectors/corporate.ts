import type { Connector } from "../base.js";
import { rssConnector, src, clamp, has, ent } from "../base.js";
import { fetchJson, fetchRss, fetchText, gnews } from "../http.js";
import type { RawEvent } from "../../schema.js";
import { loadUniverse } from "../../universe/index.js";

/** Nasdaq trade halts — T1 (news pending) is the strongest "something is about to drop" signal that exists. */
export const nasdaqHalts: Connector = {
  id: "nasdaq-halts", name: "Nasdaq Trade Halts", tier: "primary", cadence_s: 30, url: "https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts",
  async run() {
    const xml = await fetchText("https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts");
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
    const pick = (s: string, tag: string) => (new RegExp(`<ndaq:${tag}>([^<]*)<`, "i").exec(s) ?? [])[1]?.trim() ?? "";
    const universeIds = new Set(loadUniverse().assets.map(a => a.id));
    return items.map((it): RawEvent | null => {
      const sym = pick(it, "IssueSymbol"), reason = pick(it, "ReasonCode"), date = pick(it, "HaltDate"), time = pick(it, "HaltTime"), market = pick(it, "Market");
      if (!sym) return null;
      const [mm, dd, yyyy] = date.split("/");
      const ts = new Date(`${yyyy}-${mm}-${dd}T${time.slice(0, 8)}-04:00`).toISOString();
      const news = /^T1$|^T2$|^T5$/.test(reason);
      const luld = /^LUDP$|^LUDS$|^M$/.test(reason);
      const inUniverse = universeIds.has(sym.replace(/\.W$/, ""));
      return {
        native_id: `${sym}-${date}-${time}`, ts_event: ts, source: src(nasdaqHalts), kind: "corp.halt",
        title: `Trading halt: ${sym} (${market}) — code ${reason}${news ? " news pending" : luld ? " volatility" : ""}`,
        summary: `${pick(it, "IssueName")} halted on ${market} at ${time} ET, reason ${reason}.${pick(it, "ResumptionTradeTime") ? ` Resumption ${pick(it, "ResumptionTradeTime")}.` : ""}`,
        entities: inUniverse ? [ent("company", `company:${sym.replace(/\.W$/, "")}`, sym)] : [],
        severity: news ? (inUniverse ? 0.9 : 0.4) : luld ? 0.5 : 0.2, novelty: 0.9, raw_ref: "https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts", meta: { reason, market },
      };
    }).filter(Boolean) as RawEvent[];
  },
};

/** Nasdaq earnings calendar for today/tomorrow — scheduled events (low novelty, high severity for the name). */
export const nasdaqEarnings: Connector = {
  id: "nasdaq-earnings", name: "Nasdaq Earnings Calendar", tier: "aggregator", cadence_s: 3600, url: "https://www.nasdaq.com/market-activity/earnings",
  async run() {
    const out: RawEvent[] = [];
    const ids = new Set(loadUniverse().assets.filter(a => a.class === "equity").map(a => a.id));
    for (const off of [0, 1]) {
      const d = new Date(Date.now() + off * 86_400_000).toISOString().slice(0, 10);
      let r: any;
      try {
        r = await fetchJson<any>(`https://api.nasdaq.com/api/calendar/earnings?date=${d}`, { timeoutMs: 12_000, headers: {
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
          accept: "application/json, text/plain, */*", "accept-language": "en-US,en;q=0.9", origin: "https://www.nasdaq.com", referer: "https://www.nasdaq.com/market-activity/earnings" } });
      } catch (e) { if (off === 0) throw e; continue; }
      for (const row of r?.data?.rows ?? []) {
        if (!ids.has(row.symbol)) continue;
        out.push({
          native_id: `${row.symbol}-${d}`, ts_event: `${d}T${row.time === "time-pre-market" ? "11:00" : "20:30"}:00Z`, source: src(nasdaqEarnings), kind: "corp.earnings",
          title: `${row.symbol} reports earnings ${row.time === "time-pre-market" ? "pre-market" : "after close"} ${d} (consensus EPS ${row.epsForecast ?? "n/a"})`,
          summary: `${row.name} scheduled earnings. Consensus EPS ${row.epsForecast ?? "n/a"}, prior ${row.lastYearEPS ?? "n/a"}.`,
          entities: [ent("company", `company:${row.symbol}`, row.name)], severity: 0.6, novelty: 0.1, raw_ref: `https://www.nasdaq.com/market-activity/stocks/${row.symbol.toLowerCase()}/earnings`,
        });
      }
    }
    return out;
  },
};

/** Wire services — press releases hit these 1–3 minutes before media. Only keep items that name a universe company (linker does that; here we keep all and let impacts filter). */
const wireKind = (t: string) => has(t, "acqui", "merger", "to be acquired", "definitive agreement") ? "corp.mna" as const
  : has(t, "results", "quarter", "earnings", "fiscal") ? "corp.earnings" as const
  : has(t, "guidance", "outlook") ? "corp.guidance" as const
  : has(t, "recall") ? "corp.recall" as const
  : has(t, "lawsuit", "class action", "investigation") ? "corp.lawsuit" as const
  : has(t, "offering", "notes due", "convertible") ? "corp.offering" as const
  : "corp.press" as const;

export const prNewswire = rssConnector(
  { id: "prnewswire", name: "PR Newswire", tier: "aggregator", cadence_s: 120, url: "https://www.prnewswire.com", fallback_chain: true,
    feed: ["https://www.prnewswire.com/rss/news-releases-list.rss", "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss", gnews("prnewswire.com", "when:1h")] },
  { kind: it => wireKind(it.title), severity: it => wireKind(it.title) === "corp.press" ? 0.2 : 0.5, novelty: () => 0.5 },
);
export const businessWire = rssConnector(
  { id: "businesswire", name: "Business Wire", tier: "aggregator", cadence_s: 120, url: "https://www.businesswire.com", feed: "https://feed.businesswire.com/rss/home/?rss=G1QFDERJXkJeEFpRWQ==" },
  { kind: it => wireKind(it.title), severity: it => wireKind(it.title) === "corp.press" ? 0.2 : 0.5 },
);
export const globeNewswire = rssConnector(
  { id: "globenewswire", name: "GlobeNewswire", tier: "aggregator", cadence_s: 120, url: "https://www.globenewswire.com", feed: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies" },
  { kind: it => wireKind(it.title), severity: it => wireKind(it.title) === "corp.press" ? 0.2 : 0.5 },
);

/** Google News RSS per universe ticker (last hour). Media tier → corroboration and "attention" signal, never primary. */
export const googleNews: Connector = {
  id: "google-news", name: "Google News (per-ticker, 1h)", tier: "media", cadence_s: 600, url: "https://news.google.com",
  async run() {
    const out: RawEvent[] = [];
    const eq = loadUniverse().assets.filter(a => a.class === "equity").slice(0, 60); // keep request count sane; rotate in scheduler later
    const batches = chunk(eq, 8);
    for (const b of batches) {
      await Promise.all(b.map(async a => {
        const q = encodeURIComponent(`"${a.name.replace(/\s*\(.*\)/, "")}" OR "${a.id}" when:1h`);
        try {
          const items = await fetchRss(`https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`);
          for (const it of items.slice(0, 5)) out.push({
            native_id: it.guid, ts_event: it.isoDate ?? new Date().toISOString(), source: src(googleNews), kind: "media.report",
            title: it.title, summary: (it.contentSnippet ?? "").slice(0, 400), entities: [ent("company", `company:${a.id}`, a.name, 0.6)],
            severity: 0.2, novelty: 0.4, raw_ref: it.link ?? "",
          });
        } catch { /* per-ticker failures are fine */ }
      }));
    }
    return out;
  },
};

/** NHTSA recalls for auto names in universe (daily). */
export const nhtsaRecalls: Connector = {
  id: "nhtsa-recalls", name: "NHTSA Recalls", tier: "primary", cadence_s: 3600, url: "https://www.nhtsa.gov/recalls",
  async run() {
    const makes: [string, string][] = [["tesla", "TSLA"], ["ford", "F"], ["chevrolet", "GM"], ["rivian", "RIVN"], ["lucid", "LCID"]];
    const out: RawEvent[] = [];
    const yr = new Date().getFullYear();
    for (const [make, tk] of makes) {
      try {
        const r = await fetchJson<any>(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=${make}&modelYear=${yr}`);
        for (const rc of (r.results ?? []).slice(0, 5)) out.push({
          native_id: rc.NHTSACampaignNumber, ts_event: new Date(rc.ReportReceivedDate).toISOString(), source: src(nhtsaRecalls), kind: "corp.recall",
          title: `NHTSA recall ${rc.NHTSACampaignNumber}: ${rc.Manufacturer} — ${rc.Component}`, summary: String(rc.Summary ?? "").slice(0, 500),
          entities: [ent("company", `company:${tk}`, tk), ent("regulator", "regulator:NHTSA", "NHTSA", 0.8)],
          severity: clamp(Number(rc.PotentialNumberofUnitsAffected ?? 0) / 500_000), novelty: 0.5, raw_ref: "https://www.nhtsa.gov/recalls",
        });
      } catch { /* skip */ }
    }
    return out;
  },
};

function chunk<T>(a: T[], n: number): T[][] { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

export const CORPORATE: Connector[] = [nasdaqHalts, nasdaqEarnings, prNewswire, businessWire, globeNewswire, googleNews, nhtsaRecalls];
