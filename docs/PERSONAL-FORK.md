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
  - [Forest types and Population](#forest-types-and-population)
  - [Elevation contours](#elevation-contours)
  - [Rivers](#rivers)
  - [Surface water](#surface-water)
  - [Land cover](#land-cover)
  - [Buildings](#buildings)
  - [Tree canopy](#tree-canopy)
  - [Census tracts](#census-tracts)
  - [Inundation history](#inundation-history)
- [Elevation: the DEM stack](#elevation-the-dem-stack)
- [Raster values (for Lego mode)](#raster-values-for-lego-mode)
- [Grid (REFERENCE)](#grid-reference)
- [Custom cutouts (REFERENCE)](#custom-cutouts-reference)
- [Wikipedia (REFERENCE)](#wikipedia-reference)
  - [Per capita](#per-capita)
- [Localities (REFERENCE)](#localities-reference)
- [Street assets (ANALYSIS)](#street-assets-analysis)
  - [Overture infrastructure](#overture-infrastructure)
- [Places (ANALYSIS)](#places-analysis)
- [Roads (ANALYSIS)](#roads-analysis)
- [Property sales (ANALYSIS)](#property-sales-analysis)
- [Rivers: HydroSHEDS v2 for the Americas](#rivers-hydrosheds-v2-for-the-americas)
- [Rivers: click a reach](#rivers-click-a-reach)
- [Rivers: names from OpenStreetMap](#rivers-names-from-openstreetmap)
- [Builds and restarts](#builds-and-restarts)
- [Raw downloads on an archive (GEV_RAW_DIR)](#raw-downloads-on-an-archive-gev_raw_dir)
- [Lego rendering mode](#lego-rendering-mode)
- [Colour scales: palettes and a window per layer](#colour-scales-palettes-and-a-window-per-layer)
- [Local Overpass: clone or import](#local-overpass-clone-or-import)
- [MSFS renderer on AWS](#msfs-renderer-on-aws)
- [Level of detail](#level-of-detail)

- [Keyless basemaps (MAP SOURCE)](#keyless-basemaps-map-source)
- [The Countries basemap (MAP SOURCE)](#the-countries-basemap-map-source)
- [H3 hexes (resolution by perspective)](#h3-hexes-resolution-by-perspective)
- [Point rollups: camera counts per hex](#point-rollups-camera-counts-per-hex)
- [Smaller additions](#smaller-additions)
- [Tests: budgets and flakes](#tests-budgets-and-flakes)
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

| Layer                                                              | Dataset (Earth Engine id)                                                                                                                                                                                                                        | Licence                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terrain slope, Terrain aspect, Hillshade, Elevation                | The DEM stack (see [Elevation: the DEM stack](#elevation-the-dem-stack)): GMTED2010 far out, FABDEM v1-2 as the base, USGS 3DEP 10 m and 1 m, ArcticDEM 2 m and REMA 8 m where they cover (`ee.Terrain`)                                         | FABDEM CC BY-NC-SA 4.0 (non-commercial) with the Copernicus notice; 3DEP and GMTED2010 public domain; ArcticDEM and REMA PGC/NSF acknowledgement |
| Elevation contours (see [Elevation contours](#elevation-contours)) | The DEM stack's heights, as the Elevation layer mosaics them, band by band                                                                                                                                                                       | As the terrain layers                                                                                                                            |
| Forest loss (2001–2025, coloured by year)                          | Hansen Global Forest Change v1.13, `UMD/hansen/global_forest_change_2025_v1_13`, band `lossyear`                                                                                                                                                 | CC BY 4.0                                                                                                                                        |
| Forest types (see [below](#forest-types-and-population))           | JRC global map of forest types 2020 v1, `JRC/GFC2020_subtypes/V1`, band `Map` (1 naturally regenerating, 10 primary, 20 planted)                                                                                                                 | Free to use; citation requested                                                                                                                  |
| Population (see [below](#forest-types-and-population))             | GHSL population P2023A, `JRC/GHSL/P2023A/GHS_POP`, band `population_count`, epochs 2020 (default), 2000, 1990, 1975                                                                                                                              | Reuse authorised with acknowledgement (EC reuse notice)                                                                                          |
| Administrative boundaries                                          | FAO GAUL 2025, `FAO/GAUL/2025/level1` from far out (its 500 m simplified sibling at z ≤ 8), `level2` below 800 km; countries from Overture's country lines when built locally (`npm run overture:boundaries`), else LSIB 2017, `USDOS/LSIB/2017` | CC BY 4.0 (Overture: ODbL; LSIB: US public domain)                                                                                               |
| Rivers (see [Rivers](#rivers))                                     | HydroRIVERS v1 with the Free-Flowing Rivers attributes, `WWF/HydroSHEDS/v1/FreeFlowingRivers`; names from Natural Earth                                                                                                                          | HydroSHEDS licence, attribution (Natural Earth: public domain)                                                                                   |
| Surface water (see [Surface water](#surface-water))                | JRC Global Surface Water 1.4 (1984–2021, 30 m), `JRC/GSW1_4/GlobalSurfaceWater`, bands `occurrence`, `change_abs`, `seasonality`, masked by `max_extent`                                                                                         | Copernicus, free without restriction; "Source: EC JRC/Google"                                                                                    |
| Land cover (see [Land cover](#land-cover))                         | ESA WorldCover 10 m, 2021 `ESA/WorldCover/v200/2021` and 2020 `ESA/WorldCover/v100/2020`, band `Map`                                                                                                                                             | CC BY 4.0, "© ESA WorldCover project" notice                                                                                                     |
| Buildings (see [Buildings](#buildings))                            | Google Open Buildings 2.5D Temporal v1, 2023, `GOOGLE/Research/open-buildings-temporal/v1`; footprints from Open Buildings v3, `GOOGLE/Research/open-buildings/v3/polygons`                                                                      | CC BY 4.0 (the temporal set: or ODbL 1.0)                                                                                                        |
| Tree canopy (see [Tree canopy](#tree-canopy))                      | Meta and WRI canopy height 1 m, `projects/meta-forest-monitoring-okw37/assets/CanopyHeight`; ETH Global Canopy Height 2020 10 m, `users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1`                                                                | CC BY 4.0                                                                                                                                        |
| Census tracts (see [Census tracts](#census-tracts))                | TRACTS: TIGER/Line 2020 tracts, `TIGER/2020/TRACT`; HOUSEHOLD INCOME: the Census Bureau's 2024 cartographic boundary tracts and ACS 5-year 2020–2024 B19013, drawn by the local server                                                           | US public domain                                                                                                                                 |
| Inundation history (see [Inundation history](#inundation-history)) | Global Flood Database v1, `GLOBAL_FLOOD_DB/MODIS_EVENTS/V1` (913 events, 2000–2018, 250 m)                                                                                                                                                       | CC BY-NC 4.0                                                                                                                                     |

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
  from GMTED2010, below from FABDEM and the finer regional sources (since
  2026-10-19 the DEM stack, drawn by tile zoom: see
  [Elevation: the DEM stack](#elevation-the-dem-stack)). Until then they
  drew the Copernicus DEM below 3,000 km: that mosaic is some 26,000
  images, and a z 0 to 2 tile of it took Earth Engine 10 to 156 s, past
  the proxy's 30 s, where GMTED2010, one pyramided image, answered every
  z 0 to 3 tile in under 0.5 s (both measured 2026-10-18). The terrain
  variants have no chips. From orbit the slope is near 0° almost
  everywhere and the hillshade near flat: averaged elevation has gentle
  slopes, and mountain ranges begin to show at about z 3. The boundaries
  have no ceiling either (their first level is for far views).
- **Goes no deeper than its `maxZoom`:** for terrain as deep as the
  deepest elevation source in the view's square (17 over the United
  States, 16 in the Arctic, 14 elsewhere; Elevation 14); 12 otherwise.
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
  disputes). Since 2026-10-22, while Overture's country lines are built,
  COUNTRIES draws those instead, from the local server (see
  [Boundary sources](#boundary-sources-lsib-gaul-natural-earth-overture)).
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
or, like the terrain layers, the DEM stack's bands (`demVariants()` from
`src/data/demStack.js`, `demStack: true`), drawn by tile zoom, with no
chips. A features layer names a table, a
`style`, its `inks`, and variants: those marked `auto` are chosen by
camera height, the rest only by a chip. Check a table for chunks (more
features than units) before using it: its outlines show every cut.

Every layer has a `maxZoom`, and may have a `maxHeightM`: the camera height
above which it asks for nothing. Set one only for a quantity that means
nothing once averaged down (forest-loss years); anything that pyramids
sensibly (elevation and what is derived from it) should draw from orbit.

Anything else Earth Engine can compute needs a small addition to
`expressionFor`. Use the REST names from the project's `algorithms` list.
An image layer can also have `modes` (a chip each, one map per mode):
each names a `band` of the layer's asset or its own `asset`, and its own
`vis` and `legend` (Surface water's bands, Land cover's years,
Population's epochs). The layer or its mode can then take these steps,
in this order (`imageNode` in `server/providers/earthEngine.js`): mask by
another band (`maskBand`), `remap` class codes to palette indices, mask
zero (`mask: 'self'`, or `'nonzero'` for signed values), `scale` by a
factor, mask values below `atLeast`, and draw the `log10`. Mode keys start
with a letter and may hold digits (`v200`, `density-2020`).

### Boundary sources: LSIB, GAUL, Natural Earth, Overture

The Administrative boundaries layer draws three levels from two sources
in Earth Engine: countries from LSIB 2017 (`USDOS/LSIB/2017`), and states
and provinces (`level1`) and districts (`level2`) from FAO GAUL 2025
(`FAO/GAUL/2025/level1`, `level2`). Earth Engine names FAO's 2024 release
"GAUL 2025". The Countries basemap draws Natural Earth from bundled packs
in the browser. The Localities layer reads Overture's divisions as points
only. Reviewed 2026-10-22, from each source's own pages and the Earth
Engine catalogue, with no data fetched:

| Source                                 | Levels                                                              | Licence                                     | Recency                                                                                        | Disputed territory                                                                                                                                       | Geometry                                                                                                                                                      |
| -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LSIB 2017 (in Earth Engine)            | 0                                                                   | US public domain                            | 2017-12-29. The State Department is at v11.4 (2025-02-24); Earth Engine has only 2013 and 2017 | US government policy on alignment, recognition and dispute, not necessarily de facto control                                                             | Detailed land borders; coasts from World Vector Shorelines, several hundred metres to over a kilometre off                                                    |
| FAO GAUL 2024 ("2025" in Earth Engine) | 1, 2 (no 0)                                                         | CC BY 4.0 (GAUL 2015 was non-commercial)    | 2025                                                                                           | International lines matched to the UN's 2018 reference; FAO disclaims any opinion on legal status; no dispute field (`DISP_EN` is a display label)       | One feature per unit (3,104 and 43,819); its 500 m simplified sibling (`FAO/GAUL_SIMPLIFIED_500m/2025/level1`, `level2`) draws level1's tiles at z ≤ 8        |
| Natural Earth 10m                      | 0, 1 (2: US counties only)                                          | Public domain                               | v5.1.1 on its download page; boundaries change slowly                                          | De facto by default ("who controls the territory"), with point-of-view editions for several dozen countries and disputed-area themes                     | 1:10 million, about 1 km; good from orbit, coarse below a few hundred km                                                                                      |
| Overture divisions (2026-09-23.1)      | country, dependency, (macro)region, (macro)county, down to locality | ODbL (from OpenStreetMap and geoBoundaries) | Monthly releases                                                                               | Per boundary: `is_disputed`, and `perspectives` with `accepted_by` / `disputed_by` countries, so a map can be drawn from one country's view or neutrally | OpenStreetMap detail (metres), areas land-clipped or with territorial sea; `division_boundary` is lines, `division_area` polygons; sub-county coverage spotty |

**Recommendation.** Keep GAUL for the regions and districts: it is
current, CC BY 4.0, one feature per unit, and already in use. For the
countries, LSIB 2017 is the weak link. It is eight years old, its coasts
are off by up to a kilometre, and its lines are one government's policy.
The best replacement is **Overture's `division_boundary`, country
subtype**:

- monthly, OpenStreetMap-detailed, and lines already, which is what the
  layer draws;
- disputes are first-class, so disputed segments could be drawn dashed or
  from a chosen perspective, where LSIB says only what the US recognises;
- ODbL, which the Overture buildings already carry (credit, share-alike
  only if the derived database were published).

It is not a one-line swap. Earth Engine does not host Overture, so the
lines are drawn locally, as the HydroSHEDS v2 rivers are.

**Built (2026-10-22).** COUNTRIES now draws Overture's lines while they
are built, and LSIB 2017 from Earth Engine only without them.

- **Data:** `release/2026-09-23.1/theme=divisions/type=division_boundary/`,
  one file of 512,261,151 bytes (87,530 lines: 557 country, 8,202 region,
  78,771 county). It goes in
  `raw/2026-09-23.1/divisions/division_boundary/` of the Overture cache's
  raw directory (or `GEV_RAW_DIR/overture/raw`), or is named with
  `--input`. The build never downloads it.
- **What is kept:** the 557 lines of the `country` subtype: 374 on land
  (47 of them disputed) and 183 maritime. The maritime lines are kept and
  drawn the same way: they carry borders on from the coast through
  straits, bays and territorial seas, where a land-only drawing would
  stop short (the United States and Canada's spans 130.7° W to 66.9° W,
  coast to coast). The release has no `dependency` subtype among its lines,
  so nothing more was needed there. No country line in this release fills
  `perspectives`. The build keeps the field per line anyway (the `classes`
  of each level header), so a later release's could be drawn. Every line
  names OpenStreetMap as its only source.
- **Coasts:** these are borders between countries, so coastlines are not
  drawn and an island country has no line, unlike LSIB's outlines. The
  basemap or imagery shows the coast.
- **Build:** `npm run overture:boundaries` (`--force`, `--input FILE`,
  `--dir DIR`; `scripts/overture/boundaries.mjs`). It reads the file once
  with the Parquet reader, on one thread. For each of four zoom bands
  (z 0–3, 4–6, 7–9 and 10–14) it simplifies to half a pixel, quantizes
  and cuts the lines into cells. The output is the rivers' level files
  (`server/providers/riversV2/levelFile.js`), with each piece's `order`
  holding its line's class. It writes to `build/boundaries/` of the
  Overture cache (`manifest.json`, `levels-<stamp>/`), never committed,
  and an unchanged input is skipped. Measured on 2026-10-22: 4.4 s, 3.0 MB
  (z 0–3: 6,251 points; z 10–14: 1,114,029). The divisions build now
  removes only its own build ids from `build/`, so it leaves
  `build/boundaries/` alone.
- **Server:** `server/providers/overtureBoundaries.js`, at
  `/api/boundaries/countries/layers` and
  `/api/boundaries/countries/tile/<ink>/<z>/<x>/<y>`. It draws through the
  rivers' line renderer in the layer's inks (`ffffffcc` light, `1a1a1acc`
  dark), with lines 1 px wide at z 0–3, 1.25 px at z 4–6 and 1.5 px from
  z 7. Disputed lines are dashed, 4 px on and 3 px off along each
  segment's longer axis in world pixels, so a dash is in the same place
  whichever tile draws it. Tiles are drawn in the shared tile pool and
  kept under `build/boundaries/tiles/<ink>/<version>/`. A sample of tiles
  drawn on one thread took 0.6 to 8.4 ms each, and the first in a process
  29 to 43 ms. LSIB's took Earth Engine 0.4 to 4.4 s.
- **Client:** the `level0` variant names `local: 'overture-boundaries'`
  (`src/layers/earthEngine/overtureBoundaries.js` asks for the status).
  COUNTRIES draws the local tiles in place of Earth Engine's, even when
  Earth Engine is not set up. AUTO draws them above 5,000 km
  (`localAutoAboveM`), as the Countries basemap switches to countries
  above 5,000 km. Below that AUTO is GAUL's regions and districts as
  before. Without the build, AUTO never draws countries, and COUNTRIES is
  LSIB 2017.
- **Earth Engine's LSIB layer is kept** as the fallback without a build.
  It costs nothing extra: it is the variant that was already there.
- **Credit:** `OVERTURE_BOUNDARIES_CREDIT` (`src/data/dataCredits.js`,
  beside the Overture buildings' credit): © OpenStreetMap contributors,
  Overture Maps Foundation, ODbL. It is registered while the lines draw.

GAUL's levels could follow later from `division_area`, region and county,
which is 4.5 GB, but GAUL is fine there.

**Not recommended.**

- Natural Earth for the countries layer: it is coarse below a few hundred
  km, though fine for the Countries basemap from orbit, where it already
  is.
- GAUL 2015's level0: non-commercial, and chunked into false borders.
- LSIB's newer v11.4 by our own import: public domain and current, but
  still US policy lines with the same shorelines, for the same import work
  as Overture's.

**GAUL's 500 m simplified level1 draws the far tiles (measured
2026-10-22).** Tiles of the regions at z 8 and coarser, which is AUTO
above 800 km (`drapeZoomForHeight`: z 8 at 800 km on a 1,600 px canvas,
z 3 for the whole globe) and REGIONS from far out, draw
`FAO/GAUL_SIMPLIFIED_500m/2025/level1` in place of `FAO/GAUL/2025/level1`.
They draw through a map of their own (`level1-coarse`,
`simplifiedVariant` in `server/providers/earthEngine.js`). Closer in, the
full table draws as before.

- _Not chunked._ 3,103 features for 3,103 GAUL1 codes, against the full
  table's 3,104 for 3,103 (level2: 43,819 for 43,819 in both); 54 MB
  against 202 MB.
- _Faster cold._ The same 16 tiles were fetched through the provider's
  own backend, at z 3, 4, 6 and 8 over Norway's fjords, Indonesia, the
  Canadian Arctic and central Africa. There were two runs, the second in
  the opposite order, each from a map Earth Engine had never drawn.

  | Zoom | Full, median (worst) | Simplified, median (worst) |
  | ---- | -------------------- | -------------------------- |
  | z 3  | 2.5 s (9.7 s)        | 1.2 s (2.0 s)              |
  | z 4  | 0.83 s (3.3 s)       | 0.47 s (0.80 s)            |
  | z 6  | 0.42 s               | 0.31 s                     |
  | z 8  | 0.26 s               | 0.29 s                     |

  The z 3 and z 4 tiles took 36 s in all from the full table against
  14 s. Earth Engine's warm repeats were noisy both ways (0.07 to 5.5 s),
  and the disk cache serves warm tiles anyway.

- _The same to the pixel, once points are left out._ The simplification
  collapses the smallest islands into points and slivers: simplified
  Western Australia holds 140 points and 1,989 line parts, the full one
  none and 3. `Collection.style` draws points as circles, so the coasts
  of Indonesia, Norway and the Aegean came out ringed (up to 2,000 extra
  line pixels a z 3 tile, 859 of them more than a pixel from any full
  line). With `pointSize: 0` the tiles match the full table's: under 3%
  of line pixels differ, and at most 5 a tile lie more than one pixel
  from the full table's lines. There are no straight seams; the straight
  lines in the Arctic tiles are Nunavut's and the provinces' own, in both
  tables.

### Forest types and Population

Two ANALYSIS layers added 2026-10-19. Each map is one pyramided image,
every tile measured came back in about a second, and both draw from orbit
(no `maxHeightM`).

**Forest types** (`ee-forest-types`) draws JRC's global map of forest types
2020 v1 (`JRC/GFC2020_subtypes/V1`, 10 m, `maxZoom` 14): naturally
regenerating forest, primary forest and planted forest (plantations
included), the EUDR's categories, cut from the extent of JRC's forest
cover map. `Image.remap` turns the codes 1, 10 and 20 into 1, 2 and 3 for a
three-colour palette; anything else is masked. The colours are Brewer's
Dark2 (`b8e186` natural, `1b9e77` primary, `d95f02` planted), not the
dataset's own: its dark green for primary forest (`006837`) all but
vanished on forest imagery and on black.

_Why it has no ceiling._ The asset's pyramid policy is **MODE** (its band
metadata, read with the API on 2026-10-19), so a coarser pixel is the
commonest type beneath it, a fair summary of a category. Its mask is
averaged, so a pixel is as opaque as the share of forest under it: sparse
forest fades rather than filling in. From orbit it reads as the dominant
type, with forest density as opacity (boreal primary forest, European
planted and naturally regenerating forest, tropical primary forest);
minority types inside a large forest appear only as the view comes in, as
with any mode. Forest loss differs: its `lossyear` pyramid is MODE too, but
"no loss" there is the value 0, not a mask, so loss, a rare class, loses
the vote to 0 from far away and vanishes. It keeps its 3,000 km ceiling.

_No FOREST COVER chip._ JRC's binary cover map (latest version
`JRC/GFC2020/V4`; V2 and V3 are deprecated) is just as cheap, but its
pyramid drew nearly all land as forest at z 0 to 2 (the steppe, the Sahel,
most of India), so it was dropped. The types map is cut from the cover
map's extent and already shows it.

Tile times (first fetch from Earth Engine, in seconds, 2026-10-19; z 0 is
a single tile, so later rows' z 0 may come from Earth Engine's cache):

| Forest types | z0  | z1  | z2  | z3  | z4  | z5  | z6  | z7  | z8  | z9  | z10 |
| ------------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Amazon       | 0.3 | 0.2 | 0.2 | 0.2 | 0.3 | 0.4 | 0.3 | 0.2 | 0.2 | 0.1 | 0.1 |
| Borneo       | 0.1 | 0.1 | 0.2 | 0.2 | 0.4 | 0.2 | 0.1 | 0.2 | 0.3 | 0.3 | 0.2 |
| Germany      | 0.3 | 0.2 | 3.8 | 0.5 | 0.3 | 0.2 | 0.3 | 0.6 | 0.3 | 0.2 | 0.2 |
| Baltimore    | 0.1 | 0.4 | 0.5 | 0.1 | 0.4 | 0.3 | 0.4 | 0.2 | 0.3 | 0.2 | 0.2 |

**Population** (`ee-population`) draws GHSL's residential population
(`JRC/GHSL/P2023A/GHS_POP`, `maxZoom` 12) as **people per km²**, on a
log ramp from 1 to 10,000 and more (YlOrRd, `fed976` to `bd0026`); fewer
than one person per km² is left clear. Chips pick the epoch: **2020** (the
default, the latest estimate; 2025 and 2030 are projections), 2000, 1990
or 1975, kept as `gev.population.mode`. Each epoch is its own map
(`density-<year>`), made only when a tile asks for it (`lazyMaps`). The
status line says "People per km² in <year> (GHSL)".

_Why a density, and why it is scale-invariant._ Each epoch is one image
of 100 m cells on the equal-area World Mollweide grid, 0.01 km² each, and
its pyramid policy is **MEAN** (checked 2026-10-19). A count would not
survive that: a coarser pixel holds the mean count of the cells beneath
it, not their sum. But the mean count × 100 is their mean density, the
same quantity at every level. So the expression is `log10` of
`population_count × 100`, masked below 1, and it draws from orbit with no
far variant. `populationDataset(epoch)` (`src/data/earthEngineLayers.js`)
returns the image id, band, cell size and that factor, ready for a later
"Wikipedia articles per capita" join.

| Population 2020 | z0  | z1  | z2  | z3  | z4  | z5  | z6  | z7  | z8  |
| --------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Delhi           | 0.1 | 0.4 | 0.2 | 0.2 | 0.2 | 1.2 | 0.4 | 0.4 | 0.3 |
| Lagos           | 0.3 | 0.1 | 0.1 | 0.2 | 0.2 | 0.2 | 0.3 | 0.2 | 0.4 |
| Germany         | 0.1 | 0.1 | 0.2 | 0.2 | 0.2 | 0.2 | 0.4 | 0.3 | 0.3 |
| Amazon          | 3.0 | 0.3 | 0.2 | 0.2 | 0.2 | 0.2 | 0.2 | 0.1 | 0.1 |

The other epochs matched (1975, 1990 and 2000: 0.1 to 0.6 s for z 0 to
6), except one 1975 z 0 tile that hit the 30 s timeout on its first
request and took 0.1 s on the next.

**Readability.** Tiles were composited at the default 70% opacity over
satellite imagery (Esri World Imagery, standing in for the photoreal
tiles), CARTO Positron and black. Forest types: all three colours read on
imagery and black; on Positron naturally regenerating forest is the
faintest. Population: cities read on all three; on imagery and black the
countryside's 1 to 100 per km² forms a broad yellow-orange wash (that is
where people live), and on Positron the lowest class is faint. The opacity
slider tones either one down.

### Elevation contours

**Elevation contours** (ANALYSIS, `ee-elevation-contours`) draws contour
lines of the terrain layers' elevation (the DEM stack, see
[Elevation: the DEM stack](#elevation-the-dem-stack)) in the boundaries'
inks: white
(`ffffffcc`) on imagery and dark maps, near-black (`1a1a1acc`) on light ones,
with AUTO / LIGHT / DARK ink chips. Every fifth line is an index contour,
drawn at the ink's full alpha; the others are at 55% of it.

**Why ANALYSIS, not REFERENCE.** It is an Earth Engine raster computed from
the DEM, like slope, aspect and hillshade, with their row (legend, opacity,
ink chips, tile count) and the same daily tile budget. The Grid in
REFERENCE is drawn by the client from arithmetic and costs nothing.

**Method** (`contourExpression`, `server/providers/earthEngine.js`). Earth
Engine draws each tile from:

1. the elevation: the DEM stack's band for the tile's zoom, each source
   read bilinearly on its own grid (FABDEM's 1″, 3DEP's 1/3″ in NAD83, each
   3DEP 1 m tile in its own UTM zone), its sea (0) masked, then the sources
   mosaicked as the Elevation layer mosaics them (`stackContourExpression`).
   Resampling comes before the mosaic: a mosaic's default projection is 1°,
   and resampled over 1° cells the lines came out as straight diagonal
   ramps (the first version, on Copernicus GLO-30);
2. the level, `floor(dem / step)`;
3. a line wherever the level differs from its `Image.focalMin` over the
   3 × 3 pixels about it: one pixel wide, on the upper side of each level,
   in the tile's own pixels;
4. an index line where `floor(level / 5)` differs the same way;
5. a constant image whose mask is the line's alpha (0.55 or 1), coloured in
   the ink; the ink's alpha is the map's opacity.

The level and its focal minimum are shared values in the request
(`valueReference`), each sent once, after the stack's own shared sources.

**Level of detail: the step follows the zoom.** Each band names the zooms it
draws (`zooms`, as the Rivers' bands do), so the server's `zoom` variant
draws every tile with its own zoom's step and source, on the globe and on
the photoreal tiles alike, from level 0 (no primitive needs more than
Cesium's 10 draped textures). On AUTO the camera's height names the band in
the row ("Contours every 100 m"): the heights at which the middle of a
1,600 px view drapes those zooms.

Each band of steps is cut where the DEM stack's band changes, so a tile
draws from exactly the sources the terrain layers draw at its zoom:

| Band         | Zooms | Step  | Index lines | Heights from (the stack's band)                                    | Height (1,600 px view) | Cold tile times (Rainier, Alps, Tromsø) |
| ------------ | ----- | ----- | ----------- | ------------------------------------------------------------------ | ---------------------- | --------------------------------------- |
| `c500-far`   | 0–5   | 500 m | 2,500 m     | GMTED2010 (`far`)                                                  | above 3,338 km         | 0.32–0.75 s (z 3, z 5)                  |
| `c500-base`  | 6–7   | 500 m | 2,500 m     | FABDEM (`base`)                                                    | 834–3,338 km           | 0.57–0.81 s                             |
| `c200-base`  | 8–9   | 200 m | 1,000 m     | FABDEM (`base`)                                                    | 209–834 km             | 0.33–0.71 s (z 9)                       |
| `c100-base`  | 10    | 100 m | 500 m       | FABDEM (`base`)                                                    | 104–209 km             | 0.58–0.71 s                             |
| `c100-polar` | 11    | 100 m | 500 m       | FABDEM (`polar`)                                                   | 52–104 km              | 0.29–1.27 s                             |
| `c40-polar`  | 12    | 40 m  | 200 m       | FABDEM (`polar`)                                                   | 26–52 km               | 0.43–0.67 s                             |
| `c20-fine`   | 13    | 20 m  | 100 m       | USGS 3DEP 10 m over the US, else FABDEM (`fine`)                   | 13–26 km               | 0.31–0.41 s                             |
| `c20-finest` | 14    | 20 m  | 100 m       | USGS 3DEP 1 m lidar where it is, else 10 m, else FABDEM (`finest`) | below 13 km            | 0.29–0.46 s                             |

ArcticDEM and REMA, whose heights are ellipsoidal (30 to 60 m off the
others'), are beneath every other source, as in Elevation: they draw only
where nothing else has heights (Greenland far out, north of 80° N,
Antarctica), so no line jumps at a source's edge.

The times are Earth Engine's first answer for each tile (measured
2026-10-19 through the server's own expression code, one tile each over
Mount Rainier, the Bernese Alps and Tromsø per zoom; each map took 0.3 to
1.6 s to make). The slowest, 1.27 s, is a twentieth of the proxy's 30 s.
Until 2026-10-19 the contours drew GMTED2010 to z 9 and the Copernicus
GLO-30 mosaic from z 10 (1.4 to 7.9 s a tile at z 10 to 12).

**Choosing the steps.** On a slope θ, lines `step` apart in height are
`step / tan θ` apart on the ground. On a 20° to 25° slope (tan θ about 0.4),
a step of about one pixel's ground size puts them 2 to 3 pixels apart:
306 m at z 9 → 200 m, 76 m at z 11 → 100 m, 38 m at z 12 → 40 m, 19 m at
z 13 → 20 m. The first trial (500 m to z 4, 200 m to z 7, 100 m at z 8–9,
40 m at z 10–11) filled the Alps almost solid at z 9 and z 11. These match
the usual map-scale practice too: z 9 is about 1:1,000,000 (200 to 500 m
intervals), z 13 about 1:70,000 (20 m). Steep mountains still crowd the
lines, as on any contour map; plains show few.

**Sources.** The bands name the DEM stack's bands (`stack`), so a change to
the stack (`src/data/demStack.js`) re-points the contours too, and the row
names the source under the view and credits the sources in it as the
terrain layers do (`demStack`). FABDEM, bare earth (Copernicus GLO-30 with
forests and buildings removed), gives contours of the ground, not of the
canopy and the roofs.

**From orbit: aggregate, then derive.** Earth Engine computes a coarse tile
from the elevation already averaged to that tile's scale (GMTED2010's mean
pyramid), and draws the contours of that. So a z 2 tile shows the true
coarse shape of the land at 500 m, not the 30 m lines thinned out. There is
no ceiling: the layer draws from orbit.

**Bilinear.** Read nearest-neighbour, 30 m cells drew staircase lines at
z 13 and 14 (19 and 10 m pixels). Read bilinearly, each on its own grid,
they are smooth, and the tiles are no slower.

**Maps.** One map per (band, ink), sixteen in all, made only when a tile asks
for one (`lazyMaps`, as the Rivers'), so the catalog request makes none.

**Labels.** Contour values are not labelled. Cesium labels are forbidden
(`src/noCesiumLabels.test.mjs`), and labels through the world-overlay host
would need elevations sampled along the lines on the client: not cheap.

### Rivers

**Rivers** (`ee-rivers`, ANALYSIS) draws the HydroRIVERS v1 network, 8,477,883
reaches from HydroSHEDS' 15″ hydrography (weaker above 60° N, where it comes
from coarser data), as Earth Engine publishes it with the connectivity
attributes of the free-flowing rivers study: `WWF/HydroSHEDS/v1/FreeFlowingRivers`.
In NETWORK mode, when the self-hosted HydroSHEDS v2 build is there, the
Americas come from v2 instead (below, and
[Rivers: HydroSHEDS v2 for the Americas](#rivers-hydrosheds-v2-for-the-americas)).
A click on the map traces the reach there to the sea
([Rivers: click a reach](#rivers-click-a-reach)). The names are Natural
Earth's, drawn by the client. Credit (in the Cesium credit line and the
data-attribution popover): HydroSHEDS/WWF, Lehner, Verdin and Jarvis 2008
(Eos 89:93, HydroSHEDS), Grill et al. 2019 (Nature 569:215, the
free-flowing rivers), Natural Earth, and, while v2 is drawn, "HydroSHEDS v2
(Lehner et al. 2022; WWF, DLR, Confluvio), CC BY 4.0" with
doi:10.1029/2022EO220167 (`HYDROSHEDS_V2_CREDIT` in `src/data/dataCredits.js`,
registered when v2 is first draped; the reach lookup's `RIVER_REACH_CREDIT`
when the clicks attach). The HydroSHEDS licence allows commercial and
noncommercial use with attribution; v2 is CC BY 4.0; Natural Earth is public
domain.

**Modes** (chips, kept as `gev.rivers.mode`):

- **NETWORK**: every reach in the ink, wider the larger its flow
  (`RIV_ORD`, the order of the long-term average discharge: 1 is over
  100,000 m³/s, the Amazon; each order a tenth of the one before), drawn
  exactly as HydroSHEDS v2's tiles are: the smallest order a band draws is
  0.75 px, each order larger adds 0.55 px, up to 4 px (`riverLineWidth`, one
  function for both); under a pixel a 1 px line at that share of the ink's
  alpha (v2's coverage raster does the same). The inks are v2's too:
  `ffffffcc` light, `1a1a1acc` dark (the boundaries' and the Grid's), one
  table (`RIVER_INKS`) that v2's `bands.js` imports.
- **FREE-FLOWING**: three colours by `CSI_FF2` (1 free-flowing, 2 good
  connectivity, 3 impacted): blue, yellow, vermillion.
- **PRESSURE**: six colours by `CSI_D`, the pressure that lowers the reach's
  connectivity most: dams (fragmentation, `DOF`) vermillion, flow regulation
  (`DOR`) blue, sediment trapping (`SED`) orange, water consumption (`USE`)
  purple, road density (`RDD`) green, urban areas (`URB`) yellow. The 5.3
  million reaches with none (`NAN`) are drawn a faint grey.

FREE-FLOWING and PRESSURE stay HydroRIVERS v1 everywhere, the Americas
included: their scores exist only for v1. Their colours are the Okabe–Ito
hues, which stay apart with the common colour vision deficiencies, each in
a light-ink version (lightened, for imagery and dark maps) and a dark-ink
one (darkened, for the white globe, Positron and the light styles), at least
3.9:1 against its background, at the same widths as NETWORK. **AUTO INK /
LIGHT INK / DARK INK** work as on the boundaries, in every mode, and the
legend's swatches follow the mode and the ink drawn. The names are in the
ink too (`#ffffff`, `#1a1a1a`).

**Why the first lines looked broken** (2026-10-19). The first version drew
NETWORK 1.8 to 3 px wide at z 3 (an absolute width by order, 3 px for order
1 down to 1 px) with alpha by order. Over the eastern United States and
northern South America (`o4`, z 3 `3/2/3`) that came out as thick blobs.
`Collection.style`, `Collection.draw` and `Image.paint` (1 px) drew the
same tile identically, and painting at four times the resolution and
taking each pixel's maximum changed nothing, so neither the drawing call
nor a coarse internal scale cuts the lines: HydroRIVERS' reaches are short
(a few km) and each is stroked on its own, so wide strokes overlap into
blobs at the joints, and an order threshold starts a river where its flow
crosses it (100 m³/s for `o4`), which reads as a gap. The widths now are
v2's (thin, relative to the band), and the same tile is continuous. Still,
Earth Engine composites overlapping strokes where v2 takes each pixel's
maximum, and v1 orders by discharge where v2 orders by upstream area, so
v1 is a little heavier: on the same z 8 tile over Virginia (`8/70/99`,
both orders ≤ 6) v1 drew 7,205 pixels at a mean alpha of 102 against v2's
5,656 at 92, the same rivers at the same widths; at z 3 (`3/2/3`, ≤ 3) v1
draws more of the Orinoco's and the Amazon's tributaries, which are a
discharge order bigger than their basin's area makes them. `Image.paint`
with per-reach widths and a coverage mask (v2's way of compositing) took
66.7 s for that z 3 tile and drew nothing, so it was dropped.

**How it is drawn.** Each reach gets a whole style (`{color, width}`) looked
up from constant tables in one mapped function (`Collection.map`, then
`Collection.style` with `styleProperty`): NETWORK one `List.get` by
`RIV_ORD`, FREE-FLOWING a list by `CSI_FF2` then by `RIV_ORD`, PRESSURE a
dictionary by `CSI_D` (with the faint style for anything else) then a list
by `RIV_ORD`. The tables are per band (the widths depend on the band's
largest order). Building a `Dictionary` per reach with `Number.format` keys
(the first version) made the slowest tiles about twice as slow (orders 1 to
6, pressure, z 5 over the Amazon: 18.3 s against 9.7 s). `RIV_ORD` (1 to 10)
and `CSI_FF2` (1 to 3) are on every reach (counted live), so they index
lists. Each (band, ink, mode) is its own map, 6 × 2 × 4 = 48 with the hidden
`network-rest` mode (below), and the catalog makes none of them
(`lazyMaps`): the first tile that needs one makes it. The tile route carries
the mode after the layer,
`/api/earth-engine/tile/ee-rivers/<mode>/<band>/<ink>/<z>/<x>/<y>?v=<hash>`,
and the disk cache keeps them under
`.gev-cache/earth-engine/tiles/ee-rivers/<mode>/<band>/<ink>/<hash>/`; `/layers`
gives each band's hashes per mode and ink (`modeVersions`), so a changed
expression is never served old tiles.

**HydroSHEDS v2 over the Americas** (NETWORK only). The layer asks
`/api/rivers/v2/layers` on enable and on each refresh
(`createRiversV2Source`, kept 5 minutes). While `riversV2Ready(status, ink)`
holds, it drapes two imagery layers at one opacity: Earth Engine's
`network-rest` maps (NETWORK without CON_ID 1 and 2) and, above them, v2's
tiles in the same ink (`riversV2ImageryOptions`: its own version per ink, so
a change of ink swaps the provider), limited to v2's extent and, below
1,667 km, to the view's square as well; a view whose square misses the
Americas drapes Earth Engine only. The row says "The Americas from
HydroSHEDS v2"; the NETWORK chip stays lit. When there is no build (503,
"Run npm run rivers:build"), the status cannot be read, or it has no tiles
in the ink, NETWORK is v1 everywhere and the row says nothing about it.
FREE-FLOWING and PRESSURE never omit the Americas. `network-rest` keeps v1
where v2 has no data (`AMERICAS_KEEP`, checked live on 2026-10-18):

- `COUNTRY = 'Greenland'`: 137,088 reaches, all CON_ID 1, none outside
  Greenland (the Canadian islands beside it are `Canada`: 55,993 against
  5,532 in a box over the Nares Strait); v2 stops at Newfoundland;
- a box west of 169.72° W: 734 CON_ID 1 reaches (`United States`: the
  Aleutians past Umnak, the Pribilofs, St. Lawrence Island), next to 7,818
  Russian ones (CON_ID 5, never omitted);
- a box north of 83.13° N: 28 Canadian reaches at Ellesmere's north tip.

Nothing else of CON_ID 1 or 2 lies outside v2's extent: none south of
55.96° S, and east of 32.41° W only Greenland's (27,827, all `Greenland`).
Easter Island and Hawaii have no v1 reach, so need nothing. The filter is
`not (CON_ID = 1 or 2) or COUNTRY = 'Greenland' or in one of the boxes`,
the CON_ID test first so a reach outside the Americas costs no geometry
test. Live tiles of `network-rest` against `network` (dark ink): a z 7 tile
over south-west Greenland (`7/46/34`) 61 KB both, the Aleutians at z 6
(`6/0/21`, `6/1/21`) 2 and 1 KB both, Ellesmere's north at z 5 (`5/9/1`)
10 KB against 3 KB (only the reaches past 83.13° N), New England at z 6
(`6/18/22`) 88 KB against 0 KB, South America at z 3 (`3/2/4`) 22 KB against
0 KB, Europe (`3/4/2`) 11 KB both.

**Level of detail: RIV_ORD bands by height** (level switching, like the
boundaries). On AUTO the camera height picks how many orders are drawn,
the largest rivers from orbit and more as the view comes in. Since
2026-10-19 the heights are where the imagery level Cesium drapes at the
middle of the view steps, and HydroSHEDS v2's zoom bands
(`server/providers/riversV2/bands.js` `BANDS`) draw the same orders at those
zooms, so the Americas' edge does not jump:

| Camera height   | Band  | Orders                  | Cesium zooms there | v2 band (zooms, orders) | Tiles from | First-level tile, live (s) |
| --------------- | ----- | ----------------------- | ------------------ | ----------------------- | ---------- | -------------------------- |
| 6,675 km and up | `o3`  | 1–3 (over 1,000 m³/s)   | z 0–4              | z 0–4, ≤ 3              | z 2        | 3.1–8.6                    |
| 1,666–6,675 km  | `o4`  | 1–4 (over 100 m³/s)     | z 5–6              | z 5–6, ≤ 4              | z 3        | 1.9–11.9                   |
| 834–1,666 km    | `o5`  | 1–5 (over 10 m³/s)      | z 7                | z 7, ≤ 5                | z 4        | 2.5–12.9                   |
| 417–834 km      | `o6`  | 1–6 (over 1 m³/s)       | z 8                | z 8, ≤ 6                | z 5        | 1.7–14.2                   |
| 104–417 km      | `o7`  | 1–7 (over 0.1 m³/s)     | z 9–10             | z 9–10, ≤ 7             | z 6        | 1.6–8.2                    |
| below 104 km    | `all` | every order (8,477,883) | z 11 and up        | z 11–14, all (8)        | z 7        | 0.9–3.0                    |

(Earlier the steps were at 6,000, 1,600, 700, 250 and 80 km; v2's bands
were z 0–2 ≤ 3, z 3–4 ≤ 4, z 5–6 ≤ 5, z 7–8 ≤ 6, z 9–10 ≤ 7, so v2 drew an
order more than v1 at most heights.)

**Which zoom Cesium drapes** (`riverZoomForHeight`, from Cesium 1.138's
code): the globe refines a terrain tile of level L (geometric error
77,067 m / 2^L for a 65-sample heightmap over two level-0 tiles) until its
screen-space error, error × drawing-buffer height / (distance ×
sseDenominator) / pixel ratio, is at most 2 px; sseDenominator is
2·tan(30°)/aspect for the 60° frustum, so the bound is error ≤ 2.309 ×
distance / canvas width (CSS px). The tile then takes the imagery level
round(L + log2(2.03 × cos latitude)) (`ImageryLayer`'s
`getLevelWithMaximumTexelSpacing`), L + 1 from the equator to about 50°.
For a 1,600 px wide canvas looking down that is z = ceil(log2(5.34e7 /
height)) + 1, which steps at 5.34e7 / 2^n m: 6,675, 3,338, 1,669, 834, 417,
209 and 104 km. The `o4`/`o5` step is at 1,666 km rather than 1,669 so that
`o5`'s view square is never the whole world. The step moves with the
canvas (Cesium's error bound is per CSS pixel of the larger side), so the
layer picks its band from `riverHeightForCanvas`: the height a 1,600 px
canvas would need for the zoom this canvas drapes (a 720 px pane at
4,500 km is a 1,600 px canvas at 10,000 km, orders 1 to 3, Cesium's z 4).
The clicks' `maxOrder` uses the same height.

**The tiles come by zoom** (since 2026-10-19). The band by height names the
orders in the row and the clicks, but the tiles are drawn through the
server's `zoom` variant (`/tile/ee-rivers/<mode>/zoom/<ink>/<z>/<x>/<y>`):
each tile by the band of its own zoom (`variantForZoom`: z 0–4 `o3`, z 5–6
`o4`, z 7 `o5`, z 8 `o6`, z 9–10 `o7`, z 11 on `all`), exactly as v2's tiles
are, so the two agree tile by tile on any canvas, towards the horizon and on
a 3D tileset. Every zoom of it is quick (each band only at its own zooms),
so it is asked for at `minimumLevel` 0 everywhere; its version hashes every
band's. The bands keep their `minZoom` for a client that asks for a band by
name (on a globe), and the server answers a band's tile coarser than its
first level with the band of that zoom (`coarseVariant`) rather than a
transparent one. HydroSHEDS v2's provider takes the Earth Engine side's
levels (0 to 11), so neither is sharper or blurrier than the other.
`maxZoom` is 11 (HydroSHEDS' 15″ is about 460 m). The bands' first levels
finish in at most 14.2 s against the proxy's 30 s, most under 9 s; the
slowest are always over the Amazon.

**Rivers on the photoreal tiles.** On the default photoreal map at 4,500 km
over North America (720 × 507 pane) only a hard-edged patch of rivers drew,
blurred, with the Columbia, the upper Missouri, the Saskatchewan and the St.
Lawrence missing. The cause is how Cesium 1.138 drapes imagery on a 3D
tileset (`ModelPrimitiveImagery`): each loaded primitive gets about one
imagery tile at the level whose tile spans it, clamped up to the provider's
`minimumLevel`, and `ImageryPipelineStage` keeps at most 10 draped textures
per primitive, dropping the rest ("Draped imagery requires 16 texture units,
truncating"). At orbit the photoreal primitives are continent-sized, so the
`o4` band's `minimumLevel` 3 made one need 16 to 33 z 3 tiles (all 64
requested, all 200); the first 10 were drawn, and HydroSHEDS v2's layer,
second in the list, got none of the slots left. v2 itself had no minimum,
so it drew one z 0 or z 2 tile stretched over each primitive: thick and
blurry. Now the Rivers ask for every level through the `zoom` variant at
`minimumLevel` 0, so each primitive takes one to four tiles per layer at
Cesium's own level and both layers fit. The other Earth Engine layers have
no `minZoom` (their minimum was always 0), so they never needed more than
Cesium's one-to-four tiles a primitive; several draped layers at once still
share the 10 slots. On a tileset the level follows the primitive, not the
screen, so at orbit the lines stay softer than on a globe (a z 2 tile over a
90° primitive) whatever the layer; a globe map is the sharper view from far
out.

Checked in headless Chrome (SwiftShader) with real Cesium 1.138, the
layer's own modules and the real server routes against the main checkout's
caches and live Earth Engine (`scratchpad/harness/run.mjs`, not committed).
Google's tiles refuse the harness's origin (the browser key is restricted to
the app's referrers, and so is the ion token), so the photoreal stack is a
stand-in: a 3D tileset of ellipsoid patches, either 16 cells of 90° × 45°
(continent-sized, as the photoreal primitives at orbit are) or a seven-level
quadtree, draped through the same `ModelPrimitiveImagery` code. Requests at
lat 40, lon −100 (and 38.6, −90.2 at 600 km), pitch −90, 720 × 507,
NETWORK with v2:

| View                | Before (`local-fixes`)                                 | After                                                |
| ------------------- | ------------------------------------------------------ | ---------------------------------------------------- |
| 90° cells, 4,500 km | EE 64 (z 3, 7 of 15 primitives over 10 textures), v2 5 | EE 9 (z 0, z 2), v2 5 (z 0, z 2); none over 10       |
| quadtree, 4,500 km  | EE 64 (z 3, 1 primitive over 10), v2 15                | EE 25 (z 0, 2, 3), v2 15 (z 0, 2, 3), the same tiles |
| quadtree, 600 km    | EE 10 (z 5), v2 11 (z 0, 2, 3, 5)                      | EE 11, v2 11, the same tiles                         |
| globe, 4,500 km     | EE 84 (z 3 64, z 4 20), v2 48                          | EE 58 (z 1 to 4), v2 48 (z 1 to 4)                   |
| globe, 600 km       | EE 42 (z 5 to 7), v2 41 (z 1 to 7)                     | EE 41, v2 41, the same tiles                         |

The administrative boundaries on the 90° cells: 9 tiles (z 0 and z 2), no
primitive over 10 textures; on the globe 58.

**Timings** (2026-10-18, sequential, nothing else running against the
project; tiles fetched straight from Earth Engine with the server's
credentials). Plain outlines (`Collection.style`, one colour and width),
each row a fresh map:

| Filter      | z 0  | z 1       | z 2       | z 3       | z 4      | z 5     | z 6     | z 7     |
| ----------- | ---- | --------- | --------- | --------- | -------- | ------- | ------- | ------- |
| RIV_ORD ≤ 3 | 11.9 | 6.9–8.7   | 3.2–4.4   | 1.6–3.7   | 0.8–2.2  | 0.5–2.3 |         |         |
| RIV_ORD ≤ 4 | 11.4 | 8.2–13.5  | 5.7–7.2   | 2.1–7.4   | 1.3–6.0  | 0.7–2.3 |         |         |
| RIV_ORD ≤ 5 | 26.8 | 12.0–15.2 | 20.4–26.8 | 2.7–6.0   | 3.4–4.5  | 0.7–2.4 |         |         |
| RIV_ORD ≤ 6 |      |           | 24.2      | 7.8–13.0  | 2.9–7.3  | 0.9–6.1 | 0.5–1.7 |         |
| RIV_ORD ≤ 7 |      |           | 31.5      | 8.0–36.5  | 4.2–12.4 | 2.1–6.4 | 1.0–3.0 |         |
| all orders  | > 90 | 69–87     | 34–71     | 12.3–31.2 | 5.3–7.6  | 1.5–6.5 | 1.1–5.4 | 0.9–2.3 |

The all-orders z 0 to 3 row is from a first run that overlapped other
Earth Engine work (z 3 and deeper re-measured alone). The layer's own
requests, per-reach styles, each band at its first two levels (s; light
ink):

| Band  | Mode         | First level   | Next level   |
| ----- | ------------ | ------------- | ------------ |
| `o3`  | network      | z 2: 4.6–8.6  | z 3: 1.6–4.5 |
| `o3`  | free-flowing | z 2: 4.6–7.0  | z 3: 1.4–4.7 |
| `o3`  | pressure     | z 2: 4.7–6.6  | z 3: 1.3–5.1 |
| `o4`  | network      | z 3: 2.5–11.7 | z 4: 2.0–8.8 |
| `o4`  | free-flowing | z 3: 3.6–11.2 | z 4: 1.5–5.9 |
| `o4`  | pressure     | z 3: 2.6–8.9  | z 4: 1.5–5.7 |
| `o5`  | network      | z 4: 2.5–8.2  | z 5: 2.5–4.2 |
| `o5`  | pressure     | z 4: 3.8–12.9 | z 5: 5.9     |
| `o6`  | network      | z 5: 1.7–9.0  | z 6: 1.6–6.3 |
| `o6`  | pressure     | z 5: 1.8–14.2 | z 6: 1.1–5.1 |
| `o7`  | network      | z 6: 1.6–6.7  | z 7: 2.4–2.7 |
| `o7`  | pressure     | z 6: 1.6–8.2  | z 7: 1.6–3.4 |
| `all` | network      | z 7: 1.5–3.0  | z 8: 1.3–1.6 |
| `all` | pressure     | z 7: 0.9–2.8  | z 8: 1.0–1.2 |

Tiles timed: Europe, the Amazon, South and East Asia, Siberia and eastern
North America at each level (for example z 3 `3/4/2`, `3/2/4`, `3/5/3`,
`3/6/2`, `3/1/2`). Earth Engine's timings vary by up to two times between
runs.

Re-timed on 2026-10-19 with v2's widths and inks (dark ink, s):

| Band, mode        | Tiles                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- |
| `o3` network      | z 2: `2/0/1` 3.1, `2/1/0` 0.3, `2/1/1` 4.3, `2/2/1` 5.9, `2/1/2` 4.7, `2/3/1` 6.3   |
| `o3` network-rest | z 2: `2/0/1` 3.4, `2/1/0` 0.5, `2/1/1` 7.4, `2/2/1` 15.0, `2/1/2` 5.1, `2/3/1` 4.1  |
| `o4` network      | z 3: `3/0/2` 1.9, `3/2/2` 2.4, `3/2/3` 11.5, `3/2/4` 11.9, `3/4/2` 4.0, `3/1/2` 2.9 |
| `o4` network-rest | z 3: `3/0/2` 1.1, `3/2/2` 2.3, `3/2/3` 5.2, `3/2/4` 3.8, `3/4/2` 3.5, `3/1/2` 4.4   |
| `o4` free-flowing | z 3: `3/2/4` 21.8, `3/4/2` 5.5                                                      |
| `o4` pressure     | z 3: `3/2/4` 9.6, `3/4/2` 5.0                                                       |

The Americas filter costs little: the Americas tiles of `network-rest` are
empty (Greenland and the boxes aside) and mostly faster. `o4`
free-flowing over the Amazon (21.8 s) is the slowest tile measured in this
layer; the same request took 11.2 s the day before.

**Far fallbacks considered.** The coarse tiles are slow because Earth Engine
reads every reach under them; three faster sources were tried:

- **The FeatureView** `WWF/HydroSHEDS/v1/FreeFlowingRivers_FeatureView`.
  `maps.create` cannot draw it (a FeatureView is not an expression), but
  the REST API has its own route: `POST /v1/projects/<project>/featureView`
  with `{asset: 'projects/earthengine-public/assets/WWF/HydroSHEDS/v1/FreeFlowingRivers_FeatureView',
visualizationExpression}` answers `projects/*/featureViews/<id>`, and its
  tiles are at `/v1/<name>/tiles/<z>/<x>/<y>`, the same path shape the
  server's `fetchTile` uses. It works with the server's
  `earthengine` scope, takes `color`, `lineWidth` and `rules` (filters, with
  `isVisible`), and answered every z 0 to 7 tile in 0.2 to 0.7 s. But it is
  thinned when it was ingested: up to z 3 even the largest rivers come out
  in dashes, and at z 5 over Germany only the Rhine shows. Not used; it
  would serve a far band only if a FeatureView with a `RIV_ORD` thinning
  ranking were made, which needs an asset of our own.
- **HydroSHEDS flow accumulation** (`WWF/HydroSHEDS/15ACC` and `30ACC`,
  one pyramided image each), thresholded: 0.1 to 0.5 s a tile at any
  level, and the pyramid makes a scale-dependent network by itself. But it
  stops at 60° N (no Ob, Yenisei, Lena, Mackenzie or Yukon lower courses),
  and it can only draw NETWORK. MERIT Hydro's upstream area pyramids by
  sampling and comes out as dots.
- **Natural Earth's lines**, drawn by the client: fast and global but
  without the connectivity attributes. Not drawn (only the names are used).

The bands' `minZoom` (above) is what made the far view fast enough
instead.

**The Americas switch.** `omitAmericas` in the record (off) leaves out
`CON_ID` 1 and 2 in every mode, with no exceptions; it is a manual
override. The wiring above uses the `network-rest` mode instead, which
keeps `AMERICAS_KEEP` and only applies while v2 is drawn. The
check, live on 2026-10-18: every reach has a `CON_ID` (none missing, none
0: 1 = 1,270,524, 2 = 1,790,250, 3 = 938,544, 4 = 1,527,551, 5 = 2,114,542,
6 = 836,472). Greenland is 1 (124,446 reaches), as are the Canadian Arctic
islands; the Caribbean (Cuba, Hispaniola, Jamaica, Puerto Rico, the
Bahamas, the Lesser Antilles, Trinidad), Central America from Guatemala to
Panama and most of Mexico are 2 (northern Baja is partly 1); Iceland and
Svalbard are 3; Hawaii has no reaches; Alaska's Near Islands west of 180°
and Chukotka are 5. So 1 and 2 are exactly the Americas with Greenland and
the Caribbean. `CON_ID` is stored as a double: `Filter.inList` with
`[1, 2]` matched no reach, so the switch is `not (CON_ID = 1 or CON_ID = 2)`
with `Filter.eq` (live: the z 3 South America tile comes back empty, Europe
unchanged). It changes the request, so the hash, so the tiles.

**Names** (`src/layers/earthEngine/riverNames.js`). Natural Earth 10m
rivers and lake centerlines (public domain), downloaded from
naciscdn.org and trimmed by `scripts/build-river-names-pack.mjs` into
`src/data/local_data/natural_earth/river_names.json` (88 KB: 1,097 names,
1,202 label points, English with Spanish and Russian where Natural Earth
has them; the folder's README has the provenance). Loaded on first use.
They are world-overlay labels (`ee-rivers-names`, never Cesium labels),
in the rivers' blue for the ink, larger rivers winning the collisions,
thinned by Natural Earth's `scalerank` with the camera height:

| Camera height   | Names up to scalerank |
| --------------- | --------------------- |
| 8,000 km and up | 2 (24 to 55 at orbit) |
| 4,000 km        | 4                     |
| 2,000 km        | 5                     |
| 1,000 km        | 7                     |
| 400 km          | 9                     |
| 150 km          | 12 (all)              |
| below 150 km    | none                  |

Below 150 km the label points (from 1:10m lines) are too coarse for the
reaches Earth Engine draws. Only the points in the view window (the H3 window rule; from
far out, the side of the Earth the camera sees) are published, larger
rivers first, then nearer the middle of the view, at most 160.

**Checklist** ([Level of detail](#level-of-detail)):

- [x] The record says how its detail follows the camera: level switching
      by `RIV_ORD` band, lines one to three pixels at every zoom; names
      thinned by scalerank.
- [x] It draws from orbit (orders 1 to 3).
- [x] Its coarsest tiles were timed live (above); each band starts at a
      level that answers in seconds, and the coarser ones are transparent.
- [x] Not a boundary table (each reach is one feature).

Tests: `src/layers/earthEngine/rivers.test.mjs` (the bands by height, the
zoom each height gets and v2's orders at it, the widths and inks shared
with v2, the mode expressions, the Americas flag and `network-rest`'s
exemptions, the v2 and v1 choice and its quiet fallback, the clicks' attach
and detach and their `maxOrder` by height, the names' thinning and labels,
the pack, the chips and `gev.rivers.mode`) and the Rivers tests in
`src/data/earthEngine.test.mjs` (lazy maps, the mode route, the transparent
tile, the cache path per mode).

### Surface water

**Surface water** (`ee-surface-water`, ANALYSIS) draws JRC's Global Surface
Water 1.4: where water was seen in 38 years of Landsat (1984–2021, 30 m).
Three chips pick the band, kept as `gev.surfaceWater.mode`:

- **OCCURRENCE** (the default): how often water was there, 1% (pale) to
  100% (deep blue).
- **CHANGE**: `change_abs`, the change in occurrence from 1984–1999 to
  2000–2021, red where water was lost and blue where it was gained (−50 to
  +50 points; beyond is the end colour). No change (0) is transparent.
- **SEASONALITY**: months a year with water, 1 (pale) to 12 (deep blue).

Land is transparent: the dataset masks pixels where water was never seen,
and zero is masked here (`selfMask`, or `≠ 0` for the signed CHANGE).

**Level of detail: masked by the water's own extent.** Every mode is also
masked by the dataset's `max_extent` band (1 wherever water was ever seen).
Without it, the far view was wrong: Earth Engine's coarse pyramid of a
band averages only its unmasked pixels and keeps the coarse pixel wherever
any of them is, so at z 3 Europe drew as one blue sheet, every land pixel
holding some pond. `max_extent` is pyramided by MODE (read from the asset),
so a coarse pixel is water only where most of it is: from orbit the layer
shows the large lakes, the big rivers and the coasts, and more water as the
view comes in. At the data's own 30 m the mask is the water itself. The
other bands are pyramided by MEAN, which suits them (a lake's coarse pixel
is its mean occurrence). So it draws from orbit with no ceiling and no far
variant.

Timed live on 2026-10-19 (map made in 0.5 to 0.8 s; tiles over Europe,
Africa and Asia, then Finland's lakes):

| Mode        | z 0    | z 1 (4 tiles) | z 2 (3)     | z 3 (4)     | z 6, 9, 12  |
| ----------- | ------ | ------------- | ----------- | ----------- | ----------- |
| OCCURRENCE  | 0.19 s | 0.20–0.39 s   | 0.11–0.17 s | 0.16–0.22 s | 0.11–0.26 s |
| CHANGE      | 0.24 s | 0.11–0.23 s   | 0.12–0.19 s | 0.11–0.27 s | 0.12–0.42 s |
| SEASONALITY | 0.13 s | 0.17–0.30 s   | 0.10–0.22 s | 0.11–0.36 s | 0.12–0.32 s |

`maxZoom` is 13 (30 m pixels are about 19 m at z 13 at the equator).

### Land cover

**Land cover** (`ee-land-cover`, ANALYSIS) draws ESA WorldCover's 11
classes at 10 m in the dataset's own colours (the STAC record's
`gee:classes`): tree cover, shrubland, grassland, cropland, built-up, bare
or sparse vegetation, snow and ice, permanent water, herbaceous wetland,
mangroves, moss and lichen. The class codes (10 to 100, with 95) are
remapped to 0–10 so one palette draws them. Two chips pick the year, kept
as `gev.landCover.mode`: **2021** (v200, the default) and **2020** (v100),
for comparison; ESA changed the method between them, so not every
difference is a change on the ground, and the chip's title says so. Each
year is one global image (`ESA/WorldCover/v200/2021`, `…/v100/2020`), loaded
directly rather than as a mosaic.

**Level of detail: categorical, pyramided by MODE, with a high ceiling.**
The `Map` band is pyramided by MODE (read from the asset on 2026-10-19), so
a coarse pixel is the class most of it holds: every level shows real
classes, as a small-scale land cover map would (minority classes, such as
small towns, fall out from far away). That is unlike forest loss, whose
coarse pixels are years of loss averaged into years that never were. Every
level drew in under a second (below), so time sets no limit either. The
ceiling, `maxHeightM` 10,000 km (`LAND_COVER_MAX_HEIGHT_M`), is for the one
level that misleads: the z 0 world tile, which a view of the whole disc
drapes on the photoreal tiles, draws the Arctic as blocky stripes and every
coast as a thick band of water. From z 1 the map reads well. Above the
ceiling the row says to zoom in below 10,000 km.

Timed live on 2026-10-19 (2021 map made in 0.6 s; tiles over Germany, the
Amazon and the Great Plains; 2020 sampled at z 0, 1, 3, 6, 10):

| Level | 2021 (v200) | 2020 (v100)  |
| ----- | ----------- | ------------ |
| z 0   | 0.13 s      | 0.16 s       |
| z 1   | 0.10–0.34 s | 0.22 s       |
| z 2   | 0.14–0.40 s |              |
| z 3   | 0.19–0.99 s | 0.18 s       |
| z 4–8 | 0.14–0.95 s | 0.22 s (z 6) |
| z 10  | 0.13–0.25 s | 0.23 s       |

`maxZoom` is 14 (10 m pixels are about 10 m at z 14 at the equator).

Both layers are colour rasters, so they have no inks; their colours were
chosen to read on the photoreal tiles, Positron and the black globe alike
(not yet checked live). Tests: `src/data/earthEngine.test.mjs` (each mode's
expression, mask and colours, the class remap and palette, the ceiling, a
mode with digits on the tile route, the fixture) and
`src/layers/earthEngine/earthEngine.test.mjs` (the chips, the stored mode,
the legends, the ceiling's status line).

### Buildings

**Buildings** (`ee-buildings`, ANALYSIS) draws Google's Open Buildings 2.5D
Temporal v1 for 2023: one image per S2 cell and year (2016 to 2023), on a
0.5 m grid of 4 m effective resolution, with three bands, all pyramided by
MEAN (read from the assets on 2026-10-19). It covers Africa, South and
Southeast Asia, Latin America and the Caribbean: 46 S2 cells, 151 images in 2023. There is no data for the United States, Europe, China, Japan or
Australia. There, the row says **"No Open Buildings data here"** rather than
drawing nothing: the point under the view is tested against the 46 cells'
boxes (`src/data/openBuildingsCoverage.js`). The boxes are coarse, so inside
one there may still be no data, but outside them there surely is none.

Three chips, kept as `gev.buildings.mode`:

- **COUNT** (the default): buildings per km², on a log scale from 1 to
  10,000+. The fractional count per 0.25 m² pixel × 4,000,000; with a MEAN
  pyramid that is the same density at every zoom (a 1 km box in Lagos:
  about 2,400 per km²). It reads well from orbit.
- **COVER**: the share of the ground built on (building_presence), 2% to
  50%+ (35% in that Lagos box). From orbit only cities show: a z 3 pixel
  (20 km) is under 2% built almost everywhere else.
- **HEIGHT**: metres, building_height ÷ building_presence. Both are MEAN
  pyramids, so at every zoom a pixel is Σ height / Σ presence over it:
  roughly the mean height of what is built. Height is predicted off
  buildings too: 11 to 22% of the pixels with presence under 0.1 had some,
  in 1 km boxes. So this reads 28 to 50% above the mean height of the
  pixels with presence over 0.5: Lagos 10.1 m against 7.9 m, Jakarta 24.9 m
  against 16.6 m, São Paulo 31.8 m against 23.7 m. The plain mean over the
  ground (3.5, 5.8 and 10.5 m) would be half the buildings' height. Pixels
  under 5% built are clear.

**Footprints from z 15.** The layer's two bands go through the server's
`zoom` variant, as the Rivers' do:

- **Raster** (z 0–14): the mode alone.
- **Footprints** (z 15–17): the mode, visualized (`Image.visualize`), with
  Open Buildings v3's polygons blended over it as 1 px outlines in the ink
  (`Image.blend`; `overlayExpression` in `server/providers/earthEngine.js`).
  Only polygons with a confidence of at least 0.7 are drawn; the dataset
  suggests 0.65 to 0.75.

The row then says "With building footprints (Open Buildings v3)", and the
ink chips (AUTO / LIGHT / DARK) choose the outlines' colour. The v3 table
is huge (some 1.8 billion buildings), and its tiles cost seconds whatever
the zoom. z 15 is where a 4.8 m pixel shows a house's shape. Maps are made
when a tile asks for them (`lazyMaps`: 2 bands × 3 modes × 2 inks).

Timed live on 2026-10-19, first answers, over Lagos, Jakarta and São Paulo
(maps made in 0.3 to 1.9 s):

| Tiles                          | z 0–4       | z 5–9       | z 10–14                                                                | z 15–17                  |
| ------------------------------ | ----------- | ----------- | ---------------------------------------------------------------------- | ------------------------ |
| COVER                          | 0.30–1.75 s | 0.20–1.13 s | 0.18–1.52 s                                                            | raster alone 0.21–0.50 s |
| COUNT                          | 0.45–0.74 s | 0.21–1.57 s | 0.14–0.78 s                                                            |                          |
| HEIGHT                         | 0.27–0.64 s | 0.16–2.11 s | 0.28–0.51 s                                                            | raster alone 0.31–0.45 s |
| Footprints alone (v3, ≥ 0.7)   |             |             | z 11: 7.2 s and over 30 s (Jakarta); z 13: 4.9–10.9 s; z 14: 3.0–4.3 s | 3.0–7.6 s                |
| Footprints over COVER (drawn)  |             |             |                                                                        | 3.5–7.1 s                |
| Footprints over HEIGHT (drawn) |             |             |                                                                        | 2.8–8.6 s                |

The slowest tile drawn, 8.6 s, is under a third of the proxy's 30 s.
`maxZoom` is 17. Outside the coverage the raster's tiles are empty
(Baltimore: 334 B a tile).

#### Overture buildings outside Open Buildings

Where Open Buildings has no data, the layer drapes **Overture Maps'
buildings** (release 2026-09-23.1, the `buildings` theme: OpenStreetMap,
Microsoft's ML footprints, Esri Community Maps, Google Open Buildings,
USGS 3DEP heights and more, ODbL) beside Earth Engine's tiles, from a
local build: `npm run overture:build -- --buildings`. The row then says
**"Overture buildings (OSM, Microsoft, Esri…)"** in place of "No Open
Buildings data here", and the credit adds Overture's
(`OVERTURE_BUILDINGS_CREDIT`). The build leaves out every building Open
Buildings draws, so the two never draw the same place. Without the build
the row says what it said before. With Earth Engine not set up,
Overture's buildings still draw.

_Where Open Buildings draws._ Its 46 boxes are coarse S2 cells, and five
take in land Google has no data for: the US Southwest and South Florida
(San Diego, Tucson, El Paso, San Antonio, Miami), southern Spain, Sicily,
Malta and southern Greece. Leaving out everything in the boxes left those
cities blank, so a building inside a box is still Overture's when its
country is the US, Spain, Portugal, Italy, Malta, Greece or Gibraltar
(`scripts/overture/openBuildingsGaps.mjs`). The country comes from Natural
Earth's admin-0 outlines (the bundled pack), rasterized once over the
boxes at 0.01° (about 1 km); the outlines are simplified, so the gap
countries reach 8 cells (about 8 km) further into cells no other country
claims (the sea, a border sliver). Checked: San Diego, Tucson, El Paso,
San Antonio, Laredo, McAllen, Miami, Miami Beach, Málaga, Gibraltar,
Palermo, Catania, Valletta and Kalamata draw Overture's; Tijuana, Ciudad
Juárez, Nuevo Laredo, Reynosa, Matamoros, Monterrey, Havana, Nassau,
Tangier, Ceuta and Tunis draw Open Buildings'. Known misses, where the
simplified outlines leave the place out or another country's takes it:
the Florida Keys (islands under 20 km² are dropped from the pack),
Brownsville TX, and small islands such as Lampedusa. Along the US–Mexico
border the 1 km cells show as a stair-step edge between the sources.
Rule 2 (`BUILDINGS_RULES`) is this; a region built under rule 1 (the US's
first build) gets a gaps pass that adds only those buildings.

The same three modes in the same ramps and legends, so the two sources
read alike: COUNT per km² (log, 1 to 10,000+, under 1 clear), COVER (2%
to 50%+), HEIGHT (3 to 30+ m, where at least 5% is built and the height
of at least a quarter of what is built is known). A building's height is
Overture's `height`, else 3 m a floor (`num_floors`), else unknown.
Footprint outlines in the ink from z 15, as Open Buildings' v3 polygons.

_The build._ The theme is 512 GeoParquet files, 277 GB, 2.53 billion
buildings. The step reads only what it needs:

1. **Plan.** Each file's footer is fetched once and kept
   (`raw/2026-09-23.1/buildings/footers/`, 419 MB for the 512 files, 76 s).
   A row group is planned when its bounding box (the `bbox` columns'
   statistics) meets a region asked for and is not wholly inside one Open
   Buildings box, and only six columns are fetched (`geometry`, `height`,
   `num_floors`, `subtype`, `class`, `sources.dataset`; the geometry is
   97% of the bytes). The plan is checked against a 25 GB cap
   (`--cap-gb` raises it).
2. **Parts.** Each row group is fetched by HTTP range, decoded by the
   dependency-free Parquet reader (`scripts/overture/parquet.mjs`) in
   worker threads, and written as a part: its buildings quantized to a
   web-mercator grid of 2^28 units (0.15 m at the equator), grouped by the
   z 14 tile of their centre. A building is kept when its centre is in the
   region, in no region built before it, and outside every Open Buildings
   box. The raw bytes are dropped once decoded (`--keep-raw` keeps them).
   A part on disk is done, so a stopped build repeats nothing finished.
3. **Merge.** Each z 6 bucket that new parts reach is written again from
   its earlier file and the parts, three at a time, one z 10 tile at a
   time: the footprints per z 14 tile (varint deltas, zstd), and the
   density sums (buildings, built m², Σ height × m², m² with a known
   height) at the cells of each z 10 tile (153 m at the equator) and of
   the bucket's own z 6 tile. Then a new manifest, `buildings/current.json`
   pointing at it, and the parts and replaced files go
   (`server/providers/overture/buildingsFile.js`).

Regions add up: `--building-regions europe` later keeps the US and adds
Europe, and its row groups skip any building the US already took.

_Level of detail._ The tiles (`server/providers/overture/buildingsTiles.js`)
are sums divided by ground, so each mode is the same quantity at every
zoom: z 0–6 from the buckets' cells, z 7–10 from the z 10 tiles' cells,
z 11 and closer from the footprints themselves, binned into cells no finer
than a z 11 pixel (76 m at the equator, 58 m at Baltimore; at z 15 a cell is
16 pixels), with the outlines over them from z 15. Tiles are kept on disk
under the build's version (`buildings/tiles/<version>/`; the ink only in
footprint tiles' paths), and the browser keeps one a day under its `?v=`.

_The z 11 tiles' cells (D19)._ z 11–14 tiles need sums at a z 11 pixel.
Without them, a z 11 tile decoded the footprints of the 64 z 14 tiles
under it. Each bucket now also holds, for every z 11 tile with a
building, that tile's 256 × 256 cells. These are the same sums the
footprints give, and the tiles drawn from them are byte-identical. A z 11
to 14 tile reads one block, and z 15 and closer still read the footprints
for their outlines.

- The manifest marks a bucket that has them (`d19`); an older bucket is
  drawn from its footprints as before.
- A build written before them gets them without Overture. It writes each
  bucket again from its own footprints, one worker at a time (the densest
  bucket holds 1.4 GB while it is written), then publishes a new manifest:

  ```bash
  node scripts/overture/index.mjs levels --workers 1
  ```

_Serving._ The dev server draws the tiles in worker threads (up to four,
`server/providers/overture/buildingsTilePool.js`), so a tile being drawn
never holds the server's other routes, and a tile asked twice while
drawing is drawn once. Drawn on the server's own thread, a view loading
held everything: a San Diego z 12 tile that draws in 75 ms answered in 24
to 30 s on the live server (2026-10-19, with the test suite running), and
`/api/overture/layers` waited 650 ms behind a 24-tile burst (12 ms now).
Two costs went with it. A bucket's index (tens of thousands of blocks in a
dense one) is searched in a natively sorted typed array instead of being
built into a Map on every open: opening all 191 buckets, as a z 0 tile
does, went from about 2.8 s to 0.57 s. Tiles z 0–4 read each bucket's own
cells summed to 64 × 64 once and kept (64 KB a bucket, the same pixels:
42 tiles compared byte for byte). Measured on a server of its own with a
fresh tile cache: a burst of 64 tiles from orbit and close in (21 at z 0–6,
40 at z 11), then the Baltimore, Paris and San Diego tiles, took 9.3 s
before and 2.5 s after, the asked tiles answering in 2.3 to 2.4 s instead
of 8.8 to 9.1 s; alone each is 4 to 17 ms from the disk cache.

Tiles z 0–4 go to the first worker alone, ahead of the others' queue: they
read every bucket's overview, which that worker builds once (each of four
workers built its own). Both inks share one draw and one file below the
footprints' zoom, and a tile file is written by a temp file of its own and
a rename tried again when Windows refuses it (EPERM while another reader
holds the file: refused 100 times in 100 here); a tile that cannot be kept
is logged, once a minute, where it was silently dropped before.

The census tracts' and the HydroSHEDS v2 rivers' tiles go the same way
(one pool implementation, `server/providers/common/tilePool.js`: a worker
imports the provider's own module and calls its service's `draw`, while
the cache read, the one-draw-per-tile rule and the atomic write,
`server/providers/common/tileCache.js`, stay on the server's thread):
three workers for census tiles (20 ms to 1.9 s each to draw), two for the
rivers (7 to 30 ms). Wikipedia coverage stays on the server's thread: its
tiles take 1 to 2 ms from a 264 MB grid in memory, which every worker
would hold again. Measured on a server of its own with the four providers
wired by their Vite plugins (fresh tiles, warm builds), a burst of 96
tiles (48 census, 32 rivers, 16 Wikipedia) took 1.07 to 1.14 s before and
0.50 to 0.56 s after; census tiles answered in a median 367 to 396 ms
(581 to 592 before), rivers 218 to 243 ms (877 to 933), Wikipedia 147 to
190 ms (984 to 1,038), and `/api/overture/layers` during the burst 168
to 205 ms (973 to 1,038).

Measured, the conterminous US (2026-10-19): 8,061 row groups, 14.4 GB of
column chunks fetched in 603 s (12 connections); decoded in 6.6 min (14
workers) and merged in 2.7 min. **152,795,749 buildings** in 60 buckets,
**3.27 GB** (about 2.1 GB per 100 million buildings); 113.4 million (74%)
have a height. A first merge of 14 buckets at a time held 15.6 GB and
thrashed; merging a z 10 tile at a time, three buckets at once, fixed it.
Cold tiles: 8 to 356 ms (the US at z 3 320 ms; Baltimore z 11 356 ms, z 12
75 to 93 ms, z 15 with outlines 81 ms; a Naperville suburb z 15 46 ms).

**Europe and the gaps** (2026-10-19, one run, `--building-regions
conterminous-us,europe --cap-gb 47`, the cache on D: through the junction):
the US gaps pass (1,096 row groups, 2.19 GB) and Europe (18,578 row
groups, 33.30 GB): 38.5 GB fetched and decoded in 40.7 min, merged in
13.2 min, 56.7 min in all. The build now holds **579,463,210 buildings**
in 191 buckets, **11.07 GB**:

| Region          | Buildings   | With a height       | Sources                                                                  |
| --------------- | ----------- | ------------------- | ------------------------------------------------------------------------ |
| Conterminous US | 164,043,095 | 121.2 million (74%) | OSM 83.6 M, Microsoft 71.3 M, Esri 8.5 M, Google 0.6 M (northern Mexico) |
| Europe          | 415,420,115 | 91.7 million (22%)  | OSM 254.4 M, Microsoft 145.8 M, IGN Spain 12.0 M, Esri 3.3 M             |

Europe's heights are mostly floors (29.2 million of the 91.7 million are
3 m a floor). The gaps pass added 11.2 million US buildings. Cold tiles:
9 to 781 ms (Europe at z 4 781 ms; London z 11 529 ms; Paris z 12 249 ms,
z 15 with outlines 147 ms; Málaga, Catania, San Diego, Miami z 12 49 to
105 ms).

What each region costs (the plan, from the footers; the derived size at
2.1 GB per 100 million):

| Region (`--building-regions`)                 | Fetched  | Buildings     | Derived |
| --------------------------------------------- | -------- | ------------- | ------- |
| Conterminous US `conterminous-us` (built)     | 14.40 GB | 155.3 million | 3.27 GB |
| Europe `europe` [-32, 34, 45, 72] (built)     | 33.30 GB | 435.9 million | ~7.6 GB |
| Western Europe [-11, 35, 19, 61]              | 19.89 GB | 242.8 million | ~5.2 GB |
| France, Benelux, UK, Germany [-6, 42, 15, 59] | 14.42 GB | 179.6 million | ~3.8 GB |
| France [-5, 42, 8.5, 51.2]                    | 6.44 GB  | 80.9 million  | ~1.7 GB |
| The world outside Open Buildings              | 72.3 GB  | 953 million   | ~20 GB  |

Row groups are spatially sorted but their boxes are coarse, so a small
region pulls in some of its neighbours' bytes (dropped by the centre test).

_Where both sources have data_ (1 km boxes, Overture with the Open
Buildings exclusion off, against Open Buildings 2.5D 2023 summed in Earth
Engine at 0.5 m):

| Box                   | COUNT per km², Overture / Open Buildings | Ratio | COVER, Overture / Open Buildings | Ratio |
| --------------------- | ---------------------------------------- | ----- | -------------------------------- | ----- |
| Lagos, Ikeja          | 2,345 / 3,308                            | 0.71  | 42.5% / 44.0%                    | 0.97  |
| Lagos Island          | 2,113 / 5,135                            | 0.41  | 36.1% / 40.8%                    | 0.89  |
| São Paulo, Pinheiros  | 2,666 / 4,427                            | 0.60  | 47.3% / 36.3%                    | 1.30  |
| Mexico City, Narvarte | 609 / 6,169                              | 0.10  | 6.6% / 39.7%                     | 0.17  |

Cover agrees within about 10% where Overture has the buildings; COUNT
reads 0.4 to 0.7 times Open Buildings' fractional count, whose raster
splits terraced rows into more buildings than footprints do. Narvarte is a
gap in Overture itself (607 footprints for a dense square kilometre). So
across a boundary between the sources expect COUNT to step down by about
half and COVER to agree.

_Licence._ Overture's buildings are ODbL: the local build is a derived
database (share-alike if it were published), and the tiles on screen are a
Produced Work that needs the credit, which the layer registers. Its
sources' licences are listed in the credit and in DATA_SOURCES.md. Like
the divisions index, it stays in `.gev-cache` and is never committed.

### Tree canopy

**Tree canopy** (`ee-tree-canopy`, ANALYSIS) draws canopy height in metres,
from 2 m to 40+ m, light to dark green, where there is none clear. Two
chips, kept as `gev.treeCanopy.mode`:

- **META 1 M** (the default): Meta and WRI's High Resolution Canopy Height
  Maps (Tolan et al. 2024). The Earth Engine community catalog's
  `projects/meta-forest-monitoring-okw37/assets/CanopyHeight` is 170 tiles,
  band `cover_code` (height in m), 1.19 m cells in EPSG:3857, MEAN
  pyramid.
- **ETH 10 M**: ETH Zürich's Global Canopy Height 2020 (Lang et al. 2023),
  `users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1`, band `b1`, 10 m, MEAN
  pyramid. It is there to compare: Meta's reads lower in tall forest (a
  1 km box in the Congo basin: 22.6 m mean against 32.7 m; the Pacific
  Northwest: 10.3 m against 20.0 m), so the two are not blended.

Both assets are readable by the service account (checked 2026-10-19).

**Level of detail: a mean pyramid, from orbit.** Zero (no canopy) is part
of the mean, so a coarse pixel is the mean height over all the ground
beneath it, gaps included: a forest reads lower from far out than its trees
are. Meta's band is an integer, so a coarse pixel whose mean is under 1 m
(dry savanna; East Africa at z 2) is 0 and clear. **Canopy cover** (the
share of ground above a height) is not offered. A mean pyramid of heights
cannot give it, and deriving it from the 1 m pixels for a coarse tile would
read every pixel under it: that needs a precomputed pyramid of its own.

Every tile was fast, so Meta's 1 m map draws from orbit with no far
fallback. Timed live on 2026-10-19 over the Congo basin and the Pacific
Northwest (maps made in 0.3 to 0.9 s):

| Tiles    | z 0–3       | z 4–6       | z 8–10      | z 12–14     |
| -------- | ----------- | ----------- | ----------- | ----------- |
| META 1 M | 0.19–0.67 s | 0.18–0.34 s | 0.18–0.34 s | 0.21–0.34 s |
| ETH 10 M | 0.11–0.36 s | 0.10–0.41 s | 0.15–0.44 s | 0.14–0.43 s |

`maxZoom` is 16 (2.4 m pixels). The optional US NLCD tree canopy mode was
not added.

Tests: `src/data/earthEngineBuildingsCanopy.test.mjs` (the records, each
mode's expression, the year filter, the footprints' blend, the zoom
variant's maps, the coverage boxes) and
`src/layers/earthEngine/buildingsCanopy.test.mjs` (the rows: coverage
words, chips, legends, the footprints' words).

### Census tracts

**Census tracts** (`ee-census-tracts`, ANALYSIS) has two modes, kept as
`gev.censusTracts.mode`:

- **TRACTS**: TIGER/Line 2020's 85,528 tract outlines (`TIGER/2020/TRACT`),
  drawn by Earth Engine in the boundaries' inks (white or near-black at
  67%, AUTO / LIGHT / DARK by the basemap).
- **HOUSEHOLD INCOME**: each tract filled by its ACS median household
  income (5-year 2020–2024, 2024 dollars) in seven classes (under $30k,
  $30k, $50k, $70k, $90k, $120k, $160k+; ColorBrewer YlGnBu at 78%), with
  thin outlines from z 10. A tract with no estimate (no households, or too
  few) is faint grey.
- **SURFACE TEMPERATURE**: each tract's summer land surface temperature
  (below).

**Why the income is drawn locally.** Earth Engine has no ACS asset (its
catalogue's TIGER group is boundaries only), and colouring 85,000 tracts
by values from elsewhere does not work inside it: a GEOID → colour
dictionary of every tract in the map expression made a 6.0 MB request,
the map in 8.6 s, and a first tile that had not answered after five
minutes (2026-10-19). An uploaded table asset is not used. So
`npm run census:build` (`scripts/census/index.mjs`) fetches what the mode
needs into `CENSUS_CACHE_DIR` (default `.gev-cache/census`), and the local
server draws the tiles (`server/providers/census.js`), as the Rivers draw
HydroSHEDS v2:

1. **Boundaries** (no key): the Census Bureau's 2024 cartographic boundary
   tracts, `cb_2024_us_tract_500k.zip` (58 MB, 1:500,000, public domain),
   downloaded once and read straight out of the ZIP (a small shapefile
   reader, `scripts/census/shapefile.mjs`) into tract files: 85,184
   tracts, 4.85 million points, about 42 MB (`server/providers/census/
tractsFile.js`: degrees × 10⁶ in Int32, a 0.5° grid index).
2. **Income** (needs **`CENSUS_API_KEY`**, free from
   api.census.gov/data/key_signup.html): ACS 2024 5-year `B19013_001E` for
   every tract, one request per state, a second apart. The Census API
   refuses keyless requests (it redirects them to its key page). Without
   the key the build skips this step and says so; the row says "Set
   CENSUS_API_KEY in .env …, then run npm run census:build" until the
   incomes are there.

`npm run census:status` reports what is built and whether the key is set
(never its value). `GET /api/census/layers` lists each local mode with
its readiness, message and tile version; `GET /api/census/tile/income/<z>/
<x>/<y>?v=<version>` draws a tile, kept under
`tiles/income/<version>/`, the version hashing the classes and the build.
The renderer (`server/providers/census/render.js`) fills each tract
(even-odd rings, four sub-rows a pixel for antialiased edges) and draws
the outlines with the Rivers' line coverage, with no canvas library.

**Level of detail: tracts only where they resolve.** A tract holds about
4,000 people: a kilometre or two across in a city, tens of kilometres in
the country. Both modes draw below `TRACT_MAX_HEIGHT_M` (417 km, where the
middle of a 1,600 px view drapes z 9: 300 m pixels, so a city tract is a
few pixels across); above it the row says to come lower. Counties and
states are the Administrative boundaries layer's. Earth Engine's outline
tiles start at z 7 (`minZoom`), the first level that answers in about a
second; the server answers a coarser one with a transparent tile.

| Zoom | TRACTS (Earth Engine, NYC / Kansas / LA) | HOUSEHOLD INCOME (local, NYC) |
| ---- | ---------------------------------------- | ----------------------------- |
| 3    | 0.2–21.4 s                               | not drawn                     |
| 4    | 3.8–12.3 s                               | not drawn                     |
| 5    | 4.6–7.2 s                                | not drawn                     |
| 6    | 1.0–3.9 s                                | not drawn                     |
| 7    | 0.4–2.6 s                                | 1.13 s (6,610 tracts)         |
| 9    | 0.5–3.2 s                                | 0.44 s (3,128); LA 0.25 s     |
| 10   | 0.5–1.3 s                                |                               |
| 11   |                                          | 0.14 s (811)                  |
| 12   | 0.5–3.4 s                                | 0.06 s (286)                  |
| 14   |                                          | 0.05 s (34)                   |

(Earth Engine: cold tiles, 2026-10-19. Local: the first draw of a tile,
with stand-in incomes; drawn tiles are then read from disk.)

**SURFACE TEMPERATURE** (the third mode, also drawn by the local server):
each tract's summer land surface temperature, the June–August 2018–2023
mean of Landsat 8 and 9 Collection 2 Level-2 `ST_B10` (×0.00341802 + 149,
in °C), clear pixels only (QA_PIXEL's dilated cloud, cirrus, cloud and
shadow bits off), on land only (JRC Global Surface Water 1.4 occurrence
under 50%), averaged over the tract (`reduceRegions`, mean) at 300 m,
in seven classes (under 25 °C to 50 °C+, RdYlBu reversed). It is the
ground's temperature, not the air's: summer roofs and roads are often over
50 °C. Google Earth's layer shows the same kind of value per tract.

It is computed once, by the build's third step (`scripts/census/lst.mjs`),
with the server's Earth Engine service account; the owner approved the
cost (about an hour of Earth Engine time at 300 m; 10 hours at 90 m,
estimated from Maricopa County's 1,009 tracts, which took 90.7 s at 90 m).

- **Resumable.** Each state's answer is written to `lst-v<rules>/<state>.json`
  as it comes, and a state already there is skipped, so a crash repeats
  nothing finished. A dropped connection or an Earth Engine 5xx is asked
  again twice (10 s, then 20 s later); a state that one request still
  cannot answer is asked county by county, each county kept the same way.
  The directory is named by the rules (`LST_RULES`), so a run under new
  rules starts afresh and the build's values change only when it ends.
- **The run** (2026-10-19, four requests at a time): 56 states and
  territories in about 19 minutes. Only Nevada went county by county (its
  statewide request failed in transit). California's 9,129 tracts came in
  one request. The first run stopped at Hawaii: tracts with no clear
  summer pixel had no mean, so the GEOID and value lists differed in
  length. Such tracts are now left out (drawn as no value), and the build
  resumed with the 10 states it had.
- **Result:** 85,413 TIGER 2020 tracts (7.3 to 60.7 °C, median 37 °C).
  85,077 of the 2024 boundaries' 85,184 tracts have a value. The 107
  without are in the territories, Hawaii and Puerto Rico. Connecticut's
  tracts are keyed across its 2022 county renumbering by their tract code,
  unique in the state (all 879 matched).
- **Water (rules 3, 2026-10-19).** TIGER 2020's tracts include their
  water, so a shoreline tract's mean took in river and sea pixels and read
  cooler (along Manhattan's rivers). Masking Landsat's per-scene water bit
  (rules 2) made it worse: in cities it is set on about half of the clear
  summer scenes (inland Harlem: 26.7 of 52.6 a pixel), and those are the
  warm ones, so what was left was the hazy, cold scenes (a Harlem tract
  29.4 → 17.2 °C, Randall's Island 26.5 → 8.1 °C). The step now masks
  water from a fixed map instead: pixels whose JRC Global Surface Water 1.4
  occurrence (1984–2021) is 50% or more are left out of the mean. Checked
  on Manhattan at 300 m and 30 m (they agree): shoreline tracts warm by 5
  to 10 °C, inland ones do not move.
- **Result (rules 3):** 85,150 TIGER 2020 tracts (7.8 to 60.7 °C, median
  37.3 °C); the 267 without a value are water: 255 are the `99xxxx`
  water-only tracts. Manhattan's 309 tracts: mean 36.0 → 37.6 °C; 88 warmed
  by over 1 °C (72 by over 3 °C: tract 002400 28.6 → 38.3, 006200 27.7 →
  37.3, 008602 26.8 → 36.3, 012902 32.8 → 40.8), 211 moved under 0.15 °C,
  none cooled. Nationwide 5,686 tracts warmed by over 1 °C, 7 cooled by
  over 0.5 °C. The run took 31 minutes of Earth Engine (two sittings: the
  first stopped on dropped connections while a large download shared the
  line, which is why the step now retries).

`--skip-lst` leaves the step out; `--env-root DIR` reads `.env` and the
Earth Engine key path from another checkout (a worktree's build reads the
main checkout's). The tiles took 0.10 to 0.15 s to draw (Phoenix z 9, NYC
z 11, Houston z 10).

Tests: `src/data/censusFlood.test.mjs` (the TRACTS expression and inks,
the shapefile reader and tract files, the ACS step with its key and
no-estimate codes, the polygon fill, the server's modes, messages, tiles
and cache, the route) and `src/layers/earthEngine/census.test.mjs` (the
income from the local server, TRACTS from Earth Engine, the row without
the key and above the ceiling, the status check).

### Inundation history

**Inundation history** (`ee-inundation`, ANALYSIS) draws the Global Flood
Database v1 (`GLOBAL_FLOOD_DB/MODIS_EVENTS/V1`; Tellman et al. 2021,
Nature 596:80; CC BY-NC 4.0): 913 large floods of 2000–2018 mapped from
MODIS at 250 m, one image per event. Two chips, kept as
`gev.inundation.mode`:

- **FLOOD COUNT** (the default): how many of the events flooded each
  place (pale blue once, deep purple 10 or more).
- **FLOODED DURATION**: the days under flood water summed over the events,
  on a log scale (1 day to 300+ days).

Each mode sums its band over the collection (`ImageCollection.reduce`,
`Reducer.sum`), less the share of each pixel that is permanent water (the
JRC map inside every event): sum × (1 − permanent water). Below a tenth of
a flood, and below a day, nothing is drawn.

**Level of detail: the sum of a mean pyramid.** Every band is pyramided by
MEAN (read from the asset), so a coarse pixel holds each event's flooded
fraction, and their sum is a count averaged over the pixel: it reads
sensibly from orbit. Permanent water is subtracted as a share, not masked,
because a mask would drop every coarse pixel that touches a lake or a coast.
There is no ceiling; `maxZoom` is 10 (150 m pixels on 250 m data).

| Zoom           | FLOOD COUNT | FLOODED DURATION |
| -------------- | ----------- | ---------------- |
| 0              | 4.51 s      | 5.22 s           |
| 1 (2 tiles)    | 1.63–3.67 s | 2.02–3.49 s      |
| 2 (2)          | 1.51–2.11 s | 1.61–2.20 s      |
| 3 (3)          | 0.99–2.51 s | 0.50–1.89 s      |
| 5, 7, 9 (Asia) | 0.97–1.52 s | 1.44–1.94 s      |

(Cold tiles, 2026-10-19; maps made in 0.8 s.)

## Elevation: the DEM stack

Since 2026-10-19 the terrain layers (**Terrain slope**, **Terrain aspect**,
**Hillshade** and the new **Elevation**, all in ANALYSIS) draw the best
free elevation at each place and zoom instead of Copernicus GLO-30
everywhere. The choice is one shared module, `src/data/demStack.js` (pure
data and functions, used by the server and the client), with its tests in
`src/data/demStack.test.mjs`.

**The sources.** Each was read live with the server's service account on
2026-10-19 (asset metadata, a point sample over land and sea, and tiles):

| Source         | Earth Engine id                                                 | Pixel                  | Licence                                            | Readable | Coverage (live)                                                                                                                                            |
| -------------- | --------------------------------------------------------------- | ---------------------- | -------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GMTED2010      | `USGS/GMTED2010_FULL`, band `mea`                               | 7.5″ (231 m)           | US public domain                                   | yes      | 56° S to 84° N; its sea is 0, and so is all of Greenland (no data); no Antarctica                                                                          |
| FABDEM v1-2    | `projects/sat-io/open-datasets/FABDEM`, band `b1`               | 1″ (30 m), EPSG:4326   | CC BY-NC-SA 4.0, non-commercial; Copernicus notice | yes      | 19,011 1° tiles, 60° S to 80° N (none at 81° N, none in Antarctica); water inside a land tile is 0, the open sea has no tile                               |
| USGS 3DEP 10 m | `USGS/3DEP/10m_collection`, band `elevation`                    | 1/3″ (10 m), EPSG:4269 | US public domain                                   | yes      | the United States and territories (Alaska, Hawaii, Puerto Rico, the Virgin Islands, Guam, American Samoa) with a few km of buffer; water at sea level is 0 |
| USGS 3DEP 1 m  | `USGS/3DEP/1m`, band `elevation`                                | 1 m, UTM per project   | US public domain                                   | yes      | patchy, by lidar project (Denver yes; Mount Rainier's summit, Anchorage and the Brooks Range no); water masked                                             |
| ArcticDEM v4.1 | `UMN/PGC/ArcticDEM/V4/2m_mosaic`, bands `elevation`, `datamask` | 2 m, EPSG:3413         | PGC/NSF acknowledgement                            | yes      | north of 50° N; heights above the WGS84 ellipsoid; water and voids filled from GLO-30 (`datamask` 0)                                                       |
| REMA v1.1      | `UMN/PGC/REMA/V1_1/8m`, band `elevation`                        | 8 m                    | PGC/NSF acknowledgement                            | yes      | Antarctica; ellipsoidal heights; sea masked                                                                                                                |

FABDEM is the community catalog's asset (the API refuses to list
`projects/sat-io` folders, but `ImageCollection.load` reads it), and holds
V1-2 (the catalog's changelog; V1-2 fixed V1-0's tile-edge seams over
forests and its high-latitude misalignment). `USGS/3DEP/10m`, the single
image, still loads but is deprecated in favour of `10m_collection`, so the
collection is used. No `ArcticDEM/V4` 10 m or 32 m mosaic and no REMA v2
exists in the public catalog (404); the 2 m mosaic and REMA's 8 m are
single pyramided images, fast at every zoom, so nothing coarser is needed.

**The bands.** Each tile is drawn by the band of its own zoom (through the
server's `zoom` variant, as the Rivers are); the camera height names the
band in the row (heights for a 1,600 px canvas, `riverHeightForCanvas`
scales them to the pane). Bottom to top:

| Band     | Zooms | Camera height   | Layers, bottom to top                                  |
| -------- | ----- | --------------- | ------------------------------------------------------ |
| `far`    | 0–5   | 3,338 km and up | ArcticDEM (its data mask), REMA, GMTED2010             |
| `base`   | 6–10  | 104 to 3,338 km | ArcticDEM (its data mask), REMA, FABDEM                |
| `polar`  | 11–12 | 26 to 104 km    | FABDEM, REMA, ArcticDEM (on land)                      |
| `fine`   | 13    | 13 to 26 km     | FABDEM, REMA, 3DEP 10 m, ArcticDEM (on land)           |
| `finest` | 14–17 | below 13 km     | FABDEM, REMA, 3DEP 10 m, ArcticDEM (on land), 3DEP 1 m |

**Why those zooms** (`tilePixelM`: 156,543 m × cos latitude / 2^z per
tile pixel, the way `src/maps/h3Resolution.js` sizes hexes against screen
pixels). A finer source joins where a tile pixel becomes smaller than the
pixel of the source beneath it, so its detail can show:

- FABDEM from z 6: GMTED2010's 231 m are finer than a z 6 tile pixel
  (2.4 km at the equator) and FABDEM's coarse tiles are slow (z 3 8.7 s,
  z 4 3.5 to 14.8 s, z 5 1.8 to 5.8 s; z 6 to 8 under 0.7 s), so the switch
  is at z 6, the old 3,000 km line.
- ArcticDEM from z 11: a z 11 tile pixel at 70° N is 26 m, smaller than
  FABDEM's 30 m (z 10: 52 m).
- 3DEP 10 m from z 13: at 37° N (the conterminous states' middle) a z 12
  pixel is 31 m, no finer than FABDEM; z 13 is 15.6 m.
- 3DEP 1 m from z 14: 7.8 m at 37° N, finer than 10 m (z 13 is not).
- REMA at every zoom: FABDEM and GMTED2010 have no Antarctica.

How deep to ask (`maxZoom`, about 3 to 4 tile pixels to one source pixel
at its region's middle latitude, FABDEM's old 14 at 40° N being 4):
FABDEM 14, REMA 14, 3DEP 10 m 15, ArcticDEM 16, 3DEP 1 m 17. The client
asks as deep as the deepest source in the view's square goes
(`maxZoomInRect`): 17 over the United States, 16 in the Arctic, 14
elsewhere. The layers' `maxZoom` is 17 (Elevation's 14: a tint shows no
more at 1 m than at 7 m).

**Regions** (boxes `[west, south, east, north]`; a box stops at 85.1°,
since a box to the pole cannot be put into Web Mercator: "Can't transform
(180.0,90.0)"):

- **United States** (both 3DEP sources, `US_BOXES`): the conterminous
  states `[-124.85, 24.4, -66.85, 49.0]`, Alaska `[-180, 51.2, -141, 71.6]`,
  its panhandle `[-141, 54.6, -129.95, 60.4]`, the Aleutians west of 180°
  `[172.4, 51.2, 180, 53.1]`, Hawaii `[-160.6, 18.8, -154.7, 22.4]`, Puerto
  Rico and the Virgin Islands `[-67.35, 17.85, -64.5, 18.55]`, Guam and the
  Northern Marianas `[144.55, 13.2, 146.1, 20.6]`, American Samoa
  `[-171.15, -14.6, -168.1, -14.1]`. Read live: 3DEP 10 m has Toronto and
  Vancouver (buffer), not Montreal, Victoria, Tijuana, Ciudad Juárez,
  Monterrey, Nassau, Whitehorse or Fredericton. The conterminous box takes
  in the Canadian shore of the Great Lakes and Vancouver Island's south
  tip: there the row says 3DEP 10 m, and FABDEM draws wherever 3DEP has no
  data.
- **Arctic** (ArcticDEM): `[-180, 60, 180, 85.1]`. Its data reach 50° N,
  but south of 60° FABDEM's bare earth is the better base. In Alaska north
  of 60° it lies over 3DEP 10 m (2 m against 10 m).
- **Antarctica** (REMA): `[-180, -85.1, 180, -60]`.
- For naming only: FABDEM covers `[-180, -60, 180, 80]`, GMTED2010
  `[-180, -56, 180, 84]` less Greenland `[-74, 59.5, -10.5, 84]`.

The row's status line says which source draws under the middle of the
view ("Elevation: USGS 3DEP 10 m", "Elevation: FABDEM 30 m", "Elevation:
ArcticDEM 2 m", "Elevation: REMA 8 m", "Elevation: GMTED2010 230 m"); for
3DEP 1 m, which is patchy, "USGS 3DEP 1 m where lidar exists, else 10 m"
(a box cannot say where the lidar is: Mount Rainier National Park has none,
0 of the collection's images at the summit, Paradise or the west flank,
counted live 2026-10-19). The credit
line names the sources the view's square can show (the band at the middle
and the finer ones down to the deepest level asked for), and the provider
is made again when they change; each source's own entry
(`demSourceCredit` in `src/data/dataCredits.js`, keyed `dem-<source>`)
joins the Data attribution popover the first time it draws. The row's
tooltip is the notices of the sources in view.

**Sea and no-data.** FABDEM and both 3DEP sources store water at sea level
as 0 inside their tiles, so they mask 0 first (`seaIsZero`). That also
fixes an old fault: the Copernicus DEM stores the sea inside every land
tile as 0, and the old `near` variant drew those 1° squares as flat green
(slope) or grey (hillshade) blocks over every coast (live tile `7/69/46`,
the Adriatic). GMTED2010's 0 is masked as before. ArcticDEM fills water and
voids from GLO-30 and marks them `datamask` 0: where it fills beneath
(`far`, `base`) it is masked by its data mask; on top (`polar` and finer)
by the base's land (FABDEM not 0, or where FABDEM has nothing, north of
80° N, its data mask), because its data mask alone leaves holes over
rough land that the base would show through as patches. REMA masks its sea
itself.

**Datums and seams.** ArcticDEM and REMA give heights above the WGS84
ellipsoid, 30 to 60 m from the others (Oslo's fjord: 39 m against
FABDEM's 0). So the terrain layers compute slope, aspect or hillshade on
each source and mosaic the results, finer on top within its box and the
base beneath it with no gap: a datum's offset makes no cliff at a box's
edge. A seam is still visible where two sources meet, as a change of
detail (finer sources give steeper, sharper slopes) and a line a pixel or
two wide where the finer source's terrain kernel runs out: along 49° N
(3DEP to FABDEM, `13/1325/2813`), at the Alaska panhandle's box edge (129.95° W), and along 60° N
(FABDEM to ArcticDEM, `12/2123/1189` in western Norway) from z 11. The
Elevation layer mosaics heights, so it keeps the ellipsoidal sources
beneath the others (`bandLayers(band, {heights: true})`): they fill only
where nothing else has heights (Greenland far out, north of 80° N,
Antarctica).

**Grids.** A collection's mosaic has no projection of its own, and the
terrain operations need one. Given EPSG:4326 or EPSG:3857 at a scale (the
old approach), FABDEM's and 3DEP 10 m's hillshade came out striped: the
mosaic's grid is not the data's, and every tile is resampled into lines.
Each now gets its own grid (`crs`, `crsTransform`): FABDEM's 1″ grid with
pixel centres on whole arc-seconds, 3DEP 10 m's 1/3″ NAD83 grid (its 1°
tiles start 6 pixels before their degree). 3DEP 1 m's 10 km tiles are in
many UTM zones, so no one grid fits: each tile is drawn on its own
(`perImage`: `Collection.map` over the images, the terrain operation in
each one's projection), then mosaicked; the tiles overlap by 6 m, so their
edges leave no gap. Slope is right in every projection tried (the same
tiles' mean slopes agreed within about 1° between the native image, EPSG:4326 and
EPSG:3857, at 47° N and 70° N).

**Bilinear, before and after the terrain operation** (`DEM_RESAMPLE`).
The client asks for tiles as deep as the deepest source in the view goes
(3DEP 1 m: z 17), but where there is no lidar the 10 m beneath draws,
magnified: at z 17 a 10 m cell is about 12 × 12 tile pixels. Read
nearest-neighbour, the hillshade was a mosaic of flat grey squares (Mount
Rainier's west flank, 46.9176, −121.9049, z 17, 2026-10-19). Every source
is now read bilinearly on its own grid, and because Earth Engine computes a
terrain operation on the source's own grid, its result is resampled
bilinearly too: magnified, slope, aspect and hillshade shade smoothly.
Elevation's heights are read bilinearly as well, and the contours were
already. Tile times did not change (0.19 to 1.65 s at z 3 to 17 over Rainier,
the Alps and Tromsø, three layers).

**How it is drawn** (`server/providers/earthEngine.js`
`demStackExpression`). One map per (layer, band): 5 × 4 = 20, made when a
tile first asks (`lazyMaps`). Each is `ImageCollection.mosaic` of
`ImageCollection.fromImages`, one image per source: its elevation (a
shared value, so FABDEM read for the base and for ArcticDEM's land mask is
one node), its masks, the terrain operation (or, for Elevation, the height
renamed to one band and type), `Image.clip` to its boxes (one box a
`BBox`, several a planar `MultiPolygon`). Earth Engine skips a clipped
source whose box misses the tile: the full `fine` band over the Alps or
the Himalaya took 0.3 to 0.8 s against 0.3 s for FABDEM alone. The route
is the usual one, `/api/earth-engine/tile/<layer>/zoom/default/<z>/<x>/<y>?v=<hash>`,
the version hashing every band's request, and the disk cache keeps each
band under its own hash. The coarse tiles a 3D tileset asks for (z 0 to 2
for continent-sized primitives) come from the `far` band, never FABDEM's
slow coarse tiles; `minimumLevel` stays 0 and each primitive takes one to
four tiles, within the 10-texture cap.

**Elevation** (`ee-elevation`). A hypsometric tint of the same stack,
drawn from orbit by GMTED2010 (with ArcticDEM over Greenland and REMA over
Antarctica, which GMTED2010 lacks). It shows √max(height, 0) from 0 to 80
(`transform: 'sqrt'`), so the lowlands, where most land is, get as many
colours as the mountains: nine stops at 0, 100, 400, 900, 1,600, 2,500,
3,600, 4,900 and 6,400 m (legend 0, 400, 1,600, 3,600 and 6,400 m+). Its
tiles took as long as the others' (below).

**Timings** (2026-10-19, live, sequential, each run a new map at places no
earlier run asked for; the layers' own requests; s):

| Band     | Zooms timed     | Hillshade | Slope   | Aspect  | Elevation |
| -------- | --------------- | --------- | ------- | ------- | --------- |
| `far`    | 0–5 (11 tiles)  | 0.2–6.6   | 0.3–3.1 | 0.3–2.4 | 0.2–0.6   |
| `base`   | 6–10 (9 tiles)  | 0.3–1.6   | 0.2–0.8 | 0.3–1.6 | 0.2–0.7   |
| `polar`  | 11–12 (7 tiles) | 0.4–1.3   | 0.3–0.9 | 0.4–0.8 | 0.4–0.6   |
| `fine`   | 13 (6 tiles)    | 0.4–1.0   | 0.4–1.2 | 0.3–0.8 | 0.3–3.0   |
| `finest` | 14–17 (9 tiles) | 0.3–0.8   | 0.4–1.0 | 0.3–0.9 | 0.2–0.6   |

Places: the world at z 0, North America, Australia, Greenland, the
Himalaya, Antarctica and Europe at z 1 to 5; the Himalaya, the Ross Sea,
the Alps, Franz Josef Land, the Andes, Siberia, Colorado, Svalbard and
Fuji at z 6 to 10; Tromsø, Anchorage, the Alps, Svalbard, Greenland's west
coast, McMurdo and Colorado at z 11 and 12; Mount Rainier, Anchorage,
Svalbard, the Alps, the 49th parallel and the Antarctic Peninsula at z 13;
Denver (z 14), Washington (z 15), San Francisco (z 16), Breckenridge
(z 17), Rainier, Anchorage, Tromsø, the Alps and McMurdo at z 14 and 15.
The slowest tile seen in all the runs was 8.4 s (slope, `polar`, z 12 over
northern Norway, before the grids above); every one is far inside the
proxy's 30 s. The sources on their own (hillshade, s): GMTED2010 z 0 to 5
0.2 to 0.4; FABDEM z 3 8.7, z 4 3.5 to 14.8, z 5 1.8 to 5.8, z 6 to 8 0.2
to 0.7; Copernicus GLO-30 (the old `near`) z 5 2.3 to 3.9, z 6 8.2 to 9.5;
3DEP 10 m z 6 to 15 0.2 to 0.5; 3DEP 1 m z 13 to 17 0.3 to 0.6; ArcticDEM
z 2 to 16 0.2 to 1.8; REMA z 1 to 14 0.2 to 0.4.

**Check it live** (lat, lon, camera height):

- United States: Mount Rainier, 46.853, −121.760 at 20 km ("USGS 3DEP 10
  m") and 5 km ("USGS 3DEP 1 m where lidar exists, else 10 m": no lidar
  there, so 10 m, smooth; Denver, 39.70, −105.25 at 3 km, has lidar).
- The Arctic: the Lyngen Alps, 69.60, 20.20 at 60 km ("ArcticDEM 2 m").
- Elsewhere: the Jungfrau, 46.54, 7.96 at 20 km ("FABDEM 30 m").
- Seams: the 49th parallel at Chilliwack Lake, 49.00, −121.40 at 20 km
  (3DEP south, FABDEM north); the 60th parallel in western Norway, 60.00,
  6.60 at 60 km (ArcticDEM north, FABDEM south).
- Antarctica: McMurdo, −77.85, 166.67 at 100 km ("REMA 8 m"); Greenland from
  8,000 km, 72, −40 (drawn now: GMTED2010 has nothing there).

**Checklist** ([Level of detail](#level-of-detail)):

- [x] Its record says how its detail follows the camera: a pyramid of
      elevation (mean), terrain derived at the tile's scale from each
      source, sources switched by zoom band and region.
- [x] It draws from orbit (GMTED2010, with ArcticDEM and REMA).
- [x] Its coarsest tiles were timed live (z 0 to 2: 0.2 to 4.4 s), every
      band at its zooms (above); FABDEM's slow coarse tiles are never
      asked for.
- [x] Not a boundary table.

Tests: `src/data/demStack.test.mjs` (the sources and their credits, the
bands and why their zooms, heights against Cesium's drape zoom, the source
named at a point, the sources and depth of a view),
`src/data/earthEngine.test.mjs` (the bands' expressions in the fixture, the
zoom variant and lazy maps) and `src/layers/earthEngine/earthEngine.test.mjs`
(the row, the credit and the depth over Rainier, the Alps, Tromsø and from
orbit; Elevation's tint).

## Raster values (for Lego mode)

`GET /api/raster/values` answers numbers, not coloured tiles, for a raster
layer over a view window: what the client's Lego mode raises as heights.
The DEM stack's heights come first; they are also the base height for every
other layer on the photoreal tiles. The service is
`server/providers/rasterValues.js`, with the Earth Engine adapters in
`rasterValues/earthEngineValues.js` and the self-hosted ones in
`rasterValues/selfHosted.js`. The encoding, the window's grid and the
client's fetch are in `src/data/rasterValues.js`.

```
GET /api/raster/values?layer=<layerId>&mode=<modeKey or ''>
    &west=&south=&east=&north=&cells=<max cells a side, ≤ 512>
```

**The answer** is `application/octet-stream`:

- a little-endian uint32, the header's length;
- the UTF-8 JSON header, padded with spaces to 4 bytes;
- the values as little-endian Float32, row-major, the north row and the
  west column first.

The header holds `schema` ('raster-values/1'), `layer`, `mode` (the key
used; '' for a layer without modes), `cols`, `rows`, the box, `cellSizeM`
(a cell's width at the window's centre), `units`, `nodata`, `min` and
`max` (of this grid; null when it is all nodata), `legendMin` and
`legendMax` (the layer's display range, in the same units), `source` (the
name shown to the user), `version` (a hash of what the values are made
from) and `aggregation` ('mean', 'sum', 'mode' or 'sample'). Nodata is NaN.
JSON has no NaN, so the header's `nodata` is the string "NaN", and
`decodeRasterValues` turns it back into NaN. Elevation and the terrain
layers add `band`, the DEM stack's band read.

**The grid.** `cells` is the longer side, measured in ground metres at the
centre; the other side keeps the cells about square. Elevation and the
terrain layers never go finer than the stack's own cell in the window
(`stackNativeM`): 3DEP 1 m in the US, 2 m ArcticDEM, else FABDEM's 30 m. So
a 2 km window at 512 cells gets 66 × 66 cells of 30 m. Their band is the
one a map tile of the cell's size would draw (`bandForZoom`).

**Errors** are JSON `{error}`:

- 400: bad parameters;
- 404: a layer or mode without values;
- 413: more than 512 cells a side;
- 503: the data is not built, or Earth Engine is not set up (the message
  says what to run);
- 429: the day's Earth Engine budget is used.

`?v=` is ignored. Each Earth Engine answer counts as one tile against the
day's budget (`EARTH_ENGINE_DAILY_TILES`), as a map tile does.

**Kept on disk** under
`.gev-cache/raster-values/<layer>/<mode>/<version>/<hash>.bin` for 30
days, the hash being of the layer, mode, box and cells. A changed
expression, build or grid file makes a new version. Answers in flight are
shared. The self-hosted sources are computed in two worker threads, the
shared tile pool's `raster-values` drawer
(`server/providers/common/tileWorker.js`).

**Earth Engine** values come from `image:computePixels` as NPY. The
expression is the layer's own (`expressionFor`), less what only colours
it: Elevation's √, the log10 ramps and the `atLeast` floors, so a field's 0
people is 0, not nodata. Two float bands come back: `v`, the value
unmasked to 0, and `m`, `Image.mask`. Nodata is exactly where `m` is 0, so
no sentinel can collide with a real value. Earth Engine reads the pyramid
level nearest the cell. A coarse cell is that level's mean, or its mode
for the categorical assets (MODE pyramids).

| Layer (mode)                      | Source                            | Units                | Aggregation |
| --------------------------------- | --------------------------------- | -------------------- | ----------- |
| Elevation                         | DEM stack (FABDEM, 3DEP, GMTED …) | m                    | mean        |
| Slope                             | DEM stack                         | °                    | mean        |
| Aspect                            | DEM stack                         | °                    | sample      |
| Population (each epoch)           | GHSL P2023A                       | people/km²           | mean        |
| Surface water (occurrence/change) | JRC GSW 1.4                       | %                    | mean        |
| Surface water (seasonality)       | JRC GSW 1.4                       | months               | mean        |
| Tree canopy (META 1 M, ETH 10 M)  | Meta and WRI / ETH                | m                    | mean        |
| Buildings (COUNT/COVER/HEIGHT)    | Open Buildings 2.5D (2023)        | per km², fraction, m | mean        |
| Forest types                      | JRC forest types 2020             | class 1–3            | mode        |
| Land cover (2021, 2020)           | ESA WorldCover                    | class 0–10           | mode        |
| Forest loss                       | Hansen GFC                        | years since 2000     | mode        |
| Inundation (count, duration)      | Global Flood Database v1          | count, days          | mean        |

Classes are the legend's indices: Forest types 1 natural, 2 primary, 3
planted; Land cover 0 to 10 in `LAND_COVER_CLASSES` order. Aspect is
computed per cell from heights averaged to that cell, since a mean of
compass bearings means nothing.

**Self-hosted** values are computed from the fork's own builds:

| Layer (mode)                      | Source                              | Units                | Aggregation   |
| --------------------------------- | ----------------------------------- | -------------------- | ------------- |
| Buildings, outside Open Buildings | Overture buildings (density blocks) | per km², fraction, m | mean / sample |
| Census tracts (income)            | ACS 2020–2024, per tract            | USD                  | sample        |
| Census tracts (lst)               | Landsat summer LST, per tract       | °C                   | sample        |
| Wikipedia coverage (articles)     | grid.bin pyramid                    | articles/km²         | mean          |
| Wikipedia coverage (text)         | grid.bin pyramid                    | bytes/km²            | mean          |
| Wikipedia coverage (count)        | grid.bin pyramid                    | articles             | sum           |

- **Buildings** answers as the layer draws: Overture's build where the
  window's centre is outside Open Buildings and inside one of the build's
  regions, else Earth Engine. Overture's cells are summed from the
  buckets' z 14-pixel cells (2.4 km), or the z 10 tiles' (153 m), into the
  cell holding their centre, then divided by the cell's ground ('mean').
  A cell finer than 153 m takes the z 10 pixel under its centre
  ('sample'). HEIGHT is NaN where the tiles leave it clear (under 5%
  built, or under a quarter of it with known heights). Outside the regions
  it is NaN.
  - **Coarse levels.** A cell of 0.35° or more reads the coarsest of each
    bucket's levels of which it holds four cells a side: 64², 32², 16², 8²
    or 4² cells a bucket (0.088° to 1.4°). The 64² one is the z 0–4 tiles'
    overview; the coarser ones are summed 2 × 2 from it. A level cell's
    sums are split over the cells it overlaps by ground, so a city on a
    cell's edge goes to both sides by area rather than whole to one. The
    levels are summed once a bucket and kept: about 85 KB a bucket, 16 MB
    for the 191-bucket build. Fewer than four a side was too coarse:
    building density changes faster than that.
  - **Timings.** For a world window (512 × 242, 0.7° cells), against the
    191-bucket build (conterminous US and Europe):
    - Before: 1.43–1.57 s every time, re-reading every bucket's z 14
      cells.
    - After: 26–40 ms once the levels are kept. The first request after a
      start takes 1–2 s, building the overviews.
    - Totals: the same to 0.01%.
    - Cells: 94% within 5% of the z 14 answer and 97% within 10%. The
      worst cell is 5.6% of the window's p99 value away, which is invisible
      as a Lego height. The cells that move are sparse ones beside dense
      ones.
    - Continent windows (0.1° cells) still read the z 14 cells, with the
      same answers as before.
  - **Open buckets.** The values worker keeps open every bucket it reads,
    unless `GEV_BUILDINGS_VALUES_MAX_OPEN` caps it (the map tiles keep 48).
    An open bucket holds its block index, 32 bytes a block: 0.65 MB for the
    mean bucket, 2 MB for the densest, and 125 MB for all 191, in each of
    the two values workers. A continent window reads 60 to 110 buckets, and
    reopening them past 48 cost a third of its time: Americas and USA went
    from 530 to 365 ms, Europe from 700 to 490 ms.
- **Census tracts** fill each cell with the value of the tract under its
  centre (even-odd, so holes stay out). It is NaN outside the tracts and
  where a tract has no estimate. TRACTS (the outlines) has no values.
- **Wikipedia coverage** sums the grid's cells whose centres fall in each
  cell, from the coarsest level whose cells still fit one. A cell finer
  than 0.05° takes its share of the count by ground.

**Skipped:**

- Rivers (v2 and Earth Engine), Administrative boundaries and Census tract
  outlines: they are lines, not rasters.
- Hillshade: shading, not a quantity.
- Elevation contours: lines.

**Timings**, live on 2026-10-19, with an empty disk cache, through the
worker pool. Each value is the time for one window at 128, 256 and 512
cells. A self-hosted source's first answer in a worker includes reading
its build (0.3 to 0.9 s). A kept answer serves in 2 to 5 ms.

| Layer (mode), window                   | 128    | 256    | 512    |
| -------------------------------------- | ------ | ------ | ------ |
| Elevation, Alps 0.5° (base, 30 m)      | 1.73 s | 1.02 s | 1.61 s |
| Elevation, Baltimore 0.1°              | 0.72 s | 0.64 s | 1.09 s |
| Elevation, Europe 20° (far)            | 0.66 s | 0.77 s | 0.83 s |
| Slope, Alps                            | 0.55 s | 1.41 s | 1.33 s |
| Population, Paris                      | 0.32 s | 0.51 s | 0.94 s |
| Surface water occurrence, Louisiana    | 0.53 s | 0.49 s | 1.07 s |
| Tree canopy (META 1 M), Cascades       | 0.53 s | 0.64 s | 0.98 s |
| Buildings COUNT, Lagos (EE)            | 0.45 s | 0.49 s | 1.03 s |
| Land cover 2021, Alps                  | 0.41 s | 0.48 s | 0.65 s |
| Forest types, Germany                  | 0.28 s | 0.44 s | 0.80 s |
| Inundation count, Bangladesh           | 0.96 s | 0.96 s | 3.73 s |
| Buildings HEIGHT, Baltimore (Overture) | 0.38 s | 0.07 s | 0.10 s |
| Buildings COUNT, Europe (Overture)     | 0.92 s | 0.51 s | 0.58 s |
| Census income, Baltimore               | 0.35 s | 0.03 s | 0.03 s |
| Census LST, the United States          | 0.23 s | 0.20 s | 0.24 s |
| Wikipedia articles, Europe             | 0.05 s | 0.15 s | 0.59 s |
| Wikipedia count, London                | 0.01 s | 0.01 s | 0.02 s |

**The client** uses `createRasterValuesClient()` from
`src/data/rasterValues.js`. Its `get({layer, mode, box, cells})` resolves
to `{header, values}` (a Float32Array). It keeps an in-memory LRU keyed as
the server's cache (64 answers), makes one request per key however many
ask, and does not keep failures. A failure rejects with an Error carrying
`status`.

```
curl -s "http://localhost:4173/api/raster/values?layer=ee-elevation&mode=&west=7.5&south=45.8&east=8&north=46.2&cells=256" -o alps.bin
curl -s "http://localhost:4173/api/raster/values?layer=ee-buildings&mode=height&west=-76.65&south=39.25&east=-76.55&north=39.33&cells=256" -o baltimore-heights.bin
```

Tests: `src/data/rasterValues.test.mjs` covers the encoding's round trip,
the parameters, the grid and the client.
`server/providers/rasterValues.test.mjs` covers:

- Elevation through a mocked computePixels: the grid sent, the band, NaN
  where masked, counted as a tile, kept on disk;
- the modes' units and legends;
- 400, 404, 413, 429 and 503;
- Wikipedia coverage on a tiny grid;
- census tracts with a hole;
- the NPY reader;
- the route.

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

## Custom cutouts (REFERENCE)

A cookie-cutter for Google's photorealistic 3D tiles. With the layer on and
the Google 3D map active, the tiles are clipped to one or more boundaries
(a city's limits, a neighbourhood), and everything outside them shows a
plain plate. The plate is black or white, and the draped overlays
(districts, rivers, localities) lie on it around the cut pieces. Each piece
stands as a 3D "cookie" on the plate. With the layer off, or with every
cutout hidden, the tiles are exactly as without it.

**Using it.** Turn on Custom cutouts (REFERENCE, in the DATA LAYERS panel).
The CUSTOM CUTOUTS panel opens in the right rail:

- **PLATE: BLACK / WHITE** sets the colour under the cut tiles.
- **ADD AT VIEW CENTRE** lists the administrative areas under the middle
  of the view, most local first, with their OSM `admin_level` (L10 a
  neighbourhood, L6 a US city or county, L4 a state). ADD puts one in the
  list.
- **FIND** takes a place name through the search box's geocoder, then lists
  the areas at the place it finds, the one named like the query first.
- **The list:**
  - ◉/○ shows or hides a cutout;
  - its name field renames it (Enter or leaving the field keeps the name,
    Escape undoes the edit);
  - × deletes it;
  - RESET LIST empties the list (the plate and the toggle stay).
  - A cutout whose boundary could not be fetched says NOT FOUND; a click on
    it tries again.
- **Needs Google 3D:** on any other map the layer changes nothing, and the
  panel says to choose Google 3D.

The user's test case is `map=photoreal` with Baltimore (relation 133345,
`admin_level` 6) and Cedarcroft (relation 12744748, `admin_level` 10),
both under 39.3699, −76.6131.

**Drawing a cutout.** For an area no boundary has, such as a house lot,
**DRAW** outlines it by its corners:

- Each left click on the map adds a corner where it lands. The pick is the
  app's depth-aware one (`pickWorldFromScreen`, as the annotation Draw tool
  uses), so a corner sits on Google's ground or roof, not on the ellipsoid
  under it.
- The open outline is drawn live, with a dot at each corner; the first dot
  is larger.
- **UNDO** or Backspace takes the last corner back.
- **FINISH**, Enter, or a click on the first corner (within 10 px) closes
  it, from 3 corners.
- **CANCEL** or Escape leaves draw mode with nothing added.
- While drawing:
  - the left button only places corners: it never starts a pan;
  - right-drag pans, middle-drag tilts, and the wheel zooms;
  - map clicks do nothing else (the tool holds the shared pointer), and the
    Viewer's own entity click and double click are borrowed.
- Every way out (finish, cancel, the layer off) gives the camera's input
  lists, the clicks, the keys and the pointer back exactly as they were.
- Backspace and Enter are left alone while a text field has the focus.
- The new cutout is named "Drawn 1", "Drawn 2" and so on (one more than the
  highest drawn number listed). It is renamed, hidden, shown and deleted
  like the others, and its row's tag says DRAWN.
- **A crossing outline is refused, not repaired.** A corner whose edge
  would cross an earlier one is not added, and FINISH is refused when the
  closing edge would cross. The panel says why in one line; a guess at
  what was meant could cut the wrong lot. Edges folding back on each other
  count as crossing.
- **Winding does not matter:** every ring is turned counter-clockwise
  before it is clipped, so a ring drawn either way round cuts the same.
- **The cap is 200 corners** (`DRAW_MAX_VERTICES`), because the ring lives
  in the URL. At the cap the panel says so; FINISH or UNDO goes on from
  there.
- A drawn ring is never simplified: the cap is below the 400-point vertex
  budget.
- The list's limit of 12 holds: with 12 cutouts listed, DRAW says to
  delete one first.

**Where the boundaries come from.**

1. **The local Overpass**, through the app's own proxy (`/api/overpass`,
   so its sanitizer and cache apply):
   - `is_in(lat,lon)` lists the areas at a point.
   - Each area's geometry comes from
     `area(3600000000 + id)->.a; rel(pivot.a); out geom;`. That is the
     sanitizer's bounded pivot form: `relation(id)` on its own is refused as
     unbounded.
   - Both are boundary-class queries, kept 30 days in the proxy's disk
     cache.
   - The outer members' ways are stitched into closed rings
     (`buildRingComponents`, `src/sources/featureGeometry.js`). Rings under
     10,000 m² are dropped.
   - Measured on 2026-10-23 at the test point:
     - is_in took 25.8 s the first time after the clone, then 0.6 to 1.0 s.
       The proxy waits 22 s for an upstream (`OVERPASS_TIMEOUT_MS`), so that
       very first lookup can fail once; the panel's "try again" covers it.
     - Baltimore's geometry was 0.8 s and gave 1 ring of 113 points.
     - Cedarcroft's was 13 s cold and gave 1 ring of 46 points.
2. **The bundled boundary packs**, when Overpass is not configured or does
   not answer:
   - FIND falls back to `findAdminArea` (`src/data/adminBoundaries.js`:
     countries, states and provinces, US counties, "Baltimore city"
     included).
   - Such a cutout's key is its query, folded (`pack:baltimore-city`), so a
     reload finds it again.
   - ADD AT VIEW CENTRE has no pack fallback, because the packs answer only
     by name.
   - The neighbourhood polygons (`src/data/neighborhoodPolygons.js`) cover
     San Francisco only, so they are not used.

**Rendering.**

- **Clipping:** a `ClippingPolygonCollection` (Cesium 1.138 here) with one
  `ClippingPolygon` per outer ring, set on the Google tileset with
  `inverse: true`. That keeps what is inside any polygon (a union).
- **Inner rings (holes) are ignored** in this pass: a cutout covers its
  outer boundary whole.
- **Requires WebGL2** (`ClippingPolygonCollection.isSupported(scene)`).
  Without it the tiles stay whole, and the panel says so.
- **The vertex budget:** 400 points a cutout over all its rings
  (`CUTOUT_VERTEX_BUDGET`). Douglas–Peucker's tolerance is raised by
  bisection until the rings fit, and the bigger rings keep more. Clipping's
  cost grows with the vertex count per fragment.
- **Outlines:** a clipped tileset has no side walls, so each ring also gets
  a 2 px outline on the ground (white on black, black on white). That reads
  as the cut edge; there is no extruded wall.
- **The plate:** `MapSourceController.setPlate(color)`, used only by this
  layer.
  - While a colour is set and a 3D tileset is the active stack, the globe
    is shown under the tiles in that colour.
  - Draped overlays then host on the globe (`resolveImageryHost` prefers a
    shown globe) instead of on the tileset, so the clipping never cuts
    them away.
  - Set back to null, the stack is as before: globe hidden, overlays on the
    tiles.
  - The plate is the bare ellipsoid. Where a city's ground lies below the
    ellipsoid (the geoid is some 33 m under it at Baltimore, so a harbour
    is too), an opaque plate would cover it inside the cookie. So the
    globe is clipped too, the other way round (`inverse: false`): it is cut
    away inside the cutouts. Each piece then stands in its own hole in the
    plate, never covered by it, slightly proud of the plate where the
    ground is high and a little below its rim where the ground is low.
- **No quota saving:** clipping hides tiles but does not stop them
  streaming. Google 3D loads and bills the same tiles as without the layer.

**State and the URL.**

- The layer is local-only (never in `l=`). Its toggle, plate and list ride
  in a hash parameter of their own, `cc`, e.g.
  `cc=1.black~osm:133345*Baltimore~osm:12744748!Cedarcroft`:
  - `1`/`0` is the toggle;
  - `*` shows a cutout and `!` hides it;
  - names are URI-encoded;
  - fetched rings are never stored.
- **A drawn cutout has no upstream, so its ring is its source key:**
  `draw:` and the base64url, unpadded, of its corners.
  - The corners are kept at 1e-6° (about 11 cm). Each latitude and
    longitude is stored as its difference from the corner before, as a
    zigzag varint.
  - The alphabet is `A–Z a–z 0–9 - _`, so a key never holds the `cc`
    separators `~ * !` or anything to escape.
  - Measured with the code: a four-corner lot is 28 characters. 200 corners
    on a circle of 0.01° radius (about 1 km) are 1,009, and of 1° radius
    1,524. At most five bytes a value keep any 200-corner key below 2,700
    characters.
  - On a reload the ring is decoded from the key, with nothing to fetch.
- The source keys the list accepts are one exported list,
  `CUTOUT_SOURCE_PATTERNS` in `src/data/customCutouts.js`: `osm:`, `pack:`
  and `draw:`. A new source adds one line there.
- A reload restores the list and turns the layer on, then fetches the rings
  again (from the proxy's cache). The list holds at most 12 cutouts.
- **Credit:** while cutouts are drawn, the on-screen "© OpenStreetMap"
  credit shows, and the Data attribution popover lists the boundaries as
  OpenStreetMap's (ODbL), through the local Overpass.

**Not verified in a browser.** The checks here are unit tests:
- the model (`src/data/customCutouts.test.mjs`);
- the clipping against a tileset stub
  (`src/layers/customCutouts/clipping.test.mjs`);
- the layer, through the acceptance steps against stubs
  (`src/layers/customCutouts/layer.test.mjs`);
- the plate in the controller (`src/maps/controllerPlate.test.mjs`);
- the panel's words (`src/ui/customCutoutsPanel.test.mjs`);
- drawing: the state machine, the scene input against stubbed picks, and
  the camera, clicks, keys and pointer given back on every way out
  (`src/layers/customCutouts/draw.test.mjs`).

The real Overpass answers above were parsed by the same code. The puppeteer
harness needs the dev server, which is not run from a worktree here.

## Wikipedia (REFERENCE)

**Wikipedia** (`wikipedia-coverage`, the id it always had, so share links
and the Lego mode keep working) sits in the **REFERENCE** group after
Localities. It shows where English Wikipedia has written about the Earth
in two ways, switched with the row's chips and kept as
`gev.wikipedia.mode`:

| Chip                   | What it shows                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Articles** (default) | one dot per geotagged article, coloured by its type, titles for the nearest ones close in, a card on click (below)                                                                         |
| **Density per km²**    | primary geotagged articles under the pixel, divided by the cells' area (per km², with each row's spherical cell area, so a 60° N cell counts half an equatorial one)                       |
| **Text per km²**       | bytes of the articles' wikitext per km²: article _size_, not words, and only when the build included the page table (below); otherwise the chip is greyed and choosing it says what to run |
| **Per 100k people**    | articles per 100,000 people (GHSL 2020), clear where fewer than 100 people live                                                                                                            |
| **Text per person**    | wikitext bytes per person, likewise                                                                                                                                                        |

The four coverage modes are heat rasters (or H3 hexagons, the Hexes chip),
in the spirit of the Oxford Internet Institute's maps of the uneven
geographies of Wikipedia and of Earth Engine's catalog rasters. Every
article with a primary coordinate (Wikimedia's GeoData extension,
`geo_tags`) is counted into a 0.05° cell (about 5.5 km at the equator,
7200 × 3600 cells), and the cells are coloured on a logarithmic
inferno-like ramp: transparent where there is nothing, a dark half-seen
plum at the ramp's floor, pale yellow at its ceiling. The floor and
ceiling are the 5th and 99.5th percentiles of the non-empty cells, so the
ramp spans what is there rather than the few densest blocks of Manhattan.
The raw count (`count`) is no longer a chip; the grid, the hexagons and
the Lego mode still carry it.

The legend is the type classes (Articles) or the ramp in five swatches,
labelled with the variant's floor and ceiling (the last marked `+`); the
opacity slider (rasters only) is kept in this browser as
`gev.wikipediaCoverage.opacity`; the status line names the dump date and
the article count. The layer is off by default and voice cannot control
it. Raster tiles go no deeper than z 9, where a cell is an 18-pixel
square; Cesium upsamples below that. Like the Earth Engine overlays the
rasters drape through `maps/imageryHost.js` (the globe, or a photoreal
tileset's own imagery layers), and cover only a view-sized rectangle on a
tileset (the Earth Engine layer's rectangle and rebuild rule, imported
from it).

Attribution: "Wikipedia, CC BY-SA 4.0 — Wikimedia GeoData", in the credit
line and the data-attribution popover. The counts are facts about
Wikipedia, not its text; the dump's licence is Wikipedia's. A card's
summary is Wikipedia's text (CC BY-SA 4.0), shown with the article's
title and a link to it.

### Articles: one dot per article

The Articles mode is what [wikimap.wiki](https://wikimap.wiki/) does: every
geotagged article as a dot. Dots are coloured by GeoData's `gt_type` in
four classes, which also rank them:

| Class     | `gt_type`                                         | Colour    |
| --------- | ------------------------------------------------- | --------- |
| Places    | city, adm1st, adm2nd, adm3rd, country, state      | `#ffd166` |
| Landmarks | landmark, edu, railwaystation, airport, event     | `#ef476f` |
| Nature    | mountain, river, waterbody, isle, glacier, forest | `#06d6a0` |
| Other     | everything else, and the 712,054 untyped          | `#8ecae6` |

Within a class, articles rank by article bytes, the better proxy for
notability, and then by `gt_dim` (GeoData's object size, often a
template's default). Articles about a list, a history, a period, a
battle or a polity count as "other" whatever GeoData types them (titles
like "List of …", "History of …", "Battle of …", "… dynasty", "… Empire",
"… Uprising", or a numbered republic such as the French Third Republic;
`NOT_A_PLACE_TITLE` in `src/data/wikipediaPoints.js`): GeoData types many
of them country or state with a country's dim, and the first build
(ranked by dim) put "Preclassic period in Belize" and "List of highest
U.S. county high points" among the world's top places. From
afar each tile keeps only its best ranked (24 a tile below z 12), so a
world or continent view is a sparse splatter of the most notable places;
from z 12 (about 10 km up) every article is there. The answer holds at
most 4,000 dots; past that, the best ranked. Below 40 km the nearest 30 of
the view's dots get their titles through the overlay host (variant
`label`, so the panel's Titles toggle hides them). A click opens a card:
the title, its class and type, Wikipedia's description and extract, the
article's size, its Wikidata item, the coordinates and the dump's date;
the card's thumbnail beside it. The summary (and thumbnail) comes from
`https://en.wikipedia.org/api/rest_v1/page/summary/<title>` through the
local server, which names itself with the build's User-Agent and keeps
each answer a day; the browser asks only on click, once a session per
title, and nothing is prefetched. A click on the card opens
`https://en.wikipedia.org/?curid=<page id>` (the page id, since a title
can be renamed).

**Primary and secondary coordinates.** GeoData gives an article at most
one _primary_ coordinate (where the article's subject is) and any number
of _secondary_ ones (places it mentions: a river's mouth, a battle's
positions, a route's stops). The dump of 2026-10-08 has 1,259,442 primary
and 1,541,250 secondary Earth coordinates. The dots are the primary ones;
`--secondary` adds the secondary ones as a lower class of their own,
ranked below every primary one (so they never crowd a world view), drawn
smaller and grey, and shown only when the row's **Secondary** chip is on
(`gev.wikipedia.secondary`, off by default).

**Compared with wikimap.wiki**: the same idea (a dot an article, the
notable ones from afar) on the app's own globe, built offline from the
dumps and served from the local disk, with no tile server or API of its
own; classes and ranking from GeoData's own type and size rather than
page views; the coverage rasters beside it.

**Building the points**: `npm run wikipedia:build -- --points
[--secondary]` (`scripts/wikipedia/points.mjs`), after the grid's steps:

1. `geo_tags` (already on disk): every Earth coordinate with its page id,
   `gt_type` and `gt_dim`; a second primary coordinate for a page is
   dropped as GeoData's duplicate.
2. The page table, streamed as `--text` does (once, never kept; one pass
   serves both), or read from a downloaded copy with `--page-file FILE`:
   each geotagged article's title and size; namespace 0 only, redirects
   dropped. With `--offline` and `--page-file` the build asks nothing of
   the network: `geo_tags` and `page_props` must already be in the raw
   directory.
3. `enwiki-latest-page_props.sql.gz` (484 MB, kept beside `geo_tags` with
   its ETag): each article's Wikidata item (`pp_propname =
'wikibase_item'`). The item is the key other wikis' articles will be
   unioned by.
4. The index under `points/` (`server/providers/wikipediaCoverage/
pointsFile.js`): blocks of a tile's articles in rank order, 28 bytes an
   article (position on the 2^28 grid, page id, item number, bytes, dim,
   class, flags, wiki) and its "title\0type", one block per tile and zoom:
   zooms 0–6 in one overview file, 7–12 in one bucket file per z 6 tile
   (the Overture buildings' bucket format), a manifest and `current.json`.
   `wikipedia:status` says what is built. `--points-only` rebuilds the
   points alone (the three dump passes, about 15 minutes), leaving
   `grid.bin` and `h3.bin` as they are.

`GET /api/wikipedia-coverage/points?west=&south=&east=&north=&zoom=[&secondary=1]`
answers the tiles the box meets at the zoom (stepping up a zoom past 1,024
tiles), in the shared tile pool's worker; `GET
/api/wikipedia-coverage/summary?title=` is the card's summary. Not yet
built on this machine: the page_props download waits for a go-ahead, and
the sizes and the build time are reported with the first run.

### Wikipedia: more languages

`--wikis enwiki,dewiki,frwiki,…` builds the Articles mode from several
wikis at once. Each wiki's articles are unioned by their Wikidata item,
so an article is never counted twice.

- **The dumps.** Each wiki's three dumps sit under
  `GEV_RAW_DIR/wikipedia/raw/<wiki>/`
  (`<wiki>-latest-{geo_tags,page,page_props}.sql.gz`, each with its
  `.meta.json`), joined as enwiki's are. A build fetches a missing or
  changed one once, single stream, and keeps it, so a rebuild only asks
  whether it changed. `--offline` refuses a missing one by name and URL.
  enwiki's dumps stay where the grid's build has always kept them, in
  `raw/` itself (`raw/enwiki/` is read instead when it holds them).
- **One dot an item.** enwiki's article is the one kept for an item it
  has: its coordinates, title, type, class and size. For an item enwiki
  lacks, the article from the first wiki listed that has one is kept, with
  its title in its own language. Another wiki's article on a kept item
  adds no dot. An article without an item is its own wiki's dot.
- **The languages.** Each record carries the mask of the wikis with an
  article on its item (`wikis`, bit code − 1, in format 3's 32-byte
  record). A langs file (`points/langs.<stamp>.bin`, sorted by item) keeps
  each such item's page id and size per wiki, searched on disk.
  `GET /api/wikipedia-coverage/langs?qid=Q90` answers
  `[{wiki, lang, page, bytes, url}]`.
- **The card.** It lists the languages ("Wikipedia in en · de · fr"). A
  click opens the article in the viewer's language when that Wikipedia
  has it, else the kept article. Its summary comes from that article's
  own wiki (`/summary?title=…&wiki=dewiki`).
- **Ranking.** Thinning ranks as before: primary first, then the type
  class, then the kept article's size. Within a class an article in
  several languages ranks higher: `log2(bytes) + log2(wikis)`, so one in
  eight languages ranks as if eight times its size (`WIKI_BOOST`). One
  wiki adds nothing.
- **Status.** `npm run wikipedia:status` lists the wikis, how many of each
  wiki's articles were kept as dots, and how many items more than one
  wiki has.

The ten wikis besides enwiki, with their sizes, measured 2026-10-22 by
HEAD requests to dumps.wikimedia.org (the dumps of 2026-10-01). They come
to 140 MB of `geo_tags`, 2.69 GB of `page` and 658 MB of `page_props`:
3.49 GB, kept on E: under `wikipedia/raw/<wiki>/`.

| Wiki   | geo_tags | page     | page_props | All      |
| ------ | -------- | -------- | ---------- | -------- |
| dewiki | 61.4 MB  | 320.9 MB | 105.4 MB   | 487.7 MB |
| frwiki | 10.4 MB  | 486.0 MB | 104.2 MB   | 600.6 MB |
| eswiki | 11.6 MB  | 302.5 MB | 61.3 MB    | 375.4 MB |
| ruwiki | 12.6 MB  | 315.0 MB | 64.0 MB    | 391.6 MB |
| jawiki | 6.1 MB   | 172.7 MB | 60.3 MB    | 239.1 MB |
| zhwiki | 9.2 MB   | 286.1 MB | 54.0 MB    | 349.3 MB |
| itwiki | 10.2 MB  | 297.0 MB | 62.3 MB    | 369.5 MB |
| ptwiki | 6.7 MB   | 209.9 MB | 42.1 MB    | 258.7 MB |
| plwiki | 8.3 MB   | 147.1 MB | 47.9 MB    | 203.3 MB |
| nlwiki | 3.8 MB   | 154.3 MB | 56.3 MB    | 214.4 MB |

```bash
npm run wikipedia:build -- --points --points-only --wikis enwiki,dewiki,frwiki,eswiki,ruwiki,jawiki,zhwiki,itwiki,ptwiki,plwiki,nlwiki
```

**The memory budget.** The build must fit Node's default heap (about
4 GB) and leaves `--max-old-space-size` alone: while the Overpass import
runs this 16 GB machine has about 1 GB free. The first eleven-wiki build
ran out of heap at 4,014 MB while reading frwiki's page table. Two things
filled it:

- **Kept slices.** A value the dump parser hands out is a slice of the
  text it was reading, and V8 keeps all of that text alive while any slice
  of it is kept. Each title and GeoData type the join held kept a stretch
  of the dump with it, so the heap grew with every row read, not every
  article kept. dewiki alone ran out at 1,536 MB after 5 of its 8 million
  page rows.
- **An object a coordinate.** Each coordinate was an object in a list in
  a Map, then again an object in the join and a copy in the union, and
  enwiki's maps stayed alive through every later wiki.

Now coordinates and records are columns of typed arrays, and titles are
UTF-8 bytes in one pool; types are interned as fresh strings
(`scripts/wikipedia/pointStore.mjs`). Each wiki is folded into one union
as soon as its three dumps are read, and its columns go before the next
wiki is read; enwiki's go too. The writer ranks record indexes and writes
bucket by bucket, making objects only while a block is encoded. The files
are the same, byte for byte. That was checked against the previous code
on dewiki + frwiki (1,002,947 points, 2,186 buckets) and on synthetic
dumps of three wikis with and without secondary coordinates. The build
logs the heap after each wiki.

Measured offline on the 2026-10 dumps with the heap capped at 1,536 MB:

| Wikis                  | Peak heap before                        | Peak heap now | Time  |
| ---------------------- | --------------------------------------- | ------------- | ----- |
| dewiki                 | over 1,536 MB (ran out)                 | 101 MB        | 101 s |
| dewiki, frwiki         | 600 MB (with slices fixed)              | 118 MB        | 247 s |
| enwiki, dewiki, frwiki | over 4 GB (11 wikis, ran out at frwiki) | 197 MB        | 707 s |

The three-wiki peaks: enwiki 133 MB (its 61 million page rows at
117 MB), dewiki 197 MB, frwiki 144 MB. Columns live outside the V8 heap;
the process's resident memory stayed under 500 MB. The union adds about
60 bytes a record kept, plus its title.

**Restarts.** A points build that a restart stopped resumes; it does not
read every dump again. Each wiki's articles, once its three dumps are
joined, are kept as a checkpoint
(`<build dir>/points-checkpoints/<wiki>.<key>.bin`,
`scripts/wikipedia/checkpoints.mjs`). The key is the wiki's three dumps'
Last-Modified and ETag, the points format, and whether secondary
coordinates are kept.

- A rerun with the same dumps reads a wiki's checkpoint in a second or two
  instead of its dumps. enwiki's page table alone is 2.3 GB compressed.
  The union is rebuilt from the checkpoints in order, and the index comes
  out byte for byte as a fresh build's.
- A checkpoint holds only its own wiki's articles, not what the union
  made of them. A changed dump, or another list of wikis, costs only the
  wikis whose dumps changed.
- enwiki's page_props is fetched before its page table: its key needs all
  three dumps before anything is read.
- Checkpoints sit beside `points/`, not in it, because the index's files
  come and go with every build. Each is written whole, synced, then
  renamed into place, so one that is there is complete; a torn one is
  ignored. A wiki's new checkpoint replaces its old one.
- `--force` reads every dump again and writes the checkpoints afresh.
  `npm run wikipedia:status` lists the wikis checkpointed, with their
  dump dates and sizes.

Measured on dewiki and frwiki (offline, 2026-10 dumps):

| Run                             | Time  | Index                         |
| ------------------------------- | ----- | ----------------------------- |
| Fresh (writes both checkpoints) | 231 s | the heap fix's, byte for byte |
| Stopped during frwiki, rerun    | 145 s | the same, byte for byte       |
| Both checkpointed, rerun        | 50 s  | the same, byte for byte       |

The checkpoints are 44 MB (dewiki) and 41 MB (frwiki); the 50 s is
nearly all the index's write. With enwiki (from `--page-file`): fresh
765 s, rerun from the three checkpoints 74 s (enwiki's is 88 MB), the
index byte for byte the same.

The index switches over atomically, as it always did, and now also
durably. Each file of a new build has its own stamp, is written to a
temporary file, synced, then renamed. `current.json` moves to the new
manifest last, in one rename. The earlier index's files go only after
that. A build stopped at any point leaves the earlier index current and
whole for the server, and the next build clears what it left.

The other way, Wikidata's coordinates (P625) for every item with a
sitelink, would be one source for every language. But the Wikidata JSON
dump is 156.6 GB compressed (the "truthy" N-Triples 71.7 GB), most of a
day to stream, and an item's coordinate is not always the one its
articles carry.

### The coverage rasters: building and serving

**Building the grid** (`scripts/wikipedia/`). Nothing is fetched at request
time: the server reads a grid you build.

```
npm run wikipedia:build            # articles per km² and counts (about a minute)
npm run wikipedia:build -- --text  # also article sizes: streams the 2 GB page table once
npm run wikipedia:build -- --points [--secondary]  # the Articles dots (above)
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

### Per capita

Two more chips: **Per 100k people** (`capita`, articles per 100,000
people) and **Text per person** (`textcapita`, wikitext bytes per person).
The people are GHSL's 2020 residents (P2023A), the same as the Population
layer's 2020 chip.

**The join is made once, at build time, so a tile is a local divide.**
`npm run wikipedia:build -- --population` (`scripts/wikipedia/
population.mjs`):

- fetches the Population layer's 2020 density (people per km², without the
  map's log ramp or its 1 per km² floor) onto the grid's 0.05° base;
- does it with Earth Engine's `image:computePixels`, in tiles of 512 × 512
  cells: 120 requests for the world, each counted against the day's Earth
  Engine budget as a tile;
- multiplies each cell's density by its area: people per cell;
- keeps each tile as it arrives (`population-parts/`, removed once
  `population.bin` is written), so a stopped run repeats nothing;
- writes `population.bin` (every pyramid level, summed in Float64 and kept
  as Float32), then `capita.bin`.

Earth Engine reads the pyramid level nearest 0.05°. GHSL's pyramid is
MEAN, so a cell's density is the mean of the 100 m pixels under it. It
needs `EARTH_ENGINE_KEY_FILE` and `EARTH_ENGINE_PROJECT`, from `.env`
under `--env-root` (default the repository).

`capita.bin` holds what depends on both the people and the dump:

- the grid's per-capita ramp domains;
- the people of every hexagon in `h3.bin`, in its tables' order.

Every `wikipedia:build` that finds `population.bin` writes it again, so the
monthly dump refresh keeps it current. Its header names the `builtAt` of
the grid and of the hexagons it was made for. The server refuses a
per-capita answer (503) from a `capita.bin` made for another build.

Built 2026-10-20: 120 requests in 129 s; 7.794 billion people (GHSL's own
2020 total is about 7.8 billion); `population.bin` 138.1 MB, `capita.bin`
5.6 MB (written in 16.7 s). The Wikipedia directory grows from 320.6 MB
(grid and hexagons) to 464.3 MB.

**The floor.** A pixel or a hexagon with fewer than 100 people
(`PEOPLE_FLOOR`) has no per-capita value and is drawn clear: otherwise a
lighthouse with one resident, or a research station, would top the ramp.
The floor applies to the people summed under the pixel (or in the
hexagon), the same cells whose articles are summed, so it never divides
one cell's articles by another's people.

**Tiles.** `capitaTileValues` in `grid.js` sums, for each pixel, the
articles (or bytes) and the people of the same grid cells at the level the
zoom reads. The value is articles ÷ people × 100,000, or bytes ÷ people.
The articles, text and count tiles go through the old path untouched.
Byte-checked on 2026-10-20 against local-fixes `198671f8` on the real grid:
18 tiles and 9 hexagon answers of the old variants are identical; only the
catalog changes (two more variants, a `population` summary, and GHSL in
the attribution once the population is built).

**Hexagons.** Resolutions 0 to 5 (about 250 km² and up, several base
cells each) sum the people of the base cells whose centres they hold:
each populated cell's resolution-5 hexagon, then its parents. Resolutions
6 and 7 (36 km² and 5 km², finer than a 31 km² base cell) take the
density of the base cell under their centre, times their own area. The
rollup is Σ articles ÷ Σ people of the same hexagon; hexagons under the
floor are left out.

**The ramp** is the layer's log ramp between the 5th and 99.5th
percentiles of the cells over the floor:

| Variant                  | Floor of the ramp | Median | Ceiling |
| ------------------------ | ----------------- | ------ | ------- |
| Per 100k people (grid)   | 3.7               | 119    | 3,200   |
| Text per person (grid)   | 0.17 B            | 4.7 B  | 269 B   |
| Per 100k people (H3 r 2) | 1.3               | 24     | 20,700  |
| Per 100k people (H3 r 4) | 0.9               | 24     | 6,300   |

Timed on 2026-10-20 (24 tiles a view; the first tile reads the levels it
needs from `population.bin`):

| View                        | Zoom | First tile | Median |
| --------------------------- | ---- | ---------- | ------ |
| Europe, 3,000 km            | z 5  | 164 ms     | 1 ms   |
| India, 3,000 km             | z 6  | 176 ms     | 3 ms   |
| The United States, 2,000 km | z 6  | 150 ms     | 2 ms   |
| London (z 9, the deepest)   | z 9  | 144 ms     | 2 ms   |

Hexagons over Europe answer in 8 ms (resolution 2, 95 cells) and 9 ms
(resolution 4, 3,387 cells).

**What it shows.** Western and northern Europe read high (hundreds of
articles per 100,000), cities darker than the country around them: more
residents for each article. India and the Gangetic plain read low (a few
per 100,000), the Himalaya and its hill stations higher. In the United
States the Midwest and the East are dense with small towns that each have
an article, so they read high. The West's settlements read high too, as
scattered dots between empty land under the floor.

**Caveats.**

- The people are GHSL's 2020 residents; the articles are today's
  Wikipedia. Five years of growth (and of articles) are not matched.
- GHSL counts where people live, not where they work or visit. A business
  district, an airport or a national park full of articles and with few
  residents reads very high.
- English Wikipedia's geotags, so the layer measures English coverage per
  person, not the world's knowledge.
- A 0.05° cell is 5.5 km. Close in, the layer stops at z 9 and Cesium
  stretches its cells.

Tests: `server/providers/wikipediaCoveragePerCapita.test.mjs`:

- the floor and the values;
- people summed up the pyramid;
- tiles at z 9 and z 2 over a tiny fixture: a cell over the floor, one
  under it, one with no articles;
- the hexagons' people at resolutions 7 and 2;
- a stale `capita.bin` refused;
- the Earth Engine step against a mock: 120 tiles, density × area,
  resumed with nothing fetched twice.

The existing tests now list the two chips.

## Rivers: HydroSHEDS v2 for the Americas

**What it does.** Over North, Central and South America the Rivers layer
can draw HydroSHEDS v2's river network instead of HydroRIVERS v1 (Earth
Engine's `WWF/HydroSHEDS/v1/FreeFlowingRivers`, which it keeps for the
rest of the world). v2 is traced from 12 m TanDEM-X elevation on a
1 arc-second grid (about 30 m): 21.0 million reaches, 35.4 million km, every
stream with at least 1 km² upstream. The app's own server draws it into
transparent 256 × 256 PNG tiles, z 0 to 14, in the layer's two inks, and
keeps them on disk; nothing is fetched at request time. This section is
the data pipeline, the tile route and a client helper; the Rivers layer
uses it for NETWORK while a build is there (see [Rivers](#rivers): Earth
Engine then draws the rest of the world, and v1 where v2 has no data).

**Source, licence, attribution.** HydroSHEDS v2 core data, river network
(RIV), version `v2r0`, released for the Americas in July 2026 (the DLR EOC
Geoservice lists 2026-07-24). v2 is derived from DLR's TanDEM-X elevation
data, conditioned by Confluvio (with flow tools developed with Esri);
HydroSHEDS itself began at WWF. The technical documentation (v2.0.0,
July 2026) was prepared by Bernhard Lehner for Confluvio. Licence: **CC BY 4.0** for scientific, educational and
commercial use (https://creativecommons.org/licenses/by/4.0/); the authors
also ask that the data not be redistributed whole in its original format
on other websites without their permission, which this fork does not do
(it serves only tiles drawn from it, to its own browser). Cite, as the
documentation asks until a v2 paper is out: Lehner, B., Roth, A., Huber,
M., Anand, M., Thieme, M. (2022). A sharper look at the world's rivers and
catchments. _Eos_, 103, https://doi.org/10.1029/2022EO220167, and link
https://www.hydrosheds.org. The tile route's credit line is "HydroSHEDS v2
(Lehner et al. 2022; WWF, DLR, Confluvio), CC BY 4.0"; the layer should
carry it in its credit and the data-attribution popover.

**The files.** From the v2 core-data downloads page
(https://www.hydrosheds.org/downloads-core-data-v2, whose region table is
`https://data.hydrosheds.org/file/hydrosheds-v2/download-index.json`),
the river network comes per continent as a zipped Esri File Geodatabase or
an OGC GeoPackage:

| File                                                    | Bytes          | Used |
| ------------------------------------------------------- | -------------- | ---- |
| `RIV/1s/north-america_RIV_1s_v2r0.gdb.zip`              | 3,391,450,146  | yes  |
| `RIV/1s/south-america_RIV_1s_v2r0.gdb.zip`              | 1,430,637,101  | yes  |
| `RIV/1s/north-america_RIV_1s_v2r0.gpkg`                 | 18,052,263,936 | no   |
| `RIV/1s/south-america_RIV_1s_v2r0.gpkg`                 | 7,498,641,408  | no   |
| `technical-documentation/HydroSHEDS_TechDoc_v2_0_0.pdf` | 2,485,310      | read |

(all under `https://data.hydrosheds.org/file/hydrosheds-v2/`, the PDF under
`https://data.hydrosheds.org/file/`). The GeoPackages hold the same layer
at five times the size (25.6 GB against 4.8 GB), so the build reads the
geodatabases; it reads a `*_RIV_*.gpkg` too, if one is put in place of a
region's `.gdb.zip`. Each archive holds `<region>_RIV_STREAMS_1s_v2r0`
(the reaches) and `<region>_RIV_NODES_1s_v2r0` (their end points, not
used). The North American one also holds
`north_america_RIV_STREAMS_1s_v2r0_1`, an earlier copy with the same rows
left after a field was dropped (its freed blocks show the old
`StrahlerOrder`/`StrahlerID` field names); the build passes over it.

**What a reach carries** (the geodatabase's fields, checked against the
documentation's Table 1): `STRM_ID`, `STRM_DN` (the next reach downstream,
-1 at the ocean or a sink), `STRM_UP` (the reaches upstream, joined with
`_`), `GRID_CODE`, `MAIN_BAS` (the whole basin's id), `NODE_ID_UP`,
`NODE_ID_DOWN`, `LENGTH_KM` (geodesic), `UP_CELLS` and `UPLAND_SKM` (cells
and km² upstream, at the reach's last pixel), `ORD_STRAH` (Strahler order,
1 to 11; not in the documentation's table) and `Shape_Length`. There is
**no discharge, no v1-style `ORD_FLOW`/`RIV_ORD` and no names**; the
documentation says attributes will come later through HydroRIVERS and
HydroATLAS. Geometry: single-part polylines (2D, though the field is
declared with Z and M), one part each, vertices on the 1″ grid; CRS
geographic WGS 84 (`GCS_WGS_1984`). Counts: North America 11,558,529
reaches (19.8 M km, 375 M vertices), South America 9,432,146 (15.6 M km,
260 M vertices).

**Extent.** West −169.72° (the Aleutians as far as Unalaska and Umnak;
not Atka, Adak or anything past 180°), south −55.96° (Cape Horn), east
−32.41° (Brazil's Atlantic islands), north 83.13° (Ellesmere Island).
Covered (checked for reaches in the built cells): the whole Canadian
Arctic Archipelago, every Caribbean island checked (the Bahamas, Cuba,
Hispaniola, Puerto Rico, Guadeloupe, Dominica, Martinique, Barbados,
Trinidad, Aruba, Curaçao, Bonaire; South America's file reaches 14.88° N,
North America's comes down to Panama at 7.21° N, and they overlap),
Bermuda, the Galápagos, Cocos, the Revillagigedos, Clipperton, Juan
Fernández, Fernando de Noronha, the Falklands and South Georgia. **Not covered: Greenland** (North America's
file stops at Newfoundland, 52.6° W; HydroSHEDS lists Greenland as a region
of its own, not yet released), **Hawaii**, the western Aleutians and
Easter Island. So a Rivers layer that leaves out HydroRIVERS v1's Americas
must keep v1 there.

**Level of detail.** Lines: thin by size, simplify per band. A reach's
v1-equivalent order comes from its upstream area. v1's order is a decade of
long-term discharge (1 over 100,000 m³/s, 2 from 10,000, … 6 from 1 to 10,
7 from 0.1 to 1); at the world's mean runoff, about 0.01 m³/s per km²
(315 mm a year), a discharge decade is an area decade, so **order k ⇔ at
least 10^(8−k) km² upstream** (`orderForUpland` in
`server/providers/riversV2/bands.js`). Wet basins (the Orinoco) come out a
step smaller than by discharge, dry ones (the Colorado) a step bigger; no
American river reaches order 1 (the Amazon's 5.95 M km² is order 2).

| Zooms   | Orders drawn | Upstream area | Simplified for | Cells at | Reaches | Level file |
| ------- | ------------ | ------------- | -------------- | -------- | ------- | ---------- |
| 0 – 4   | ≤ 3          | ≥ 100,000 km² | z 4            | z 2      | 62 k    | 0.1 MB     |
| 5 – 6   | ≤ 4          | ≥ 10,000 km²  | z 6            | z 5      | 276 k   | 1.1 MB     |
| 7       | ≤ 5          | ≥ 1,000 km²   | z 7            | z 7      | 908 k   | 4.6 MB     |
| 8       | ≤ 6          | ≥ 100 km²     | z 8            | z 8      | 2.67 M  | 16.6 MB    |
| 9 – 10  | ≤ 7          | ≥ 10 km²      | z 10           | z 9      | 7.37 M  | 90.8 MB    |
| 11 – 14 | ≤ 8 (all)    | ≥ 1 km²       | z 12           | z 11     | 21.0 M  | 684 MB     |

Since 2026-10-19 these are the Rivers layer's v1 bands at the zooms Cesium
drapes at their heights (`riverZoomForHeight`; the table in [Rivers](#rivers)),
so both sides of the Americas' edge draw the same orders. Before, they were
z 0–2 ≤ 3, z 3–4 ≤ 4, z 5–6 ≤ 5, z 7–8 ≤ 6, z 9–10 ≤ 7 and z 11–14 all, which
kept the gap between drawn rivers at roughly 5 to 15 pixels (a basin of
10^n km² is about √10^n km across) and drew an order more than v1 at most
heights.

Reaches by order: 2: 6,512; 3: 55,915; 4: 213,250; 5: 632,582; 6: 1.76 M;
7: 4.70 M; 8: 13.6 M. Within a band each reach is projected to Web Mercator, simplified
(Douglas–Peucker, half a pixel at the "simplified for" zoom; for the last
band 19 m at the equator, under the 30 m grid, which smooths the 1″ stair
steps), and quantized to a quarter pixel at the band's deepest zoom. Line
width grows with size: the smallest order a zoom draws is 0.75 px, each
order bigger adds 0.55 px, up to 4 px (`widthFor`, which calls the Rivers
layer's `riverLineWidth`: the Earth Engine v1 tiles use the same rule);
under a pixel a line is drawn fainter rather than thinner. Lines are
antialiased capsules, max-composited (crossings and joints do not darken),
in the Rivers layer's inks (`RIVER_INKS`, imported): light `ffffffcc`, dark
`1a1a1acc` (AUTO is resolved by the layer).
The bands are one table (`BANDS`); a change there is a new tile version
and a rebuild.

**Building** (`scripts/rivers/`). Personal-fork tooling, no new
dependencies: a ZIP64 reader that streams an entry straight out of the
archive (`zip.mjs`), a File Geodatabase table reader written from GDAL's
open format notes (`fileGdb.mjs`: field list, null bitmaps, the
varint-packed polylines, the `.gdbtablx` row index), and a GeoPackage
reader on Node's built-in `node:sqlite` with its own WKB decoder
(`geopackage.mjs`). PNGs are encoded with `zlib`; no canvas library.

```
npm run rivers:fetch    # the two .gdb.zip files (4.8 GB), skipped when present at their size
npm run rivers:build    # 21 M reaches → the level files (about 6 minutes)
npm run rivers:status   # inputs, build, levels, tile cache
```

`build` reads each region's stream table once, in file order, at the
offsets its `.gdbtablx` names (an edited table's freed blocks do not chain),
checks the row count against the header, and writes each band's pieces to
row-stripe partition files, then sorts every stripe by cell into one level
file per band: `'GEVRIV2\n'`, the cells (each raw deflate of its pieces:
order, point count, zigzag varint deltas from the cell's corner), the index
(Float64 start, Uint32 key, Uint32 length per cell), a JSON header and a
footer. A reach crossing cells is cut at them; each cell also takes in the
lines within half the widest line and a pixel of it (at the band's
shallowest zoom), so a tile reads only the cells under it. An unchanged
input is skipped (`--force` rebuilds; `--limit N` builds from the first N
reaches of each region, never counted as up to date). `manifest.json` names
the level files (in `levels-<stamp>/`), the build id, the sources, the
extent and the timings; older levels and all tiles go when a build lands.

Rebuilt on 2026-10-19 for the aligned bands (into the main checkout's
cache with `RIVERS_CACHE_DIR`): 318 s in all (North America read 154 s,
South America 100 s, writing the levels 64 s), build `d7ccfc67a4e187a6`,
tile versions light `5d040e0b91d8`, dark `818bc602933d`, levels 797.0 MB.

Measured on 2026-10-18 (this machine, Node 24.21): reading and cutting
6 min 34 s in all (North America 186 s, South America 123 s, writing the
levels 84 s); a read-only pass over both tables is 111 s. Disk: the
downloads 4.5 GB in `raw/`, the build 797 MB in `v2/`.

Everything lives in `RIVERS_CACHE_DIR` (default `.gev-cache/rivers`): `raw/`
(each download in its own folder: `north-america-riv-gdb/`,
`south-america-riv-gdb/`, `techdoc/`), `v2/` (the build, `runs.jsonl` and
the server's `tiles/`). A worktree points it at the main checkout's
(`RIVERS_CACHE_DIR=C:\Users\nospa\Desktop\godseye\.gev-cache\rivers`, or
`--dir` for the scripts) so the 5 GB is not copied. None of it is
committed; the tests build tiny synthetic geodatabases, ZIPs and
GeoPackages in a temporary folder.

**On demand, not a pyramid.** A tile costs 2 to 25 ms to draw (45 to 85 ms
at worst: a z 3 or z 5 tile over the Amazon reads 190,000 to 540,000
points), 2 to 9 ms to encode, then a few ms from disk. A prebuilt pyramid
to z 14 over the Americas would be tens of millions of tiles, so tiles are
drawn when first asked for and kept.

**Serving** (`server/providers/riversV2.js`, same-site, GET only):

- `GET /api/rivers/v2/layers`: `configured` (else the message "Run npm run
  rivers:build to build the HydroSHEDS v2 rivers"), `builtAt`, `buildId`,
  the regions and reach count, the extent, the tile template
  `/api/rivers/v2/tile/{ink}/{z}/{x}/{y}`, `inks` (`light`, `dark`) with
  `versions` (each ink's tile version), the zoom bands, `minZoom` 0,
  `maxZoom` 14, the attribution and the licence.
- `GET /api/rivers/v2/tile/<ink>/<z>/<x>/<y>[?v=<version>]`: a PNG (gray +
  alpha, both inks being grays). 404 for another ink, 400 past z 14 or off
  the grid, 503 before a build, 403 cross-site, 405 for anything but GET.
  Outside the build's extent the answer is a shared 206-byte transparent
  PNG after a box test (well under a millisecond); a tile in the extent
  with no river is the same PNG, not stored.

A tile version is the hash of the style (renderer version, ink, band
table, widths) and the build id (`tileVersion`). Tiles are kept under
`v2/tiles/<ink>/<version>/<z>/<x>/<y>.png` and the client puts the version
in the URL as `?v=`, so neither a style change nor a rebuild serves an old
tile; a URL naming another version than the current one is answered
`Cache-Control: no-store`, the rest `private, max-age=86400`. The manifest
is stat'ed at most every 5 s, so a rebuild lands without a restart.

**Client helper** (`src/layers/riversV2/source.js`, imports no Cesium):
`createRiversV2Source().status()` (the `/layers` answer, checked, kept
5 minutes; a failure reads as not ready), `riversV2Ready(status, ink)`,
`riversV2TileTemplate(ink, version)` and `riversV2ImageryOptions(status,
ink)`, the options for `new UrlTemplateImageryProvider(...)` (`url`,
`minimumLevel`, `maximumLevel`, 256 px tiles, `hasAlphaChannel`, `credit`)
plus `rectangleDegrees`, the extent to pass as `rectangle:
Rectangle.fromDegrees(...)`, or null when the build is not ready.

**Checklist** (from [Level of detail](#level-of-detail)):

- [x] How its detail follows the camera: level switching by size class
      (order bands from upstream area), each band simplified for its own
      zooms; the module header and this section say so.
- [x] It draws from orbit: z 0 shows the rivers of 100,000 km² and more;
      no `maxHeightM`.
- [x] Coarsest tiles timed: z 0 16 ms, z 1 9 ms, z 2 5 ms to draw; the
      source is the local level files and every tile is cached on disk.
- [ ] (Boundary tables only: not applicable.)

## Rivers: click a reach

With the Rivers layer on, a click on the map finds the river reach nearest
it and draws three things on the ground. The clicked reach is thick amber.
The path its water takes to the sea, or to an inland sink, is a cyan line.
The network above it is thin pale dashes, thinner for smaller rivers. The
reach and the path sit on a dark casing, so they read on light and dark
maps, and the three differ by width and pattern as well as colour. They are
`GroundPolylinePrimitive`s with classification BOTH, so they lie on terrain
and on the photoreal tiles alike, as the Grid draws; without depth textures
they are drawn at sea level. A card at the reach, published through the
world-overlay host (no Cesium labels), gives:

- the river's name and basin, with the country (an unnamed creek is called
  a tributary of the first named river below it);
- its size, in plain words from `RIV_ORD`, and its average flow;
- its Free-Flowing Rivers status (`CSI_FF2`: free-flowing, good
  connectivity or impacted) with the connectivity index;
- the pressure that lowers that index most (`CSI_D`: dams fragmenting it,
  reservoirs regulating its flow, sediment trapped, water withdrawn, roads
  or towns);
- the distance from the click to the mouth along the path.

A label marks the path's end ("Mouth" or "Inland sink"). Escape, another
click, a click on the sky, or turning the layer off clears it all. A miss
says "No river here" for 3 seconds.

**Data.** HydroRIVERS v1 with the Free-Flowing Rivers attributes (Grill et
al. 2019, _Nature_ 569: 215), Earth Engine table
`WWF/HydroSHEDS/v1/FreeFlowingRivers`, with the same service account as the
Earth Engine layers (see above). Each reach has `NOID`, its downstream
neighbour `NDOID` (0 at a terminal reach) and its backbone `BB_ID`: a
backbone is one contiguous flow path, from a source to where it joins a
bigger river or ends. `BB_OCEAN` is 1 when the backbone reaches the ocean.
HydroSHEDS counts the Caspian as ocean, so the Volga ends "to the sea";
the Okavango and the Amu Darya end inland.

**The endpoint** (`server/providers/riverReach.js`, registered in
`server/providers/local.js`, same-site, GET only):

```
GET /api/rivers/reach?lat=&lon=&heightM=[&maxOrder=][&upstream=1]
GET /api/rivers/reach/<source>/<id>[?upstream=1]
GET /api/rivers/reach/<source>/<id>/upstream
```

It answers 400 for bad parameters, 404 when no river is within the
tolerance, 429 past the minute's budget, 502 when Earth Engine fails and 503
when Earth Engine is not set up. The tolerance grows with the camera height
(`src/data/riverReach.js`): 0.014 × height, about twelve screen pixels,
never under 100 m nor over 50 km. The size limit (`maxOrder`) shrinks with
height, so a click on a big river seen from far away is not taken by a
creek beside it: every order up to 20 km, ≤ 8 to 80 km, ≤ 7 to 250 km, ≤ 6
to 800 km, ≤ 5 to 2,500 km, ≤ 4 to 8,000 km, then ≤ 3. A layer that draws
fewer orders at some height passes its own `maxOrder`.

**Method: three Earth Engine requests at most, each one `value:compute`.**

1. _The nearest reach._ A `withinDistance` filter (spatially indexed) and
   `RIV_ORD ≤ maxOrder`, each candidate's distance set, sorted, limit 1.
   0.4 to 1.3 s.
2. _The downstream path, in one request however long._ The reaches below
   the clicked one on its backbone are `BB_ID = b and UPLAND_SKM ≥ u`
   (upstream area only grows downstream). The lowest of them has the next
   backbone's entry as its `NDOID`. Sixteen such hops are nested in one
   expression graph, with every node a shared value, so the graph stays
   linear. Hops past the terminal reach are empty and cost almost nothing:
   3, 6, 12 and 20 hops all took 3.4 to 4.2 s from a creek. In use, 1 to
   3.4 s for requests 1 and 2 together.
3. _The upstream network, in one request._ The clicked backbone above the
   reach, then up to 4 levels of tributary backbones, all within 2 orders
   of the clicked one, the 2,500 largest kept by upstream area. A kept
   reach's downstream neighbours are always kept, so the network stays
   connected. The client asks for it after drawing the path. Each level
   costs about 1.1 to 2.5 s: 3 levels took 3.6 s, 6 took 8.5 s and 10 took
   10.2 s, finding 441, 460 and 468 reaches above the Meramec. That is why
   4 is the default.

What was tried and dropped:

- A client-side walk of `NDOID` costs one request per reach, hundreds to
  the Gulf.
- `table:computeFeatures` pages its answer and computes the whole graph
  again for each page. The Danube above Budapest took 24.7 s that way and
  11.1 s through one `value:compute`.
- `Filter.inList` does not match a numeric field against a list over REST.
  `Filter.listContains` with the list on the left does; it is the JS
  client's own `inList`.
- Id lists of tens of thousands are refused as "Filter is too complex". The
  Danube's and the Okavango's networks hit this until each level was cut to
  its 2,500 largest before the next was found. That loses nothing the final
  cut keeps, because a tributary is smaller than the reach it joins.
- `Join.simple` and `Join.inverted` instead of the lists ran past 60 s.

**Measured** on 2026-10-18 through the handler, with a cold cache and live
Earth Engine. "First" is requests 1 and 2; the upstream request is separate.

| Click (camera height)                 | Reach found                                  | Downstream                                               | First                              | Upstream                        |
| ------------------------------------- | -------------------------------------------- | -------------------------------------------------------- | ---------------------------------- | ------------------------------- |
| St. Louis creek, Mississippi (250 km) | unnamed, order 7, 0.13 m³/s, 1.6 km off      | 467 reaches, 1,891 km, 3 backbones (… > Missouri), ocean | 3.4 s, 2 req                       | none (a headwater), 1.5 s       |
| Meramec at Valley Park (100 km)       | Meramec, order 5, 75 m³/s                    | 462 reaches, 1,889 km, Meramec > Missouri, ocean         | 2.5 s, 2 req                       | 454 reaches, 215 lines, 4.0 s   |
| Danube at Budapest (50 km)            | Danube, order 3, 2,311 m³/s, impacted (dams) | 400 reaches, 1,764 km, ocean                             | 1.4 s, 2 req                       | 1,685 reaches, 62 lines, 9.9 s  |
| Madeira at Porto Velho (300 km)       | Madeira, order 2, 19,545 m³/s                | 741 reaches, 2,255 km, Madeira > Amazon, ocean           | 1.0 s, 2 req                       | 2,500 (capped), 26 lines, 9.8 s |
| Okavango at Rundu (50 km)             | Okavango, order 4, free-flowing              | 283 reaches, 1,134 km, inland (the delta)                | 1.6 s, 2 req                       | 1,195 reaches, 49 lines, 12.3 s |
| Amu Darya at Nukus (300 km)           | Amudar'ya, order 3, impacted (reservoirs)    | 54 reaches, 357 km, inland (the Aral)                    | 1.1 s, 2 req                       | 2,500 (capped), 52 lines, 7.9 s |
| Volga at Astrakhan (1,000 km)         | unnamed in the data, order 3, 8,103 m³/s     | 17 reaches, 110 km, ocean (the Caspian)                  | 3 req with upstream, 17.0 s in all | 2,500 (capped), 25 lines        |

The Mississippi path ends at the bird's foot (89.26°W, 29.11°N), the
Danube's at its delta (29.70°E, 45.25°N), the Amazon's off Macapá. The
answers are 8 to 45 KB without the network and 75 to 300 KB with it, the
coordinates rounded to 1e-5°.

**Caching and limits.** Answers are kept on disk by reach id under
`.gev-cache/rivers/reach/` for 180 days: `<id>.json` holds the reach and its
path, and `<id>.upstream.json` its network. The data is static, and a
version number in the file drops older layouts. A click's rounded place and
rule are remembered in memory with the id they found (up to 1,000), so the
same click again asks nothing: 2 to 15 ms. After a restart it is the
nearest-reach request only, 0.4 to 0.8 s. The same lookup asked twice at
once is done once. At most 3 Earth Engine requests run at once and 40 start
in any minute; past that the answer is 429. The client waits 150 ms before
asking, so a double click asks once, and it drops any answer to a click
that a newer one replaced.

**The answer's shape** (`river-reach/1`, documented in
`src/data/riverReach.js`) is one any source can give: `schema`, `source`
`{id, name, attribution}`, `query` (a click's `lat`, `lon`, `heightM`,
`toleranceM` and `maxOrder`), and then:

- `reach`: `id`, `distanceM`, `properties` (`RIV_ORD`, `DIS_AV_CMS`,
  `LENGTH_KM`, `UPLAND_SKM`, `CSI`, `CSI_FF`, `CSI_FF2`, `CSI_D`, `BB_ID`,
  `BB_NAME`, `BB_OCEAN`, `BB_LEN_KM`, `BAS_ID`, `BAS_NAME`, `COUNTRY`,
  `CONTINENT`, `NOID`, `NDOID`, `REACH_ID`) and a GeoJSON `geometry`
  LineString;
- `downstream`: `complete`, `terminal` (`ocean`, `inland` or `unknown`),
  `reaches`, `lengthKm`, `distanceToMouthKm`, `mouth` and `segments`
  `[{backboneId, name, order, lengthKm, coordinates}]`;
- `upstream`: null, or `{reaches, lengthKm, maxOrder, levels, truncated,
lines: [{backboneId, name, order, coordinates}]}`;
- `links`: `{self, upstream}`, then `cached` and `timing {ms, requests}`.

Coordinates run with the flow, from source to mouth.

**HydroSHEDS v2 later.** The handler takes a list of sources and asks the
first whose `covers(lat, lon)` is true. The id routes are named by source
(`/api/rivers/reach/<source>/<id>`), and an answer's `links.upstream` says
where its network is. A self-hosted v2 network for the Americas is one more
object, `{source, covers, atPoint, byId, upstream}`, answering this shape
and put ahead of the v1 service in `riverReachProxy({sources})`. The client
can also point at another server (`attachReachHighlight(…, {endpoint})`),
whose relative links it resolves against that server.

**In the Rivers layer** (`src/layers/earthEngine/riverClicks.js`, made in
`src/app/layers/earthEngine.js`). The layer attaches the highlight and the
click handler when it is turned on and detaches both when it is turned
off; the size limit it passes is the orders it draws at the camera's
height (`riverOrdersAt`: ≤ 3 above 6,675 km, ≤ 4 to 1,666 km, ≤ 5 to
834 km, ≤ 6 to 417 km, ≤ 7 to 104 km, then all), so a click takes a river
that is on screen, not the endpoint's own height rule. The lookup's credit
(`RIVER_REACH_CREDIT`) is registered when the clicks attach.

**Clicks on v2's streams.** Over the Americas, NETWORK draws HydroSHEDS v2,
which has streams v1 lacks (every 1 km² basin against v1's 10 km², traced
from a 30 m grid instead of 460 m), while the lookup is still v1's. A click
on a v2-only stream finds the nearest v1 reach within the click's tolerance
(about twelve pixels of ground), usually the river it flows into, and the
trace drawn is v1's geometry, which can sit a pixel or two off v2's line;
past the tolerance the card says "No river here". The fix is a local v2
source for `riverReachProxy({sources})`, `covers` true inside v2's extent
(outside Greenland), answering from v2's own `STRM_ID` / `STRM_DN` /
`UPLAND_SKM`. It is not cheap with what the build keeps: the level files
hold only each piece's order and coordinates, cut into cells and
simplified per band, with no reach id, so a v2 source needs its own index
(id, downstream id, upstream area and full geometry per reach, plus a
spatial index for the nearest reach) written by `scripts/rivers/build.mjs`
alongside the levels. That is a follow-up; it also has no names (v2 carries
none), so its card would name the river only through v1.

**The client** (`src/layers/rivers/reachHighlight.js`, with the card's words
in `reachCard.js`). `attachReachHighlight({viewer, overlays, cesium,
picking, requestRender}, {endpoint, upstream, debounceMs})` returns
`{select(lat, lon, heightM, {maxOrder}), clear(), detach(), state()}`.
`attachReachClicks({viewer, highlight, picking, isPointerFree, maxOrder})`
routes the viewer's left clicks to it. A click on the map or on the
highlight selects there; a click on another layer's object is left to that
layer; a click on the sky clears; a tool holding the pointer gets the click
first. The highlight's pick ids start with `river-reach:` and are registered
with the pick registry. Strings are translated into Spanish and Russian.

## Rivers: names from OpenStreetMap

HydroSHEDS v2 (the Americas, self-hosted) and HydroRIVERS v1 carry no
river names of their own (v1's Free-Flowing Rivers table has a backbone
name, `BB_NAME`, for some), so `npm run rivers:names` names the reaches
from OpenStreetMap's named waterways (`scripts/rivers/names.mjs`):

1. **Extract**, once (`npm run rivers:names -- --extract --pbf
E:/gev-data/osm/planet-261012.osm.pbf`): osmium in the Overpass image
   (`docker run --rm --entrypoint osmium wiktorn/overpass-api:0.7.62`, the
   PBF mounted read-only) keeps the ways tagged
   `waterway=river|stream|canal|drain|ditch`, then exports them as GeoJSON
   lines, both written one file at a time under
   `GEV_RAW_DIR/rivers/names/` (`waterways.osm.pbf`,
   `waterways.geojsonseq`). The planet PBF (95 GB) is read once.
2. **Group**: each named way's name, `name:en`, `wikidata` and kind;
   ways are grouped by their Wikidata item, else by their name, so a
   river split into many ways counts as one.
3. **Match** each v2 reach (21 M) to the waterway it follows
   (`namesMatch.mjs`): the reach is sampled along its length (at most 24
   samples); each sample counts for the waterways whose nearest segment
   lies within a tolerance by the reach's Strahler order (30 m for orders
   1–2, 100 m for 3–5, 250 m from 6: a large river's centreline can sit a
   channel's width from OSM's) and runs within 45° of the reach (OSM's
   ways are usually digitised downstream, but either way counts). The
   group covering the most of the reach names it when it covers at least
   40%. Both inputs are spilled by 1° cell (the waterways with a 0.1°
   margin) under `GEV_RAW_DIR/rivers/names/tmp`, in long appends from one
   writer, and the cells are matched in worker threads.
4. **Main stems**: a reach without a name of its own takes the name of the
   reach above it of the same Strahler order (the stem goes on; a
   confluence of two equal orders raises the order and ends it), the
   largest such reach where stems meet, walking down until a reach has
   its own name or the order changes. Each name is kept with its source:
   `direct` or `inherited`.
5. **The sidecar** under the rivers cache's `names/`
   (`server/providers/riverNames/namesFile.js`): `names.bin` (the name
   groups), and bucket files of one z 8 tile each with the named lines by
   z 12 tile (the v2 reaches, direct or inherited, and every OSM named
   waterway, for v1's cards anywhere) and a label point per name and z 10
   tile for Strahler 5 and up; the manifest keeps the match rates by
   order.

**What the app does with it**:

- The reach card (`src/layers/rivers/reachCard.js`) is titled by the name
  at the click (`osmName` on the `/api/rivers/reach` answer): a named v2
  reach within 150 m first, else the nearest named OSM waterway within
  150 m (how v1's reaches outside the Americas get a name), in its own
  language with `name:en` in brackets when different; then v1's
  `BB_NAME`, "Tributary of …", the basin, and "Unnamed river" only when
  nothing matched. A line under it says where the name came from
  (OpenStreetMap, carried down the main stem, or the nearest waterway).
- Below 150 km, where Natural Earth's names stop, the Rivers layer labels
  the nearest 12 named rivers of Strahler 5 and up in view
  (`/api/rivers/names/labels`), overlay variant `label`, so the panel's
  Titles toggle hides them like the others.
- `GET /api/rivers/names/nearest?lat=&lon=` answers a point's name too.

Attribution: the names are © OpenStreetMap contributors, under the
[ODbL](https://opendatacommons.org/licenses/odbl/1-0/), beside
HydroSHEDS' (the Rivers layer's credit, and the card's line). The sidecar
is a derived database: not to be published except under the ODbL.

**Status (2026-10-21)**: the matching and inheritance are tested on
synthetic geometry (`src/tooling/riverNames.test.mjs`); the extract and
the real build wait for the local Overpass import to finish (it holds
Docker's memory and E:), so the match rates by order are not measured
yet. They are printed per Strahler order at the end of the build and kept
in the manifest.

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
| Light   | CARTO Positron, Positron (no labels)          | `basemaps.cartocdn.com` (`light_all`, `light_nolabels`), `?key=` from `CARTO_API_KEY` when set                          | 0–20       | © OpenStreetMap contributors © CARTO                                            |
| Dark    | CARTO Dark Matter, Dark Matter (no labels)    | `basemaps.cartocdn.com` (`dark_all`, `dark_nolabels`), `?key=` from `CARTO_API_KEY` when set                            | 0–20       | © OpenStreetMap contributors © CARTO                                            |
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
non-commercial use with attribution, but without a key CARTO watermarks the
tiles "API KEY REQUIRED". Set `CARTO_API_KEY` in `.env` (free at
carto.com/basemaps/apikey, no account, 5M requests a month non-commercial;
keys registered before 2026-09-23 keep working until 2026-11-30) and it is
appended to the four CARTO tile URLs as `?key=`. Without it the styles still
load, watermarked, and the picker notes "CARTO key needed to remove the
watermark". It is client-exposed and injected the same way as Stadia's key,
and is registered as the hidden row `carto-basemaps`.

Stadia Maps serves the Stamen styles to `localhost` without a key; from any other origin set `STADIA_MAPS_API_KEY`
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

## Localities (REFERENCE)

Populated places with their names at every height
(`src/layers/localities/`), under **REFERENCE** beside the Grid: names
are a base reference to read other layers against, not a quantity to
analyse.

**From orbit to regional scale: Natural Earth.** The 7,342 places of
Natural Earth's 10m populated places (public domain), bundled as
`src/data/local_data/natural_earth/populated_places.json` (802 KB, 228 KB
gzipped: names in English, Spanish and Russian, scalerank, Natural Earth's
own label `min_zoom`, largest population, capital class, country, at about
100 m). It is built by `scripts/build-populated-places-pack.mjs` from the
official download (SHA-256 pinned; see the pack README), like the river
names.

_Thinning._ A place is named once the imagery level the camera height
drapes at the middle of the view (the Rivers' `riverZoomForHeight`, a
1,600 px canvas: z 3 from 20,000 km, z 6 from 3,000 km, z 12 from 50 km)
reaches its `min_zoom`, the zoom Natural Earth itself gives it from its
scalerank and population. Within that, national capitals first, then lower
`min_zoom`, scalerank and larger population; at most 180 labels, in the
view window (the H3 window rule; from orbit, the side of the Earth the
camera sees); the overlay's collision solver drops what overlaps, larger
places winning. Measured on the pack: 41 names from orbit (Moscow, not
Baltimore), 180 of the 992 eligible from 3,000 km over Europe (every
capital in view), and the 15 Natural Earth places in the window of a 50 km
view of Baltimore (Baltimore, Annapolis, Washington, Philadelphia and the
towns between).

**Close in: Overture Maps divisions.** Below 60 km the layer also names
the view's places from a local index of Overture Maps' divisions
(`npm run overture:build`, below), when it is built: localities (city,
town, village, hamlet), neighbourhoods (macro, micro) and municipalities
and counties with a population. The box is the ground a nadir view sees
(half-side one camera height, at least 3 km), snapped outward to 0.05° so
a small pan reuses the answer, asked at the view's zoom; the server
answers in milliseconds. Natural Earth's place gives way where the close-in
source has one of the same name within 5 km.

**Close in without the build: OpenStreetMap.** Without the index the layer
asks Overpass for the view's named `place` nodes instead, the kinds
widening as the camera comes in: `city` and `town` below 60 km; `village`
and `suburb` too below 20 km; `hamlet` and `neighbourhood` too below
6 km; at most 800 places. The layer asks the server once each time it is
turned on; a build that goes away while it is on falls back to Overpass.

**The Overture divisions build.** `npm run overture:build` reads Overture's
release **2026-09-23.1** (schema v2.0.0) from its public bucket over HTTPS
(no account, no key; `server/providers/overture/sources.js` pins it):

| File (theme=divisions/type=division)                                | Size                   | Points    |
| ------------------------------------------------------------------- | ---------------------- | --------- |
| `part-00000-8b67a992-99db-52a1-aeb0-1b049a9a125c-c000.zstd.parquet` | 581,868,458 B (582 MB) | 4,688,229 |

The divisions theme's areas (8 files, 4.5 GB) and boundaries (512 MB) are
not read. The world's points are one file, so the build takes the world
(`--regions north-america,europe`, or `OVERTURE_REGIONS`, keeps less). It
downloads the file once (resumable, checked against the listed size,
refused past 5 GB in all), reads it with a small Parquet reader
(`scripts/overture/parquet.mjs`: Thrift footer, dictionary and RLE pages,
ZSTD through Node's zlib; no dependency), and writes the index: 24 bytes
a place sorted by 0.5° cell and by the zoom it is named from, the names in
a separate file, and a cell table counting each cell's places by zoom, so
a view reads only the start of each cell
(`server/providers/overture/divisionsFile.js`). Each build goes to
`build/<buildId>/` and `build/current.json` points at it, so the server
never reads a build being written; the build id hashes the input, the
rules and the index format, and the answers' version hashes the build, so
a rebuild never answers under an old one. `npm run overture:status`
reports it. Everything is in `OVERTURE_CACHE_DIR` (default
`.gev-cache/overture`, gitignored).

Measured (2026-10-19): the download took 28 s; reading 4,688,229 points
took 27.7 s and writing the index 4.9 s (35 s in all, the download
already there). It keeps 4,639,407 places in 42,310 cells: 1,712,328
hamlets, 1,558,002 villages, 103,177 towns, 14,199 cities, 113,333
localities without a class, 728,226 neighbourhoods, 237,753
microhoods, 156,594 macrohoods, 7,495 municipalities and 8,300 counties.
Country, dependency and region points (4,201) are left out: they name
areas, which the Boundaries layer draws, as are counties and municipalities
without a population. On disk: 555 MB raw, 240 MB index (111 MB places,
125 MB names, 3 MB cells).

_Which zoom names a place._ The release leaves Overture's
`cartography.min_zoom` and `max_zoom` empty for every point, and gives a
`prominence` (1-100) only to localities, so the build derives the zoom
(`src/data/overtureDivisions.js`): a locality from its prominence
(round(16 - 0.14 × prominence): 100 from z 2, 94 (Paris) z 3, 69
(Baltimore) z 6, 50 z 9, 30 z 12, 10 z 15) or its class (city z 9, town
z 11, village z 13, hamlet z 15), whichever comes first; a locality
without a class from z 14; a macrohood from z 12, a neighbourhood z 14, a
microhood z 16, a municipality z 12 and a county z 11, each a zoom sooner
for every tenfold of population past 10,000 (at most four). The server
answers with the places whose zoom the view's zoom reaches (z 12 at 50 km
and 30 km, z 14 at 10 km), the most prominent first, then those named
sooner, then the larger; one per name within 5 km (a county and its city
of the same name are one); at most 800. Labels from Overture rank in the
collision solver by prominence (capitals and Natural Earth's larger
places still win), the neighbourhoods below the localities.

Measured on the index (2026-10-19, `createOvertureService` on this
machine):

| View                  | Zoom | Places       | Kinds                                             | Time  |
| --------------------- | ---- | ------------ | ------------------------------------------------- | ----- |
| Baltimore, 50 km      | 12   | 321 of 329   | 19 cities, 80 towns, 106 villages, 106 macrohoods | 6 ms  |
| Baltimore, 30 km      | 12   | 118 of 119   | 9 cities, 41 towns, 18 villages, 47 macrohoods    | 2 ms  |
| Baltimore, 10 km      | 14   | 538 of 544   | 22 localities, 18 macrohoods, 497 neighbourhoods  | 7 ms  |
| Paris, 40 km          | 12   | 800 of 1,023 | 5 cities, 254 towns, 537 villages (capped)        | 10 ms |
| Rural Kansas, 30 km   | 12   | 13 of 13     | Great Bend, Lyons, Ellsworth and villages         | 1 ms  |
| Massif Central, 20 km | 13   | 95 of 95     | Saint-Flour and 90 villages                       | 1 ms  |

_Licence._ Overture's divisions are ODbL 1.0 (they derive from
OpenStreetMap), credited "© OpenStreetMap contributors, Overture Maps
Foundation". ODbL's share-alike applies to a derived database that is
publicly used: the index in `.gev-cache/overture` is one, so it must not
be published except under ODbL; rendered views (the labels on screen,
screenshots) are a Produced Work and need only the credit, which the
layer registers. The fork is personal use, beside FABDEM's CC BY-NC-SA
4.0 elevation (non-commercial), which already keeps the whole app
non-commercial.

**Overpass.** Both this layer and [Street assets](#street-assets-analysis)
go through the app's own `/api/overpass` proxy (its query bounds, its 24 h
memory and 7-day disk cache) with a client that paces them
(`src/sources/overpassView.js`): one request at a time, at least 1.5 s
apart, nothing until a refusal's Retry-After has passed, a newer view
aborting the request in flight. The proxy queries only the instances in
**`OVERPASS_UPSTREAMS`**, and uses no public instance unless told to.
Without it the row says "OpenStreetMap places need OVERPASS_UPSTREAMS in
.env" and Natural Earth keeps naming. To turn it on, add to `.env` and
restart the dev server, for example:

```
OVERPASS_UPSTREAMS=https://overpass-api.de/api/interpreter,https://overpass.private.coffee/api/interpreter
```

**On screen.** Names are world-overlay labels (never Cesium labels),
white on imagery and dark maps, near-black on light ones (the basemap's
luminance). **DOTS** (on by default, kept as `gev.localities.dots`) adds a
point at each named place, larger for capitals. A click on a name or a dot
opens a card beside it: its kind (City, Town, Village, Hamlet, Suburb,
Neighbourhood; Overture's Locality, District, Small neighbourhood,
Municipality and County; or National capital, Regional capital, Populated
place) and country (an Overture place's from its ISO code, in the page's
language), population, its local name when the English one differs, and
the source, with an Overture place's Wikidata id (the overlay's cards
hold text, so the id is not a link); a click elsewhere closes it.
Attribution: Natural Earth (public domain), the Overture Maps Foundation
and © OpenStreetMap contributors (ODbL), registered when the layer is
on.

Overpass times for the layer's own queries (2026-10-19, through the public
`maps.mail.ru` mirror, the only one that answered from this machine that
day: overpass-api.de refused it with 406 and the others timed out; a
configured upstream should be faster):

| Query                         | Box         | Answer             | Time   |
| ----------------------------- | ----------- | ------------------ | ------ |
| city, town @ 55 km, Baltimore | 1.0° × 1.3° | 111 places, 46 KB  | 18.3 s |
| city, town @ 55 km, Paris     | 1.0° × 1.5° | 276 places, 158 KB | 25.8 s |
| village, suburb @ 15 km       | 0.3° × 0.4° | (mirror 504)       | n/a    |

## Street assets (ANALYSIS)

The infrastructure Google Earth shows, from OpenStreetMap
(`src/layers/streetAssets/`): **EV CHARGING** (`amenity=charging_station`,
nodes and areas), **BIKE LANES** (`highway=cycleway`, and roads with
`cycleway`, `cycleway:both`, `cycleway:left` or `cycleway:right` = lane or
track), **HYDRANTS** (`emergency=fire_hydrant`), **STREET LIGHTS**
(`highway=street_lamp`) and **SIGNALS** (`highway=traffic_signals`). One
type at a time, a chip each (kept as `gev.streetAssets.type`), through
the same paced `/api/overpass` client as Localities (and the same
`OVERPASS_UPSTREAMS` need). OpenChargeMap was not used: OpenStreetMap's
charging stations need no key. Attribution © OpenStreetMap contributors
(ODbL).

**From Overture first, when built.** Five of the types read local
Overture indexes instead of Overpass when they are built, at the same
heights, limits and boxes. Each type has its steps in order
(`src/layers/streetAssets/assets.js`); an index not built is passed over:

| Type          | Steps (index: asked for)                                                                                                      |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| EV charging   | places (`npm run overture:build -- --places`): `charging`, 50% or more; and infrastructure: `charging_station`, always merged |
| Bike lanes    | roads (`-- --roads`, see [Roads](#roads-analysis)): cycleways and paths signed for bikes                                      |
| Hydrants      | infrastructure (`-- --infrastructure`, below): `fire_hydrant`                                                                 |
| Street lights | infrastructure: `street_lamp`                                                                                                 |
| Signals       | infrastructure: `traffic_signals`                                                                                             |

Pins come from the index's route (`/api/overture/places`,
`/api/overture/infrastructure` or `/api/roads/bike`, the box clipped to 1°
around the view) and counts per hexagon from its `/counts`. The chip's
title says "Overture Maps", the row names the index that answered ("from
Overture Maps (places)", "(infrastructure)" or "(roads)"), and each
index's credit is registered. Without the builds, or if one goes away
while the layer is on, the type takes its next step, then asks
OpenStreetMap as before.

**Sparse views take the next step.** A step is taken only when the answer
so far has fewer than the type's `sparseBelow` features for the view (3
for each type; pins in the box, or counts in the window), and its answer
is merged in. EV CHARGING takes both of its steps whenever both indexes
are built (`mergeSteps`), sparse or not, and the row says "(places +
infrastructure)" when each added stations. The merge:

- **Pins:** a later step's point within 25 m of one already held is the
  same feature, and the earlier entry stays (the places' has a name and a
  website); the merged list keeps to the type's pin limit.
- **Counts:** the larger count per cell. Counts cannot be matched point
  by point, and a sum would count a station both indexes hold twice.

After the last step, a view still that sparse asks Overpass for the same
box; it then shows OpenStreetMap's answer, and the row ends "from
OpenStreetMap (Overture sparse here)". If Overpass is not configured or
fails, the indexes' few stand; once it has said it is not configured, it
is not asked again until the layer is turned off and on.

- **EV charging:** the places' coverage differs by country (see Places),
  and the infrastructure's charging stations are OpenStreetMap's (202 k
  world-wide against the places' 56 k); each has stations the other
  lacks, so both are shown. Measured at Street assets' 4 km box:

  | View               | Places | Infrastructure | Within 25 m | Shown                           |
  | ------------------ | ------ | -------------- | ----------- | ------------------------------- |
  | Baltimore downtown | 56     | 40             | 5           | 91 (places + infrastructure)    |
  | Berlin             | 376    | 1,020          | 150         | 1,246 (places + infrastructure) |
  | Paris              | 0      | 465            | 0           | 465 (infrastructure)            |
  | Lagos              | 0      | 2              | 0           | Overpass; blocked here, the 2   |

  Counts within 60 km of Paris: the places 203, the infrastructure 6,001,
  6,050 merged (the larger per cell).

- **Hydrants, street lights, signals:** the infrastructure is
  OpenStreetMap's own, as of the release. The fallback catches places
  with next to nothing mapped then (Lagos: no hydrants, no lamps) and,
  with Overpass, anything mapped since.

**Level of detail: pins, then counts, then nothing.** These are dense, so
each type has two heights:

| Type          | Pins below | Counts below | Pin limit | Count limit |
| ------------- | ---------- | ------------ | --------- | ----------- |
| EV charging   | 40 km      | 150 km       | 1,500     | 8,000       |
| Bike lanes    | 8 km       | 30 km        | 2,500     | 10,000      |
| Hydrants      | 5 km       | 25 km        | 2,000     | 12,000      |
| Street lights | 3 km       | 15 km        | 2,000     | 12,000      |
| Signals       | 5 km       | 40 km        | 2,000     | 12,000      |

Below its pin height a type draws its features for the view: points
(coloured by type, outlined in the ink), or for bike lanes lines in the ink
clamped to the ground and the 3D tiles. From there to its count height the
same features come as bare coordinates (`out skel`, or `out center` for
ways and areas) and the shared point rollup (`src/layers/pointRollup/`)
draws their counts per H3 hexagon, a click flying the camera in. Above it
nothing is asked for and the row says how low to go: a wider box would ask
Overpass for a city's worth of features. The rollup also takes over below
the pin height if a view holds more than the pin limit. The box is the
ground a nadir view sees (half-side one camera height), snapped to 0.05°,
inside the proxy's 12° bound at every cap (tested at 70° N). An answer at
its limit says so ("more than the view can show; zoom in for all").

Overpass times for the layer's own queries at the caps (2026-10-19,
Baltimore, through `maps.mail.ru` as above; several timed out at the mirror,
which says more about the mirror that day than about the queries):

| Query                                | Answer                    | Time   |
| ------------------------------------ | ------------------------- | ------ |
| Signals, pins @ 10 km (then the cap) | 2,000 (the limit), 341 KB | 13.4 s |
| EV charging, pins @ 38 km            | 413, 175 KB               | 15.8 s |
| Hydrants, counts @ 24 km             | 4,426 points, 368 KB      | 20.5 s |
| Street lights, count @ 20 km box     | 1,112 (count only)        | 54.7 s |
| Signals, count @ 20 km box           | 2,347 (count only)        | 22.6 s |

The signals' first pin height (10 km) filled the limit in Baltimore's
20 km box, so their pins start at 5 km (a 4 km box held 544). OpenStreetMap
coverage varies by city: Baltimore has only 25 hydrants mapped in a 4 km
box.

### Overture infrastructure

`npm run overture:build -- --infrastructure` reads Overture's base theme,
`type=infrastructure`, release **2026-09-23.1** (schema v2.0.0): 64
GeoParquet files, 13.8 GB, 157,617,917 features in 4,864 row groups, all
from OpenStreetMap (152 classes). It keeps four classes
(`src/data/overtureInfrastructure.js`):

| Class (subtype)                     | Features  | Street assets type  |
| ----------------------------------- | --------- | ------------------- |
| `fire_hydrant` (emergency)          | 2,533,349 | HYDRANTS            |
| `street_lamp` (transportation)      | 6,448,036 | STREET LIGHTS       |
| `traffic_signals` (transportation)  | 2,008,803 | SIGNALS             |
| `charging_station` (transportation) | 202,394   | EV CHARGING, second |

Charging stations are OpenStreetMap's (`amenity=charging_station`), 202 k
beside the places' 56 k: EV CHARGING reads them where the places are
sparse (see "From Overture first"). `crossing` (58 k in a sample of 548 k features) is
left out: it is `highway=crossing`, which SIGNALS has never asked
Overpass for. So is `tower/lighting` (floodlight masts, not street
lights).

- **Columns.** Eight of the 39: `bbox.xmin`, `bbox.xmax`, `bbox.ymin`,
  `bbox.ymax`, `class`, `subtype`, `names.primary` and
  `sources[].dataset`. The bounding box stands in for the geometry: a
  node's box is the node, and a line's or an area's centre is its point.
  The four box columns are 2.3 GB of the release against the geometry's
  5.6 GB.
- **Downloads.** 2.54 GB of those chunks, 4.83 GB with the ranges between
  them (`fetchBytes`), checked against a 20 GB cap (`--cap-gb`). They are
  kept under `GEV_RAW_DIR/overture/raw/<release>/infrastructure`
  (`--drop-raw` deletes them).
- **Index.** The places' format and code (`scripts/overture/places.mjs`
  `POINT_BUILDS`, `server/providers/overture/placesIndex.js`
  `POINT_INDEXES`): z 12 tiles of 12-byte points, the class as the
  category, every feature at confidence 1, and the text holding the name
  (if any), the class and the source. Written to
  `.gev-cache/overture/infrastructure`; `npm run overture:status` lists
  the counts per class.

Measured (2026-10-19, 4 workers): 4.83 GB downloaded and decoded in
8.2 min, merged in 0.9 min, 10.0 min in all. The index is 89 MB in 738
buckets (the blocks are ZSTD-compressed; most texts are empty), plus a
1.2 MB counts file for resolutions 0–5 (71,817 cells); the raw chunks
are 4.8 GB on the archive. 270,548 of the features have a name.

**The routes.**

- `GET /api/overture/infrastructure?west&south&east&north[&zoom&class]`
  answers a box of at most 1° that does not cross the antimeridian:
  `{count, candidates, saturated, places: [{id, name, category, basic,
source, confidence, at}]}`, at most 2,000. `class` is `all`, `hydrant`,
  `lamp`, `signals` or `charging`; `zoom` (0–22) is checked and not used.
  A box holding more keeps 2,000 spread over it by a hash of each
  position, the same ones as the view pans.
- `GET /api/overture/infrastructure/counts?res&class[&west&south&east&north]`
  answers `{res, total, cells: [[h3, count]]}` for resolutions 0–7.

Both answer from two worker threads (the tile pool's
`overture-infrastructure` drawer) and are cached for a day under the
build's version. `/api/overture/layers` says whether the build is there
(its `infrastructure`, with the counts per class).

Timings (warm unless marked; pins at Street assets' heights, 4 km for
signals and hydrants and 3 km for lamps; direct from the index):

| View                 | Signals                | Hydrants                | Street lights           |
| -------------------- | ---------------------- | ----------------------- | ----------------------- |
| Baltimore downtown   | 1,621, 16 ms           | 368, 7 ms               | 794, 7 ms               |
| Columbia MD (suburb) | 235, 5 ms              | 299, 5 ms               | 221, 3 ms               |
| Paris                | 2,000 of 6,196, 134 ms | 2,000 of 10,791, 127 ms | 2,000 of 31,850, 110 ms |
| Tokyo, Shibuya       | 2,000 of 2,666, 28 ms  | 287, 24 ms              | 379, 10 ms              |
| Lagos                | 65, 1 ms               | 0 (sparse)              | 0 (sparse)              |

Counts per hexagon at 80% of each count height answer in 0–14 ms. The
world at resolution 2 (1,519 cells) takes 7 ms. Through the route with
4 tile workers, Baltimore's signals take 142 ms cold and 27 ms warm
(261 KB), and eight saturated Paris boxes at once take 624 ms.

**Licence.** Overture's infrastructure is OpenStreetMap data under the
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/). The credit
reads "© OpenStreetMap contributors, Overture Maps Foundation", linked to
docs.overturemaps.org/attribution. The local index is a derived database,
not to be published except under ODbL.

## Places (ANALYSIS)

Points of interest from Overture Maps' places theme
(`src/layers/places/`), read from a local index built once
(`npm run overture:build -- --places`, below): 64.7 million named places
world-wide, each at least 50% likely to exist by Overture's confidence.
One category at a time, a chip each (kept as `gev.places.category`):
**ALL**, **FOOD & DRINK**, **SHOPPING**, **HEALTH**, **EDUCATION**,
**TRANSPORT**, **ACCOMMODATION**, **PUBLIC SERVICES**, **RELIGION**,
**ARTS & RECREATION** and **EV CHARGING**. A second pair of chips sets
the confidence floor: **≥80%** (the default) or **≥50%**
(`gev.places.confidence`). Without the build, the row says how to make it.

**Level of detail: counts, then pins.** Above 20 km the shared point
rollup (`src/layers/pointRollup/`, through its new `getCounts` option)
draws the server's counts per H3 hexagon. The resolution follows the
height, from 0 at orbit to 7 below 60 km, and a click on a hexagon flies
the camera in. Below 20 km the layer draws the view's places as points
coloured by category, at most 1,500. The box is the ground a nadir view
sees (half-side one camera height, at least 1.5 km), snapped outward to
0.02°.

A view holding more than 1,500 keeps the most confident places, and the
row says so ("the most confident; zoom in for more"). Most of a city is
at 100%, so ties are broken by a hash of the position: the kept places
spread over the view and stay put as it pans. A click on a pin opens its
card: the name, the category and Overture's own kind (`basic_category`),
the brand, the website (as text, not a link) and phone, the source
dataset and the confidence.

**The routes.**

- `GET /api/overture/places?west&south&east&north&category&minConfidence`
  answers a box of at most 1° that does not cross the antimeridian. The
  answer is `{count, candidates, saturated, places: [{id, name, category,
basic, website, phone, brand, source, confidence, at}]}`, with at most
  1,500 places.
- `GET /api/overture/places/counts?res&category&minConfidence[&west&south&east&north]`
  answers `{res, total, cells: [[h3, count]]}` for resolutions 0–7. With
  a window it returns only the window's cells.

`category` is `all` or a chip's key. `minConfidence` is 0.8 or 0.5;
other values snap down to the nearer floor, and the default is 0.8. Both
routes answer from two worker threads (the tile pool's `overture-places`
drawer) and are cached for a day under the build's version.
`/api/overture/layers` says whether the build is there (its `poi`).

**The places build.** `npm run overture:build -- --places` reads release
**2026-09-23.1** (schema v2.0.0, `theme=places/type=place`) from the
public `overturemaps-us-west-2` bucket over HTTPS: 16 GeoParquet files,
11 GB in all, holding 81,455,423 places in 4,864 row groups.

- **Columns.** It reads only `geometry`, `confidence`, `names.primary`,
  `basic_category`, `taxonomy.hierarchy`, `websites`, `phones`,
  `brand.names.primary`, `sources[].dataset` and `operating_status`, by
  HTTP range.
- **Raw files.** Each row group's chunks are kept under
  `GEV_RAW_DIR/overture/raw/<release>/places`, else the cache's `raw/`.
  `--drop-raw` deletes them once decoded.
- **Index.** The build writes it to `.gev-cache/overture/places`.
- **What it keeps.** Places at 50% confidence or more, open (not
  `permanently_closed`) and named.
- **Resumable.** Each row group writes its own part, and the parts are
  merged once all are there.
- **Cap.** It refuses to start if the download would pass 15 GB
  (`--cap-gb` changes the cap).

`npm run overture:status` reports the build.

Measured on 2026-10-19 with 4 workers:

- **Download and decode:** 7.91 GB in 12.1 min. The ranges between the
  wanted chunks come along; 4.0 GB of chunks are kept on the archive.
- **Merge:** 3.5 min, for 16 min in all.
- **Kept:** 64,735,759 of 81.5 M places. 15.8 M were under 50% and
  0.96 M were permanently closed.
- **Size:** 2.42 GB in 1,284 buckets (one per z6 tile), plus a 6.9 MB
  counts file for resolutions 0–5 (313,917 cells).

| Category          | Places | Overture's top level, or the place's kinds                                 |
| ----------------- | ------ | -------------------------------------------------------------------------- |
| Food & drink      | 8.66 M | `food_and_drink`                                                           |
| Shopping          | 11.1 M | `shopping`                                                                 |
| Health            | 4.42 M | `health_care`                                                              |
| Education         | 3.04 M | `education`                                                                |
| Transport         | 3.44 M | `travel_and_transportation`                                                |
| Accommodation     | 2.44 M | `lodging`                                                                  |
| Public services   | 2.30 M | `community_and_government`                                                 |
| Religion          | 1.80 M | any kind naming `place_of_worship` or `religious_organization`             |
| Arts & recreation | 4.90 M | `arts_and_entertainment`, `sports_and_recreation`, `cultural_and_historic` |
| EV charging       | 56,410 | any kind with `charging` in it                                             |
| Other (ALL only)  | 22.6 M | services and businesses, and the rest                                      |

By source: Meta 43.2 M, BrightQuery 9.14 M, Microsoft 6.13 M, Foursquare
4.14 M, AllThePlaces 1.81 M, PinMeTo 163 k, DAC 149 k, Krick 13.5 k and
RenderSEO 3.3 k. Of the kept places, 39.2 M have a website and 53.2 M a
phone.

**The index format** (`server/providers/overture/placesFile.js`) is the
buildings' bucket file format:

- **Per z12 tile:** a block of 12-byte places sorted by confidence (x and
  y on a 2^28 Web Mercator grid, the confidence in 250ths, the category),
  and a block of their texts (name, kind, website, phone, brand, source).
- **Per bucket:** the H3 counts at resolutions 0–7, per category and
  confidence floor.
- **Global counts:** resolutions 0–5 are also summed into one file, so a
  view from orbit reads one block.

Timings on this machine, through the route with 4 tile workers (warm
unless marked cold):

| View                            | Answer                                 | Time             |
| ------------------------------- | -------------------------------------- | ---------------- |
| Baltimore downtown, 3 km, ALL   | 1,500 of 11,798 (≥80%), 385 KB         | 46 ms (163 cold) |
| Columbia MD (suburb), 5 km, ALL | 1,500 of 6,207; FOOD 500 of 500        | 34 ms            |
| Naperville IL (suburb), 5 km    | 1,500 of 7,936; FOOD 838; EV 10        | 35 ms            |
| Paris, 5 km, FOOD & DRINK       | 1,500 of 15,646, 338 KB                | 190 ms           |
| Paris, 5 km, ALL ≥50%           | 1,500 of 109,592                       | 115 ms           |
| Europe from 6,000 km, res 2     | 2,219 cells (the visible globe), 53 KB | 2 ms (15 cold)   |
| Baltimore 200 km, res 6         | 24,895 cells, 3.9 M places             | 80 ms            |
| Eight pin boxes at once         |                                        | 311 ms           |

**Street assets' EV CHARGING** draws from this index when it is built
(see Street assets). Overture's charging stations are uneven by country:
12,455 in the conterminous US, 11,058 in Germany and 10,284 in the UK,
but only 37 around Paris (24 within 25 km of the centre, none within
5 km). OpenStreetMap maps many more there, so a sparse view asks it
instead (see Street assets).

**Licences.** The places are Overture's, drawn from several sources with
their own licences. Each place keeps its `sources[].dataset`, shown on
its card:

- **CDLA-Permissive 2.0** ([text](https://cdla.dev/permissive-2-0/)):
  Meta, Microsoft, BrightQuery, PinMeTo, DAC, Krick and RenderSEO.
- **Apache License 2.0**
  ([text](https://www.apache.org/licenses/LICENSE-2.0)): Foursquare.
- **CC0 1.0**
  ([text](https://creativecommons.org/publicdomain/zero/1.0/)):
  AllThePlaces.

The credit reads "Overture Maps Foundation" with the sources, linked to
docs.overturemaps.org/attribution. The app serves the places from the
local index and bundles none.

Foursquare's [NOTICE](https://opensource.foursquare.com/places-notice-txt/)
(kept verbatim in [docs/notices/FOURSQUARE-OS-PLACES-NOTICE.txt](notices/FOURSQUARE-OS-PLACES-NOTICE.txt))
must travel in full with any distribution of its data; for an API, it
goes in the developer documentation. It names Foursquare Labs, Inc. as
the copyright holder and the Apache License 2.0 as the licence, asks that
changes be marked prominently, and disclaims all warranties. Two kinds of
change apply here: Overture transformed the data to its schema, and this
build keeps a subset of its columns and places. Overture's attribution
page adds "Foursquare data was transformed to the Overture schema" to the
release.

## Roads (ANALYSIS)

**Roads** (`roads`, ANALYSIS) draws Overture Maps' road segments as
self-hosted tiles: OpenStreetMap's, and TomTom's where Overture's sources
say so. The tiles drape on the globe or on the photoreal tiles. The
segments come from the transportation theme of release 2026-09-23.1
(`theme=transportation/type=segment`, 128 files, 72 GB). The build covers
the conterminous US and Europe.

Three modes, kept as `gev.roads.mode`:

- **NETWORK** (the default): roads by class, the major ones on top.
- **SPEED**: the speed limit on a ramp from 30 to 130+ km/h (the legend
  gives mph too). Roads without a limit are thin grey.
- **SURFACE**: paved (paved, paving stones, metal), unpaved (unpaved,
  gravel, dirt) or not mapped.

Three ink chips, kept as `gev.roads.ink`: AUTO follows the basemap, LIGHT
gives bright colours for dark maps, DARK deep colours for light maps.
Tunnels and roads under construction are drawn faint, bridges over the
rest.

**A click on a road opens its card**: name, class (or subclass: ramp,
sidewalk, crossing, alley), bridge or tunnel, speed limit in its own unit,
surface, bicycles (designated, allowed, not allowed) and source. The click
asks `GET /api/roads/nearest?lon=&lat=&zoom=`. The server finds the
nearest road drawn at that zoom within 8 px. A path, sidewalk or crossing
counts 3 px further than it is, so a click on a street finds the street,
not the pavement mapped beside it. A click off any road closes the card.

**Lanes are not in Overture's schema.** The 2026-09 segment schema has
`width_rules`, but no lane count, so the card has no lanes. Nor does it
mark painted cycle lanes on roads: OpenStreetMap's `cycleway=lane` tags
do not survive into Overture. What it has for bicycles is the access
restrictions, whose modes name bicycles (designated, allowed, denied).

### Level of detail: classes by zoom, a level per band of zooms

Each class is drawn from the tile zoom the camera heights in the brief
give (`ROAD_CLASSES` in `src/data/overtureRoads.js`). Ramps (a `link`
flag or subclass) join with the secondary roads, at z 9.

| Classes                                                               | From | Camera height (1,600 px canvas) |
| --------------------------------------------------------------------- | ---- | ------------------------------- |
| motorway, trunk                                                       | z 0  | orbit                           |
| primary                                                               | z 7  | about 1,000 km                  |
| secondary, tertiary, ramps                                            | z 9  | about 300 km                    |
| residential, living street, unclassified, other                       | z 12 | about 50 km                     |
| service, pedestrian, footway, steps, cycleway, path, track, bridleway | z 14 | about 10 km                     |

The build keeps six levels (`ROAD_LEVELS`). Each holds the classes drawn
by its last zoom. Its coordinates sit on a grid of a quarter pixel at that
zoom (the last level keeps Overture's own 0.15 m), simplified to half a
pixel (Douglas-Peucker). The levels are z 0–4, 5–6, 7–8, 9–11, 12–13 and
14–17.

On a coarse grid many short segments snap onto the same points. They
merge into one line there and are kept once. A segment shorter than a grid
cell vanishes, but its neighbours' shared ends snap together, so no gap
opens.

Each level's lines are cut into pieces no longer than a quarter of a block
(a z `block` tile: the level's first zoom or half of it). A piece is kept
in the block holding its ends' middle, so a tile reads only the blocks it
meets, widened by an eighth of a block. The blocks sit in bucket files
(`server/providers/overture/roadsFile.js`): one file per level and z 6
tile, one per level for the two coarse levels.

| Level   | Grid | Block | US segments (pieces) | US size |
| ------- | ---- | ----- | -------------------- | ------- |
| z 0–4   | 2^14 | z 2   | 181,900              | 0.9 MB  |
| z 5–6   | 2^16 | z 4   | 370,360              | 2.0 MB  |
| z 7–8   | 2^18 | z 6   | 1,382,564            | 8.3 MB  |
| z 9–11  | 2^21 | z 8   | 6,670,305            | 55 MB   |
| z 12–13 | 2^23 | z 11  | 28,134,384           | 321 MB  |
| z 14–17 | 2^28 | z 13  | 69,518,639           | 1.71 GB |

### The build

`npm run overture:build -- --roads` (`scripts/overture/roads.mjs`) runs
in three steps, as the buildings do:

1. **Plan.** It reads the 128 files' footers, fetched once and kept with
   the raw downloads. It plans the row groups whose boxes meet a region,
   and the column chunks of the twelve columns it reads (`ROAD_COLUMNS`:
   geometry, subtype, class, subclass, primary name, surface, flags, max
   speed and its unit, access types and their modes, source datasets).
   Those are about half of each row group: ids and connectors stay behind.
   The plan is checked against a 60 GB cap (`--cap-gb`).
2. **Parts.** Each row group is fetched by HTTP range and decoded in
   worker threads (`roadsParts.mjs`). A road segment whose middle point is
   in the region goes onto every level that draws its class. Rail and
   water segments are left out. Attributes:
   - the flags: bridge, tunnel, link and under construction from
     `road_flags`, link also from the subclass;
   - bicycles from the access restrictions whose modes name bicycles,
     each restriction's type paired with its own modes
     (`rowsOfNested` in `parquet.mjs`);
   - the first `road_surface`;
   - the highest max speed, in its unit (the conditional limits, for
     trucks or school hours, are lower);
   - TomTom when a source dataset says so;
   - the primary name.

   The raw row groups are kept (`GEV_RAW_DIR`), so a rebuild fetches
   nothing; `--drop-raw` drops them.

3. **Merge.** Each container a part reached is written again from its
   earlier file and the parts (`roadsMerge.mjs`). On the coarse levels,
   pieces the grid made identical are kept once.

Regions add up: `--road-regions europe` after the US keeps the US. A
part on disk is done, so a stopped build repeats nothing finished. The
build lives in `.gev-cache/overture/roads`, like the other Overture
builds; `OVERTURE_ROADS_DIR` may point it elsewhere. Each rebuild drops
the tiles drawn from the build before it.

| Region          | Row groups | Rows read | Kept    | Fetched  | Derived | Time                          |
| --------------- | ---------- | --------- | ------- | -------- | ------- | ----------------------------- |
| conterminous-us | 3,001      | 64.7 M    | 62.9 M  | 8.43 GB  | 2.09 GB | parts 16.9 min, merge 2.3 min |
| europe          | 5,118      | 109.9 M   | 107.6 M | 15.97 GB | 3.80 GB | parts 32.5 min, merge 4.6 min |
| both            | 8,119      | 174.6 M   | 170.5 M | 24.4 GB  | 5.89 GB |                               |

By source: the US 61.6 M OpenStreetMap and 1.3 M TomTom, Europe 104.1 M
and 3.5 M. Named: 24.1 M and 31.7 M. With a speed limit: 5.1 M and
13.9 M. With a surface: 15.5 M and 38.4 M. Designated for bicycles: 471 k
and 1.57 M.

The size table above is the US alone. With Europe the six levels hold
0.36 M, 0.70 M, 3.0 M, 18.0 M, 76.3 M and 189.0 M pieces (2.0 MB, 4.1 MB,
20 MB, 157 MB, 852 MB and 4.85 GB).

### Serving and timings

`server/providers/overtureRoads.js` serves `/api/roads`:

- `/layers`: the build's status.
- `/tile/<mode>/<ink>/<z>/<x>/<y>?v=`: drawn in the shared tile pool's
  `overture-roads` workers, and kept on disk under the build's version.
- `/nearest`: the click.
- `/bike`: Street assets' bike lanes.

A tile reads its level's blocks and draws each class's lines as
antialiased capsules (the Rivers' coverage rasters), widths by class
growing with the zoom (`roadWidth`).

Tile draw times, live on 2026-10-20 (12 tiles a view, first draws, one
thread; a kept tile serves from disk):

| View (camera height)         | Zoom | Median | Slowest |
| ---------------------------- | ---- | ------ | ------- |
| Europe and the US from orbit | z 3  | 36 ms  | 214 ms  |
| A US interstate, 1,000 km    | z 7  | 71 ms  | 209 ms  |
| Baltimore, 100 km            | z 11 | 22 ms  | 134 ms  |
| Baltimore, 20 km             | z 13 | 16 ms  | 89 ms   |
| Baltimore, 20 km, SPEED      | z 13 | 30 ms  | 99 ms   |
| Paris, 20 km                 | z 13 | 27 ms  | 115 ms  |
| Paris, 20 km, SPEED          | z 13 | 32 ms  | 128 ms  |
| Baltimore, 3 km              | z 16 | 12 ms  | 83 ms   |
| Paris, 3 km                  | z 16 | 12 ms  | 103 ms  |

The slowest tile of each view is the first to open a block; its
neighbours reuse it. In a worker thread a first tile took 299 ms with the
worker's start; a kept tile serves in 2 ms.

The click answers in 5 to 100 ms. Bike lanes for a 0.2° box over
Baltimore take 163 ms (1,391 lines); a 1° box of middle points for the
counts takes 1.0 s (10,081 points).

### The click card in a narrow pane

In a narrow window (the dev tooling's preview pane is 720 × 507) a road's
card could be lost: the left panel stack is 360 px wide, half the pane,
and the world overlay fades cards out beyond the keyhole (a circle about
the pane's height across), so the four sides the host tries could all sit
under the panel or out where the card is at 1 % opacity. A click card (a
protected `card` entry: Roads, and the other click cards, unless one says
`fitPane: false`) whose sides would lose it now gets one more placement,
tried first: `paneFitPlacement` (`src/overlays/worldOverlayDraw.js`)
searches positions inside the pane less its margin, at the click's sides
and against each panel's edges, and keeps the nearest one that clears the
chrome, leaves the clicked road uncovered and sits inside the keyhole. Its
side follows where it landed: below when there is no room above, beside
the panel when the click is under it, so the leader still meets the card.
In a wide window the sides are clear and visible and nothing changes.
Tested on a fake 720 × 507 viewport with the app's chrome
(`src/overlays/paneFit.test.mjs`, and the host in
`src/overlays/worldOverlay.test.mjs`).

### Street assets' BIKE LANES

BIKE LANES now read the roads when they are built. Below 8 km they draw
cycleways and paths signed for bicycles (designated or allowed) as lines.
Up to 30 km they draw those lines' middle points as H3 counts. Both come
from `/api/roads/bike`, the box clipped to 1° around the view.

A view with fewer than 3 asks OpenStreetMap through Overpass as the other
types do, and Overpass's answer includes roads tagged with a painted lane
(Overture has no such lanes). Without the build, BIKE LANES are
Overpass's as before.

Tests:

- `src/data/overtureRoads.test.mjs`:
  - the classes, colours and levels;
  - a line's pieces;
  - the block codec and the nested lists;
  - a small build through parts and merge;
  - the tiles at z 5 and z 16, the click, the bike lanes, and the route.
- `src/layers/roads/roads.test.mjs`:
  - the layer's imagery, chips, inks and legends;
  - the card, the status words and the source;
  - Street assets' BIKE LANES from the roads.

## Property sales (ANALYSIS)

**Property sales (US)** (`property-sales`, ANALYSIS, the 58th layer)
draws U.S. property records from realestatedataset.com's file of
September 2026: 146,628,100 rows, one per property (a parcel, or a unit
where the source lists units), in 1,184 Parquet row groups (13.4 GB). The
publisher, RealEstateDataset.com ("brought to you by Straply"), releases
it under CC0 1.0; the notice and the CC0 text are in
`docs/notices/REALESTATEDATASET-CC0-NOTICE.txt`. The layer credits it as
"realestatedataset.com (Straply), CC0; public-record fields only".

**Only the public-record fields are used**: street, unit, city, state,
ZIP, latitude and longitude, property type, beds, baths, square feet, lot
size, year built, last sale price and date, parcel number (APN), county
FIPS, the tax history (year, amount, assessment) and the price history's
entries whose event is a sale. The listing fields (`status`,
`list_price`, `listing_type`, `hoa_fee`, the amenities) and the price
history's other events (listed, pending, price changes, delistings) come
from listing portals: the publisher's methodology page says the file is
aggregated "from publicly available U.S. property records and listings".
A compiler's CC0 cannot cover what the portals published, so the build
never reads those columns.

**Provenance caveat.** The operator is anonymous beyond the Straply
brand, and the methodology page is a general description: it names no
county sources and no matching rules. The file was checked before use
(2026-10-21) against two authoritative sources:

| Check                                        | NYC (PLUTO)        | Cook County (assessor) |
| -------------------------------------------- | ------------------ | ---------------------- |
| Coordinates within 10 m of the parcel centre | 89% (median 0–1 m) | 86% (median 0–1 m)     |
| Year built exact                             | 93%                | 93%                    |
| Last sale matches a recorded county sale     | 80%                | 80%                    |

Parcel-grade, then, but not the county's own record: every card and the
row say "Public records as published by realestatedataset.com: not
checked against the county".

### What it draws

Above 6 km (about z 14), **H3 hexagons** at the resolution the camera
height picks (0–7, the shared table in `src/maps/h3Resolution.js`),
coloured by one metric on the inferno ramp, kept as `gev.property.metric`:

- **PRICE** (the default): the median last-sale price, sales since 2015
  at $10,000 or more (nominal transfers left out); log scale.
- **$/SQFT**: the median of those sales' price per square foot.
- **YEAR BUILT**: the median year built; linear scale.
- **SALES**: records with a recorded sale, any year.
- **PROPERTIES**: records (parcels, and units where listed).

A median needs three values in its hexagon, else the hexagon is empty.
The legend follows the drawn resolution's domain (5th to 99.5th
percentile of its cells; 2nd to 98th for years). Opacity is a slider
(`gev.property.opacity`). The Lego mode builds the same metric as
columns (`/api/raster/values?layer=property-sales&mode=<metric>`,
sampled from the hexagons about a column wide).

Below 6 km, **the view's buildings** as points in the same colours, at
most 3,000 a view (a spread by position when there are more, the same
ones as the view pans). Records are collapsed into buildings: records at
the same point, or at the same street address without its unit (and
ZIP), are one building (New York's apartments and condos are unit rows:
`929 W End Ave APT 4B`). A building of many units draws a larger point. A
click opens its card: the address and county, the type, beds, baths,
square feet, lot and year built, the last sale and up to three earlier
ones, the latest assessment and tax with the assessments as a sparkline
(`▁▂▃▅▇ 2014–2025`), and the parcel number. A building's card lists its
first six units (unit, last sale, square feet) and how many more; a stack
of different addresses at one point (a geocoder's fallback) says "N
records at this point" and lists the addresses.

### What the build cleans

- **Parcel numbers** in the counties' own forms: Cook County's 14-digit
  PIN (the source drops the trailing `0000` of most:
  `0305309008` → `03-05-309-008-0000`), New York City's BBL (the source
  gives block and lot without the borough: `000300018` in Kings →
  `3-00030-0018`); elsewhere as given.
- **Units** come off the street when the unit column is empty: `APT`,
  `UNIT`, `STE`, `FL`, `#` and the like, followed by a unit number.
- **Sale dates** before 1901 (the source's `1900` placeholders) and after
  the build day are dropped; tax years from 1990, the newest 12 kept;
  sales from the price history, the newest 10 kept.
- **Coordinates** are checked against the Census Bureau's county boxes
  (`src/data/local_data/us_census_counties`), widened by 0.02°: a record
  outside its county's box is kept when it lies in its state's, and
  dropped when it lies outside its state (misgeocodes: a Jackson, MS
  record in Wyoming, a St. Louis one in South Carolina; 57 in the two
  sample row groups), or has no coordinates (0.7% of the file). The
  build's report counts both.

### The index

`npm run property:build` (`scripts/property/`) streams the Parquet file a
row group at a time; worker threads read only the public-record columns
(`scripts/overture/parquet.mjs`), clean the rows (`rows.mjs`) and sort
them two ways (`parts.mjs`). The main thread spills them to one file per
z 10 tile and one per resolution-3 hexagon under
`GEV_RAW_DIR/property/tmp` (`--tmp`): a few files at a time, in long
appends, so an external spinning disk takes one stream of writes. Then:

- **Buildings** (`merge.mjs`): each z 10 tile's records grouped into
  buildings inside each z 14 tile, into a bucket file in the buildings'
  format (`server/providers/overture/buildingsFile.js`): P blocks per
  z 14 tile (28 bytes a building: position, units, type, last sale,
  year built, square feet) and D blocks per z 16 tile (each building's
  records, varint-encoded, the tax history as deltas).
- **Hexagons** (`hexes.mjs`): each resolution-3 cell's records give exact
  medians for it and its descendants (resolutions 3–7); resolutions 0–2
  are summed from histograms (log bins 1.35% wide for prices, 1.12% for
  prices per sqft, one bin a year), one file of typed arrays
  (`server/providers/property/hexFile.js`).
- A manifest and `current.json` naming it, under `PROPERTY_DIR` (default
  `.gev-cache/property`); the spill is deleted.

The source comes from `--file`, `PROPERTY_PARQUET`, or
`GEV_RAW_DIR/realestatedataset/realestatedataset-us-2026-09.parquet`.
`--groups 0-1` builds from some row groups only (the writer's sample).

**Sizes and times.** The two-row-group sample (19–20, 249,152 rows: Cook
County and Montana) kept 249,095 records in 228,112 buildings: an 18 MB
index (pins 2.4 MB, records 14.8 MB, hexagons 0.08 MB) and a 16 MB spill,
in 16 s with two workers. Twelve years of tax history are 42% of a
record's bytes; a stronger zstd level saves 3%. Scaled to the whole file
that is about 8–10 GB of index and 9 GB of spill. One worker holds
600–800 MB while it reads a row group (capped at 768 MB of heap), so the
full build waits for a machine with room for 6–8 of them: about 25
minutes. Not yet run on the whole file (2026-10-21): the local Overpass
import holds the memory, and the build runs once it is done:

```bash
npm run property:build -- --workers 8 --dir .gev-cache/property --tmp E:/gev-data/property/tmp
```

`npm run property:status` says what is built.

### The server

`server/providers/property.js`, answered in the shared tile pool's
workers (`server/providers/common/tilePool.js`, drawer `property`):

- `GET /api/property/layers`: whether the index is built, its version,
  counts, source and each resolution's domains;
- `GET /api/property/h3/<res>/<metric>?west=&south=&east=&north=`: the
  metric's hexagons whose centres lie in the box, 413 past 20,000;
- `GET /api/property/buildings?west=&south=&east=&north=`: the buildings
  in a box under 0.3°, at most 3,000, `saturated` when more;
- `GET /api/property/building?id=`: one building's records (at most 500)
  with its county's name.

An answer asked under its version (`?v=`) may be kept a day; 503 when the
index is not built.

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

**The count window.** While the hexes show, the Cameras, Places and
Street assets rows carry the **SCALE** controls (see Colour scales below)
for them: a floor and a ceiling in points per hex (automatic: one to the
fullest hex drawn), LOG (the default) or LINEAR, a palette in place of the
layer's accent, INVERT and HIDE OUTSIDE. The alpha runs from 0.25 at the
floor to 0.85 at the ceiling; a palette colours along the same window
(inverting flips the colour, not the alpha, so a fuller hex stays the more
opaque); with HIDE OUTSIDE the hexes outside the window go, their counts
with them. Kept as `<layer>:rollup` (`cctv`, `places`, `street-assets`; in
the share hash `cc-rollup`, `pl-rollup`, `sa-rollup`). `scale.js` holds
the fill; `attachPointRollup` takes the store as `scales` (the app's by
default), redraws on a change, and gives the row `scaleControl()`.
Untouched, the hexes are the accent's log ramp exactly as before.

Tests: `src/layers/pointRollup/pointRollup.test.mjs` (binning, the window
across the antimeridian, hysteresis, labels through
`normalizeOverlayEntry`, the lifecycle on a fake viewer across the
threshold and with the rollup off) and `src/layers/cctv/rollup.test.mjs`
(the saved mode, the chips, pins hidden and shown). Drawn with real Cesium
and the real world-overlay host in headless Chrome over a synthetic
3,000-pin catalog: hexes with painted counts from orbit and at 2,500 km,
pins at 100 km.

## Builds and restarts

This PC can restart under a long build: an update, a crash, a silent
installer. One reboot killed the first eleven-wiki Wikipedia build. Two
things are asked of every build:

1. **The finished output switches over atomically.** A build never writes
   in place what a server reads. Either a file goes to a temporary name and
   is renamed when whole, or a set of files carries a build stamp and a
   pointer (`current.json`) moves to its manifest in one rename, the old
   set going after. A stopped build leaves the previous output current.
2. **Long work resumes.** Work that takes more than a few minutes keeps
   what it finished, keyed by its inputs, and a rerun picks it up.

Where each build stands:

| Build                                          | Output switch                                             | A rerun after a restart                                                                                                                            |
| ---------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wikipedia points (`wikipedia:build --points`)  | stamped files, synced, `current.json`                     | each wiki from its checkpoint (above)                                                                                                              |
| Wikipedia grid and hexagons                    | `grid.bin`, `h3.bin` written to a temporary file, renamed | reads geo_tags again (a minute); the page table again with `--text`                                                                                |
| Overture buildings, roads (`overture:build`)   | stamped files, `current.json`                             | the footers and row groups are kept (a group fetched to `.partial`, renamed); a part on disk is done, and a stopped build repeats nothing finished |
| Overture places, infrastructure                | stamped files, `current.json`                             | the same: footers and groups kept, parts done                                                                                                      |
| Overture divisions (`overture:build`)          | `build/<id>/`, `current.json`                             | the download resumes; the build (minutes) is redone                                                                                                |
| Overture country lines (`overture boundaries`) | whole files                                               | redone (minutes); an unchanged input is skipped                                                                                                    |
| Census tracts (`census:build`)                 | temporary file, renamed                                   | surface temperature resumes state by state (`lst-v<rules>/<state>.json`); the rest is quick                                                        |
| Rivers (`rivers:build`)                        | level files and manifest via temporary files              | `rivers:fetch` skips a download already whole; the build is redone                                                                                 |
| Property sales (`property:build`)              | stamped files, `current.json`                             | redone; its spill is under `--tmp`                                                                                                                 |

The rule for a new build: write the output with a stamp or a temporary
name and switch it in one rename. Any step longer than a few minutes
leaves a checkpoint keyed by its inputs (their Last-Modified, ETag or size,
and the build's format), written whole then renamed, and a rerun uses it
unless `--force`. Keep checkpoints out of the directory the output is
swapped in, and list them in the build's `status`.

## Raw downloads on an archive (GEV_RAW_DIR)

The builds that download large inputs keep them, by default, in their
cache directory: `.gev-cache/rivers/raw` (the HydroSHEDS v2 ZIPs, 4.8 GB),
`.gev-cache/overture/raw` (the divisions file and the buildings footers,
1.0 GB, and any `--keep-raw` row groups), `.gev-cache/census/raw` (the
boundaries ZIP) and the Wikipedia dump beside its grid. With
**`GEV_RAW_DIR`** set (in the environment or `.env`; `.env.local` wins, as
in Vite), they keep them under `GEV_RAW_DIR/<build>/raw` instead
(`scripts/rawDir.mjs`), say a NAS share, so a rebuild or a new region on
another disk reuses what was downloaded once. The derived builds (level
files, indexes, tiles) stay in `.gev-cache`.

- **Never a hang.** Before it reads or writes there, each build checks the
  directory in a child process with a 20 s limit (make it, write a file,
  rename it, read it back, remove it; a `status` only lists it), and a slow
  or absent share stops the build with a message saying to connect it or
  unset `GEV_RAW_DIR` (an unknown server answered in 2.5 s:
  "cannot be read (UNKNOWN …)"). Downloads are written to a temp file
  beside their destination and renamed, as before, so a dropped share
  leaves no half file under the final name.
- **Status.** `rivers:status`, `census:status`, `overture:status` and
  `wikipedia:status` name the raw directory they read (marked
  `(GEV_RAW_DIR)` when it comes from there).
- **Tests** never read `GEV_RAW_DIR`: the builds' functions take the raw
  directory from their command line entry, else the cache's own.

**`npm run raw:archive`** moves the raw downloads already in the cache to
the archive (`--to DIR`, else `GEV_RAW_DIR`), leaving the builds where they
are (`scripts/raw-archive.mjs`): each file copied to a temp name beside its
destination, its size checked, renamed into place with its time kept, then
removed from the cache, and the emptied folders with it. A file already
there at its size is not copied again, so a stopped or repeated run picks
up where it was; a copy that moves no bytes for 60 s is abandoned; the
archive is checked first, so nothing moves if it cannot be written; files
being written (`*.partial`, `*.tmp`) are left alone. `--dry-run` lists
what would move; `--only rivers,overture` limits it. Planned on
2026-10-19 (dry run): 519 files, 5.96 GB, to `X:\gev-data` (rivers 3
files, 4.82 GB; overture 513, 1.02 GB; census 1, 0.06 GB; wikipedia the
dump and its metadata, 0.05 GB). After moving, set `GEV_RAW_DIR` to the
archive in `.env`, or the builds will download again.

## Lego rendering mode

Height instead of colour, for raster layers (`src/layers/lego/`). A
drop-down beside the **ANALYSIS** heading picks **Render: Colour** (the
default) or **Render: Lego**, kept as `gev.render.mode`. In Lego, the
raster layer turned on last (an Earth Engine image layer, the Census tracts'
raster modes, or Wikipedia coverage; vector and point layers are untouched)
is also built as bricks: each cell of its values grid around the camera is
one column of stacked **2×2 bricks**, as tall as its value and in its own
ramp's colour snapped to the classic Lego palette. The colour imagery stays
beneath, so nodata and zero cells still read. A second drop-down, shown in
Lego, sets the elevation exaggeration, 1× to 5× (`gev.render.legoExaggeration`).
Until one is chosen it is 2× on a flat basemap, where the columns stand on
the ellipsoid and low country barely rises, and 1× on terrain or the
photoreal tiles, whose own relief carries the columns. A line under the
heading says what is built ("Elevation: 199,809 columns of 54 m bricks").

**The brick.** Classic brick 3003 (design 300323) proportions: the footprint
is the cell, square; a brick is 0.6 of its width tall (a 30 m cell stacks
18 m bricks, a 10 m cell 6 m bricks); four studs 0.3 of the width across
and about 0.1 high. Columns are quantised to the nearest whole brick.

**Height.** Elevation (`ee-elevation`): the true height (× exaggeration)
over the brick height; nothing at or below sea level. Any other raster: its
legend range (`legendMin` to `legendMax` from the values header, on the
layer's own scale: log for the log ramps such as Population and Wikipedia
coverage, square root for elevation) onto 1 to 40 bricks; nodata and zero
are no column. Forty bricks is 24 cell widths at any zoom, so a dense
layer reads as a bar chart close in and a forest of towers from far out
(`MAX_VALUE_BRICKS` in `model.js` is the knob).

**Colour.** The layer's own ramp at the value (its Earth Engine
visualization palette, the Wikipedia inferno stops; elevation its
hypsometric tint), snapped to the nearest Lego colour by CIE L\*a\*b\*
distance. The palette is the classic solid set, hex values from
[Rebrickable's colour table](https://rebrickable.com/colors/) (its
downloadable `colors.csv.gz`, read 2026-10-20); the greys are the classic
ones (to 2007), not the bluish ones:

| Colour        | LEGO name              | Rebrickable id | Hex       |
| ------------- | ---------------------- | -------------- | --------- |
| White         | White                  | 15             | `#ffffff` |
| Bright red    | Bright Red             | 4              | `#c91a09` |
| Bright blue   | Bright Blue            | 1              | `#0055bf` |
| Bright yellow | Bright Yellow          | 14             | `#f2cd37` |
| Black         | Black                  | 0              | `#05131d` |
| Dark green    | Dark Green             | 2              | `#237841` |
| Light grey    | Grey                   | 7              | `#9ba19d` |
| Dark grey     | Dark Grey              | 8              | `#6d6e5c` |
| Tan           | Brick Yellow           | 19             | `#e4cd9e` |
| Orange        | Bright Orange          | 25             | `#fe8a18` |
| Brown         | Earth Orange           | 6              | `#583927` |
| Lime          | Bright Yellowish Green | 27             | `#bbe90b` |
| Medium blue   | Medium Blue            | 73             | `#5a93db` |
| Dark red      | Dark Red               | 320            | `#720e0f` |
| Reddish brown | Reddish Brown          | 70             | `#582a12` |
| Sand green    | Sand Green             | 378            | `#a0bcac` |

**Base.** On the flat basemaps (blank, Positron, dark, Countries: no
photoreal tileset and an ellipsoid terrain) the columns stand on the
ellipsoid. On photoreal tiles or terrain each column stands on its cell's
ground height, read from the elevation values of the same window and cells;
elevation's own columns are the height and always rise from the ellipsoid.

**Level of detail and budget.** The window is fitted to the ground in view
(`legoWindow`): a square 2.5 camera heights across, at least 10 km, around
the point under the middle of the view; a planet-wide view takes 60° around
it. On a 1,600 × 900 canvas (Cesium's 60° field of view across the width)
a camera at height h looking straight down sees 1.15 h × 0.65 h of ground;
tilted to −45° it sees from 0.49 h before that point to 0.96 h past it,
1.27 h to each side at the far edge. The square holds both, but for the
far corners of the tilted view. Until 2026-10-20 the window was the Earth
Engine overlays' (six heights, at least 40 km): the budget then went on
ground off screen. It is cut into cells square
in metres, the coarsest of: what fits 200,000 columns, what fits 512 a
side, and the layer's native cell (30 m for the DEM stack, 10 m for land
cover and forest types, 100 m for population, 5 km for Wikipedia
coverage); so native resolution close in, coarser as the camera rises
(`cellsForWindow`). It is rebuilt when the camera settles out of the
window's middle half or its height doubles or halves (`legoViewMoved`, the
overlays' hysteresis on Lego's window), 300 ms after it settles; the old
bricks are freed. Over the DEM stack's 30 m cells:

| Camera height | Window, before → now | Brick height, before → now |
| ------------- | -------------------- | -------------------------- |
| 80 km         | 479 → 200 km         | 644 → 268 m                |
| 40 km         | 240 → 100 km         | 322 → 134 m                |
| 20 km         | 120 → 50 km          | 161 → 67 m                 |
| 10 km         | 60 → 25 km           | 80 → 34 m                  |
| 5 km          | 40 → 12.5 km         | 54 → 18 m (native)         |
| 3 km          | 40 → 10 km           | 54 → 18 m (native)         |

**Rendering.** One mesh, one draw call (`bricks.js`): every column a box on
its cell's lat/lon corners in a local frame at the window's centre (so
neighbours abut exactly and the Earth's curvature is kept), its top face and
only the parts of its sides a taller neighbour does not hide (at 200,000
columns over a massif, 233,000 to 274,000 faces instead of a million). The
vertices are interleaved, 28 bytes each (position, normal, colour, the
face's coordinates, the height in bricks), drawn by a Cesium `DrawCommand`
with its own shader: a seam at every brick height on the sides, four studs
on each top (lit on the sunward rim, a little shadow on the far side),
darkened bevels at every edge, and a matte-plastic light (a soft key light,
a sky fill, a broad faint highlight); log depth when the scene uses it.

**Click.** A click on a column (`scene.pickPosition`, then the cell and its
neighbours by height) opens a card through the world overlay: "N bricks =
the value in the layer's units", the cell size, the column centre's
latitude and longitude, and the source. Esc or another click closes it.

**Data.** The values come from the local server's `GET
/api/raster/values?layer&mode&west&south&east&north&cells` (a JSON header
and float32 cells; `src/data/rasterValues.js` fetches, decodes and keeps the
last 12 grids). Until that service is served the row says "Lego needs the
raster values service (/api/raster/values)" and Colour is unchanged.

**Timings** (headless Chrome 2026-10-20, ANGLE on a GeForce GTX 1080 Ti,
1600 × 900, a synthetic massif seen from 40 km, the camera turning every
frame; the frame interval is capped by the display rate):

| Columns       | Faces   | Build  | Frame median | p95    | Max     |
| ------------- | ------- | ------ | ------------ | ------ | ------- |
| 50,176        | 58,049  | 313 ms | 6.9 ms       | 7.8 ms | 11.4 ms |
| 99,856        | 117,438 | 472 ms | 6.9 ms       | 7.7 ms | 10.1 ms |
| 199,809       | 233,283 | 818 ms | 6.9 ms       | 8.0 ms | 13.1 ms |
| none (Colour) | —       | —      | 6.9 ms       | 7.8 ms | 13.0 ms |

Build is decode + columns + mesh + upload, on the main thread. A real
massif or city keeps more sides (up to about 500,000 faces for the
synthetic city), still one draw call.

## Colour scales: palettes and a window per layer

Every layer that paints a value through a colour ramp gets a **SCALE**
toggle on its row. It opens a palette dropdown with a preview, a floor and
ceiling over one track (two handles, and number inputs in the layer's
units), **LINEAR / LOG** (and **SQRT** where that is the layer's own
mapping), **INVERT**, **HIDE OUTSIDE** and **RESET**. The window is
window/level: values below the floor take the floor colour, values above
the ceiling the ceiling colour, or with HIDE OUTSIDE nothing is painted
there. Left alone, a layer draws exactly as it did before (its own ramp,
automatic range; tested byte for byte), and the toggle reads **SCALE •**
once anything differs.

**The model** (`src/maps/colourScale.js`, pure): `{ palette, floor,
ceiling, scale: 'linear'|'log'|'sqrt', invert, outside: 'clamp'|'hide' }`,
with `null` floor or ceiling meaning the layer's automatic range. The
palettes are `default` (the layer's own ramp; Wikipedia's inferno-like
ramp stays the default there), viridis, inferno, magma, plasma, cividis,
turbo, grey, hot iron, PET rainbow and blue–white–red. A layer describes
itself with `defineScaleDefaults({ scale, units, outside, colourAt | stops,
range, format })`; `normalizeScale` validates anything read back,
`createScalePainter` paints a value array, `scaleLegend` draws the row's
legend from the model, and `rangeFraction`/`rangeValue` map the slider.

**Kinds: diverging and circular.** A layer's defaults also say what its
values are (`kind`):

- **sequential** (the rest): as above.
- **diverging** (a change either side of a `centre`, default 0; Surface
  water change): the scale is linear and the row shows **LOCK CENTRE**
  (on by default) instead of the mappings. Locked, the centre always
  paints the ramp's middle and each half stretches to its own end, so a
  lopsided window (−10 to 40) still has white at 0; the automatic window
  is symmetric about the centre over the wider side of the data; dragging
  one handle mirrors the other; a Centre input moves the centre (empty:
  the layer's). Unlocked, the window is plain linear and the middle
  follows it. A diverging legend has an odd number of swatches, the
  middle one the centre.
- **circular** (an angle over a `period`, 360 for Aspect): the window is
  a start angle (`floor`) and an arc (`ceiling` − `floor`, at most one
  period) that wraps: start 315°, arc 90° paints 315° → 45° through
  north. Outside the arc a value takes the nearer end's colour round the
  circle, or none with HIDE OUTSIDE. The row shows Start and Arc sliders
  and inputs, and previews the result as one period's bar, 0° at the
  left, the arc wrapping past the right edge (`circularGradient`). The
  **Hue wheel** palette (ends that meet) suits it.

Lego places diverging and circular columns by the same rule
(`withColourScale(spec, model, defaults)` gives the spec a `positionOf`).
No client-drawn layer is diverging or circular today; the Earth Engine
layers declare theirs.

**Where it is kept** (`src/maps/colourScaleStore.js`): per `layerId:mode`,
in this browser as `gev.colourScale.<layerId>:<mode>`, and in the share
link as `cs`, in the `lo` grammar: `_` between entries, `.` between
fields, `<layer>[-<mode>].<palette>.<floor>.<ceiling>.<flags>`, `p` for
the decimal point, flags `l|n|s` then `i` (invert), `h` (hide) and `u` (a
diverging centre unlocked), and an optional fifth field for a centre of
the user's own. For example
`cs=ct-income.g.50000.120000.n_w-articles.v.0p5.200.lih`, or
`sw-change.d.-10.40.nu` and `as.u.315.405.n`. Links made before the kinds
read the same. The hash
is read once at start and wins over what the browser kept; only scales
that differ from the default are written.

**Layers wired** (client-coloured):

- **Wikipedia coverage**, every variant, in the raster and the Hexes mode
  (`src/layers/wikipediaCoverage/scale.js`; units per km², B/km², articles,
  per 100k, B/person).
- **Property sales** hexes and points (`src/layers/property/scale.js`; the
  metric decides log or linear).
- **Census tracts**, the income and surface-temperature modes the local
  server draws (`src/data/censusScale.js`, shared with the server; $ and
  °C). A changed scale rides on the tile URL as `&s=<fields>` and the
  server draws and caches those tiles under `<version>/s-<token>`; the
  default stays the classed tiles. `src/layers/census/scale.js` gives the
  URL token and the row's control.
- **Lego**: the window becomes the spec's min and max, so the bricks
  follow it too; the palette is snapped to brick colours as before, and
  HIDE OUTSIDE raises no column there.

The Earth Engine layers (elevation, slope, aspect, population, water,
canopy, buildings, inundation, forest loss) are drawn by the server from
`src/data/earthEngineScale.js` on their own branch. The point rollup
hexes' count window is under Point rollups above. Not wired: Traffic
(categorical).

## Local Overpass: clone or import

The local Overpass API (`tools/overpass`, its README has the commands)
serves the parts of the app that still ask Overpass: the CCTV layer's
OpenStreetMap-linked webcams, the military installations cache, Street
assets' sparse fallbacks, Localities without its Overture build, and the
annotation and footprint lookups. The river names come from an osmium
extract of the planet, not from Overpass. On 2026-10-22 a reboot (an
installer asked for one) cut the planet import off at 46%, after 25
hours. An import cannot resume, so it was started again from nothing at
16:52 UTC.
Reviewed the same day, from the image's own scripts
(`/app/docker-entrypoint.sh`, `/app/bin/download_clone.sh`), the clone
server's listing and two timed downloads.

|                 | Planet import (running)                                                                                          | Clone, no metadata (ready, not in use)                                       |
| --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Source          | `planet-261012.osm.pbf` on E: (95 GB, data of 2026-10-12)                                                        | dev.overpass-api.de's latest clone (2026-10-20 on 2026-10-22)                |
| Time            | 25 h to 46% (2026-10-21/22); about 54 h if that rate holds. The restart reached 10% in 2 h 10 min, the same pace | 302 GB at 5.4 to 9.4 MB/s (one 20 MB and one 100 MB timed sample): 9 to 16 h |
| After a restart | Starts again from nothing                                                                                        | Resumes from the last byte (`initdb-clone/10-clone-resumable.sh`)            |
| Size            | 16 GB at 10%, 45 GB at 20%, 145 GB at 46%: about 350 GB at 100% if the last stretch's 3.8 GB a point holds (gz)  | 302 GB (lz4 blocks, uncompressed maps)                                       |
| Metadata        | yes (`--meta`)                                                                                                   | no                                                                           |
| Updates         | hourly diffs from the planet's date                                                                              | minutely diffs from the clone's `replicate_id`                               |
| Areas (`is_in`) | built afterwards, locally                                                                                        | the same (the clone has none)                                                |

**Space.** D: has 206 GB free. Docker's data disk
(`D:\DockerDesktop\DockerDesktopWSL\disk\docker_data.vhdx`) is 207 GB on
D:, and the database inside it is about 21 GB, so about 185 GB inside it
can be reused without growing the file. That makes about 390 GB for the
database:

- **The import:** at about 350 GB it would leave D: near the 40 GB line
  where the import monitor stops, before the areas. That is a rough
  extrapolation: the growth per point rose from 2.9 GB (10 to 20%) to 3.8
  GB (20 to 46%).
- **The clone without metadata:** 302 GB would leave about 90 GB.
- **The clone with metadata:** 405 GB would not fit.

**Metadata is not needed.** None of the app's queries reads it. The
`out` statements in `src/` and `server/` are all `geom`, `center`,
`tags`, `body`, `skel` or `qt`, none with `meta`. None of them filters by
`user`, `uid`, `newer`, `changed` or a date, and no build or script asks
Overpass for metadata.

**What the clone is.** `download_clone.sh` asks the source's
`trigger_clone` for the latest clone directory, then fetches the
`replicate_id` and the database files, each with its `.idx`. With
`--meta=yes` it adds the `*_meta` files and the user files; with `attic`
it adds history (about 400 GB more). There are no area files: the image's
areas loop builds them while it serves, as after an import. The image's
script deletes each file before fetching it, so a restarted container
downloads everything again. `initdb-clone/10-clone-resumable.sh` keeps
complete files, resumes partial ones with `curl -C -`, and starts over
only if the server no longer has the clone it began. The clone's
`replicate_id` (7336388) is a sequence of the minutely feed, which was at
7340222 that day, against 123684 for the hourly feed. So the clone's
compose override uses the minutely feed. The image's diff loop applies
it as it would the hourly one.

**Recommendation: switch to the clone without metadata.**

- It takes a fifth to a third of the import's time.
- A restart costs nothing but the minutes it was down.
- It fits on D: with room to spare.
- It is Overpass's own recommended route ("the recommended way to
  populate the database is via cloning", and it "needs the least space").

Switching gives up the running import's progress (11% on 2026-10-22 at
19:12 UTC). The commands are in `tools/overpass/README.md` ("Clone
instead of import"), and nothing has been switched: the user decides.

**If the import stays,** it cannot be made restart-safe:
`update_database` has no resume. It can only be made shorter:

- An import without metadata writes about a quarter less (the clone's
  meta files are 25% of its base and meta together). It still starts
  over after a restart.
- A continent extract imports in a fraction of the time, but the layers
  ask Overpass wherever the view is. A continent would leave the rest of
  the world to the public mirrors, which refuse these queries.
- Docker's memory is not raised: the PC has 16 GB.

### Surprise restart

What a reboot does to this PC's work, and what to do after it.

**What dies:**

- Docker Desktop's WSL VM, and with it every container mid-write: the
  Overpass import (which cannot resume), or the clone (which can).
- Every Node build in progress (property, Wikipedia, rivers and the
  rest): run its command again. The builds skip unchanged inputs where
  they say so, and the downloads that take `-C -` or ETags resume.
- The dev server and every Claude session, with their background tasks
  (the import monitor among them).
- A write to E: mid-file: check the file's size or checksum before using
  it.

**What comes back by itself:** Docker Desktop is a per-user app, so
nothing starts before someone signs in. After sign-in, Docker Desktop
starts if Settings > General > "Start Docker Desktop when you sign in to
your computer" is on. On 2026-10-22 its setting read `AutoStart false`
(`%APPDATA%\Docker\settings-store.json`), yet a "Docker Desktop" entry is
in `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Turn the setting
on in Docker Desktop, so the two agree. Once Docker runs, `gev-overpass`
starts by itself (`restart: unless-stopped`).

**Then:**

1. `npm run overpass:status`. It says one of: the import cut off at N%
   (the database incomplete, wipe and start again), the import or clone in
   progress, serving, or Docker not running.
2. `npm run overpass:recover` prints the commands for that state, the
   destructive `docker compose down -v` included. It runs nothing.
3. Start the import monitor and any builds again.

**Fewer reboots (Windows 10 Education). The user applies these, not a
script:**

- **Installers:** no silent installs that may restart. Run them by hand,
  or with `/norestart` where they take it. The 2026-10-22 reboot was
  one.
- **Pause updates:** Settings > Update & Security > Windows Update >
  Pause updates for 7 days (Advanced options: up to 35 days).
- **Active hours:** set to 05:00 to 23:00 on 2026-10-22 (smart active
  hours on). Windows does not restart for updates inside them.
- **No auto-restart with a user signed in:** `gpedit.msc` > Computer
  Configuration > Administrative Templates > Windows Components > Windows
  Update. (Newer templates put it under Legacy Policies.)
  - Set "No auto-restart with logged on users for scheduled automatic
    updates installations" to Enabled. This is the registry value
    `HKLM\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU`,
    `NoAutoRebootWithLoggedOnUsers` (DWORD) = 1. It is already 1 on this
    PC.
  - The policy applies only while "Configure Automatic Updates", in the
    same folder, is Enabled with scheduled installs (option 4). That is
    not set here: the AU key holds no `AUOptions`.
  - An alternative is "Configure Automatic Updates" = Enabled, option 3
    ("Auto download and notify for install", `AUOptions` = 3). Updates
    then download but install only when told to, so they never restart
    the PC by themselves.

## MSFS renderer on AWS

A rented AWS Windows GPU machine that runs Microsoft Flight Simulator 2024
as GEV's render farm. This PC computes a camera path from GEV's data, and
the cloud machine flies the sim's camera along it and records video. All of
it is in `tools/msfs-renderer/`, with its own README (prerequisites, the
minimum IAM policy, costs, the first session by hand).

- **Infrastructure:** `template.yaml`, CloudFormation. One `g5.2xlarge` on
  Windows Server 2022 (the latest AMI from its SSM public parameter), a 150 GB
  gp3 volume, and termination protection. The security group opens RDP and
  Parsec to the caller's address only. The instance role has SSM and read
  access to the NVIDIA driver buckets. Everything is tagged
  `gev-msfs-renderer`.
- **First boot:** `user-data.ps1` installs the NVIDIA gaming driver by AWS's
  documented procedure (`s3://nvidia-gaming`, `vGamingMarketplace=2`, the
  licence certificate for the version), then Parsec as a shared host, Steam,
  OBS and 7-Zip. It turns off Windows Update's automatic restart, restarts
  once and logs to `C:\gev-provision.log`.
- **Operating:** `npm run msfs:deploy`, `msfs:start`, `msfs:stop`,
  `msfs:status` and `msfs:quota`, through the AWS CLI v2 with the profile
  `gev-msfs`. `destroy` takes a typed confirmation and has no npm script.
  The key pair's private key goes to `~/.gev-secrets/`, and the scripts never
  fetch the Windows password, only print the command for it.
- **Cost (us-east-1):** $1.58 per hour running plus $0.005 for the public
  address, $12 per month for the volume, and transfer out past the free
  100 GB per month at $0.09 per GB.
- **Quota:** a new account has 0 vCPUs of G instances; `msfs:quota` requests 8.
- **Camera paths:** `npm run msfs:path -- --from lat,lon --to lat,lon
--out path.json` (`scripts/msfs/cameraPath.mjs`). It builds great-circle
  legs, rounds corners to the turn the speed allows, and samples them at the
  frame rate. The altitude is the DEM stack's terrain (raster values,
  `ee-elevation`) plus the AGL, slope-limited and smoothed, never below that
  clearance. Heading, pitch and bank come from the track. Road mode follows
  straight legs until a routing graph exists.
- **The bridge:** `tools/msfs-renderer/bridge/` (C#, .NET 8, native
  SimConnect.dll from the MSFS 2024 SDK). It flies the add-on camera along a
  path (`SimConnect_CameraAcquire`, a world locker at the start,
  `SimConnect_CameraSet` with `ALL_ROTATION` in the World referential) on a
  monotonic clock, and can record with OBS through obs-websocket v5. It
  releases the camera on exit and Ctrl+C. It reads its SimConnect values
  from the installed `SimConnect.h` and checks the camera struct against it.
  `--dry-run` replays a file without a sim. It flew `paths/baltimore.json`
  on the AirGPU machine on 2026-10-22. Here it is built and tested in
  Microsoft's .NET 8 SDK container (`bridge/tests`, 39 checks), since this
  PC has no .NET SDK.
- **Recording on AirGPU, with no hand steps** (`tools/msfs-renderer/README.md`,
  "Recording" and "Resolution"):
  - `airgpu-setup.ps1` writes OBS 32's own files, checked against its
    sources: the WebSocket server on 4455, with a password it makes once
    and keeps in `C:\gev\obs-websocket.txt` (this user only, never
    printed); a GEV profile (NVENC HEVC at constant quality CQP 18, 60
    fps, hybrid MP4 in `C:\gev\recordings`); and a GEV scene (a Game
    Capture of MSFS's window by its executable). OBS is closed while they
    are written and started again in the tray.
  - The bridge reads the password file (`--obs-password-file`), signs in
    with `--obs-check`, and after a recording logs the frames OBS could
    not render or encode in time.
  - `--stills` saves PNGs at the canvas's size at the path's waypoints, or
    every `--every-s N` seconds, after `--settle` seconds at each.
  - `airgpu-display.ps1` reports the display modes the virtual display
    offers and MSFS 2024's `UserCfg.opt` video lines. Their key names are
    not published, so they are read there, not guessed.
  - The recommended profile for the RTX A4000: video at 1080p60, and
    stills at 4K in their own run if the display offers 4K. The frame-rate
    cost of 4K and of render scaling is not measured yet; the first run's
    OBS frame counts measure it.
- **Tests:** `src/tooling/msfsRenderer.test.mjs` covers the template, the
  user-data, the commands against a fake AWS CLI, the costs and the
  arguments, with no AWS calls.

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
  coarser one (the terrain layers' GMTED2010 up to z 5, above about
  3,300 km), and where finer ones exist they join at the zoom their pixels
  become visible (the [DEM stack](#elevation-the-dem-stack)). The Wikipedia
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
  precomputed pyramid (an exported asset) of its own. Elevation contours
  are derived the same way: each tile's lines are those of the elevation
  averaged to its scale, with a step that follows the zoom (500 m from
  orbit to 20 m at street scale; see
  [Elevation contours](#elevation-contours)).
- **Categorical rasters keep a cap where their pyramid cannot keep their
  meaning.** Forest loss pixels are years of loss: averaged, they mean
  nothing, and its MODE pyramid lets "no loss" (0) outvote the loss from
  far away. It stays dark above its `maxHeightM` (3,000 km), and its row
  says how low to go. Land cover's classes are pyramided by MODE, so every
  level shows real classes; its ceiling (10,000 km) only keeps the z 0
  world tile, blocky in the Arctic, off the view (see
  [Land cover](#land-cover)). Forest types draws from orbit: its pyramid is
  MODE (the commonest type) with an averaged mask (opacity as the share of
  forest), so a far pixel still says something true (see
  [Forest types and Population](#forest-types-and-population)). Population
  is drawn as a density, which a MEAN pyramid keeps, and so are Buildings'
  COUNT and COVER; Buildings' HEIGHT is a ratio of two MEAN pyramids (Σ
  height / Σ presence) and Tree canopy a mean height over the ground (see
  [Buildings](#buildings), [Tree canopy](#tree-canopy)).
- **Masked rasters: mask by a band pyramided for the mask.** A band whose
  unmasked pixels are only some of the ground (Surface water's) averages
  just those pixels at coarse levels and keeps every coarse pixel any of
  them touches, so from far out it floods the land. Surface water masks
  every mode by `max_extent`, pyramided by MODE, so a coarse pixel shows
  only where most of it is water (see [Surface water](#surface-water)).
- **Points: H3 rollups.** A point layer too dense for the view is counted
  into H3 cells at the resolution the height picks (see
  [H3 hexes](#h3-hexes-resolution-by-perspective)): Wikipedia coverage's
  Hexes mode, from resolution 0 at orbit to 7 at city scale, and the
  Cameras layer's counts per hex that give way to pins as the view comes in
  (see [Point rollups](#point-rollups-camera-counts-per-hex)), and Street
  assets' counts between each type's pin and count heights (see
  [Street assets](#street-assets-analysis)).
- **Names: thinned by their own importance.** Localities names Natural
  Earth's places from the zoom Natural Earth gives each (its `min_zoom`,
  from scalerank and population), at most 180 at once, and adds Overture's
  places below 60 km, each from the zoom its prominence or kind gives it,
  the most prominent first, at most 800 (without the Overture build,
  OpenStreetMap's, the kinds widening as the camera comes in; see
  [Localities](#localities-reference)); the river names thin by scalerank
  the same way.
- **Boundaries: level switching.** The administrative boundaries' AUTO
  chip draws states and provinces above 800 km and districts below;
  COUNTRIES, REGIONS and DISTRICTS force one level (Overture's country
  lines, or LSIB 2017 without them; GAUL 2025 level1 and level2). With
  the country lines built, AUTO draws them above 5,000 km.
  Earth Engine's lines are one pixel at every zoom. The Countries basemap's
  subdivisions style does the same (admin-1 below 5,000 km, countries
  above), and the Grid steps its spacing (30° at orbit to 1' at the street;
  MGRS from grid zones to 1 km lines). The Rivers draw more `RIV_ORD`
  orders as the camera comes in (orders 1 to 3 from orbit, every order
  below 104 km; see [Rivers](#rivers)), each band from the level whose tiles
  Earth Engine draws in seconds.
- **Lines: thin by size, simplify per band.** The HydroSHEDS v2 rivers
  draw the rivers of 100,000 km² and more from orbit (to z 4) and add a
  decade of upstream area at z 5, 7, 8 and 9 (the Rivers' v1 bands at the
  zooms Cesium drapes at their heights), to every 1 km² stream from z 11, each band
  simplified to half a pixel at its own zooms (see
  [Rivers: HydroSHEDS v2](#rivers-hydrosheds-v2-for-the-americas)). Roads
  draw by class with the zoom (motorways and trunks from orbit, streets
  from z 12, paths from z 14), each of six levels on its own grid and
  simplified to half a pixel at its last zoom (see
  [Roads](#roads-analysis)).

**Checklist for a new data layer:**

- [ ] Its record or module header says how its detail follows the camera:
      a pyramid (and its aggregation: mean, sum, mode, sample), a derived
      quantity (aggregate-then-derive at output scale, or a precomputed
      pyramid for derive-then-aggregate), level switching, or an H3 rollup.
- [ ] It draws from orbit unless the aggregated quantity is meaningless
      (categories, years); only then does it get a `maxHeightM`, and the
      record says why.
- [ ] An Earth Engine image's pyramid policy was read from its asset
      (`GET /v1/projects/earthengine-public/assets/<id>`: MEAN, MODE,
      SAMPLE…) and the drawn quantity survives it: a density, not a count,
      under MEAN; a class under MODE, with "none" masked rather than a
      value that outvotes it.
- [ ] Its coarsest tiles were timed against the live source (z 0 to 2),
      and a slow source has a far variant, a cache in front of it, or
      variants that start at a level it answers in seconds (`minZoom`, the
      Rivers).
- [ ] A boundary table has one feature per unit (compare its feature count
      with its distinct codes); a chunked one draws its cuts as borders.

## Smaller additions

- **What the dev server watches and scans** (`build/vite.js`). Vite's
  watcher ignores `.claude/` (the worker worktrees, each a full checkout
  with its own `index.html`), `.gev-cache*` (the tile and data caches, a
  junction to another drive), `.gev-secrets/` and `node_modules/`, so a new
  worktree or a deleted cache page no longer reloads the app; and the
  dependency scanner starts from `index.html` alone rather than every
  `*.html` in the tree (camindex fixtures, the template fragments,
  `tools/cesium-render.html`, which its own script serves). Measured
  2026-10-20 against the main checkout with a bare Vite on port 4179: the
  dependency scan 156 s to 11.6 s (18 entries to 1), the watched paths
  33,563 to 2,557, server ready 130 ms to 118 ms. `src/data/trafficTiming.test.mjs`
  builds its own server, now without a watcher or a scan: 123 s to 0.9 s
  in the main checkout. Upstream has none of these folders, so the ignores
  are harmless there.
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

## Tests: budgets and flakes

`npm test` passes or fails on correctness alone. It runs on a machine that
is often busy with an import, a build or another suite, so a test whose
result depends on how fast the machine is that minute isn't a gate.

- **Wall-clock budgets.** A test that times its own work ("50,000 cameras
  de-duplicate in well under 300 ms", "decodes in linear time") checks the
  time with `withinBudget(ms, budget, note)` from `scripts/bench.mjs`. In
  `npm test` a missed budget is printed as `[bench] over budget …` and the
  test still passes on its correctness assertions. `npm run bench` runs the
  files that call `withinBudget()`, one at a time, with `GEV_BENCH=1`, and
  fails on a miss. Run it on a quiet machine after touching one of those
  paths.
- **Promptness checks stay.** A check that an injected short deadline was
  used rather than the production one (`< 500 ms` against a production
  timeout of seconds) is a correctness assertion and stays in `npm test`.
  Its bound sits well below the production value, so a loaded machine still
  passes it.
- **Real timers need headroom.** A test racing real timers keeps a margin a
  stalled event loop can't eat: the CCTV media idle-deadline test sends a
  chunk every 10 ms against a 100 ms deadline (it was 40 ms) and watches for
  four and a half deadlines.
- **Tests stay offline.** A test that reaches a real host is a bug, and
  `npm test` (and `npm run bench`) fail it. Every test file runs with
  `scripts/test-network-guard-preload.mjs` loaded (`node --import`), which
  refuses `fetch()` and any socket connection to a host other than this
  machine (`localhost`, `*.localhost`, `127.x`, `::1`, `0.0.0.0`, `::`)
  before a byte or a DNS query leaves. The code under test sees an
  unreachable host. The test file fails with
  `unit tests stay offline: a connection to <host> was refused` and the
  frames that asked, even when the code swallows the error. node:test pins
  an error thrown outside a test's own callback on the file, so the file
  fails rather than one test; the frames name the line.
  - A test that pins a made-up name to a loopback fixture server (the local
    receivers' DNS-pinning tests) names it in `GEV_TEST_ALLOW_HOSTS`,
    comma-separated, for its own duration. The guard sees names, not the
    addresses a custom `lookup` gives them. `*` allows every host, for a
    one-off investigation only.
  - The linked-webcam pack's QLever fallback goes over `node:https`, past a
    `fetch` mock, so a test that loads the whole CCTV catalog sets
    `CCTV_LINKED_ENABLED=0`. Without it the Catalonia and WSDOT catalog tests
    waited out QLever's 300 s timeout, and the King County one asked the real
    QLever. The guard would now fail them at once.
- **A flake is a bug with a cause.** A test that fails in the suite and
  passes alone is not rerun until green and left. Loop it under load to find
  the cause, and fix that. A small CPU burner (a worker thread per core
  spinning for a minute) next to `node --test --test-name-pattern=… file`, a
  few at a time, reproduces most of them. Two were real Windows races, fixed
  in the code rather than the tests:
  - Windows refuses, for a moment, a rename over a file another process is
    reading (EPERM). The MCP panel key's malformed-file repair
    (`server/mcp/panelKey.js`) and the Mapillary tile cache's untrimmed-tile
    rewrite (`server/providers/mapillary/tiles.js`) now try again, as
    `keepTile` does.
  - The tile cache also no longer starts a second rewrite when a concurrent
    hit's read finishes after the first rewrite landed.
- **A file-level 'test failed' with nothing else is a process that died.**
  An unhandled rejection, or a worker thread's error, is pinned on the
  running test and printed with its message. Only a process that exited, or
  crashed natively, fails its file as `test at <file>:1:1 … 'test failed'`.
  The spec reporter hides the exit code; the TAP reporter shows it:

  ```bash
  node --test --test-reporter=tap path/to/file.test.mjs
  ```

  Look for `exitCode:` in the failure; 3221225477 is 0xC0000005, a Windows
  access violation. The SDR decoder tests had one. Node 24.21 crashed when
  a `node:worker_threads` Worker running the decoder's WebAssembly DSP was
  terminated, about once in 2,000 cycles under load, and turning off
  WebAssembly tier-up did not reliably stop it in the test runner. The
  tests are about the decoder's output, so they now run the real decoder
  module in their own thread behind a `self` that copies messages as
  postMessage does (`src/testSupport/sdrDecoder.mjs`). The browser still
  runs it in a Web Worker.

node:test sets no per-file timeout, and `npm test` passes none, so a heavy
file (transit lifecycle, about 16 s alone; constructCatalog and the wind
layer files, about 5–6 s) cannot time out. Its time is only the suite's
wall clock.

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
  The fork's count is upstream's plus 25 (the two Baltimore layers, Recorded
  Video, the sixteen Earth Engine overlays, the Grid, Wikipedia
  coverage, Localities, Street assets, Places and Roads): 57 since Roads
  (2026-10-20). A record added to `src/data/earthEngineLayers.js` or an
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

A failure there is read the way [Tests: budgets and flakes](#tests-budgets-and-flakes)
says.

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
