// Fair meeting point maths. Runs entirely in the browser.

export interface Station { name: string; lat: number; lon: number; modes: string }
export interface Network {
  generated: string; source: string; feedVersion: string; retrieved: string;
  slots: { id: string; day: string; time: string; date: string }[];
  walk: { mPerMin: number; detour: number };
  stations: Station[];
  /** Bus stops people can start from (not meeting points). Each has `feedK` entries in fd-<slot>.bin. */
  stops?: { name: string; lat: number; lon: number }[];
  feedK?: number;
  feedChunk?: number;
}
export type Place = { kind: 'station'; idx: number } | { kind: 'stop'; idx: number } | { kind: 'pin'; lat: number; lon: number };
/** Bus stop -> station table for one time slot: hub index (65535 = none) and minutes, `feedK` per stop. */
export interface Feed { hub: Uint16Array; min: Uint8Array; k: number }
/** One way to reach a station from a start point: walk there, or walk to a bus stop and ride (`stop`, entry `k`). */
export interface Access { idx: number; min: number; walk: number; stop?: number; k?: number }
export interface Person { id: number; name: string; place: Place | null; label: string }
export interface Result { idx: number; times: number[]; max: number; min: number; spread: number; total: number; score: number; withinCap: boolean }

const ACCESS_M = 1500; // furthest we let someone walk to their first station
const STOP_M = 600; // furthest we let someone walk to a bus stop

export function distM(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export class Planner {
  constructor(public net: Network, public tt: Uint8Array, public feed: Feed | null = null) {}
  get H() { return this.net.stations.length; }

  walkMin(m: number) { return (m * this.net.walk.detour) / this.net.walk.mPerMin; }

  coords(p: Place) {
    if (p.kind === 'station') return this.net.stations[p.idx];
    if (p.kind === 'stop') return this.net.stops![p.idx];
    return p;
  }

  /** Ways to reach the first station: walking to nearby stations, or walking to a bus stop and riding the bus. */
  access(p: Place): Access[] {
    const st = this.net.stations;
    const { lat, lon } = this.coords(p);
    const out: Access[] = [];
    for (let i = 0; i < st.length; i++) {
      const d = distM(lat, lon, st[i].lat, st[i].lon);
      if (d <= ACCESS_M) { const w = p.kind === 'station' && i === p.idx ? 0 : this.walkMin(d); out.push({ idx: i, min: w, walk: w }); }
    }
    out.sort((a, b) => a.walk - b.walk);
    const res = out.slice(0, 6);
    const f = this.feed, stops = this.net.stops;
    if (f && stops && p.kind !== 'station') {
      const near: { s: number; walk: number }[] = [];
      if (p.kind === 'stop') near.push({ s: p.idx, walk: 0 });
      else stops.forEach((s, i) => { const d = distM(lat, lon, s.lat, s.lon); if (d <= STOP_M) near.push({ s: i, walk: this.walkMin(d) }); });
      near.sort((a, b) => a.walk - b.walk);
      for (const n of near.slice(0, 3)) {
        for (let k = 0; k < f.k; k++) {
          const h = f.hub[n.s * f.k + k];
          if (h === 65535) break;
          res.push({ idx: h, min: n.walk + f.min[n.s * f.k + k], walk: n.walk, stop: n.s, k });
        }
      }
    }
    return res;
  }

  nearestStation(lat: number, lon: number) {
    let best = 0, bd = Infinity;
    this.net.stations.forEach((s, i) => { const d = distM(lat, lon, s.lat, s.lon); if (d < bd) { bd = d; best = i; } });
    return { idx: best, dist: bd };
  }

  /** Door-to-station minutes from a place to every station (Infinity if unreachable). */
  timesFrom(p: Place): Float64Array {
    const H = this.H;
    const res = new Float64Array(H).fill(Infinity);
    for (const a of this.access(p)) {
      for (let m = 0; m < H; m++) {
        const v = this.tt[a.idx * H + m];
        if (v === 255) continue;
        const t = a.min + v;
        if (t < res[m]) res[m] = t;
      }
      if (a.min < res[a.idx]) res[a.idx] = a.min; // the first station itself
    }
    return res;
  }

  /**
   * Rank meeting stations.
   * Rule: nobody travels longer than `cap` minutes; among those, prefer the shortest longest trip
   * while keeping trips as equal as possible (score = longest + 0.5 × gap between longest and shortest).
   * Results are spread out so the three suggestions are not neighbouring stops.
   */
  rank(places: Place[], cap: number, count = 3): Result[] {
    const per = places.map((p) => this.timesFrom(p));
    const all: Result[] = [];
    for (let m = 0; m < this.H; m++) {
      const times = per.map((r) => r[m]);
      if (times.some((t) => !Number.isFinite(t))) continue;
      const max = Math.max(...times), min = Math.min(...times);
      const total = times.reduce((a, b) => a + b, 0);
      all.push({ idx: m, times: times.map((t) => Math.round(t)), max: Math.round(max), min: Math.round(min), spread: Math.round(max - min), total: Math.round(total), score: max + 0.5 * (max - min) + 0.01 * total, withinCap: max <= cap + 0.49 });
    }
    all.sort((a, b) => (a.withinCap === b.withinCap ? a.score - b.score : a.withinCap ? -1 : 1));
    const st = this.net.stations;
    const picked: Result[] = [];
    for (const r of all) {
      if (picked.length >= count) break;
      if (picked.some((p) => distM(st[p.idx].lat, st[p.idx].lon, st[r.idx].lat, st[r.idx].lon) < 900)) continue;
      picked.push(r);
    }
    return picked;
  }
}
