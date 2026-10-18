# Personal fork

This checkout's `local-fixes` branch adds the features below to upstream God's
Eye View, for the fork owner's own use. Fork-only code is marked with
"Personal fork" comments. Everything here is as of 2026-10-16 (`local-fixes`
at `04a5df85` plus this change). Items marked **(check)** are unclear or
unconfirmed in the code and need a second look.

All caches live under `.gev-cache/`, which git ignores. Every fork pack is on
unless its switch is set to `0`.

## Contents

- [Cameras near the view (proximity loading)](#cameras-near-the-view-proximity-loading)
- [Camera sources](#camera-sources)
  - [Featured YouTube cams, the channel watcher and the review queue](#featured-youtube-cams-the-channel-watcher-and-the-review-queue)
  - [Windy webcams](#windy-webcams)
  - [OpenStreetMap and Wikidata linked webcams](#openstreetmap-and-wikidata-linked-webcams)
  - [USGS volcano cams](#usgs-volcano-cams)
  - [National Park Service webcams](#national-park-service-webcams)
  - [Maryland CHART traffic video](#maryland-chart-traffic-video)
  - [camindex: OpenCCTV, Open-Eagle-Eye and PocketWorld](#camindex-opencctv-open-eagle-eye-and-pocketworld)
- [One pin per camera (cross-source dedupe)](#one-pin-per-camera-cross-source-dedupe)
- [The SOURCES readout](#the-sources-readout)
- [The camera picker](#the-camera-picker)
- [Panel kinds and local time](#panel-kinds-and-local-time)
- [Sound detection](#sound-detection)
- [Screenshot-safe mode (HIDE WINDY)](#screenshot-safe-mode-hide-windy)
- [Google indoor views (Street Level)](#google-indoor-views-street-level)
- [Baltimore enforcement and CitiWatch cameras](#baltimore-enforcement-and-citiwatch-cameras)
- [Earth Engine layers (ANALYSIS)](#earth-engine-layers-analysis)
- [Keyless basemaps (MAP SOURCE)](#keyless-basemaps-map-source)
- [Smaller additions](#smaller-additions)
- [Keeping up with upstream](#keeping-up-with-upstream)
- [What you need to do](#what-you-need-to-do)

## Cameras near the view (proximity loading)

**What it does.** The Cameras layer still starts from the server's capped
worldwide catalog (upstream's `CCTV_MAX_SOURCES`, default 4000). When the view
settles, it also asks for every indexed camera near the view centre and adds
the ones it lacks: up to 400 per query, held in a working set of 2,500 that
drops the farthest first. Nothing is fetched above 400 km altitude. The
search radius is 1.5 km per km of altitude, between 3 and 200 km, and a new
query goes out only after the view moves well away from the last one. In
testing, London went from 250 to 505 cameras within 10 km.

**Where it comes from.** `GET /api/cctv/sources?near=lat,lon&radiusKm=&limit=`
on the app's own server. The server keeps an uncapped index of every pack's
cameras next to the capped list (at most 500 km and 1,000 cameras per query).
Streams and non-traffic cameras rank as nearer than they are, so they are not
crowded out by traffic cameras.

**Switches.** None of its own; each pack has its own switch.

**Cache.** In memory, rebuilt with the catalog every 15 minutes, or after
2 minutes when an enabled live pack came back empty.

**Limits.** The `linked` and `camindex` packs add cameras only this way, never
to the startup catalog.

Code: `src/layers/cctv/proximity.js`, `server/providers/cctv/catalog.js`.

## Camera sources

### Featured YouTube cams, the channel watcher and the review queue

**What it does.** Loads 41 hand-checked public-interest live streams (falcon
nests, explore.org, Monterey Bay Aquarium and others) from
`src/data/local_data/cctv_featured/live-cams.json`. Each is pinned only as
precisely as its operator publishes: at the site, in the area, in the region,
or at the operator's own geotag. Streams play in YouTube's privacy-enhanced
player, which exists only while the camera panel is open. When an operator
restarts a stream, the new one is found through the channel's uploads by
title (at most hourly) and saved back to the file.

The channel watcher scans 11 operator channels (`channels.json`) every
2 hours. Live, public, embeddable streams the list doesn't have go to a
PENDING CAMS block in the panel, with ACCEPT, ADJUST and SKIP. Accepted
entries are checked and appended to `live-cams.json`.

**Where it comes from, and terms.** The YouTube Data API (`videos.list`,
playlist items; never `search.list`). Each stream is the operator's own,
embedded only. Place suggestions use the server Google key's Geocoding API,
at most 60 a day.

**Switches.**

| Variable                      | Default                                                 |
| ----------------------------- | ------------------------------------------------------- |
| `YOUTUBE_API_KEY`             | unset; streams still load, with live status unknown     |
| `CCTV_FEATURED_ENABLED`       | `1`                                                     |
| `CCTV_FEATURED_FILE`          | `src/data/local_data/cctv_featured/live-cams.json`      |
| `CCTV_FEATURED_WATCH`         | `1`                                                     |
| `CCTV_FEATURED_CHANNELS_FILE` | `src/data/local_data/cctv_featured/channels.json`       |
| `CCTV_CHANNEL_SCAN_MINUTES`   | `120` (at least 60)                                     |
| `YOUTUBE_DAILY_BUDGET`        | `1500` units (YouTube's day resets at midnight Pacific) |

**Cache.** `.gev-cache/cctv-featured/`: `pending.json`, `skipped.json` and
`quota.json`.

Code: `server/providers/cctv/featured*.js`, `src/ui/cctvPending.js`,
`src/ui/cctvEmbed.js`.

### Windy webcams

**What it does.** Asks Windy for webcams near the view on each proximity query
(up to 250 km, at most 150 per query by default), and shows their preview
stills.

**Terms.** Windy's free tier allows images at their original size or smaller,
each linked to its Windy page and credited "Webcams provided by windy.com",
with the ads kept. **It forbids publishing graphics that show the images:**
don't share screenshots that show a Windy camera. Use HIDE WINDY (below)
before taking one. Upstream declined this source; the fork enables it for its
owner only.

**Switches.** `WINDY_WEBCAMS_API_KEY` (the code also accepts `WINDY_API_KEY`),
`CCTV_WINDY_ENABLED` (`1`), `CCTV_WINDY_MAX_PER_QUERY` (`150`, at most 1000).

**Cache.** In memory: answers for 15 minutes per area. Up to 8,000 cameras are
remembered so their frames can still be served. Requests are held to 120 per
minute (Windy allows 300).

**Limits.** Display only. The panel shows an "OPEN ON WINDY.COM" link, which
the terms require. Windy cameras are stills with no pose, so they draw no cone
or projection.

**Screenshots.** The camera panel's HIDE WINDY toggle hides every Windy pin,
card and still until it is turned off; see
[Screenshot-safe mode](#screenshot-safe-mode-hide-windy).

Code: `server/providers/cctv/windy.js`.

### OpenStreetMap and Wikidata linked webcams

**What it does.** Adds every OpenStreetMap object tagged `contact:webcam`
(about 10,000) and every Wikidata item with a webcam URL (P4238) and
coordinates (about 600). Direct image, HLS and YouTube links play in the app.
Links to an operator's page become pins that open the page.

**Where it comes from, and terms.** Overpass (upstream's `OVERPASS_UPSTREAMS`,
else four public mirrors), falling back to QLever's OSM planet endpoint when
every mirror fails. Wikidata comes from its SPARQL endpoint. OpenStreetMap
data is ODbL and Wikidata is CC0; each feed belongs to its operator.

**Switches.** `CCTV_LINKED_ENABLED` (`1`), `OVERPASS_UPSTREAMS` (shared with
upstream).

**Cache.** `.gev-cache/cctv-linked/osm.json` and `wikidata.json`, refreshed
weekly. After a failure it retries in 30 minutes and serves the stale copy
meanwhile.

**Limits.** Since 2026-10-14 the public Overpass mirrors refuse this query, so
the OSM half arrives through QLever (up to 5 minutes, 32 MB).

Code: `server/providers/cctv/linked.js`.

### USGS volcano cams

**What it does.** Adds USGS observatory webcams (Alaska, Cascades,
Yellowstone and some Hawaii) that have coordinates and a USGS-hosted still
from the last 3 days. About 225 of 461 pass.

**Terms.** US Government work, public domain. Cameras whose images are hosted
by third parties are left out, because USGS's public domain doesn't cover
them.

**Switches.** `CCTV_USGS_ENABLED` (`1`). No key.

**Cache.** `.gev-cache/cctv-packs/usgs-volcano.json`, daily.

**Limits.** A bearing or elevation of 0 in the source means "not filled in".

Code: `server/providers/cctv/usgs.js`.

### National Park Service webcams

**What it does.** Adds active NPS webcams with coordinates from the NPS Data
API, classified like the linked webcams.

**Terms.** Public domain.

**Switches.** `NPS_API_KEY` (free from developer.nps.gov), `CCTV_NPS_ENABLED`
(`1`). Without a key the pack logs once and stays empty.

**Cache.** `.gev-cache/cctv-packs/nps.json`, daily.

Code: `server/providers/cctv/nps.js`.

### Maryland CHART traffic video

**What it does.** Adds up to 300 online MDOT SHA CHART traffic cameras inside
Maryland, nearest Baltimore, Annapolis and the DC suburbs first, as live HLS
from `strmrN.sha.maryland.gov`.

**Terms.** The keyless CHART camera feed states no licence. DATA_SOURCES.md
notes that any use beyond personal local viewing needs MDOT SHA's
confirmation.

**Switches.** `CCTV_MDOT_ENABLED` (`1`), `CCTV_MDOT_MAX_SOURCES` (`300`),
`CCTV_MDOT_VIDEO` (`1`; `0` shows stills), `CCTV_MDOT_URL`.

Code: `server/providers/cctv/sources.js` (`loadMdotSourcesFromOpenData`).

### camindex: OpenCCTV, Open-Eagle-Eye and PocketWorld

**What it does.** camindex is a command-line crawler that reads public camera
directories and writes `.gev-cache/camindex/catalog.json`. The app's
`camindex` pack serves that file through proximity loading.

```bash
node scripts/camindex/index.mjs discover --source opencctv
```

Other commands: `discover --source openeagleeye`, `discover --source
pocketworld [--scope non-traffic|maryland|all] [--limit N]`, `verify
[--source …]`, `build`, `status`.

**Sources and terms.** Each source has a section in
`scripts/camindex/SOURCES.md`.

- **OpenCCTV** (opencctv.org). Its terms forbid scraping, bulk downloading
  and bypassing rate limits. camindex reads only what robots.txt allows,
  never `/api/`, and checks the site's stills at most 40 per 10 minutes.
- **Open-Eagle-Eye** (MIT). One registry file of about 31,500 stills, read
  weekly. Rows that need a login are dropped. Rows carry an IANA time zone.
- **PocketWorld** (pocketworld.org). Attribution required; personal and
  development use allowed; no bypassing rate limits or mirroring. Its webcams
  API answered 502 on 2026-10-16, so camindex reads the listing pages at one
  request per 2 s. The first run stops at 2,000 cameras.

**Rules for every source.** robots.txt first. One request at a time per host,
at least 1.5 s apart. Back off on 429 or 503. Every page is kept on disk for a
week, so a rerun costs nothing.

**Switches.** `CCTV_CAMINDEX_ENABLED` (`1`), `CAMINDEX_DIR` (default
`.gev-cache/camindex`). Neither is in `.env.example`.

**Cache.** `.gev-cache/camindex/`: `http/` (every page read),
`<source>/candidates.json`, `<source>/verify.json`, `catalog.json` and
`runs.jsonl`.

**Limits.**

- Nothing runs camindex automatically unless you install the nightly task
  (below). The pack is empty until `discover` and `build` have run.
- The pack serves every feed kind the catalog holds: stills, MJPEG, HLS,
  YouTube and operator links, with each camera's time zone.
- A camera whose still a viewer opened is checked as it loads
  (`observed.json`): seen dead or as a placeholder, it leaves this and the
  Windy, linked, USGS and NPS packs; seen live, it is marked live.
  PocketWorld cards that proved to be web pages become operator links
  (`pocketworld/link-hosts.json`).

**Install the nightly run (optional).** `npm run camindex:schedule` runs
whatever is due (weekly `discover`, nightly `verify --rolling`, then `build`)
and exits. To have Windows run it every night at 03:00, open a Command
Prompt and run this once:

```bat
schtasks /Create /TN "God's Eye View camindex" /SC DAILY /ST 03:00 /TR "cmd /c cd /d C:\Users\nospa\Desktop\godseye && npm run camindex:schedule >> .gev-cache\camindex\schedule.log 2>&1"
```

`npm run camindex:status` shows the counts per source and when each step
last ran (from `.gev-cache/camindex/runs.jsonl`). Remove the task with
`schtasks /Delete /TN "God's Eye View camindex" /F`. More detail is in
`scripts/camindex/SOURCES.md` under Install.

Code: `scripts/camindex/`, `server/providers/cctv/camindex.js`,
`server/providers/cctv/observed.js`.

## One pin per camera (cross-source dedupe)

**What it does.** Several sources often list the same camera. The server
keeps one pin per camera and records the others in `alsoListedIn`. A higher
source wins: featured, then agency feeds (any upstream pack or HLS stream),
then USGS and NPS, then Windy, then linked webcams, then camindex
directories.

Two listings count as one camera when any of these holds:

- the same feed URL or YouTube id within 25 km;
- the same operator page within 500 m;
- they are within 30 m with matching names (never between two agency feeds);
- a directory camera is within 60 m of a camera with its own feed.

A URL that more than two cameras in one source share is ignored. In testing,
Baltimore's 60 km view went from 886 to 498 pins.

**Switch.** `CCTV_DEDUPE_ENABLED` (`1`).

**Limits.** A new upstream pack counts as an agency source automatically,
because only fork packs are listed as non-agency.

Code: `server/providers/cctv/dedupe.js`.

## The SOURCES readout

**What it does.** A collapsible SOURCES block at the bottom of the camera panel
shows what the camera index holds and what it costs. It is fetched when the
block opens and every 60 seconds while it stays open. It reads
`GET /api/cctv/status` (and the indoor Street View status, when that route is
mounted). Nothing in it fetches from a camera source, and no key is ever
returned.

**One row per pack.** For example: "1.2k indexed · 300 on map · 45 folded",
then how long ago the pack last refreshed, and its last error if the most
recent attempt failed. The status route reports four counts per pack:

- `available`: cameras the pack offered.
- `servedCapped`: cameras in the startup set ("on map"). Proximity-only packs
  (linked, camindex) have none.
- `inIndex`: cameras kept in the proximity index after dedupe ("indexed").
- `dedupedAway`: cameras folded into a better source's pin ("folded"; see
  [One pin per camera](#one-pin-per-camera-cross-source-dedupe)).

A pack switched off, or left empty on purpose (for example NPS without a key),
reads "off" with the reason.

**Other rows.**

- Windy: areas cached and cameras known, or "no key".
- The camindex file: cameras, and how many have been checked live or dead.
- YouTube featured cams: listed, live now and pending review.
- The audio cache: sound, silent, likely, unknown.
- The frame cache: frames, size and hit rate.
- Indoor Street View: places and panoramas.

**The quota line** sits above the rows, for example "YouTube 120 / 1500 units
today · Windy 3 / 120 req/min · Street View 677 / 3000". It shows today's
YouTube Data API units against `YOUTUBE_DAILY_BUDGET`, Windy requests in the
last minute against the pack's per-minute budget, and today's indoor Street
View metadata requests against `STREETVIEW_INDOOR_DAILY_CAP`. A part is left
out when its source is off.

Code: `server/providers/cctv/status.js`, `src/ui/cctvSources.js`.

## The camera picker

**What it does.** A search box over the loaded cameras, nearest the view
centre first (150 shown).

- Every word typed must match the place, name, a tag or the category.
- Tags: YOUTUBE, LINK, WINDY, OPENCCTV, VIDEO, CCTV, plus SOUND for cameras
  with audio. Typing "sound" lists only those.
- Arrow keys move, Enter opens, Escape clears.
- PREV and NEXT walk the same nearest-first order.

The hidden native select stays, so share links and QA scripts work as before.

Code: `src/ui/cctvCameraList.js`.

## Panel kinds and local time

**What it does.** The camera panel shows only what fits the camera.

- A camera is **embed** (YouTube), **link** (operator page only), **still**
  (any display-only source: Windy, USGS, NPS, directories, linked webcams) or
  **projected** (traffic and agency cameras, the default).
- For embed, still and link cameras, the panel hides calibration, the pose
  readouts, SAVE/RESET CAL, the CAL badge and PROJECTION. The globe draws no
  cone, viewshed or projected frame for them.
- The meta line gains a second line, for example "Local 03:12 solar · night".
  Sunrise and sunset come from the NOAA algorithm.
- A live YouTube stream at night adds "probably a replay".
- The scene summary becomes a plain sentence: kind, place, category, pin
  precision, operator and local time.

**Limits.** The clock is civil time only when the camera carries an IANA time
zone. Today no served camera does, so every camera shows solar time from its
longitude.

Code: `src/ui/cctvPanelKind.js`, `src/layers/cctv/cameraKind.js`,
`src/data/solarDaylight.js`.

## Sound detection

**What it does.** Works out whether a camera's stream carries audio. The
picker shows a SOUND tag, and the meta line says "sound", "sound likely" or
"silent".

- YouTube is "likely", since its streams always carry a track that may be
  silence. Stills, MJPEG and links are "silent".
- Other streams are checked once, 3 seconds after they are first opened. The
  check reads the HLS playlist's codecs, or one segment's stream table, or the
  first 2 MB of an MP4/WebM file.

**Where it comes from.** The camera's own stream. Each host gets one check at a
time, at least 2 s apart. opencctv.org and windy.com are never checked.

**Switch.** `CCTV_AUDIO_SWEEP=1` (off by default; not in `.env.example`)
checks every stream in the catalog at the same pace.

**Cache.** `.gev-cache/cctv-audio.json`. Results last 7 days; "unknown" is
retried after a day.

**Limits.** None of the tested traffic streams carries audio, so most cameras
read "silent" or "unknown".

Code: `server/providers/cctv/audioProbe.js`, `audioParse.js`.

## Screenshot-safe mode (HIDE WINDY)

**What it does.** The HIDE WINDY button sits in its own row under FOCUS,
COVERAGE and AUTO HOP in the camera panel. While it is on, it reads WINDY
HIDDEN and the panel shows "Windy cams hidden for screenshots". Windy cameras'
pins, cards and panel stills disappear. Their records stay loaded, so turning
it off brings them back without a reload. Windy cameras have no projected
frame anyway.

**Why.** Windy's terms forbid publishing graphics that show its webcam images.

**State.** Saved per browser in localStorage as `gev.cctv.hideWindy`.

**Limits.** Windy cameras' names still appear in the picker, which is text
only. If the active camera is a Windy camera, the panel keeps it selected but
shows no still.

Code: `src/layers/cctv/screenshotSafe.js`, `src/ui/cctvScreenshotSafe.js`.

## Google indoor views (Street Level)

**What it does.** A GOOGLE INDOOR switch in the Street Level panel, off by
default. It pins places where Google Street View has indoor imagery or
contributed 360° photospheres, and opens them in Google's free Maps Embed
viewer.

- Zoom in below about 3 km over ground the app hasn't searched, and the
  server looks around the view centre.
- A panorama counts when its copyright names a photographer (not Google), or
  when Google returns it for any source but not for outdoor imagery.

**Where it comes from.**

- Street View Static API **metadata** requests on the server key. These are
  free; no image is ever requested.
- Search targets come from Places (New) nearby searches, which are billed:
  two per search, at most 200 a day.
- The viewer uses the Maps Embed API on the browser key.

**Switches.**

| Variable                             | Default                              |
| ------------------------------------ | ------------------------------------ |
| `STREETVIEW_INDOOR_ENABLED`          | on (`0` turns it off)                |
| `STREETVIEW_INDOOR_GRID`             | `0` (`1` also searches a ~40 m grid) |
| `STREETVIEW_INDOOR_DAILY_CAP`        | `3000` metadata requests a day       |
| `STREETVIEW_INDOOR_PLACES_DAILY_CAP` | `200` Places searches a day          |

It also uses `GOOGLE_MAPS_SERVER_API_KEY` (falls back to
`GOOGLE_MAPS_API_KEY`) and `GOOGLE_MAPS_API_KEY`.

**Cache and retention.** `.gev-cache/streetview-indoor/`: `panos.json`,
`places.json`, `cells.json` and `usage.json`. Google allows caching its
content for at most 30 days, and Place IDs indefinitely:

- a panorama is re-checked after 25 days and dropped at 30;
- a place keeps only its Place ID once its name and position are 30 days old;
- a searched ~250 m cell is searched again after 30 days.

**Limits.** "Contributed" can't tell indoor 360s from outdoor ones. The viewer
needs the Maps Embed API enabled (see the checklist).

**Upstream's Google provider.** Upstream now ships its own GOOGLE STREET VIEW
source (`src/layers/streetLevel/providers/google/`, Maps JavaScript API), and
Street Level shows one source at a time. GOOGLE INDOOR is a separate source
that sits beside it; the fork's code lives in `providers/googleIndoor/`.

Code: `server/providers/streetview/`, `src/layers/streetLevel/providers/googleIndoor/`.
More detail in [DATA_SOURCES.md](../DATA_SOURCES.md).

## Baltimore enforcement and CitiWatch cameras

**What it does.** Two layers in the Infrastructure group:

- **Enforcement Cameras (Baltimore):** 336 red-light, speed and truck-height
  camera locations.
- **CitiWatch Cameras (Baltimore):** 861 police CCTV locations.

Both are locations only, with no video. They draw coloured ground points with
labels for the nearest 40 when you are zoomed in.

**Where it comes from.** Open Baltimore ArcGIS feature services, fetched by the
browser once a session.

- CitiWatch is credited CC BY 3.0.
- The enforcement data's licence isn't stated in the code **(check)**.

**Limits.** Not in share links, and voice can't control them.

Code: `src/layers/baltimoreCameras/`.

## Earth Engine layers (ANALYSIS)

The **ANALYSIS** group in the DATA LAYERS panel draws Google Earth Engine
images over the globe. Each overlay is its own toggle. Its row has a legend,
an opacity slider (kept per layer in this browser as
`gev.earthEngine.opacity.<id>`), and a status line.

| Layer | Dataset (Earth Engine id) | Licence |
| --- | --- | --- |
| Terrain slope, Terrain aspect, Hillshade | Copernicus DEM GLO-30, `COPERNICUS/DEM/GLO30_2024_1` (`ee.Terrain`) | Copernicus DEM licence; notice required |
| Forest loss (2001–2025, coloured by year) | Hansen Global Forest Change v1.13, `UMD/hansen/global_forest_change_2025_v1_13`, band `lossyear` | CC BY 4.0 |
| Administrative boundaries | FAO GAUL 2025, `FAO/GAUL/2025/level1` from far out, `level2` below 800 km | CC BY 4.0 |

The ids were taken from Earth Engine's catalog records on 2026-10-17. The
older ids, `COPERNICUS/DEM/GLO30` and `FAO/GAUL/2015/*`, are deprecated, and
the 2015 GAUL tables were noncommercial only. Each layer credits Google Earth
Engine and its dataset in Cesium's credit line and in the data-attribution
popover.

**Registration.** The Cloud project "gods-eye-view"
(`true-energy-511503-v7`) is registered for **noncommercial** Earth Engine
use. That is the Community tier: 150 EECU-hours a month. The server signs in
as the service account `gods-eye-view-earth-engine` with the scope
`https://www.googleapis.com/auth/earthengine`, which was enough on its own.
The account needs these roles:

- **Earth Engine Resource Writer**, not only Viewer. Making a map
  (`earthengine.maps.create`) is a write, and Viewer was refused on the
  first live run.
- **Service Usage Consumer.**

**Algorithm names.** The REST API's algorithm names are not always the JS
client's method names. The project's own list is the authority: `GET
https://earthengine.googleapis.com/v1/projects/<project>/algorithms`, asked
with the server's auth. For example, the JS `FeatureCollection.style` is
`Collection.style` in REST, and Earth Engine answered `Unknown function:
'FeatureCollection.style'` until the boundaries used it. Check that list
before writing a new kind of expression.

**Setup.** Put the account's JSON key at `.gev-secrets/earth-engine.json`.
That folder is gitignored, and the key never leaves the server. Then set, in
`.env`:

```
EARTH_ENGINE_KEY_FILE=.gev-secrets/earth-engine.json
EARTH_ENGINE_PROJECT=true-energy-511503-v7
```

Until both are set and the file exists, each row says "Set
EARTH_ENGINE_KEY_FILE and EARTH_ENGINE_PROJECT in .env to draw the Earth
Engine layers", and nothing is fetched.

**How it works** (`server/providers/earthEngine.js`). It uses Earth Engine's
REST API, with no npm dependency. The official `@google/earthengine` client
pulls in about 110 MB (`googleapis@92`).

1. The server signs a JWT with the key (RS256, `node:crypto`) and exchanges it
   for an access token, which it keeps for its hour.
2. For each layer it makes a map: `POST
   /v1/projects/<project>/maps` with the layer's expression, the computation
   graph Earth Engine's own clients send. The map is made again after two
   hours, or when a tile says it has expired. One request is in flight per
   layer at a time. When a new map cannot be made, the old one keeps serving.
3. The browser asks this server for tiles at
   `/api/earth-engine/tile/<layer>/<variant>/<z>/<x>/<y>`. The server keeps
   each tile on disk for 30 days in `.gev-cache/earth-engine/tiles/`.
4. Tiles fetched from Earth Engine count against `EARTH_ENGINE_DAILY_TILES`
   (20,000 a day by default); tiles from disk do not. Past the budget, the
   server answers 429.
5. `GET /api/earth-engine/layers` lists the layers with their tile template,
   legend, attribution and map expiry. When Earth Engine refused a map, it
   also carries Earth Engine's own error text, which the row's status line
   shows.

Both routes are same-site only. The exact JSON sent for each layer is
committed as `src/data/fixtures/earth-engine-expressions.json`, so a
rejection can be read against what was sent. A test fails when a layer's
request and the fixture drift apart.

**Tile guards** (`src/layers/earthEngine/index.js`). Draped on the photoreal
tileset, an unguarded overlay asked for 1,158 slope tiles for one 60 km view
over Baltimore, at levels 2 to 8 across the planet. That is 6% of a day's
budget, for one layer in one view.

The cause is in Cesium 1.138: `ModelPrimitiveImagery` drapes about one
imagery tile (up to nine) on every loaded primitive, at the level whose tile
spans it. The tileset loads every ancestor from the planet-wide root down,
so its coarse ancestors ask for coarse tiles across their whole footprint.
The globe asks for 77 to 143 tiles for the same view.

Each overlay now:

- **Covers only the view's neighbourhood.** It is an `ImageryLayer` with a
  `rectangle`: a square six times the camera height across, at least
  40 km, around the point under the middle of the view. Past a 5,000 km
  half-side, it covers the whole world. The square is rebuilt when the view
  moves half way to its edge, or when the height doubles or halves. A
  rebuild costs no Earth Engine tiles, because the browser (`max-age` a
  day) and the server's disk (30 days) keep them. In a model of the
  tileset at that 60 km view, Cesium's own coverage code asked for 1,482
  tiles without the square and 225 with it.
- **Stays dark above its ceiling.** Above the record's `maxHeightM` nothing
  is asked for, and the row says "Zoom in below 500 km to draw it". The
  ceilings are 500 km for slope, aspect and hillshade, 3,000 km for forest
  loss, and none for the boundaries (their first level is for far views).
- **Goes no deeper than its `maxZoom`:** 14 for terrain, 12 otherwise.
- **Keeps `minimumLevel` at 0, on purpose.** Cesium clamps a primitive's
  level _up_ to the provider's minimum. A raised minimum would therefore
  make a planet-sized primitive ask for every tile of that level: far more
  tiles, not fewer.

**Counting.** `.gev-cache/earth-engine/usage.json` holds the day's Earth
Engine tiles, in all and per layer (`{day, tiles, byLayer, warned}`); tiles
served from disk are not counted. `GET /api/earth-engine/layers` returns
each layer's `tilesToday`, and its row shows "N tiles today, this layer"
beside "used of budget tiles today". The server logs one line, once a day
each, at 50% and at 90% of `EARTH_ENGINE_DAILY_TILES`, naming the layers
that used the most:

```
[EarthEngine] 50% of today's tile budget used (10000 of 20000; ee-terrain-slope 6200, …)
```

**Adding a layer** is a record in `src/data/earthEngineLayers.js`; the file's
header lists the fields. Then:

1. Regenerate the expressions fixture.
2. Add the id to the ANALYSIS group in `src/ui/layerPanel.js` and to
   `src/voice/layerManifest.js`.
3. Add its name to `src/ui/layerNames.js` and to `forkStrings.test.mjs`,
   with Spanish and Russian names.
4. Bump the layer counts in `src/app/constructCatalog.test.mjs` and
   `src/app/sourceComposition.test.mjs`.

An image layer names an asset (a collection is mosaicked) and its band, and
optionally a terrain operation, `selfMask` and `vis` (min, max, palette). A
features layer names a table and a `style`, with variants by camera height.

Every layer has a `maxZoom`, and may have a `maxHeightM`: the camera height
above which it asks for nothing. Set one for anything that says nothing from
far away. Without it, the layer draws (and spends tiles) from orbit.

Anything else Earth Engine can compute needs a small addition to
`expressionFor`. Use the REST names from the project's `algorithms` list.

## Keyless basemaps (MAP SOURCE)

Fourteen more map sources that need no key, under the five upstream chips in
the MAP SOURCE tray. The chips stay as upstream renders them; everything
else is in one grouped **More styles…** picker below them
(`src/mapStackMore.js`). The picker shows the active style lit, with a short
note when the style has a limit, and the placeholder while a chip is active.
A style that cannot be built (no network, a refused request) and a style
whose tiles fail twice both fall back to OSM, as Esri does upstream.

| Group   | Style                                       | Source                                                                                                         | Levels | Attribution                                                                   |
| ------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| Blank   | Blank (black), Blank (white)                | No imagery at all: the bare globe painted with `globe.baseColor`                                               | —      | none                                                                          |
| Light   | Natural Earth II                            | CesiumJS's bundled tile set (`Assets/Textures/NaturalEarthII`)                                                 | 0–2    | Natural Earth (public domain)                                                 |
| Light   | CARTO Positron, Positron (no labels)        | `basemaps.cartocdn.com` (`light_all`, `light_nolabels`)                                                        | 0–20   | © OpenStreetMap contributors © CARTO                                          |
| Dark    | CARTO Dark Matter, Dark Matter (no labels)  | `basemaps.cartocdn.com` (`dark_all`, `dark_nolabels`)                                                          | 0–20   | © OpenStreetMap contributors © CARTO                                          |
| Terrain | OpenTopoMap                                 | `tile.opentopomap.org`                                                                                         | 0–17   | Map data © OpenStreetMap contributors, SRTM; map style © OpenTopoMap (CC-BY-SA) |
| NASA    | NASA Black Marble                           | GIBS WMTS, `VIIRS_Black_Marble` (2016 night lights), EPSG:3857, `GoogleMapsCompatible_Level8`                  | 0–8    | NASA GIBS (ESDIS)                                                             |
| NASA    | NASA Blue Marble                            | GIBS WMTS, `BlueMarble_NextGeneration`, EPSG:3857, `GoogleMapsCompatible_Level8`                               | 0–8    | NASA GIBS (ESDIS)                                                             |
| Stamen  | Stamen Toner, Toner Lite, Terrain, Watercolor | `tiles.stadiamaps.com` (`stamen_toner` 0–20, `stamen_toner_lite` 0–20, `stamen_terrain` 0–18, `stamen_watercolor` 0–16) | see source | © Stadia Maps © Stamen Design © OpenMapTiles © OpenStreetMap contributors |

Each style's attribution is carried by its imagery provider and shown in
Cesium's credit line while it is on screen. The URL shapes were checked
against the live services on 2026-10-17 (a z=9 GIBS tile is a 400; a z=17
watercolor tile is an empty 204).

**Fair use.** OpenTopoMap is a volunteer-run service for interactive use:
the style stays within 17 levels, and nothing bulk-loads it. GIBS is NASA's
public service and keyless. CARTO's raster basemaps are free for
non-commercial use with attribution. Stadia Maps serves the Stamen styles to
`localhost` without a key; from any other origin set `STADIA_MAPS_API_KEY`
in `.env` (free at client.stadiamaps.com). The key is appended to tile URLs
the browser loads, so like `MAPILLARY_CLIENT_TOKEN` it is client-exposed by
design (`build/vite.js` injects it; restrict it to your domain at Stadia).
It is never logged. The key is registered as a hidden POWER UP row
(`stadia-maps`), so it never counts as a missing key.

**How it works.**

- `src/maps/keylessBasemapCatalog.js` holds the records (id, labels, group,
  note, how to draw, credit). Pure data: the tray, the share-link codec and
  the voice vocabulary read it without Cesium. `MAP_STACKS` (catalog.js)
  appends one descriptor per record, kind `keyless-basemap`.
- `src/maps/keylessBasemaps.js` builds the provider for a record
  (`UrlTemplateImageryProvider` for CARTO, OpenTopoMap, GIBS and Stadia;
  Cesium's `TileMapServiceImageryProvider` for Natural Earth II; `null` for
  a blank globe) and the registry entry `defaultSources.js` hands the map
  controller: the same terrain as the other 2D stacks, the credit, and the
  OSM fallbacks.
- A blank style resolves to no provider. The controller (`controller.js`,
  two "Personal fork" lines) then adds no imagery layer and paints
  `globe.baseColor` (`src/maps/globeBaseColor.js` remembers Cesium's own
  colour and restores it under the next imagery). Earth Engine and the
  other draped overlays still find the shown globe to drape on
  (`imageryHost.js`).
- Share links accept every id as `map=` (`src/view/index.js`), the voice
  tool `set_map_stack` lists them with spoken aliases ("dark matter",
  "black marble", "night lights", "toner", "watercolour", "topo", "blank",
  "white globe"…; `src/voice/gevActions.js`), the submarine cables classify
  them against terrain (`CABLE_GLOBE_STACK_IDS`), and the first Google key
  strips them from the restart hash like OSM and Esri
  (`stripKeylessBasemapFromHash`).

**Adding a style** is one record in `keylessBasemapCatalog.js`, then the
same id in the five literal lists above (the tests in
`src/maps/keylessBasemaps.test.mjs` and `src/voice/gevActions.test.mjs` fail
until every list agrees), its translations in `es.json` and `ru.json` for
any note, and a row here.

## Smaller additions

- **Frame cache.** Camera stills are kept for their Cache-Control lifetime (at
  most an hour, 500 frames or 64 MB), so an open panel asks OpenCCTV at most
  every 10 minutes and Windy every 2.5 minutes
  (`server/providers/cctv/frameCache.js`).
- **Operator link.** Under the meta line, for any camera with an operator
  page.
- **Link-only cameras.** A synthetic "opens on operator site" frame, with no
  upstream request.
- **Upstream response bodies** are now always cancelled, which stopped a dev
  server crash (`server/providers/common/http.js`).
- **Older fork commits that upstream solved differently.** The fork's https
  Bing tiles (`5b294fa3`, PR #1104) and server-side Google geocoding
  (`4c613f02`, PR #1105) were closed unmerged upstream, which fixed both its
  own way (#1092, #693). The 2026-10-16 upstream sync replaced the fork's
  versions with upstream's.

## Keeping up with upstream

The fork branched from upstream at `8b8ccc9a`. It was last synced with
`origin/main` at `79176667` on 2026-10-16 (branch `personal/upstream-sync`).

```bash
git fetch origin
```

```bash
git checkout local-fixes
```

```bash
git merge origin/main
```

**Files most likely to conflict** (changed on both sides):

- `server/providers/cctv/catalog.js`: `LIVE_PACKS`. Upstream added nyc,
  toronto and lithuania where the fork added mdot and its own packs.
- `scripts/package-boundaries.json`: both sides add modules. Resolve by
  keeping both lists; the file is edited as text, never reformatted.
- `src/app/constructCatalog.js`: new layers and Street Level sources.
- `server/providers/cctv.js`, `server/providers/cctv/sources.js` and
  `normalize.js`.
- `src/ui/cctvPresentation.js`, `src/ui/templates/layer-panels.html` and
  `src/ui/styles/cctv.css`.
- `src/data/dataCredits.js`, `.env.example` and `DATA_SOURCES.md`.
- **Layer counts in tests.** `src/app/constructCatalog.test.mjs` (two
  places) and `src/app/sourceComposition.test.mjs` assert `layers.length`.
  The fork's count is upstream's plus 8 (the two Baltimore layers, Recorded
  Video and the five Earth Engine overlays): 40 since the Earth Engine
  layers (2026-10-17). A record added to `src/data/earthEngineLayers.js` or an
  upstream layer added later changes the number.
- **Translations.** Upstream checks that every UI string is marked for
  translation (`npm run i18n`). Fork UI text goes through `t()`, `tn()` and
  `msg()` (or `data-i18n*` in markup) like upstream's, with Spanish and
  Russian entries in `src/i18n/locales/`. `src/i18n/forkStrings.test.mjs`
  fails when a fork module adds text without both translations. Brand names
  (YOUTUBE, WINDY, STREET VIEW, WIKIDATA) stay English.
- **Street Level providers.** Upstream's Google provider took
  `providers/google/`; the fork's indoor provider moved to
  `providers/googleIndoor/`.

**Two fixes that diverged from upstream** (resolved in the 2026-10-16 sync by
taking upstream's version and re-applying what only the fork needs):

- **Bing tiles over https** (`src/maps/imagery.js` and
  `src/maps/sourceFactories.test.mjs`).
  - The fork (`5b294fa3`) rewrites the ion provider's private
    `_imageUrlTemplate` to https in `upgradeBingTileProtocol`.
  - Upstream PR #1092 (merged 2026-10-14) resolves the ion endpoint and builds
    a `BingMapsImageryProvider` with `tileProtocol: 'https'` through public
    APIs, keeping ion's credits.
  - Same result, different code. Take upstream's.
- **Google geocoding through the server.**
  - Files: `server/providers/places/google.js`, `google-key.js`,
    `src/search/defaults.js`, `src/search/http.js`,
    `src/googleGeocodeProxy.test.mjs` (added on both sides).
  - The fork (`4c613f02`) adds one route, `/api/google/geocode`, that takes
    `address` or `latlng`.
  - Upstream PR #693 (merged 2026-10-15, issue #363) builds its routes with an
    `installGeocodeRoute` helper and adds a separate
    `/api/google/reverse-geocode` taking `lat`/`lon`, which the browser's
    reverse geocoder calls.
  - Take upstream's, then keep the fork's `requestNearbyPlaces` helper in
    `places/google.js`, which the indoor Street View probe uses.

After a merge, run:

```bash
npm test
```

```bash
npm run format:check
```

```bash
npm run check:boundaries
```

On Windows, `npm test` has one known failure ("Codex login resolves an
installed executable before PATH…"). Set `CCTV_LINKED_ENABLED=0` while
testing so the catalog tests stay offline.

## What you need to do

These keys go in `.env`; the in-app POWER UP panel doesn't list them.

- [ ] Enable **Maps Embed API** for the browser key (`GOOGLE_MAPS_API_KEY`),
      for the indoor Street View viewer.
- [ ] Enable **Street View Static API** and **Places API (New)** for the server
      key (`GOOGLE_MAPS_SERVER_API_KEY`), for the indoor-view search.
      **Geocoding API** on the same key is used for featured-cam place
      suggestions.
- [ ] Get a free **NPS key** from developer.nps.gov and set `NPS_API_KEY`.
- [ ] Set `YOUTUBE_API_KEY` for featured-cam live status, restarted-stream
      lookup and the channel watcher.
- [ ] Set `WINDY_WEBCAMS_API_KEY` for Windy webcams, and turn on HIDE WINDY
      before sharing screenshots.
- [ ] Run camindex (`discover`, then `build`) when you want its cameras, or
      install the nightly task (camindex section) so it keeps itself current.
- [ ] Optional: `STREETVIEW_INDOOR_GRID=1`, `CCTV_AUDIO_SWEEP=1`.
