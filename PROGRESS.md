# Progress log

Newest first. Each nightly run adds one entry: date, what changed, what to do next, anything blocked.

## 2026-11-27 (nightly: bus stops as starting points)

- People can now start from any MVV bus stop in the city box (1,748 stops on real data), not only rail and tram stations. Bus stops are starting points only; meeting points stay the 315 stations.
- Pipeline: for every bus stop and slot it runs the same connection scan (up to 60 min, median over the hour incl. waiting) and keeps the 8 stations reached fastest plus the route there. Output `fd-<slot>.bin` (~42 kB each) and `paths/<slot>/s<n>.json` (100 stops per file, loaded on demand). Stops with the same name as a station within 300 m are left out. Build still ~2 min, site ~12 MB.
- App: search shows bus stops after stations (with a "Bus" badge); a map pin or "my location" may also walk up to 600 m to a bus stop; routes and line chips include the bus (e.g. 187 › S8). Share links: a bus stop picked from the list is shared as that stop; map pins are still shared only as the nearest station.
- Check script: new "Bus stops" section. Real data, weekday evening: 1.3 % of stops reach no station within 60 min, average 13 min to the nearest station; Sundays and nights 6–9 % (lines without service then). These people fall back to walking to a station within 1.5 km. Known pairs unchanged (Studentenstadt → Marienplatz 12, Pasing → Ostbahnhof 19).
- Next: backlog item 4 (PWA).

## 2026-11-26 (nightly: data check, station names)

- New `pipeline/check.mjs`, run as the last step of every build (a failure blocks the deploy; results also go to the Actions run summary). It prints known pairs, per-slot unreachable share, zero-minute pairs and duplicate names, and fails on missing stations, impossible values or more than 10 % unreachable pairs.
- First result on real data (315 stations, feed 20261102): Studentenstadt → Marienplatz 12 min, Pasing → Ostbahnhof 19, Garching → Sendlinger Tor 27, Marienplatz → Hauptbahnhof 4–5 (shorter than the ~8 reference, but plausible on the S-Bahn trunk with trains every few minutes). Unreachable pairs 0–0.7 %, no zero-minute pairs, no duplicate names. 1–127 pairs per slot exceed 120 min (edge stations at weekend nights); these are only warnings.
- Station names: the "München" prefix is dropped ("München-Pasing" → "Pasing"), "München Hbf" → "Hauptbahnhof", "München Ost" → "Ostbahnhof"; Hbf stops merged into one station (316 → 315).
- Search now accepts "Hbf", "Str.", "Bf", umlaut-free spellings (muenchner) and missing spaces (ostbf). Share links are unaffected (they hold coordinates).
- Next: backlog item 3 (bus feeders).

## 2026-11-26 (more meeting times, Saheel's request)

- 15 time slots instead of 2: Mon–Fri / Saturday / Sunday × morning 8–9, midday 12–13, afternoon 15–16, evening 18–19, night 21–22. The app preselects the slot matching the current time in Munich. Old share links (`weekend-day`) map to Saturday afternoon.
- Cost and politeness: MVV timetable and OpenStreetMap places are now downloaded at most once per week and kept in the free GitHub Actions cache, so nightly code pushes don't hit MVV or Overpass. Build ~15 min on free public-repo runners; site stays a few MB (Pages limit is 1 GB).

## 2026-11-26 (real routes on the map, Saheel's request)

- Saheel did not want straight lines from people to the meeting point; he wants routes like the MVG app.
- Pipeline now keeps, for every station pair, the journey of the median departure: walks and rides with every intermediate stop (MVV has no shapes.txt, so rides follow the stop sequence). Output: `geo.json` (nodes, line names and colours) and `paths/<slot>/<hub>.json`, loaded on demand.
- Map: rides in line colour with white casing, walking as dotted lines in the person's colour, white stop dots where people board and leave, line badges (U6, S8, 19...). Selected card lists each person's lines.
- Idea for later (ask Saheel first, it adds a data source): follow real track geometry from OpenStreetMap railway lines instead of stop-to-stop lines.

## 2026-11-25 (mobile fix, after Saheel's feedback)

- Saheel reported the phone site was hard to use: options off-screen, sections frozen.
- Causes: bottom sheet only gave ~380 px of scroll space and could hide behind the browser bar; station search re-rendered the panel on every key, which closes the phone keyboard; inputs under 16 px made iPhones zoom in.
- New phone layout: map fixed on top (36% of screen), panel below fills the rest and scrolls normally (uses dvh). "Tap the map" enlarges the map and shows a bar with Cancel. Search updates only the suggestion list. After choosing a start point the panel scrolls to the results. Bigger touch targets.
- Rule for future runs: test every UI change with the Playwright iPhone 13 profile (tap, type, scroll to the Share button), not only screenshots.

## 2026-11-25 (version 1)

- Built the data pipeline (`pipeline/build.mjs`): MVV GTFS → stations (rail, S-Bahn, U-Bahn, tram in Munich) → connection scan with transfers (2 min) and footpaths (≤600 m) → median door-to-door minutes over departures every 10 min, for weekday evening and weekend afternoon. Tested on a synthetic feed.
- Built `pipeline/venues.mjs`: cafés, bars and food within 400 m of each station from OpenStreetMap (Overpass).
- Built the app (Vite + TypeScript + MapLibre + OpenFreeMap tiles): people with station search, my location and map tap; fairness ranking with limit; result cards with per-person bars; places nearby; share link; EN/DE; mobile bottom sheet; About & data dialog with attributions and privacy note.
- GitHub Actions workflow builds data and deploys to GitHub Pages on every push and every Monday.
- Next: backlog item 1 (sanity check on real data).
