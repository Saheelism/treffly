# Treffly plan

Owner: Saheel (GitHub `Saheelism`). Built and improved by a nightly Claude run.
Live site: https://saheelism.github.io/treffly/

## Product

Treffly finds the fairest place for a group (2 to 6 people) to meet in Munich by public transport.

- People are added by station search, "use my location" or a tap on the map.
- Time slots: weekday evening and weekend afternoon.
- Fairness rule (decided by Saheel, do not change without asking):
  1. Nobody travels longer than the chosen limit (30 / 45 / 60 min, default 45).
  2. Among those, prefer the shortest longest trip and the most equal trips:
     `score = longest + 0.5 × (longest − shortest) + 0.01 × total`.
  3. The three suggestions are at least 900 m apart.
  4. If no station meets the limit, show the best options with a clear warning.
- Results: top 3 stations, each person's minutes, places nearby (café, bar, food), share link.
- Share links hold only the nearest station of each person, never exact coordinates.
- Mobile-first (bottom sheet), English and German.
- UI must stay comfortable, calm and polished. Look at screenshots after every UI change.

## Hard rules for every run

- **Zero cost:** no paid services, no service that needs a credit card, no API keys. Static hosting on GitHub Pages and GitHub Actions on this public repo only.
- **No legal risk:** keep all attributions (MVV CC BY 4.0 with retrieval date, OpenStreetMap ODbL, OpenFreeMap/OpenMapTiles). Respect every data source's usage policy and rate limits. No MVV, DB or Google branding. No scraping of sites that forbid it.
- **Privacy:** no cookies, no trackers, no analytics, no accounts, no data leaving the browser.
- Never commit secrets, never force-push, never rewrite history, never delete the repo or its Pages setup.
- Keep the build green. If the last GitHub Actions run failed, fixing it comes first.

## Ask Saheel first (push notification, then stop that item)

- Adding any new external service or data source.
- Anything about money: ads, donations, paid features, a custom domain.
- Expanding beyond Munich.
- Changing the fairness rule or removing a feature.
- Anything needing his accounts, logins or personal details (for example an Impressum).

## Backlog (top = next)

1. Sanity-check real travel times: add `pipeline/check.mjs` that prints times for known pairs (Marienplatz ↔ Hauptbahnhof, Studentenstadt ↔ Marienplatz, Pasing ↔ Ostbahnhof, Garching ↔ Sendlinger Tor) and fails the build on clearly impossible values (0 between different stations, >120, or many unreachable pairs). Tune station grouping if names are duplicated or hubs are missing.
2. Station names: strip the "München, " prefix if the feed uses it; merge duplicates; make search match "Hbf", "Str." and umlaut-free spellings.
3. Bus feeders: let people start from any MVV stop (walk to the nearest bus stop counts), not only rail and tram stations.
4. PWA: web manifest, icons, installable, offline cache of app shell and data.
5. Link previews: Open Graph image (static PNG made at build time) and good meta tags in EN and DE.
6. "Why this spot" line on each card and a light heat layer on the map showing where trips stay under the limit.
7. Accessibility: keyboard navigation for suggestions, focus states, ARIA labels, contrast check.
8. Performance: lazy-load MapLibre, keep first load under 400 kB gzip where possible.
9. More time slots: weekday morning and late evening (check the data size stays small).
10. Show the main line for each person's trip (needs storing the first boarded route in the pipeline).
11. Small landing and SEO text, and a "How it works" section.
