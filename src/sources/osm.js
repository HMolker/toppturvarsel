import { haversineKm } from '../util/utm.js';
import { log } from '../util/log.js';
import { overpass } from '../util/overpass.js';

/**
 * Tour routes derived from OpenStreetMap.
 *
 * WHAT THIS DOES — AND WHAT IT REFUSES TO DO
 * ------------------------------------------
 * It finds the tour's summit in OSM (a natural=peak whose name matches the
 * tour), then walks OSM's own mapped path network from that summit back to
 * the nearest place you could start: a road, a car park or a mountain hut.
 * The result is a real sequence of mapped path segments, not a drawn line.
 *
 * It never invents geometry. If no mapped path reaches within 600 m of the
 * summit, there is no track — the UI says so. It does not "helpfully" join
 * the end of a path to the summit with a straight line either: the last
 * few hundred metres to a Norwegian summit are exactly where a straight
 * line crosses a cornice or a cliff band. The gap is reported in metres.
 *
 * Most OSM paths in Norway and Sweden are SUMMER paths. A ski line often
 * differs (it follows snow-filled gullies and avoids boulder fields the path
 * uses). Routes built mostly from piste:type=skitour ways are labelled ski
 * routes; everything else is labelled a summer path. Neither is a
 * recommendation to ski it today; that is what the bulletin is for.
 *
 * Data © OpenStreetMap contributors, ODbL. Derived GPX carries the licence.
 */

const SEARCH_RADIUS_M = 7000;
const PEAK_RADIUS_M = 4000;
const SUMMIT_SNAP_M = 600;
const MAX_TRACK_M = 30000;

const WALKABLE = /^(path|footway|track|bridleway|steps)$/;
const ROAD = /^(trunk|primary|secondary|tertiary|unclassified|residential|service|living_street)$/;

export function overpassQuery(lat, lon, r = SEARCH_RADIUS_M) {
  const a = `(around:${r},${lat},${lon})`;
  return `[out:json][timeout:60];
(
  way${a}[highway~"^(path|footway|track|bridleway|steps)$"];
  way${a}["piste:type"="skitour"];
  way${a}[highway~"^(trunk|primary|secondary|tertiary|unclassified|residential|service|living_street)$"];
  node${a}[amenity=parking];
  node${a}[tourism~"^(alpine_hut|wilderness_hut)$"];
  node(around:${PEAK_RADIUS_M},${lat},${lon})[natural=peak];
);
out geom;`;
}

export async function fetchOsm(lat, lon) {
  return overpass(overpassQuery(lat, lon), { timeoutMs: 90000, what: 'routes' });
}

/* ------------------------------------------------------------------ *
 * pure helpers (tested)
 * ------------------------------------------------------------------ */

const distM = (a, b) => haversineKm(a.lat, a.lon, b.lat, b.lon) * 1000;
// Nodes are keyed by coordinate, not by OSM node id: two ways that share a
// node have bit-identical coordinates, and this works whether or not the
// response carries the node id array.
const key = (p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`;

export function normalizeName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "Njulla (Nuolja)" -> ["njulla nuolja", "njulla", "nuolja"]; longest first. */
export function nameCandidates(tourName) {
  const whole = normalizeName(tourName);
  const parts = String(tourName)
    .split(/[()\/&,–]| - /)
    .map(normalizeName)
    .filter((s) => s.length >= 4);
  return [...new Set([whole, ...parts])].sort((a, b) => b.length - a.length);
}

/**
 * Pick the OSM peak for a tour. Name match wins over proximity; a nameless
 * guess is only accepted very close to the tour's own coordinates.
 */
export function snapSummit(tour, peaks) {
  const cands = nameCandidates(tour.name);
  const scored = [];
  for (const p of peaks) {
    const names = [p.tags?.name, p.tags?.['name:no'], p.tags?.['name:sv'], p.tags?.['name:se'], p.tags?.alt_name]
      .filter(Boolean)
      .map(normalizeName);
    const d = distM(tour, p);
    let score = 0;
    for (const n of names) {
      for (const c of cands) {
        if (n === c) score = Math.max(score, 3);
        else if (n.length >= 4 && (c.includes(n) || n.includes(c))) score = Math.max(score, 2);
      }
    }
    if (score) scored.push({ p, d, score });
  }
  scored.sort((a, b) => b.score - a.score || a.d - b.d);
  const best = scored[0];
  if (best) return summitFrom(best.p, best.score === 3 ? 'osm-peak-name' : 'osm-peak-partial-name');

  const near = peaks
    .map((p) => ({ p, d: distM(tour, p) }))
    .filter((x) => x.d <= 800)
    .sort((a, b) => a.d - b.d)[0];
  if (near) return summitFrom(near.p, 'osm-peak-nearest');

  return { lat: tour.lat, lon: tour.lon, name: tour.name, ele: tour.summit_m ?? null, source: 'tour-coordinates' };
}

function summitFrom(p, source) {
  const ele = Number.parseFloat(String(p.tags?.ele ?? '').replace(',', '.'));
  return { lat: p.lat, lon: p.lon, name: p.tags?.name ?? null, ele: Number.isFinite(ele) ? ele : null, source };
}

/** Build the walkable graph plus the set of "you can start here" nodes. */
export function buildGraph(elements) {
  const adj = new Map();
  const coord = new Map();
  const roadKeys = new Set();
  const parking = [];
  const huts = [];
  const peaks = [];

  const addEdge = (a, b, w, kind) => {
    const ka = key(a), kb = key(b);
    coord.set(ka, a); coord.set(kb, b);
    if (!adj.has(ka)) adj.set(ka, []);
    if (!adj.has(kb)) adj.set(kb, []);
    adj.get(ka).push({ to: kb, w, len: w.len, kind });
    adj.get(kb).push({ to: ka, w, len: w.len, kind });
  };

  for (const el of elements) {
    if (el.type === 'node') {
      if (!Number.isFinite(el.lat) || !Number.isFinite(el.lon)) continue;
      const pt = { lat: el.lat, lon: el.lon, tags: el.tags ?? {} };
      if (el.tags?.natural === 'peak') peaks.push(pt);
      else if (el.tags?.amenity === 'parking') parking.push(pt);
      else if (/^(alpine_hut|wilderness_hut)$/.test(el.tags?.tourism ?? '')) huts.push(pt);
      continue;
    }
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const geom = el.geometry.filter((g) => g && Number.isFinite(g.lat) && Number.isFinite(g.lon));
    const hw = el.tags?.highway ?? '';
    const skitour = el.tags?.['piste:type'] === 'skitour';

    if (ROAD.test(hw) && !skitour) {
      for (const g of geom) roadKeys.add(key(g));
      continue;
    }
    if (!WALKABLE.test(hw) && !skitour) continue;

    const kind = skitour ? 'skitour' : hw === 'track' ? 'track' : 'path';
    // Prefer mapped ski routes; mildly discourage vehicle tracks.
    const factor = kind === 'skitour' ? 0.6 : kind === 'track' ? 1.15 : 1;
    for (let i = 1; i < geom.length; i++) {
      const len = distM(geom[i - 1], geom[i]);
      addEdge(geom[i - 1], geom[i], { cost: len * factor, len }, kind);
    }
  }

  const starts = new Map(); // key -> 'road' | 'parking' | 'hut'
  for (const k of adj.keys()) {
    if (roadKeys.has(k)) starts.set(k, 'road');
  }
  const markNear = (pts, radius, label) => {
    for (const p of pts) {
      for (const [k, c] of coord) {
        if (!starts.has(k) && distM(p, c) <= radius) starts.set(k, label);
      }
    }
  };
  markNear(parking, 80, 'parking');
  markNear(huts, 150, 'hut');

  return { adj, coord, starts, peaks };
}

/** Binary-heap Dijkstra from the summit node to the cheapest start node. */
export function shortestToStart(graph, fromKey) {
  const { adj, starts } = graph;
  const dist = new Map([[fromKey, 0]]);
  const prev = new Map();
  const heap = [[0, fromKey]];
  const push = (item) => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  while (heap.length) {
    const [d, k] = pop();
    if (d > (dist.get(k) ?? Infinity)) continue;
    if (starts.has(k) && k !== fromKey) {
      const path = [k];
      while (prev.has(path[path.length - 1])) path.push(prev.get(path[path.length - 1]).from);
      return { path, startType: starts.get(k), prev };
    }
    for (const e of adj.get(k) ?? []) {
      const nd = d + e.w.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, { from: k, kind: e.kind, len: e.w.len });
        push([nd, e.to]);
      }
    }
  }
  return null;
}

/**
 * elements (Overpass JSON) + tour -> route, or a reasoned "no route".
 * Route points run start -> summit, the way you would ski-tour it.
 */
export function routeFromOsm(elements, tour) {
  const graph = buildGraph(elements);
  const summit = snapSummit(tour, graph.peaks);

  let nearest = null;
  for (const [k, c] of graph.coord) {
    const d = distM(summit, c);
    if (!nearest || d < nearest.d) nearest = { k, d };
  }
  if (!nearest || nearest.d > SUMMIT_SNAP_M) {
    return {
      found: false,
      summit,
      reason: nearest
        ? `No mapped path comes within ${SUMMIT_SNAP_M} m of the summit (closest: ${Math.round(nearest.d)} m).`
        : 'No mapped paths in the area.',
    };
  }

  const res = shortestToStart(graph, nearest.k);
  if (!res) {
    return { found: false, summit, reason: 'The paths near the summit do not connect to a road, car park or hut.' };
  }

  // res.path runs start -> ... -> summit node (walked back from the start).
  const keys = res.path;
  const points = keys.map((k) => graph.coord.get(k));
  let lengthM = 0;
  const byKind = { skitour: 0, path: 0, track: 0 };
  for (let i = 1; i < keys.length; i++) {
    const step = res.prev.get(keys[i - 1]);
    const len = distM(points[i - 1], points[i]);
    lengthM += len;
    if (step) byKind[step.kind] = (byKind[step.kind] ?? 0) + len;
  }
  // `keys` goes start -> summit only if we walked prev pointers from start;
  // shortestToStart builds it from the start back towards the summit.
  const ordered = distM(points[0], summit) > distM(points[points.length - 1], summit) ? points : points.reverse();

  if (lengthM > MAX_TRACK_M) {
    return { found: false, summit, reason: `The nearest mapped approach is ${Math.round(lengthM / 1000)} km long; not shown as a tour line.` };
  }

  const skiShare = lengthM ? byKind.skitour / lengthM : 0;
  return {
    found: true,
    source: 'osm',
    kind: skiShare >= 0.5 ? 'ski-route' : 'summer-path',
    summit,
    startType: res.startType,
    endGapM: Math.round(nearest.d),
    lengthM: Math.round(lengthM),
    composition: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, Math.round(v)])),
    points: ordered.map((p) => ({ lat: p.lat, lon: p.lon })),
  };
}

export async function discoverRoute(tour) {
  const elements = await fetchOsm(tour.lat, tour.lon);
  const route = routeFromOsm(elements, tour);
  log.info(
    `osm: ${tour.name}: ${route.found ? `${route.kind}, ${(route.lengthM / 1000).toFixed(1)} km from ${route.startType}` : route.reason}`
  );
  return route;
}
