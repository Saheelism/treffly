# Progress log

Newest first. Each nightly run adds one entry: date, what changed, what to do next, anything blocked.

## 2026-11-25 (version 1)

- Built the data pipeline (`pipeline/build.mjs`): MVV GTFS → stations (rail, S-Bahn, U-Bahn, tram in Munich) → connection scan with transfers (2 min) and footpaths (≤600 m) → median door-to-door minutes over departures every 10 min, for weekday evening and weekend afternoon. Tested on a synthetic feed.
- Built `pipeline/venues.mjs`: cafés, bars and food within 400 m of each station from OpenStreetMap (Overpass).
- Built the app (Vite + TypeScript + MapLibre + OpenFreeMap tiles): people with station search, my location and map tap; fairness ranking with limit; result cards with per-person bars; places nearby; share link; EN/DE; mobile bottom sheet; About & data dialog with attributions and privacy note.
- GitHub Actions workflow builds data and deploys to GitHub Pages on every push and every Monday.
- Next: backlog item 1 (sanity check on real data).
