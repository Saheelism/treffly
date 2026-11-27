import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './style.css';
import { Planner, type Feed, type Network, type Access, type Person, type Place, type Result, distM } from './fair';
import { dict, detectLang, type Lang } from './i18n';

// ---------- state ----------
const COLORS = ['#ff6b5b', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
const MAX_PEOPLE = 6;
const CAPS = [30, 45, 60];
type VType = 'cafe' | 'bar' | 'food';
type Venue = [string, VType, number, number, number, string, string];

const S = {
  lang: detectLang() as Lang,
  people: [] as Person[],
  nextId: 1,
  slot: 'weekday-evening',
  cap: 45,
  results: [] as Result[],
  selected: 0,
  vtype: 'cafe' as VType,
  editing: null as number | null, // person whose start point is being chosen
  picking: null as number | null, // person waiting for a map tap
  query: '',
  planner: null as Planner | null,
  net: null as Network | null,
  tts: new Map<string, Uint8Array>(),
  feeds: new Map<string, Feed | null>(),
  venues: null as Venue[][] | null,
  loadError: false,
};
const t = () => dict[S.lang];
const BASE = import.meta.env.BASE_URL;

// ---------- helpers ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
// Search spelling: "ue" = "ü", "Str." = "Straße", "Hbf" = "Hauptbahnhof", "Bf" = "Bahnhof".
const canon = (f: string) => f.replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
  .replace(/strasse\b/g, 'str').replace(/hauptbahnhof\b/g, 'hbf').replace(/bahnhof\b/g, 'bf');
const searchKeys = new Map<number, string[]>();
function keysOf(i: number, name: string) {
  let k = searchKeys.get(i);
  if (!k) { const f = fold(name); const c = canon(f); k = [f, c, c.replace(/ /g, '')]; searchKeys.set(i, k); }
  return k;
}
const modeBadges = (modes: string) => [...modes].map((m) => `<span class="mode mode-${m}">${m === 'T' ? 'Tram' : m === 'B' ? 'Bus' : m}</span>`).join('');
const color = (p: Person) => COLORS[(p.id - 1) % COLORS.length];
function toast(msg: string) {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function placeLatLon(p: Place) {
  const c = p.kind === 'station' ? S.net!.stations[p.idx] : p.kind === 'stop' ? S.net!.stops![p.idx] : p;
  return { lat: c.lat, lon: c.lon };
}
function addPerson(name?: string, place: Place | null = null, label = '') {
  if (S.people.length >= MAX_PEOPLE) return null;
  const p: Person = { id: S.nextId++, name: name || `${t().person} ${S.people.length + 1}`, place, label };
  S.people.push(p);
  return p;
}

// ---------- map ----------
maplibregl.setWorkerUrl(workerUrl);
const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/positron',
  center: [11.575, 48.137],
  zoom: 11.3,
  attributionControl: { compact: true, customAttribution: 'Timetable © MVV (CC BY 4.0)' },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
let mapReady = false;
const personMarkers = new Map<number, maplibregl.Marker>();
let meetMarker: maplibregl.Marker | null = null;

map.once('style.load', () => {
  mapReady = true;
  map.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  // walking: dotted line in the person's colour
  map.addLayer({ id: 'walk', type: 'line', source: 'links', filter: ['==', ['get', 'k'], 'walk'], paint: { 'line-color': ['get', 'c'], 'line-width': 4, 'line-dasharray': [0.1, 1.8] }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  // rides: line colour with a white casing, like a transit map
  map.addLayer({ id: 'ride-casing', type: 'line', source: 'links', filter: ['==', ['get', 'k'], 'ride'], paint: { 'line-color': '#ffffff', 'line-width': 9 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  map.addLayer({ id: 'links', type: 'line', source: 'links', filter: ['==', ['get', 'k'], 'ride'], paint: { 'line-color': ['get', 'c'], 'line-width': 5.5 }, layout: { 'line-cap': 'round', 'line-join': 'round' } });
  map.addLayer({ id: 'stops', type: 'circle', source: 'links', filter: ['==', ['get', 'k'], 'stop'], paint: { 'circle-radius': 5, 'circle-color': '#ffffff', 'circle-stroke-color': ['get', 'c'], 'circle-stroke-width': 3 } });
  map.addSource('venues', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'venues', type: 'circle', source: 'venues', paint: { 'circle-radius': 6, 'circle-color': '#1f2a44', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'venue-labels', type: 'symbol', source: 'venues', minzoom: 14.5, layout: { 'text-field': ['get', 'n'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#1f2a44', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', minzoom: 12, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 15, 4], 'circle-color': '#9aa4b8' } }, 'walk');
  drawStations();
  drawMap(true);
});
map.on('click', (e) => {
  if (S.picking == null || !S.planner) return;
  const p = S.people.find((x) => x.id === S.picking);
  stopPicking();
  if (!p) return;
  setPin(p, e.lngLat.lat, e.lngLat.lng);
});
map.on('click', 'venues', (e) => {
  const f = e.features?.[0];
  if (f) new maplibregl.Popup({ offset: 10, closeButton: false }).setLngLat((f.geometry as any).coordinates).setHTML(`<strong>${esc(String(f.properties!.n))}</strong>`).addTo(map);
});
map.on('mouseenter', 'venues', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'venues', () => (map.getCanvas().style.cursor = ''));

function startPicking(id: number) {
  S.picking = id;
  document.body.classList.add('picking');
  document.getElementById('pickmsg')!.textContent = t().tapHint;
  document.getElementById('pickcancel')!.textContent = t().cancel;
  setTimeout(() => map.resize(), 280);
}
function stopPicking() {
  if (S.picking == null && !document.body.classList.contains('picking')) return;
  S.picking = null;
  document.body.classList.remove('picking');
  setTimeout(() => { map.resize(); fitView(); }, 280);
}
function afterPlaceSet() {
  if (!isMobile()) return;
  requestAnimationFrame(() => {
    const target = S.results.length ? panel.querySelector('.results') : panel.querySelector('.people .ploc.empty');
    target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
}

function setPin(p: Person, lat: number, lon: number) {
  const ns = S.planner!.nearestStation(lat, lon);
  p.place = { kind: 'pin', lat, lon };
  p.label = ns.dist < 2000 ? `${t().near} ${S.net!.stations[ns.idx].name}` : t().pinned;
  if (ns.dist > 1500) toast(t().outside);
  S.editing = null;
  update();
  afterPlaceSet();
}

function drawStations() {
  if (!mapReady || !S.net) return;
  (map.getSource('stations') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: S.net.stations.map((s) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })) });
}

function drawMap(fit = false) {
  if (!mapReady || !S.net) return;
  // people
  const alive = new Set<number>();
  for (const p of S.people) {
    if (!p.place) continue;
    alive.add(p.id);
    const { lat, lon } = placeLatLon(p.place);
    let m = personMarkers.get(p.id);
    if (!m) {
      const el = document.createElement('div');
      el.className = 'pwrap';
      el.innerHTML = '<div class="pmark"><b></b></div>';
      m = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([lon, lat]).addTo(map);
      personMarkers.set(p.id, m);
    }
    const pin = m.getElement().querySelector<HTMLElement>('.pmark')!;
    pin.style.background = color(p);
    pin.querySelector('b')!.textContent = (p.name.trim()[0] || '?').toUpperCase();
    m.setLngLat([lon, lat]);
  }
  for (const [id, m] of personMarkers) if (!alive.has(id)) { m.remove(); personMarkers.delete(id); }
  // meeting point and links
  const r = S.results[S.selected];
  const feats: any[] = [];
  if (r) {
    const s = S.net.stations[r.idx];
    if (!meetMarker) {
      const el = document.createElement('div');
      el.className = 'meet';
      el.innerHTML = '<span></span>';
      meetMarker = new maplibregl.Marker({ element: el }).setLngLat([s.lon, s.lat]).addTo(map);
    }
    meetMarker.setLngLat([s.lon, s.lat]);
    drawRoutes(r.idx, feats);
  } else if (meetMarker) { meetMarker.remove(); meetMarker = null; }
  if (!r) clearLineBadges();
  (map.getSource('links') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  // venues
  const vs = r ? currentVenues(r.idx) : [];
  (map.getSource('venues') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: vs.map((v) => ({ type: 'Feature', properties: { n: v[0] }, geometry: { type: 'Point', coordinates: [v[3], v[2]] } })) });
  if (fit) fitView();
}

// ---------- routes (lines each person takes) ----------
type Leg = number[]; // [route, node, node, ...]; route -1 = walk
interface Geo { nodes: [number, number, string][]; routes: [string, string, string][] }
let geo: Geo | null = null;
let geoLoading = false;
const pathCache = new Map<string, Leg[][] | 'loading'>();
let lineBadges: maplibregl.Marker[] = [];

function clearLineBadges() { lineBadges.forEach((m) => m.remove()); lineBadges = []; }

/** Which station a person walks to first for a given meeting station, and the walk minutes. */
function bestAccess(p: Place, m: number) {
  const H = S.planner!.H;
  let best: (Access & { total: number }) | null = null;
  for (const a of S.planner!.access(p)) {
    const v = a.idx === m ? 0 : S.planner!.tt[a.idx * H + m];
    if (v === 255) continue;
    const total = a.min + v;
    if (!best || total < best.total) best = { ...a, total };
  }
  return best;
}

/** Legs from a person's start to station m, or null while the data loads. */
function routeFor(p: Person, m: number): { access: number; legs: Leg[] } | null {
  if (!p.place || !S.planner) return null;
  const acc = bestAccess(p.place, m);
  if (!acc) return null;
  if (!geo && !geoLoading) {
    geoLoading = true;
    fetch(`${BASE}data/geo.json`).then((r) => (r.ok ? r.json() : null)).then((g) => { geo = g; render(); drawMap(false); }).catch(() => {});
  }
  // bus ride from the stop to the first station (paths/<slot>/s<chunk>.json, one list per stop)
  let bus: Leg[] = [];
  if (acc.stop !== undefined) {
    const size = S.net!.feedChunk || 100;
    const c = pathFile(`${S.slot}/s${Math.floor(acc.stop / size)}`) as unknown as Leg[][][] | null;
    if (!c) return null;
    bus = c[acc.stop % size]?.[acc.k!] || [];
  }
  if (acc.idx === m) return geo ? { access: acc.idx, legs: bus } : null;
  const c = pathFile(`${S.slot}/${acc.idx}`);
  if (!c || !geo) return null;
  return { access: acc.idx, legs: [...bus, ...(c[m] || [])] };
}

/** A route file, or null while it loads (a redraw follows when it arrives). */
function pathFile(key: string): Leg[][] | null {
  const c = pathCache.get(key);
  if (c === undefined) {
    pathCache.set(key, 'loading');
    fetch(`${BASE}data/paths/${key}.json`).then((r) => (r.ok ? r.json() : [])).then((d) => { pathCache.set(key, d); render(); drawMap(false); }).catch(() => pathCache.delete(key));
    return null;
  }
  return c === 'loading' ? null : c;
}

function drawRoutes(m: number, feats: any[]) {
  clearLineBadges();
  for (const p of S.people) {
    if (!p.place) continue;
    const rt = routeFor(p, m);
    const start = placeLatLon(p.place);
    const pc = color(p);
    if (!rt || !geo) continue;
    const ll = (n: number): [number, number] => [geo!.nodes[n][1], geo!.nodes[n][0]];
    // walk from the starting point to the first station
    const first = rt.legs.length ? rt.legs[0][1] : m;
    const firstLL = ll(first);
    if (Math.abs(firstLL[0] - start.lon) + Math.abs(firstLL[1] - start.lat) > 0.0004) feats.push({ type: 'Feature', properties: { k: 'walk', c: pc }, geometry: { type: 'LineString', coordinates: [[start.lon, start.lat], firstLL] } });
    for (const leg of rt.legs) {
      const [r, ...nodes] = leg;
      const coords = nodes.map(ll);
      if (r < 0) { feats.push({ type: 'Feature', properties: { k: 'walk', c: pc }, geometry: { type: 'LineString', coordinates: coords } }); continue; }
      const [name, , lc] = geo.routes[r] || ['', 'B', '#56607a'];
      feats.push({ type: 'Feature', properties: { k: 'ride', c: lc }, geometry: { type: 'LineString', coordinates: coords } });
      feats.push({ type: 'Feature', properties: { k: 'stop', c: lc }, geometry: { type: 'Point', coordinates: coords[0] } });
      feats.push({ type: 'Feature', properties: { k: 'stop', c: lc }, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } });
      // line name badge in the middle of the ride
      const mid = coords[Math.floor(coords.length / 2)];
      const el = document.createElement('div');
      el.className = 'linebadge';
      el.style.background = lc;
      el.textContent = name;
      lineBadges.push(new maplibregl.Marker({ element: el }).setLngLat(mid).addTo(map));
    }
  }
}

/** Short summary of a person's trip for the result card. */
function legChips(p: Person, m: number) {
  const rt = routeFor(p, m);
  if (!rt || !geo) return `<span class="muted small">…</span>`;
  const parts: string[] = [];
  const acc = bestAccess(p.place!, m)!;
  if (acc.walk >= 1) parts.push(`<span class="walkchip" title="${S.lang === 'de' ? 'Fußweg' : 'Walk'}">🚶 ${Math.round(acc.walk)}′</span>`);
  for (const leg of rt.legs) {
    if (leg[0] < 0) { parts.push(`<span class="walkchip">🚶</span>`); continue; }
    const [name, mode, lc] = geo.routes[leg[0]] || ['?', 'B', '#56607a'];
    const label = name || mode;
    parts.push(`<span class="linechip" style="background:${lc}" title="${esc(geo.nodes[leg[1]][2])} → ${esc(geo.nodes[leg[leg.length - 1]][2])}">${esc(label)}</span>`);
  }
  if (!rt.legs.length && acc.walk < 1) return `<span class="muted small">${S.lang === 'de' ? 'schon da' : 'already there'}</span>`;
  return parts.join('<span class="arrow">›</span>');
}

function fitView() {
  const pts: [number, number][] = [];
  for (const p of S.people) if (p.place) { const { lat, lon } = placeLatLon(p.place); pts.push([lon, lat]); }
  const r = S.results[S.selected];
  if (r) {
    const s = S.net!.stations[r.idx]; pts.push([s.lon, s.lat]);
    if (geo) for (const p of S.people) { const rt = p.place ? routeFor(p, r.idx) : null; rt?.legs.forEach((l) => l.slice(1).forEach((n) => pts.push([geo!.nodes[n][1], geo!.nodes[n][0]]))); }
  }
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  pts.forEach((p) => b.extend(p));
  map.fitBounds(b, { padding: isMobile() ? { top: 40, bottom: 40, left: 36, right: 36 } : { top: 80, bottom: 80, left: 460, right: 80 }, maxZoom: 14.5, duration: 700 });
}

function currentVenues(idx: number): Venue[] {
  return (S.venues?.[idx] || []).filter((v) => v[1] === S.vtype);
}

// ---------- compute ----------
function compute() {
  const ready = S.people.filter((p) => p.place);
  if (!S.planner || ready.length < 2 || ready.length !== S.people.length) { S.results = []; return; }
  S.results = S.planner.rank(ready.map((p) => p.place!), S.cap);
  if (S.selected >= S.results.length) S.selected = 0;
}

async function loadSlot(id: string) {
  if (!S.tts.has(id)) {
    const res = await fetch(`${BASE}data/tt-${id}.bin`);
    if (!res.ok) throw new Error('tt');
    S.tts.set(id, new Uint8Array(await res.arrayBuffer()));
  }
  const F = S.net!.stops?.length || 0, K = S.net!.feedK || 0;
  if (F && K && !S.feeds.has(id)) {
    // bus stops: optional, the app still works with stations only if this file is missing
    const res = await fetch(`${BASE}data/fd-${id}.bin`).catch(() => null);
    const buf = res?.ok ? await res.arrayBuffer() : null;
    S.feeds.set(id, buf && buf.byteLength === F * K * 3 ? { hub: new Uint16Array(buf, 0, F * K), min: new Uint8Array(buf, F * K * 2, F * K), k: K } : null);
  }
  S.planner = new Planner(S.net!, S.tts.get(id)!, S.feeds.get(id) || null);
}

// ---------- share links ----------
function writeHash() {
  if (!S.net) return;
  const ps = S.people.filter((p) => p.place).map((p) => {
    const { lat, lon } = placeLatLon(p.place!);
    // Only a stop is shared: the bus stop someone picked from the list, otherwise the nearest station (never a map pin).
    const s = p.place!.kind === 'stop' ? S.net!.stops![p.place!.idx] : S.net!.stations[S.planner!.nearestStation(lat, lon).idx];
    return `${encodeURIComponent(p.name)}~${s.lat.toFixed(5)}~${s.lon.toFixed(5)}`;
  });
  const h = `s=${S.slot}&c=${S.cap}${ps.length ? `&p=${ps.join(',')}` : ''}`;
  history.replaceState(null, '', `#${h}`);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  const legacy: Record<string, string> = { 'weekend-day': 'saturday-afternoon' }; // links from the first version
  const qs = legacy[q.get('s') || ''] || q.get('s');
  if (qs && S.net!.slots.some((s) => s.id === qs)) S.slot = qs;
  if (q.get('c') && CAPS.includes(+q.get('c')!)) S.cap = +q.get('c')!;
  const p = q.get('p');
  if (!p) return false;
  for (const part of p.split(',').slice(0, MAX_PEOPLE)) {
    const [n, la, lo] = part.split('~');
    if (!la || !lo) continue;
    const ns = S.planner!.nearestStation(+la, +lo);
    const stop = ns.dist > 15 ? nearestStop(+la, +lo) : null;
    if (stop) addPerson(decodeURIComponent(n || ''), { kind: 'stop', idx: stop.idx }, S.net!.stops![stop.idx].name);
    else addPerson(decodeURIComponent(n || ''), { kind: 'station', idx: ns.idx }, S.net!.stations[ns.idx].name);
  }
  return S.people.length > 0;
}

/** The bus stop at a shared position (within 15 m), if any. */
function nearestStop(lat: number, lon: number) {
  let best: { idx: number; d: number } | null = null;
  (S.net!.stops || []).forEach((s, i) => { const d = distM(lat, lon, s.lat, s.lon); if (d < 15 && (!best || d < best.d)) best = { idx: i, d }; });
  return best as { idx: number; d: number } | null;
}

// ---------- render ----------
const panel = document.getElementById('panel')!;
let focusPicker = false;
const isMobile = () => window.innerWidth < 760;

function render() {
  const T = t();
  document.documentElement.lang = S.lang;
  if (!S.net) {
    panel.innerHTML = `<div class="brand"><div class="logo"><i></i><i></i><i></i></div><div><h1>Treffly</h1><p class="tag">${T.tagline}</p></div></div><p class="muted pad">${S.loadError ? T.loadError : T.loading}</p>`;
    return;
  }
  const allSet = S.people.length >= 2 && S.people.every((p) => p.place);
  const r = S.results;
  panel.innerHTML = `
    <header class="brand">
      <div class="logo" aria-hidden="true"><i></i><i></i><i></i></div>
      <div><h1>Treffly</h1><p class="tag">${T.tagline}</p></div>
      <div class="lang" role="group" aria-label="Language">
        <button data-act="lang" data-v="en" class="${S.lang === 'en' ? 'on' : ''}">EN</button><button data-act="lang" data-v="de" class="${S.lang === 'de' ? 'on' : ''}">DE</button>
      </div>
    </header>
    <div class="scroll">
      <section>
        <h2>${T.who}</h2>
        <ul class="people">${S.people.map(personRow).join('')}</ul>
        ${S.people.length < MAX_PEOPLE ? `<button class="add" data-act="add"><span>+</span>${T.addPerson}</button>` : ''}
      </section>
      <section class="results">
        ${!allSet ? `<p class="hint">${S.people.length < 2 ? T.needTwo : T.needPlaces}</p>` : resultsHtml()}
      </section>
      <section>
        <h2>${T.when}</h2>
        ${whenHtml()}
        <h3>${T.maxTime}</h3>
        <div class="seg small">${CAPS.map((c) => `<button data-act="cap" data-v="${c}" class="${S.cap === c ? 'on' : ''}">${c} ${T.min}</button>`).join('')}</div>
      </section>
      <footer><button class="link" data-act="about">${T.about}</button><span>·</span><span>Timetable © MVV · Map © OpenStreetMap</span></footer>
    </div>`;
  const inp = panel.querySelector<HTMLInputElement>('.picker input');
  if (inp && focusPicker) { focusPicker = false; inp.focus({ preventScroll: true }); inp.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
}

function personRow(p: Person) {
  const T = t();
  const editing = S.editing === p.id;
  return `<li class="person ${editing ? 'editing' : ''}" style="--c:${color(p)}">
    <div class="row">
      <span class="avatar">${esc((p.name.trim()[0] || '?').toUpperCase())}</span>
      <div class="pinfo">
        <input class="pname" data-id="${p.id}" value="${esc(p.name)}" aria-label="${T.rename}" maxlength="24" />
        <button class="ploc ${p.place ? '' : 'empty'}" data-act="edit" data-id="${p.id}">${p.place ? esc(p.label) : T.noLocation}</button>
      </div>
      ${S.people.length > 1 ? `<button class="x" data-act="remove" data-id="${p.id}" aria-label="${T.remove}">×</button>` : ''}
    </div>
    ${editing ? pickerHtml(p) : ''}
  </li>`;
}

function suggestions(pid: number) {
  const q = fold(S.query);
  if (q.length < 2) return '';
  const qs = [q, canon(q), canon(q).replace(/ /g, '')];
  // stations first, then bus stops (search index H + i); stations win when equally good
  const H = S.net!.stations.length;
  const all = [...S.net!.stations.map((s) => ({ name: s.name, modes: s.modes })), ...(S.planner?.feed ? S.net!.stops || [] : []).map((s) => ({ name: s.name, modes: 'B' }))];
  let sug: { i: number; s: number }[] = [];
  all.forEach((st, i) => {
    let best = Infinity;
    for (const f of keysOf(i, st.name)) for (const v of qs) {
      const pos = f.indexOf(v);
      if (pos >= 0) best = Math.min(best, pos === 0 ? 0 : f.includes(' ' + v) ? 1 : 2 + pos / 100);
    }
    if (best < Infinity) sug.push({ i, s: best + (i >= H ? 0.5 : 0) });
  });
  sug.sort((a, b) => a.s - b.s || all[a.i].name.length - all[b.i].name.length);
  sug = sug.slice(0, 6);
  return sug.map((x) => `<li><button data-act="choose" data-id="${pid}" data-v="${x.i}"><span>${esc(all[x.i].name)}</span><span class="modes">${modeBadges(all[x.i].modes)}</span></button></li>`).join('');
}

function pickerHtml(p: Person) {
  const T = t();
  return `<div class="picker">
    <input type="search" placeholder="${T.searchPh}" value="${esc(S.query)}" data-id="${p.id}" autocomplete="off" enterkeyhint="search" />
    <ul class="sug">${suggestions(p.id)}</ul>
    <div class="pick-actions">
      <button data-act="geo" data-id="${p.id}">◎ ${T.myLocation}</button>
      <button data-act="tap" data-id="${p.id}">⌖ ${T.pickMap}</button>
      <button class="link" data-act="cancel">${T.cancel}</button>
    </div>
  </div>`;
}

function resultsHtml() {
  const T = t();
  const r = S.results;
  if (!r.length) return `<p class="hint">${T.outside}</p>`;
  const over = !r[0].withinCap;
  const ready = S.people.filter((p) => p.place);
  const sel = r[S.selected];
  const st = S.net!.stations;
  const maxBar = Math.max(...r.flatMap((x) => x.times), 1);
  const vs = currentVenues(sel.idx);
  return `
    <h2>${T.results}</h2>
    ${over ? `<p class="warn">${T.overCap(S.cap)}</p>` : ''}
    <div class="cards">
      ${r.map((x, i) => `<button class="card ${i === S.selected ? 'on' : ''}" data-act="sel" data-v="${i}">
        <div class="ctop"><span class="rank">${i + 1}</span><span class="cname">${esc(st[x.idx].name)}</span><span class="modes">${modeBadges(st[x.idx].modes)}</span></div>
        <div class="bars">${ready.map((p, k) => `<div class="bar"><span class="who" style="background:${color(p)}">${esc((p.name.trim()[0] || '?').toUpperCase())}</span><span class="track"><span style="width:${Math.max(6, (x.times[k] / maxBar) * 100)}%;background:${color(p)}"></span></span><span class="mins">${T.minutes(x.times[k])}</span></div>`).join('')}</div>
        ${i === S.selected ? `<div class="legs">${ready.map((p) => `<div class="legrow"><span class="who" style="background:${color(p)}">${esc((p.name.trim()[0] || '?').toUpperCase())}</span><span class="chips2">${legChips(p, x.idx)}</span></div>`).join('')}</div>` : ''}
        <div class="csum">${x.withinCap ? `<b>${T.everyone(x.max)}</b>` : `${T.longest} <b>${T.minutes(x.max)}</b>`} · ${T.gap} ${T.minutes(x.spread)}</div>
      </button>`).join('')}
    </div>
    <h2 class="places-h">${T.places} <span class="muted">· ${esc(st[sel.idx].name)}</span></h2>
    <div class="chips">${(['cafe', 'bar', 'food'] as VType[]).map((v) => `<button data-act="vtype" data-v="${v}" class="${S.vtype === v ? 'on' : ''}">${T[v]}</button>`).join('')}</div>
    ${vs.length ? `<ul class="venues">${vs.map((v) => `<li><button data-act="venue" data-lat="${v[2]}" data-lon="${v[3]}"><span class="vn">${esc(v[0])}</span><span class="vd">${v[5] ? `<i>${esc(v[5].split(';')[0].replace(/_/g, ' '))}</i> · ` : ''}${v[4]} m</span></button><a href="https://www.openstreetmap.org/?mlat=${v[2]}&mlon=${v[3]}#map=19/${v[2]}/${v[3]}" target="_blank" rel="noopener" aria-label="${T.openMap}">↗</a></li>`).join('')}</ul>` : `<p class="muted">${S.venues ? T.noPlaces : '…'}</p>`}
    <button class="share" data-act="share">${T.share}</button>`;
}

const DAY_IDS = ['weekday', 'saturday', 'sunday'];
const TIME_IDS = ['morning', 'midday', 'afternoon', 'evening', 'night'];
const slotParts = () => { const [d, tm] = S.slot.split('-'); return { d, tm }; };
function whenHtml() {
  const T = t();
  const { d, tm } = slotParts();
  const has = (id: string) => S.net!.slots.some((s) => s.id === id);
  return `<div class="seg">${DAY_IDS.filter((x) => has(`${x}-${tm}`) || TIME_IDS.some((y) => has(`${x}-${y}`))).map((x) => `<button data-act="day" data-v="${x}" class="${d === x ? 'on' : ''}">${T.days[x]}</button>`).join('')}</div>
    <div class="times">${TIME_IDS.filter((y) => has(`${d}-${y}`)).map((y) => `<button data-act="time" data-v="${y}" class="${tm === y ? 'on' : ''}"><b>${T.times[y]}</b><span>${T.timeHints[y]}</span></button>`).join('')}</div>`;
}
/** Slot that fits the current day and time in Munich. */
function slotForNow(): string {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value || 'Mon';
  const h = Number(parts.find((p) => p.type === 'hour')?.value || 18);
  const d = wd === 'Sat' ? 'saturday' : wd === 'Sun' ? 'sunday' : 'weekday';
  const tm = h < 11 ? 'morning' : h < 14 ? 'midday' : h < 17 ? 'afternoon' : h < 20 ? 'evening' : 'night';
  const id = `${d}-${tm}`;
  return S.net!.slots.some((s) => s.id === id) ? id : S.net!.slots[0].id;
}

function aboutHtml() {
  const T = t();
  const n = S.net!;
  const seen = new Set<string>();
  const slot = n.slots.filter((s) => !seen.has(s.day) && seen.add(s.day)).map((s) => `${T.days[s.day]}: ${s.date.slice(6, 8)}.${s.date.slice(4, 6)}.${s.date.slice(0, 4)}`).join(' · ');
  return `<form method="dialog">
    <h2>${T.aboutTitle}</h2><p>${T.aboutBody}</p>
    <h3>${T.privacyTitle}</h3><p>${T.privacyBody}</p>
    <h3>${T.dataTitle}</h3>
    <ul>
      <li>${T.timetable}: ${esc(n.source)}, <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noopener">CC BY 4.0</a>. ${S.lang === 'de' ? 'Abgerufen am' : 'Retrieved'} ${esc(n.retrieved)}${n.feedVersion ? `, ${S.lang === 'de' ? 'Version' : 'version'} ${esc(n.feedVersion)}` : ''}. ${slot}</li>
      <li>${S.lang === 'de' ? 'Orte und Karte' : 'Places and map data'}: © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>, ODbL. ${S.lang === 'de' ? 'Kartendarstellung' : 'Map tiles'}: <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>, © <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a>.</li>
      <li>${S.lang === 'de' ? 'Quellcode' : 'Source code'}: <a href="https://github.com/Saheelism/treffly" target="_blank" rel="noopener">github.com/Saheelism/treffly</a> (MIT)</li>
    </ul>
    <p class="muted">${S.lang === 'de' ? 'Treffly ist ein unabhängiges, nicht-kommerzielles Projekt und steht in keiner Verbindung zum MVV.' : 'Treffly is an independent, non-commercial project and is not affiliated with MVV.'}</p>
    <button class="share">${T.close}</button>
  </form>`;
}

// ---------- update cycle ----------
function update(fit = true) {
  compute();
  render();
  drawMap(fit);
  writeHash();
}

// ---------- events ----------
panel.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!b) return;
  const act = b.dataset.act!, id = Number(b.dataset.id), v = b.dataset.v!;
  const p = S.people.find((x) => x.id === id);
  switch (act) {
    case 'lang': S.lang = v as Lang; try { localStorage.setItem('treffly-lang', S.lang); } catch {} S.people.forEach((x) => { if (x.place?.kind === 'pin') { const ns = S.planner!.nearestStation(x.place.lat, x.place.lon); x.label = `${t().near} ${S.net!.stations[ns.idx].name}`; } }); render(); return;
    case 'add': { const np = addPerson(); if (np) { S.editing = np.id; S.query = ''; focusPicker = true; } render(); return; }
    case 'remove': S.people = S.people.filter((x) => x.id !== id); if (S.editing === id) S.editing = null; update(); return;
    case 'edit': S.editing = S.editing === id ? null : id; S.query = ''; focusPicker = S.editing != null; render(); return;
    case 'cancel': S.editing = null; stopPicking(); render(); return;
    case 'choose': if (p) {
      const i = +v, H = S.net!.stations.length;
      p.place = i < H ? { kind: 'station', idx: i } : { kind: 'stop', idx: i - H };
      p.label = i < H ? S.net!.stations[i].name : S.net!.stops![i - H].name;
      S.editing = null; S.query = ''; update(); afterPlaceSet();
    } return;
    case 'geo':
      if (!p) return;
      if (!navigator.geolocation) { toast(t().geoError); return; }
      toast(t().locating);
      navigator.geolocation.getCurrentPosition((pos) => setPin(p, pos.coords.latitude, pos.coords.longitude), () => toast(t().geoError), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      return;
    case 'tap': startPicking(id); return;
    case 'day': case 'time': {
      const { d, tm } = slotParts();
      let id = act === 'day' ? `${v}-${tm}` : `${d}-${v}`;
      if (!S.net!.slots.some((x) => x.id === id)) id = S.net!.slots.find((x) => x.id.startsWith(act === 'day' ? v : d))?.id || S.slot;
      S.slot = id; await loadSlot(id); update(false); return;
    }
    case 'cap': S.cap = +v; update(false); return;
    case 'sel': S.selected = +v; render(); drawMap(true); if (isMobile()) panel.querySelector('.places-h')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); return;
    case 'vtype': S.vtype = v as VType; render(); drawMap(false); return;
    case 'venue': map.flyTo({ center: [+b.dataset.lon!, +b.dataset.lat!], zoom: 16.5, duration: 800 }); return;
    case 'share': await share(); return;
    case 'about': { const d = document.getElementById('about') as HTMLDialogElement; d.innerHTML = aboutHtml(); d.showModal(); return; }
  }
});
panel.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.classList.contains('pname')) {
    const p = S.people.find((x) => x.id === Number(el.dataset.id));
    if (p) { p.name = el.value; const av = el.closest('.person')?.querySelector('.avatar'); if (av) av.textContent = (p.name.trim()[0] || '?').toUpperCase(); drawMap(false); writeHash(); }
  } else if (el.type === 'search') {
    S.query = el.value;
    const ul = el.parentElement!.querySelector('.sug')!;
    ul.innerHTML = suggestions(Number(el.dataset.id));
  }
});
panel.addEventListener('change', (e) => { if ((e.target as HTMLElement).classList.contains('pname')) render(); });
panel.addEventListener('keydown', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.type === 'search' && e.key === 'Enter') { const first = panel.querySelector<HTMLButtonElement>('.sug button'); first?.click(); }
  if (e.key === 'Escape') { S.editing = null; render(); }
});

async function share() {
  writeHash();
  const r = S.results[S.selected];
  const name = r ? S.net!.stations[r.idx].name : '';
  const text = r ? `${t().shareText} ${name} (${t().everyone(r.max)})` : 'Treffly';
  const url = location.href;
  if (navigator.share && window.innerWidth < 760) {
    try { await navigator.share({ title: 'Treffly', text, url }); return; } catch { /* cancelled */ }
  }
  try { await navigator.clipboard.writeText(`${text}\n${url}`); toast(t().copied); } catch { prompt('Copy this link', url); }
}

document.getElementById('pickcancel')!.addEventListener('click', () => { stopPicking(); render(); });

// ---------- boot ----------
render();
(async () => {
  try {
    const res = await fetch(`${BASE}data/network.json`);
    if (!res.ok) throw new Error('net');
    S.net = await res.json();
    S.slot = slotForNow();
    await loadSlot(S.slot);
    if (!readHash()) { addPerson(); addPerson(); }
    else await loadSlot(S.slot);
    drawStations();
    update(true);
    fetch(`${BASE}data/venues.json`).then((r) => (r.ok ? r.json() : null)).then((v) => { if (v) { S.venues = v.venues; render(); drawMap(false); } }).catch(() => {});
  } catch {
    S.loadError = true;
    render();
  }
})();

// keep distM referenced for tree-shaking clarity
void distM;

// A pasted share link on an open page only changes the hash; reload so it is read fresh.
window.addEventListener('hashchange', () => location.reload());
