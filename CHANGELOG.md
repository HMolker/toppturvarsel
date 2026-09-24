# Changelog

Every version is a git tag. To go back to one: `git checkout <tag>` and
`docker compose up -d --build` (see INSTALL.md, step 10).

## v5.7.3 — no target average in Find runs (2026-09-25)

- The "Average about °" setting is gone: too fine a control. Runs are now
  simply as long as the terrain allows inside the angle band (rider skill
  or your own min and max), less what the settings ask to avoid. Each run
  still shows its average and steepest angle.

## v5.7.2 — runs stay inside the marked area (2026-09-25)

- Find runs searched all the terrain it had loaded, which is whole map
  tiles and reaches up to a tile beyond the box on each side, so runs could
  lie outside the area marked. Now only cells inside the box are used, for
  the runs and their run-outs.

## v5.7.1 — remove descents from a tour (2026-09-24)

- The tour's descents are listed under the tour buttons, each with its
  length and a **×** to take it out of the tour (drawn ones and found runs
  alike). A tour already built says to press Build tour again.
- In the found-runs list, a run in the tour shows **Remove from tour**
  instead of Add; a run is never added twice. After a new search, runs from
  the earlier one that are still in the tour are named "Earlier run n".

## v5.7.0 — find runs in an area (2026-09-24)

- **Find runs in an area**, on Plan a tour: click two corners of an area
  (up to 6 km across) and the best descents in it are found and numbered on
  the map, with length, vertical, average and steepest angle and aspect.
  **Add as descent** / **Use all as the tour's descents** hands them to the
  tour builder: set the start, Build tour, and "when to go" works as before.
- How: the terrain as one-way network from high to low, one pass from the
  top down keeping the best-scoring line to each cell; a metre scores most
  near the average angle asked for, every metre in the band counts (so runs
  are as long as the terrain allows), and what the settings ask to avoid
  costs. The best line is taken, the ground near it facing the same way set
  aside, and the next found.
- **Run settings** (kept in the browser): rider (easy / intermediate /
  advanced / expert set the angles), runs to find, min and max angle,
  average about, max angle on today's problem aspects and heights (from the
  bulletin), run-out allowed below the min angle, min vertical, runs apart
  (m) or aspects apart (°), traverse off the fall line, and — as checkboxes —
  avoid convex rolls (danger 2+ with a slab problem), avoid NVE runout
  zones, avoid terrain traps (gullies), avoid lines narrower than a width,
  and keep a distance below cornices on lee slopes of a wind slab. Cliffs
  (45°+) and the ground next to them are never used.
- Each run says what shaped it: capped on a problem slope, crosses a convex
  roll, in a runout zone or a gully, narrow, or an average away from the one
  asked for because nothing closer exists there.
- **Demo: Städjan** marks the area around Städjan (Idre) and searches it —
  free terrain in Sweden (Lantmäteriet or GLO-30).

## v5.6.2 — Sweden's terrain at 30 m without Lantmäteriet, and faster (2026-09-24)

- **Copernicus GLO-30 replaces Open-Meteo's 90 m heights.** The same
  Copernicus model at 30 m instead of 90 m, read from its free public
  files on Amazon's open-data store the way Lantmäteriet's are read: only
  the pieces needed, kept a year, no key and no daily limit (a courtesy cap,
  `GLO30_DAILY_MB`, 2000). Order of sources: Lantmäteriet 1 m (Sweden, with
  a login) → Kartverket 1–10 m (Norway) → GLO-30 → Open-Meteo last. GLO-30
  costs no height budget, so building a tour and the 3D view in Sweden are
  no longer slowed down or refused by Open-Meteo's limits, and slopes and
  routes follow 30 m terrain instead of 90 m.
- The TIFF reader also reads LZW files and a file's own GeoTIFF placement.
- **Three terrain requests at a time** instead of one after another
  (`TERRAIN_PARALLEL`), so a new area loads faster.
- `/api/terrain/zone` says which Swedish source is in use (`sweden`) and
  GLO-30's state (`glo30`); the page credits it.

## v5.6.1 — pages no longer wait for the Swedish resort list (2026-09-24)

- **Forecast accuracy stuck on "loading…"**: the page's cells include the
  ski resorts, and asking for the resorts waited for OpenStreetMap whenever
  the Swedish list was due — an Overpass query for all of Sweden, which can
  take minutes. Since v5.5.3 refused an empty answer, that wait came back
  every 15 minutes. Now a list being fetched is waited for 3 seconds at most;
  meanwhile the last list (or the built-in one) is served and the real one
  replaces it when it arrives. The same fixes the resort layer on the
  conditions page taking minutes to show the Swedish resorts, and the first
  map tiles waiting for it. The page asks again a minute later.

## v5.6.0 — find any place; the sketch map is back (2026-09-24)

- **Find a place**, on the conditions page and on Plan a tour: any name in
  Norway (Kartverket's place names) or Sweden (OpenStreetMap's Nominatim),
  searched on Enter, listed under the box with what it is and where. Listed
  tours and resorts come first, as before.
- **Plan a tour anywhere with a name**: choosing a place adds the 12 km
  around it to the service area, so the map, NVE layers and terrain work
  there, and puts a pin on it. Only places the server itself found by name
  can be added (30 a day, 300 in all), so it is still not an open proxy.
  From the conditions page, **Plan a tour here** opens Plan a tour at the pin.
- **The conditions map is a sketch again**, keeping the pan and zoom: no
  shaded map tiles under the data. By default the land around each forecast
  region is coloured by its **snow base** and the region's circle by its
  **new snow over 48 h**; the other layer is **Avalanche danger**. (The
  separate "Snow depth" and "New snow 48h" buttons are now this one layer.)

## v5.5.3 — the Swedish ski resorts come back (2026-09-24)

- An OpenStreetMap (Overpass) server that answers the Sweden query with
  nothing — no error, just an empty list — was kept for 30 days as "Sweden
  has no ski resorts", so they vanished from the map (and from the service
  area around them). A Swedish list shorter than 20 resorts is now treated
  as a failed answer: the last good list, or the built-in list of 41, is
  shown, and OpenStreetMap is asked again after 15 minutes. A short list
  already cached by an earlier version is thrown away on start, so the Pi
  heals itself after the update. (`RESORTS_SE_MIN` sets the threshold.)

## v5.5.2 — gentler on Open-Meteo, and says why Sweden is coarse (2026-09-24)

- **Open-Meteo is paced and rested.** Its free service counts every point
  and refuses (429) past its per-minute and daily limits; a tour in Sweden
  without Lantmäteriet asked for ~16 000 heights at once and every tile
  failed. Heights now go at most `OPEN_METEO_POINTS_PER_MIN` (500) a minute,
  and after a 429 Open-Meteo is left alone for 2 minutes, doubling up to an
  hour, with a plain message instead of a stream of refusals.
- **Lantmäteriet is rested after a failure** (a refused login, an order not
  yet active, the download cap) for 10 minutes instead of being retried for
  every tile, and the reason is carried into the error the page shows.
  `/api/terrain/zone` reports `lantmateriet.usable`.
- **Tours in Sweden on the 90 m fallback ask for fewer, coarser tiles**
  (at most 16, one zoom coarser — finer adds nothing to a 90 m model), and
  the tour builder checks whether Lantmäteriet is answering before it plans.
- Tiles refused with 429 are asked again after two minutes instead of only
  after a reload.

## v5.5.1 — Sweden no longer eats the height budget (2026-09-24)

- **Lantmäteriet first, wherever it may have ground.** A tile's country
  comes from the nearest listed tour or resort, so Swedish terrain near the
  border could be taken for Norway: it was then asked of Kartverket (which
  has nothing there), then of Open-Meteo, and charged to the daily budget
  twice over. With a Geotorget login, Lantmäteriet is now tried for every
  point that is not known to be elsewhere; outside Sweden it has no file,
  and that answer is cached.
- **Only heights that go to a point service are charged.** The budget used
  to be charged for every new point before asking anyone, including points
  Lantmäteriet then answered for free. Now it counts what actually went to
  Kartverket or Open-Meteo, and stops before asking them when the day's
  budget would be exceeded.
- Plan a tour says so in the status line when you look at Sweden and the
  server has no Lantmäteriet login (heights are then 90 m and come out of
  the budget).

## v5.5.0 — when to go, and a real map on the conditions page (2026-09-24)

- **When to go**, under a built tour on Plan a tour: pick a day and the tour
  is laid out on it — when to leave, when you are at the top and bottom of
  each descent, when you are back — keeping it in the light and every
  descent off before wet snow on its aspect, with the best weather among
  those. A 24-hour strip shows light, legs, descents and where wet snow
  starts; warnings say plainly when a descent cannot be off in time or the
  tour does not fit in the day. Built on the planner's daylight, hourly
  weather and wet-snow rules, so the two agree.
- **Try another order of the descents**, when the plan has a descent on wet
  snow: every order is tried with new legs between the descents, timed on
  the day, and the best offered when it saves 15 minutes or more on wet snow
  — e.g. the south face first while it is still frozen. *Use this order*
  rebuilds the tour; descents keep their own names. When the wet snow is a
  thaw that softens every aspect, it says so instead.
- **The conditions page map is a real map** — the same one as Plan a tour —
  with the regions, tours, resorts and huts on top, grey tiles underneath.
  Drag or pinch to move, Ctrl/⌘ + scroll to zoom, the page still scrolls.
  Replaces the schematic outline.
- The tile proxy now also serves OpenTopoMap's overview (zooms 4–8) for the
  Nordic mainland only (~700 tiles), which the new map needs far from tours.

## v5.4.0 — build a whole tour, and one frame for every page (2026-09-24)

- **Build a tour** on Plan a tour: *Set start*, *Add descent* (two or more
  points down each line you want to ski, as many descents as you like),
  *Undo last point*, *Build tour*. Descents stay as drawn; the legs between
  them are found — start to the first descent, the bottom of each descent to
  the top of the next, and back to the start, skiing down where that is the
  way. Replaces "Suggest a way up".
- Each leg is the quickest by the **Munter method** with avalanche terrain
  costing extra: steep ground, slopes facing today's problems at their
  heights, and NVE runout zones (Norway); harder at danger 3+. At danger 1
  problems and runout are ignored, but skin tracks keep off 35°+. Legs are
  routed on a ~40 m grid with NVE's slope map deciding what is steep.
- **Tour numbers** per leg, per descent and in total: length, climb,
  vertical on your descents, Munter time; descents and legs crossing
  today's problems or runout zones marked in red.
- The route's time on the page is now Munter too (was 400 m/h up, 1500 m/h
  down, 4 km/h flat).
- **Same frame on every page:** the forecast accuracy page, Plan a tour and
  the tour editor now have the main page's header, logotype, margins and a
  "← Conditions" button in the same place.

## v5.3.0 — Plan a tour, and a 3D view that costs half (2026-09-24)

- The terrain page is now **Plan a tour** ("Plan a tour" on the Tours card,
  "Plan this tour" in a tour panel). The address stays `/terrain`.
- **3D detail:** *Low*, *Normal* (default) or *High*, each shown with what it
  would cost today before anything loads. Normal loads the whole area coarse
  and a corridor about 150 m either side of the route two zooms finer: for a
  5 km tour 2 300 new heights where v5.0 took 4 600, and twice as sharp along
  the route. High goes three zooms finer along the route (74 m at 61°N) for
  3 800, where v5.0 needed 12 100 for that. Terrain already loaded is free,
  and a level that needs more than today's budget says so instead of loading
  half. Sweden with Lantmäteriet (no point budget) may use three times the
  tiles at every level.
- **Map shading** uses terrain one zoom coarser than the map, drawn smoothly:
  a quarter of the heights per screenful (about 1 700 instead of 7 000),
  which was what emptied the daily budget. At the closest zoom the cells are
  still 37 m (29 m in the far north).
- The status line shows how much of the day's height budget is left once
  half is used.

## v5.2.1 — v4.19.1 merged into the v5 line (2026-09-24)

A combined release: v5.2.0 plus the one change made on the v4 line after
v5 branched off. Nothing else is new.

- From **v4.19.1**: Lantmäteriet's 635 Swedish lift lines ship in
  `data/lifts-SE.geojson`, so Swedish resort maps draw their lifts without
  any export of your own, and nine positions in the built-in Swedish resort
  list are corrected from them.
- v4.15.3 – v4.19.0 were already part of v5.0.0 (it was built on v4.19.0),
  so the merge brings no second copy of them.

## v5.2.0 — Sweden's terrain at 1 m, from Lantmäteriet (2026-09-23)

- With a Geotorget login that has ordered *Markhöjdmodell Nedladdning*
  (`LANTMATERIET_USER` / `LANTMATERIET_PASSWORD` in `.env`), Swedish terrain
  comes from Lantmäteriet's 1 m model instead of Copernicus' 90 m: slope
  shading, route profiles (now a 10 m cross in Sweden too), suggestions, the
  3D view (finer, up to 80 terrain tiles) and tour contours. © Lantmäteriet,
  CC BY 4.0.
- The files are found through Lantmäteriet's open STAC catalogue and read in
  512 × 512 blocks by HTTP range requests, from the coarsest overview fine
  enough for the job; Cloud-Optimized GeoTIFF with DEFLATE and the
  floating-point predictor, decoded without a library (checked against a
  real file's header and a file written by libtiff,
  `test/fixtures/make-cog.py`). Blocks are cached on disk for a year;
  `LANTMATERIET_DAILY_MB` (default 1000) caps a day's downloads.
- A refused login (401), missing access (403) or an outage falls back to
  Copernicus, and the terrain page says why.
- Fixed on the way: the coordinate conversion rounded to whole metres, fine
  for the 1 km snow grid but not for a 1 m terrain model; it now has an
  unrounded mode.

## v5.1.0 — weather on the route, GPX in and out (2026-09-23)

- **Weather on the route:** once a route is measured, MET Norway's hourly
  forecast (the one behind yr.no) for the start and the highest point, each
  at its own height: every two hours for the next day and a half,
  temperature, wind and gusts with direction, precipitation as snow or rain,
  and a summary per point. Strong wind in bold red. New endpoint
  `POST /api/terrain/weather` (one or two points, service area only);
  answers kept until MET's `Expires`, re-asked with `If-Modified-Since`, the
  last answer shown (marked older) if MET is down. © MET Norway, CC BY 4.0.
- **Import GPX:** track, route or waypoints from any GPX file, read in the
  browser and never uploaded; long tracks thinned to 150 points; the file's
  track name becomes the route name. Covers Garmin: export the activity from
  Garmin Connect as GPX.
- **Export GPX:** the route as a track and as a route, with measured heights
  and no timestamps, named after the route.
- The browser check (`demo/terrain-check.mjs`) now covers the weather box and
  a GPX round trip.

## v5.0.0 — terrain & routes (2026-09-23)

A new page, **/terrain** ("Terrain & routes" on the Tours card, "Terrain &
3D" in every tour panel), a page of its own like the tour editor:

- **A pannable, zoomable map** with **NVE's slope and runout map** for
  Norway (slope from 27°, three runout zones; © NVE, CC BY 4.0), through the
  tile proxy as `/tiles/nve/…`.
- **Computed shading** from the terrain model: slope angle (the slope layer
  for Sweden), aspect, or today's problems (25°+ ground facing the
  bulletin's problem aspects, at their heights).
- **Draw a route** and see what it crosses: distance, climb, time, a profile
  coloured by the slope of the ground under it, metres per slope class,
  every 30°+ stretch with aspect and heights, a rose of the steep aspects,
  the stretches in today's avalanche problems, and NVE runout zones crossed.
- **Suggest a way up**: a least-cost line on skins that keeps off steep
  ground, runout zones and today's problem slopes where it can. Marked
  unverified.
- **3D view** of the route's area in WebGL, map and overlays draped over it.
- Routes kept in the address bar and in this browser; a tour's own route can
  be taken over as yours.
- New endpoints `GET /api/dem/{z}/{x}/{y}`, `POST /api/terrain/profile`,
  `GET /api/terrain/zone`, limited to 12 km around the tours and resorts, with
  a daily height budget (`TERRAIN_DAILY_POINTS`, default 60 000) and a year's
  disk cache.
- **Prepared for v5.1:** Import GPX / Export GPX buttons and a "Weather on
  the route" box (start and highest point) are in place, switched off; the
  plan is in `docs/v5.1.md`.
- `demo/terrain-check.mjs`: the page driven offline in a headless browser
  against made-up terrain, with screenshots.
## v4.19.1 — Sweden's lifts, from Lantmäteriet (2026-09-23)

- `data/lifts-SE.geojson` now ships with the app: all 635 *Lintrafik* lines
  (lifts, gondolas, funiculars) from Lantmäteriet's Topografi 50, converted
  from SWEREF 99 TM to WGS 84. © Lantmäteriet. Every Swedish resort map is
  checked against it with nothing to set up — lifts it knows and
  OpenStreetMap does not are drawn and counted, as Kartverket's register
  already does for Norway.
- The lines carry no names in that dataset, so the facts say how many are
  missing rather than naming them.
- Nine resorts in the built-in Swedish fallback list had positions off by 2
  to 8 km; they are now taken from the mapped lifts themselves (Åre Björnen,
  Björnrike, Storhogna, Tänndalen, Kläppen, Orsa Grönklitt, Hassela,
  Branäs, Ski Sunne).

## v4.19.0 — forecast accuracy, as a tool of its own (2026-09-22)

- New page at **/skill**, linked from the resorts box: how good the forecast
  has actually been, by lead time and by place.
  - A slider for 1, 3, 5, 10 and 15 days ahead.
  - New snow (and whether 5 cm fell), temperature, sun and cloud, wind —
    and **all four** as one weighted score (snow 40 %, temperature 25 %,
    wind 20 %, cloud 15 %).
  - A map of 25 km cells, coloured by skill, click one for its record.
  - Skill against forecast length, per cell and across every cell.
- Every morning the server keeps the 16-day forecast for each cell holding a
  tour or a resort, and scores the older ones against the analysis that comes
  back in the same request. Scores are against climatology — the error of
  saying "normal for the time of year" — so 0 means no better than knowing
  the season and 1 means perfect.
- Nothing is shown before a cell has 30 scored days and a climatology to
  compare with. Until then, and on the Sample data button, the page shows
  made-up figures of a realistic shape, clearly marked.
- Settings: `SKILL_VERIFY=on|off`, `SKILL_HOUR=6`, `SKILL_MIN_CASES=30`.
  Stored in `data/cache/verify/`, a few MB a season.
- New `GET /api/skill`.

## v4.18.1 — the Swedish resorts are back (2026-09-22)

- The Swedish resort list comes from one big OpenStreetMap query, and
  v4.15.4 gave it the lowest priority: after any Overpass failure it was
  turned away for ten minutes without even trying, so on a Pi where
  OpenStreetMap is unreliable the Swedish resorts disappeared. It is now
  treated as something a person is waiting for, not background work.
- A list that fails is not retried on every page load, only every 15
  minutes, and the last good list is served however old it is.
- If OpenStreetMap has never answered, a built-in list of 41 Swedish
  resorts stands in (positions approximate, marked as such in the panel)
  until it does. Sweden is never empty again.
- "Data sources & freshness" now has a Ski resorts card: how many resorts
  came from where, and whether the list is stale, with the error.

## v4.18.0 — lifts checked against the national maps (2026-09-22)

- **Norway:** every resort map is now checked against Kartverket's
  place-name register (SSR), which holds each lift's official name and
  position. Lifts it knows and OpenStreetMap does not are ringed in red on
  the map, named, and listed in the fun facts ("9 lifts registered with
  Kartverket, 7 matched · missing from OpenStreetMap: Olaheisen,
  Roniheisen"). No key, nothing to set up. © Kartverket, CC BY 4.0.
- **Sweden:** Lantmäteriet's lift lines (Topografi 50, object type
  Lintrafik) need a Geotorget account and come as a GeoPackage, so they
  cannot be fetched automatically. Export them once to
  `data/lifts-SE.geojson` (WGS 84) and every Swedish resort map uses them
  the same way — as drawn lines where OpenStreetMap has nothing. The same
  works for Norway with an N50 export in `data/lifts-NO.geojson`. See
  README, "National lift data".
- Stored resort maps are rebuilt by the night scan after this upgrade.

## v4.17.0 — lifts only on the resort map, and honest counts (2026-09-22)

- The ski-area map now draws **only the lifts**. Which ways belong to which
  run, and how they are graded, is too uneven in OpenStreetMap to draw
  honestly. With the runs gone the map frames on the lift network, so it
  zooms in much further.
- Lifts are searched for much harder: the ski area's own boundary is asked
  for first and everything inside it is taken, the circle around the resort
  grew from 4 to 7 km, funiculars count as lifts, and any lift meeting an
  accepted one end to end is followed — so linked areas come out whole
  while a neighbouring resort's lift stays out.
- Fun facts say plainly that the OpenStreetMap numbers are an estimate, and
  the resort's own counts from Fnugg are shown first with the difference
  ("9 lifts reported, 7 mapped — 2 missing from OpenStreetMap").
- After an upgrade the night scan refetches every resort once, then goes
  back to refreshing maps older than 30 days (`RESORT_MAP_MAX_AGE_DAYS`),
  so most nights it finds nothing to do.

## v4.16.0 — ski-area maps stored, refreshed at night (2026-09-22)

- A night scan (01:00–05:00 Norwegian time) goes through every ski
  resort and stores its map, fun facts and snow history, so opening a
  resort in the day is instant. Resorts never fetched go first, then the
  oldest. It waits a minute between resorts, uses OpenStreetMap at the
  lowest priority, and pauses when OpenStreetMap is failing.
- A stored map is kept for 90 days (was 30), then refetched. A map older
  than that is still shown at once while a new one is fetched behind the
  scenes.
- "Data sources & freshness" has a new card: how many resorts are stored,
  the oldest, how many are left, and how last night went.
- Settings (in `.env`): `NIGHT_SCAN=on|off`, `NIGHT_SCAN_HOURS=1-5`,
  `NIGHT_SCAN_GAP_S=60`, `RESORT_MAP_MAX_AGE_DAYS=90`.

## v4.15.4 — ski-area maps no longer wait behind background work (2026-09-22)

- The resort panel could sit on "Counting runs and lifts in
  OpenStreetMap…" for many minutes: its request waited in line behind the
  background jobs (deriving every tour's route, the huts layer, the Swedish
  resort list), which are slow when OpenStreetMap's servers are busy.
- The OpenStreetMap queue now has priorities: a ski-area map goes first, a
  tour's route next, background work last.
- A ski-area map gets at most 75 s, waiting included, and then says why it
  failed, with Try again. The panel counts the seconds while it waits.
- When every OpenStreetMap server has failed, background work pauses for
  10 minutes (the route warm-up for 30) instead of queueing more requests.
  A click still tries at once.
- An expired ski-area map is shown, marked with its date, when a fresh one
  can't be fetched. Two clicks on the same resort share one lookup.
- New `GET /api/overpass` shows what the queue is doing.

## v4.15.3 — tour photos found again (2026-09-22)

- Every request to outside services now identifies the app with a contact
  link (`Fjallskred/4 (...; +https://github.com/HMolker/toppturvarsel)`).
  Wikimedia Commons refuses requests without one, which is why no tour
  found any photos.
- An empty or failed photo search is retried after 6 hours instead of
  being kept for 7 days, so the old empty results clear themselves.
- When a tour has no photos, the panel says why: Commons unreachable
  (with the reason), Flickr unreachable, or Flickr not searched because
  no `FLICKR_API_KEY` is set (a free key adds many more photos).

## v4.15.2 — huts in simulated mode (2026-09-22)

- Simulated mode shows the huts & cafés layer even when the real list from
  OpenStreetMap can't be loaded: about one made-up place per tour, of every
  kind and winter status, marked as simulated in the legend and panel. The
  real list is used whenever it is available.
- The legend says why the real list failed, when it does.

## v4.15.1 — gentle with OpenStreetMap's servers (2026-09-22)

- Every Overpass request (tour routes, ski-area maps, huts, Swedish
  resorts) now goes through one queue: one request at a time, at least
  3 s apart. A 429 "too many requests" or 503/504 gets one wait (the
  server's Retry-After, else 15 s) and a retry before the next instance;
  an instance that refuses connections is rested for 30 minutes (tried
  last). overpass-api.de refusing the Pi (ECONNREFUSED) after bursts of
  route lookups at each restart was the likely reason ski-area maps did
  not load.
- A proper User-Agent with a contact link on every request.

## v4.15 — snow history for resorts, sturdier OpenStreetMap requests (2026-09-22)

- **Snow depth this winter** in the resort panel too: the same graph as
  for tours, at the resort's own point (`/api/snowhistory?resort=<id>`).
- **OpenStreetMap requests try three public Overpass servers** in turn
  (overpass-api.de, overpass.kumi.systems, overpass.private.coffee) when
  one is busy, refuses or cannot be reached; used for the ski-area maps
  and the huts layer. Errors now say why ("fetch failed" came with no
  reason) and the resort panel has a "Try again" button.
- Resort areas mapped as multipolygon relations are recognised too.

## v4.14.1 — no more stale code after an update (2026-09-22)

- JavaScript and CSS were cached by the browser for an hour. After an
  update the page could keep running old modules (or a mix of old and
  new), so new sections such as the snow-depth graph and the ski-area map
  did not appear. Code and styles are now revalidated on every load, with
  an ETag so an unchanged file costs a 304.

## v4.14 — huts, mountain lodges and remote cafés (2026-09-22)

- **New map layer "huts & cafés"**, shown when zoomed in: from
  OpenStreetMap, within 15 km of the tours:
  - DNT, STF and other cabins (tourism=alpine_hut), open huts and shelters
    (wilderness_hut), mountain lodges by name (fjellstue, fjellstove,
    fjellhotell, turisthytte, fjällstation, fjällstuga, seter …);
  - cafés and restaurants only when remote: at least 3 km from any
    village, town or city. Bars, pubs and fast food never.
  Places open in winter are highlighted in the profile's red; unknown ones
  are plain ("check"), summer-only ones faded. "Open in winter" is read
  from OSM's opening_hours and seasonal tags; most places don't say, and
  the panel says so.
- **Click a place** for a panel like a tour's: type, who runs it (DNT /
  STF), winter opening and hours, height, beds, fee, avalanche region,
  tours within 15 km with today's score, and links (website, a search on
  ut.no or STF's site, OpenStreetMap).
- **Tour panels** list the huts and cafés within 8 km.
- `GET /api/huts`: one Overpass request for all tours (clustered), cached
  30 days; the last good list is kept if Overpass is down.

## v4.13 — the ski area in detail, in the profile's colours (2026-09-22)

- **Runs by difficulty in the Molker ramp:** novice pale (#FBD6CB), easy
  pink (#F4A891), intermediate red (#C2402A), advanced maroon (#6E1E15),
  expert black; freeride and ungroomed runs dashed. Runs have a thin dark
  casing so the pale steps read on the map; floodlit runs carry a line of
  light dots.
- **Much more from OpenStreetMap:**
  - lifts: pylons as dots on the cable, named stations with their height,
    lift numbers and names along the cable, and per lift the type, seats
    per chair or cabin, capacity, ride time (minutes, "6:30" or PT4M30S),
    bubble, heated seats, detachable grip;
  - runs: numbers and names as badges in the run's colour, grooming
    (groomed, moguls, not groomed), floodlights, snowmaking, glades;
  - cross-country trails, sledging runs, snow parks, the resort's own area
    (landuse=winter_sports), which also keeps a neighbouring resort's
    lifts out, and restaurants, cafés, bars, ski rental and ski schools.
- **Resort panel:** fun facts now include floodlit and snowmaking km,
  off-piste lines, pylons, seats per cycle, cross-country km and what is
  around the slopes; below them a table of **every lift** (from → to
  station, type, seats, length, rise and top height, people per hour, ride
  time, notes), a list of **every run**, and the **places on the mountain**.

## v4.12 — ski-area maps and fun facts (2026-09-22)

- **Ski-area map** in the resort panel: runs and lifts from OpenStreetMap
  over the same grey topo map and contours as a tour. Runs in muted piste
  colours (novice green, easy blue, intermediate red, advanced/expert
  black, freeride dashed brown), lifts as thin ink lines with cross ticks
  and their stations (drag lifts dashed). Hover for name, type, length and
  capacity. The map zooms to fill the frame with the ski area.
- **Fun facts** from the same data: runs by difficulty and km of piste,
  lifts by type, uphill capacity (from the lifts that have it mapped),
  vertical and top station, longest run, longest lift, the biggest climb
  in one lift. Labelled as OpenStreetMap's figures.
- **Website** link at the top of the resort panel as well as the button.
- `GET /api/resortmap?resort=<id>`: one Overpass request per resort,
  elevations for the contours and lift stations, cached for 30 days.

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
