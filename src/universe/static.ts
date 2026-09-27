import type { Asset, Session } from "../schema.js";

export const US_EQUITY_SESSION: Session = { tz: "America/New_York", open: "09:30", close: "16:00", days: [1, 2, 3, 4, 5] };
export const US_EXTENDED_SESSION: Session = { tz: "America/New_York", open: "04:00", close: "20:00", days: [1, 2, 3, 4, 5] };
export const CME_SESSION: Session = { tz: "America/Chicago", open: "17:00", close: "16:00", days: [0, 1, 2, 3, 4, 5] }; // Sun 17:00 → Fri 16:00, treated as near-24h
export const ALWAYS: Session = { tz: "UTC", open: "00:00", close: "24:00", days: [0, 1, 2, 3, 4, 5, 6], always: true };

const eq = (id: string, name: string, tags: string[], cik?: string): Asset => ({
  id, name, class: "equity", venue: "US", sessions: [US_EQUITY_SESSION], cik, tags,
});
const etf = (id: string, name: string, tags: string[]): Asset => ({
  id, name, class: "etf", venue: "US", sessions: [US_EQUITY_SESSION], tags,
});
const cx = (id: string, name: string, cg: string, tags: string[] = []): Asset => ({
  id, name, class: "crypto", venue: "crypto", sessions: [ALWAYS], coingecko_id: cg, tags: ["crypto", ...tags],
});
const cmd = (id: string, name: string, tags: string[]): Asset => ({
  id, name, class: "commodity", venue: "CME/ICE", sessions: [CME_SESSION], tags,
});
const fx = (id: string, name: string, tags: string[]): Asset => ({
  id, name, class: "fx", venue: "OTC", sessions: [CME_SESSION], tags,
});
const rate = (id: string, name: string, tags: string[]): Asset => ({
  id, name, class: "rate", venue: "UST", sessions: [CME_SESSION], tags,
});
const idx = (id: string, name: string, tags: string[]): Asset => ({
  id, name, class: "index", venue: "US", sessions: [CME_SESSION], tags,
});

/**
 * Seed equity universe: high-volume Wall Street names. Refreshed daily by universe/refresh.ts
 * (top-100 by 20d average volume), this list is the fallback and carries the curated tags.
 * Tags: sector:*, hq:CC, rev:CC (material revenue exposure), input:COMMODITY, reg:REGULATOR, theme:*
 */
export const SEED_EQUITIES: Asset[] = [
  eq("NVDA", "NVIDIA", ["sector:semis", "hq:US", "rev:CN", "rev:TW", "reg:BIS", "theme:ai"], "0001045810"),
  eq("TSLA", "Tesla", ["sector:autos", "hq:US", "rev:CN", "input:LITHIUM", "reg:NHTSA", "theme:ev"], "0001318605"),
  eq("AAPL", "Apple", ["sector:tech", "hq:US", "rev:CN", "rev:EU", "reg:FTC", "reg:EC", "theme:consumer"], "0000320193"),
  eq("MSFT", "Microsoft", ["sector:tech", "hq:US", "reg:FTC", "reg:EC", "theme:ai", "theme:cloud"], "0000789019"),
  eq("AMZN", "Amazon", ["sector:tech", "hq:US", "reg:FTC", "reg:EC", "theme:cloud", "theme:retail"], "0001018724"),
  eq("META", "Meta Platforms", ["sector:tech", "hq:US", "reg:FTC", "reg:EC", "theme:ai", "theme:ads"], "0001326801"),
  eq("GOOG", "Alphabet", ["sector:tech", "hq:US", "reg:DOJ", "reg:EC", "theme:ai", "theme:ads"], "0001652044"),
  eq("GOOGL", "Alphabet A", ["sector:tech", "hq:US", "reg:DOJ", "reg:EC", "theme:ai", "theme:ads"], "0001652044"),
  eq("AMD", "AMD", ["sector:semis", "hq:US", "rev:CN", "rev:TW", "reg:BIS", "theme:ai"], "0000002488"),
  eq("INTC", "Intel", ["sector:semis", "hq:US", "rev:CN", "theme:chips_act"], "0000050863"),
  eq("AVGO", "Broadcom", ["sector:semis", "hq:US", "rev:CN", "theme:ai"], "0001730168"),
  eq("TSM", "TSMC (ADR)", ["sector:semis", "hq:TW", "rev:US", "theme:ai", "theme:taiwan"], "0001046179"),
  eq("MU", "Micron", ["sector:semis", "hq:US", "rev:CN", "theme:ai"], "0000723125"),
  eq("QCOM", "Qualcomm", ["sector:semis", "hq:US", "rev:CN"], "0000804328"),
  eq("ARM", "Arm Holdings", ["sector:semis", "hq:GB", "theme:ai"], "0001973239"),
  eq("SMCI", "Super Micro", ["sector:hardware", "hq:US", "theme:ai"], "0001375365"),
  eq("PLTR", "Palantir", ["sector:software", "hq:US", "theme:ai", "theme:defense"], "0001321655"),
  eq("ORCL", "Oracle", ["sector:software", "hq:US", "theme:cloud", "theme:ai"], "0001341439"),
  eq("CRM", "Salesforce", ["sector:software", "hq:US"], "0001108524"),
  eq("NFLX", "Netflix", ["sector:media", "hq:US"], "0001065280"),
  eq("DIS", "Disney", ["sector:media", "hq:US"], "0001744489"),
  eq("UBER", "Uber", ["sector:tech", "hq:US", "theme:gig"], "0001543151"),
  eq("SHOP", "Shopify", ["sector:tech", "hq:CA"], "0001594805"),
  eq("SNOW", "Snowflake", ["sector:software", "hq:US", "theme:ai"], "0001640147"),
  eq("CRWD", "CrowdStrike", ["sector:cyber", "hq:US"], "0001535527"),
  eq("PANW", "Palo Alto Networks", ["sector:cyber", "hq:US"], "0001327567"),
  eq("COIN", "Coinbase", ["sector:crypto_proxy", "hq:US", "reg:SEC", "reg:CFTC", "theme:crypto"], "0001679788"),
  eq("MSTR", "Strategy (MicroStrategy)", ["sector:crypto_proxy", "hq:US", "theme:crypto", "holds:BTC"], "0001050446"),
  eq("HOOD", "Robinhood", ["sector:brokers", "hq:US", "reg:SEC", "theme:crypto", "theme:retail_flow"], "0001783879"),
  eq("MARA", "MARA Holdings", ["sector:crypto_proxy", "hq:US", "theme:btc_mining"], "0001507605"),
  eq("RIOT", "Riot Platforms", ["sector:crypto_proxy", "hq:US", "theme:btc_mining"], "0001167419"),
  eq("CLSK", "CleanSpark", ["sector:crypto_proxy", "hq:US", "theme:btc_mining"], "0000827876"),
  eq("JPM", "JPMorgan", ["sector:banks", "hq:US", "reg:FED", "reg:OCC"], "0000019617"),
  eq("BAC", "Bank of America", ["sector:banks", "hq:US", "reg:FED"], "0000070858"),
  eq("WFC", "Wells Fargo", ["sector:banks", "hq:US", "reg:FED"], "0000072971"),
  eq("C", "Citigroup", ["sector:banks", "hq:US", "reg:FED"], "0000831001"),
  eq("GS", "Goldman Sachs", ["sector:banks", "hq:US", "reg:FED"], "0000886982"),
  eq("MS", "Morgan Stanley", ["sector:banks", "hq:US", "reg:FED"], "0000895421"),
  eq("V", "Visa", ["sector:payments", "hq:US", "reg:DOJ"], "0001403161"),
  eq("MA", "Mastercard", ["sector:payments", "hq:US"], "0001141391"),
  eq("PYPL", "PayPal", ["sector:payments", "hq:US", "theme:stablecoin"], "0001633917"),
  eq("SOFI", "SoFi", ["sector:fintech", "hq:US"], "0001818874"),
  eq("BRK.B", "Berkshire Hathaway B", ["sector:conglomerate", "hq:US"], "0001067983"),
  eq("XOM", "ExxonMobil", ["sector:energy", "hq:US", "input:CL", "input:NG"], "0000034088"),
  eq("CVX", "Chevron", ["sector:energy", "hq:US", "input:CL"], "0000093410"),
  eq("OXY", "Occidental", ["sector:energy", "hq:US", "input:CL"], "0000797468"),
  eq("SLB", "SLB", ["sector:energy_services", "hq:US", "input:CL"], "0000087347"),
  eq("LLY", "Eli Lilly", ["sector:pharma", "hq:US", "reg:FDA", "theme:glp1"], "0000059478"),
  eq("PFE", "Pfizer", ["sector:pharma", "hq:US", "reg:FDA"], "0000078003"),
  eq("MRK", "Merck", ["sector:pharma", "hq:US", "reg:FDA"], "0000310158"),
  eq("JNJ", "Johnson & Johnson", ["sector:pharma", "hq:US", "reg:FDA"], "0000200406"),
  eq("NVO", "Novo Nordisk (ADR)", ["sector:pharma", "hq:DK", "reg:FDA", "theme:glp1"], "0000353278"),
  eq("UNH", "UnitedHealth", ["sector:health_insurance", "hq:US", "reg:CMS", "reg:DOJ"], "0000731766"),
  eq("ABBV", "AbbVie", ["sector:pharma", "hq:US", "reg:FDA"], "0001551152"),
  eq("MRNA", "Moderna", ["sector:biotech", "hq:US", "reg:FDA"], "0001682852"),
  eq("WMT", "Walmart", ["sector:retail", "hq:US", "rev:CN_imports", "theme:tariffs"], "0000104169"),
  eq("COST", "Costco", ["sector:retail", "hq:US"], "0000909832"),
  eq("TGT", "Target", ["sector:retail", "hq:US", "theme:tariffs"], "0000027419"),
  eq("HD", "Home Depot", ["sector:retail", "hq:US", "theme:housing", "theme:hurricane"], "0000354950"),
  eq("NKE", "Nike", ["sector:consumer", "hq:US", "rev:CN", "theme:tariffs"], "0000320187"),
  eq("SBUX", "Starbucks", ["sector:consumer", "hq:US", "rev:CN", "input:COFFEE"], "0000829224"),
  eq("MCD", "McDonald's", ["sector:consumer", "hq:US"], "0000063908"),
  eq("KO", "Coca-Cola", ["sector:staples", "hq:US"], "0000021344"),
  eq("PEP", "PepsiCo", ["sector:staples", "hq:US"], "0000077476"),
  eq("PG", "Procter & Gamble", ["sector:staples", "hq:US"], "0000080424"),
  eq("BA", "Boeing", ["sector:aerospace", "hq:US", "reg:FAA", "rev:CN"], "0000012927"),
  eq("LMT", "Lockheed Martin", ["sector:defense", "hq:US", "theme:defense"], "0000936468"),
  eq("RTX", "RTX", ["sector:defense", "hq:US", "theme:defense"], "0000101829"),
  eq("GE", "GE Aerospace", ["sector:aerospace", "hq:US"], "0000040545"),
  eq("CAT", "Caterpillar", ["sector:industrials", "hq:US", "rev:CN", "theme:tariffs"], "0000018230"),
  eq("DE", "Deere", ["sector:industrials", "hq:US", "theme:agri"], "0000315189"),
  eq("F", "Ford", ["sector:autos", "hq:US", "reg:NHTSA", "theme:tariffs", "rev:MX"], "0000037996"),
  eq("GM", "General Motors", ["sector:autos", "hq:US", "reg:NHTSA", "theme:tariffs", "rev:MX", "rev:CN"], "0001467858"),
  eq("RIVN", "Rivian", ["sector:autos", "hq:US", "theme:ev"], "0001874178"),
  eq("NIO", "NIO (ADR)", ["sector:autos", "hq:CN", "theme:ev", "theme:china_adr"], "0001736541"),
  eq("BABA", "Alibaba (ADR)", ["sector:tech", "hq:CN", "theme:china_adr"], "0001577552"),
  eq("PDD", "PDD Holdings (ADR)", ["sector:retail", "hq:CN", "theme:china_adr", "theme:tariffs"], "0001737806"),
  eq("AAL", "American Airlines", ["sector:airlines", "hq:US", "input:CL", "theme:hurricane"], "0000006201"),
  eq("DAL", "Delta Air Lines", ["sector:airlines", "hq:US", "input:CL"], "0000027904"),
  eq("UAL", "United Airlines", ["sector:airlines", "hq:US", "input:CL"], "0000100517"),
  eq("CCL", "Carnival", ["sector:travel", "hq:US", "input:CL", "theme:hurricane"], "0000815097"),
  eq("T", "AT&T", ["sector:telecom", "hq:US", "reg:FCC"], "0000732717"),
  eq("VZ", "Verizon", ["sector:telecom", "hq:US", "reg:FCC"], "0000732712"),
  eq("TMUS", "T-Mobile US", ["sector:telecom", "hq:US", "reg:FCC"], "0001283699"),
  eq("CMCSA", "Comcast", ["sector:media", "hq:US", "reg:FCC"], "0001166691"),
  eq("NEE", "NextEra Energy", ["sector:utilities", "hq:US", "theme:hurricane", "theme:rates"], "0000753308"),
  eq("VST", "Vistra", ["sector:utilities", "hq:US", "theme:ai_power", "input:NG"], "0001692819"),
  eq("CEG", "Constellation Energy", ["sector:utilities", "hq:US", "theme:ai_power", "theme:nuclear"], "0001868275"),
  eq("FCX", "Freeport-McMoRan", ["sector:mining", "hq:US", "input:HG", "rev:ID", "rev:PE"], "0000831259"),
  eq("NEM", "Newmont", ["sector:mining", "hq:US", "input:GC"], "0001164727"),
  eq("ALL", "Allstate", ["sector:insurance", "hq:US", "theme:hurricane", "theme:catastrophe"], "0000899051"),
  eq("TRV", "Travelers", ["sector:insurance", "hq:US", "theme:catastrophe"], "0000086312"),
  eq("PLUG", "Plug Power", ["sector:cleantech", "hq:US"], "0001093691"),
  eq("LCID", "Lucid", ["sector:autos", "hq:US", "theme:ev", "rev:SA"], "0001811210"),
  eq("GME", "GameStop", ["sector:retail", "hq:US", "theme:retail_flow", "holds:BTC"], "0001326380"),
  eq("AMC", "AMC Entertainment", ["sector:media", "hq:US", "theme:retail_flow"], "0001411579"),
  eq("SNAP", "Snap", ["sector:tech", "hq:US", "theme:ads"], "0001564408"),
  eq("PINS", "Pinterest", ["sector:tech", "hq:US", "theme:ads"], "0001506293"),
  eq("DELL", "Dell Technologies", ["sector:hardware", "hq:US", "theme:ai"], "0001571996"),
  eq("HPQ", "HP Inc", ["sector:hardware", "hq:US", "theme:tariffs"], "0000047217"),
  eq("CSCO", "Cisco", ["sector:networking", "hq:US"], "0000858877"),
  eq("IBM", "IBM", ["sector:tech", "hq:US", "theme:ai"], "0000051143"),
  eq("ADBE", "Adobe", ["sector:software", "hq:US", "theme:ai"], "0000796343"),
  eq("NOW", "ServiceNow", ["sector:software", "hq:US", "theme:ai"], "0001373715"),
  eq("SPOT", "Spotify", ["sector:media", "hq:SE"], "0001639920"),
  eq("ABNB", "Airbnb", ["sector:travel", "hq:US"], "0001559720"),
  eq("DASH", "DoorDash", ["sector:tech", "hq:US", "theme:gig"], "0001792789"),
  eq("RBLX", "Roblox", ["sector:gaming", "hq:US"], "0001315098"),
  eq("SQ", "Block", ["sector:payments", "hq:US", "theme:crypto", "holds:BTC"], "0001512673"),
];

export const SEED_ETFS: Asset[] = [
  etf("SPY", "S&P 500 ETF", ["index:SPX"]),
  etf("QQQ", "Nasdaq-100 ETF", ["index:NDX"]),
  etf("IWM", "Russell 2000 ETF", ["index:RUT"]),
  etf("DIA", "Dow ETF", ["index:DJI"]),
  etf("TLT", "20+Y Treasury ETF", ["rates:long"]),
  etf("HYG", "High Yield Corp Bond ETF", ["credit:hy"]),
  etf("GLD", "Gold ETF", ["input:GC"]),
  etf("SLV", "Silver ETF", ["input:SI"]),
  etf("USO", "Oil ETF", ["input:CL"]),
  etf("UNG", "Nat Gas ETF", ["input:NG"]),
  etf("XLE", "Energy Sector ETF", ["sector:energy", "input:CL"]),
  etf("XLF", "Financials ETF", ["sector:banks"]),
  etf("XLK", "Tech ETF", ["sector:tech"]),
  etf("SMH", "Semiconductor ETF", ["sector:semis", "theme:taiwan"]),
  etf("IBIT", "iShares Bitcoin Trust", ["holds:BTC", "theme:crypto"]),
  etf("ETHA", "iShares Ethereum Trust", ["holds:ETH", "theme:crypto"]),
];

export const SEED_INDICES: Asset[] = [
  idx("SPX", "S&P 500", []),
  idx("NDX", "Nasdaq 100", []),
  idx("VIX", "CBOE VIX", ["risk"]),
  idx("DJI", "Dow Jones", []),
];

export const SEED_CRYPTO: Asset[] = [
  cx("BTC", "Bitcoin", "bitcoin", ["l1", "store_of_value"]),
  cx("ETH", "Ethereum", "ethereum", ["l1", "defi"]),
  cx("SOL", "Solana", "solana", ["l1", "memecoins"]),
  cx("XRP", "XRP", "ripple", ["payments", "reg:SEC"]),
  cx("BNB", "BNB", "binancecoin", ["exchange:binance"]),
  cx("DOGE", "Dogecoin", "dogecoin", ["meme"]),
  cx("ADA", "Cardano", "cardano", ["l1"]),
  cx("TRX", "Tron", "tron", ["stablecoin_rails"]),
  cx("AVAX", "Avalanche", "avalanche-2", ["l1"]),
  cx("LINK", "Chainlink", "chainlink", ["oracle"]),
  cx("SUI", "Sui", "sui", ["l1"]),
  cx("HYPE", "Hyperliquid", "hyperliquid", ["perps_dex"]),
  cx("TON", "Toncoin", "the-open-network", ["telegram"]),
  cx("USDT", "Tether", "tether", ["stablecoin", "reg:GENIUS"]),
  cx("USDC", "USD Coin", "usd-coin", ["stablecoin", "reg:GENIUS"]),
];

export const SEED_COMMODITIES: Asset[] = [
  cmd("CL", "WTI Crude", ["energy", "geo:middle_east", "geo:hormuz"]),
  cmd("BZ", "Brent Crude", ["energy", "geo:middle_east"]),
  cmd("NG", "Henry Hub Nat Gas", ["energy", "weather"]),
  cmd("GC", "Gold", ["safe_haven", "rates"]),
  cmd("SI", "Silver", ["metals"]),
  cmd("HG", "Copper", ["metals", "china_demand"]),
  cmd("ZW", "Wheat", ["agri", "geo:black_sea"]),
  cmd("ZC", "Corn", ["agri"]),
  cmd("ZS", "Soybeans", ["agri", "rev:CN"]),
];

export const SEED_FX_RATES: Asset[] = [
  fx("DXY", "US Dollar Index", ["usd"]),
  fx("EURUSD", "EUR/USD", ["eur", "reg:ECB"]),
  fx("USDJPY", "USD/JPY", ["jpy", "reg:BOJ"]),
  fx("USDBRL", "USD/BRL", ["brl", "reg:BCB"]),
  fx("USDCNH", "USD/CNH", ["cny", "reg:PBOC"]),
  rate("US2Y", "US 2Y Treasury", ["front_end", "fed_path"]),
  rate("US10Y", "US 10Y Treasury", ["belly", "inflation"]),
  rate("US30Y", "US 30Y Treasury", ["long_end", "supply"]),
];

export const SEED_ASSETS: Asset[] = [
  ...SEED_EQUITIES, ...SEED_ETFS, ...SEED_INDICES, ...SEED_CRYPTO, ...SEED_COMMODITIES, ...SEED_FX_RATES,
];
