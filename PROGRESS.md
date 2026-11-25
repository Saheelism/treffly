# Progress log

Newest first. Each nightly run adds one entry: date, what changed, what to do next, anything blocked.

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
