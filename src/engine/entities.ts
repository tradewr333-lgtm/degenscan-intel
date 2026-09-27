import type { Entity } from "../schema.js";
import { loadUniverse, assetByCik } from "../universe/index.js";
import { facilitiesNear } from "../graph/graph.js";

/** Aliases → graph node. Extend freely; matching is case-insensitive whole-word. */
const COUNTRY_ALIASES: Record<string, string[]> = {
  TW: ["taiwan", "taiwanese", "hsinchu", "tainan", "taipei", "taiwan strait"],
  CN: ["china", "chinese", "beijing", "shanghai", "shenzhen", "prc", "hong kong", "zhengzhou"],
  "US-GULF": ["gulf coast", "gulf of mexico", "louisiana coast", "texas coast", "florida panhandle", "florida keys", "new orleans", "port of houston", "houston ship channel"],
  IR: ["iran", "iranian", "tehran", "hormuz", "strait of hormuz"],
  SA: ["saudi", "aramco", "riyadh", "ras tanura", "abqaiq"],
  IL: ["israel", "israeli", "tel aviv", "gaza", "hezbollah", "lebanon"],
  RU: ["russia", "russian", "moscow", "kremlin"],
  UA: ["ukraine", "ukrainian", "kyiv", "odesa", "odessa"],
  KR: ["south korea", "korean", "seoul", "pyeongtaek", "icheon"],
  JP: ["japan", "japanese", "tokyo"],
  DE: ["germany", "german", "berlin"],
  IN: ["india", "indian", "new delhi", "chennai"],
  MX: ["mexico", "mexican"],
  EG: ["egypt", "suez"],
  ID: ["indonesia", "grasberg"],
  BR: ["brazil", "brasil", "brazilian", "brasília"],
  VE: ["venezuela"],
  EU: ["european union", "eurozone", "brussels", "european commission"],
};

const REGULATOR_ALIASES: Record<string, string[]> = {
  FED: ["federal reserve", "fomc", "fed chair", "powell", "federal open market"],
  SEC: ["securities and exchange commission", "sec charges", "sec.gov", "gensler", "atkins"],
  CFTC: ["cftc", "commodity futures trading commission"],
  FTC: ["federal trade commission", "ftc"],
  DOJ: ["department of justice", "justice department", "doj", "antitrust division"],
  FDA: ["fda", "food and drug administration"],
  FCC: ["fcc", "federal communications commission"],
  FAA: ["faa", "federal aviation administration"],
  NHTSA: ["nhtsa", "highway traffic safety"],
  BIS: ["bureau of industry and security", "export controls", "entity list"],
  USTR: ["ustr", "trade representative", "tariff", "tariffs", "section 301", "section 232"],
  OFAC: ["ofac", "sanctions", "sdn list", "treasury sanctions"],
  CMS: ["cms", "medicare", "medicaid"],
  ECB: ["european central bank", "ecb", "lagarde"],
  BOJ: ["bank of japan", "boj", "ueda"],
  BOE: ["bank of england", "boe"],
  PBOC: ["pboc", "people's bank of china"],
  BCB: ["banco central do brasil", "copom", "selic"],
  EC: ["european commission", "dma", "digital markets act", "dsa"],
  TREASURY: ["treasury department", "treasury secretary", "bessent"],
  BLS: ["bureau of labor statistics", "nonfarm payrolls", "cpi", "consumer price index", "jobs report"],
};

// Bare words ("gold", "oil", "corn") produce false positives (Gold Star Distribution, Corn Belt Bancorp…): require market context.
const COMMODITY_ALIASES: Record<string, string[]> = {
  CL: ["crude", "wti", "opec", "opec+", "oil prices", "oil price", "price of oil", "oil futures", "oil output", "oil supply", "oil tanker", "barrels per day", "petroleum"],
  BZ: ["brent"],
  NG: ["natural gas", "lng", "henry hub"],
  GC: ["gold prices", "gold price", "price of gold", "gold futures", "spot gold", "bullion", "gold rally", "gold miners"],
  SI: ["silver prices", "silver price", "silver futures", "spot silver"],
  HG: ["copper prices", "copper price", "copper futures", "copper mine", "copper output"],
  ZW: ["wheat futures", "wheat prices", "wheat exports", "grain corridor", "grain exports"],
  ZC: ["corn futures", "corn prices", "corn crop", "corn harvest"],
  ZS: ["soybean futures", "soybean prices", "soybean exports", "soybeans"],
};

const THEME_ALIASES: Record<string, string[]> = {
  ai: ["artificial intelligence", " ai ", "gpu", "datacenter", "data center", "llm"],
  crypto: ["bitcoin", "crypto", "cryptocurrency", "stablecoin", "blockchain", "digital asset"],
  tariffs: ["tariff", "tariffs", "trade war", "import duties"],
  hurricane: ["gulf coast hurricane", "hurricane makes landfall", "landfall in florida", "landfall in louisiana", "landfall in texas"],
  defense: ["pentagon", "defense department", "nato", "missile"],
  glp1: ["glp-1", "ozempic", "wegovy", "zepbound", "mounjaro", "semaglutide", "tirzepatide"],
  ev: ["electric vehicle", "ev ", "evs "],
  stablecoin: ["stablecoin", "genius act", "tether", "usdc"],
};

const CRYPTO_ALIASES: Record<string, string[]> = {
  BTC: ["bitcoin", "btc"], ETH: ["ethereum", "ether", "eth"], SOL: ["solana", "sol"], XRP: ["xrp", "ripple"],
  BNB: ["binance coin", "bnb"], DOGE: ["dogecoin", "doge"], USDT: ["tether", "usdt"], USDC: ["usdc", "circle"],
  HYPE: ["hyperliquid"], TON: ["toncoin", "telegram wallet"], LINK: ["chainlink"], SUI: ["sui network"], AVAX: ["avalanche"],
};

interface Dict { node: string; type: Entity["type"]; name: string; re: RegExp }
let DICT: Dict[] | null = null;

function esc(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordRe(alias: string) {
  const a = alias.trim();
  return new RegExp(`(^|[^A-Za-z0-9$])${esc(a)}(?=$|[^A-Za-z0-9])`, "i");
}

function buildDict(): Dict[] {
  const d: Dict[] = [];
  const u = loadUniverse();
  for (const a of u.assets) {
    if (a.class === "equity") {
      // Case-sensitive ticker. Short tickers (T, V, C, F, GE, GM…) collide with ordinary words/abbreviations, so they only match with a $ prefix.
      const tickerRe = a.id.length <= 2
        ? new RegExp(`\\$${esc(a.id)}(?=$|[^A-Za-z0-9.])`)
        : new RegExp(`(^|[^A-Za-z0-9])\\$?${esc(a.id)}(?=$|[^A-Za-z0-9.])`);
      d.push({ node: `company:${a.id}`, type: "company", name: a.name, re: tickerRe });
      const base = a.name.replace(/\s*\((ADR|MicroStrategy)\)\s*/i, "").replace(/\s+(Inc|Corp|Holdings|Platforms|Technologies|Entertainment|US|B|A)\.?$/i, "");
      if (base.length >= 4) d.push({ node: `company:${a.id}`, type: "company", name: a.name, re: wordRe(base) });
    }
  }
  for (const [id, aliases] of Object.entries(CRYPTO_ALIASES)) for (const al of aliases) d.push({ node: `asset:${id}`, type: "asset", name: id, re: al.length <= 4 ? new RegExp(`(^|[^A-Za-z0-9])\\$?${esc(al.toUpperCase())}(?=$|[^A-Za-z0-9])`) : wordRe(al) });
  for (const [id, aliases] of Object.entries(COUNTRY_ALIASES)) for (const al of aliases) d.push({ node: `country:${id}`, type: "country", name: id, re: wordRe(al) });
  for (const [id, aliases] of Object.entries(REGULATOR_ALIASES)) for (const al of aliases) d.push({ node: `regulator:${id}`, type: "regulator", name: id, re: wordRe(al) });
  for (const [id, aliases] of Object.entries(COMMODITY_ALIASES)) for (const al of aliases) d.push({ node: `commodity:${id}`, type: "commodity", name: id, re: wordRe(al) });
  for (const [id, aliases] of Object.entries(THEME_ALIASES)) for (const al of aliases) d.push({ node: `theme:${id}`, type: "sector", name: `theme:${id}`, re: wordRe(al) });
  return d;
}

export function invalidateDict() { DICT = null; }

/** Extract entities from text. Returns unique nodes with a crude confidence (more hits → higher). */
export function linkEntities(text: string, pre: Entity[] = []): Entity[] {
  DICT ??= buildDict();
  const hits = new Map<string, Entity>();
  for (const e of pre) hits.set(e.id, e);
  for (const d of DICT) {
    if (hits.has(d.node)) continue;
    if (d.re.test(text)) hits.set(d.node, { type: d.type, id: d.node, name: d.name, confidence: 0.7 });
  }
  return [...hits.values()];
}

/** SEC CIK → company entity */
export function entityFromCik(cik: string): Entity | undefined {
  const a = assetByCik(cik);
  return a ? { type: "company", id: `company:${a.id}`, name: a.name, confidence: 1 } : undefined;
}

/** Geo → facility entities within radius. */
export function entitiesFromGeo(lat: number, lng: number, radiusKm: number, country?: string): Entity[] {
  const out: Entity[] = facilitiesNear(lat, lng, radiusKm).map(({ f, km }) => ({
    type: "facility" as const, id: `facility:${f.id}`, name: `${f.name} (${km.toFixed(0)} km)`,
    confidence: Math.max(0.2, 1 - km / radiusKm),
  }));
  if (country) out.push({ type: "country", id: `country:${country}`, name: country, confidence: 0.8 });
  return out;
}
