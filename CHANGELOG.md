# Changelog

Every version is a git tag. To go back to one: `git checkout <tag>` and
`docker compose up -d --build` (see INSTALL.md, step 10).

## v4.0 — countries and GPX markers (2026-09-20)

First version kept on GitHub (branch `main`, CI on every push).

- **Country selection** at the top of the page. It frames the map on the
  chosen countries and filters everything else: tours, regions, trip
  planner, ski resorts, alerts shown and the data-source panel. Remembered
  in the browser. Countries come from `data/regions.json`, and groups such
  as "Pyrenees" are ready in `public/countries.js` for when more countries
  are added.
- **Server-side alert filter** `ALERT_COUNTRIES` (e.g. `NO`), since the
  buttons only change what you see, not what you are sent.
- **GPX marker in the tour list**: filled `GPX` for your own track, outlined
  for a ski route from OpenStreetMap, dashed for a summer path, `no track`
  or `area` otherwise. A filter for "has a GPX track" / "own GPX only".
  New endpoint `/api/tracks` reads only what is on disk.
- Branch renamed `master` → `main`.

## v3.x — tours and install (2026-09-19/20)

- v3.8-haukeli: seven Haukeli tours (91 tours).
- v3.7-roldal-gausta: five Røldal tours, Gausta east couloirs, Gaustatoppen corrected.
- v3.6-fv50: Blåbergi, Såteggi, Urevassnutane, positions checked against Kartverket.
- v3.5-hemsedal-geilo: twelve tours around Hemsedal and Geilo.
- v3.4-rank-no-forecast / v3.3-no-forecast-tours: Städjan, Sonfjället and
  Elgåhogna, ranked with caution where no avalanche forecast exists.
- v3.2-tours-south-of-are: twelve tours south of Åre with links to Freeride.
- v3.1-install: Raspberry Pi install guide, TP-Link DDNS, refresh cooldown.
- v3-score-explained: "how was this scored?" box in the planner.

## v2-planner

Trip planner: avalanche filter first, then a score from fresh snow, base,
weather, quality and fit, with confidence per day.

## v1-resorts-music / before-resorts

Ski resort layer (Fnugg live for Norway, OpenStreetMap for Sweden), map zoom,
walkthrough video with soundtrack. `before-resorts` is the version before that:
routes, contours, Commons photos and the Fjällskred logotype.
