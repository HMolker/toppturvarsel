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
- **78 curated tours** with difficulty and quality ratings, filterable and
  sortable by how much snow just fell on them.
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
npm test             # 104 tests, no network needed
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
| `ALERT_QUIET_FROM` / `_TO` | `22` / `6` | Alerts found overnight are **held, not dropped**, and sent when the window ends. |

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
| `GET /api/track?tour=` · `/api/track.gpx?tour=` | Route, profile and GPX for a listed tour. |
| `GET /api/terrain?tour=` | Elevation grid for contours. |
| `GET /api/photos?tour=` · `/api/photo?tour=&i=` | Commons photos near the summit, and their thumbnails. |
| `GET /api/forecast?tour=` | 5-day summit forecast. |
| `GET /api/outlook` | Trip planner inputs: bulletins per day and every tour's 5-day summit forecast. |
| `GET /api/resorts` | Ski resorts: Norway with live lift/slope status (Fnugg), Sweden location only (OSM). |

The healthcheck deliberately fails on **stale data**, not just on a dead
process, so a container that is up but quietly not fetching shows as
unhealthy instead of looking fine.

## Adding your own tours

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
NVE's seNorge. Regobs data, if you enable it, requires crediting both Regobs
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

## Licence

MIT for the code. The data belongs to the agencies above and carries their
terms.
