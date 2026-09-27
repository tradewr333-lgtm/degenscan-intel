import { EDGES, FACILITIES, type Edge, type Facility } from "./seed.js";
import { loadUniverse } from "../universe/index.js";

export interface Graph {
  out: Map<string, Edge[]>;
  in: Map<string, Edge[]>;
  edges: Edge[];
  facilities: Facility[];
}

let built: Graph | null = null;

/** Build graph = curated seed + edges derived from universe tags. Cached; call invalidateGraph() after universe refresh. */
export function getGraph(): Graph {
  if (built) return built;
  const edges: Edge[] = [...EDGES];
  const universe = loadUniverse();

  for (const a of universe.assets) {
    // company:X → asset:X (equities) so events linked to the company hit the tradable asset
    if (a.class === "equity") edges.push({ from: `company:${a.id}`, to: `asset:${a.id}`, type: "pegged", w: 1, sign: 1 });
    for (const tag of a.tags) {
      const [k, v] = tag.split(":");
      if (!v) continue;
      const target = a.class === "equity" ? `company:${a.id}` : `asset:${a.id}`;
      switch (k) {
        case "sector": edges.push({ from: `sector:${v}`, to: target, type: "sector_of", w: 0.5, sign: 1 }); break;
        case "hq": edges.push({ from: `country:${v}`, to: target, type: "located_in", w: 0.6, sign: 1 }); break;
        case "rev": edges.push({ from: `country:${v}`, to: target, type: "revenue_from", w: 0.25, sign: 1 }); break;
        case "input": edges.push({ from: `commodity:${v}`, to: target, type: "input", w: 0.4, sign: 1 }); break;
        case "reg": edges.push({ from: `regulator:${v}`, to: target, type: "regulated_by", w: 0.4, sign: 1 }); break;
        case "holds": edges.push({ from: `asset:${v}`, to: target, type: "holds", w: 0.5, sign: 1 }); break;
        case "index": edges.push({ from: `asset:${v}`, to: target, type: "pegged", w: 1, sign: 1 }); break;
        case "theme": edges.push({ from: `theme:${v}`, to: target, type: "exposed_to", w: 0.4, sign: 1 }); break;
        case "geo": edges.push({ from: `country:${v}`, to: target, type: "exposed_to", w: 0.4, sign: -1 }); break;
      }
    }
  }
  // facility → company
  for (const f of FACILITIES) {
    const target = universe.assets.find(a => a.id === f.company && a.class === "equity") ? `company:${f.company}`
      : universe.assets.find(a => a.id === f.company) ? `asset:${f.company}` : `company:${f.company}`;
    edges.push({ from: `facility:${f.id}`, to: target, type: "operates", w: f.critical, sign: 1 });
    edges.push({ from: `facility:${f.id}`, to: `country:${f.country}`, type: "located_in", w: 0.1, sign: 1 });
  }

  const out = new Map<string, Edge[]>(), inn = new Map<string, Edge[]>();
  const seen = new Set<string>();
  const dedup: Edge[] = [];
  for (const e of edges) {
    if (e.w <= 0) continue;
    const key = `${e.from}>${e.to}:${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key); dedup.push(e);
    (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
    (inn.get(e.to) ?? inn.set(e.to, []).get(e.to)!).push(e);
  }
  built = { out, in: inn, edges: dedup, facilities: FACILITIES };
  return built;
}

export function invalidateGraph() { built = null; }

/** Map a graph node id to a tradable asset id if it is one. */
export function nodeToAsset(node: string): string | undefined {
  const [type, id] = node.split(":");
  const u = loadUniverse();
  if (type === "asset" || type === "company" || type === "commodity") {
    return u.assets.find(a => a.id === id) ? id : undefined;
  }
  return undefined;
}

export interface Propagation { asset_id: string; weight: number; sign: 1 | -1; path: string[] }

/**
 * Propagate from a set of seed nodes along out-edges up to `depth`, multiplying weights and signs.
 * Returns the best (highest |weight|) path per tradable asset.
 */
export function propagate(seeds: { node: string; weight: number; sign: 1 | -1 }[], depth = 3, minWeight = 0.05): Propagation[] {
  const g = getGraph();
  const best = new Map<string, Propagation>();
  type Frontier = { node: string; weight: number; sign: 1 | -1; path: string[] };
  let frontier: Frontier[] = seeds.map(s => ({ node: s.node, weight: s.weight, sign: s.sign, path: [s.node] }));

  const consider = (f: Frontier) => {
    const asset = nodeToAsset(f.node);
    if (!asset) return;
    const prev = best.get(asset);
    if (!prev || Math.abs(f.weight) > Math.abs(prev.weight)) best.set(asset, { asset_id: asset, weight: f.weight, sign: f.sign, path: f.path });
  };
  frontier.forEach(consider);

  for (let d = 0; d < depth && frontier.length; d++) {
    const next: Frontier[] = [];
    for (const f of frontier) {
      for (const e of g.out.get(f.node) ?? []) {
        const w = f.weight * e.w;
        if (w < minWeight) continue;
        if (f.path.includes(e.to)) continue;
        const nf: Frontier = { node: e.to, weight: w, sign: (f.sign * e.sign) as 1 | -1, path: [...f.path, e.to] };
        consider(nf);
        next.push(nf);
      }
    }
    frontier = next;
  }
  return [...best.values()].sort((a, b) => b.weight - a.weight);
}

/** Sub-graph around an asset (both directions) for the exposure_graph tool. */
export function neighborhood(assetId: string, depth = 2) {
  const g = getGraph();
  const u = loadUniverse();
  const a = u.assets.find(x => x.id === assetId);
  const root = a?.class === "equity" ? `company:${assetId}` : a?.class === "commodity" ? `commodity:${assetId}` : `asset:${assetId}`;
  const nodes = new Set<string>([root, `asset:${assetId}`]);
  const edges: Edge[] = [];
  let frontier = [...nodes];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const e of [...(g.out.get(n) ?? []), ...(g.in.get(n) ?? [])]) {
        if (!edges.includes(e)) edges.push(e);
        for (const m of [e.from, e.to]) if (!nodes.has(m)) { nodes.add(m); next.push(m); }
      }
    }
    frontier = next;
  }
  return { root, nodes: [...nodes], edges, facilities: g.facilities.filter(f => nodes.has(`facility:${f.id}`)) };
}

/** Facilities within radius_km of a point. */
export function facilitiesNear(lat: number, lng: number, radiusKm: number) {
  return FACILITIES.map(f => ({ f, km: haversine(lat, lng, f.lat, f.lng) })).filter(x => x.km <= radiusKm).sort((a, b) => a.km - b.km);
}

export function haversine(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371, dLat = (lat2 - lat1) * Math.PI / 180, dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
