// Fetches cafés, bars and places to eat near each hub station from OpenStreetMap (Overpass API).
// Data © OpenStreetMap contributors, ODbL 1.0. The derived file venues.json is published under ODbL too.
// Usage: node pipeline/venues.mjs <out-dir>
import fs from 'node:fs';
import path from 'node:path';

const OUT_DIR = process.argv[2] || 'public/data';
const net = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'network.json'), 'utf8'));
const RADIUS = 400;
const PER_TYPE = 8;

let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
for (const s of net.stations) { minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat); minLon = Math.min(minLon, s.lon); maxLon = Math.max(maxLon, s.lon); }
const pad = 0.006;
const bbox = `${minLat - pad},${minLon - pad},${maxLat + pad},${maxLon + pad}`;
const query = `[out:json][timeout:180];(nwr["amenity"~"^(cafe|bar|pub|biergarten|restaurant|fast_food|ice_cream)$"]["name"](${bbox}););out center tags;`;

const endpoints = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
let data = null;
for (const ep of endpoints) {
  try {
    const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'Treffly/1.0 (https://github.com/Saheelism/treffly)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
    break;
  } catch (e) {
    console.warn(`Overpass ${ep} failed: ${e.message}`);
  }
}
if (!data) { console.error('No venue data; keeping the previous venues.json if present.'); process.exit(0); }

const typeOf = (a) => (a === 'cafe' || a === 'ice_cream' ? 'cafe' : a === 'bar' || a === 'pub' || a === 'biergarten' ? 'bar' : 'food');
const venues = [];
for (const el of data.elements) {
  const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
  if (lat == null || !el.tags?.name) continue;
  venues.push({ n: el.tags.name, t: typeOf(el.tags.amenity), lat, lon, c: el.tags.cuisine || '', o: el.tags.opening_hours || '' });
}
function distM(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const cell = 0.005;
const grid = new Map();
venues.forEach((v, i) => { const k = `${Math.floor(v.lat / cell)},${Math.floor(v.lon / cell)}`; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
const out = net.stations.map((s) => {
  const near = [];
  const gy = Math.floor(s.lat / cell), gx = Math.floor(s.lon / cell);
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) for (const i of grid.get(`${gy + dy},${gx + dx}`) || []) {
    const d = distM(s.lat, s.lon, venues[i].lat, venues[i].lon);
    if (d <= RADIUS) near.push({ ...venues[i], d: Math.round(d) });
  }
  near.sort((a, b) => a.d - b.d);
  const pick = [];
  for (const t of ['cafe', 'bar', 'food']) pick.push(...near.filter((v) => v.t === t).slice(0, PER_TYPE));
  return pick.map((v) => [v.n, v.t, +v.lat.toFixed(5), +v.lon.toFixed(5), v.d, v.c, v.o]);
});
fs.writeFileSync(path.join(OUT_DIR, 'venues.json'), JSON.stringify({ license: 'ODbL 1.0, © OpenStreetMap contributors', generated: new Date().toISOString(), venues: out }));
console.log(`Venues: ${venues.length} total, saved for ${out.length} stations`);
