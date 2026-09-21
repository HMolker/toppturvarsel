# Changelog

Every version is a git tag. To go back to one: `git checkout <tag>` and
`docker compose up -d --build` (see INSTALL.md, step 10).

## v4.11 — snow through the winter, and a panel for each ski resort (2026-09-22)

- **Snow depth this winter** in every tour panel: this winter's modelled
  depth (solid) against the average of the five winters before (dashed)
  and their range (shaded), with today's value as a red dot and how it
  compares ("73 cm today, −53 % vs average"). Hover for any day. From NVE
  seNorge at the tour's grid cell, via the new `GET /api/snowhistory`:
  past winters are fetched once and cached for good, the current one is
  refreshed every 6 hours. Out of season it shows the winter just gone;
  in simulated mode a made-up winter so far.
- **Ski resorts open a panel**, like tours: open or closed today, lifts
  and slopes open with bars, season dates, the avalanche region and its
  danger for off-piste, modelled snow at the nearest tour, touring
  objectives within 40 km with today's planner score, the 5-day forecast
  at the resort (`/api/forecast?resort=<id>`, listed resorts only), a map,
  and the website. The map's resort names no longer jump straight to the
  website; the panel links to it.
- The map tile proxy also serves the areas around listed ski resorts.

## v4.10 — wet snow in the best window (2026-09-22)

- **Wet-snow hours:** the best window now knows that warming makes the
  afternoon the dangerous part. An hour is a wet-snow hour when the air at
  the tour's mid-height (summit forecast + 6.5 °C per km down to half the
  vertical) is above about +1 °C, or in March–June when the sun is on an
  east-to-west descent aspect with little cloud and it is not too cold.
  From the first such hour the rest of the day counts as wet.
- Wet-snow hours score as poor (0.25), so the window moves before them.
  When that day's bulletin names a wet-snow or gliding-snow problem, the
  thaw is a hard limit: the window must end before it if the light allows.
- **Planner:** "off the slope by 11: wet snow after", or "too long to finish
  before wet snow at 11", which also takes 40 % off the weather part. The
  explanation box shows when and why the wet snow starts.
- **Tour forecast:** wet-snow hours in blue-grey in the hour strip, "off by
  11" under the window, and a legend entry.
- **Simulated data:** day 5 is a thaw (clear, frozen night, above zero by
  day) with a wet-snow problem in the bulletin, so all of this shows.

## v4.9.1 — version box, and a simulation that shows everything (2026-09-21)

- **Data sources & freshness** has a box with the running version and when
  it started, from the new `GET /api/version`.
- **Simulated data:** day 3 of the simulated week brings a short second
  front, so the planner shows "poor weather even at best" and the trip plan
  suggests a resort day, before cold, clear powder days. Checked in the
  browser, starting from an off-season snapshot like September's: problem
  icons, rose and height band in the region panel, icons in the planner and
  powder alerts, the best-window rows and hour strips, the area trip and its
  resort hints all appear once "Simulated data" is pressed.

## v4.9 — resort days in the trip plan, and an advert (2026-09-21)

- **A few days in one area:** a day with poor touring weather (or nothing
  that passes) now suggests the biggest ski resorts within ~45 km of the
  area's tours. Click one and the map turns on the resort layer and zooms
  to it. Resort status now reloads on every refresh once it has been loaded.
- **Advert:** `demo/record-advert.mjs` records a ~2.5 minute film of one
  made-up week in Hallingdal: your own GPX in the tour editor, the trip
  plan for Tuesday to Thursday, a storm day pointing to Hemsedal's lifts,
  and a powder day. Weather, snow, bulletins and lift status come from
  `demo/advert/scenario.mjs`; the terrain is a made-up model
  (`demo/advert/terrain.mjs`) that the real server code profiles, contours
  and shades. The music (`demo/advert/music.py`) is an original après-ski
  style track, synthesised from scratch and timed to the scenes.

## v4.8.1 — hour strip legend (2026-09-21)

- The best-window strip shades the hours in the light on a red scale
  (darker = better), so they stand apart from the dark no-light hours, and
  a small legend under the forecast table explains the strip.

## v4.8 — when to go, what the snow is like, and a few days in one area (2026-09-21)

- **Hourly summit forecast:** Open-Meteo is now asked for hourly wind, gusts,
  cloud, temperature, snowfall and precipitation, including the two days
  before today (`past_days=2`). The daily rows still start today.
  `/api/outlook` is gzipped, since it now carries ~90 hourly series.
- **Daylight and the best window:** sunrise, sunset and civil twilight per
  tour and day (polar night and midnight sun included). The planner's
  weather part is the best stretch of daylight, as long as the tour takes
  (400 m/h up, 1500 m/h down, +30 min), scored hour by hour. It says
  "go 08–12", and marks a tour down when it does not fit the light.
  The tour forecast gets Daylight, Best window (with an hour strip) and
  Surface rows.
- **Snow surface by aspect:** wind while and after it snowed gives lee
  (loaded, slab-prone), windward (scoured) or cross; warming after the snow
  gives crust; spring corn on sunny aspects with its best hours (E 9–12
  through W 13–16); cold and calm keeps the powder. Replaces the old
  day-level warm/windy/corn rules whenever hourly data exists (they remain
  as the fallback).
- **A few days in one area:** under the planner, the three best regions for
  a 2–5 day trip from the selected day, one different tour per day; days
  with nothing passing are rest days and count zero.
- **Proposals section** at the bottom of the page: travel time and road
  status, ground truth (Regobs, webcams, trip log), personal alerts, more
  mountains, an editor that saves, official EAWS icons.
- Simulated data now includes hourly forecasts, so all of the above shows in
  simulation mode (on today's real dates, so the daylight is September's).

## v4.7 — avalanche problems drawn, explained and put on the map (2026-09-21)

- **Region panel:** each avalanche problem gets a pictogram, a compass rose of
  the aspects it applies to, and a mountain with its height band shaded.
  Black and white below danger 3, in colour from 3.
- **Explanations on hover (tap on a phone):** each problem type and each
  danger level says in two or three sentences what it means, after the EAWS
  avalanche-problem standard and the European Avalanche Danger Scale.
- **Trip planner and powder alerts:** danger level and problem icons after the
  tour or region name; the text is unchanged, and no directions here.
- **Route map:** slopes steeper than 25° that face the way today's problems
  face, at their heights, are shaded red. Computed from a new ~50 m slope grid
  (`/api/slopes`, up to 60 × 60 points, cached 30 days), since the contour
  grid's 200–400 m cells average steep faces down to ~20°.
- Problems are now matched on Varsom's problem type ("Wind-drifted snow")
  rather than the avalanche type ("Dry slab avalanche"); alert messages name
  the problem too.
- The pictograms are this tool's own drawings: the EAWS icon downloads state
  no licence for reuse.

## v4.6 — more photos, and a drawing when there are none (2026-09-21)

- **Commons, wider:** the search reaches 10 km from the summit instead of 5,
  and when that is thin it also asks for files *named after* the summit —
  many Norwegian and Swedish mountain photos are named or categorised but
  never geotagged. Those are listed after the located ones and labelled
  "named after …", with no map marker.
- **Flickr:** with a free `FLICKR_API_KEY`, Creative-Commons and
  public-domain photos near the summit are added, credited and linked back.
  Without a key Flickr is not asked. Written against Flickr's documented API
  and not yet exercised live.
- **Drawn when nothing exists:** if no photo is found, the panel draws the
  mountain from the terrain grid — a shaded relief with the fall line on it,
  and the profile of that line coloured by slope angle. It looks down the
  tour's descent aspect; where that is "varied" it finds the steepest way
  down and says so. Labelled as drawn, not photographed, and as too coarse to
  read real slope angles from.

## v4.5 — alerts through an ordinary mailbox (2026-09-21)

- The image now installs `nodemailer` (itself dependency-free), so
  `MAIL_PROVIDER=smtp` works out of the box: alerts can go through Gmail or
  any other mailbox with an app password, instead of needing a Resend
  account and a verified domain. If the package cannot be fetched the build
  still succeeds and only SMTP mail is unavailable.
- `.env.example` and the README carry the Gmail and Outlook address lines,
  including the app-password step and the `%40` encoding that trips people up.

## v4.4 — a simulated winter, on a button (2026-09-21)

- **Simulated data** next to "Refresh now": invents a storm week over the
  real region and tour lists and fills every panel — snow depth, new snow,
  avalanche danger with problems, bulletins, powder alerts, the trip
  planner's five days and lift status. A banner and the freshness chip say
  it is not a forecast, and each simulated bulletin says so in its own text.
- It runs entirely in the browser (`public/simulate.js`): the service is
  asked for nothing, told nothing, and no alert is sent. "Refresh now" ends
  it and loads the live data; the 10-minute auto-refresh pauses while it is
  on, so it stays until you leave it.

## v4.3 — the tour editor inside the tool, as a preview (2026-09-21)

- The service serves the editor at **/editor**, linked from the Tours card.
  It is a read-only preview: every part is visible and the example tour is
  loaded, but loading a track, adding photos or saving files opens a dialog
  saying it is not wired up yet. Writing into a running service needs a way
  to sign in first; until then the standalone `editor/tour-editor.html` on
  your own computer makes the files.
- The page itself is one file in both places: the service marks the copy it
  serves with `window.FJALLSKRED_PREVIEW`.

## v4.2.1 — tests no longer reach the internet (2026-09-20)

Fixes the red CI run. `test/tour-api.test.js` stubbed Open-Meteo but not
Kartverket, so on a machine with internet access (GitHub's runner) the
synthetic test route was profiled against the real terrain of Lyngen and the
ascent assertion failed. Kartverket is now stubbed, and every test's fetch
refuses any request except to its own server: an unstubbed upstream call
fails loudly instead of quietly depending on the network.

## v4.2 — photos, descent aspect, own tracks in red (2026-09-20)

- **Your photos.** The tour editor takes photos, reads position, height,
  camera direction and time from their EXIF, shows them on the track, and
  packs them as `photos/<slug>/` with a `photos.json` into the .zip. Images
  are resized to 2048 px and saved without metadata; positions live only in
  `photos.json`, and only for photos you leave "on the map".
- The main tool reads `data/photos/<slug>/` (mounted read-only, no rebuild)
  and shows them first in the tour panel, numbered and in red, with a marker
  and camera-direction cone on the route map. New endpoints
  `/api/own-photos` and `/api/own-photo`, serving only listed files.
- **Descent aspect** as a compass rose: small in the tour list, large in the
  tour panel ("Descent aspect", with a note when it is still "varied").
- **Your own GPX tracks** are marked in red in the tour list (`--own`, the
  ramp's red step, a shade apart from the alert red).
- `docker-compose.yml` mounts `./data/photos`; create it with
  `mkdir -p data/photos` on the Pi.

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
