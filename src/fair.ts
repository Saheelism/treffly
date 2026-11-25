// Fair meeting point maths. Runs entirely in the browser.

export interface Station { name: string; lat: number; lon: number; modes: string }
export interface Network {
  generated: string; source: string; feedVersion: string; retrieved: string;
  slots: { id: string; day: string; time: string; date: string }[];
  walk: { mPerMin: number; detour: number };
  stations: Station[];
}
export type Place = { kind: 'station'; idx: number } | { kind: 'pin'; lat: number; lon: number };
export interface Person { id: number; name: string; place: Place | null; label: string }
export interface Result { idx: number; times: number[]; max: number; min: number; spread: number; total: number; score: number; withinCap: boolean }

const ACCESS_M = 1500; // furthest we let someone walk to their first station

export function distM(aLat: number, aLon: number, bLat: number, bLon: number) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

export class Planner {
  constructor(public net: Network, public tt: Uint8Array) {}
  get H() { return this.net.stations.length; }

  walkMin(m: number) { return (m * this.net.walk.detour) / this.net.walk.mPerMin; }

  /** Stations a person can walk to, with walking minutes. */
  access(p: Place): { idx: number; walk: number }[] {
    const st = this.net.stations;
    const lat = p.kind === 'station' ? st[p.idx].lat : p.lat;
    const lon = p.kind === 'station' ? st[p.idx].lon : p.lon;
    const out: { idx: number; walk: number }[] = [];
    for (let i = 0; i < st.length; i++) {
      const d = distM(lat, lon, st[i].lat, st[i].lon);
      if (d <= ACCESS_M) out.push({ idx: i, walk: p.kind === 'station' && i === p.idx ? 0 : this.walkMin(d) });
    }
    out.sort((a, b) => a.walk - b.walk);
    return out.slice(0, 6);
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
        const t = a.walk + v;
        if (t < res[m]) res[m] = t;
      }
      if (a.walk < res[a.idx]) res[a.idx] = a.walk; // walk straight there
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
