import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import './style.css';
import { Planner, type Network, type Person, type Place, type Result, distM } from './fair';
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
  collapsed: false,
  planner: null as Planner | null,
  net: null as Network | null,
  tts: new Map<string, Uint8Array>(),
  venues: null as Venue[][] | null,
  loadError: false,
};
const t = () => dict[S.lang];
const BASE = import.meta.env.BASE_URL;

// ---------- helpers ----------
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
const modeBadges = (modes: string) => [...modes].map((m) => `<span class="mode mode-${m}">${m === 'T' ? 'Tram' : m}</span>`).join('');
const color = (p: Person) => COLORS[(p.id - 1) % COLORS.length];
function toast(msg: string) {
  const el = document.getElementById('toast')!;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout((toast as any)._t);
  (toast as any)._t = setTimeout(() => el.classList.remove('show'), 2800);
}
function placeLatLon(p: Place) {
  const st = S.net!.stations;
  return p.kind === 'station' ? { lat: st[p.idx].lat, lon: st[p.idx].lon } : { lat: p.lat, lon: p.lon };
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

map.on('load', () => {
  mapReady = true;
  map.addSource('links', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'links', type: 'line', source: 'links', paint: { 'line-color': ['get', 'c'], 'line-width': 3, 'line-opacity': 0.75, 'line-dasharray': [1.5, 1.5] }, layout: { 'line-cap': 'round' } });
  map.addSource('venues', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'venues', type: 'circle', source: 'venues', paint: { 'circle-radius': 6, 'circle-color': '#1f2a44', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'venue-labels', type: 'symbol', source: 'venues', minzoom: 14.5, layout: { 'text-field': ['get', 'n'], 'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-font': ['Noto Sans Regular'] }, paint: { 'text-color': '#1f2a44', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } });
  map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'stations', type: 'circle', source: 'stations', minzoom: 12, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 2, 15, 4], 'circle-color': '#9aa4b8' } }, 'links');
  drawStations();
  drawMap();
});
map.on('click', (e) => {
  if (S.picking == null || !S.planner) return;
  const p = S.people.find((x) => x.id === S.picking);
  S.picking = null;
  document.body.classList.remove('picking');
  if (!p) return;
  setPin(p, e.lngLat.lat, e.lngLat.lng);
});
map.on('click', 'venues', (e) => {
  const f = e.features?.[0];
  if (f) new maplibregl.Popup({ offset: 10, closeButton: false }).setLngLat((f.geometry as any).coordinates).setHTML(`<strong>${esc(String(f.properties!.n))}</strong>`).addTo(map);
});
map.on('mouseenter', 'venues', () => (map.getCanvas().style.cursor = 'pointer'));
map.on('mouseleave', 'venues', () => (map.getCanvas().style.cursor = ''));

function setPin(p: Person, lat: number, lon: number) {
  const ns = S.planner!.nearestStation(lat, lon);
  p.place = { kind: 'pin', lat, lon };
  p.label = ns.dist < 2000 ? `${t().near} ${S.net!.stations[ns.idx].name}` : t().pinned;
  if (ns.dist > 1500) toast(t().outside);
  S.editing = null;
  update();
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
      el.className = 'pmark';
      m = new maplibregl.Marker({ element: el }).setLngLat([lon, lat]).addTo(map);
      personMarkers.set(p.id, m);
    }
    const el = m.getElement();
    el.style.background = color(p);
    el.innerHTML = `<b>${esc((p.name.trim()[0] || '?').toUpperCase())}</b>`;
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
    for (const p of S.people) {
      if (!p.place) continue;
      const { lat, lon } = placeLatLon(p.place);
      feats.push({ type: 'Feature', properties: { c: color(p) }, geometry: { type: 'LineString', coordinates: [[lon, lat], [s.lon, s.lat]] } });
    }
  } else if (meetMarker) { meetMarker.remove(); meetMarker = null; }
  (map.getSource('links') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: feats });
  // venues
  const vs = r ? currentVenues(r.idx) : [];
  (map.getSource('venues') as maplibregl.GeoJSONSource).setData({ type: 'FeatureCollection', features: vs.map((v) => ({ type: 'Feature', properties: { n: v[0] }, geometry: { type: 'Point', coordinates: [v[3], v[2]] } })) });
  if (fit) fitView();
}

function fitView() {
  const pts: [number, number][] = [];
  for (const p of S.people) if (p.place) { const { lat, lon } = placeLatLon(p.place); pts.push([lon, lat]); }
  const r = S.results[S.selected];
  if (r) { const s = S.net!.stations[r.idx]; pts.push([s.lon, s.lat]); }
  if (!pts.length) return;
  const b = new maplibregl.LngLatBounds(pts[0], pts[0]);
  pts.forEach((p) => b.extend(p));
  const mobile = window.innerWidth < 760;
  map.fitBounds(b, { padding: mobile ? { top: 60, bottom: Math.round(window.innerHeight * 0.55), left: 40, right: 40 } : { top: 80, bottom: 80, left: 460, right: 80 }, maxZoom: 14.5, duration: 700 });
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
  S.planner = new Planner(S.net!, S.tts.get(id)!);
}

// ---------- share links ----------
function writeHash() {
  if (!S.net) return;
  const ps = S.people.filter((p) => p.place).map((p) => {
    const { lat, lon } = placeLatLon(p.place!);
    const ns = S.planner!.nearestStation(lat, lon); // only the nearest station is shared
    const s = S.net!.stations[ns.idx];
    return `${encodeURIComponent(p.name)}~${s.lat.toFixed(4)}~${s.lon.toFixed(4)}`;
  });
  const h = `s=${S.slot}&c=${S.cap}${ps.length ? `&p=${ps.join(',')}` : ''}`;
  history.replaceState(null, '', `#${h}`);
}
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  if (q.get('s') && S.net!.slots.some((s) => s.id === q.get('s'))) S.slot = q.get('s')!;
  if (q.get('c') && CAPS.includes(+q.get('c')!)) S.cap = +q.get('c')!;
  const p = q.get('p');
  if (!p) return false;
  for (const part of p.split(',').slice(0, MAX_PEOPLE)) {
    const [n, la, lo] = part.split('~');
    if (!la || !lo) continue;
    const ns = S.planner!.nearestStation(+la, +lo);
    addPerson(decodeURIComponent(n || ''), { kind: 'station', idx: ns.idx }, S.net!.stations[ns.idx].name);
  }
  return S.people.length > 0;
}

// ---------- render ----------
const panel = document.getElementById('panel')!;

function render() {
  const T = t();
  document.documentElement.lang = S.lang;
  if (!S.net) {
    panel.innerHTML = `<div class="brand"><div class="logo"><i></i><i></i><i></i></div><div><h1>Treffly</h1><p class="tag">${T.tagline}</p></div></div><p class="muted pad">${S.loadError ? T.loadError : T.loading}</p>`;
    return;
  }
  const allSet = S.people.length >= 2 && S.people.every((p) => p.place);
  const r = S.results;
  panel.classList.toggle('collapsed', S.collapsed);
  panel.innerHTML = `
    <button class="handle" data-act="toggle" aria-label="Expand or collapse"><span></span></button>
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
        <div class="seg">${S.net.slots.map((s) => `<button data-act="slot" data-v="${s.id}" class="${S.slot === s.id ? 'on' : ''}">${esc(s.label[S.lang])}</button>`).join('')}</div>
        <h3>${T.maxTime}</h3>
        <div class="seg small">${CAPS.map((c) => `<button data-act="cap" data-v="${c}" class="${S.cap === c ? 'on' : ''}">${c} ${T.min}</button>`).join('')}</div>
      </section>
      <footer><button class="link" data-act="about">${T.about}</button><span>·</span><span>Timetable © MVV · Map © OpenStreetMap</span></footer>
    </div>`;
  const inp = panel.querySelector<HTMLInputElement>('.picker input');
  if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
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

function pickerHtml(p: Person) {
  const T = t();
  const q = fold(S.query);
  let sug: { i: number; s: number }[] = [];
  if (q.length >= 2) {
    S.net!.stations.forEach((st, i) => {
      const f = fold(st.name);
      const pos = f.indexOf(q);
      if (pos >= 0) sug.push({ i, s: pos === 0 ? 0 : f.includes(' ' + q) ? 1 : 2 + pos / 100 });
    });
    sug.sort((a, b) => a.s - b.s || S.net!.stations[a.i].name.length - S.net!.stations[b.i].name.length);
    sug = sug.slice(0, 6);
  }
  return `<div class="picker">
    <input type="search" placeholder="${T.searchPh}" value="${esc(S.query)}" data-id="${p.id}" autocomplete="off" />
    ${sug.length ? `<ul class="sug">${sug.map((x) => `<li><button data-act="choose" data-id="${p.id}" data-v="${x.i}"><span>${esc(S.net!.stations[x.i].name)}</span><span class="modes">${modeBadges(S.net!.stations[x.i].modes)}</span></button></li>`).join('')}</ul>` : ''}
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
        <div class="csum">${x.withinCap ? `<b>${T.everyone(x.max)}</b>` : `${T.longest} <b>${T.minutes(x.max)}</b>`} · ${T.gap} ${T.minutes(x.spread)}</div>
      </button>`).join('')}
    </div>
    <h2 class="places-h">${T.places} <span class="muted">· ${esc(st[sel.idx].name)}</span></h2>
    <div class="chips">${(['cafe', 'bar', 'food'] as VType[]).map((v) => `<button data-act="vtype" data-v="${v}" class="${S.vtype === v ? 'on' : ''}">${T[v]}</button>`).join('')}</div>
    ${vs.length ? `<ul class="venues">${vs.map((v) => `<li><button data-act="venue" data-lat="${v[2]}" data-lon="${v[3]}"><span class="vn">${esc(v[0])}</span><span class="vd">${v[5] ? esc(v[5].split(';')[0].replace(/_/g, ' ')) + ' · ' : ''}${v[4]} m</span></button><a href="https://www.openstreetmap.org/?mlat=${v[2]}&mlon=${v[3]}#map=19/${v[2]}/${v[3]}" target="_blank" rel="noopener" aria-label="${T.openMap}">↗</a></li>`).join('')}</ul>` : `<p class="muted">${S.venues ? T.noPlaces : '…'}</p>`}
    <button class="share" data-act="share">${T.share}</button>`;
}

function aboutHtml() {
  const T = t();
  const n = S.net!;
  const slot = n.slots.map((s) => `${esc(s.label[S.lang])}: ${s.date.slice(6, 8)}.${s.date.slice(4, 6)}.${s.date.slice(0, 4)}`).join(' · ');
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
    case 'toggle': S.collapsed = !S.collapsed; render(); return;
    case 'lang': S.lang = v as Lang; try { localStorage.setItem('treffly-lang', S.lang); } catch {} S.people.forEach((x) => { if (x.place?.kind === 'pin') { const ns = S.planner!.nearestStation(x.place.lat, x.place.lon); x.label = `${t().near} ${S.net!.stations[ns.idx].name}`; } }); render(); return;
    case 'add': { const np = addPerson(); if (np) { S.editing = np.id; S.query = ''; } render(); return; }
    case 'remove': S.people = S.people.filter((x) => x.id !== id); if (S.editing === id) S.editing = null; update(); return;
    case 'edit': S.editing = S.editing === id ? null : id; S.query = ''; render(); return;
    case 'cancel': S.editing = null; S.picking = null; document.body.classList.remove('picking'); render(); return;
    case 'choose': if (p) { const i = +v; p.place = { kind: 'station', idx: i }; p.label = S.net!.stations[i].name; S.editing = null; update(); } return;
    case 'geo':
      if (!p) return;
      if (!navigator.geolocation) { toast(t().geoError); return; }
      toast(t().locating);
      navigator.geolocation.getCurrentPosition((pos) => setPin(p, pos.coords.latitude, pos.coords.longitude), () => toast(t().geoError), { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
      return;
    case 'tap': S.picking = id; document.body.classList.add('picking'); S.collapsed = window.innerWidth < 760; render(); toast(t().tapHint); return;
    case 'slot': S.slot = v; await loadSlot(v); update(false); return;
    case 'cap': S.cap = +v; update(false); return;
    case 'sel': S.selected = +v; render(); drawMap(true); return;
    case 'vtype': S.vtype = v as VType; render(); drawMap(false); return;
    case 'venue': map.flyTo({ center: [+b.dataset.lon!, +b.dataset.lat!], zoom: 16.5, duration: 800 }); if (window.innerWidth < 760) { S.collapsed = true; render(); } return;
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
    render();
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

// ---------- boot ----------
render();
(async () => {
  try {
    const res = await fetch(`${BASE}data/network.json`);
    if (!res.ok) throw new Error('net');
    S.net = await res.json();
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
