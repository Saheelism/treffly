# Treffly

**The fairest place to meet in Munich, by public transport.**

Add where everyone starts. Treffly compares public transport travel times for the whole group and suggests stations where nobody travels much longer than the others, plus cafés, bars and places to eat nearby.

## How it works

- A GitHub Action downloads the MVV timetable (GTFS) every week and computes station-to-station travel times for a weekday evening and a weekend afternoon (median over departures every 10 minutes, so typical waiting time is included).
- The website is static. All the matching runs in the browser: no server, no accounts, no cookies, no tracking.
- Fairness rule: nobody travels longer than the chosen limit (default 45 min); among the options, Treffly prefers the shortest longest trip and keeps trips as equal as possible (`score = longest + 0.5 × (longest − shortest)`).

## Data and licences

- Timetable: Münchner Verkehrs- und Tarifverbund GmbH (MVV), GTFS-MVV-Gesamt, CC BY 4.0. Retrieval date and feed version are shown in the app under "About & data".
- Places and map data: © OpenStreetMap contributors, ODbL 1.0. The generated `venues.json` is a derived database and is published under ODbL 1.0.
- Map tiles: OpenFreeMap, © OpenMapTiles.
- Code: MIT.

Treffly is an independent, non-commercial project and is not affiliated with MVV.

## Development

```bash
npm ci
# build data from an unzipped GTFS feed
node pipeline/build.mjs path/to/gtfs public/data
node pipeline/venues.mjs public/data
npx vite
```
