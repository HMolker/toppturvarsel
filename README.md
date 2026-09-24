# Fjällskred

<img src="public/brand/logo.png" alt="Fjällskred — Molker Digital free-touring monitor" width="220">

*Molker Digital · free-touring monitor.* (The code, Docker service and
environment still use the working name `toppturvarsel`.)

A self-hosted web service for ski touring in Norway and Sweden. It pulls live
avalanche bulletins and modelled snow depth several times a day, shows them on
a map against a curated list of touring objectives, and emails or pushes you
when a region gets loaded.

No account, no tracking, no third-party frontend dependencies. One Node
process, zero npm dependencies, one Docker container.

---

## What it actually does

- **Avalanche danger** for all 24 Norwegian forecast regions (NVE / Varsom)
  and the 6 Swedish ones (Naturvårdsverket), with the avalanche problems,
  mountain weather, snow surface and the forecaster's summary of recent
  observations and avalanche activity.
- **Snow depth and new snow** from NVE's seNorge 1 km model grid, sampled at
  **each tour's own coordinates** rather than a region centroid — so
  Rørnestinden gets Rørnestinden's snow, not the fjord's.
- **91 curated tours** with difficulty and quality ratings, filterable and
  sortable by how much snow just fell on them, each marked with whether a
  GPX track is available (your own, or a route from OpenStreetMap).
- **Country selection** as the first filter: pick Norway, Sweden or both, and
  the map re-frames while the tours, planner, resorts and alerts follow.
- **Powder alerts** by email and phone push when new snow over 48 h crosses
  your threshold, with the current danger level and problems in the message.

## Look

The interface uses Henrik Molker's graphical profile, which comes from the
figures in his 2019 Chalmers thesis. It follows the profile's own grammar:

- **Ink, steel grey and paper white** carry the data. Snow depth is a
  grayscale ramp, and tours are ink markers.
- **The white-to-maroon ramp** (Fig. 26) shows new snow over 48 h. The 30 cm
  alert threshold falls on the red step.
- **Signal red `#C0392B`** is used only for the critical point: regions and
  tours over the alert threshold.
- **Avalanche danger keeps the EAWS standard colours** (green, yellow, orange,
  red, black). This is the one deliberate exception, because a safety scale
  everyone in Europe reads the same way is not the place for a house style.

The profile is a light, print-style look. The dark theme is derived from
the same inks for early-morning checks.

The Fjällskred logotype sits at the top left (`public/brand/`). It is
drawn on paper, so the dark theme shows it on a paper tile rather than
inverting it. The favicon is the logo's mountain, cropped.

Type is IBM Plex Sans, with Plex Mono for labels. Nothing is fetched from
a third party at runtime. Plex is used if it is installed on the viewer's
machine or placed in `public/fonts/` (see the README there). Otherwise the
page falls back to Helvetica/Arial.

## Quick start

On a Raspberry Pi: follow **[INSTALL.md](INSTALL.md)**, step by step.

```bash
git clone <your-repo> toppturvarsel && cd toppturvarsel
cp .env.example .env
$EDITOR .env                 # at minimum, set up one alert channel
docker compose up -d --build
```

Then open <http://localhost:8080>.

The first refresh starts on boot. Out of season it skips upstream entirely, so
if you start this in September you will get an empty map and a banner saying
so — that is correct behaviour, not a failure. Force a fetch with:

```bash
docker compose exec toppturvarsel node src/cli-refresh.js --force
```

### Without Docker

Node 22 or newer, then:

```bash
npm start            # serve on $PORT (default 8080)
npm run refresh      # one-shot fetch, useful from host cron
npm test             # 111 tests, no network needed
```

## Routes, elevation and forecast

Selecting a tour opens a topo map with its route, an elevation sketch that
follows your cursor along the route, and a 5-day summit forecast.

- **Routes come from OpenStreetMap.** The service finds the tour's summit
  in OSM by name, then follows OSM's mapped path network back to the
  nearest road, car park or hut. Every point on the line is a real mapped
  path vertex. Routes made mostly of `piste:type=skitour` ways are labelled
  as ski routes. Everything else is labelled a *summer path*, because that
  is what most mapped paths are, and the ski line often differs near the
  top. Routes are derived once and cached for 30 days.
- **No invented lines.** If no mapped path comes within 600 m of the
  summit, or the paths don't connect to a road, car park or hut, no line
  is drawn and the page says why. A path that stops short of the summit
  is drawn to where it stops, and the gap is given in metres. A guessed
  line into mountain terrain, or a GPX file of one, is worse than none.
  The 7 area tours (Sulitjelma, Hemavan, …) have no single line.
- **Your own tracks win.** Put `data/tracks/<slug>.gpx` in place and it
  replaces the OSM route, including its own elevations (see
  `data/tracks/README.md`). There is deliberately no upload endpoint.
- **Elevation profile:** in Norway, Kartverket's national terrain model
  (1 m DTM where it exists, else 10 m), so summits and gullies keep their
  shape. In Sweden, and to fill any gap, Copernicus DEM GLO-90 via
  Open-Meteo, which is a sketch: 90 m cells round off summits and ridges.
  One sample per ~50 m. Neither is used for slope angles, which matter for
  avalanches; use the Varsom slope-angle map for those.
- **Contour lines:** a 24 × 20 elevation grid around the tour (same
  sources, cached 30 days) is turned into contours in the browser
  (`public/contours.js`, marching squares): 25, 50 or 100 m apart
  depending on relief, with labelled index lines. They are drawn *under*
  the map tiles. Where the topo tiles load, you see the tile's own finer
  contours. Where a tile fails, the map is still readable.
- **Photos near the summit:** up to 8 openly licensed, geotagged photos
  within 5 km, from Wikimedia Commons, nearest first. Each card says
  where it was taken from ("1.2 km NE of the summit"), links to its
  Commons page and carries the author, licence and date. Hovering a card
  highlights its numbered marker on the map, and the reverse. Photos
  without a licence, and maps, logos and diagrams, are left out.
  Thumbnails go through the server (`/api/photo?tour=…&i=…`), looked up
  from its own cache by index, so no URL can be passed in. Cached 7 days.
  Why not Google image search: there is no image search API for this,
  scraping results is against the terms, and search results carry no
  licence or author you could credit.
- **Forecast:** Open-Meteo daily values (MET Nordic, the yr.no model, where
  it covers; ECMWF elsewhere), downscaled to the summit's elevation. It
  shows sky, max/min temperature, new snow, precipitation, wind and gusts,
  and the daytime 0° level. Cached for 2 hours.
- **Map tiles:** Kartverket's greyscale topo (`topograatone`) in Norway,
  OpenTopoMap in Sweden. The server fetches them and caches them for 30
  days, so the route is the only strong mark on the map.

Because the Pi is reachable from the internet, all of this is locked to the
tours in `data/tours.json`. Routes and forecasts are looked up by tour name
only, never by arbitrary coordinates. Map tiles are served only within
about 12 km of a listed tour, at zoom 9–16. Otherwise the service would be
a free Overpass, Open-Meteo and tile relay for anyone who found the port.

Data: route © OpenStreetMap contributors (ODbL; exported GPX carries the
licence) · map and Norwegian elevation © Kartverket (CC BY 4.0) /
OpenTopoMap (CC-BY-SA) · other elevation Copernicus DEM via Open-Meteo ·
forecast Open-Meteo (CC BY 4.0, free for non-commercial use) · photos
Wikimedia Commons, each under its own licence, credited on the card ·
Norwegian resort status Fnugg · Swedish resorts © OpenStreetMap contributors.

## Terrain & routes (v5)

`/terrain` (**Plan a tour**), linked from the Tours card and from every tour
panel ("Plan this tour"), is a page of its own, like the tour editor. It is the
Skida / FATMAP part of Fjällskred:

- **A map you can pan and zoom** (no library): Kartverket's grey topo in
  Norway, OpenTopoMap in Sweden, through the same tile proxy as the rest.
- **NVE's slope and runout map** (Norway and Svalbard): slope angle from 27°
  in six classes and the three avalanche runout zones, from the 1 m / 10 m
  terrain model. © NVE, CC BY 4.0. It comes through the tile proxy as
  `/tiles/nve/{z}/{x}/{y}.png`; tiles with nothing drawn are remembered.
- **Computed shading**, worked out in the browser from a terrain grid:
  slope angle (the only slope layer in Sweden), aspect in eight colours, or
  **today's problems** — ground of 25° and more facing the aspects, and at
  the heights, of the avalanche problems in the bulletin for the region of
  the nearest tour.
- **Draw a route**: click to add points, drag to move them, drag a small
  ring to add one in between, Delete to remove, Ctrl+Z to undo. The server
  measures it every 25 m (more on long routes), each point with a small
  cross of heights around it, so the slope is the ground's fall line, not
  the route's own gradient. You get distance, climb, time on skins (400 m up
  and 1500 m down an hour, 4 km/h on the flat), the profile coloured by
  slope, metres in each slope class, every stretch of 30° and more with its
  aspect and heights, a rose of which way the steep parts face, which
  stretches meet today's avalanche problems, and (Norway) where the route
  crosses NVE's runout zones.
- **Build a tour** (v5.4): *Set start*, then *Add descent* for each line
  you want to ski (two or more points down it; *Undo last point* takes the
  last click back), then *Build tour*. Your descents stay exactly as drawn;
  the legs between them are found: from the start up to the first descent,
  from the bottom of each descent to the top of the next, and back to the
  start (skiing down where that is the way). Each leg is the quickest by the
  Munter method, with steep ground, today's problem slopes (aspect and
  height) and NVE's runout zones costing extra, much more at danger 3 and
  up. At **danger 1** problems and runout zones are not considered, but skin
  tracks still keep off 35° and steeper. Legs are found on a ~40 m grid (the
  terrain model interpolated, with NVE's 10 m slope map deciding what is
  steep in Norway). The panel gives the tour length, the climb, the vertical
  on your descents and the Munter time per leg and descent and in total,
  and marks in red where a descent (or a leg with no way round) crosses
  today's problems or runout zones. The legs avoid known avalanche terrain;
  they are not a safe route — no cornices, glaciers, small cliffs, forest,
  water or snowpack in the model.
- **When to go** (v5.5): under a built tour, pick a day (today and the
  next four). It lays the tour out on that day: the departure that keeps
  the tour in the light and every descent finished before wet snow starts
  on its aspect (the planner's rule: warming, and spring sun on the
  slope), with the best weather among those, earliest among near-equals.
  You get the time you leave, when you are at the top and bottom of each
  descent (15 min changeovers for skins), when you are back, a 24-hour
  strip of it all, and a plain warning when a descent cannot be off before
  it softens or the tour does not fit in the light. Weather is the summit
  forecast of the nearest listed tour.
- **Try another order of the descents**: shown when a descent in the plan
  runs into wet snow. It tries every order (up to six descents), finds new
  legs between them on the same terrain grid, times each on the day and
  offers the best when it saves 15 minutes or more on wet snow (or all of
  it) — typically skiing the sun-facing descent first. *Use this order*
  rebuilds the tour; each descent keeps its own name. When the wet snow is
  a general thaw (warm air, every aspect), it says that no order can help.
- **Time** everywhere on the page is by the **Munter method**: 1 km of
  distance or 100 m of height is one unit; 4 units an hour skinning and on
  the flat, 10 skiing downhill.
- **3D view**: the area around the route (or the view) as a WebGL mesh with
  the map, the overlays and the route draped over it. Drag to turn, scroll
  to zoom, a slider for height exaggeration. **Detail** (v5.3): *Low* is the
  whole area coarse (~300–600 m cells, ~1 200 heights); *Normal* adds a
  corridor about 150 m either side of the route two zooms finer (~150 m
  cells in southern Norway, ~110 m in the north; ~2 300–4 600 heights);
  *High* goes three zooms finer along the route (~75 / 55 m; ~3 800–7 500).
  Each choice shows what it would cost today before anything loads, and
  terrain already loaded is free.
- Routes live in the page's address (share or bookmark the link) and in a
  list saved in this browser. A tour's own route (your GPX or OpenStreetMap)
  is shown dotted and can be taken over as your route.

**Service area and cost.** Like the tiles, everything covers 12 km around
the tours and ski resorts, so this box never becomes a free elevation
service. Heights come from Kartverket (Norway, 50 points per request) and
Open-Meteo (Sweden, 100 per request); every point asked for counts against
`TERRAIN_DAILY_POINTS` (default 60 000 a day, about 1 200 Kartverket
requests) and past it the page is told to try tomorrow. Terrain grids are
kept on disk for a year (`data/cache/dem/`), so an area costs once. A first
look at a new area takes a while. Map shading uses terrain one zoom coarser
than the map (v5.3), about 6 grid tiles of 289 points a screenful (1 700
heights, a quarter of v5.0's); a suggestion up to 30 tiles; the 3D view as
above.

**Sweden at 1 m (v5.2).** With a Geotorget account that has ordered
*Markhöjdmodell Nedladdning*, set `LANTMATERIET_USER` and
`LANTMATERIET_PASSWORD` in `.env` and Swedish terrain comes from
Lantmäteriet's 1 m model instead of Copernicus' 90 m: the computed slope
shading, the route profile (a 10 m cross, as in Norway), the suggestions,
the 3D view (which may then use up to 80 terrain tiles, so finer cells) and
the tour contours. The server finds the right 10 × 10 km file through
Lantmäteriet's open STAC catalogue and reads only the 512 × 512 blocks it
needs, from the coarsest overview that is still fine enough, with HTTP range
requests; the files are Cloud-Optimized GeoTIFFs (float32, DEFLATE with the
floating-point predictor), decoded without any library. Blocks are kept on
disk for a year (`data/cache/lm/`). `LANTMATERIET_DAILY_MB` (default 1000)
caps what is downloaded a day. If the login is refused (401), the account
has no access yet (403) or Lantmäteriet is down, Sweden falls back to
Copernicus and the terrain page says why. © Lantmäteriet, CC BY 4.0.

To check a login from Windows before putting it on the Pi:
`curl.exe -u USER -r 0-65535 -o head.tif https://dl1.lantmateriet.se/hojd/data/grid/mhm/70_4/m703_40.tif`
must give a 64 KB file, not a 1 KB error page.

**Limits.** Without a Lantmäteriet login the Swedish terrain model is
Copernicus GLO-90 (90 m cells), so short steep faces read flatter than they
are. There is no NVE layer in Sweden either way. The
map shading has 16 screen pixels per cell at every zoom, so it is coarse
zoomed out and finer zoomed in. Runout is read from the colours of NVE's
map along the route, which is a heuristic.

**Weather on the route (v5.1).** Once a route is measured, the panel shows
MET Norway's hourly forecast (the one behind yr.no) for the start and the
highest point, each at its own height, every two hours for the next day and
a half, with the range of temperature, the strongest wind and gusts, and
snow versus rain. Strong wind (15 m/s and over) is in bold red. Answers are
kept per point until MET's `Expires` and re-asked with `If-Modified-Since`;
if MET cannot be reached the last answer is shown, marked as older.

**GPX in and out (v5.1).** *Import GPX* reads a track, route or waypoints
from any GPX file (Garmin Connect, Strava, Suunto, OsmAnd, Fatmap) in the
browser — nothing is uploaded — and thins long tracks to 150 points.
*Export GPX* downloads the route as both a track and a route, with heights
from the measurement and no timestamps, for maps and for watches.

`node demo/terrain-check.mjs <outdir>` runs the page offline against a
made-up terrain (the advert's Hallingdal) in a headless browser and takes
screenshots of each part.

## The map on the conditions page (v5.6)

A sketch — coastline, the Norway/Sweden border and the forecast regions —
that you can pan and zoom (drag or pinch; Ctrl/⌘ + scroll zooms, a plain
scroll scrolls the page). No map tiles: shaded terrain made the data hard to
read. Two layers:

- **Snow** (default): the land around each forecast region (the land nearer
  to it than to any other region, within 110 km) in the region's **snow
  base**, grey scale; the region's **circle** in its **new snow over 48 h**,
  white to maroon, with a red ring over the alert threshold.
- **Avalanche danger**: the circles in the EAWS colours on plain land.

Tours, ski resorts and huts go on top as before. **Find a place** searches
any name in Norway (Kartverket's place names) and Sweden (OpenStreetMap's
Nominatim) on Enter, puts a pin on the map, names the nearest listed tour,
and offers **Plan a tour here**.

## Place search and the service area (v5.6)

The search box on both pages (`GET /api/places?q=`) asks Kartverket's
place-name register for Norway and Nominatim for Sweden, and keeps each
answer 30 days. It searches on Enter only: Nominatim's usage policy allows
no search-as-you-type and at most one request a second, which the server
keeps to. Searching costs no heights and no map tiles.

Choosing a place (`POST /api/places/pick`) adds the 12 km around it to the
service area, like a listed tour, so Plan a tour works there — map, NVE
layers, terrain. Only a place this server found by name can be added, never
arbitrary coordinates, so the tile and height endpoints stay closed to the
rest of the world; at most `PLACES_DAILY` (30) new places a day and
`PLACES_MAX` (300) in all, the least recently used dropped. They are kept in
`data/cache/places-zones.json`; delete it to start over.

## Trip planner

"Where should I go in the coming days?" The planner ranks the tours for
each of the next five days, with a table showing the whole week at once.
You set your maximum difficulty, your maximum avalanche danger and,
optionally, where you are starting from; the settings are remembered in
the browser.

It works in three steps and never blends them into one number:

1. **Avalanche filter.** Danger level against the tour's steepness (its
   difficulty rating stands in for slope angle), and whether the tour's
   aspect and elevation fall inside a problem the bulletin names. Varsom
   publishes, per problem, the aspects (`ValidExpositions`, e.g.
   `11100011` = N, NE, E, W, NW) and the elevation band
   (`ExposedHeight1/2`, `ExposedHeightFill`), so the planner can say
   "inside wind slab (NE/E/SE above 600 m)" rather than just "danger 3".
   Tours that fail are **excluded, not marked down**, and listed with the
   reason, so powder can never outweigh danger.

   | Danger | Passes | Caution | Excluded |
   |---|---|---|---|
   | 1 | everything | | |
   | 2 | everything | difficulty ≥ 3 inside a problem area | |
   | 3 | difficulty ≤ 2 outside problem areas | difficulty ≤ 2 inside, or 3 outside | difficulty 3 inside, and ≥ 4 |
   | 4 | | difficulty 1 outside problem areas | everything else |
   | 5 | | | everything |

   Plus your own maximum danger. No bulletin → "not assessed", never ranked.
   Exception: areas no forecast covers at all (Städjan, Sonfjället,
   Elgåhogna). Gentle tours there (difficulty ≤ 2) are ranked, marked
   caution and "no avalanche forecast · own judgement"; steeper ones are not.
2. **Conditions score 0–100** for what passes: fresh snow and surface
   25 % (new snow over 72 h from seNorge, ageing day by day, plus forecast
   snow; best at 20–40 cm; marked down for warming or wind; spring corn
   counts), **base 20 % (nothing at 20 cm or less, full marks from 100 cm —
   100 cm and 300 cm count the same)**, weather that day 25 % (wind, sky,
   precipitation; capped by strong gusts or a freezing level above the
   summit), tour quality 20 %, fit 10 % (difficulty, and distance if you
   give a start).
3. **Confidence.** High with that day's bulletin and a near forecast.
   Varsom issues about two days ahead; later days reuse the last bulletin
   and say so. Beyond three days it is labelled "weather only".

Hover over a result, or tap its score on a phone, to see how that day's
number was made. The box shows the filter step, each of the five parts
with its value, weight and points, small curves for the fresh-snow and
base rules with the tour marked on them, the sum, the confidence, and the
method in general. The same box opens on the week table's cells, including
excluded ones: there it shows what the tour would have scored, and why
that doesn't count.

**When in the day, and does it fit (v4.8).** With the hourly summit
forecast, "weather that day" is the best stretch of *daylight*, as long as
the tour takes (400 m/h up, 1500 m/h down, plus half an hour), scored hour
by hour: wind × 0.45, cloud × 0.35, snowfall/rain × 0.20, and any hour with
gusts ≥ 17 m/s capped at 0.30. Daylight is civil dawn to civil dusk
(`public/daylight.js`, NOAA's solar equations), so polar-night twilight in
Tromsø counts and midnight sun is kept to 05–23. The planner says "go
08–12"; a tour longer than the light gets half the weather part, and a
margin under an hour is flagged "tight on daylight". The tour's forecast
table shows Daylight, Best window (with a strip of the day's hours) and
Surface.

**Wet snow and the time of day (v4.10).** Warming makes the afternoon the
dangerous part, so the window also looks at temperature and sun. An hour is
a wet-snow hour when the air at the tour's mid-height is above about +1 °C
(the summit forecast plus 6.5 °C per km down to half the vertical), or in
March–June when the sun is on an east-to-west descent aspect under little
cloud (E 8–12, SE 9–14, S 10–15, SW 12–17, W 13–18). From the first wet hour
the rest of the day counts as wet and scores 0.25. If that day's bulletin
names a wet-snow or gliding-snow problem, the thaw is a hard limit and the
planner says "off the slope by 11"; a tour too long to finish before it is
marked down and says so. The hour strip shows wet hours in blue-grey.

**Snow surface by aspect (v4.8).** `public/snowquality.js` looks at the
72 hours up to noon, from the two past days Open-Meteo returns: wind of
7 m/s or more while and after it snowed makes the tour's descent aspect lee
(loaded, denser, slab-prone, × 0.85), windward (scoured, × 0.5) or cross
(× 0.75); above 0° after the snow gives crust (× 0.55); a spring day with a
frozen night and a thaw gives corn on sunny aspects, at least 0.8, with its
hours (E 9–12, SE 10–13, S 11–14, SW 12–15, W 13–16); cold and calm keeps
the powder. Without hourly data the older day-level rules apply.

**A few days in one area (v4.8).** Under the planner: the three best
regions for a 2–5 day trip starting on the selected day, one different
tour per day (`public/areaplan.js`). Days where nothing in the region
passes are rest days and count zero, so an area with one great tour does
not beat an area with three good ones.

Also shown: "thin cover" where the base is below what the tour's terrain
needs, and "skiable from the car" / "carry skis" from the modelled snow at
the start of the route (where a route is known).

`GET /api/outlook` serves the inputs (bulletins per day, every tour's
summit forecast); the scoring runs in the browser (`public/planner.js`),
so changing your limits re-ranks instantly. It sorts what the bulletin
says. Read the bulletin before you go.

## Ski resorts layer

For the days that don't end up as touring days, tick **ski resorts** above
the map. Each resort gets two icons: slopes on the left, lifts on the
right. Each icon is shaded by how much of that is open, from closed
(outline) to all open (solid ink). The resort's name sits underneath and
links to its home page (↗). Zoomed out, each resort is a small square
shaded by its lifts. Zoom in with + / −, double-click, or Ctrl/⌘ + scroll
(drag to pan) to get the icons and names. Where resorts crowd, the bigger
one keeps its icons and the smaller one stays a square until you zoom
further; hover for the numbers.

- **Norway: live, from [Fnugg](https://fnugg.no).** One request returns
  every resort Fnugg lists (126 in September 2026) with position,
  homepage, and lifts and slopes open out of total. Refreshed hourly from
  November to May and daily otherwise, cached on disk. If Fnugg is down,
  the last good list is shown and marked stale. Summer venues (bike
  parks, summer ski) are filtered out. Fnugg publishes no terms for this
  endpoint; the service identifies itself, makes one request an hour at
  most, and credits Fnugg on the map.
- **Sweden: location and link only, from OpenStreetMap.** There is no
  open live status feed in Sweden. Snörapporten (SLAO) has open lifts and
  slopes for ~60 resorts but publishes no API. Swedish resorts are drawn
  with dashed "no status" icons, never as closed, and link to the website
  mapped in OSM where there is one. One Overpass query a month. If SLAO
  grants data access, it slots in as another source in `src/resorts.js`.
- Colours follow the profile: the grey scale, darker = more open (flipped
  in the dark theme so more open is always more contrast). Red stays
  reserved for alerts.

Set `RESORTS_ENABLED=false` to turn the layer and its endpoint off.

## Avalanche problems, drawn

Each region's problems are shown as a pictogram, a compass rose of the
aspects they apply to and a mountain with the height band shaded — in black
and white, or in colour from danger 3. Hover (or tap) any problem or danger
symbol for a short explanation after the EAWS standards. The planner and the
powder alerts show the danger level and problem icons next to each name.

On a tour's route map, slopes steeper than 25° that face the way today's
problems face, at their heights, are shaded red. This comes from a ~50 m
elevation grid fetched once per tour (about 70 Kartverket requests, cached
for 30 days). It follows the bulletin and the terrain model; it is not a
slope-angle survey, and short steep rolls finer than 50 m do not show.

## Photos near the summit

The tour panel shows openly licensed photos from **Wikimedia Commons** —
geotagged within 10 km, then files named after the summit — and, with a free
`FLICKR_API_KEY` in `.env`, Creative-Commons photos from **Flickr**. All are
credited and link back to their page. Your own photos (from the tour editor)
come first.

When none exist, the panel **draws** the mountain from the terrain model: a
shaded relief with the fall line, and that line's profile coloured by slope
angle, looking down the tour's descent aspect (or the steepest way down if
the aspect is not recorded yet).

## Simulated data, on a button

Out of season the map is mostly empty. **Simulated data**, next to "Refresh
now", invents a storm week over the real regions and tours and fills every
panel with it, so you can see the winter layout: loaded regions, danger
levels and problems, powder alerts, the planner's week and open lifts. It is
drawn in the browser from a fixed seed — nothing is fetched, stored or sent,
and every simulated bulletin says it is not a forecast. "Refresh now" puts
the live data back.

## Demo out of season

`demo/` produces a 30-second video of a simulated storm week (Mon 8 – Sun 14
February 2027). It doesn't fake the app's output. It fakes the **upstream**:
a small weather model answers the same requests Varsom, seNorge and
lavinprognoser.se would, and the real `refresh()` pipeline and alert engine
turn those answers into what you see. Every number on screen is what the code
would show if that week happened. Captions, the push toast and the title
cards are overlays, and every frame is labelled as simulated.

```bash
npm run demo:simulate      # 7 daily snapshots into demo/out/
npm run demo:record        # 30 s teaser; needs Playwright + Chromium and ffmpeg
npm run demo:record-full   # ~2 min walkthrough of every feature
npm run demo:music         # add the original soundtrack (demo/music.py; numpy, scipy)
```

For the walkthrough, the simulation also stands in for OpenStreetMap and
Open-Meteo on four featured tours. It gives them synthetic path networks,
terrain and summit weather, and the real route finder, profile code and
forecast shaping run over them. Hamperokken's path deliberately stops 1.9 km
below the summit, to show that the tool draws no line rather than a guessed
one. Map tiles are not simulated, so route maps appear on plain paper with
contour lines drawn from the simulated terrain. Ski resorts in the demo
are Fnugg's real resort list (`demo/fixtures/fnugg-resorts.txt`) with
simulated open counts: on a stormy day the exposed lifts go on wind hold.
Swedish resorts are at approximate positions. Commons photos are live-only,
so the photo panel shows its fallback in the video.

## Configuration

Everything is environment variables; see `.env.example` for the annotated set.
The ones that matter:

| Variable | Default | Notes |
|---|---|---|
| `TZ` | `Europe/Stockholm` | Local time for quiet hours. |
| `REFRESH_COOLDOWN_MINUTES` | `10` | Minimum gap between refreshes forced from the page's button. |
| `REFRESH_MINUTES` | `180` | Bulletins update about once a day. Under 60 is pure load on a public agency's API; the service clamps to 30 minimum. |
| `SEASON_ONLY` | `true` | Stop hitting upstream outside 1 Nov – 30 Jun. |
| `ALERT_THRESHOLD_CM` | `30` | New snow over 48 h that triggers an alert. |
| `ALERT_REGIONS` | `all` | Or a comma-separated list of region ids (see `data/regions.json`). |
| `ALERT_COUNTRIES` | `all` | Or e.g. `NO` or `NO,SE`: which countries you are notified about. The country buttons on the page only change what you see. |
| `ALERT_QUIET_FROM` / `_TO` | `22` / `6` | Alerts found overnight are **held, not dropped**, and sent when the window ends. |
| `TERRAIN_DAILY_POINTS` | `60000` | Heights the terrain page may ask Kartverket / Open-Meteo for per day (UTC). |
| `GLO30` / `GLO30_DAILY_MB` | `on` / `2000` | Copernicus GLO-30 (30 m) from its open files where Lantmäteriet and Kartverket have no answer, before Open-Meteo; most MB a day. |
| `TERRAIN_PARALLEL` | `3` | Terrain requests worked on at once. |
| `OPEN_METEO_POINTS_PER_MIN` | `500` | Heights sent to Open-Meteo per minute at most; after a 429 it is rested 2 min, doubling up to an hour. |
| `LANTMATERIET_USER` / `_PASSWORD` | – | Geotorget login with access to *Markhöjdmodell Nedladdning*: Sweden's terrain at 1 m. |
| `LANTMATERIET_DAILY_MB` | `1000` | Most MB a day downloaded from Lantmäteriet's terrain files. |

### Alerts by email

```env
MAIL_PROVIDER=resend
RESEND_API_KEY=re_xxx
MAIL_FROM=toppturvarsel@yourdomain.tld
MAIL_TO=you@yourdomain.tld
```

Resend is used over its HTTP API so the image stays dependency-free. For a
normal SMTP server instead:

```env
MAIL_PROVIDER=smtp
SMTP_URL=smtps://user:pass@smtp.example.com:465
```

SMTP needs one dependency: `npm install nodemailer` and rebuild. It is loaded
dynamically, so nothing is pulled in unless you ask for it.

#### Through your own mailbox (Gmail, Outlook, …)

`MAIL_PROVIDER=smtp` sends through any ordinary mailbox. Gmail needs an app
password, not your account password:

1. Google Account → Security → turn on 2-Step Verification (required).
2. Security → App passwords → create one for "Mail"; Google shows 16 letters
   in four groups. Write them without the spaces.
3. In `.env`:

```
MAIL_PROVIDER=smtp
MAIL_TO=you@gmail.com
MAIL_FROM=you@gmail.com
SMTP_URL=smtps://you%40gmail.com:abcdefghijklmnop@smtp.gmail.com:465
```

`@` in the user name is written `%40`. `MAIL_FROM` must be the mailbox you
log in as; Gmail rewrites anything else. The image installs `nodemailer` at
build time for this; if that download fails the build still succeeds and
SMTP simply stays unavailable (the log says so).

### Alerts by phone push (ntfy)

```env
NTFY_TOPIC=toppturvarsel-<something-long-and-random>
```

Install the ntfy app, subscribe to that topic, done — no account needed.

> **Pick a long random topic.** On the public ntfy.sh a topic name is the only
> secret: anyone who guesses it can read your alerts and publish to them. Or
> self-host and set `NTFY_SERVER`.

Check your wiring without waiting for weather:

```bash
curl -X POST localhost:8080/api/test-alert   # dry run, records nothing
```

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/conditions` | The whole current snapshot: regions, bulletins, snow, tours. |
| `GET /api/alerts` | What is currently over threshold, what is held, what was recently sent. |
| `GET /api/health` | `200` when fresh, `503` when the snapshot is stale — wire this to your monitoring. |
| `POST /api/refresh` | Force a refresh now. Concurrent calls are coalesced. |
| `POST /api/test-alert` | Dry-run the alert path. |
| `GET /api/meta` | The static region and tour definitions. |
| `GET /api/tracks` | Per tour: own GPX, OSM route, none, area or not looked up yet. Reads disk only. |
| `GET /api/track?tour=` · `/api/track.gpx?tour=` | Route, profile and GPX for a listed tour. |
| `GET /api/terrain?tour=` | Elevation grid for contours. |
| `GET /api/photos?tour=` · `/api/photo?tour=&i=` | Commons photos near the summit, and their thumbnails. |
| `GET /api/forecast?tour=` | 5-day summit forecast. |
| `GET /api/snowhistory?tour=` | Snow depth 1 Oct – 30 Jun for this winter and the five before, from seNorge (past winters cached for good). |
| `GET /api/huts` | Cabins, open huts, mountain lodges and remote cafés within 15 km of the tours, from OpenStreetMap (cached 30 days). |
| `GET /api/overpass` | What the OpenStreetMap (Overpass) queue is doing: requests waiting, the one running, rested servers, last error. |
| `GET /api/skill` | Forecast accuracy: every verified cell, with skill, error and bias per parameter and lead time. |
| `GET /api/resortmap?resort=` | Runs, lifts, terrain grid and fun facts for a listed ski resort, from OpenStreetMap (cached 30 days). |
| `GET /api/forecast?resort=` | 5-day forecast at a listed ski resort, by its id. |
| `GET /api/version` | The running version (from package.json) and when the server started. |
| `GET /api/outlook` | Trip planner inputs: bulletins per day and every tour's 5-day summit forecast with hourly values (gzipped). |
| `GET /api/resorts` | Ski resorts: Norway with live lift/slope status (Fnugg), Sweden location only (OSM). |
| `GET /api/dem/{z}/{x}/{y}` | Terrain page: a 17 × 17 height grid over one map tile (z 11–15), service area only, kept a year. |
| `POST /api/terrain/profile` | Terrain page: `{"points": [[lat, lon], …]}` (≤ 300 points, ≤ 50 km, service area only) → samples every 25 m+ with height, slope and aspect of the ground. |
| `POST /api/terrain/weather` | Terrain page: `{"points": [[lat, lon, ele], …]}` (one or two, service area only) → MET Norway hourly forecast at each point and height. |
| `GET /api/terrain/zone` | Terrain page: the service-area margin, today's height budget, the places added by search, Lantmäteriet's state. |
| `GET /api/places?q=` | Place names in Norway (Kartverket) and Sweden (Nominatim), kept 30 days; `&country=NO\|SE` to limit. |
| `POST /api/places/pick` | `{"id": …}` from a search answer → that place joins the service area (30 a day, 300 in all). |
| `GET /tiles/nve/{z}/{x}/{y}.png` | NVE's slope and runout map (Norway), through the tile proxy. |

The healthcheck deliberately fails on **stale data**, not just on a dead
process, so a container that is up but quietly not fetching shows as
unhealthy instead of looking fine.

## Adding your own tours

There is a preview of the editor in the running service at **/editor** (the
"Tour editor" button on the Tours card). It shows the parts but cannot load
or save anything yet.

**The easy way:** open `editor/tour-editor.html` in a browser (double-click
it; no server needed). Load your GPX, fill in the fields, add photos if you
like, and download the .zip it makes: the track for `data/tracks/`, the entry
for `data/tours.json`, and a `photos/<slug>/` folder for `data/photos/`.
Photos from a phone keep their position (in `photos.json`, not in the image
files) and show on the tour's route map. It checks the entry the same way the tests do and tells
you where each file goes. The manual route below is what it automates.

`data/tours.json` is a plain array. Add an entry, restart:

```json
{
  "name": "Blåbrean", "region": "indre-sogn",
  "lat": 61.45, "lon": 7.75,
  "summit_m": 1800, "vertical_m": 1300, "aspect": "N–NE",
  "difficulty": 4, "quality": 5,
  "access": "Turtagrø", "season": "Apr–Jun",
  "note": "Why this one is worth the drive."
}
```

Optional `links` point to route descriptions elsewhere, shown on the tour
card as "Route descriptions on …": `[{"site": "Freeride.se", "title":
"Storsylens norgeåk", "url": "https://…"}]`. Link, don't copy: the tours
south of Åre added from Freeride.se's route list carry only a name, our own
summit data (positions and heights from PeakVisor/OpenStreetMap) and our
own short note, with the route descriptions a click away on Freeride.

`region` must match an `id` in `data/regions.json`. The coordinates do real
work — they choose the seNorge grid cell the snow depth comes from — so put
them on the objective, not the car park.

---

## Forecast accuracy (/skill)

A tool of its own, at `http://<your-pi>:8080/skill`, linked from the resorts
box: **how good the forecast has actually been**, by how far ahead it was
made and by where.

Every morning the server asks Open-Meteo for 16 days ahead at each 25 km
cell holding a tour or a resort, and writes down what it said for 1, 3, 5,
10 and 15 days out. The same request returns the last five days as analysed
— what actually happened — so yesterday's weather scores the forecasts made
1, 3, 5, 10 and 15 days before it.

Four things are checked: **new snow** (and whether 5 cm fell), the day's
**highest temperature**, mean **cloud** (a bluebird day is under 30 %) and
the day's strongest **wind**. *All four* is a weighted average — snow 40 %,
temperature 25 %, wind 20 %, cloud 15 %.

Every score is measured against climatology, not against zero:

    skill = 1 − (the forecast's error) ÷ (the error of saying "normal for the time of year")

0 means the forecast was no better than knowing the season; 1 means it was
perfect. The climatology is built from the observations as they accumulate,
so a cell shows nothing until it has 30 scored days and enough observations
to know what normal is. The 1-day scores appear after a couple of days, the
15-day ones after a fortnight, and the map fills in over a winter.

Until then — and whenever you press **Sample data** — the page shows
made-up figures of a realistic shape, clearly marked, so you can see what it
will look like.

Settings (`.env`): `SKILL_VERIFY=on|off`, `SKILL_HOUR=6` (Norwegian time),
`SKILL_MIN_CASES=30`. Stored in `data/cache/verify/`, a few MB a season.

## National lift data (Kartverket and Lantmäteriet)

OpenStreetMap is drawn by volunteers, so a ski area's lifts are usually a
few short. Two official sources are used to check it:

**Norway — automatic, nothing to set up.** Kartverket's place-name register
(SSR) holds every lift's official name and position
(`navneobjekttype` *Skiheis*, *Fjellheis*). Each resort map asks it for the
names around the resort and matches them against the mapped lifts. Whatever
is registered but not mapped is ringed in red on the map and listed in the
fun facts. Open data, no key, CC BY 4.0 — © Kartverket.

**Sweden — included.** `data/lifts-SE.geojson` ships with the app: the 635
*Lintrafik* lines (lifts, gondolas, funiculars) from Lantmäteriet's
Topografi 50, converted to WGS 84. © Lantmäteriet. Nothing to set up — every
Swedish resort map checks against it. To refresh it from a newer download,
follow the steps below and overwrite that file.

**Sweden — refreshing it yourself.** Lantmäteriet's lift lines live in
*Topografi 50*, theme *Byggnadsverk*, layer `Byggnadsanläggningslinje`,
object type **Lintrafik** (code 1978: lifts, gondolas and funiculars).
That product is not on Lantmäteriet's open STAC API; it needs a free
Geotorget account and is delivered as a GeoPackage (download
`byggnadsverk_sverige.zip`, about 110 MB, not the whole 5 GB set), so the
app cannot fetch it for you. Once you have it:

1. Open the GeoPackage in QGIS and select the `byggnadsanlaggningslinje`
   layer; filter to `objekttyp = 'Lintrafik'`.
2. Export it as **GeoJSON** in **EPSG:4326 (WGS 84)**.
3. Save it as `data/lifts-SE.geojson` on the Pi and restart
   (`docker compose up -d`).

Every Swedish resort map then checks against it exactly as Norway does.
The same works for Norway with an N50 export (`data/lifts-NO.geojson`,
feature types *Taubane* and *Skitrekk*) if you want lift lines rather than
just names. Any GeoJSON of `LineString`/`MultiLineString` features works;
the name is read from `name`, `namn`, `navn` or `tekst`.

## Honest limitations

These are the things worth knowing before you trust a number on this page.

**New snow is modelled, and it under-reports.** It is the rise in modelled
snow depth between two daily values, so settlement eats into it: 40 cm falling
overnight may read as +30 by morning. Good for "something significant
happened", not a resort-style snow report.

**Snow depth is a 1 km grid cell, not a snow pit.** The cell containing
Galdhøpiggen's 2469 m summit reports its mean elevation as 2178 m. Treat
depths as regional truth, not slope truth.

**The Swedish bulletin is scraped.** Sweden publishes no API — no JSON, no
CAAML feed. `src/sources/lavinprognoser.js` reads the public page, and it was
written out of season when every Swedish region reads "Ej bedömd", so the
in-season markup has never been seen by this code. It is deliberately loose
and fails to `null` rather than guessing. **First Swedish forecast day of the
season (11 December), check one region against the website** and adjust the
patterns if they have drifted. A wrong danger level is worse than none, which
is why a parse failure shows a link to the bulletin instead of a number.

**Regobs observation counts are off by default.** The Regobs search API is
POST-only and could not be verified against the live service from the build
environment, so the request shape comes from documentation rather than from an
observed response. Shipping an unverified count is worse than shipping none —
"0 observations" reading as "nobody has been out there" is exactly the kind of
wrong that gets acted on. Instead the UI shows the forecaster's own
observation and avalanche-activity summary, which comes from the verified
Varsom endpoint. To enable the raw counts, set `REGOBS_ENABLED=true` and check
`/api/health`, which reports whether they are actually returning data.

**Commons photos and map tiles were not seen live.** The build
environment could reach Kartverket's elevation service (the contour
preview uses a real grid from it), but not Wikimedia Commons, its image
host or the tile servers. The Commons request follows the MediaWiki API
documentation and is tested against that shape. If Commons changes its
answer, the photo panel says "could not be loaded" and links to Commons
rather than showing anything wrong. Check one tour's photo panel after
first start.

**Regions without tours use one indicative sample.** 12 regions have no tour
in the list, so their snow comes from a single grid cell at the region marker,
which may sit well below skiable terrain. The UI labels these.

**The map is schematic.** A low-resolution outline for picking a region, and
zoomable only so resorts can be told apart. The coastline stays coarse at any
zoom. Not for navigation, ever.

**Resort status is only as good as what resorts report.** Fnugg's counts come
from the resorts themselves and can lag a morning wind hold. The Swedish
resort positions and links come from OpenStreetMap and were not fetched
live from the build environment (Overpass was unreachable there); the query
is written against the documented output and tested against that shape.

## Attribution and being a good neighbour

Avalanche data is © NVE / Varsom.no and Naturvårdsverket; snow data is from
NVE's seNorge; the slope and runout map on the terrain page is © NVE
(CC BY 4.0); the route weather is © MET Norway (CC BY 4.0); Swedish terrain at 1 m is
© Lantmäteriet (CC BY 4.0). Regobs data, if you enable it, requires crediting both Regobs
and the individual observer. The footer of the page carries this — please
leave it there.

These are small public services run by public agencies, and they owe you
nothing. The defaults here identify the client, cap concurrency at 4, back off
on failure, coalesce concurrent refreshes and go quiet all summer. Please
don't turn `REFRESH_MINUTES` down to 5 because you can.

## Reality check

A regional bulletin describes a region, not your slope. A model is not a pit.
An alert saying 40 cm fell is a reason to read the bulletin carefully, not a
reason to go. Nothing here replaces terrain assessment, a partner,
transceiver/shovel/probe, and the willingness to turn around.

## Versions and GitHub

From v4 the project is kept on GitHub: `main` is the current version, every
release is a tag (`v4.0`, `v4.1`, …), and `CHANGELOG.md` says what changed.
GitHub Actions runs the tests on every push (`.github/workflows/ci.yml`)
and builds the Docker image for the Pi (`image.yml`), published as
`ghcr.io/hmolker/toppturvarsel:latest` and `:vX.Y` per version. The Pi picks
one with `FJALLSKRED_VERSION` in `.env`. INSTALL.md steps 11–12 have the setup.

## Licence

MIT for the code. The data belongs to the agencies above and carries their
terms.
