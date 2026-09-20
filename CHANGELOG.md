# Changelog

Every version is a git tag. To go back to one: `git checkout <tag>` and
`docker compose up -d --build` (see INSTALL.md, step 10).

## v4.1 — tour editor (2026-09-20)

- `editor/tour-editor.html`: a standalone page for your own tours. Load a GPX
  (or a `.tour.json` made earlier), see the track from above and its profile,
  fill in name, region, summit, aspect, difficulty, quality, access, season,
  description and links, and download `<slug>.gpx` + `<slug>.tour.json`
  (or both as a .zip with a note on where they go). Checks mirror the
  tour-data tests. Timestamps are stripped by default. Works offline as a
  single file; `npm run editor:sync` refreshes its region and tour lists.

## v4.0.1 — ready-made images for the Pi (2026-09-20)

- GitHub builds the Docker image (arm64 for the Pi, and amd64) on every push:
  `ghcr.io/hmolker/toppturvarsel:latest` from `main`, `:vX.Y` for each version
  tag, and any older version on request from the Actions tab.
- `FJALLSKRED_VERSION` in `.env` picks the version the Pi runs; update or
  switch with `docker compose pull && docker compose up -d`.
- INSTALL.md steps 11–12: first upload to GitHub, and running images on the Pi.

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
