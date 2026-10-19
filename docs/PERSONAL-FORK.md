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
- [Elevation: the DEM stack](#elevation-the-dem-stack)
- [Grid (REFERENCE)](#grid-reference)
- [Wikipedia coverage (ANALYSIS)](#wikipedia-coverage-analysis)
- [Localities (REFERENCE)](#localities-reference)
- [Street assets (ANALYSIS)](#street-assets-analysis)
- [Rivers: HydroSHEDS v2 for the Americas](#rivers-hydrosheds-v2-for-the-americas)
- [Rivers: click a reach](#rivers-click-a-reach)
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

| Layer                                                              | Dataset (Earth Engine id)                                                                                                                                                                                | Licence                                                                                                                                          |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Terrain slope, Terrain aspect, Hillshade, Elevation                | The DEM stack (see [Elevation: the DEM stack](#elevation-the-dem-stack)): GMTED2010 far out, FABDEM v1-2 as the base, USGS 3DEP 10 m and 1 m, ArcticDEM 2 m and REMA 8 m where they cover (`ee.Terrain`) | FABDEM CC BY-NC-SA 4.0 (non-commercial) with the Copernicus notice; 3DEP and GMTED2010 public domain; ArcticDEM and REMA PGC/NSF acknowledgement |
| Elevation contours (see [Elevation contours](#elevation-contours)) | The DEM stack's heights, as the Elevation layer mosaics them, band by band                                                                                                                               | As the terrain layers                                                                                                                            |
| Forest loss (2001–2025, coloured by year)                          | Hansen Global Forest Change v1.13, `UMD/hansen/global_forest_change_2025_v1_13`, band `lossyear`                                                                                                         | CC BY 4.0                                                                                                                                        |
| Forest types (see [below](#forest-types-and-population))           | JRC global map of forest types 2020 v1, `JRC/GFC2020_subtypes/V1`, band `Map` (1 naturally regenerating, 10 primary, 20 planted)                                                                         | Free to use; citation requested                                                                                                                  |
| Population (see [below](#forest-types-and-population))             | GHSL population P2023A, `JRC/GHSL/P2023A/GHS_POP`, band `population_count`, epochs 2020 (default), 2000, 1990, 1975                                                                                      | Reuse authorised with acknowledgement (EC reuse notice)                                                                                          |
| Administrative boundaries                                          | FAO GAUL 2025, `FAO/GAUL/2025/level1` from far out, `level2` below 800 km; countries from LSIB 2017, `USDOS/LSIB/2017`                                                                                   | CC BY 4.0 (LSIB: US public domain)                                                                                                               |
| Rivers (see [Rivers](#rivers))                                     | HydroRIVERS v1 with the Free-Flowing Rivers attributes, `WWF/HydroSHEDS/v1/FreeFlowingRivers`; names from Natural Earth                                                                                  | HydroSHEDS licence, attribution (Natural Earth: public domain)                                                                                   |
| Surface water (see [Surface water](#surface-water))                | JRC Global Surface Water 1.4 (1984–2021, 30 m), `JRC/GSW1_4/GlobalSurfaceWater`, bands `occurrence`, `change_abs`, `seasonality`, masked by `max_extent`                                                 | Copernicus, free without restriction; "Source: EC JRC/Google"                                                                                    |
| Land cover (see [Land cover](#land-cover))                         | ESA WorldCover 10 m, 2021 `ESA/WorldCover/v200/2021` and 2020 `ESA/WorldCover/v100/2020`, band `Map`                                                                                                     | CC BY 4.0, "© ESA WorldCover project" notice                                                                                                     |
| Buildings (see [Buildings](#buildings))                            | Google Open Buildings 2.5D Temporal v1, 2023, `GOOGLE/Research/open-buildings-temporal/v1`; footprints from Open Buildings v3, `GOOGLE/Research/open-buildings/v3/polygons`                              | CC BY 4.0 (the temporal set: or ODbL 1.0)                                                                                                        |
| Tree canopy (see [Tree canopy](#tree-canopy))                      | Meta and WRI canopy height 1 m, `projects/meta-forest-monitoring-okw37/assets/CanopyHeight`; ETH Global Canopy Height 2020 10 m, `users/nlang/ETH_GlobalCanopyHeight_2020_10m_v1`                        | CC BY 4.0                                                                                                                                        |

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
3DEP 1 m, which is patchy, "USGS 3DEP 1 m / USGS 3DEP 10 m". The credit
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
  m") and 5 km ("USGS 3DEP 1 m / USGS 3DEP 10 m"; Denver, 39.70, −105.25 at
  3 km, has lidar).
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

**Close in: OpenStreetMap.** Below 60 km the layer also asks Overpass
for the view's named `place` nodes, the kinds widening as the camera comes
in: `city` and `town` below 60 km; `village` and `suburb` too below 20 km;
`hamlet` and `neighbourhood` too below 6 km. The box is the ground a nadir
view sees (half-side one camera height, at least 3 km), snapped outward
to 0.05° so a small pan reuses the answer; at most 800 places. Natural
Earth's place gives way where OpenStreetMap has one of the same name
within 5 km.

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
Neighbourhood; or National capital, Regional capital, Populated place) and
country, population, its local name when OpenStreetMap's English one
differs, and the source; a click elsewhere closes it. Attribution: Natural
Earth (public domain) and © OpenStreetMap contributors (ODbL), registered
when the layer is on.

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
  from scalerank and population), at most 180 at once, and adds
  OpenStreetMap's places below 60 km, the kinds widening as the camera
  comes in (see [Localities](#localities-reference)); the river names thin
  by scalerank the same way.
- **Boundaries: level switching.** The administrative boundaries' AUTO
  chip draws states and provinces above 800 km and districts below;
  COUNTRIES, REGIONS and DISTRICTS force one level (LSIB 2017 countries,
  GAUL 2025 level1 and level2).
  The lines are one pixel at every zoom. The Countries basemap's
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
  [Rivers: HydroSHEDS v2](#rivers-hydrosheds-v2-for-the-americas)).

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
  The fork's count is upstream's plus 19 (the two Baltimore layers, Recorded
  Video, the fourteen Earth Engine overlays, the Grid and Wikipedia
  coverage): 51 since Buildings and Tree canopy (2026-10-19). A record added to `src/data/earthEngineLayers.js` or an
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
