// Sanity check for the built travel-time tables. Fails (exit 1) on clearly impossible data.
// Usage: node pipeline/check.mjs [data-dir]
// Prints times for well-known pairs, duplicate station names and per-slot statistics.

import fs from 'node:fs';
import path from 'node:path';

const DIR = process.argv[2] || 'public/data';
const net = JSON.parse(fs.readFileSync(path.join(DIR, 'network.json'), 'utf8'));
const st = net.stations;
const H = st.length;
const problems = []; // fail the build
const notes = []; // warnings only
const lines = [];
const say = (s = '') => { console.log(s); lines.push(s); };

function distM(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const norm = (n) => n.toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/^muenchen[,\s-]+/, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Known places with the names the feed may use (first match wins) and a rough position to pick the right one.
const PLACES = {
  marienplatz: { names: ['marienplatz'], lat: 48.1372, lon: 11.5755 },
  hbf: { names: ['hauptbahnhof', 'hbf', 'muenchen hbf'], lat: 48.1402, lon: 11.5600 },
  studentenstadt: { names: ['studentenstadt'], lat: 48.1823, lon: 11.6085 },
  pasing: { names: ['pasing', 'muenchen pasing'], lat: 48.1497, lon: 11.4613 },
  ost: { names: ['ostbahnhof', 'ost', 'muenchen ost'], lat: 48.1272, lon: 11.6050 },
  garching: { names: ['garching', 'garching u', 'garching hochbrueck'], lat: 48.2496, lon: 11.6511 },
  sendlinger: { names: ['sendlinger tor'], lat: 48.1340, lon: 11.5670 },
};
// Expected weekday-evening minutes (door to door, incl. waiting): [min, max] counted as plausible.
const PAIRS = [
  ['marienplatz', 'hbf', 3, 18, 'about 8'],
  ['studentenstadt', 'marienplatz', 6, 25, 'about 12'],
  ['pasing', 'ost', 10, 35, 'about 19'],
  ['garching', 'sendlinger', 15, 50, 'about 28'],
];

function find(key) {
  const p = PLACES[key];
  const near = st.map((s, i) => ({ i, s, d: distM(s, p), n: norm(s.name) })).filter((x) => x.d < 1500);
  for (const want of p.names) {
    const hit = near.filter((x) => x.n === want).sort((a, b) => a.d - b.d)[0];
    if (hit) return hit.i;
  }
  const loose = near.filter((x) => p.names.some((w) => x.n.includes(w))).sort((a, b) => a.d - b.d)[0];
  if (loose) return loose.i;
  const closest = near.sort((a, b) => a.d - b.d).slice(0, 3).map((x) => `${x.s.name} (${Math.round(x.d)} m)`);
  problems.push(`Station not found: ${key}. Nearest stations: ${closest.join(', ') || 'none within 1.5 km'}`);
  return -1;
}

say(`# Treffly data check`);
say(`${H} stations, feed ${net.feedVersion || '?'}, retrieved ${net.retrieved}`);
if (H < 150) problems.push(`Only ${H} stations; expected several hundred`);

const idx = Object.fromEntries(Object.keys(PLACES).map((k) => [k, find(k)]));
const tables = {};
for (const slot of net.slots) {
  const buf = fs.readFileSync(path.join(DIR, `tt-${slot.id}.bin`));
  if (buf.length !== H * H) problems.push(`tt-${slot.id}.bin has ${buf.length} bytes, expected ${H * H}`);
  tables[slot.id] = buf;
}
const tt = (slot, a, b) => tables[slot][a * H + b];
const fmt = (v) => (v === 255 ? 'unreachable' : `${v} min`);

// 1. known pairs
say('\n## Known pairs (weekday evening, both directions)');
const refSlot = net.slots.find((s) => s.id === 'weekday-evening')?.id || net.slots[0].id;
for (const [a, b, lo, hi, expect] of PAIRS) {
  const ia = idx[a], ib = idx[b];
  if (ia < 0 || ib < 0) continue;
  const there = tt(refSlot, ia, ib), back = tt(refSlot, ib, ia);
  say(`- ${st[ia].name} → ${st[ib].name}: ${fmt(there)}, back ${fmt(back)} (expected ${expect})`);
  for (const v of [there, back]) if (v < lo || v > hi) problems.push(`${st[ia].name} ↔ ${st[ib].name} is ${fmt(v)}, outside ${lo}–${hi} min`);
  // the same pair in every slot must stay reachable and below 120 min
  for (const s of net.slots) {
    const v = tt(s.id, ia, ib);
    if (v === 0 || v > 120) problems.push(`${st[ia].name} → ${st[ib].name} in ${s.id}: ${fmt(v)}`);
  }
}

// 2. per-slot statistics
say('\n## Slots');
say('| slot | date | unreachable | zero (>500 m apart) | median | max |');
say('|---|---|---|---|---|---|');
for (const s of net.slots) {
  const t = tables[s.id];
  let unreach = 0, zero = 0, over = 0;
  const vals = [];
  for (let a = 0; a < H; a++) for (let b = 0; b < H; b++) {
    if (a === b) continue;
    const v = t[a * H + b];
    if (v === 255) { unreach++; continue; }
    vals.push(v);
    if (v > 120) over++;
    if (v === 0 && distM(st[a], st[b]) > 500) zero++;
  }
  vals.sort((x, y) => x - y);
  const pairs = H * (H - 1);
  const share = unreach / pairs;
  say(`| ${s.id} | ${s.date} | ${(share * 100).toFixed(1)} % | ${zero} | ${vals[vals.length >> 1] ?? '-'} | ${vals[vals.length - 1] ?? '-'} |`);
  if (zero > 0) problems.push(`${s.id}: ${zero} pairs of stations more than 500 m apart have 0 min`);
  if (share > 0.1) problems.push(`${s.id}: ${(share * 100).toFixed(1)} % of pairs unreachable (limit 10 %)`);
  else if (share > 0.02) notes.push(`${s.id}: ${(share * 100).toFixed(1)} % of pairs unreachable`);
  if (over > 0) notes.push(`${s.id}: ${over} pairs over 120 min`);
}

// 3. duplicate names (should be one station each unless really far apart)
const byName = new Map();
st.forEach((s, i) => { const n = norm(s.name); if (!byName.has(n)) byName.set(n, []); byName.get(n).push(i); });
const dups = [...byName.values()].filter((g) => g.length > 1);
say(`\n## Duplicate station names: ${dups.length}`);
for (const g of dups.slice(0, 30)) {
  const far = Math.max(...g.map((i) => distM(st[i], st[g[0]])));
  say(`- ${st[g[0]].name}: ${g.length} entries, up to ${Math.round(far)} m apart`);
  if (far < 400) notes.push(`Duplicate station "${st[g[0]].name}" (${g.length} entries within ${Math.round(far)} m)`);
}

// 4. bus stops (starting points only): every stop should reach some station in every slot
const stops = net.stops || [];
const K = net.feedK || 0;
say(`\n## Bus stops: ${stops.length}`);
if (stops.length && K) {
  for (const s of net.slots) {
    const file = path.join(DIR, `fd-${s.id}.bin`);
    if (!fs.existsSync(file)) { problems.push(`fd-${s.id}.bin is missing`); continue; }
    const buf = fs.readFileSync(file);
    if (buf.length !== stops.length * K * 3) { problems.push(`fd-${s.id}.bin has ${buf.length} bytes, expected ${stops.length * K * 3}`); continue; }
    let none = 0, bad = 0, firstSum = 0;
    for (let f = 0; f < stops.length; f++) {
      const h = buf.readUInt16LE(f * K * 2), m = buf[stops.length * K * 2 + f * K];
      if (h === 65535) { none++; continue; }
      if (h >= H) bad++;
      firstSum += m;
    }
    const share = none / stops.length;
    if (s.id === refSlot || share > 0.05) say(`- ${s.id}: ${(share * 100).toFixed(1)} % without a station, average ${(firstSum / Math.max(1, stops.length - none)).toFixed(1)} min to the nearest one`);
    if (bad) problems.push(`${s.id}: ${bad} bus stops point to a station that does not exist`);
    if (share > 0.2) problems.push(`${s.id}: ${(share * 100).toFixed(1)} % of bus stops reach no station within the limit`);
    else if (share > 0.05) notes.push(`${s.id}: ${(share * 100).toFixed(1)} % of bus stops reach no station`);
  }
}

say(`\n## Result: ${problems.length ? 'FAILED' : 'OK'}`);
for (const p of problems) say(`- ❌ ${p}`);
for (const n of notes) say(`- ⚠️ ${n}`);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
process.exit(problems.length ? 1 : 0);
