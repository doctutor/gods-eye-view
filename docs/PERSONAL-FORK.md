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
- [Grid (REFERENCE)](#grid-reference)
- [Wikipedia coverage (ANALYSIS)](#wikipedia-coverage-analysis)
- [Level of detail](#level-of-detail)

- [Keyless basemaps (MAP SOURCE)](#keyless-basemaps-map-source)
- [The Countries basemap (MAP SOURCE)](#the-countries-basemap-map-source)
- [H3 hexes (resolution by perspective)](#h3-hexes-resolution-by-perspective)
- [Point rollups: camera counts per hex](#point-rollups-camera-counts-per-hex)
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
`gev.earthEngine.opacity.<id>`), and a status line. The boundaries row also
has level and ink chips (below).

| Layer                                     | Dataset (Earth Engine id)                                                                                                        | Licence                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Terrain slope, Terrain aspect, Hillshade  | Copernicus DEM GLO-30, `COPERNICUS/DEM/GLO30_2024_1` (`ee.Terrain`); above 3,000 km GMTED2010, `USGS/GMTED2010_FULL`, band `mea` | Copernicus DEM licence; notice required (GMTED2010: USGS, public domain) |
| Forest loss (2001–2025, coloured by year) | Hansen Global Forest Change v1.13, `UMD/hansen/global_forest_change_2025_v1_13`, band `lossyear`                                 | CC BY 4.0                                                                |
| Administrative boundaries                 | FAO GAUL 2025, `FAO/GAUL/2025/level1` from far out, `level2` below 800 km; countries from LSIB 2017, `USDOS/LSIB/2017`           | CC BY 4.0 (LSIB: US public domain)                                       |

The ids were taken from Earth Engine's catalog records on 2026-10-17. The
older ids, `COPERNICUS/DEM/GLO30` and `FAO/GAUL/2015/*`, are deprecated, and
the 2015 GAUL tables were noncommercial only; none of them is used any more. Each layer credits Google Earth
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
   `/api/earth-engine/tile/<layer>/<variant>/<ink>/<z>/<x>/<y>?v=<hash>`.
   The server keeps each tile on disk for 30 days in
   `.gev-cache/earth-engine/tiles/<layer>/<variant>/<ink>/<hash>/`, where
   `<hash>` is the first 12 hex digits of the SHA-256 of the map's request
   body (`mapRequestHash`). A changed expression, ink or visualization is
   a new hash, so neither the disk nor the browser's day-long cache (the
   client puts the hash, from `/layers`' `versions`, in the URL as `?v=`)
   can serve the old one's tiles. Tiles under an old hash or the old
   hashless layout are never read again and can be deleted. The server
   builds its maps from the code it started with: after a change to a
   layer, restart the dev server.
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
- **Stays dark above its ceiling, when it has one.** Above the record's
  `maxHeightM` nothing is asked for, and the row says "Zoom in below
  3000 km to draw it". Only forest loss has a ceiling (3,000 km): its
  loss-year pixels mean nothing averaged down. Slope, aspect and hillshade
  draw from orbit since 2026-10-18 (see
  [Level of detail](#level-of-detail)): Earth Engine computes them at the
  tile's scale from the elevation averaged to it. Above 3,000 km they draw
  from GMTED2010 (`far`), below from the Copernicus DEM (`near`): the
  Copernicus mosaic is some 26,000 images, and a z 0 to 2 tile of it took
  Earth Engine 10 to 156 s, past the proxy's 30 s, where GMTED2010, one
  pyramided image, answered every z 0 to 3 tile in under 0.5 s (both
  measured 2026-10-18). Its sea, stored as 0, is masked (`seaIsZero`). The
  terrain variants have no chips. From orbit the slope is near 0° almost
  everywhere and the hillshade near flat: averaged elevation has gentle
  slopes, and mountain ranges begin to show at about z 3. The boundaries
  have no ceiling either (their first level is for far views).
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

**Levels and ink** (the boundaries row). Two rows of chips:

- **AUTO / COUNTRIES / REGIONS / DISTRICTS** choose the GAUL level. AUTO
  is the height rule (states and provinces above 800 km, districts
  below); the others force one level everywhere, kept as
  `gev.earthEngine.level.<id>`. DISTRICTS from far out works but the row
  says the tiles arrive slowly: Earth Engine rasterises the whole level-2
  table into each coarse tile. **GAUL 2025 has no level0**: the API's
  `FAO/GAUL/2025` folder lists `level1` and `level2` only (checked
  2026-10-18 with one authenticated request), so COUNTRIES draws the
  US Department of State's LSIB 2017 (`USDOS/LSIB/2017`, US public
  domain; its interior boundaries follow US government policy on
  disputes).
- **Why LSIB 2017 for the countries.** GAUL 2015's level0 (the earlier
  choice) stores Canada and the United States as rectangular pieces cut
  along even parallels and meridians (292 features for 276 codes: Canada
  in 10, the United States in 5, Australia in 3, the West Bank in 2), and
  `Collection.style` outlined every piece, so the cuts showed as straight
  false borders (98.18° W and 31.68° N in the United States, 116.76° W and
  100.12° W in Canada, a box over British Columbia). `USDOS/LSIB_SIMPLE/2017`
  and `FAO/GAUL_SIMPLIFIED_500m/2015/level0` are chunked too. LSIB 2017 has
  one feature per country (279 for 279 names), shows only real borders and
  coasts at z 1 to 3, and its tiles took Earth Engine 0.4 to 4.4 s (z 1:
  1.0 to 3.7 s; measured 2026-10-18). Drawing the edges of GAUL 2015's
  code instead (`Image.paint` the code, `Image.neq` against
  `Image.focalMin`) also hid the seams, but its z 2 and 3 tiles took 15 s
  to over 200 s and its z 0 and 1 tiles did not finish in 240 s, so it
  was dropped (commit `e3cadce2` has it). The GAUL 2025 tables have one
  feature per unit (level1: 3,104 features, 3,103 codes; level2: 43,819
  and 43,819) and need nothing. Every features table tried here (GAUL 2015 and
  2025, LSIB 2017) fails its z 0
  tile ("Can't transform (…, 90.0)", Antarctica's pole in Web Mercator);
  Cesium draws z 1 there.
- **AUTO INK / LIGHT INK / DARK INK** choose the line colour. Earth Engine
  bakes the colour into the tiles, so white lines vanished on the white
  globe, Positron, the light Stamen styles and the light Countries maps.
  Each features layer now names its `inks` (`ffffffcc` light, `1a1a1acc`
  dark, the same width), the server makes **one map per (layer, variant,
  ink)** and keys its disk cache by the ink and the map's hash
  (`.gev-cache/earth-engine/tiles/<layer>/<variant>/<ink>/<hash>/z/x/y.png`), and
  the tile route is `/tile/<layer>/<variant>/<ink>/<z>/<x>/<y>` (`default`
  for the image layers). `/layers` advertises each layer's `inks`. On AUTO
  the client draws the ink the basemap wants: every map stack record now
  carries `luminance: 'dark' | 'light'` (`src/maps/catalog.js`,
  `keylessBasemapCatalog.js`, the Countries themes), the map stack
  controller exposes `getActiveLuminance()`, and `src/maps/ink.js` turns
  it into an ink (light on dark, dark on light); every settled map switch
  re-picks it, and the legend swatch follows. LIGHT and DARK force one,
  kept as `gev.earthEngine.ink.<id>`.

**Adding a layer** is a record in `src/data/earthEngineLayers.js`; the file's
header lists the fields. Then:

1. Regenerate the expressions fixture.
2. Add the id to the ANALYSIS group in `src/ui/layerPanel.js` and to
   `src/voice/layerManifest.js`.
3. Add its name to `src/ui/layerNames.js` and to `forkStrings.test.mjs`,
   with Spanish and Russian names.
4. Bump the layer counts in `src/app/constructCatalog.test.mjs` and
   `src/app/sourceComposition.test.mjs`.
5. Go through the [Level of detail](#level-of-detail) checklist.

An image layer names an asset (a collection is mosaicked) and its band, and
optionally a terrain operation, `selfMask` and `vis` (min, max, palette);
or, like the terrain layers, `auto` variants (a far and a near source)
chosen by camera height, with no chips. A features layer names a table, a
`style`, its `inks`, and variants: those marked `auto` are chosen by
camera height, the rest only by a chip. Check a table for chunks (more
features than units) before using it: its outlines show every cut.

Every layer has a `maxZoom`, and may have a `maxHeightM`: the camera height
above which it asks for nothing. Set one only for a quantity that means
nothing once averaged down (forest-loss years); anything that pyramids
sensibly (elevation and what is derived from it) should draw from orbit.

Anything else Earth Engine can compute needs a small addition to
`expressionFor`. Use the REST names from the project's `algorithms` list.

## Grid (REFERENCE)

The **Grid** layer, in the REFERENCE group of the DATA LAYERS panel, is off
by default. It draws a latitude–longitude graticule clamped to the ground,
so it lies on terrain and on the photoreal 3D tiles alike
(`src/layers/grid/`).

**Lines.** The spacing follows the camera's height so that about 4 to 12
lines cross the view: 30°, 10°, 5°, 2°, 1°, 30', 10', 5', 1'.

- **Only around the view.** Lines are made in a window three view-widths
  each side of the view's centre, at most 40 a side. Parallels stop at
  ±85°, meridians spread out near the poles, and longitudes stay continuous
  across the antimeridian. The set is rebuilt when the camera settles
  somewhere it no longer covers, or the spacing changes; nothing runs per
  frame.
- **Marked lines.** The equator and the prime meridian are amber and
  thicker. The tropics (±23.4365°) and polar circles (±66.5635°) are
  dashed.
- **Labels** sit near the view's west and south edges, in the HUD's
  colours and notation (`38°N`, `76°30'W`, `180°`). `src/ui/dms.js` now
  holds the HUD's degrees-minutes-seconds formatting, shared by `src/hud.js`
  and the grid. The HUD's readout is unchanged, checked over 40,000
  values.

**How it is drawn.**

- **Lines:** one `GroundPolylinePrimitive` (`classificationType` BOTH:
  terrain and 3D Tiles), plus a dashed one for the tropics and polar
  circles, both in `scene.groundPrimitives`. Parallels are rhumb lines.
  Ground primitives are made asynchronously, which loads Cesium's
  approximate terrain heights the first time.
- **Labels:** entries in the app's world-overlay host, like all world
  text (`src/noCesiumLabels.test.mjs` forbids Cesium labels). They are
  screen-space, in the overlay's mono font, at the crossings' positions on
  the ellipsoid, with no terrain occlusion so they show over buildings.
- **Without depth textures** (`GroundPolylinePrimitive.isSupported`), the
  lines are drawn at sea level, and the row says so.

**Row.** The row has:

- an opacity slider (the Earth Engine rows' control, kept as
  `gev.grid.opacity`);
- the spacing drawn (in MGRS, with the view centre's reference, such as
  `18S UJ 23 06`);
- an ink switch, kept as `gev.grid.ink`: **AUTO INK** follows the
  basemap's luminance through the map stack controller (the HUD's cyan and
  amber on imagery and dark styles; a dark blue-grey `#2f4f6f` and a brown
  `#8a5a00` on the white globe, Positron, the light Stamen and Countries
  styles), the labels in the same ink; **LIGHT INK** and **DARK INK**
  force one. Each settled map switch redraws the lines when the ink
  changes;
- a mode switch, kept as `gev.grid.mode`:
  - **LAT/LON**, the graticule.
  - **TISSOT**, Tissot's indicatrix. At each graticule crossing near the
    view (150 at most, the nearest first) it draws a circle of the same real
    radius, a third of the spacing, so circles never touch. The graticule
    stays, faint. The circles are true circles on the WGS84 ellipsoid
    (Vincenty's direct formula, matching Cesium's `EllipsoidGeodesic` to
    1e-11), so their unequal shapes on screen are the view's own
    foreshortening. None is drawn within its radius of a pole.
  - **MGRS**, the Military Grid Reference System, in place of the
    graticule (`src/layers/grid/mgrs.js`, `src/layers/grid/utm.js`).
    - **Levels.** Like the graticule's spacing, the level follows the
      camera's height: the grid zones (6° by 8°, labelled `18S`), then
      100 km squares (`18S UJ`), then 10 km and 1 km lines. The fine lines
      are labelled with their kilometre digits near the view's west and
      south edges, with the square's reference at the corner.
    - **Zones.** The zone boundaries are amber, and are always drawn,
      including Norway's 32V and Svalbard's 31X–37X. UTM lines are traced
      in each zone's own grid and cut where the zone ends, so they meet its
      edge at their true slant.
    - **Bounds.** Lines come only from the graticule's window around the
      view: at most 40 per axis in a zone, and 240 pieces in all, the
      view's zone first. MGRS stops at 80°S and 84°N; the polar UPS caps
      are not drawn, and the row says so there.
    - **Arithmetic.** Transverse Mercator on WGS84 by Krüger's series to
      sixth order (Karney 2011). Round trips agree to the nanometre, and
      the Eiffel Tower gives Veness's published `31U DQ 48251 11932`. The
      100 km lettering is the WGS84 ("AA") scheme. There is no dependency.

## Wikipedia coverage (ANALYSIS)

**Wikipedia coverage**, the last row of the **ANALYSIS** group, drapes a
heat raster of where English Wikipedia has written about the Earth, in the
spirit of the Oxford Internet Institute's maps of the uneven geographies of
Wikipedia and of Earth Engine's catalog rasters. Every article with a
primary coordinate (Wikimedia's GeoData extension, `geo_tags`) is counted
into a 0.05° cell (about 5.5 km at the equator, 7200 × 3600 cells), and the
cells are coloured on a logarithmic inferno-like ramp: transparent where
there is nothing, a dark half-seen plum at the ramp's floor, pale yellow at
its ceiling. The floor and ceiling are the 5th and 99.5th percentiles of the
non-empty cells, so the ramp spans what is there rather than the few
densest blocks of Manhattan.

The row's chips switch between three variants:

| Chip                           | What a pixel shows                                                                                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Articles per km²** (default) | primary geotagged articles under the pixel, divided by the cells' area (per km², with each row's spherical cell area, so a 60° N cell counts half an equatorial one)                       |
| **Text per km²**               | bytes of the articles' wikitext per km²: article _size_, not words, and only when the build included the page table (below); otherwise the chip is greyed and choosing it says what to run |
| **Articles (count)**           | the raw number of articles under the pixel, not divided by area, so it grows as you zoom out                                                                                               |

The legend is the ramp in five swatches, labelled with the variant's floor
and ceiling (the last marked `+`); the opacity slider is kept in this
browser as `gev.wikipediaCoverage.opacity`; the status line names the dump
date and the article count. The layer is off by default, is not in share
links, and voice cannot control it. Tiles go no deeper than z 9, where a
cell is an 18-pixel square; Cesium upsamples below that. Like the Earth
Engine overlays it drapes through `maps/imageryHost.js` (the globe, or a
photoreal tileset's own imagery layers), and covers only a view-sized
rectangle on a tileset (the Earth Engine layer's rectangle and rebuild
rule, imported from it).

Attribution: "Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData", in the credit
line and the data-attribution popover. The counts are facts about
Wikipedia, not its text; the dump's licence is Wikipedia's.

**Building the grid** (`scripts/wikipedia/`). Nothing is fetched at request
time: the server reads a grid you build.

```
npm run wikipedia:build            # articles per km² and counts (about a minute)
npm run wikipedia:build -- --text  # also article sizes: streams the 2 GB page table once
npm run wikipedia:status           # what is built, from which dump, how old
```

1. It downloads Wikimedia's GeoData dump,
   `https://dumps.wikimedia.org/enwiki/latest/enwiki-latest-geo_tags.sql.gz`
   (54 MB), with the User-Agent
   `gods-eye-view-personal-fork/0.1 wikipedia-coverage (+https://github.com/doctutor/gods-eye-view)`
   as Wikimedia's policy asks, one connection at a time, and keeps the
   answer's ETag and Last-Modified in `geo_tags.meta.json`. A re-run sends
   them back; an unchanged dump is a 304 and a few seconds.
2. It streams the file through gunzip and a MySQL-dump parser
   (`scripts/wikipedia/dump.mjs`: the `CREATE TABLE` gives the column order,
   each `INSERT … VALUES` statement its rows, in chunks of any size), keeps
   `gt_globe = 'earth'` and `gt_primary = 1`, and bins by `gt_lat`,
   `gt_lon`. The poles and 180° fall in the last row and column; anything
   outside ±90° / ±180° or with a NULL coordinate is dropped and counted as
   invalid. The 2026 dumps write one tuple per line after `VALUES`; older
   ones put them on one line; both parse.
3. With `--text` it streams `enwiki-latest-page.sql.gz` (about 2 GB
   compressed, some 63 million rows) once, after a 2 s pause, adding
   `page_len` to the cell of every page the geo pass kept (redirects are
   skipped). It is never written to disk. The Action API (`prop=info`,
   50 ids a request) would be some 27,000 requests and was not used.
4. It sums the base into four coarser levels (0.1°, 0.2°, 0.4°, 0.8°,
   the last 450 × 225) and writes `grid.bin`: `'WGRD'`, a JSON header
   (built-at, the dump's ETag and date, row counts, the top types and
   countries, the ramp domains) and the arrays, Uint32 counts and Float32
   bytes, each level at its own offset so the server reads only the levels
   a view needs. 132 MB without text, 264 MB with.

Everything lives in `.gev-cache/wikipedia/` (or `WIKIPEDIA_COVERAGE_DIR`):
the dump, `geo_tags.meta.json`, `grid.bin` and `runs.jsonl`, one line a run.
None of it is committed; the tests use a 301-row synthetic fixture in
`scripts/wikipedia/fixtures/` in the shape of both dumps.

**Refresh.** The GeoData dump is published about twice a month, so the
schedule is monthly, not nightly: run `npm run wikipedia:build` (with
`--text` if you want sizes) from a monthly Task Scheduler or cron entry, or
by hand when `wikipedia:status` says the grid is older than a month. The
ETag makes a month without a new dump cost nothing but the request.

**First real run** (2026-10-18, dump of 2026-10-08): 2,814,713 rows,
1,259,442 primary Earth coordinates kept, 14,021 on other globes,
1,541,250 secondary tags, 0 invalid; 486,898 non-empty cells; 28 s to bin.
The articles ramp runs 0.033 to 1.35 per km² (median cell 0.052), the count
ramp 1 to 30. The commonest `gt_type` values were none (712,054), landmark
(196,351), city (148,684), edu (40,418) and railwaystation (38,588). The
`--text` pass then streamed the page table in 11 minutes and sized
1,256,943 of those articles (the rest are missing from the page table or
are redirects): 9.28 GB of wikitext, a text ramp of 58 B to 15 kB per km²
(median cell 258 B/km²), a 263 MB grid.

**Serving** (`server/providers/wikipediaCoverage.js`, same-site, GET only):

- `GET /api/wikipedia-coverage/layers`: whether a grid is built (else
  "Run npm run wikipedia:build to build the Wikipedia coverage grid"),
  built-at, the dump's date, the article count, each variant with its ramp
  domain, the tile template and the attribution.
- `GET /api/wikipedia-coverage/tile/<variant>/<z>/<x>/<y>`: the 256 × 256
  values under a Web Mercator tile, resampled from the pyramid level whose
  cells still fit a pixel (0.8° at z 0, down to the base from z 4): each
  pixel sums the cells whose centres fall under it, or reads the one cell
  it lies in when it is smaller than a cell, and divides by their area for
  the density variants. The bytes are `'WCT1'`, width, height, dtype (1 =
  Float32) as uint32, then the values; gzip when the browser accepts it
  (a sparse tile packs to a few kB). Cached a day by the browser.

The grid file is stat'ed at most every 5 s and opened again when it
changes, so a rebuild lands without a restart.

**Hexagons** (`h3.bin`, `server/providers/wikipediaCoverage/h3.js`). A
"per km²" drawn from the equal-angle grid is tied to the grid's own cells;
so that it can follow the viewer's perspective instead, the build also
aggregates the same articles into H3 hexagons (`h3-js` 4.5.0). Every kept
coordinate goes to its resolution-7 cell (about 5 km²), and each coarser
resolution down to 0 (about 4 million km², 122 base cells) sums its
children, so the counts and bytes at every resolution add up to the same
totals. That parent chain is the resolution semantics: H3's nesting is
approximate, and `latLngToCell` at a coarse resolution can name a cell
other than the parent of the point's resolution-7 cell, so a coarse
hexagon holds the articles of its child hexagons, not strictly the
articles inside its outline. Only non-empty cells are kept, one table per
resolution, sorted by
index: the index's two uint32 halves, `articles` (uint32), `bytes`
(Float64, when the build had sizes), the cell's centre (`lat`, `lon`,
Float32) and its `cellArea(cell, 'km2')` (Float32). Each table's header
carries its own ramp domains (5th / 99.5th percentile and median of the
non-empty cells) for articles per km², text per km² and the raw count,
because a hexagon at resolution 3 holds a thousand resolution-7 ones and
their densities spread differently. The file sits beside `grid.bin`,
follows the same ETag skip (a build is "up to date" only when both files
are from the current dump), and `wikipedia:status` lists its cells by
resolution. Inside one resolution a cell's low 52 bits (base cell and
digits) are its key, which fits a Number exactly; the top 12 bits (mode,
resolution) are the same for the whole table.

- `GET /api/wikipedia-coverage/h3/<res>/<variant>?west=&south=&east=&north=`
  (res 0–7; variant `articles`, `text` or `count`; the box in degrees,
  `west > east` crossing the antimeridian) answers
  `{res, variant, dump: {date}, domain: {min, max, median}, cells: [[h3Index,
value], …]}` for the cells whose **centre** lies in the box: articles and
  text per km², count raw. More than 20,000 cells is a 413 `{message}`
  (ask at a coarser resolution or for a smaller box); no `h3.bin` a 503;
  a bad resolution, variant or box a 400; the text variant without sizes
  a 404. Same cache headers as the tiles (`private, max-age=86400`, gzip
  when accepted).
- `/layers` carries `h3: {built, resolutions, cells: {res: count}, text,
maxCells}` (or `{built: false}`).

The cells are chosen by scanning the resolution's centre arrays, not by
`polygonToCells` of the box: the scan is typed-array arithmetic over the
non-empty cells only (734,514 at resolution 7 for the 2026-10-08 dump),
so an ocean-sized box costs the same as a city and nothing empty is ever
enumerated, whereas filling a large box at resolution 7 would enumerate
millions of hexagons to find a few thousand with articles. Measured on
that build: a resolution-7 query over a 1° box around Baltimore (1,390
cells) takes about 4 ms once the table is read (the first query of a
resolution reads its arrays, about 25 ms for resolution 7); the world at
resolution 3 (14,379 cells) about 5 ms; a Pacific box across the
antimeridian at resolution 7 (5,871 cells) about 5 ms. Europe at
resolution 5 or 7 is a 413: ask at resolution 4 (3,896 cells).

**Second real run** (2026-10-18, same dump): `h3.bin` 31.8 MB with 122,
702, 3,233, 14,379, 54,810, 167,423, 412,732 and 734,514 non-empty cells
at resolutions 0 to 7; 39 s for grid and hexagons together. The client
(`src/layers/wikipediaCoverage/`) paints each tile itself: a custom Cesium
imagery provider (`provider.js`, implementing what `ImageryLayer` reads in
1.138) fetches the values through Cesium's `Resource`, so its scheduler
can throttle, and colours them on a 256 × 256 canvas with `ramp.js`.

**Hexes mode.** The row's fourth chip, **Hexes**, draws H3 cells instead of
the raster: the cells of the view window at the resolution the camera
height picks (see [H3 hexes](#h3-hexes-resolution-by-perspective)),
coloured by the current variant on the same inferno ramp, with the legend
following the resolution's own domain and the row's opacity slider. They
are ground-clamped polygons (`GroundPrimitive`, classification BOTH), so
they drape on terrain and on the photoreal tileset alike
(`src/layers/wikipediaCoverage/hexes.js`). The cells come from

- `GET /api/wikipedia-coverage/h3/<res>/<variant>?west=&south=&east=&north=`
  (resolution 0–7, variant `articles` | `text` | `count`, the box in
  degrees, `west > east` across the antimeridian): `{ res, variant, dump:
{ date }, domain: { min, max, median }, cells: [[h3Index, value], …] }`,
  the density variants per km² of the cell's area, `count` raw, the domain
  the resolution's own quantiles of non-empty cells. `413 { message }` when
  the box holds more than 20,000 cells at that resolution, `503 { message }`
  while the H3 grid is not built.

The window is the Earth Engine rectangle rule (the whole planet past a
5,000 km half-side) and the surface is rebuilt on `moveEnd` when the
resolution or the window changes; a 413 asks once more one resolution
down, a second refusal shows the server's message in the status line. A
503 (no H3 grid) or a 404 (the `text` variant when the hex grid was built
without `--text`) greys the chip that asked, with the message below.
Values are per-resolution rollups along the H3 parent chain: a coarse
hexagon holds its child hexagons' articles, which is not strictly the
articles inside its drawn outline, since H3 nesting is approximate. The
client was written to the endpoint's contract against the committed
fixture `src/data/fixtures/wikipedia-coverage-h3-europe.json` (resolution
2 over Europe, synthetic densities) and drawn with real Cesium in headless
Chrome from that fixture; the live route (server/providers/
wikipediaCoverage.js, from local-fixes `181f947a`) answers the same shape.

## Keyless basemaps (MAP SOURCE)

Fourteen more map sources that need no key, under the five upstream chips in
the MAP SOURCE tray. The chips stay as upstream renders them; everything
else is in one grouped **More styles…** picker below them
(`src/mapStackMore.js`). The picker shows the active style lit, with a short
note when the style has a limit, and the placeholder while a chip is active.
A style that cannot be built (no network, a refused request) and a style
whose tiles fail twice both fall back to OSM, as Esri does upstream.

| Group   | Style                                         | Source                                                                                                                  | Levels     | Attribution                                                                     |
| ------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------- |
| Blank   | Blank (black), Blank (white)                  | No imagery at all: the bare globe painted with `globe.baseColor`                                                        | —          | none                                                                            |
| Light   | Natural Earth II                              | CesiumJS's bundled tile set (`Assets/Textures/NaturalEarthII`)                                                          | 0–2        | Natural Earth (public domain)                                                   |
| Light   | CARTO Positron, Positron (no labels)          | `basemaps.cartocdn.com` (`light_all`, `light_nolabels`)                                                                 | 0–20       | © OpenStreetMap contributors © CARTO                                            |
| Dark    | CARTO Dark Matter, Dark Matter (no labels)    | `basemaps.cartocdn.com` (`dark_all`, `dark_nolabels`)                                                                   | 0–20       | © OpenStreetMap contributors © CARTO                                            |
| Terrain | OpenTopoMap                                   | `tile.opentopomap.org`                                                                                                  | 0–17       | Map data © OpenStreetMap contributors, SRTM; map style © OpenTopoMap (CC-BY-SA) |
| NASA    | NASA Black Marble                             | GIBS WMTS, `VIIRS_Black_Marble` (2016 night lights), EPSG:3857, `GoogleMapsCompatible_Level8`                           | 0–8        | NASA GIBS (ESDIS)                                                               |
| NASA    | NASA Blue Marble                              | GIBS WMTS, `BlueMarble_NextGeneration`, EPSG:3857, `GoogleMapsCompatible_Level8`                                        | 0–8        | NASA GIBS (ESDIS)                                                               |
| Stamen  | Stamen Toner, Toner Lite, Terrain, Watercolor | `tiles.stadiamaps.com` (`stamen_toner` 0–20, `stamen_toner_lite` 0–20, `stamen_terrain` 0–18, `stamen_watercolor` 0–16) | see source | © Stadia Maps © Stamen Design © OpenMapTiles © OpenStreetMap contributors       |

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

## The Countries basemap (MAP SOURCE)

MapChart-style world maps, drawn as Cesium geometry on a blank globe: six
entries in the picker's **Countries** group, three styles in a dark and a
light theme. They are map sources, not data layers, so a countries style
is the ground everything else sits on.

| Style        | What it draws                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Simple       | Every country as one fill with a dark (light theme) or light (dark theme) outline, like MapChart's Simple map.                                                                                                                                                                                                                                                                                                                         |
| Subdivisions | The simple map, plus the first-level units (states, provinces, regions) as thinner outlines once the camera is below 5,000 km. Only the units around the view are built, in a square six times the camera height across (at most 10,000 km), rebuilt when the view moves half way to its edge.                                                                                                                                         |
| Hex          | Land as H3 cells at the resolution the camera height picks (see [H3 hexes](#h3-hexes-resolution-by-perspective)), each coloured by the country under its centre from a ten-colour palette: the "war games" look. Every cell of the resolution from orbit (resolutions 0 to 2), the disk of cells around the view nearer; a country with no cell centre on it still gets the cell of a point inside it, so Iceland is there from orbit. |

**Geometry.** The bundled Natural Earth packs
(`src/data/local_data/natural_earth/countries.json`, 260 countries, and
`states_provinces.json`, 4,587 units; public domain, provenance in that
folder's README), loaded on first use with `loadBundledJson`. Nothing is
fetched from the network and no server route is involved: the packs were
already in the tree for the voice annotation resolver, simplified at
0.005–0.02° with holes kept (Lesotho is a hole in South Africa). The task
asked for a download script and a `.gev-cache/natural-earth/` cache; the
packs make both unnecessary.

**Rendering** (`src/maps/countries/renderer.js`). Fills are
`PolygonGeometry` instances with a per-instance colour in one `Primitive`
(`PerInstanceColorAppearance`, flat), outlines `PolylineGeometry` instances
in another. A countries style installs flat terrain
(`EllipsoidTerrainProvider`), so the polygons at the ellipsoid are the
ground; the next imagery stack restores its own terrain. The globe is
painted the theme's ocean colour, like the blank basemaps, and the
controller adds no imagery layer. The planet-wide group is rebuilt only
when the style, theme, opacity or a country colour changes; the view-bound
group (units, hexes) on `camera.moveEnd` when the view has moved far
enough. A late pack load or build after the stack has moved on draws
nothing.

**Draped overlays.** The Earth Engine imagery drapes on the shown globe as
before (the imagery host is the globe), but Cesium draws primitives over
the globe's imagery, so an opaque countries fill covers an overlay. Lower
the fill opacity to see both:

```js
const { countriesBasemap } =
  window.__godsEyeView.styleManager.mapStackController;
countriesBasemap.setOpacity(0.5); // kept in this browser as gev.countries.opacity
```

**Colouring countries** by hand or from data, by ISO 3166-1 alpha-2:

```js
countriesBasemap.setCountryFill('UA', '#d94f4f'); // null removes it
countriesBasemap.setCountryFills({ FR: '#3b6', DE: '#36b' }); // replaces all
```

Overrides apply in every style and theme (`src/maps/countries/palette.js`;
the themes' colours are there too). Individual hexes of the hex style can
be coloured by H3 index, over the country fills, so any data can colour
the basemap:

```js
countriesBasemap.setCellFills(new Map([['82075ffffffffff', '#ffd400']]));
countriesBasemap.setCellFills(null); // clears them
```

The hexes are H3 cells (`h3-js`, see [H3 hexes](#h3-hexes-resolution-by-perspective)),
which replaced the fork's first home-made equal-area lattice: one
consistent cell hierarchy over the whole globe, no polar stretching, and
cells any data can be joined to by index.

**Tests** (`src/maps/countries/countries.test.mjs`) run on a fake viewer
and a fake Cesium against the committed fixture
`src/data/fixtures/countries-basemap.json`: Iceland, Lesotho, South Africa
and Switzerland with the first-level units of the first two, cut from the
packs. The wiring (share links, voice enum and aliases such as "hex map",
"countries", "subdivisions"; cable classification; the first-key hash
strip) follows the keyless basemaps' lists.

## H3 hexes (resolution by perspective)

Every hex surface in the fork (the Countries basemap's hex style, the
Wikipedia coverage layer's Hexes mode) uses [H3](https://h3geo.org/)
cells (`h3-js` 4.5) at a resolution the camera height picks, the way
Cesium's tiles pick their level from the camera. One helper,
`src/maps/h3Resolution.js`, holds the table; `src/maps/h3Cells.js` turns a
view into its cells.

**The table.** Looking down with Cesium's 60° field of view, a canvas
about 800 px tall shows 1.15 camera heights of ground, so a pixel is about
height / 700 metres. Each band starts where its resolution's hexes
(√3 × the average H3 edge across) would be about 58 px on screen and ends
one H3 step later (cells grow √7 ≈ 2.65× per resolution) at about 22 px.
Orbit is the exception: the whole planet is on screen there, so resolution
0's 122 cells (about 100 px across at 20,000 km) are the right surface.

| Camera height (at least) | Resolution | Hex across |
| ------------------------ | ---------- | ---------- |
| 18,000 km (orbit)        | 0          | 2,219 km   |
| 11,200 km                | 1          | 837 km     |
| 4,240 km                 | 2          | 316 km     |
| 1,600 km                 | 3          | 120 km     |
| 603 km                   | 4          | 45 km      |
| 228 km                   | 5          | 17 km      |
| 86 km                    | 6          | 6.4 km     |
| below (city scale)       | 7          | 2.4 km     |

**The cells for a view.** The view window is the Earth Engine rectangle
rule (a square six camera heights across, at least 40 km) with longitudes
that wrap, so a window across the antimeridian is one window with
`west > east`, a window reaching round a pole spans every longitude, and
past a 5,000 km half-side the window is the planet. For a planet-wide
window at resolutions 0 to 2 the cells are every cell of the resolution
(122, 842, 5,882); otherwise they are the H3 disk around the cell under
the view that covers the window's half-side, its radius capped so the
disk stays within 20,000 cells. Cell rings are made continuous across
±180° before they reach Cesium. The surfaces are rebuilt on `moveEnd`
when the resolution changes or the view has moved half way to the
window's edge (or the height doubled or halved).

Tests: `src/maps/h3.test.mjs` (the table's bands and pixel sizes, windows
across the antimeridian and over the poles, cell sets and rings).

## Point rollups: camera counts per hex

From orbit the Cameras layer drew thousands of pins that crowd and stack.
Now, while the camera is above 300 km or the view window holds more than
400 cameras, the pins hide and one hex per H3 cell shows how many are
under it, at the resolution the
camera height implies (the table above); as the view comes in the count
falls and the pins return. The Cameras row carries **ROLLUP AUTO / OFF**,
kept in this browser as `gev.cctv.rollup`.

**The rule.** Height or density, each with hysteresis: the rollup
switches on when the camera is above `ROLLUP_ENTER_HEIGHT_M` (300 km) or
more than `ROLLUP_ENTER_COUNT` (400) of the layer's pins fall in the view
window (the H3 window rule: six camera heights across, the planet past a
5,000 km half-side), and off again only when the camera is below
`ROLLUP_EXIT_HEIGHT_M` (250 km) and fewer than `ROLLUP_EXIT_COUNT` (250)
pins are in the window, so neither edge flickers; below
`ROLLUP_MIN_HEIGHT_M` (30 km) the pins always show. A dense city at 100 km
can therefore still roll up (435 synthetic pins in the window did), while
a sparser 100 km view shows pins (189 did). The decision is made again on
`moveEnd` and whenever the pins are re-culled (a catalog or proximity
load). A layer's `threshold` can pass `enterHeightM: Infinity` to decide
on the count alone. While the hexes show, the Cameras layer paints no
ambient thumbnail cards (they annotate pins).

**The module** (`src/layers/pointRollup/`): `rollup.js` holds the pure
parts (binning with `latLngToCell`, the window test, the hysteresis rule,
the log alpha ramp from 0.25 to 0.85 of the accent colour, the short
count, the label entry); `index.js` attaches to a layer. The hexes are
ground-clamped polygons through the shared drawer `src/maps/h3Surface.js`
(classification BOTH, so they drape on terrain and on the photoreal
tileset; the Wikipedia Hexes mode draws with the same drawer). The count at
each cell centre is a `label` entry published through the world-overlay
host (`src/noCesiumLabels.test.mjs` forbids Cesium labels), which also
activates like a click; a click on the hex itself (the rollup owns the
`rollup:<layer>:<cell>` pick ids in the pick registry) flies the camera to
the cell's bounds. The Cameras layer's part is `src/layers/cctv/rollup.js`:
it starts and stops with the layer, hides the pins through
`layerState._rollupHidesPins` (read by horizon culling and the coverage
styles), and offers the row's chips.

**Adopting it in another point layer** is a few lines:

```js
import { attachPointRollup } from '../pointRollup/index.js';

const rollup = attachPointRollup(
  { id: 'my-layer', viewer, overlays, cesium, picking, requestRender },
  {
    getPoints: () => records.map((r) => ({ id: r.id, lat: r.lat, lon: r.lon })),
    accent: '#39d5ff', // the layer's colour
    // optional; these are the defaults
    threshold: {
      enter: 400,
      exit: 250,
      enterHeightM: 300_000,
      exitHeightM: 250_000,
      minHeightM: 30_000,
    },
    onModeChange: (active) => {
      pins.show = !active; // hide the layer's own pins while the hexes show
    },
    onUpdate: () => repaintRow(), // optional: after each redraw or clear
  },
);
rollup.refresh(); // again when the points change; moveEnd is listened to
rollup.setEnabled(false); // the layer's own OFF
rollup.detach(); // on disable or destroy
```

`overlays` is the world-overlay host (`setEntries`, `setVisible`,
`clearSource`, as `src/overlays/worldOverlay.js` exports them or a layer's
wrapper); `picking` is `src/data/pickRegistry.js`. The featured and vessel
placement logic is untouched: the rollup only reads the points a layer
already has.

Tests: `src/layers/pointRollup/pointRollup.test.mjs` (binning, the window
across the antimeridian, hysteresis, labels through
`normalizeOverlayEntry`, the lifecycle on a fake viewer across the
threshold and with the rollup off) and `src/layers/cctv/rollup.test.mjs`
(the saved mode, the chips, pins hidden and shown). Drawn with real Cesium
and the real world-overlay host in headless Chrome over a synthetic
3,000-pin catalog: hexes with painted counts from orbit and at 2,500 km,
pins at 100 km.

## Level of detail

The fork's rule: **every layer says how its detail follows the camera**,
and draws something true at every height rather than going dark or
drowning the view. There are four ways to do it, by the kind of data:

- **Rasters: a pyramid, aggregated by what the pixels mean.** Each coarser
  level summarises four finer pixels in a way that keeps their meaning:
  the mean for a continuous quantity (elevation), the mode or a sample for
  a category. Earth Engine does this for its assets and computes every
  tile at the tile's own scale, so `src/data/earthEngineLayers.js` needs
  no cap for anything that averages sensibly; `maxZoom` bounds the deep
  end. Where a source is slow at the coarse end, a far variant swaps in a
  coarser one (the terrain layers' GMTED2010 above 3,000 km). The Wikipedia
  coverage grid's pyramid (0.8° at z 0 down to the 0.05° base from z 4)
  sums article counts the same way.
- **Derived quantities: aggregate, then derive.** Slope, aspect and
  hillshade are computed from the elevation already averaged to the
  tile's scale. From orbit that is the coarse shape of the land (gentle
  slopes, near 0° almost everywhere; mountain ranges from about z 3), and
  cheap. The other order, derive at full resolution and then aggregate
  (the mean slope of the 30 m pixels, i.e. roughness: how rugged the
  ground is, even where its average shape is flat), is a different
  quantity. Earth Engine cannot compute it on the fly for a coarse tile,
  because each one would read every 30 m pixel beneath it; it would need a
  precomputed pyramid (an exported asset) of its own.
- **Categorical rasters keep a cap.** Forest loss pixels are years of loss:
  averaged, they mean nothing, and a sampled pyramid level is noise from
  far away. It stays dark above its `maxHeightM` (3,000 km), and its row
  says how low to go.
- **Points: H3 rollups.** A point layer too dense for the view is counted
  into H3 cells at the resolution the height picks (see
  [H3 hexes](#h3-hexes-resolution-by-perspective)): Wikipedia coverage's
  Hexes mode, from resolution 0 at orbit to 7 at city scale, and the
  Cameras layer's counts per hex that give way to pins as the view comes in
  (see [Point rollups](#point-rollups-camera-counts-per-hex)).
- **Boundaries: level switching.** The administrative boundaries' AUTO
  chip draws states and provinces above 800 km and districts below;
  COUNTRIES, REGIONS and DISTRICTS force one level (LSIB 2017 countries,
  GAUL 2025 level1 and level2).
  The lines are one pixel at every zoom. The Countries basemap's
  subdivisions style does the same (admin-1 below 5,000 km, countries
  above), and the Grid steps its spacing (30° at orbit to 1' at the street;
  MGRS from grid zones to 1 km lines).

**Checklist for a new data layer:**

- [ ] Its record or module header says how its detail follows the camera:
      a pyramid (and its aggregation: mean, sum, mode, sample), a derived
      quantity (aggregate-then-derive at output scale, or a precomputed
      pyramid for derive-then-aggregate), level switching, or an H3 rollup.
- [ ] It draws from orbit unless the aggregated quantity is meaningless
      (categories, years); only then does it get a `maxHeightM`, and the
      record says why.
- [ ] Its coarsest tiles were timed against the live source (z 0 to 2),
      and a slow source has a far variant or a cache in front of it.
- [ ] A boundary table has one feature per unit (compare its feature count
      with its distinct codes); a chunked one draws its cuts as borders.

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
  The fork's count is upstream's plus 10 (the two Baltimore layers, Recorded
  Video, the five Earth Engine overlays, the Grid and Wikipedia coverage):
  42 since Wikipedia coverage (2026-10-17). A record added to `src/data/earthEngineLayers.js` or an
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
- [ ] Run `npm run wikipedia:build` (add `--text` for article sizes) for the
      Wikipedia coverage layer, and again monthly; a month without a new
      dump costs one request.
- [ ] Optional: `STREETVIEW_INDOOR_GRID=1`, `CCTV_AUDIO_SWEEP=1`.
