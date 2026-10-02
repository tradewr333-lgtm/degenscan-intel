import type { Connector } from "../base.js";
import { rssConnector, src, clamp, has, ent } from "../base.js";
import { fetchJson, gnews } from "../http.js";
import type { RawEvent, EventKind } from "../../schema.js";
import { entityFromCik } from "../../engine/entities.js";

/* ───────────────────────── SEC ───────────────────────── */

/** 8-K item → kind/severity. Items per Reg S-K. */
const ITEM_MAP: Record<string, { kind: EventKind; sev: number; label: string }> = {
  "1.01": { kind: "corp.8k", sev: 0.6, label: "Material definitive agreement" },
  "1.02": { kind: "corp.8k", sev: 0.6, label: "Termination of material agreement" },
  "1.03": { kind: "corp.bankruptcy", sev: 1, label: "Bankruptcy or receivership" },
  "1.05": { kind: "corp.8k", sev: 0.7, label: "Material cybersecurity incident" },
  "2.01": { kind: "corp.mna", sev: 0.7, label: "Completion of acquisition/disposition" },
  "2.02": { kind: "corp.earnings", sev: 0.8, label: "Results of operations" },
  "2.03": { kind: "corp.8k", sev: 0.4, label: "Creation of direct financial obligation" },
  "2.04": { kind: "corp.8k", sev: 0.7, label: "Triggering events (acceleration of obligation)" },
  "2.05": { kind: "corp.8k", sev: 0.6, label: "Exit or disposal costs (restructuring)" },
  "2.06": { kind: "corp.8k", sev: 0.6, label: "Material impairment" },
  "3.01": { kind: "corp.8k", sev: 0.7, label: "Delisting notice" },
  "3.02": { kind: "corp.offering", sev: 0.5, label: "Unregistered sale of equity" },
  "4.01": { kind: "corp.8k", sev: 0.6, label: "Change in auditor" },
  "4.02": { kind: "corp.8k", sev: 0.9, label: "Non-reliance on prior financials (restatement)" },
  "5.01": { kind: "corp.8k", sev: 0.7, label: "Change in control" },
  "5.02": { kind: "corp.8k", sev: 0.6, label: "Departure/appointment of directors or officers" },
  "5.03": { kind: "corp.8k", sev: 0.2, label: "Amendments to articles/bylaws" },
  "7.01": { kind: "corp.press", sev: 0.3, label: "Reg FD disclosure" },
  "8.01": { kind: "corp.8k", sev: 0.4, label: "Other events" },
};

/** SEC EDGAR full-text search — every 8-K in the last day, with items. Requires descriptive User-Agent (INTEL_UA). */
export const secEfts: Connector = {
  id: "sec-efts", name: "SEC EDGAR 8-K (full-text search)", tier: "primary", cadence_s: 60, url: "https://efts.sec.gov/LATEST/search-index",
  async run() {
    const today = new Date(); const from = new Date(today.getTime() - ([0, 6].includes(today.getUTCDay()) ? 4 : 2) * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const url = `https://efts.sec.gov/LATEST/search-index?q=%228-K%22&forms=8-K&dateRange=custom&startdt=${fmt(from)}&enddt=${fmt(today)}`;
    const r = await fetchJson<any>(url);
    const hits: any[] = r?.hits?.hits ?? [];
    return hits.map((h): RawEvent | null => {
      const s = h._source;
      const cik = String(s.ciks?.[0] ?? "");
      const company = entityFromCik(cik);
      if (!company) return null;                                  // only universe companies
      const items: string[] = (s.items ?? []).map((x: string) => x.trim());
      const top = items.map(i => ITEM_MAP[i]).filter(Boolean).sort((a, b) => b.sev - a.sev)[0] ?? { kind: "corp.8k" as EventKind, sev: 0.3, label: "8-K" };
      const name = String(s.display_names?.[0] ?? company.name).replace(/\s*\(CIK.*$/, "");
      const [adsh, file] = String(h._id).split(":");
      const link = `https://www.sec.gov/Archives/edgar/data/${cik.replace(/^0+/, "")}/${adsh.replace(/-/g, "")}/${file}`;
      return {
        native_id: h._id, ts_event: new Date(`${s.file_date}T${s.file_time ?? "12:00:00"}-04:00`).toISOString(), source: src(secEfts), kind: top.kind,
        title: `${name} files 8-K — ${top.label}${items.length > 1 ? ` (+${items.length - 1})` : ""}`,
        summary: `Form 8-K items ${items.join(", ")}. ${items.map(i => ITEM_MAP[i]?.label).filter(Boolean).join("; ")}.`,
        entities: [company], severity: top.sev, novelty: items.includes("2.02") ? 0.4 : 0.7, raw_ref: link, meta: { items, cik },
      };
    }).filter(Boolean) as RawEvent[];
  },
};

/** SEC EDGAR "latest filings" Atom: Form 4 (insiders), 13D/G (activists), S-1/424B (offerings). */
export const secAtom: Connector = {
  id: "sec-atom", name: "SEC EDGAR latest filings", tier: "primary", cadence_s: 120, url: "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent",
  async run() {
    const forms: { type: string; kind: EventKind; sev: number }[] = [
      { type: "SC 13D", kind: "corp.activist", sev: 0.7 }, { type: "4", kind: "corp.insider", sev: 0.3 }, { type: "S-1", kind: "corp.offering", sev: 0.4 }, { type: "424B5", kind: "corp.offering", sev: 0.5 },
    ];
    const out: RawEvent[] = [];
    const { fetchRss } = await import("../http.js");
    for (const f of forms) {
      const items = await fetchRss(`https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(f.type)}&count=100&output=atom`);
      for (const it of items) {
        const cikm = /\((\d{10})\)/.exec(it.title) ?? /CIK=(\d+)/.exec(it.link ?? "");
        const company = cikm ? entityFromCik(cikm[1]) : undefined;
        if (!company) continue;
        out.push({
          native_id: it.guid, ts_event: it.isoDate ?? new Date().toISOString(), source: src(secAtom), kind: f.kind,
          title: it.title, summary: `${f.type} filing: ${it.title}`, entities: [company], severity: f.sev, novelty: 0.5, raw_ref: it.link ?? "",
        });
      }
    }
    return out;
  },
};

export const secPress = rssConnector(
  { id: "sec-press", name: "SEC Press Releases", tier: "primary", cadence_s: 300, url: "https://www.sec.gov/news", feed: "https://www.sec.gov/news/pressreleases.rss" },
  { kind: it => has(it.title, "charges", "settle", "fraud", "penalt") ? "reg.enforcement" : has(it.title, "adopts", "final rule", "approves") ? "reg.rule" : has(it.title, "proposes") ? "reg.proposed_rule" : "reg.notice",
    severity: it => has(it.title, "charges", "fraud") ? 0.6 : 0.4, entities: () => [ent("regulator", "regulator:SEC", "SEC")] },
);

/* ───────────────────────── Fed / central banks ───────────────────────── */

export const fedPress = rssConnector(
  { id: "fed-press", name: "Federal Reserve Press", tier: "primary", cadence_s: 60, url: "https://www.federalreserve.gov/newsevents.htm", feed: "https://www.federalreserve.gov/feeds/press_all.xml" },
  {
    kind: it => has(it.title, "FOMC statement", "Federal Reserve issues FOMC statement") ? "cb.decision" : has(it.title, "minutes") ? "cb.minutes"
      : has(it.title, "enforcement") ? "reg.enforcement" : has(it.title, "requests comment", "proposal") ? "reg.proposed_rule" : has(it.title, "final rule", "approves") ? "reg.rule" : "cb.press",
    severity: it => has(it.title, "FOMC statement") ? 1 : has(it.title, "minutes") ? 0.6 : has(it.title, "stablecoin", "GENIUS") ? 0.6 : has(it.title, "approval of application", "announces approval", "enforcement action with former", "termination of enforcement") ? 0.1 : 0.3,
    novelty: it => has(it.title, "FOMC") ? 0.3 : 0.6,
    entities: it => [ent("regulator", "regulator:FED", "Federal Reserve"), ...(has(it.title, "stablecoin", "GENIUS") ? [ent("asset", "asset:USDC", "USDC", 0.7), ent("asset", "asset:USDT", "USDT", 0.7)] : [])],
  },
);
export const fedSpeeches = rssConnector(
  { id: "fed-speeches", name: "Federal Reserve Speeches", tier: "primary", cadence_s: 300, url: "https://www.federalreserve.gov/newsevents/speeches.htm", feed: "https://www.federalreserve.gov/feeds/speeches.xml" },
  { kind: () => "cb.speech", severity: it => has(it.title, "Powell", "Chair") ? 0.7 : 0.35, entities: () => [ent("regulator", "regulator:FED", "Federal Reserve")] },
);
export const ecbPress = rssConnector(
  { id: "ecb-press", name: "ECB Press Releases", tier: "primary", cadence_s: 120, url: "https://www.ecb.europa.eu/press", feed: "https://www.ecb.europa.eu/rss/press.html" },
  { kind: it => has(it.title, "monetary policy decision") ? "cb.decision" : "cb.press", severity: it => has(it.title, "monetary policy decision") ? 0.9 : 0.3, entities: () => [ent("regulator", "regulator:ECB", "ECB")] },
);
export const boePress = rssConnector(
  { id: "boe-press", name: "Bank of England News", tier: "primary", cadence_s: 300, url: "https://www.bankofengland.co.uk/news", feed: "https://www.bankofengland.co.uk/rss/news" },
  { kind: it => has(it.title, "Bank Rate", "Monetary Policy Summary") ? "cb.decision" : "cb.press", severity: it => has(it.title, "Bank Rate") ? 0.7 : 0.25, entities: () => [ent("regulator", "regulator:BOE", "BoE")] },
);
export const bojPress = rssConnector(
  { id: "boj-press", name: "Bank of Japan", tier: "primary", cadence_s: 300, url: "https://www.boj.or.jp/en", feed: "https://www.boj.or.jp/en/rss/whatsnew.xml" },
  { kind: it => has(it.title, "Statement on Monetary Policy") ? "cb.decision" : "cb.press", severity: it => has(it.title, "Monetary Policy") ? 0.8 : 0.25, entities: () => [ent("regulator", "regulator:BOJ", "BoJ")] },
);

/* ───────────────────────── Federal Register (all US federal rules) ───────────────────────── */

const AGENCY_TO_REG: Record<string, string> = {
  "securities-and-exchange-commission": "SEC", "federal-reserve-system": "FED", "commodity-futures-trading-commission": "CFTC", "federal-trade-commission": "FTC",
  "justice-department": "DOJ", "antitrust-division": "DOJ", "food-and-drug-administration": "FDA", "federal-communications-commission": "FCC",
  "federal-aviation-administration": "FAA", "national-highway-traffic-safety-administration": "NHTSA", "industry-and-security-bureau": "BIS",
  "trade-representative-office-of-united-states": "USTR", "foreign-assets-control-office": "OFAC", "centers-for-medicare-medicaid-services": "CMS",
  "treasury-department": "TREASURY", "executive-office-of-the-president": "WH", "energy-department": "DOE", "environmental-protection-agency": "EPA",
};
const WATCH_AGENCIES = Object.keys(AGENCY_TO_REG);

export const federalRegister: Connector = {
  id: "federal-register", name: "Federal Register (rules, proposed rules, EOs)", tier: "primary", cadence_s: 900, url: "https://www.federalregister.gov/developers/documentation/api/v1",
  async run() {
    const qs = new URLSearchParams({ per_page: "100", order: "newest" });
    for (const t of ["RULE", "PRORULE", "PRESDOCU"]) qs.append("conditions[type][]", t);
    for (const a of WATCH_AGENCIES) qs.append("conditions[agencies][]", a);
    qs.append("fields[]", "title"); qs.append("fields[]", "type"); qs.append("fields[]", "abstract"); qs.append("fields[]", "document_number");
    qs.append("fields[]", "html_url"); qs.append("fields[]", "publication_date"); qs.append("fields[]", "agencies"); qs.append("fields[]", "significant");
    const r = await fetchJson<any>(`https://www.federalregister.gov/api/v1/documents.json?${qs}`);
    return (r.results ?? []).map((d: any): RawEvent => {
      const regs = (d.agencies ?? []).map((a: any) => AGENCY_TO_REG[a.slug]).filter(Boolean) as string[];
      const kind: EventKind = d.type === "Rule" ? "reg.rule" : d.type === "Proposed Rule" ? "reg.proposed_rule" : "reg.notice";
      return {
        native_id: d.document_number, ts_event: `${d.publication_date}T09:00:00-04:00`, source: src(federalRegister), kind,
        title: `${d.type}: ${d.title}`.slice(0, 300), summary: String(d.abstract ?? "").slice(0, 600),
        entities: regs.map(rg => ent("regulator", `regulator:${rg}`, rg, 0.9)), text_hints: (d.agencies ?? []).map((a: any) => a.name),
        severity: d.significant ? 0.6 : d.type === "Rule" ? 0.4 : 0.25, novelty: 0.5, raw_ref: d.html_url, meta: { type: d.type, significant: d.significant },
      };
    });
  },
};

/* ───────────────────────── Agencies RSS ───────────────────────── */

export const ftcPress = rssConnector(
  { id: "ftc-press", name: "FTC Press Releases", tier: "primary", cadence_s: 300, url: "https://www.ftc.gov/news-events", feed: "https://www.ftc.gov/feeds/press-release.xml" },
  { kind: it => has(it.title, "sues", "lawsuit", "complaint", "order", "blocks", "challenges", "merger") ? "reg.antitrust" : has(it.title, "settle", "penalt", "fine") ? "reg.enforcement" : "reg.notice",
    severity: it => has(it.title, "sues", "blocks", "challenges") ? 0.7 : 0.35, entities: () => [ent("regulator", "regulator:FTC", "FTC")] },
);
export const dojPress = rssConnector(
  { id: "doj-press", name: "DOJ Press Releases", tier: "primary", cadence_s: 300, url: "https://www.justice.gov/news", fallback_chain: true,
    feed: ["https://www.justice.gov/news/rss?type=press_release", "https://www.justice.gov/feeds/justice-news.xml", gnews("justice.gov", "when:1d")] },
  { kind: it => has(it.title, "antitrust", "monopol", "merger", "price-fixing", "price fixing", "cartel") ? "reg.antitrust"
      : has(it.title, "securities fraud", "insider trading", "foreign corrupt", "fcpa", "export control", "sanctions evasion", "cryptocurrency", "crypto", "market manipulation", "bank fraud", "wire fraud scheme", "false claims act", "medicare fraud") ? "reg.enforcement" : null,
    severity: it => has(it.title, "antitrust", "monopol", "merger") ? 0.7 : 0.35, entities: () => [ent("regulator", "regulator:DOJ", "DOJ")] },
);
export const fdaPress = rssConnector(
  { id: "fda-press", name: "FDA Press Announcements", tier: "primary", cadence_s: 300, url: "https://www.fda.gov/news-events", feed: "https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/press-releases/rss.xml" },
  { kind: it => has(it.title, "approv", "authoriz", "clear") ? "reg.approval" : has(it.title, "warn", "recall", "safety", "reject", "complete response") ? "reg.enforcement" : "reg.notice",
    severity: it => has(it.title, "approv") ? 0.6 : 0.35, entities: () => [ent("regulator", "regulator:FDA", "FDA")] },
);
export const cftcPress = rssConnector(
  { id: "cftc-press", name: "CFTC Press Releases", tier: "primary", cadence_s: 300, url: "https://www.cftc.gov/PressRoom", feed: "https://www.cftc.gov/RSS/RSSGP/rssgp.xml" },
  { kind: it => has(it.title, "charges", "order", "penalt") ? "reg.enforcement" : has(it.title, "approves", "final rule") ? "reg.rule" : has(it.title, "proposes") ? "reg.proposed_rule" : "reg.notice",
    severity: () => 0.4, entities: () => [ent("regulator", "regulator:CFTC", "CFTC")] },
);
export const fccNews = rssConnector(
  { id: "fcc-news", name: "FCC Headlines", tier: "primary", cadence_s: 900, url: "https://www.fcc.gov/news-events", fallback_chain: true,
    feed: ["https://www.fcc.gov/news-events/headlines.rss", "https://docs.fcc.gov/public/attachments/rss/headlines.xml", gnews("fcc.gov", "when:1d")] },
  { kind: it => has(it.title, "FM Station", "AM Station", "Political Files", "Additional Documents", "Daily Digest") ? null
      : has(it.title, "approves", "adopts", "order", "fine", "forfeiture", "merger", "transaction", "spectrum", "auction") ? "reg.rule" : has(it.title, "proposes", "proposed", "NPRM") ? "reg.proposed_rule"
      : has(it.title, "T-Mobile", "Verizon", "AT&T", "Comcast", "broadband", "5G", "satellite", "Starlink") ? "reg.notice" : null,
    severity: it => has(it.title, "fine", "forfeiture", "merger") ? 0.5 : 0.3, entities: () => [ent("regulator", "regulator:FCC", "FCC")] },
);
export const whiteHouse = rssConnector(
  { id: "whitehouse", name: "White House", tier: "primary", cadence_s: 900, url: "https://www.whitehouse.gov", fallback_chain: true,
    feed: ["https://www.whitehouse.gov/presidential-actions/feed/", gnews("whitehouse.gov", "when:1d")] },
  { kind: it => has(it.title, "executive order") ? "reg.rule" : has(it.title, "tariff", "trade", "sanction") ? "reg.notice" : null,
    severity: it => has(it.title, "tariff") ? 0.7 : 0.5, entities: it => has(it.title, "tariff", "trade") ? [ent("regulator", "regulator:USTR", "USTR")] : [ent("regulator", "regulator:WH", "White House")] },
);
export const euCommission = rssConnector(
  { id: "ec-press", name: "European Commission Press", tier: "primary", cadence_s: 300, url: "https://ec.europa.eu/commission/presscorner", feed: "https://ec.europa.eu/commission/presscorner/api/rss?language=en" },
  { kind: it => has(it.title, "fine", "antitrust", "DMA", "Digital Markets", "non-compliance") ? "reg.antitrust" : has(it.title, "approves", "clears") ? "reg.approval" : has(it.title, "tariff", "countermeasure") ? "reg.notice" : null,
    severity: it => has(it.title, "fine", "non-compliance") ? 0.7 : 0.4, entities: () => [ent("regulator", "regulator:EC", "European Commission")] },
);

/** CISA KEV — only entries naming universe vendors are useful. */
export const cisaKev: Connector = {
  id: "cisa-kev", name: "CISA Known Exploited Vulnerabilities", tier: "primary", cadence_s: 900, url: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
  async run() {
    const r = await fetchJson<any>("https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json");
    const cutoff = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    return (r.vulnerabilities ?? []).filter((v: any) => v.dateAdded >= cutoff).map((v: any): RawEvent => ({
      native_id: v.cveID, ts_event: `${v.dateAdded}T14:00:00Z`, source: src(cisaKev), kind: "reg.notice",
      title: `CISA KEV: ${v.cveID} — ${v.vendorProject} ${v.product}`, summary: `${v.vulnerabilityName}. ${v.shortDescription}`.slice(0, 600),
      text_hints: [v.vendorProject], severity: v.knownRansomwareCampaignUse === "Known" ? 0.5 : 0.3, novelty: 0.6, raw_ref: "https://www.cisa.gov/known-exploited-vulnerabilities-catalog",
    }));
  },
};

/** OFAC recent actions (sanctions designations). */
export const ofac = rssConnector(
  { id: "ofac", name: "OFAC Recent Actions", tier: "primary", cadence_s: 21600, url: "https://ofac.treasury.gov/recent-actions", fallback_chain: true,
    feed: ["https://ofac.treasury.gov/recent-actions.rss", "https://ofac.treasury.gov/system/files/126/ofac.xml", "https://home.treasury.gov/news/press-releases/rss", gnews("treasury.gov", "sanctions when:2d")] },
  { kind: () => "reg.sanction", severity: it => has(it.title, "Russia", "Iran", "China", "crypto", "virtual currency") ? 0.6 : 0.3, entities: () => [ent("regulator", "regulator:OFAC", "OFAC")] },
);

/** TreasuryDirect — upcoming auctions (supply). */
export const treasuryAuctions: Connector = {
  id: "treasury-auctions", name: "TreasuryDirect Auctions", tier: "primary", cadence_s: 3600, url: "https://www.treasurydirect.gov/TA_WS/",
  async run() {
    const r = await fetchJson<any[]>("https://www.treasurydirect.gov/TA_WS/securities/announced?format=json&pagesize=20");
    return r.filter(a => /Bond|Note/.test(a.securityType) && Number(a.securityTermWeekYear ?? 0) >= 0).map((a): RawEvent => ({
      native_id: a.cusip + a.auctionDate, ts_event: new Date(a.announcementDate ?? a.auctionDate).toISOString(), source: src(treasuryAuctions), kind: "macro.auction",
      title: `Treasury announces ${a.securityTerm} ${a.securityType} auction — $${(Number(a.offeringAmount) / 1e9).toFixed(0)}B on ${a.auctionDate?.slice(0, 10)}`,
      summary: `CUSIP ${a.cusip}, offering ${a.offeringAmount}, auction ${a.auctionDate}, issue ${a.issueDate}.`,
      entities: [ent("asset", /30-Year|20-Year/.test(a.securityTerm) ? "asset:US30Y" : /10-Year|7-Year/.test(a.securityTerm) ? "asset:US10Y" : "asset:US2Y", "UST", 0.8)],
      severity: clamp(Number(a.offeringAmount) / 60e9), novelty: 0.2, raw_ref: "https://www.treasurydirect.gov/auctions/upcoming/",
    }));
  },
};

export const REGULATORS: Connector[] = [
  secEfts, secAtom, secPress, fedPress, fedSpeeches, ecbPress, boePress, bojPress, federalRegister,
  ftcPress, dojPress, fdaPress, cftcPress, fccNews, whiteHouse, euCommission, cisaKev, ofac, treasuryAuctions,
];
