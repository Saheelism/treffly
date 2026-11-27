// Builds Treffly's station-to-station travel-time tables from an unzipped GTFS feed.
// Usage: node pipeline/build.mjs <gtfs-dir> <out-dir>
// Output: <out-dir>/network.json (stations, bus stops, metadata), <out-dir>/tt-<slot>.bin (Uint8 minutes, 255 = unreachable),
// <out-dir>/fd-<slot>.bin (bus stop -> nearest stations), paths/<slot>/<hub>.json and paths/<slot>/s<chunk>.json (routes)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const [, , GTFS_DIR = 'gtfs', OUT_DIR = 'public/data'] = process.argv;

// ---------- settings ----------
// Hubs (meeting stations and walk-in points): rail, S-Bahn, U-Bahn and tram stations in this box.
const HUB_BOX = { minLat: 47.98, maxLat: 48.28, minLon: 11.36, maxLon: 11.80 };
// Connections are kept inside a larger box so routes may pass just outside the city.
const NET_BOX = { minLat: 47.85, maxLat: 48.40, minLon: 11.15, maxLon: 12.00 };
const WALK_M_PER_MIN = 75; // about 4.5 km/h
const WALK_DETOUR = 1.25; // street network vs straight line
const MAX_FOOTPATH_M = 600; // walking links between nearby stations
const TRANSFER_MIN = 2; // minimum time to change vehicles
const MAX_TRIP_MIN = 120;
// Time slots: 3 kinds of day x 5 times. Each slot averages departures over one hour.
const DAYS = [{ id: 'weekday', dow: 3 }, { id: 'saturday', dow: 6 }, { id: 'sunday', dow: 0 }];
const TIMES = [{ id: 'morning', start: 8 * 60 }, { id: 'midday', start: 12 * 60 }, { id: 'afternoon', start: 15 * 60 }, { id: 'evening', start: 18 * 60 }, { id: 'night', start: 21 * 60 }];
const SLOTS = DAYS.flatMap((d) => TIMES.map((t) => ({ id: `${d.id}-${t.id}`, day: d.id, time: t.id, dow: d.dow, start: t.start, window: 60, step: 10 })));

// ---------- helpers ----------
async function readCsv(file, onRow) {
  const p = path.join(GTFS_DIR, file);
  if (!fs.existsSync(p)) return false;
  const rl = readline.createInterface({ input: fs.createReadStream(p), crlfDelay: Infinity });
  let header = null;
  for await (let line of rl) {
    if (!header) {
      header = parseLine(line.replace(/^﻿/, '')).map((h) => h.trim());
      continue;
    }
    if (!line) continue;
    const vals = parseLine(line);
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = vals[i] ?? '';
    onRow(row);
  }
  return true;
}
function parseLine(line) {
  if (line.indexOf('"') === -1) return line.split(',');
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const toMin = (t) => {
  if (!t) return NaN;
  const [h, m, s] = t.trim().split(':').map(Number);
  return h * 60 + m + (s || 0) / 60;
};
const inBox = (b, lat, lon) => lat >= b.minLat && lat <= b.maxLat && lon >= b.minLon && lon <= b.maxLon;
function distM(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
// Display names: drop the city prefix the feed uses ("München, X", "München-Pasing") and spell out the big stations.
const RENAME = { hbf: 'Hauptbahnhof', ost: 'Ostbahnhof' };
function cleanName(n) {
  const s = n.trim().replace(/\s+/g, ' ');
  const rest = s.replace(/^München(?:[,\s-]+|$)/, '');
  if (!rest || rest === s) return s;
  return RENAME[rest.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()] || rest;
}
const normName = (n) => n.toLowerCase().replace(/\s*\(.*?\)\s*/g, ' ').replace(/[^a-z0-9äöüß]+/g, ' ').trim();
function modeOf(routeType) {
  const t = Number(routeType);
  if (t === 1 || (t >= 400 && t < 500)) return 'U';
  if (t === 0 || (t >= 900 && t < 1000)) return 'T';
  if (t === 2 || (t >= 100 && t < 200)) return 'S';
  return 'B';
}

// ---------- 1. stops -> stations ----------
console.log('Reading stops');
const stops = new Map();
await readCsv('stops.txt', (r) => {
  stops.set(r.stop_id, { id: r.stop_id, name: cleanName(r.stop_name), lat: +r.stop_lat, lon: +r.stop_lon, parent: r.parent_station || '', type: r.location_type || '0' });
});
// group: parent station if present, else the stop itself
const groupOf = new Map();
for (const s of stops.values()) groupOf.set(s.id, s.parent && stops.has(s.parent) ? s.parent : s.id);
// merge groups with the same name within 400 m (feeds without parent stations)
const groups = new Map();
for (const s of stops.values()) {
  const g = groupOf.get(s.id);
  if (!groups.has(g)) groups.set(g, []);
  groups.get(g).push(s);
}
const byName = new Map();
const canon = new Map();
for (const [g, members] of groups) {
  const lat = members.reduce((a, m) => a + m.lat, 0) / members.length;
  const lon = members.reduce((a, m) => a + m.lon, 0) / members.length;
  const nm = normName((stops.get(g) || members[0]).name);
  const cands = byName.get(nm) || [];
  const hit = cands.find((c) => distM(c.lat, c.lon, lat, lon) < 400);
  if (hit) canon.set(g, hit.g);
  else { cands.push({ g, lat, lon }); byName.set(nm, cands); canon.set(g, g); }
}
const stationOfStop = (id) => canon.get(groupOf.get(id));
const stationInfo = new Map(); // station key -> {name, lats, lons}
for (const s of stops.values()) {
  const k = stationOfStop(s.id);
  if (!stationInfo.has(k)) stationInfo.set(k, { key: k, name: (stops.get(k) || s).name, latS: 0, lonS: 0, n: 0, modes: new Set() });
  if (s.type === '1') continue;
  const st = stationInfo.get(k);
  st.latS += s.lat; st.lonS += s.lon; st.n++;
}
for (const st of stationInfo.values()) {
  if (st.n) { st.lat = st.latS / st.n; st.lon = st.lonS / st.n; }
  else { const s = stops.get(st.key); st.lat = s.lat; st.lon = s.lon; }
}

// ---------- 2. services ----------
console.log('Reading calendars');
const cal = [];
await readCsv('calendar.txt', (r) => cal.push(r));
const calDates = [];
await readCsv('calendar_dates.txt', (r) => calDates.push(r));
let feedStart = '99999999', feedEnd = '00000000';
for (const c of cal) { if (c.start_date < feedStart) feedStart = c.start_date; if (c.end_date > feedEnd) feedEnd = c.end_date; }
for (const c of calDates) { if (c.date < feedStart) feedStart = c.date; if (c.date > feedEnd) feedEnd = c.date; }
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function pickDate(dow) {
  // first matching weekday from max(today, feed start), skipping German public holidays roughly by service count check later
  const startStr = ymd(new Date()) > feedStart ? ymd(new Date()) : feedStart;
  const d = new Date(Date.UTC(+startStr.slice(0, 4), +startStr.slice(4, 6) - 1, +startStr.slice(6, 8)));
  const out = [];
  for (let i = 0; i < 60 && out.length < 4; i++) {
    const dd = new Date(d.getTime() + i * 86400000);
    if (dd.getUTCDay() === dow && ymd(dd) <= feedEnd) out.push(ymd(dd));
  }
  return out;
}
function activeServices(date) {
  const dow = dayNames[new Date(Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8))).getUTCDay()];
  const set = new Set();
  for (const c of cal) if (c.start_date <= date && c.end_date >= date && c[dow] === '1') set.add(c.service_id);
  for (const c of calDates) if (c.date === date) { if (c.exception_type === '1') set.add(c.service_id); else set.delete(c.service_id); }
  return set;
}

console.log('Reading routes and trips');
const routeMode = new Map();
const routeInfo = new Map(); // route_id -> {name, mode, color}
await readCsv('routes.txt', (r) => {
  const mode = modeOf(r.route_type);
  routeMode.set(r.route_id, mode);
  const name = (r.route_short_name || r.route_long_name || '').trim();
  routeInfo.set(r.route_id, { name, mode, color: r.route_color ? '#' + r.route_color.replace('#', '') : '' });
});
// Line colours used when the feed has none (the usual Munich line colours).
const LINE_COLORS = { U1: '#52822f', U2: '#c20831', U3: '#ec6726', U4: '#00a984', U5: '#bc7a00', U6: '#0065ae', U7: '#52822f', U8: '#c20831', S1: '#16c0e9', S2: '#71bf44', S3: '#7b107d', S4: '#ee1c25', S6: '#008a51', S7: '#963833', S8: '#1f1f1f', S20: '#f05a73' };
const MODE_COLORS = { U: '#0065ae', S: '#408335', T: '#d82020', B: '#00586a' };
const routeIdx = new Map(); // route_id -> compact index (only routes used in paths are exported)
const routeList = [];
function routeNum(id) {
  let n = routeIdx.get(id);
  if (n === undefined) {
    n = routeList.length; routeIdx.set(id, n);
    const ri = routeInfo.get(id) || { name: '', mode: 'B', color: '' };
    const bad = !ri.color || ri.color === '#' || /^#(ffffff|000000)$/i.test(ri.color);
    routeList.push([ri.name, ri.mode, bad ? LINE_COLORS[ri.name] || MODE_COLORS[ri.mode] : ri.color]);
  }
  return n;
}
const trips = new Map();
await readCsv('trips.txt', (r) => trips.set(r.trip_id, { route: r.route_id, service: r.service_id }));

// choose the date per slot with the most active trips among candidates (avoids holidays)
const dateForDow = new Map();
const slotDates = SLOTS.map((s) => {
  if (dateForDow.has(s.dow)) { const d = dateForDow.get(s.dow); return { ...s, date: d.date, services: d.services }; }
  const cands = pickDate(s.dow);
  let best = null, bestN = -1;
  for (const d of cands) {
    const act = activeServices(d);
    let n = 0;
    for (const t of trips.values()) if (act.has(t.service)) n++;
    if (n > bestN) { bestN = n; best = d; }
  }
  const services = activeServices(best);
  dateForDow.set(s.dow, { date: best, services });
  return { ...s, date: best, services };
});
for (const s of slotDates) console.log(`Slot ${s.id}: ${s.date}`);

// ---------- 3. stop_times -> connections per slot ----------
console.log('Reading stop_times (this takes a while)');
const neededTrip = new Map(); // trip_id -> slot bitmask
for (const [id, t] of trips) {
  let mask = 0;
  slotDates.forEach((s, i) => { if (s.services.has(t.service)) mask |= 1 << i; });
  if (mask) neededTrip.set(id, mask);
}
const stIndex = new Map(); // station key -> int (all stations in NET_BOX that see service)
const stList = [];
const idxOf = (k) => {
  let i = stIndex.get(k);
  if (i === undefined) { i = stList.length; stIndex.set(k, i); stList.push(stationInfo.get(k)); }
  return i;
};
const conns = slotDates.map(() => []);
const tripSeq = []; // trip number -> station indices in order
const tripRoute = []; // trip number -> compact route index
let lastTrip = null, last = null;
await readCsv('stop_times.txt', (r) => {
  const mask = neededTrip.get(r.trip_id);
  if (!mask) { lastTrip = null; return; }
  const sk = stationOfStop(r.stop_id);
  const info = stationInfo.get(sk);
  const cur = { trip: r.trip_id, seq: +r.stop_sequence, st: sk, arr: toMin(r.arrival_time || r.departure_time), dep: toMin(r.departure_time || r.arrival_time), ok: info && inBox(NET_BOX, info.lat, info.lon) };
  if (info) info.modes.add(routeMode.get(trips.get(r.trip_id).route) || 'B');
  if (lastTrip === r.trip_id && last && cur.seq > last.seq && last.ok && cur.ok && last.st !== cur.st) {
    const a = idxOf(last.st), b = idxOf(cur.st);
    slotDates.forEach((s, i) => {
      if (!(mask & (1 << i))) return;
      if (last.dep < s.start - 5 || last.dep > s.start + s.window + MAX_TRIP_MIN) return;
      conns[i].push(last.dep, cur.arr, a, b, tripNum(r.trip_id));
    });
    const tn = tripNum(r.trip_id);
    if (!tripSeq[tn]) { tripSeq[tn] = [a]; tripRoute[tn] = routeNum(trips.get(r.trip_id).route); }
    const seq = tripSeq[tn];
    if (seq[seq.length - 1] !== a) seq.push(a);
    seq.push(b);
  }
  lastTrip = r.trip_id; last = cur;
});
// note: assumes stop_times rows are grouped by trip and ordered by sequence (true for MVV); unordered rows are skipped safely
var _tripIds; function tripNum(id) { _tripIds ??= new Map(); let n = _tripIds.get(id); if (n === undefined) { n = _tripIds.size; _tripIds.set(id, n); } return n; }

// ---------- 4. hubs and footpaths ----------
const N = stList.length;
const isHub = stList.map((s) => inBox(HUB_BOX, s.lat, s.lon) && [...s.modes].some((m) => m !== 'B'));
const hubIdx = [];
isHub.forEach((h, i) => { if (h) hubIdx.push(i); });
console.log(`${N} stations in network, ${hubIdx.length} hubs`);
// Bus stops people can start from: every other served stop in the city box. They are not meeting points.
// A stop with the same name as a station within 300 m is left out (it is the same place).
const FEED_K = 8; // hubs stored per bus stop
const FEED_MAX_MIN = 40; // furthest bus ride we look at to reach a station
const FEED_CHUNK = 100; // bus stops per path file
const feederIdx = [];
stList.forEach((s, i) => {
  if (isHub[i] || !inBox(HUB_BOX, s.lat, s.lon)) return;
  const n = normName(s.name);
  if (hubIdx.some((h) => normName(stList[h].name) === n && distM(s.lat, s.lon, stList[h].lat, stList[h].lon) < 300)) return;
  feederIdx.push(i);
});
console.log(`${feederIdx.length} bus stops as starting points`);
// footpaths via grid
const cell = 0.006;
const grid = new Map();
stList.forEach((s, i) => { const k = `${Math.floor(s.lat / cell)},${Math.floor(s.lon / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
const foot = Array.from({ length: N }, () => []);
stList.forEach((s, i) => {
  const gy = Math.floor(s.lat / cell), gx = Math.floor(s.lon / cell);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    for (const j of grid.get(`${gy + dy},${gx + dx}`) || []) {
      if (j === i) continue;
      const d = distM(s.lat, s.lon, stList[j].lat, stList[j].lon);
      if (d <= MAX_FOOTPATH_M) foot[i].push(j, Math.max(1, (d * WALK_DETOUR) / WALK_M_PER_MIN));
    }
  }
});

// ---------- 5. connection scan ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const H = hubIdx.length;
// Route geometry: only stations that appear in some path are exported, numbered compactly (hubs first).
const nodeMap = new Map();
const nodes = [];
const nodeOf = (i) => {
  let n = nodeMap.get(i);
  if (n === undefined) { n = nodes.length; nodeMap.set(i, n); const s = stList[i]; nodes.push([+s.lat.toFixed(5), +s.lon.toFixed(5), s.name]); }
  return n;
};
hubIdx.forEach((i) => nodeOf(i));
slotDates.forEach((slot, si) => {
  const raw = conns[si];
  const M = raw.length / 5;
  const order = new Uint32Array(M);
  for (let i = 0; i < M; i++) order[i] = i;
  order.sort((x, y) => raw[x * 5] - raw[y * 5]);
  const dep = new Float64Array(M), arr = new Float64Array(M), from = new Int32Array(M), to = new Int32Array(M), trip = new Int32Array(M);
  for (let k = 0; k < M; k++) { const o = order[k] * 5; dep[k] = raw[o]; arr[k] = raw[o + 1]; from[k] = raw[o + 2]; to[k] = raw[o + 3]; trip[k] = raw[o + 4]; }
  let maxTrip = 1;
  for (let k = 0; k < M; k++) if (trip[k] + 1 > maxTrip) maxTrip = trip[k] + 1;
  console.log(`Slot ${slot.id}: ${M} connections`);
  const ea = new Float64Array(N);
  const onTrip = new Uint8Array(maxTrip);
  const boardAt = new Int32Array(maxTrip); // station where each trip was boarded
  const pFrom = new Int32Array(N), pTrip = new Int32Array(N); // parent station and trip (-1 = walk)
  const samples = [];
  for (let t = slot.start; t < slot.start + slot.window; t += slot.step) samples.push(t);
  const out = new Uint8Array(H * H).fill(255);
  // first connection index with dep >= t (binary search)
  const firstAt = (t) => { let lo = 0, hi = M; while (lo < hi) { const mid = (lo + hi) >> 1; if (dep[mid] < t) lo = mid + 1; else hi = mid; } return lo; };
  // Earliest arrival from src leaving at t0, scanning connections up to `limit`. Fills ea, pFrom, pTrip.
  function scan(src, t0, limit) {
    ea.fill(Infinity); onTrip.fill(0); pFrom.fill(-1); pTrip.fill(-1);
    ea[src] = t0;
    for (let f = 0; f < foot[src].length; f += 2) { const j = foot[src][f]; const w = t0 + foot[src][f + 1]; if (w < ea[j]) { ea[j] = w; pFrom[j] = src; pTrip[j] = -1; } }
    for (let k = firstAt(t0); k < M && dep[k] <= limit; k++) {
      const a = from[k];
      const tr = trip[k];
      if (onTrip[tr] || ea[a] + (a === src && ea[a] === t0 ? 0 : TRANSFER_MIN) <= dep[k]) {
        if (!onTrip[tr]) { onTrip[tr] = 1; boardAt[tr] = a; }
        const b = to[k];
        if (arr[k] < ea[b]) {
          ea[b] = arr[k]; pFrom[b] = boardAt[tr]; pTrip[b] = tr;
          const fp = foot[b];
          for (let f = 0; f < fp.length; f += 2) { const j = fp[f]; const w = arr[k] + fp[f + 1]; if (w < ea[j]) { ea[j] = w; pFrom[j] = b; pTrip[j] = -1; } }
        }
      }
    }
  }
  // Walk back from a target to the source and return legs: [route, station, station, ...] for rides, [-1, from, to] for walks.
  function tracePath(source, target, pF = pFrom, pT = pTrip) {
    const legs = [];
    let t = target, guard = 0;
    while (t !== source && t >= 0 && guard++ < 60) {
      const f = pF[t], tr = pT[t];
      if (f < 0) return [];
      if (tr < 0) legs.push([-1, f, t]);
      else {
        const seq = tripSeq[tr] || [f, t];
        const i0 = seq.indexOf(f), i1 = i0 >= 0 ? seq.indexOf(t, i0 + 1) : -1;
        legs.push([tripRoute[tr] ?? -1, ...(i0 >= 0 && i1 > i0 ? seq.slice(i0, i1 + 1) : [f, t])]);
      }
      t = f;
    }
    if (t !== source) return [];
    legs.reverse();
    const merged = []; // join back-to-back walks
    for (const l of legs) {
      const prev = merged[merged.length - 1];
      if (l[0] === -1 && prev && prev[0] === -1) prev[2] = l[2]; else merged.push(l);
    }
    return merged;
  }
  const compact = (legs) => legs.map(([r, ...st]) => [r, ...st.map(nodeOf)]);
  for (let hi = 0; hi < H; hi++) {
    const src = hubIdx[hi];
    const res = Array.from({ length: H }, () => []);
    const pathsBySample = Array.from({ length: H }, () => []);
    for (const t0 of samples) {
      scan(src, t0, t0 + MAX_TRIP_MIN);
      for (let hj = 0; hj < H; hj++) {
        const v = ea[hubIdx[hj]] - t0;
        res[hj].push(Number.isFinite(v) ? v : Infinity);
        pathsBySample[hj].push(Number.isFinite(v) && hj !== hi ? tracePath(src, hubIdx[hj]) : []);
      }
    }
    const srcPaths = [];
    for (let hj = 0; hj < H; hj++) {
      // median over departure times (includes waiting); keep the route of that same departure
      const order = res[hj].map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
      const [v, si2] = order[Math.floor(order.length / 2)];
      out[hi * H + hj] = hi === hj ? 0 : Number.isFinite(v) ? Math.min(254, Math.round(v)) : 255;
      srcPaths.push(pathsBySample[hj][si2]);
    }
    const dir = path.join(OUT_DIR, 'paths', slot.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${hi}.json`), JSON.stringify(srcPaths.map(compact)));
    if (hi % 50 === 0) console.log(`  ${hi}/${H}`);
  }
  fs.writeFileSync(path.join(OUT_DIR, `tt-${slot.id}.bin`), out);

  // 5b. bus stops: for each, the FEED_K hubs reached fastest (median over departures, incl. waiting) and the route there.
  // Output: fd-<slot>.bin = Uint16 hub index (65535 = none) for F*K entries, then Uint8 minutes for F*K entries.
  const F = feederIdx.length;
  const feedHub = new Uint16Array(F * FEED_K).fill(65535);
  const feedMin = new Uint8Array(F * FEED_K).fill(255);
  let chunk = [], noAccess = 0;
  const dir = path.join(OUT_DIR, 'paths', slot.id);
  for (let fi = 0; fi < F; fi++) {
    const src = feederIdx[fi];
    const res = Array.from({ length: H }, () => []);
    const saved = [];
    for (const t0 of samples) {
      scan(src, t0, t0 + FEED_MAX_MIN);
      saved.push([pFrom.slice(), pTrip.slice()]);
      for (let hj = 0; hj < H; hj++) res[hj].push(ea[hubIdx[hj]] - t0);
    }
    const best = [];
    for (let hj = 0; hj < H; hj++) {
      const order = res[hj].map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]);
      const [v, si2] = order[Math.floor(order.length / 2)];
      if (Number.isFinite(v)) best.push([v, si2, hj]);
    }
    best.sort((x, y) => x[0] - y[0]);
    const paths = [];
    best.slice(0, FEED_K).forEach(([v, si2, hj], k) => {
      feedHub[fi * FEED_K + k] = hj;
      feedMin[fi * FEED_K + k] = Math.min(254, Math.round(v));
      paths.push(compact(tracePath(src, hubIdx[hj], ...saved[si2])));
    });
    if (!best.length) noAccess++;
    chunk.push(paths);
    if (chunk.length === FEED_CHUNK || fi === F - 1) {
      fs.writeFileSync(path.join(dir, `s${Math.floor(fi / FEED_CHUNK)}.json`), JSON.stringify(chunk));
      chunk = [];
    }
  }
  const fd = new Uint8Array(F * FEED_K * 3);
  fd.set(new Uint8Array(feedHub.buffer), 0);
  fd.set(feedMin, F * FEED_K * 2);
  fs.writeFileSync(path.join(OUT_DIR, `fd-${slot.id}.bin`), fd);
  console.log(`Slot ${slot.id}: ${F} bus stops, ${noAccess} without a station within ${FEED_MAX_MIN} min`);
});

// ---------- 6. route geometry for the map ----------
fs.writeFileSync(path.join(OUT_DIR, 'geo.json'), JSON.stringify({ nodes, routes: routeList }));
console.log(`Paths written: ${nodes.length} nodes, ${routeList.length} routes`);

// ---------- 7. station list ----------
const stations = hubIdx.map((i) => {
  const s = stList[i];
  return { name: s.name, lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5), modes: [...s.modes].filter((m) => m !== 'B').sort().join('') };
});
let feedVersion = '';
await readCsv('feed_info.txt', (r) => { feedVersion = r.feed_version || r.feed_start_date || ''; });
fs.writeFileSync(path.join(OUT_DIR, 'network.json'), JSON.stringify({
  generated: new Date().toISOString(),
  source: 'Münchner Verkehrs- und Tarifverbund GmbH (MVV), GTFS-MVV-Gesamt',
  feedVersion,
  retrieved: new Date().toISOString().slice(0, 10),
  slots: slotDates.map((s) => ({ id: s.id, day: s.day, time: s.time, date: s.date })),
  walk: { mPerMin: WALK_M_PER_MIN, detour: WALK_DETOUR },
  stations,
  feedK: FEED_K,
  feedChunk: FEED_CHUNK,
  stops: feederIdx.map((i) => { const s = stList[i]; return { name: s.name, lat: +s.lat.toFixed(5), lon: +s.lon.toFixed(5) }; }),
}));
console.log('Done');
