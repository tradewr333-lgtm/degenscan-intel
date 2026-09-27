import type { Connector } from "../base.js";
import { rssConnector, src, clamp, has } from "../base.js";
import { fetchJson } from "../http.js";
import type { RawEvent } from "../../schema.js";

/** USGS — all M≥2.5 in the last hour, GeoJSON. Primary, keyless. */
export const usgs: Connector = {
  id: "usgs", name: "USGS Earthquakes", tier: "primary", cadence_s: 60,
  url: "https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php",
  async run() {
    const g = await fetchJson<any>("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_hour.geojson");
    return (g.features ?? []).map((f: any): RawEvent | null => {
      const mag = Number(f.properties.mag);
      if (!(mag >= 4.5)) return null;                       // below 4.5 nothing tradable moves
      const [lng, lat, depth] = f.geometry.coordinates;
      const radius = Math.min(600, 30 * Math.pow(2, mag - 4.5)); // 4.5→30km, 6.5→120km, 7.5→240km
      return {
        native_id: f.id,
        ts_event: new Date(f.properties.time).toISOString(),
        source: src(usgs), kind: "nat.quake",
        title: `M${mag.toFixed(1)} earthquake — ${f.properties.place}`,
        summary: `Magnitude ${mag} at ${depth} km depth. ${f.properties.tsunami ? "Tsunami flag set. " : ""}${f.properties.alert ? `PAGER alert: ${f.properties.alert}.` : ""}`,
        geo: { lat, lng, radius_km: radius },
        severity: clamp((mag - 4.5) / 3.5),                  // 4.5→0, 8→1
        novelty: 0.8,
        raw_ref: f.properties.url,
        meta: { mag, depth, alert: f.properties.alert, tsunami: f.properties.tsunami },
      };
    }).filter(Boolean) as RawEvent[];
  },
};

/** GDACS — UN/EC disaster alerts (green/orange/red). */
export const gdacs = rssConnector(
  { id: "gdacs", name: "GDACS Disaster Alerts", tier: "primary", cadence_s: 900, url: "https://www.gdacs.org", feed: "https://www.gdacs.org/xml/rss.xml" },
  {
    kind: it => {
      const t = it.title.toLowerCase();
      if (t.includes("earthquake")) return null;             // USGS covers it faster
      if (t.includes("cyclone") || t.includes("hurricane") || t.includes("typhoon")) return "nat.storm";
      if (t.includes("flood")) return "nat.flood";
      if (t.includes("volcano")) return "nat.volcano";
      if (t.includes("fire")) return "nat.fire";
      return "nat.other";
    },
    severity: it => {
      const lvl = String((it.raw as any)["gdacs:alertlevel"] ?? "").toLowerCase();
      return lvl === "red" ? 0.9 : lvl === "orange" ? 0.55 : 0.2;
    },
    hints: it => [String((it.raw as any)["gdacs:country"] ?? "")],
  },
);

/** NASA EONET — open natural events (storms, wildfires, volcanoes) with geometry. */
export const eonet: Connector = {
  id: "eonet", name: "NASA EONET", tier: "primary", cadence_s: 900, url: "https://eonet.gsfc.nasa.gov/docs/v3",
  async run() {
    const r = await fetchJson<any>("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=2&limit=100");
    return (r.events ?? []).map((e: any): RawEvent | null => {
      const cat = String(e.categories?.[0]?.id ?? "");
      const kind = cat === "severeStorms" ? "nat.storm" : cat === "wildfires" ? "nat.fire" : cat === "volcanoes" ? "nat.volcano" : cat === "floods" ? "nat.flood" : null;
      if (!kind) return null;
      const last = e.geometry?.[e.geometry.length - 1];
      const coords = last?.coordinates;
      const geo = Array.isArray(coords) && typeof coords[0] === "number" ? { lat: coords[1], lng: coords[0], radius_km: kind === "nat.storm" ? 300 : 80 } : undefined;
      const mag = Number(last?.magnitudeValue ?? 0);
      return {
        native_id: e.id, ts_event: last?.date ?? new Date().toISOString(), source: src(eonet), kind,
        title: `${e.title} (${cat})`, summary: `${e.title}. ${last?.magnitudeValue ? `Magnitude ${last.magnitudeValue} ${last.magnitudeUnit ?? ""}.` : ""}`,
        geo, severity: kind === "nat.storm" ? clamp(mag / 130) : 0.35, novelty: 0.5, raw_ref: e.link ?? e.sources?.[0]?.url ?? "",
      };
    }).filter(Boolean) as RawEvent[];
  },
};

/** NOAA NHC — active tropical cyclones (Atlantic/Pacific). */
export const nhc: Connector = {
  id: "nhc", name: "NOAA National Hurricane Center", tier: "primary", cadence_s: 900, url: "https://www.nhc.noaa.gov",
  async run() {
    const r = await fetchJson<any>("https://www.nhc.noaa.gov/CurrentStorms.json");
    return (r.activeStorms ?? []).map((s: any): RawEvent => {
      const wind = Number(s.intensity ?? 0); // knots
      const isGulf = s.latitudeNumeric > 18 && s.latitudeNumeric < 31 && s.longitudeNumeric < -80 && s.longitudeNumeric > -98;
      return {
        native_id: `${s.id}-${s.lastUpdate}`, ts_event: new Date(s.lastUpdate).toISOString(), source: src(nhc), kind: "nat.storm",
        title: `${s.classification} ${s.name} — ${wind} kt, moving ${s.movementDir}° at ${s.movementSpeed} kt`,
        summary: `${s.classification} ${s.name} in the ${s.binNumber?.startsWith("AT") ? "Atlantic" : "Pacific"} basin. Intensity ${wind} kt, pressure ${s.pressure} mb.${isGulf ? " Track threatens US Gulf Coast energy/insurance exposure." : ""}`,
        geo: { lat: s.latitudeNumeric, lng: s.longitudeNumeric, radius_km: 350, country: isGulf ? "US-GULF" : undefined },
        entities: isGulf ? [{ type: "country", id: "country:US-GULF", name: "US Gulf Coast", confidence: 0.9 }] : [],
        severity: clamp((wind - 34) / 100), novelty: 0.5, raw_ref: s.publicAdvisory?.url ?? "https://www.nhc.noaa.gov",
        meta: { wind_kt: wind, pressure_mb: s.pressure },
      };
    });
  },
};

/** NWS — extreme-severity alerts only (hurricane warnings, extreme cold → nat gas, etc). */
export const nws: Connector = {
  id: "nws", name: "NWS Active Alerts (Extreme)", tier: "primary", cadence_s: 300, url: "https://www.weather.gov/documentation/services-web-api",
  async run() {
    // The filter params are picky across API versions; pull all active alerts and filter client-side.
    const r = await fetchJson<any>("https://api.weather.gov/alerts/active", { headers: { accept: "application/geo+json" }, timeoutMs: 30_000 });
    return (r.features ?? []).filter((f: any) => f.properties?.severity === "Extreme" && f.properties?.status === "Actual").slice(0, 50).map((f: any): RawEvent => {
      const p = f.properties;
      const gulf = has(p.areaDesc, "Texas", "Louisiana", "Florida", "Mississippi", "Alabama");
      return {
        native_id: p.id, ts_event: p.sent ?? p.effective, source: src(nws), kind: has(p.event, "Hurricane", "Tropical") ? "nat.storm" : has(p.event, "Cold", "Freeze", "Winter") ? "nat.other" : "nat.other",
        title: `${p.event}: ${String(p.areaDesc).slice(0, 120)}`, summary: String(p.headline ?? p.description ?? "").slice(0, 500),
        entities: gulf ? [{ type: "country", id: "country:US-GULF", name: "US Gulf Coast", confidence: 0.7 }] : [],
        text_hints: [String(p.areaDesc)], severity: 0.5, novelty: 0.4, raw_ref: p["@id"] ?? "",
      };
    });
  },
};

/** NOAA SWPC — geomagnetic storm alerts (G4/G5 matter for satellites, grid). */
export const swpc: Connector = {
  id: "swpc", name: "NOAA Space Weather", tier: "primary", cadence_s: 300, url: "https://www.swpc.noaa.gov",
  async run() {
    const r = await fetchJson<any[]>("https://services.swpc.noaa.gov/products/alerts.json");
    return r.filter(a => /K-index of (8|9)|G4|G5|X\d+\.\d flare/i.test(a.message)).slice(0, 10).map((a): RawEvent => ({
      native_id: `${a.product_id}-${a.issue_datetime}`, ts_event: new Date(a.issue_datetime.replace(" ", "T") + "Z").toISOString(), source: src(swpc), kind: "nat.space_weather",
      title: a.message.split("\n").find((l: string) => /ALERT|WARNING|WATCH/.test(l)) ?? "Space weather alert", summary: a.message.slice(0, 500),
      severity: /G5|K-index of 9/.test(a.message) ? 0.9 : 0.5, novelty: 0.7, raw_ref: "https://www.swpc.noaa.gov/products/alerts-watches-and-warnings",
    }));
  },
};

export const NATURAL: Connector[] = [usgs, gdacs, eonet, nhc, nws, swpc];
