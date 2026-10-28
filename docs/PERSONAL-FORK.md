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
- [Cottereau's world history against Cliopatria](#cottereaus-world-history-against-cliopatria)
- [World history (REFERENCE)](#world-history-reference)
- [Raw downloads on an archive (GEV_RAW_DIR)](#raw-downloads-on-an-archive-gev_raw_dir)
- [Lego rendering mode](#lego-rendering-mode)
  - [Lego with the Google 3D tiles: Relief ×N and Photoreal on bricks](#lego-with-the-google-3d-tiles-relief-n-and-photoreal-on-bricks)
- [Blocks](#blocks)
  - [Blocks: the chunk source](#blocks-the-chunk-source)
  - [Blocks: the renderer](#blocks-the-renderer)
  - [Blocks: buildings and land cover](#blocks-buildings-and-land-cover)
- [Colour scales: palettes and a window per layer](#colour-scales-palettes-and-a-window-per-layer)
- [Local Overpass: clone or import](#local-overpass-clone-or-import)
- [MSFS renderer on AWS](#msfs-renderer-on-aws)
- [Level of detail](#level-of-detail)

- [Keyless basemaps (MAP SOURCE)](#keyless-basemaps-map-source)
- [The Countries basemap (MAP SOURCE)](#the-countries-basemap-map-source)
- [H3 hexes (resolution by perspective)](#h3-hexes-resolution-by-perspective)
- [Point rollups: camera counts per hex](#point-rollups-camera-counts-per-hex)
- [HUD: the camera readout](#hud-the-camera-readout)
- [Walk and Fly (embodied navigation)](#walk-and-fly-embodied-navigation)
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

**Where it comes from, and terms.** The configured Overpass only
(`OVERPASS_UPSTREAMS`, read as the Overpass proxy reads it: the local
instance here), falling back to QLever's OSM planet endpoint when every
configured endpoint fails, or at once when none is set. There is no public
mirror list of its own any more. Wikidata comes from its SPARQL endpoint.
OpenStreetMap data is ODbL and Wikidata is CC0; each feed belongs to its
operator.

**Switches.** `CCTV_LINKED_ENABLED` (`1`), `OVERPASS_UPSTREAMS` (shared with
upstream).

**Cache.** `.gev-cache/cctv-linked/osm.json` and `wikidata.json`, refreshed
weekly, stale-while-revalidate:

- The CCTV catalog never waits for the pack. A stale copy is served at once
  while one refresh per list runs in the background.
- A refresh gives up after 5 minutes (`LINKED_REFRESH_DEADLINE_MS`) and
  aborts every request it made. Before, a catalog rebuild could wait about
  32 minutes when every upstream failed (4 mirrors × 180 s plus 4 QLever
  attempts × 300 s).
- After a failure the next refresh waits an hour (`LINKED_RETRY_MS`).
- With no copy at all the pack is empty until its first fetch lands. The
  catalog retries an empty pack within two minutes and picks the list up
  then.
- The status (`/api/cctv/status`, the SOURCES block) shows each list's data
  age, "refreshing" while a refresh runs, and the last failure with its
  time.

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

`GET /api/earth-engine/budget` (read-only, same-site, GET only; nothing is
signed in or fetched to answer it) returns `{date, dailyTiles, used:
{layerId: n}, total, warnAt: [50, 90]}`. While Render: Blocks is drawn
(every fresh Blocks view spends about 40 computePixels), the page asks for
it at once and every 60 s, and never otherwise
(`src/data/earthEngineBudget.js`, started and stopped by the Blocks
controller's status in `src/app/lego.js`): the HUD shows "EE 1,240 / 20,000
today" under PX, amber from 50% and red from 90%, and the Blocks status
line's tooltip gives the day and the layers that spent it. Checked in the
built app: asked 15 s in (as Blocks began drawing) and then 60 s later, the
line amber at 56%, and nothing asked in 65 s of Render: Colour.

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

**Recommendation.** Since 2026-10-25, GAUL is no longer kept for the
regions and districts where Overture draws them: below 5,000 km
(REGIONS) and 1,000 km (DISTRICTS), wherever Overture has lines of the
level, the layer draws Overture's region and county lines (see "Built
(2026-10-25)" below). GAUL stays above those heights and where Overture
lacks the level: it is current, CC BY 4.0, one feature per unit, and
draws coasts, which Overture's lines do not. For the countries, LSIB
2017 is the weak link. It is eight years old, its coasts
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

**Built (2026-10-25): region and county lines.** The same build now keeps
the `region` and `county` subtypes too, and REGIONS and DISTRICTS draw
them close in.

- **Why:** over Baltimore, GAUL's county lines that follow the shore ran
  hundreds of metres to over a kilometre off the imagery, looping across
  the harbour. The city's own straight edges were close.
- **What is kept:** all 87,530 lines, 35.3 million points (557 country,
  8,202 region with 8.7 M points, 78,771 county with 24.0 M). Region lines
  are kept from the z 4 band on, county lines from z 7
  (`SUBTYPE_MIN_ZOOM`): from farther out a county line is noise. Each
  line's class now names its subtype, and disputes are kept as before
  (`is_disputed`, and `perspectives` when present).
- **Coverage:** region lines in 211 countries, county lines in 164. The
  gaps are real: Brazil has no county lines in this release, South Africa
  78, Pakistan 61. The build writes to the manifest which z 6 cells
  (`coverage.region`, `coverage.county`; 755 and 820 cells) have lines of
  each level, and the lines per country (`byCountry`).
- **Measured** on 2026-10-25, building into a scratch directory: 17.9 s
  (15.5 s reading), 43.1 MB of level files (z 10–14: 15.6 M points,
  35.2 MB; z 7–9: 3.6 M, 5.6 MB), about 300 MB resident, within the
  default heap.
- **Server:** the same routes, with a set before the ink:
  `/api/boundaries/countries/tile/regions/<ink>/<z>/<x>/<y>` draws the
  country and region lines, `…/tile/districts/…` all three. A tile draws
  only its set's subtypes. `/layers` gives each set's versions and its
  covered cells. The country tiles keep their versions.
- **Client:** `level1` (REGIONS) and `level2` (DISTRICTS) name
  `local: 'overture-boundaries'` with a `localSet` and a `localBelowM`
  (`OVERTURE_REGIONS_BELOW_M` 5,000 km, `OVERTURE_DISTRICTS_BELOW_M`
  1,000 km). Below its height, and where the cell under the view (or one
  of the eight around it) has lines of the level, the local set draws in
  place of GAUL, in the same inks and opacity. AUTO follows: regions below
  5,000 km and districts below 800 km are Overture's where it has them.
  Above, and anywhere without the level (Brazil's districts, the open
  sea), GAUL draws from Earth Engine as before.
- **The heights:** on a 1,600 px canvas a pixel is about the camera height
  divided by 1,400. GAUL's worst stretches (p99 1.4 to 1.9 km, below) show
  as a pixel or more below about 1,400 km, and its median errors only
  very close in. County lines are built from z 7, which a 1,000 px canvas
  drapes from about 1,050 km down, hence DISTRICTS at 1,000 km. Region
  lines start at z 4 (about 8,500 km on that canvas), hence REGIONS at
  5,000 km, where AUTO hands over to the countries anyway.
- **Coasts:** `division_boundary` holds lines between divisions (and
  maritime ones), never coastlines. Where Overture draws, a county's coast
  has no line, and the imagery or basemap shows the shore. That is the
  Baltimore fix by construction: no shore-following line can be off the
  shore.
- **Credit:** `OVERTURE_BOUNDARIES_CREDIT` now reads "Boundary lines: ©
  OpenStreetMap contributors, Overture Maps Foundation (ODbL)", and is
  registered whenever any of Overture's sets draws.

**Measured against OpenStreetMap (2026-10-25).** Samples every 50 m along
an OSM relation's boundary (the local Overpass), each measured to the
nearest line Overture's z 10–14 tiles draw (decoded from the level file
as the tiles are) and to the nearest edge of FAO GAUL 2025 level 2 (its
units around the place, from Earth Engine). "Where Overture draws it" is
the samples with an Overture line within 1 km; the rest is coast.

| Place (OSM relation)                         | Overture draws | Overture, median / p90 | GAUL there, median / p90 / p99  | GAUL on the coast, median / p90 / p99 |
| -------------------------------------------- | -------------- | ---------------------- | ------------------------------- | ------------------------------------- |
| Baltimore City (133345), 66 km               | 100%           | 0.6 m / 2.7 m          | 9.3 m / 31 m / 1,438 m          | (no coast in the relation)            |
| Finistère, département 29 (102430), 6,486 km | 10.9%          | 1.2 m / 4.4 m          | 5.4 m / 21 m / 56 m             | 3.5 m / 65 m / 1,879 m                |
| Qingdao prefecture (3469133), 1,114 km       | 91.0%          | 0.4 m / 2.5 m          | 2,391 m / 30,357 m / over 25 km | over 25 km                            |

- In Baltimore, 7.8% of the city's boundary is more than 100 m from GAUL's
  lines: the Patapsco and harbour stretches. Overture's worst point is
  3 m.
- Finistère's relation is mostly coast and islands, which Overture does
  not draw. Its land borders are within a few metres. Its p99 of 264 m is
  coast samples within 1 km of another line.
- GAUL's units around Qingdao do not follow the prefecture's OSM boundary
  at all (median 2.4 km off, p90 30 km; the cause was not looked into).
  There GAUL is off at any height where districts show, so the heights
  above are set by the good cases.

**Built (2026-10-25): division areas.** `division_area` adds what lines
cannot: a click's card, fills, and the countries' coasts.

- **Data:** `release/2026-09-23.1/theme=divisions/type=division_area/`,
  eight files, 4.53 GB (ODbL), in
  `raw/2026-09-23.1/divisions/division_area/` of the Overture cache. A
  file still named `.partial` is not read.
- **What is kept:** the land areas of the country, dependency, region and
  county subtypes, and the countries' and dependencies' territorial seas
  (for "at sea, in X's territorial sea"). That is 43,345 units: 219
  countries, 53 dependencies, 3,929 regions and 38,933 counties, from
  121.8 million points. Localities, neighbourhoods and the regions' and
  counties' sea copies are left out. A unit keeps its primary name and its
  English name (`names.common` `en`) when that differs.
- **Build:** `npm run overture:areas` (`--force`, `--dir DIR`;
  `scripts/overture/areas.mjs`). It streams one row group at a time and
  writes each unit's polygons out at once. Each band's level is
  simplified to half a pixel like the lines. Only the units' small records
  are held. Written to `build/areas/` of the Overture cache:
  - `areas-<stamp>.bin`, the polygons by offset;
  - `units-<stamp>.json`, 12.4 MB;
  - `index-<stamp>.json`, 1.1 MB: a multi-level grid, each unit in at
    most 2 × 2 cells of the deepest zoom up to 10 where its box is that
    small;
  - `coasts-<stamp>/`, the countries' and dependencies' land outlines as
    line level files, cut into cells like the boundary lines.
    Latitudes are clamped to Web Mercator's ±85.05° (Antarctica's land
    reaches -90°).
- **Measured** on 2026-10-25, building into a scratch directory: 88.1 s,
  184.2 MB (polygons 171.6 MB, of which z 10–14 is 136.4 MB; coasts
  12.6 MB), peak resident 468 MB (heap 134 MB).
- **Server:** `server/providers/overtureAreas.js`, at
  `/api/boundaries/areas`:
  - `/layers`;
  - `/identify?lat=&lon=`, the country (or dependency), region and county
    holding the point, each with its names, subtype and country code; at
    sea, the territorial sea's country, if any;
  - `/fill/<regions|districts>/<z>/<x>/<y>`;
  - `/coast/<ink>/<z>/<x>/<y>`.
    A point is looked up in one index cell per zoom, then tested against
    each candidate's finest polygons, read by offset (decoded polygons kept
    up to 12 M points). Loaded, it takes about 80 MB.
- **Click card:** with REGIONS or DISTRICTS showing (forced, or AUTO in
  their bands), a click asks `/identify` and shows a card on the world
  overlay (`src/layers/earthEngine/boundaryClicks.js`): the county, the
  region and the country with its code, or "At sea". Measured answers:

  | Point                      | Card                                                          |
  | -------------------------- | ------------------------------------------------------------- |
  | Baltimore's Inner Harbor   | Baltimore; Maryland; United States (US)                       |
  | Towson                     | Baltimore County; Maryland; United States (US)                |
  | Qingdao                    | 青岛市 (Qingdao); 山东省 (Shandong); 中国 (China) (CN)        |
  | Quimper                    | Finistère; Bretagne (Brittany); France (FR)                   |
  | Chesapeake Bay             | At sea, in the territorial sea of United States               |
  | Mid-Atlantic (35° N 40° W) | At sea                                                        |
  | Rio de Janeiro             | Rio de Janeiro; Brasil (Brazil); "No county in Overture here" |

  Each took 1 to 28 ms (the first point decodes the US outline).

- **FILLS** (a chip on the row, off by default): REGIONS and DISTRICTS
  draw their units under the lines, each in one of twelve mid-tone colours
  that read on black and white plates alike (the World history layer's),
  picked by the unit's id so it keeps its colour. The fill's own alpha is
  0.35, and the row's opacity applies on top. Tiles took 15 to 98 ms cold.
- **COASTS** (a chip, on by default): COUNTRIES drawn from Overture gets
  the countries' and dependencies' land outlines over its lines, in the
  same ink. A toggle, not "only where a country has no land border": that
  rule misses Indonesia, the United Kingdom and Ireland, Malaysia, Papua
  New Guinea and Haiti, which are mostly coast yet have a land border,
  while a toggle draws every coast alike. It is on by default because an
  island country with no outline reads as no country; off, the basemap or
  imagery shows the shore. LSIB 2017 (without Overture) has its coasts
  already.
- **Antimeridian:** a line's margin over ±180° reached a cell off the grid,
  whose key named another cell. Such runs are now dropped in both builds;
  each is in its own cell anyway. In the boundary lines that was 12 pieces
  of Fiji's region and county lines. `BOUNDARIES_FORMAT` is 3, so
  `npm run overture:boundaries` rebuilds them.
- **Credit:** the same "Boundary lines" credit, registered while fills or
  coasts draw.

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
- **ADD PARCEL AT VIEW CENTRE** lists the property parcel under the middle
  of the view, in Maryland only (see below). Its tag reads PARCEL, and it is
  named from its street address. Outside Maryland the button is disabled
  and says "Maryland parcels only".
- **FIND** takes a place name through the search box's geocoder, then lists
  the areas at the place it finds, the one named like the query first.
- **DRAW** outlines any area by clicking its corners on the map (see
  "Drawing a cutout" below).
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
- A click is a press and a release on the map at most 12 px apart
  (`CLICK_TOLERANCE_PX`); the corner goes where the button went down.
  Cesium's own click allows only 5 px, so a click that wobbled on canopy
  was lost; a left drag does nothing in draw mode, so the wider tolerance
  costs nothing. A longer drag adds no corner and changes nothing in the
  panel, and a press that began on the panel never counts.
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
3. **Maryland's property parcels**, for ADD PARCEL AT VIEW CENTRE: MD
   iMAP's Parcel Boundaries, the statewide polygons from MDP and SDAT.
   - **Upstream:** `https://mdgeodata.md.gov/imap/rest/services/PlanningCadastre/MD_ParcelBoundaries/MapServer/0/query`.
     Layer 0 is polygons, at most 1,000 records a request, as GeoJSON. The
     usual host, `geodata.md.gov`, answered 503 ("emergency maintenance")
     on 2026-10-23. It stays as a fallback, asked only when the first host
     fails.
   - **The app's route:** `GET /api/parcels/md?lat=&lon=` (the parcels
     under a point) and `GET /api/parcels/md?jurscode=&acctid=` (one
     parcel by its key) (`server/providers/mdParcels.js`, the shared code
     in `src/data/mdParcels.js`). It is same-site and GET only, and
     answers `{parcels: [{acctid, jurscode, address, acres, rings}]}`:
     rings in lon/lat, one outer ring per polygon part, holes left out.
   - **Asking upstream:** a point query (`esriGeometryPoint`,
     `esriSpatialRelIntersects`, WGS 84 in and out), a 15 s timeout (45 s for a key: an attribute query, which took 4.7 to 8 s, once over 15 s), the
     app's own User-Agent (`gods-eye-view-md-parcels/1.0`), and one
     request at a time.
   - **Points outside Maryland's box** (37.85–39.76° N, 79.55–74.98° W)
     are refused with 400, and upstream is not asked.
   - **The cache:** each parcel is kept on disk by its key
     (`.gev-cache/md-parcels/<JURSCODE>-<ACCTID>.json`, 30 days), and each
     point's answer in memory for 10 minutes. A reload asks upstream
     nothing.
   - **The fields:** only `ACCTID`, `ADDRESS`, `ACRES` and `JURSCODE` are
     asked for, and only they are kept. The layer also carries owners'
     names and mailing addresses (`OWNNAME1`, `OWNADD1`, `OWNCITY` and so
     on). They are never asked for (never `outFields=*`), stored or shown.
   - **The key:** `mdp:<JURSCODE>-<ACCTID>`, with the account id's spaces
     as `_`, e.g. `mdp:BACI-0327665082_008A`. The rings are fetched again
     by key on reload, like `osm:` and `pack:`. Every kind's pattern is in
     one list, `CUTOUT_SOURCE_PATTERNS` (`src/data/customCutouts.js`).
   - **Measured on 2026-10-23:** at 39.3699327, −76.6131013 it answered
     `0327665082 008A`, 6204 SYCAMORE RD, 1.33 acres, BACI, a ring of 11
     vertices, in about 2 s. A lot that small passes the vertex budget
     untouched.
   - **Maryland only.** Other states' parcels are not wired.
4. **Drawn on the map**, for DRAW (above): no upstream at all. The ring is
   the cutout's source key itself (`draw:…`, see "State and the URL"), so
   it is decoded, never fetched, and never simplified.

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
  `CUTOUT_SOURCE_PATTERNS` in `src/data/customCutouts.js`: `osm:`, `pack:`,
  `mdp:` and `draw:`. A new source adds one line there. Each kind starts
  with its own prefix and is matched whole, so no key reads as another
  kind, and none can hold `~ * !`.
- A reload restores the list and turns the layer on, then fetches the rings
  again (from the proxy's cache). The list holds at most 12 cutouts.
- **Credit:** while cutouts are drawn, the on-screen "© OpenStreetMap"
  credit shows, and the Data attribution popover lists the boundaries as
  OpenStreetMap's (ODbL), through the local Overpass. Once a Maryland
  parcel draws, the popover also names it as "MD iMAP, MDP, SDAT"
  (`MD_PARCELS_CREDIT`).

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
  (`src/layers/customCutouts/draw.test.mjs`);
- the parcels' query and parsing (`src/data/mdParcels.test.mjs`), and
  their route against a mocked MD iMAP
  (`server/providers/mdParcels.test.mjs`; `MD_PARCELS_LIVE=1` adds one live
  request).

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

**A name, but no reach.** When no reach lies within the tolerance but
OpenStreetMap names a waterway at the click, the card gives that name
alone, at the click, with nothing highlighted or traced: "Name only: no
HydroRIVERS reach within 400 m to trace", how far the waterway is, and
where the name came from. The name is the river names sidecar's at the
point (its own radius by the river's size, 150 m for a stream), else a
live one from the local Overpass: one request around the click, a named
river within 400 m or a stream or canal within 150 m, the nearest for its
size winning, kept by the rounded click (`liveNames.nameAt`,
`chooseWaterwayAt`). The answer is a 200 with `nameOnly: true`,
`reach: null` and the `osmName`.

**Where v2 is drawn, its line.** Over the Americas, NETWORK draws
HydroSHEDS v2 (below), whose lines follow the valleys where HydroRIVERS
v1's coarser ones can run a few hundred metres off: at Stony Run,
Baltimore, v2's stream runs north to south 132 m from a click and v1's
reach diagonally 245 m off. While the layer draws v2 there, a click asks
with `v2=1`, and the answer adds `visible`: v2's line nearest the click
within the same tolerance and order limit (`order`, `distanceM`,
`geometry`). It is read from the build's level files
(`server/providers/riversV2/nearest.js`): the level that holds every order
the click may pick (z11 from city heights, coarser ones from higher up),
the one to four cells within the tolerance, at most nine cells in all, in
1 to 5 ms. v2's pieces carry an order and a line only (no id, downstream
link, discharge or name), and a reach crossing cells is cut at them, each
cell's run sharing the segments within the level's margin of the edge, so
the runs are joined again by those shared segments (a confluence shares a
point only, so two reaches are never joined). The amber line is then v2's,
on its casing, with the card on it; v1's reach and its path to the sea
are drawn faint and thin without a casing, and the upstream network
fainter, as the way the water goes rather than the river clicked. The
card's details stay v1's, and a line says so: "Line from HydroSHEDS v2;
details and paths from HydroRIVERS v1" ("Line and details from
HydroRIVERS v1" elsewhere). With no v1 reach near enough but a v2 line
there, the answer is name-only with `visible`: the line is drawn, nothing
traced ("No HydroRIVERS reach within 400 m to trace", "Line from
HydroSHEDS v2"). A v2 read that fails leaves the answer v1's.

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
GET /api/rivers/reach?lat=&lon=&heightM=[&maxOrder=][&upstream=1][&v2=1]
GET /api/rivers/reach/<source>/<id>[?upstream=1]
GET /api/rivers/reach/<source>/<id>/upstream
```

It answers 400 for bad parameters, 404 when no river is within the
tolerance and no waterway is named there (above), 429 past the minute's
budget, 502 when Earth Engine fails and 503 when Earth Engine is not set
up. The tolerance grows with the camera height
(`src/data/riverReach.js`): 0.014 × height, about twelve screen pixels,
never under 400 m nor over 50 km. The floor is HydroRIVERS' own error,
not the click's: v1 is drawn on a 15″ grid (463 m north to south, 360 m
east to west at 39° N) in 45° steps, so a small stream's line runs a cell
or so off its channel. Until 2026-10-26 it was 100 m, and a click on Stony
Run in Baltimore (39.3268, −76.6268) found nothing: its reach 7616601
(0.13 m³/s) lies 245 m from the water. The floor rules up to a camera
height of about 29 km. The nearest reach still wins, so the wider floor
does not take a farther stream in a dense network. The size limit
(`maxOrder`) shrinks with
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
  at the click (`osmName` on the `/api/rivers/reach` answer): the named
  line nearest for its river's size (see below), a named v2 reach before
  OSM's own waterway of the same name (how v1's reaches outside the
  Americas get a name), in its own
  language with `name:en` in brackets when different; then v1's
  `BB_NAME`, "Tributary of …", the basin, and "Unnamed river" only when
  nothing matched. A line under it says where the name came from
  (OpenStreetMap, carried down the main stem, or the nearest waterway).
- Below 150 km, where Natural Earth's names stop, the Rivers layer labels
  the nearest 12 named rivers of Strahler 5 and up in view
  (`/api/rivers/names/labels`), overlay variant `label`, so the panel's
  Titles toggle hides them like the others.
- `GET /api/rivers/names/nearest?lat=&lon=` answers a point's name too.

**The radius follows the river's size** (`nearestRadiusM` and
`chooseNearest`, `server/providers/riverNames/index.js`, since 2026-10-24).
On a wide river a point on the water can lie half the river's width from
the centreline OSM draws, and v2's reach can sit up to the matcher's 250 m
from that line. So one fixed radius missed the wide rivers.

- **Measured from points on the water:**

  | River                      | Strahler order | Distance to its line |
  | -------------------------- | -------------- | -------------------- |
  | Gwynns Falls               | 4              | 124 m                |
  | Potomac at Georgetown      | 8              | 6 m                  |
  | Hudson off Manhattan       | 8              | 584 m                |
  | Missouri at St. Charles    | 9              | 249 m                |
  | Rio Negro at Manaus        | 9              | 823 m                |
  | Mississippi at St. Louis   | 10             | 100 m                |
  | Mississippi at New Orleans | 11             | 292 m                |

  At 150 m, the Mississippi at New Orleans, the Rio Negro, the Missouri and
  the Hudson were all "No named river here".

- **The radii:** 150 m to order 5, 400 m for 6 and 7, 700 m for 8, 1 km for
  9 and 10, 1.5 km for 11, and 2 km from 12. The search reaches 2 km.
- **How a name is chosen:**
  - Each name group found is sized by its largest v2 order there. An OSM
    line counts with its own name's reaches; with none nearby, an OSM river
    gets 400 m and anything else 150 m.
  - A group counts when one of its lines lies within its radius.
  - The group nearest for its size wins (distance ÷ radius). A creek past
    150 m never names a point in a wide river. At Manaus, the Igarapé do
    Quarenta at 503 m (order 3) loses to the Río Negro at 823 m of its 1 km.
  - Within a group, a v2 reach's line speaks before OSM's own.
- **Deltas, braids and confluences:** a channel's own line is near and the
  neighbour's is far for its size, so each names its own water.
  - Checked on the built sidecar: the Paraná de las Palmas and the Paraná
    Guazú, the Mississippi's Southwest Pass and South Pass, and the
    Missouri and the Mississippi just above their confluence all named
    right.
  - With the eight spot points that is 14 of 14, each answered in 0.3 to
    41 ms.
- **River areas are not used yet.** OSM's `waterway=riverbank` or
  `natural=water` + `water=river` would name a point inside a river's
  polygon directly. But the sidecar holds lines only, and the size-scaled
  radius already names all 14 points. Adding the areas means extracting
  them in `npm run rivers:names` and a point-in-polygon step.

**Live names from the local Overpass.** When the sidecar has no name for
a clicked reach, or is not built, and v1 has no `BB_NAME` for it, the reach
endpoint asks the local Overpass once for the named waterway that follows
the reach (`server/providers/riverNames/live.js`). That is
`OVERPASS_UPSTREAMS` through the app's own Overpass transport, never a
public instance.

- **The query** is `way(around:R, <the reach's line>)["waterway"~"^(river|stream|canal)$"]["name"]; out tags geom;`:
  around the reach's own polyline, thinned to about 40 points, not only
  the click.
- **The choice** is the sidecar matcher's (`matchReach`,
  `scripts/rivers/namesMatch.mjs`):
  - the reach is sampled along its length;
  - each sample counts for the names whose nearest segment lies within
    the tolerance and runs within 60° of the reach;
  - the name covering the most of the reach wins, at 40% or more.
  - A crossing stream counts at a sample or two, and a tributary at a
    confluence only near the reach's end. Ways are grouped by name, since
    a river's ways do not all carry its Wikidata item.
- **The tolerance is wider than the sidecar's** because v1's reaches are
  stepped lines on its 15″ grid. Around Baltimore (2026-10-23) the waterway
  lay 63–114 m from its reach on average:
  - 150 m covered only 21–87% of each reach;
  - so it is 250 m at least, and from there the river's size as the point
    lookup sizes it: RIV_ORD 5 (10–100 m³/s) as Strahler 6 (400 m), 4 as
    8 (700 m), 3 as 11 (1.5 km), and 1 or 2 as 12 (2 km)
    (`liveToleranceM`). The coverage and the 60° angle checks keep a
    neighbouring channel out.
- **What the five test reaches got**, each in 0.4–1.0 s:
  - 7617971: Gwynns Falls, 83% of the reach, mean 103 m off.
  - 7619123: Patapsco River, 89%, 100 m.
  - 7617765: Jones Falls, 92%, 81 m.
  - 7617526 and 7616599: Gwynns Falls, 97% and 94%.
  - At the Gwynns Falls/Gwynns Run confluence, Gwynns Run covered 17%.
- **Kept with the reach:** the answer is stored as `<id>.osmname.json`
  beside the reach's own file (180 days), including when no waterway
  follows the reach. A second click asks nothing.
- **Budget:** one request a click at most, 10 s (`LIVE_TIMEOUT_MS`). A
  failed or slow Overpass is not kept, and the card shows what it had
  before, never an error.
- **On the card,** the name order is:
  1. the sidecar's (direct, then carried down the main stem, then its
     nearest waterway);
  2. the live name;
  3. `BB_NAME`;
  4. "Tributary of …";
  5. "Unnamed river".
- **`BB_NAME` stays authoritative:** a reach it names is never looked up
  live, and the card prefers `BB_NAME` to a live name unless the two
  agree. The Susquehanna stays the Susquehanna.
- **The line under the title** reads "Name from OpenStreetMap (nearby
  waterway), © OpenStreetMap contributors, ODbL". That is the ODbL
  credit, as for the sidecar's names.
- **Not done:** the "Tributary of …" fallback does not look downstream
  live. It would cost a request per segment, and the sidecar build names
  those reaches once it lands.

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

MapChart-style world maps, painted as a globe imagery layer: six entries
in the picker's **Countries** group, three styles in a dark and a light
theme. They are map sources, not data layers, so a countries style is the
ground everything else sits on.

| Style        | What it draws                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Simple       | Every country as one fill with a dark (light theme) or light (dark theme) outline, like MapChart's Simple map.                                                                                                                                                                                                                 |
| Subdivisions | The simple map, plus the first-level units (states, provinces, regions) as thinner outlines on tiles of level 4 and finer, which stand for camera heights under 5,000 km.                                                                                                                                                      |
| Hex          | Land as H3 cells at the resolution the camera height picks (see [H3 hexes](#h3-hexes-resolution-by-perspective)), each coloured by the country under its centre from a ten-colour palette: the "war games" look. A country with no cell centre on it still gets the cell of a point inside it, so Iceland is there from orbit. |

**Geometry.** The bundled Natural Earth packs
(`src/data/local_data/natural_earth/countries.json`, 260 countries, and
`states_provinces.json`, 4,587 units; public domain, provenance in that
folder's README), loaded on first use with `loadBundledJson`. Nothing is
fetched from the network and no server route is involved: the packs were
already in the tree for the voice annotation resolver, simplified at
0.005–0.02° with holes kept (Lesotho is a hole in South Africa). The task
asked for a download script and a `.gev-cache/natural-earth/` cache; the
packs make both unnecessary.

**Rendering** (`src/maps/countries/renderer.js`, `tiles.js`). The renderer
adds one imagery layer at the bottom of `viewer.imageryLayers`, the slot a
tile basemap's imagery takes, so every draped overlay (World history,
Administrative boundaries, Rivers, the Earth Engine layers) lies over it,
as over Toner. Until 2026-10-26 the countries were `PolygonGeometry` and
`PolylineGeometry` primitives a little above the globe, and every draped
overlay went under them: World history's fills at 1 AD were invisible on
`countries-simple-dark`, only their names showing.

- **The tiles.** Its provider paints each 256 × 256 tile of the geographic
  tiling (every longitude and both poles; Web Mercator would stop at
  85°) on a canvas, as the World history painter does. Each tile gets:
  - the parts whose box crosses it, filled one path per colour (even-odd,
    so holes are cut) at the basemap's opacity;
  - on the subdivisions style, the first-level units' outlines;
  - the country outlines over the fills, solid.
    The ocean is the globe's base colour showing through.
- **Levels and heights.** A level-z tile pixel matches a camera height of
  54,800 km / 2^z (one pixel of a level-z tile is 78.3 km / 2^z, a screen
  pixel height / 700 m looking down). So the 5,000 km ceiling of the
  first-level units is level 4.
- **Hexes.** One resolution for the whole screen, the camera height's: by
  tile level, tiles of several levels side by side mixed hexes of several
  sizes, with a seam where they met. A camera move that changes the
  resolution swaps the layer. A tile on which the hexes would be under
  8 px (towards the horizon) paints the countries in their hex colours
  instead of thousands of hexes too small to see. The land of a cell, the
  small countries' own cells and the cells' rings are cached across tiles.
- **The antimeridian and the poles.** Natural Earth cuts its rings at ±180°,
  so no fill runs across a tile. A hex ring runs on past ±180° and is drawn
  shifted by a turn on the far tile. The edges of the cuts (along ±180°, or
  along a pole) are left out of the outlines, so no line runs down the
  antimeridian through Chukotka or up a meridian from the south pole.
- **Changes.** Imagery tiles cannot be repainted in place: a change of
  style, theme, opacity, a country's colour or a cell's colour swaps in a
  new provider and layer at the same index. A late pack load after the
  stack has moved on draws nothing.
- **Measured** on 2026-10-26 in headless Chrome (Cesium 1.138, ANGLE
  D3D11, 1280 × 800):

  | View                        | Tiles | Paint per tile                                      |
  | --------------------------- | ----- | --------------------------------------------------- |
  | Global (20,000 km)          | 15–17 | 4.1–4.9 ms (simple, subdivisions); 0.2–0.4 ms (hex) |
  | Regional (2,500 km, Europe) | 34–49 | 0.7–1.9 ms (simple, subdivisions); 1.6 ms (hex)     |

  The hex style's first resolution 3 view also pays 171 ms once for the
  small countries' cells. Painting runs on the main thread inside
  `requestImage`, at most a few ms a tile, so no worker or OffscreenCanvas
  was needed.

**Draped overlays.** They lie over the countries at any opacity. The fill
opacity is still the basemap's own:

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

**Tests** (`src/maps/countries/countries.test.mjs`) paint tiles on a
recording canvas and run the renderer on a fake layer stack:

- against the committed packs: France at level 3 (Paris filled, the North
  Sea not), Fiji on both sides of the antimeridian with no ring across a
  tile, Chukotka's outline without the cut, Antarctica to the pole;
- against the committed fixture `src/data/fixtures/countries-basemap.json`
  (Iceland, Lesotho, South Africa and Switzerland, with the first-level
  units of the first two, cut from the packs): Iceland's hex at level 0, a
  cell colour winning, the coarse-tile fallback;
- the layer at index 0 under overlays added before and after it, a fresh
  layer at the same index for a theme, opacity, country or cell colour,
  the subdivisions from level 4, one hex resolution by camera height, and
  a failed or late pack load. The wiring (share links, voice enum and aliases such as "hex map",
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
| World history (`world-history:build`)          | stamped files, `current.json`                             | redone (under a minute); an unchanged input is skipped                                                                                             |

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

### Lego with the Google 3D tiles: Relief ×N and Photoreal on bricks

The colour and Lego renderings of elevation read well alone but not over
the photoreal tiles. Two prototypes show elevation together with the
Google 3D tiles (`src/layers/lego/photoreal.js`). Both are off by default,
set beside the Render drop-down under the **ANALYSIS** heading, and kept
in the share link as `lp`:

- `lp=3` is Relief ×3;
- `lp=1.b` is Photoreal on bricks (AUTO; `1.bl` LIFT, `1.bt` TEXTURE, a
  trailing `c` the sides in colour);
- `lp=3.b` is both.

A link with `.b` turns Lego mode on. Once the layers are restored it also
turns on Elevation, when no Lego layer is on.

**A: Relief ×N** (×1, ×2, ×3, ×5; ×1 is off). It sets Cesium's own
`scene.verticalExaggeration`, which 3D Tiles follow since Cesium 1.116
(the Model's vertical exaggeration stage).

- The tiles are exaggerated, and so is the globe's terrain where it shows
  (the Custom cutouts plate, other maps). The Lego bricks are not.
- `scene.verticalExaggerationRelativeHeight` is the true ground under
  the middle of the view: a depth pick there, turned back from the drawn
  height. That point stays where it is, so the view does not jump when
  the relief comes on.
- The anchor moves only when the view settles more than one camera
  height away from it. At that moment the ground around shifts by
  (new − old anchor) × (N − 1).
- **Picks** read the exaggerated positions: the depth pick
  (`scene.pickPosition`) and Cesium's CPU pick of the tiles (`pickModel`,
  which applies the exaggeration) alike. The camera's ground guard is
  Cesium's, and it follows the exaggeration too.
- **Custom cutouts** clip in plan (`ClippingPolygonCollection`), so they
  are unaffected. The plate, the globe's ellipsoid, moves by
  anchor × (1 − N) and stays under the cut tiles.

**B: Photoreal on bricks.** While Lego mode draws its bricks over a shown
3D tileset, the tileset carries a `CustomShader` whose vertex stage lifts
each Lego cell's patch of the photoreal mesh by that cell's lift. The
photoreal surface then stands on its brick, and the brick sides are the
Lego layer's own.

- **The lift** (`cellLifts`) is the brick's top less the ground the tiles
  draw there:
  - The top is the column's base plus its bricks.
  - The ground is the DEM height (the column's base, or elevation's own
    value) plus the geoid's height at the window's centre (EGM96, from
    `src/data/geoid.js`). Lego stands its columns on DEM heights read as
    ellipsoidal, while Google's mesh is ellipsoidal: at Baltimore that
    is 33 m.
  - Under the relief, the ground is exaggerated as Cesium does it. The
    exaggeration stage runs before the custom shader, so the lift is
    measured from the exaggerated ground.
  - A cell without a column, or without a known ground, is not lifted.
- **The texture:** one texel a cell (at most 512 × 512), north row
  first, RGBA bytes. RGB is the lift in decimetres from −1 km (24 bits:
  −1 km to +1,676 km), and A is 255 where the cell is lifted. It is read
  with NEAREST filtering at the cell's centre, so no float textures are
  needed.
- **The vertex stage:**
  1. The vertex in eye coordinates (Cesium's precise model-view) goes
     into the window's east-north-up frame at its centre, through
     `u_ecToWindow`: the frame's world-to-ENU times the camera's inverse
     view, composed in doubles each frame on `scene.preRender`.
  2. It goes down to the ground under it: the tangent plane is
     1 + h/R farther out at height h.
  3. Then to latitude and longitude by a short series, with no trig per
     vertex: the north offset less the parallel's rise (x² tan φ / 2Rn),
     over Rm, and the east offset over Rn cos φ, with cos φ to first order
     about the centre.
  4. Then to the window's uv and its cell. The cell's lift is added along
     the window's up vector in model coordinates
     (`mat3(czm_inverseModel)`).
  - Over 447 cells a side, the mapping's worst error at the window's
    corners is 0.02 m at a 22 m cell (a 10 km window), 0.7 m at a 112 m
    cell (50 km), and 7 m at a 280 m cell (125 km at Rainier's latitude):
    under 3% of a cell, the same at 0 m and 4,000 m.
- **The lifecycle:**
  - The shader goes on the shown tileset when the bricks are built, and
    off on Lego off, Colour, a flat map, a map switch (onto the new
    tileset if there is one), the store's switch off, and destroy.
  - A custom shader the tileset had is given back, and the old shader is
    freed after the next frame.
  - A moved window, or a changed relief, keeps the shader and sets new
    uniforms: the lift texture, the frame, the box and the cells.
- **Edges: hard.** A fade of the lift to zero over a band at each cell's
  edge (`u_edgeBand`, 0.15 of a cell tried) was worse in every view. It
  turns every cell edge into a slope, and more of the tiles are stretched
  (below).

**Limits.**

- **Curtains:** a triangle whose corners fall in cells of different
  lifts is stretched between them. Cells differ wherever their brick
  counts do, which on any slope is most of them. The share of the frame
  is in the table below.
- **Picks:**
  - A depth pick (`scene.pickPosition`: the Lego card, the annotation and
    cutout drawing tools) reads the lifted surface, which is what is
    seen.
  - Cesium's CPU picks of the tiles (`Cesium3DTileset.pick`, the camera's
    collision with the tiles) read the mesh unlifted, so the camera can
    go below a lifted patch.
  - `unliftHeight(lon, lat, height)` turns a picked height back by the
    cell's lift for any caller that wants the tiles' own. Nothing calls
    it yet.
- **The window's edges:** outside the Lego window nothing is lifted. Its
  edge is a step as tall as the lifts there, and the brick sides do not
  cover it.
- **Relief and bricks together:** inside the window the tiles stand on
  the bricks as drawn. With Lego at 1× (its default on photoreal) and
  Relief ×3, that undoes the relief inside the window, and the window's
  edge is then a step of about twice the ground's height above the
  anchor.
- **Only on Google 3D in 3D mode:** the lift needs the camera's 3D
  inverse view.

**Measured** on 2026-10-25 in headless Chrome, with Cesium 1.138 on the
machine's GTX 1080 Ti through ANGLE D3D11, 1280 × 800. The Google tiles
can't be fetched there, so each view has a synthetic one-tile stand-in:
a 1,000 × 1,000 heightfield mesh (2.0 M triangles; 10 m, 60 m and 150 m
apart; a city of 6–76 m blocks on rolling ground, rolling country, and
a 4,392 m cone with ridges). Over it is the Lego elevation window the
view builds (447 × 447 cells of 22, 112 and 280 m; 161,000 to 200,000
columns). The camera looks north at −45°, from 2 km over Baltimore
downtown, 20 km over the Baltimore region, and 50 km over Mount
Rainier. Frame times are `scene.render()` plus `gl.finish()`, 240
frames, median / 95th percentile in ms:

| View           | Tiles only | Relief ×3 | Bricks    | Bricks, lifted | Relief ×3, lifted |
| -------------- | ---------- | --------- | --------- | -------------- | ----------------- |
| City, 2 km     | 0.6 / 1.3  | 0.3 / 0.5 | 0.2 / 0.4 | 0.2 / 0.3      | 0.2 / 0.3         |
| Region, 20 km  | 0.3 / 0.7  | 0.3 / 0.5 | 0.2 / 0.4 | 0.2 / 0.3      | 0.2 / 0.3         |
| Rainier, 50 km | 0.8 / 1.4  | 0.9 / 1.5 | 0.4 / 0.6 | 0.2 / 0.4      | 0.3 / 0.4         |

Neither prototype costs a measurable frame time here: all of it is under
1.5 ms, and the differences are the run's noise. With Lego at 3× the
frames were the same (0.3 to 1.0 ms medians).

The curtains, from the shader's debug colours (`u_debug`: a triangle
whose corners were lifted differently red, the rest blue), unlit and
counted, with Lego at 1×:

| View           | Of the tiles' pixels (bricks hidden) | Of the frame, bricks drawn | With the 0.15 edge band |
| -------------- | ------------------------------------ | -------------------------- | ----------------------- |
| City, 2 km     | 29%                                  | 24%                        | 79%                     |
| Region, 20 km  | 66%                                  | 29%                        | 80%                     |
| Rainier, 50 km | 85%                                  | 38%                        | 98%                     |

With Lego at 3× the hidden-bricks shares were 30%, 76% and 85%. The
curtains grow with the triangles' size against the cells', and Google's
mesh keeps its triangles about the same size on screen, so the synthetic
spacing stands in for it.

**To see them live** (any dev server; the hash is the share link's):
Baltimore downtown from 1.5 km, oblique (the camera 2.1 km south of the
Inner Harbor); the Patapsco valley from 8 km (11.4 km south of
39.24° N, 76.75° W); Mount Rainier from 25 km (29.4 km south of the
summit); all looking north at −35°, with `lp=3`, `lp=1.b` or `lp=3.b`:

```
#lat=39.2664&lon=-76.6097&alt=1500&heading=0&pitch=-35&roll=0&map=photoreal&lp=3.b
#lat=39.1374&lon=-76.7500&alt=8000&heading=0&pitch=-35&roll=0&map=photoreal&lp=3.b
#lat=46.5879&lon=-121.7603&alt=25000&heading=0&pitch=-35&roll=0&map=photoreal&lp=3.b
```

**Far out: textured brick tops** (`src/layers/lego/topTexture.js`). The
lift reads at city scale. Far out, Google's triangles grow while the
cells don't, and the frame is mostly curtains (above). So beyond a camera
height each brick's top is textured with its cell's patch of satellite
imagery instead, and the photoreal tiles are cut away under the bricks.

- **Three modes,** in a drop-down beside the checkbox:
  - **AUTO** (the default) lifts the tiles close in and textures the tops
    above 20 km (`AUTO_TEXTURE_HEIGHT_M`). It switches at 22 km on the
    way up and 18 km on the way down, so hovering at the threshold
    doesn't flap. The threshold is where the measured curtains pass 30%
    of the frame with the bricks drawn: 24% at 2 km, 29% at 20 km and 38%
    at 50 km put 30% at about 22 km.
  - **LIFT** and **TEXTURE** always draw one way.
  - Re-decided when the camera settles.
- **The sides,** in TEXTURE: **tint** (the default) is the top's imagery
  at the column's centre at 0.55 of its brightness; **colour** keeps the
  layer's own colour. Both are measured below.
- **The imagery:** Esri World Imagery, the imagery the app's map stacks
  already use (`src/maps/imagery.js`). No Google 2D satellite session
  exists in the app, so the first choice in the brief wasn't available.
  Esri's public Web Mercator tiles need no key, and the page fetches
  them with CORS. An offscreen top-down render of the Google tiles wasn't
  needed.
  - **The zoom:** the one that gives about 6 texels a cell (`zoomForWindow`),
    lowered until the window fits 4,096 px a side, at most Esri's z 18.
  - **The stitching** (`stitchPlan`): the tiles covering the window go
    into one canvas cropped to the window's mercator box. A window across
    the antimeridian unwraps, and its tile x wraps.
  - **Fetching:** six tiles at a time (`buildTopTexture`). A tile that
    fails is left blank, and the build is async and cancellable: a moved
    window aborts the build before it, and a build that lands late is
    dropped. Until the imagery is in, the tiles stay lifted. A failed
    window is not asked for again until the window moves.
- **On the bricks:**
  - Every brick vertex carries its longitude and latitude less the
    window's centre (a side's, its column's centre), in a second vertex
    buffer (`lonLat`).
  - The brick shader turns that into Web Mercator, the canvas's UV
    (`u_merc`), and samples the texture: RGBA8 with mipmaps (WebGL2),
    CLAMP_TO_EDGE.
  - The studs and bevels shade on top of the imagery.
  - A new Lego build (a new primitive, same window) gets the kept texture
    again without a fetch.
- **The tiles under the bricks:** the tile shader's `u_hide` stops the
  lift and discards every fragment in a cell that has a brick. The tiles
  stay outside the window and in cells without one.
- **Credit:** while the textured tops draw, "Powered by Esri — Source:
  Esri, Maxar, Earthstar Geographics, and the GIS User Community" shows
  in the on-screen credits, and the data popover lists it.
- **The `lp` URL:** backward compatible.
  - `.b` is the bricks, by height (AUTO) with tinted sides, so the links
    from before (`1.b`, `3.b`) read so.
  - `.bl` is LIFT and `.bt` is TEXTURE.
  - A trailing `c` keeps the sides in colour (`1.btc`, `1.bc`).

**Measured** (2026-10-25, the same headless Chrome on the GTX 1080 Ti,
1280 × 800, the synthetic stand-ins, the camera north at −45°). The
imagery tiles were drawn in the page (no network), so the build time
below is stitching and upload only. Live, it is the fetch of the tiles
listed, six at a time.

| View                  | Window cells  | Texture     | Tiles (zoom) | GPU, with mipmaps | Stitch | Lifted    | Textured, tint | Textured, colour |
| --------------------- | ------------- | ----------- | ------------ | ----------------- | ------ | --------- | -------------- | ---------------- |
| Rainier, 25 km        | 447² of 140 m | 2395 × 2395 | 110 (z 12)   | 30.6 MB           | 19 ms  | 0.4 / 1.0 | 0.2 / 0.3      | 0.2 / 0.3        |
| Rainier, 50 km        | 447² of 280 m | 2395 × 2395 | 110 (z 11)   | 30.6 MB           | 21 ms  | 0.2 / 0.4 | 0.2 / 0.3      | 0.2 / 0.3        |
| Patapsco valley, 8 km | 447² of 45 m  | 2709 × 2708 | 121 (z 14)   | 39.1 MB           | 22 ms  | 0.2 / 0.5 | 0.2 / 0.3      | 0.2 / 0.3        |
| Grand Canyon, 40 km   | 447² of 224 m | 3243 × 3243 | 182 (z 12)   | 56.1 MB           | 40 ms  | 0.2 / 0.5 | 0.2 / 0.3      | 0.2 / 0.3        |

Frame times are median / 95th percentile in ms, 240 frames. Bricks
alone were 0.2 / 0.3 at every view, and tiles alone 0.3–0.4 medians.
The texture costs no frame time measurable here. The window's texture is
the one GPU cost of note: 31 to 56 MB (5.4 to 7.3 texels a cell), freed
when it comes off.

The textured tops have no curtains: the imagery runs on across the
stepped tops, and the brick sides carry the relief.

- **Its limits:**
  - The tops are flat: no 3D buildings or trees in the window, only the
    imagery's 2D view of them.
  - Esri's imagery is not Google's: colours and dates differ at the
    window's edge, where the tiles start again.
  - The tiles are fetched from Esri for every new window: 110 to 182 at
    the four views.

**AUTO links for a look,** all looking north at −35° from south of the
place:

- Mount Rainier from 25 km (29.4 km south of the summit) and from 50 km
  (65.1 km south): both textured;
- the Patapsco valley from 8 km: AUTO lifts there (`lp=1.bt` forces the
  texture);
- the Grand Canyon from 40 km (54.1 km south of 36.10° N, 112.10° W):
  textured.

```
#lat=46.5879&lon=-121.7603&alt=25000&heading=0&pitch=-35&roll=0&map=photoreal&lp=1.b
#lat=46.2672&lon=-121.7603&alt=50000&heading=0&pitch=-35&roll=0&map=photoreal&lp=1.b
#lat=39.1374&lon=-76.7500&alt=8000&heading=0&pitch=-35&roll=0&map=photoreal&lp=1.b
#lat=35.6138&lon=-112.1000&alt=40000&heading=0&pitch=-35&roll=0&map=photoreal&lp=1.b
```

Tests (`src/layers/lego/photoreal.test.mjs`, `src/layers/lego/topTexture.test.mjs`):

- the `lp` round trip;
- the lift, with the geoid and the relief;
- the texture's packing and its decode, which the shader shares;
- the ENU mapping against exact geodetic positions at four windows, on
  the ground and 4,000 m up, every tested cell centre in its own cell;
- the uniforms and the world-to-window matrix;
- the lifecycle on stubs: on, a window move, Lego off, a map switch, a
  globe map, a flat map, the switch off, destroy;
- the relief's anchor, re-anchoring and reset;
- the tile zoom at real windows (4 to 8 texels a cell, at most 4,096 px), the
  stitching (one tile, across tile boundaries, at and across the
  antimeridian), the mercator UVs, the mesh's per-vertex places;
- the AUTO switch and its hysteresis, LIFT and TEXTURE;
- the build: tiles placed, a failed tile left blank, a cancel stopping it;
- the textured lifecycle on stubs: lifted until the imagery is in, then
  textured with the tiles cut away and the credit shown, the sides
  switched, a new primitive given the kept texture, a window move
  cancelling the build before, coming down lifting again, a failed window
  not retried, off taking it all off.

## Blocks

A third **Render** mode beside Colour and Lego: the ground around the
camera as cubes on a grid fixed to the world, the way Minecraft shows
terrain, read by shape and light rather than by a colour ramp. The design,
the decisions and the module contracts are in `docs/BLOCKS-PLAN.md`; the
code is `src/layers/blocks/` (grid, store, mesh, lighting, source,
structures, the mesh pool, renderer and the controller) with its wiring
in `src/app/blocks.js`.

**Turning it on.** The drop-down beside the **ANALYSIS** heading reads
**Render: Colour / Lego / Blocks**, kept as `gev.render.mode` like the
others. Blocks needs the **Elevation** layer on; without it nothing is
built and the line under the heading says "Blocks needs the Elevation layer
on". With it, the line says what is drawn: "Blocks: 1 m cubes · 412 chunks
· 3DEP 1 m" (the block size, the chunks drawn, the elevation source;
"274 + 48 coarse" with the coarse ring), with
"· study sun" when the real sun is under 15°, "· 1,204 buildings" when
buildings are drawn, and "· N loading" while chunks are still coming. The
share link carries it as `bk=1`: a link with `bk=1` opens in Blocks
without overwriting the stored mode, and a link without `bk` (every link
from before Blocks) keeps the stored mode as before. While Blocks draws, the HUD's floor note beside AGL
names the blocks ("· Blocks 1 m") and the camera readout's precision stops
at the block size, as it does for any surface.

**The grid.** A region is a local east-north-up frame anchored near the
camera with one block size, the elevation source's own cell there: 1 m on
3DEP lidar, 10 m on 3DEP 10 m, 30 m on FABDEM, 2 m on ArcticDEM. Columns
are integer steps east and north of its origin, levels integer steps up
from mean sea level, chunks 64 columns a side. A column at or below 0 m is
water at sea level; below the top every block is filled. The store keeps an
edits overlay per chunk from the start (for later breaking and stacking).

**Where sea level is.** Lego's rule. On flat ground (no photoreal tileset
and the globe on Cesium's ellipsoid terrain) level 0 is drawn on the
ellipsoid, so the blocks stand on the globe as Lego's columns do. On
terrain or the photoreal tiles, whose heights are ellipsoidal, the region
is lifted by the EGM96 geoid undulation at its origin (about −33 m at
Baltimore), so level 0 lands on the sea surface; a geoid that cannot be
read lifts nothing. The controller hands the renderer
`setRegion(region, { datumOffsetM })` and anchors the region again when the
ground flips (a new map stack). The blank basemaps keep the globe's terrain
(World Terrain with an Ion token, Re:Earth's keyless terrain without), so
they are terrain here unless the terrain is flat.

**When it waits.** Every chunk is Earth Engine data the user pays for, so
Blocks builds nothing (no region anchored, nothing loaded) while the
camera is higher above the ground than 4 × R2 × the block size (8 km at
1 m, 246 km at 30 m; 100 km before a region says the block size), or while
a camera flight is in progress or an arrival correction still owns the
camera (`cameraInFlight`: Cesium's flight, or `cameraArrivalPending` in
`src/data/cameraArrival.js`, the ground guard's). The line says why
("Blocks: come below 8 km to build", "Blocks: waiting for the camera to
land"), and what is drawn already stays. Through a flight or arrival on a
drawn style the globe stays hidden (Blocks builds where it lands, and a
shown globe would have the Elevation layer fetch colour tiles for nothing,
about 127 Earth Engine tiles a session opening into Blocks); too high to
build, the globe shows. The first
region is anchored where the camera settles: on the first `moveEnd` below
the ceiling, or on the tick after a flight's correction lets go. (On
2026-10-27 it anchored at the opening orbit, 17,000 km up, and loaded
500 chunks there.)

**Streaming** (`src/layers/blocks/index.js`). On the camera's `moveEnd`,
and every 500 ms while it moves or while chunks are still coming, the
controller:

- anchors a region at the camera on the first tick, asking the source for
  the block size there, and anchors a new one (every chunk replaced) when
  the camera is more than 20 km from the origin, or twice the render
  distance for coarse blocks (31 km at 30 m);
- lists the chunks within the render distance R1, 512 blocks (512 m at
  1 m, 15 km at 30 m), in whole groups of 4 × 4 chunks, nearest first: a
  chunk's distance is from the camera's column to the nearest point of
  the chunk's square, so the camera's own chunk comes first, then those it
  touches;
- beyond them, out to R2 = 4 × R1 (2 km at 1 m), a coarse ring: one chunk
  per group, 64 × 64 columns at four times the block size
  (`source.loadCoarseChunk`), drawn under a `c:gi:gj` key from the group's
  south-west corner. A coarse chunk is drawn until all 16 fine chunks
  under it are, removed then, and drawn again (its mesh kept) when one of
  them is dropped; fine chunks go a group at a time, so a group is drawn
  either fine or coarse. The coarse chunks have a load budget of their
  own; a supergroup (the source's coarse request, 4 × 4 groups) all of
  whose groups lie within R1 is not asked for at all, since its coarse
  chunks would never be drawn. A region is anchored half a supergroup
  (512 blocks) south-west of the camera, so the camera starts in the
  middle of one: the fine ring then reaches into as few supergroups as it
  can (fewer Overpass queries) and the central supergroup is skipped;
- starts loads until 8 are in flight, and meshes at most 8 chunks a tick,
  each with its four neighbours so the faces on a chunk's border are culled
  against them; a chunk is meshed again when a neighbour arrives or its
  version changes (an edit);
- drops chunks only beyond 1.25 × their ring (640 blocks fine, 2,560
  coarse), so a camera going back and forth does not reload its edge;
- asks a chunk that failed again after 2 s, 4 s, 8 s … (at most a minute),
  six tries in all; the budget doubles for 30 m blocks.

A fine chunk is not meshed while a neighbour in the ring is still to
come (at the ring's edge the neighbours beyond do not count), so a fresh
chunk is meshed once rather than once per neighbour landing; a mesh that
fails is tried again after the loads' backoff. A result that lands after
Blocks was left is drawn into the hidden renderer but says nothing.
Each chunk is meshed with its eight neighbours: the four it shares a side
with (border faces) and the diagonals (ambient occlusion at its corners).
A neighbour not loaded yet reads as the edge column repeated, so no wall
shows at the edge of what is loaded, and the chunk is meshed again when a
neighbour arrives. Where the fine ring ends, a fine chunk whose neighbour across
a border is neither loaded nor coming hangs a skirt there: its edge
columns' sides run down to the lowest ground of the coarse chunk beyond
(four fine levels to a coarse one), so the 1 m edge meets the 4 m ring
without a seam of background showing between them. It is meshed again
when that coarse chunk arrives. The other way round, a coarse chunk
beside a group drawn fine leaves that group's hidden coarse chunk out of
its neighbours and hangs a skirt toward it, down to the group's lowest
fine ground (in coarse levels), for where the coarse ground is the higher;
no skirts toward other coarse chunks.

**Buildings.** OpenStreetMap buildings stand on the fine ring as stacked
blocks (`structures.js`, worker2's): one Overpass query per 4 × 4 group
through the app's `/api/overpass`, each footprint filled onto the columns
with its levels from its tags (worker2's roofs and parts: `height` or
storeys, `min_height` for a part that starts above the ground) and put
into the chunk's structures layer, between the terrain and the edits; the
source takes its ground from the elevation source's same chunks. A chunk asks for its buildings once its terrain is in; when
they arrive its version moves on and it is meshed again. Never on the
coarse ring. A **Buildings** switch sits beside Render while Blocks is on:
on unless turned off (kept as `gev.render.blocksBuildings`, and in the
link as `bk=1.b0`; `bk=1` reads as before) or until Overpass answers that
it is not configured, which ends buildings for the page and greys the
switch with the reason. Turning it off takes the buildings off every chunk
in place (their columns cleared, the chunks meshed again); on puts them
back from the source's cache. A failed query is asked again with the
chunks' backoff. The status line counts the buildings drawn, each once
across groups, once every drawn group's buildings and ids are in
("· buildings…" until then), so two looks at the same place agree. The fine groups ask for their buildings a supergroup (4 × 4
groups) at a time: one Overpass query over the supergroup's box, each
group keeping the footprints that reach into its own box and taking its
ground from its own chunks (the per-group query stays for other callers).

**Meshing off the main thread.** Chunks are meshed by the worker pool
(`meshPool.js`, worker1's: `meshChunkAsync`, buildChunkMesh's arguments,
a promise of its mesh), none twice for the same inputs. With the pool a
tick starts up to 24 loads and submits up to 24 meshes, fine and coarse
each (8 without it), and submits none while the pool has more than twice
its workers' jobs queued: the pool, not the tick, is the bound. A mesh that comes back after its chunk moved on (its
version, a neighbour, a skirt), was dropped, or the region was anchored
again is thrown away and the chunk meshed from what it is now. Where
Workers cannot be made the pool meshes in-thread.

**Sun and fog.** The sun is read at the camera when the region is
anchored and every minute after (`SUN_TICK_MS`): the real sun when it is
more than 15° up, otherwise the study sun, 45° up from the north-west
(the cartographer's hillshade light, `lighting.js`). It is NOAA's solar
position on the wall clock (`src/data/solarDaylight.js`), the one the
HUD's SUN reads, so "· study sun" and the SUN readout agree. mesh.js bakes
it into the colours with per-face shading and ambient occlusion, so when
it changes (the real sun against the study sun, or the real sun 3° on,
about twelve minutes) every chunk is meshed again, nearest first. Fog
closes in from 70 % of the farthest ring drawn to its edge (R2 with the
coarse ring, 1,434 to 2,048 m at 1 m; R1 without it), toward what lies
behind the blocks: the horizon sky when the sky atmosphere is shown and
the camera is under 20 km, so the far ring melts into the sky at eye
level; otherwise the scene's background (black on blank-black).

**The globe.** Within the render distance the world is the blocks. On a
drawn style (blank, Positron, dark, Countries: `isFlatBasemap`) the globe
is hidden while Blocks is on, the terrain beneath would otherwise poke
through the block tops, and the fog hides where the blocks end. Leaving
Blocks, or turning Elevation off, shows it again. On imagery and the
photoreal tiles the globe stays (the ground and the block tops still
fight there for now); on a switch to another map Blocks leaves the globe
as the map stack set it. While the globe is hidden, draped overlays have
nowhere to go: the Elevation row says "Shown as blocks", others say the
map hides them, and every Earth Engine layer drapes again the moment
Blocks shows the globe, without a camera move (`src/layers/blocks/floor.js`
tells them). Blocks needs the Elevation layer's toggle on, not its drape,
so a drape that finds no host under the hidden globe does not turn Blocks
off.

Turning
Elevation off, or picking Colour or Lego, hides every chunk and keeps the
region for 60 s (the renderer's `setVisible`), so coming back is instant;
after the minute they go. The
renderer is made the first time a region is anchored, so a page that never
picks Blocks adds nothing to the scene.

**The comparison harness** (`scripts/qa-blocks-compare.mjs`). Milestone 1
is judged by eye: Blocks should read elevation better than the colour map.
The script opens a production build in headless Chrome at map=blank-black
with Elevation on at Baltimore (lat 39.3214, lon −76.6292, 300 m up,
heading 0, pitch −30), once in Render: Colour and once in Render: Blocks
(`bk=1`), and writes `colour.png` and `blocks.png`; a second pair,
`colour-eye.png` and `blocks-eye.png`, from the same place at eye level
(1.7 m above the top of the block underfoot, looking 5° down; `--views
judgement,eye` is the default, either alone with `--views eye`):

```sh
node scripts/qa-blocks-compare.mjs --build --out <a directory outside the repository>
node scripts/qa-blocks-compare.mjs --dist <an existing vite build> --out <dir>
```

No server and no port: request interception serves the build's files, and
answers `/api/raster/values` and the Elevation layer's Earth Engine catalog
and tiles from a synthetic heightfield (64 × 64 cells at 10 m, 600 m north
of the camera: a hill to 77 m, a spur, and a river valley cut to 2 m),
served at 1 m as 3DEP's lidar is (read between the 10 m cells) and tiled
by reflection beyond its edges, so the blocks have the live size and the
coarse ring has ground to 2 km; painted in the PET rainbow over 0 to
100 m for Colour; `/api/overpass` answers a small synthetic town north of
the camera (seven footprints, 6 to 80 m, by height, storeys or neither;
one starts 6 m up, `min_height`, so a hollow shows under it),
so the Blocks shots show buildings.
Other `/api/` routes answer 404 and other hosts are refused, the terrain's
too, so the globe there is flat ground and the shots show the flat case
(offset 0). The script
prints each shot's status line, how many values and tiles it answered, and
any page error, and writes `report.json` beside the PNGs (the status lines,
requests by kind, the fresh ring's time).

With `--live http://localhost:4173` the harness takes real data from an app
server that is already running (it never starts one, and stops with a
message when none answers): `/api/raster/values`, `/api/overpass` and the
Earth Engine catalog and tiles go to it, so both shots of a pair show the
same real ground; the build and every other route stay intercepted. The
eye-level view stands on the live ground under the camera (one values
probe), and the report adds each live route's answers by status, time and
bytes.

**Tests.** `src/layers/blocks/controller.test.mjs`, on a fake grid,
source, renderer and camera: the ring's order, the budget, re-meshing on a
neighbour or a version, the hysteresis, re-anchoring at 25 km, the
Elevation-off and Colour cases, the tick, failures (no values service, a
chunk that fails), the datum offset (0 on flat ground, the geoid on
terrain, a re-anchor when the ground flips, 0 when the geoid fails), the
status line and the HUD floor; the coarse ring and its handover, the
skirts both ways, pooled meshing (the budget, results dropped when stale,
the worker path against the in-thread mesh for a chunk with buildings),
and buildings (asked for fine chunks only, applied and meshed again,
counted, the switch off and on in place, Overpass not configured). The
mode, `bk` and
the drop-down are in `src/layers/lego/lego.test.mjs`, the link in
`src/sharelink.camera.test.mjs`, the floor in `src/hud/precision.test.mjs`.

### Blocks: the chunk source

`src/layers/blocks/source.js` (worker2's). The heights come from
`GET /api/raster/values` for `ee-elevation` (see
[Raster values (for Lego mode)](#raster-values-for-lego-mode)), mean sea
level as the DEM stack reports them.

**Block size.** `regionFor(lon, lat)` asks for a probe 64 m a side at 64
cells, at the camera. The server never goes finer than the stack's own
cell, so the answer's cell is that cell (64 m of 30 m cells reads 32 m),
snapped to the nearest of the stack's sizes: 1, 2, 8, 10, 30 or 231 m. A
cell over 64 m (GMTED alone) takes a second probe, 4 km a side. The block
size is the cell under the camera, not the window's finest, so a corner
of 3DEP 1 m does not turn a 30 m view into 1 m blocks.

**Groups.** One request answers a group of 4 × 4 chunks
(`CHUNK_GROUP`): 256 cells over the group's box, on a 4-chunk grid. Each
column reads the cell under its centre (`region.columnCentre`), not the
cell of its index, since the server may answer a cell short. A column's
level is floor(h / block size); at or below 0 m it is sea, water at level
0 over a bed at most level −1; nodata is no column. All 16 chunks go into
the cache at once, so a chunk's neighbours come free: a 1 m view asks
about 20 times, not 270, and every Earth Engine answer is a tile against
the day's budget. Splitting a group takes about 20 ms.

**Coarse chunks.** `loadCoarseChunk(region, gi, gj)` gives a group's
ground as one chunk of 64 × 64 columns at four times the block size:

- from the fine group, when it is loaded or on its way: each column the
  mean of the finite heights of the 4 × 4 fine columns under it (none: no
  column; at or below 0 m: water);
- otherwise from its supergroup: one request of 256 cells over 4 × 4
  groups (1,024 blocks a side, so the server answers at four times the
  block size), split into its 16 coarse chunks. A fine group's own coarse
  chunk replaces the supergroup's when the group loads.

A 2 km ring at 1 m is about 14 requests, not 210.

**The cache.** An LRU of 1,024 chunks, fine and coarse, keyed by the
region (its origin and block size) and the chunk. Groups and supergroups
in flight are shared. A failure is not kept, so the controller's retry
asks again. The server keeps the answers 30 days on disk.

### Blocks: the renderer

`src/layers/blocks/renderer.js` (worker2's).

**Placing.** Positions stay float, metres east, north and up of each
chunk's south-west corner. A chunk's model matrix is the region's
east-north-up frame at its origin, raised by the datum offset, moved to
the chunk's origin, which includes the ellipsoid's drop below the tangent
plane there (about −18 m at 15 km). Cesium composes the model-view matrix
in double precision, so a 1 m block does not shimmer 6,400 km from the
Earth's centre, and nothing is moved to world coordinates on the CPU. The
app is not `scene3DOnly`, and Cesium's Primitive then wants a
Columbus-view bounding sphere that float local geometry never gets: each
Blocks primitive updates with a 3D-only view of the frame state and draws
nothing in 2D or Columbus view.

**Two passes.** Opaque faces write depth, so `scene.pickPosition` and the
HUD's AGL and centre distance land on the blocks. Water faces (alpha 170)
draw in the translucent pass without writing depth, so a pick over water
reaches the bed under it. Every fragment is drawn 1/10,000 of its distance
nearer the eye (2 cm at 200 m, 1.5 m at 15 km), so a block top level with
the terrain or the photoreal tiles wins the depth test; a polygon offset
would not, since logarithmic depth writes the depth in the fragment
shader. Picks read that much short: a ray at 460 m hits 4.8 cm high.

**Shading.** mesh.js bakes the colours; the fragment shader adds:

- block edges: a line about 1.5 px wide (by `fwidth`) where a face
  crosses a multiple of the block size on its two in-plane axes, 12 %
  darker, fading out from 200 to 300 blocks away and as a block nears a
  pixel, so far chunks do not moiré;
- a tone per block on top faces, ±3 %, from a hash of the block's column
  in the region (the chunk's place rides on each instance), fading out as
  a block nears a pixel, so a flat field is not one colour;
- the fog (above).

Water takes neither edges nor tone. Both are options of
`createBlocksRenderer` (`edges`, `dither`: on by default, off, or
settings) and of `setStyle`. In the harness at a 70° sun the edges took a
close-up's pixel-to-pixel contrast from 2.8 to 3.7, and left the far view
as it was.

**Batching.** Each 4 × 4 group of fine chunks, and of coarse chunks,
draws as one opaque and one water Primitive with a geometry instance per
chunk. An instance carries its chunk's offset in the batch, which the
vertex shader takes back off, so edges, tone and picking are the chunk's
own. A chunk that arrives or changes draws alone at once, its old
instance in the batch hidden, and the batch takes it back in once it has
been quiet for 1.5 s, one batch a frame (a timer wakes a frame in
request-render mode). At a judgement-view load (316 fine and 184 coarse
chunks, 6.8 M vertices; headless Chrome, ANGLE D3D11):

|                           | One primitive a chunk   | Batched                       |
| ------------------------- | ----------------------- | ----------------------------- |
| Primitives, draw commands | 500                     | 48                            |
| A frame's CPU time        | 4.2–5.3 ms              | 1.3–2.4 ms                    |
| A chunk meshed again      | 1–6 ms and a 7 ms frame | 1–6 ms and a 5 ms frame       |
| Folding it into its batch | —                       | about 45 ms, once, when quiet |

The meshes are kept to rebuild batches from, compact (byte normals, which
the GPU reads too, and 16-bit indices): 159 MB at that view
(`getState().retainedMB`).

### Blocks: buildings and land cover

`src/layers/blocks/structures.js` (worker2's). One Overpass query per
group (the controller asks a supergroup at a time, above) through the
app's `/api/overpass` asks for the buildings and building parts, the land
cover areas, and the roads, railways and waterways in its box, as
`out geom`; a relation's member ways are joined into rings.

**Buildings.** A footprint takes the columns whose centres are inside it
(even-odd, so courtyards stay open). Its height in blocks is the `height`
tag, else `building:levels` × 3.2 m, else 6.4 m, over the block size,
rounded, at least one. Its roof is level, at the highest ground under it
plus that height, and its walls run down to each column's own ground, so
the low side of a slope shows more wall, as Arnis builds them. A part
with `min_height` (or `building:min_level`) starts that far above the
base and leaves a hollow under it. Parts override their building's outline
where they overlap; overlaps unite. The levels go into the chunk's
structures layer, between the terrain and the edits, so an edit can still
break a block of a building. One downtown Baltimore group at 1 m (256 m):
33 buildings over 42 % of the columns, the tallest 68 blocks; asked for
parts too, 89 footprints, 56 of them parts and 9 starting above the
ground (skybridges).

**Land cover.** A column's top block takes its surface from the same
answer:

| Surface | From                                                                                               | Material                |
| ------- | -------------------------------------------------------------------------------------------------- | ----------------------- |
| Water   | `natural=water`, `water=*`, `waterway=riverbank` areas                                             | its top a water surface |
| Water   | `waterway=river`, `stream`, `canal` lines                                                          | as above                |
| Road    | `area:highway` and `highway` + `area=yes` areas; `highway` and railway lines                       | asphalt grey            |
| Forest  | `landuse=forest`, `natural=wood`                                                                   | deep green              |
| Grass   | `landuse=grass`, `meadow`, `recreation_ground`, `village_green`; `leisure=park`, `pitch`, `garden` | green                   |

Water puts the column's water surface at its own top, the ground a level
under it, so a river above sea level reads as water. Lines are buffered
by half their width: the `width` tag, else roads 6 m, footways, paths,
cycleways and steps 2 m, service roads 4 m, tracks and railways 3 m;
rivers 20 m, streams 3 m, canals 8 m. The half-width is never under a
block's half-diagonal, so a road narrower than a block is still an
unbroken line of blocks. Tunnels and culverts are left out. Where they
meet, the first of these wins: a building, a water area, a road, a
waterway line, forest, grass, the terrain. The HUD's BLOCK line names
grass, forest and road.

**Bridges.** A road or railway with a `bridge` tag (any value but `no`),
and a `man_made=bridge` area, is not ground but a deck in the air: one
block thick, road-coloured, in the structures layer, 5 m over the
ground, or `layer` × 5 m for layers 1 to 3, at least one block; a line
is buffered as a road is. A line's deck slopes: at each column it lies
between its two ends' levels (the ground at each end plus that lift) by
the distance along the way, never under the column's own ground plus
one block, so a span over a ridge still clears it. The ends' ground is
read where they are, from the elevation source's chunks when an end lies
in another group, so a deck across groups slopes alike in each. An area
stays flat, at the highest ground under it plus the lift. Where a road
on the ground meets a deck's end at a shared node, its first blocks past
the deck rise toward it (deck − 1, − 2, − 3 at 1 m; one block from 5 m),
filled from the ground, so the road climbs rather than meeting a cliff;
a deck meeting another deck needs none. The ground under a deck keeps
its own surface, so the Jones Falls stays water under I-83, and the
hollow between is air. A building keeps its column; where two decks
cross, the higher one. With the Buildings switch off the decks go with
the buildings. One 1 m group on I-83 (layer 1): 2,691 deck columns, 439
of them over the river. At North Avenue (1 m, with stand-in ground
rising a level every 20 m): 20,627 deck columns over 13 levels, 59 ramp
columns, the ends read from 9 chunks outside the group, 2.1 s.

**Above 2 m blocks** the query leaves out what a block cannot show:
buildings with a perimeter under 8 blocks (Overpass's `if:length()`),
footways and service roads, and streams. A 10 m downtown group went from
16 MB to 2.6 MB (3.6 s), a 30 m one from 98 MB to 8.2 MB (7.3 s); at 1 m
nothing is left out (0.03 to 0.13 MB, 2 to 6 s).

**Tests.** `src/layers/blocks/source.test.mjs` (block size, groups,
supergroups, coarse levels, the cache), `renderer.test.mjs` (a real
Cesium Primitive from a tiny mesh, the model matrices, fog, edges and
tone, the sun, batching) and `structures.test.mjs` (heights, footprints,
parts and roofs, each surface, buffers at 1 m and 10 m, precedence, the
query through the proxy's checks).

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

## Cottereau's world history against Cliopatria

For a future world-history layer: which polities to show in which years,
and under which names. **Cottereau**'s video "History of the World: Every
Year" (2500 BC to 2025, YouTube `hzWwp9JM7Hw`) is a map
that names, every year, the polities its author chose to show. Its labels
are matched to **Cliopatria** v0.2.1 (Seshat's polity borders, CC BY 4.0;
13,797 records of 1,637 names), which has far more polities than any map
can name: the match is the subsetting Cottereau did by hand.

**Copyright.** The video is Cottereau's copyrighted work. Frames are
decoded in memory or kept in a scratch directory only while a fit runs,
and deleted. No frame or image of it is ever committed. Names, years and
coordinates derived from it are facts, and those are what `data/cottereau/`
holds.

```bash
node scripts/cottereau/index.mjs fit     # framings: data/cottereau/framings.json
node scripts/cottereau/index.mjs build   # tracks.json, matches.json, review.md
```

**Inputs** (read only): the OCR'd labels,
`E:\gev-data\cottereau\labels-1fps.jsonl`. These are RapidOCR boxes at one
sample a second, 1,043 samples and 76,880 boxes, with the year from the
caption track. Also the video under `E:\gev-data\cottereau\raw\`, and
Cliopatria's zip under `E:\gev-data\cliopatria\raw\`, streamed a feature
a line (`scripts/cottereau/cliopatria.mjs`, about 61 MB of vertices
outside the heap).

**The map is Miller cylindrical.** Each framing was fitted on its
coastline (`scripts/cottereau/fitFraming.py`, Python with OpenCV in
`D:\gev-tools\cottereau-venv`):

1. The sea, the map's one flat light blue, is segmented. Bluish pixels are
   kept only near their commonest colour, because some polities are painted
   near the sea's blue: Kievan Rus', Sweden, the Tibetan Kingdoms.
2. Natural Earth's land is drawn in each candidate projection.
3. The pixel mapping (x and y scale and offset, free) is fitted by
   Nelder–Mead on the chamfer distance between the two coastlines.

Only Miller fits with equal x and y scales (aspect 1.0000 to 1.0006). The
other projections need a distorted aspect and still leave residuals several
times larger. The residuals are each observed coastline pixel's distance to
the fitted coastline, in km:

| Framing | Years           | View                       | Miller median / p75 / p90 km | Coast within 25 km | p75 equirect. | p75 Mercator | p75 Gall (aspect) | p75 Robinson | Cut: zoom, carried vs fitted |
| ------- | --------------- | -------------------------- | ---------------------------- | -----------------: | ------------: | -----------: | ----------------- | -----------: | ---------------------------- |
| 1       | 2500 BC–1000 BC | 13° to 126°, 1° to 52°     | 0 / 0 / 5.9                  |                95% |          24.1 |           13 | 5.8 (0.84)        |         63.2 | —                            |
| 2       | 996 BC–799      | −13° to 139°, −6° to 61°   | 0 / 0 / 8.2                  |                93% |          39.6 |         24.6 | 11 (0.85)         |         99.9 | 0.744, 8.3 km                |
| 3       | 800–1449        | −31° to 149°, −11° to 67°  | 0 / 9.5 / 166                |                78% |            75 |         76.6 | 37.8 (0.85)       |        146.6 | 0.843, 3.8 km                |
| 4       | 1451–1778       | −126° to 147°, −39° to 76° | 0 / 9.3 / 172                |                79% |           147 |        110.6 | 63.1 (0.87)       |        204.2 | 0.661, 9.3 km                |
| 5       | 1780–2025       | −175° to 180°, −56° to 84° | 0 / 11.7 / 216               |                79% |           175 |        135.3 | 86.7 (0.87)       |        213.2 | 0.770, 16.6 km               |

The wide framings' p90 is mostly what the reference lacks, not the fit.
Natural Earth's countries count the Great Lakes as land, where the video
draws them as water. Islets add some, and one pixel is about 8 km at the
equator by framing 4.

The four cuts were found from the labels alone (`framings.mjs`). Between
two samples, nearly all the labels both share move by one zoom and shift,
with x and y factors equal (89 of 94 labels at the 1451 widening, for
instance). Each framing after the first was started from the one before
carried through its cut. That carried mapping and the coastline fit agree
to 4–17 km at the frame's corners.

**The pipeline** (`scripts/cottereau/`):

1. **Cleaning** (`labels.mjs`). The year box at the bottom centre goes, and
   so do digits and crumbs. A two-line label is joined from its lines: one
   line under another at a line's pitch (1.1–1.3 line heights; two labels
   stacked by chance sit 1.6 and more apart), centred on it, about the same
   size. A hyphen joins without a space ("Syro-Hittites"). A line ending in
   "." ends its label, so "Wal." over "Bul." over "Ottomans" stays three.
2. **Tracking** (`tracks.mjs`, in lon/lat so a track survives a cut). The
   same text, or one within an OCR slip (similarity 0.75 and more), within
   450 km of where it was last seen at most four samples before, is one
   track. Tracks split by the tracker are joined after, and the spellings
   kept as variants ("Bur." 9, "Bur.s" 1).
3. **Places**: each track's median position, through its framing's fit.
4. **Matching** (`match.mjs`). The candidates are Cliopatria's records
   alive in the track's years whose polygon holds the label or comes within
   600 km, grouped by name. Then, in order:
   - a like name (accent-folded, also against the Wikipedia title, with
     words like "Kingdom of" set aside, "Minoa" for "Minoan", plurals as
     singulars) within 300 km, or 700 km for an exact one, since a small
     polity's label is often set beside it;
   - an abbreviation ("Eng.", "Se.", "Bur.") whose words each begin one of
     the name's, within 200 km;
   - place and time: the polity holding the label (or within 50 km,
     failing that 250 km), the best name and then the label's size against
     the polity's area as tiebreaks.

   A namesake 1,000 km or more away is refused and noted. Each match also
   carries `periods`: the track's Cliopatria name year by year, because one
   label lives through several of Cliopatria's polities ("France" through
   the Kingdom, the First Republic, the Directory, … the Fifth Republic).
   Cliopatria's bracketed twin of a polity (it with its dependencies,
   "(Kingdom of France)") gives way to the plain one. A period chosen by
   place (the main match while it lives near the label, `continued`, or
   `place`) is measured from where the label stands that year, not from its
   lifetime's median: "Kushans" stood in Bactria in 30, over the Yuezhi,
   though its median lies over India. And a year is named from its own
   text: one track can be two labels in turn at one place ("Qara Qoyunlu",
   then "Aq Qoyunlu" after 1467), so a variant naming another polity of the
   same head word ("Aq" for "Qara") is not that year's.

   Rules against pairings that were alike in name or place but not the
   polity:
   - **Directions agree.** A label and a name that each say a direction
     (east, west, north, south, upper, lower, also run on, as in
     "SouthKorea") and not the same one are no likeness. The tracker keeps
     such labels apart as well: "West Francia" and "East Francia" were
     one track, and so were "NorthKorea" and "SouthKorea".
   - **A held polity breaks a near tie.** A like name holding the label
     ranks 0.15 above one beside it. "Congo" in the Democratic Republic is
     not the Republic across the river. A composite never gains this way.
   - **By place alone, never a composite.** A bracketed record, a colonial
     empire, or a "French Africa" is never a place-only match: a colony or
     a people inside one is not the empire.
   - **By place alone, never a giant.** A polity over 30 times the area
     the label's size predicts is never a place-only match (a warlord's
     label inside the Han). No match by name or abbreviation is that far
     above the size model.
   - **Single letters** ("B.", "G.") match by abbreviation or not at all.

**Results** (the whole video):

- 1,714 tracks, 1,508 of them seen three times or more.
- 1,278 matched (84.7%): 451 high, 316 medium (50.9% by name or
  abbreviation) and 511 low. Low is a guess by place alone, often a polity
  Cottereau shows inside one Cliopatria has.
- `review.md` lists the 737 tracks with no match or a weak one, with their
  nearest candidates.
- It also lists 18 large Cliopatria polities in view that no label names:
  steppe peoples (Xiongnu, Xianbei, Scythia, Yuezhi), Gothia, dynasties
  Cottereau draws under another name, and so on.
- Per century, it sets the labels against Cliopatria's polities alive in
  the view: Cottereau names from a third to all of them, fewer in the
  crowded centuries.

Tests: `src/tooling/cottereau.test.mjs` (synthetic frames and a mini
Cliopatria): joining and keeping apart stacked lines, a cut found and one
label's own move not taken for one, Miller against the other cylinders on
control points, tracking with a slip and a far namesake, and matching by
name, by abbreviation, by another name, and refusing the namesake far away.

### Cottereau's borders (private)

Cottereau's drawn borders, extracted from the video as lon/lat polygons,
for a **private** comparison layer beside Cliopatria. They are for the
user's personal use only.

**The privacy line.** The code is committed; the geometry never is. That
means no polygons, no rasters, no frames, and nothing derived from the
fills, in the repository or the fork:

- A build lives under `E:\gev-data\cottereau\borders\`, or wherever
  `--out` / `COTTEREAU_BORDERS_DIR` says. `borders.mjs` refuses any
  directory inside the repository.
- `.gitignore` guards every path a build could take there.
- A test (`src/tooling/cottereauBorders.test.mjs`) fails if a borders file
  is ever tracked.
- The route `/api/cottereau-borders` exists only when
  `COTTEREAU_BORDERS_DIR` is set where the server starts. It is same-site
  and GET only, and absent otherwise.
- Frames are decoded in memory and never written.

```bash
node scripts/cottereau/borders.mjs extract [--workers 2]     # the whole video
node scripts/cottereau/borders.mjs extract --samples 50,650,1000 --out <scratch>   # a trial
node scripts/cottereau/borders.mjs extract --reuse <out>/builds/<old key>.partial   # after an extractor change
node scripts/cottereau/borders.mjs status
node scripts/cottereau/borders.mjs report [--write]   # the current build's quality report again
```

**Per sample** (one a video second, 1,043; `extractBorders.py`, Python with
OpenCV, a frame decoded in memory):

0. **No map, no sample.** A frame in which the sea is under 5% of it is
   no map: the opening, the fade to black at the end, a cross-fade between
   framings. A map shows 27% or more. Such a frame is written as skipped
   and left out of the build's samples, so its year shows the last map
   before it. So is a fade: a dip between framings dims the whole map, its
   sea off the map's one sea colour (#d9e2ed in every framing) by more than
   6 in a channel. 799's sea was 15 darker, its unclaimed land grey, and
   Alodia's label, set on that grey, took 11 million km².
1. **Sea.** The sea is masked with the framing fit's colour rule, and the
   year box counts as sea.
2. **Label text is painted out.** Inside each OCR box, the strokes (black,
   or white on a darker fill: one shade a label, whichever it has more of)
   and a rim round them take the box's own background colour, so the fill
   runs on under the label. Text over the sea becomes sea; white strokes on
   a land fill, which the sea mask takes for sea, are land. A border line
   through a box (a line that runs on outside it; the letters are never
   one) stays, and so do the letters' rims within 2 px of it. "Neu." sat on
   Neustria's border with Austrasia in 613, and painted out it joined the
   two. In a label 28 px tall or more, a letter is its strokes, 3 px and
   more across, so a dark border line of 1 or 2 px by black letters is a
   line all the same (a smaller label's strokes are as thin as a line): the OCR's one
   box for "H." and "Wei" in 245 BC took in the Zhao–Wei border, and painted
   out it joined Zhao to Wei. A letter set right across a line is still
   painted.
3. **Separators** are:
   - the thin border lines (a black-hat: thin and darker than both sides,
     in grey or in any one channel: the British colonies' lines in 1764
     are a darker crimson, 48 to 64 darker in red but under 25 in grey; a
     wide dark fill, such as the Holy Roman Empire's grey, is not one);
   - every jump of colour between neighbouring pixels, or over three (more
     than 24 in a channel), which is two fills meeting: the compression
     spreads some meetings over three pixels in steps under 24 (Nejd's
     green and the Ottomans' teal in 1904);
   - a thin neutral-grey region (a line no darker than the fill beside it).
4. **Regions** are the connected components of what is left. Crumbs under
   25 px become separators, and every separator pixel goes to the nearest
   region, so the polygons tile.
5. **Fills.** Near-white is unclaimed land. The off-white cream is a fill
   like any other: Cottereau draws many small polities in it, divided by
   lines.
6. **Naming.**
   - A region takes the label whose point falls in it.
   - A label set beside its polity (over the sea, or over unclaimed land)
     takes the nearest region within three line heights that no label
     inside has. Among those about as near it prefers the largest, and
     those mostly (half their pixels or more) inside its matched Cliopatria
     polity come first, then those partly (a tenth or more) inside it, so
     Sarawak's crimson strip comes before the larger Dutch Borneo beside
     it (flag `beside`). A label that names its matched polity (a word of
     each begins alike: "Liberia", "Republic of Liberia") never takes a
     region wholly outside that polity: Cottereau leaves Liberia white in
     the 1880s, and its label over the sea took French Ivory Coast; Cyprus,
     Jamaica, Qatar, Sulu, Banjar and the Gold Coast took a neighbour's
     region the same way. One matched by place alone still may (Taiwan,
     matched to Japan, is its island). Labels with such a region choose
     before the others, so a label set beside its neighbour cannot take,
     by coming first, the region another label's polity is. Banu Sulaym's
     label took the Mamluks' Egypt and Levant for three centuries this way.
     A centroid test failed there: the Mamluks' 1372 ring leaves out south
     Sinai. It never takes a region over six times its matched
     polity's area that year (`MAX_CLAIM`): a small polity's label over the
     sea, beside a giant, is not the giant. Abkhazia beside the Ottomans'
     Black Sea coast was the case.
   - One label set on two lines that the cleaning kept apart ("Russian"
     over "America", their pitch 1.4 lines) is one label: two labels in
     one region, one under the other (a gap under 0.6 of a line), centred
     alike, one of them matched or both to one polity.
   - Labels of several polities in one region split it by nearest label
     (`split`). Labels matched to one Cliopatria polity in one region name
     it together ("Byzantine" and "Empire").
   - A region with no label joins the nearest region of its colour within
     800 px (an exclave, a colony, an island; `joined`). It never joins
     through a colour three or more polities share in that frame, such as
     the cream. Nor does it take a matched polity past the same six times.
     Otherwise it is kept as unlabelled, with its colour.
7. **Polygons.** Each polity's regions are traced, holes kept (specks of
   text under 30 px dropped), simplified to about a pixel, and projected
   with the sample's framing (inverse Miller).
8. **Measures.** Its area in km² (each pixel row's area at its latitude),
   and its intersection over union, by area and on land, with the
   Cliopatria polygon of its matched name in that year (matches.json
   periods).

**A build** (`borders.mjs`, "Builds and restarts"):

- It is keyed by its inputs: the extractor's declared version
  (`EXTRACTOR_VERSION` in `extractBorders.py`, bumped only when a change
  can alter some sample's output), the framings, the matches, the labels
  file. A change that leaves the output as it was (speed, memory) keeps the
  samples written.
- `--reuse` names an earlier build, finished or partial. Its samples carry
  over where the newer version's change leaves them as they were
  (`CARRY_OVER` in `borders.mjs`), and only when both builds were prepared
  from the same samples. The rest are extracted again.
  - From version 1 to 2 (frames without a sea skipped), only those frames
    are redone.
  - From 2 to 3 (the six-times bound), a sample is redone when one of its
    beside or joined polities, traced, comes within 80% of the bound. On
    the first full build that is 378 of the 1,043 samples.
  - From 3 to 4 (the beside labels' two passes), none carries over: it
    reorders the beside labels of nearly every sample.
  - From 4 to 5 (lines kept under labels, lines in one channel, meetings
    over three pixels, fades, two-line labels, one polity's labels
    together), none carries over: the separators change in nearly every
    frame, and which samples change can only be told from the frames.
  - From 5 to 6 (letters by their strokes, beside labels kept to their
    polity), none carries over: whether a black label's box holds a thin
    dark border line can only be told from the frame.
- Two labels in one region split it by nearest label in chunks of pixels,
  so a region holding many labels stays within a few hundred MB.
- While it runs it is `builds/<key>.partial/`, holding `samples.json` (the
  labels per sample with their tracks), the matched Cliopatria polygons
  (`cliopatria.json` and `.f64`), and `samples/<index>.json.gz`, each
  written whole. A stopped run resumes.
- When done it becomes `builds/<key>/`, with `manifest.json` (the counts,
  each framing's pixel size, the quality report, and each sample's year and
  the years it covers to the next), and `current.json` moves to it in one
  rename.
- A polygon is `{track, label, cliopatria, wikidata, colour, areaKm2,
flags, regions, iou, polygons}`, its rings integer at 1e-4° (the first
  vertex absolute, each later one a delta).
- A year shows the latest sample at or before it.

**The quality report** (the manifest's `quality`, printed after a build
and by `status`):

- Per century: the share of claimed land labelled, and the IoU with
  Cliopatria (median, and by area) of his regions matched by name.
- The merged and split regions, and the largest unlabelled ones.
- **The IoU summary** (`iou`) counts only the pairs matched by name or
  abbreviation, with their 20 worst.
- **Place-only pairs** are counted apart (`placeOnly`, the same numbers and
  their own 20 worst). A pair is place-only when the year's period chose the
  polity by place (`place`, or `continued`: the polity under a label that
  named another, "Egypt" over the Achaemenids; 352 of the 368 continued
  periods have no likeness of name), or when the track's match is low
  confidence (by place, or by single letters) and the period is not a
  name's. Such a pair is often a polity he shows inside one Cliopatria has
  (Austrasia in the Kingdom of the Franks), so its IoU says little of his
  borders.
- **Pairs that differ by definition** are counted apart too
  (`differences`, each case with its samples and median). Matched rightly,
  the two sources draw different things under the name; each was checked
  by hand against the frames and the records (`differences.mjs`, also
  listed in `review.md`):
  - Iroquois 1764–66: his are the Ohio valley between the colonies'
    lines; Cliopatria's Haudenosaunee is Iroquoia in New York.
  - Russian America: Cliopatria's Russian Empire leaves out Alaska.
  - Nejd 1902–04: Cliopatria's Emirate of Nejd of 1895–1904 is a 53 km²
    record.
  - Zhou: Cliopatria's Later Zhou (Eastern Zhou) is the royal domain at
    Luoyang, 4,000 to 10,000 km².
  - Qin 206 BC: Cliopatria's Zhai records carry the Qin dynasty's
    Wikipedia title, so "Qin" matches them by name; that year Zhai is a
    kingdom of 25,977 km² north of Cottereau's Qin.
  - Prussia 1834–47: Cliopatria's Kingdom of Prussia after 1807 is
    exclaves of under 2,000 km²; Prussia's land is its German
    Confederation record.
  - Qin 350–328 BC and Wei: his Warring States lie west of
    Cliopatria's (his Qin in Gansu, his Wei west of Han), and his "Zhou"
    covers Shandong.
  - Balhae 705–740: his early Balhae is in Manchuria, Cliopatria's in
    northern Korea.
  - Gauda 602–611: his is west Bengal, Cliopatria's east Bengal.
  - Dai Viet 1533–92: his is the Lê south, Cliopatria's the Mạc north.
  - Teut. State 1466–1524: his is Livonia, the Order's Prussia drawn as
    Poland's; Cliopatria's Teutonic Order is Prussia.
  - Zagwe: Cliopatria's Zagwe dynasty is the Lasta highlands, 14,454 km².
  - Volga Bulgaria: his lies north-west of Cliopatria's, though Kazan in
    the same framing overlaps at 0.5.
- `iouAll` is every pair, as the summary was before.
- `report` makes the report again from the current build's samples and
  today's `matches.json`, in a few seconds and without extracting
  anything. `--write` keeps it in the manifest; it warns when the inputs
  no longer make that build.

**Running time.** The quality numbers stay in the build's manifest and the
printed report, never here. On a trial:

- About 9 s a sample on one worker: about 2½ to 3 hours for the whole
  video, or about half that on two workers (400 MB each).

## World history (REFERENCE)

Any year from 2500 BC to 2025 on the globe, as Cottereau's video "History
of the World: Every Year" shows it, in the same frame as every other
layer: the polities he names that year, filled and labelled. A second
list compares any set of polities, each in its own colour, where the
overlaps mix.

**Copyright.** No frame or image of the video is used anywhere: not in
the build, the served index or the app. Cottereau's labels and years are
used as facts (which polities, under which names, in which years), through
`data/cottereau/` ("Cottereau's world history against Cliopatria",
above). The shapes are Cliopatria's.

**Using it.** Turn on World history (REFERENCE, in the DATA LAYERS panel).
The WORLD HISTORY panel opens in the right rail:

- **YEAR:** a slider, ◀ and ▶ for a year either way, and a typed year
  ("500 BC", "500 BCE", "-500", "1 AD", "AD 1", "476 CE", "2025"). There
  is no year 0: 1 BC is followed by 1 AD, on the slider and in the steps.
  Cliopatria ends in 2024, so 2025 shows 2024, and the panel says so.
- **VIEW:**
  - **COTTEREAU** (the default) shows the Cliopatria polities matched to
    his labels at high or medium confidence, in the years he shows them.
    Each one carries his label text when it was matched by name or
    abbreviation, set where the video set it; otherwise it carries
    Cliopatria's name, at the polygon.
  - **Include place-only matches** adds the low-confidence ones (a polity
    matched by place alone), labelled with Cliopatria's name.
  - **ALL CLIOPATRIA** shows every polity alive that year. RELATION
    records, which repeat their members' land ("(Alliance of …)"), are
    left out.
  - The video shows no Americas or southern Africa before 1450. The
    Cottereau view follows its matches, so it shows none either.
- **COMPARE:**
  - **The picker:** type a name to filter all 1,637 Cliopatria names
    (a name starting so first, then a word, then anywhere, the largest
    first). Tick several and **ADD n SELECTED**, or press Enter for the
    first. Names Cottereau shows are brighter.
  - **Each entry** gets the next free colour of eight. ◉/○ shows or hides
    it, **MAX** / **AT YEAR** switches its shape, and × removes it. The
    entries can't be renamed. **CLEAR** empties the list.
  - **MAX** (the default) is the polity's largest record by Cliopatria's
    Area, its maximum extent. **AT YEAR** is its record alive in the
    slider's year; a polity with none that year says NOT IN that year.
  - **OPACITY** is one control for all the list's fills.
- **A click** on a polity, or on its name, opens a card: the name
  (Cottereau's label over Cliopatria's name when they differ), the years,
  the area, the Wikipedia title and the credit. A list entry on top wins,
  then the smallest polity under the click. The panel shows the same,
  with the Wikipedia link and **COMPARE**. A second click on the same spot
  opens the card of what lies under it.

**Cottereau borders (private).** Cottereau's own drawn borders, extracted
from his video (see "Cottereau's borders (private)" above), laid over the
year view for a side-by-side reading. They are for personal use only:

- **Where.** The section is in the panel only where
  `/api/cottereau-borders/status` answers, that is when the server was
  started with `COTTEREAU_BORDERS_DIR`. Without it the section is absent,
  not just disabled, and nothing of it is written to the share link.
- **The switch.** **COTTEREAU BORDERS (PRIVATE)** draws the sample for the
  slider's year: the latest at or before it. The note says "Sample year N"
  when that is not the slider's year. Before the first sample nothing is
  drawn, and the note says so.
- **Modes:**
  - **OUTLINES**: his regions in a light ink over a dark halo, so they
    read over a dark plate and a light one.
  - **FILLS**: each region in his own colour, translucent, outlined thinly.
  - **DIFFERENCES**: for each Cliopatria polity he is matched to, where only
    he has it (orange) and where only Cliopatria has it (blue), from the
    same polygons on the client. Where both have it stays clear.
- **His labels** are off by default, since the year view already names
  the polities. **OPACITY** is the overlay's own.
- **Order.** The overlay is a third imagery layer, above both the year's
  fills and the list's, so it stands on its own.
- **A click** on one of his regions opens its card: his label, the
  Cliopatria polity it is matched to, their IoU in the sample's year, its
  flags (split, joined, label beside it, unlabelled), the sample's year
  and the area. A Cliopatria polity's card gives the IoU of each of his
  polities matched to it while the overlay is on.
- **The URL.** `wh` carries the overlay last, as `@` + on (`1`/`0`) + the
  mode's initial (`o`, `f`, `d`) + labels (`1`/`0`) + `.` + the opacity,
  e.g. `~@1f0.70`. It is written only once the route has answered, and
  never at its defaults. While the page has not yet asked, a field the
  link brought rides on; once the route is known to be absent, it goes.

**Rendering.**

- **Fills** are two imagery layers painted from the served polygons
  (`src/layers/worldHistory/painter.js`): the year's, and the list's above
  it.
  - Each 256 px tile is a canvas on which the polygons crossing it are
    filled and outlined. Holes are cut by the even-odd rule, and points
    under half a pixel apart are dropped.
  - They sit on the imagery host, as the draped overlays do: the globe on
    the blank styles and the 2D maps, the Google 3D tiles on Google 3D,
    and the plate under Custom cutouts. So a Baltimore cutout over the
    year view shows the fills on the plate around the cut tiles.
  - The tiles use a geographic tiling scheme, up to level 10. Levels 0–2
    paint the coarsest served level, 3–4 the middle one, and 5 and up the
    finest.
- **Colours:**
  - The year view's colour is fixed by the polity's name (FNV-1a over a
    twelve-colour palette of mid tones that read on a black and a white
    plate), so a polity keeps its colour from year to year. The fill is
    at 0.42 alpha with a 1 px outline.
  - List entries take eight strong colours in order, a freed one given
    again. The fill is at 0.55 alpha with a 2 px outline.
  - Overlapping entries are composited on the tile, so where two overlap
    the colour is their mix. The OPACITY control is the list layer's
    alpha, so moving it repaints nothing.
- **Names** are `label` entries on the world overlay, never Cesium
  labels, so the Titles toggle hides them.
  - A year polity is named when the square root of its area is at least
    2.5% of the camera's height, at most 120 of them, largest first. The
    overlay's collision groups thin them further.
  - The list's names come first, in their colours.
- **Changing the year:** a year typed or dragged is drawn once it has
  stood 140 ms. The new year's coarse answer is asked for first, and its
  layer replaces the old one when it arrives, so a year's tiles are
  painted afresh each time.
- **Measured** on 2026-10-23 in headless Chrome, with Cesium 1.138 on the
  machine's GTX 1080 Ti through ANGLE D3D11, 1280 × 800, a black globe
  and no other layer. The year is 2024 in All Cliopatria (195 polities),
  plus six overlapping list entries (Roman, Achaemenid, Eastern Roman,
  Umayyad, Ottoman, Ilkhanate). Frame times are `scene.render()` plus
  `gl.finish()`, 150 frames, median / 95th percentile in ms:

  | View                 | No layer  | Year view | Year and list | Year loaded | List loaded |
  | -------------------- | --------- | --------- | ------------- | ----------- | ----------- |
  | World (20,000 km up) | 1.3 / 2.1 | 1.0 / 1.8 | 0.6 / 1.5     | 0.62 s      | 0.43 s      |
  | Region (4,000 km)    | 1.5 / 2.3 | 1.8 / 2.7 | 1.7 / 2.6     | 0.34 s      | 0.26 s      |
  | Close (600 km)       | 1.4 / 2.2 | 1.7 / 2.4 | 1.3 / 2.0     | 0.41 s      | 0.49 s      |

  The fills cost the frame nothing measurable: imagery is drawn the same
  however many polygons were painted into it. "Loaded" is until the
  globe's tiles settle (13, 52 and 45 tiles a layer). A ground primitive
  per polygon would cost every frame instead, and its geometry would be
  rebuilt on each year.

**The data.** Cliopatria v0.2.1 (Seshat Global History Databank, CC BY
4.0; 13,797 records of 1,637 names, 3400 BCE to 2024 CE, 3,802,843
vertices), with each record's Name, FromYear and ToYear (inclusive,
negative BCE), Area (km²), Type, Wikipedia and Wikidata. Six records end
in "year 0", which a year query reads as the end of 1 BC. The credit is
in the data popover and the panel: "Cliopatria (Seshat Global History
Databank), CC BY 4.0", with the links. The shapes are simplified (see
below), which is the change the licence asks to be noted.

**The build** (`scripts/worldHistory/`):

```bash
npm run world-history:build    # --file ZIP, --dir DIR, --force
npm run world-history:status   # --json
```

- **Input:** Cliopatria's zip (`--file`, else `CLIOPATRIA_ZIP`, else
  `GEV_RAW_DIR/cliopatria/raw/cliopatria-v0.2.1.geojson.zip`), streamed
  once a feature a line and never loaded whole, with
  `data/cottereau/matches.json` and `tracks.json`.
- **Output:** `WORLD_HISTORY_DIR`, else `.gev-cache/world-history`:
  - **Each record:** its metadata, a label point (the inside point
    farthest from the edges of its largest polygon, on a 16 × 16 grid),
    its box, and its polygons at three levels. Douglas–Peucker tolerances
    are 0.25°, 0.08° and 0.02°, keeping 876,736, 2,747,885 and 3,595,043
    vertices. Cliopatria's edges zigzag at about 5 km, so 0.05° still
    kept 90% of them.
  - **The level files:** each level is one file of the served text
    (polygons of rings, each its first point then the differences, at
    1e-4°), with every record's offset and length. The server pastes
    these into its answers without decoding them.
  - **The year index:** the records by 50-year bucket, so a year is a
    lookup.
  - **Each polity:** its records and its largest, by Area.
  - **Cottereau's spans:** 2,347 of them. Each is a label, a Cliopatria
    name, years and a confidence. A matched track's periods run on to the
    next one's start, because the samples are a second of video apart.
- **The switch-over:** the files carry the build id (from the inputs'
  sizes and times and the format), and `current.json` moves to the new
  manifest in one rename, the old build's files going after. A stopped
  build leaves the previous one current. Unchanged inputs are skipped
  (`--force` rebuilds). It keeps no checkpoint, because it runs in under
  a minute (see "Builds and restarts").
- **Measured** on 2026-10-23, from the zip on E: into the scratch
  directory: 17 to 19 s, a peak of 255 MB resident (83 MB heap). The
  output is 76.0 MB: the index 4.2 MB, and the levels 9.6, 27.6 and
  34.6 MB.

**The routes** (`server/providers/worldHistory.js`, same-site, GET only):

- `/api/world-history/status`
- `/api/world-history/year/<year>?mode=cottereau|all&places=1&lod=0..2`:
  the year's polities with their polygons, largest first. The year is
  negative BCE and never 0; 2025 answers with Cliopatria's 2024.
- `/api/world-history/polity?name=<Cliopatria name>&extent=max|<year>&lod=`:
  one polity at its largest, or as at a year (404 when it has none then).
- `/api/world-history/names[?q=]`: all the names for the picker
  (`[name, from, to, area, in Cottereau's subset]`, 65 KB), or the 50
  best for `q`.

Each answer has an ETag on the build id and the question, with
`Cache-Control: private, no-cache`, so a repeat is a 304 until a rebuild.
The index is read once and checked for a new `current.json` every 5 s.
503 says to build it. Measured on the full index: loaded in 77 ms, about
86 MB resident in the test process, a year answered in 1.4 to 9.9 ms.
2025 in the Cottereau view is 136 polities, 105 KB at the coarsest level
and 281 KB at the finest.

**State and the URL.** The layer is local-only (never in `l=`). Its state
rides in its own hash parameter, `wh`, e.g.
`wh=1.-500.c.60~*mRoman%20Empire~!yHan%20Dynasty`:

- the toggle, the year, the mode (`c` Cottereau, `cp` with place-only
  matches, `a` all) and the opacity in percent;
- then each list entry: `*` shown or `!` hidden, `m` max or `y` at the
  year, and its Cliopatria name, URI-encoded with `!'()*~.` escaped too.

A link that says on turns the layer on once the page is up. Polygons are
never in the URL.

**Limits.**

- Cliopatria's shapes are one reading of each polity's land: borders are
  uncertain and coarse at the scale they were drawn.
- Cottereau's subset is the matching's: about 9 in 10 of his labels are
  matched. A label matched only by place can name a polity he did not
  mean, which is why place-only matches are off by default.
- A dragged year redraws its tiles each time (0.3–0.6 s a year above).
- Holes are kept but small islands go at the coarse levels.

**Tests:**

- the model (`src/data/worldHistory.test.mjs`: typed years, no year 0,
  the geometry's text, colours, the list, the `wh` round trip);
- the build on a mini Cliopatria (`src/tooling/worldHistoryBuild.test.mjs`:
  records at three levels, the year index, the largest record, BCE years
  and the record ending at 0, Cottereau's spans and modes, the
  switch-over, status);
- the routes (`server/providers/worldHistory.test.mjs`: modes, ETag and
  304, polity at max and in a year, names, refusals, not built);
- the layer against stubs (`src/layers/worldHistory/layer.test.mjs`:
  tiles painted in order, the layers on the host with the list above and
  its alpha the opacity, names thinned, a new year swapped in, the click's
  card, off);
- the panel's words (`src/ui/worldHistoryPanel.test.mjs`);
- the Cottereau borders overlay (`src/layers/worldHistory/borders.test.mjs`
  on synthetic samples: the route present or absent, the sample for a
  year, the `wh` field written only with the route, the shapes for each
  mode, the differences cut on the tile, the cards' and the panel's words;
  and in `layer.test.mjs`: no layer and no field without the route, the
  overlay above the year and the list with its own opacity, his labels on
  request, his card, the Cliopatria card's IoU, and a second click).

The frame times above were measured in a scratch page, not in the app.
The live app has not been checked in a browser here.

## HUD: the camera readout

The HUD's corner readouts were partly decorative: random mission and sensor
ids (KH11-…, OPS-…), an ORB/PASS line, GSD (height × 0.000375) and NIIRS,
BAND/BITS/LVL and ONA. They are gone. In their place the bottom corners
show the camera's whole view state, the seven numbers that fix what is on
screen, plus its height above the surface and what a pixel covers
(`src/hud/cameraReadout.js`; the banner, mode, summary, REC, COLL, SUN and
AIS stay). The summary wraps to three lines instead of clipping.

- **Bottom left, position:** LAT and LON (decimal degrees), DMS and MGRS at
  the same precision, ALT above mean sea level (EGM96, as before) and AGL
  above the rendered surface under the camera, with the surface's name in
  small type ("AGL 4.2 m · Google"). The surface under the camera
  (`surfaceUnderCamera`, `src/hud/cameraState.js`) is a ray straight down
  from the camera through the scene (`pickFromRay`, so it meets the tiles
  the view loaded near the camera), else a ray down from 9 km as
  `scene.sampleHeight` casts it but through `pickFromRay` (sampleHeight
  itself only where the scene cannot pick from a ray), else the shown
  globe's terrain; an answer outside −500 … 9,000 m is a miss, not the
  ground. On 2026-10-27 over Lake Tahoe on Google's tiles, 4 m above the
  water, AGL read 25,700 m from a sample at −23.8 km. AGL is "—" until a
  plausible answer, sampled again on settling, when the tileset under the
  view loads a tile (`tileLoad`, `allTilesLoaded`), and at most once a
  second while it has none or the camera has left it.
  `window.__gevHudCamera.diagnostics()` in a live tab lists every way's raw
  answer beside the ones used, with the geometric error of the tile each
  ray met.
- **Coarse tiles are not the ground** (`src/surfaceTrust.js`). While
  Google's leaves stream in, Cesium draws and picks a coarse ancestor tile,
  and its chord can lie far off the ground. Over Baltimore on 2026-10-27,
  the camera at 80 m, every sample read +535 m: AGL showed −455.5 m, and
  Cesium's own camera collision (`enableCollision` on the Google tileset)
  lifted the eye to 536 m (535 + `minimumZoomDistance`), where it stayed;
  the arrival ground guard was not involved (it lifts to the surface +
  120 m). A hit on a tile is trusted only when the tile is no coarser than
  Cesium itself would draw at that distance from the camera, twice over
  (`TILE_SSE_SLACK` 2 × the tileset's `maximumScreenSpaceError` × a
  pixel's footprint there), and always at `TRUSTED_TILE_ERROR_M` (8 m) or
  finer; Google's leaves are about 0.5–2 m. The tile is the pick result's
  `object.content.tile`. AGL, the centre distance (the depth pick is
  judged by `scene.pick` at the centre), the arrival ground guard
  (`src/cameraGroundGuard.js`: coarse answers are waited out for up to
  15 s without spending an attempt) and Cesium's camera collision
  (`gateCollisionOnRefinedTiles`, installed in `src/app/viewer.js`: the
  scene's `globeHeight` is answered from trusted tiles under the camera
  only, found as `Cesium3DTileset.getHeight` finds them but keeping the
  tile) take only trusted hits. A synthetic tileset in Chromium (a 1,100 m
  root at +535 m, its 1.2 m leaf at 25.4 m held back) reproduced the lift
  to 536 m without the gate and kept the camera at 80 m with it.
- **Bottom right, pose:** HEADING, PITCH, ROLL, FOV, then PX (one pixel's
  ground footprint) and SUN.
- **Editing.** A click on LAT, LON, ALT, AGL, HEADING, PITCH, ROLL or FOV
  (or Enter on it) opens it for typing: Enter applies, Escape or leaving the
  box cancels, a number the field does not take stays open in red. The
  whole view is set at once (`camera.setView`), so the other numbers hold;
  AGL sets ALT to the surface plus the number typed; FOV sets
  `camera.frustum.fov` (Cesium's default 60° until then), and, being a view
  change without a camera move, raises `moveEnd`. Either way the share link
  is told (`ShareLinkManager.onCameraChange`).
- **Precision** (`src/hud/precision.js`). A pixel's footprint is
  2·d·tan(fov/2) ÷ the canvas's wider side in CSS pixels (Cesium's fov spans
  the wider side), d the distance to the surface at the screen's centre
  (`scene.pickPosition`, else a ray through the scene's primitives, the
  Google tileset among them, else the globe, else the camera's height; a
  hit off the plausible surfaces is not taken; measured again when the
  view changes or after a second). Lengths are shown to the footprint rounded down to a
  power of ten (10 km … 1 mm), no finer than the decimal place of the data
  floor; LAT and LON take the decimals whose step (0.1° ≈ 11 km …
  0.000001° ≈ 0.11 m) resolves the larger of the footprint and the floor;
  MGRS digits step 1 km, 100 m, 10 m, 1 m; DMS seconds 0 to 3 decimals.
  Angles always show 2 decimals (a pixel is fov ÷ width, about 0.03°), PX 2
  significant figures.
- **Data floor:** Google's 3D tiles 0.5 m (so heights to 0.1 m), Cesium
  World Terrain 10 m, Re:Earth's keyless terrain 30 m (so 10 m), a flat
  ellipsoid 30 m (`DATA_FLOORS`). The terrain providers say which they are
  (`gevTerrainId`, `src/maps/terrain.js`); a shown map-stack tileset is
  Google's. USGS 3DEP 1 m has an entry (1 m), but today it is only the
  Elevation layer's draped colours, not the surface, so nothing selects it.
- **Tooltips.** Every value's `title` says what it is, its reference
  (WGS84 ellipsoid, mean sea level, rendered surface), what bounds its
  precision (the pixel, or the surface's resolution), and "Click to edit"
  where it can be.
- **Share links** (`src/sharelink.js`) carry the camera at the HUD's
  precision (`setCameraPrecisionProvider`): lat/lon and alt as the HUD shows
  them, so links are short from high up and about a metre near the ground;
  heading, pitch and roll to 2 decimals (heading in 0 … 360, roll in
  −180 … 180, so a hair under 360° is 0); `fov` to 2
  decimals, written only when it is not 60°, so older links read the same.
  Without a HUD the old precision stands (4 decimals, whole metres).

The minimal and cyber layouts keep their rules; the removed elements'
selectors match nothing. This is step one toward an eye-level mode (1.7 m
above the surface at a screen-matched field of view): `editedView`'s AGL
and FOV and `applyCameraView` are what that mode would call.

## Walk and Fly (embodied navigation)

Milestone 2 of `docs/BLOCKS-PLAN.md`. The ANALYSIS heading's **Move**
drop-down, beside Render, picks Spectator (GEV's own camera, the default),
Walk or Fly; a link carries `nav=walk` or `nav=fly` (nothing for
Spectator, so older links read the same) and opens in the mode
(`src/navigation/store.js`). Spectator changes nothing.

- **Walk.** The eye 1.62 m above the feet, gravity (32 m/s², so a jump
  rises 1.25 m in Minecraft's 0.6 s), walk 4.3 m/s, sprint 5.6 (W twice
  within 300 ms, held), Space jumps, a step up climbed without jumping (one
  block under Blocks, 0.6 m elsewhere), drops of 0.3 m or less followed
  rather than fallen, swimming in water (2.2 m/s across, Space up at 2 m/s,
  sinking at 1 m/s). A walker more than 50 m above a known surface is put
  down on it. Shift sneaks, Minecraft's default: 1.3 m/s, the eye eased
  0.3 m lower over 0.1 s, and on the ground the body never steps off an
  edge deeper than a slope it follows (0.3 m), nor into ground not yet
  known; it closes on the edge as on a wall, and a jump still leaves it.
- **Controls** (`src/navigation/settings.js`). Kept in this browser
  (localStorage `gev.nav.settings`), never in the link: mouse sensitivity
  (0.1–2×), invert Y, the vertical field of view (30–110°, 70), the walk,
  sprint and fly speeds, sneak held or toggled, the sprint widening, view
  bobbing, and the key bindings (`event.code`, one key an action once
  rebound). Minecraft's defaults: WASD and the arrows, Space, Shift, G
  walks here, Esc releases; sprint, up, down and fly-here unbound (sprint
  is W twice). A key is refused where the app has a shortcut (1–7, H, O,
  V, F, D, C, Esc, `) unless it is that action's own default (D is right),
  and where another action has it. Bindings apply at once.
- **Inputs** (`src/navigation/inputs.js`). The keys and the mouse are one
  input source among others: each frame every source's `read(dt)` gives
  partial intents (forward, back, left, right, jump, sneak, sprint, up,
  down held; `lookDx`/`lookDy` in pointer-lock pixels; `walkHere`/`flyHere`
  one-shot), merged (held OR'd, looks added) and turned into the model's
  input for the mode. `addInputSource(source)` adds one (a gamepad); in
  Spectator such a source's walkHere/flyHere is read each frame while it
  is registered. A stick gives `analog: {forward, right}` (−1…1): per axis
  the larger of it and the keys' ±1 wins, and a stick part way walks part
  speed (never faster than a key on the diagonal). One-shots besides
  walkHere/flyHere: `release` leaves the mode (the pointer let go,
  Spectator), `toggleMode` switches Walk and Fly, `flySpeedStep` (±1 a
  press) moves Fly's speed a wheel notch. `showInputHint(text, ms)` (or
  `binding.hint`) says a line over the crosshair. Looks are pointer-lock
  pixels at each source's own sensitivity and inversion: the Controls'
  mouse sensitivity and invert Y apply to the mouse alone (as it moves),
  so a gamepad's own settings never compound with them. A source adds
  its own rows to the Controls card with
  `navSettings().registerSection({id, title, rows})` (rows: `range` with
  min, max, step, or `toggle`; each with a default), kept under
  `gev.nav.<id>` and reset with the rest.
- **Fly.** No gravity, 10.8 m/s (W twice doubles it), Space up and Shift down
  at 7.5 m/s; the ground and blocks still stop it. The mouse wheel sets the
  speed, Minecraft spectator's: 1.25× a notch, up faster, between 1 and
  50 m/s (a log scale), said over the crosshair for 2 s; entering Fly
  starts again from the Controls' fly speed.
- **Looking.** WASD (or the arrows) and the mouse under Pointer Lock: a
  click on the globe captures the pointer, Esc releases it. Yaw and pitch
  only; roll is held at 0. The field of view is 70° from top to bottom (the
  Controls' setting), Cesium's horizontal `fov` for the canvas's shape (96°
  at 16:10), and the previous one comes back on leaving. Sprinting forward
  widens it 10° over 0.2 s and back (Minecraft's dynamic FOV), unless the
  Controls hold it fixed. A crosshair marks the centre, and the
  looked-at block is outlined (its 12 edges; a ray through `occupancy` to
  the first solid block within 64 blocks), or off the Blocks a small ring
  where the centre's depth pick lands. The HUD's MODE line names the mode
  and what it stands on ("MODE WALK · Blocks 1 m", "· Google", "· no
  surface: hovering", and "· click to look" until the pointer is captured).
- **The world.** Under Blocks, the chunk store's occupancy in the Blocks
  region's frame (heights above mean sea level; a block's top drawn at its
  height plus the region's geoid undulation plus its chunk's drop below the
  tangent plane, as the renderer places it). The Blocks controller
  provides it through `provideBlocksWorld(() => ({region, chunkAt,
  geoidM}))` (`src/navigation/blocksSource.js`). Elsewhere, the trusted
  surface (`src/surfaceTrust.js`: a ray from 9 km, coarse tiles refused)
  sampled per 0.5 m cell for a second, in a local frame anchored at the
  camera (again when it is 2 km out): buildings and trees are walls a
  walker steps up only as far as a kerb. Nothing known under the body: it
  hovers, never falls through the world.
- **The binding** (`src/navigation/binding.js`). While a mode is on,
  `ScreenSpaceCameraController.enableInputs` and
  `enableCollisionDetection` are off (the model collides; Cesium's own
  collision lifted a walker off the blocks onto the Google tiles above
  them), both restored on leaving. The camera is driven in `scene.preUpdate`
  with the time step clamped to 0.1 s (`applyCameraView`); a flight in
  progress (a search, a link) owns the camera until it lands, and a camera
  moved by anything else is taken as the walker's new place. Movement keys
  are taken in the capture phase, outside form fields, so the app's own
  shortcuts (D cycles detection) wait. No Ctrl anywhere: Ctrl+W closes the
  browser tab, and a page cannot stop it.
- **In and out** (`src/navigation/entry.js`). In Spectator, G (or the
  Here button beside Move) walks onto the targeted block, the one under
  the pointer: the walker stands on top of the solid run it belongs to (a
  wall's face puts it on the wall), at the column's centre, facing the
  camera's heading with its pitch kept; Shift+G or Shift-click flies
  there. With nothing targeted it stands on the surface under the view's
  centre. Leaving Walk or Fly for Spectator flies the camera in 1.2 s to
  a view 60 m behind and 60 m above the walker, looking down at where it
  stood (about 46°). Entering a mode shows the keys over the crosshair for
  4 s ("WASD move · Space jump · Shift sprint · Esc release"; Fly: "Space/
  Shift up/down"), and the MODE line's tooltip lists them. Each goes
  through the mode store, so the link's `nav=` follows. Checked in Chromium
  on a 1 m Blocks world with a building: G on the pointer's wall block
  stood the walker on the roof (feet 36.000 m, at the column's centre,
  heading 20° and pitch −35° kept); leaving lifted the camera to 60.0 m
  back, 0.0001 m aside and 60.0 m up at −45.76°; with nothing targeted the
  eye landed 1.65 m over the surface at the view's centre.
- **The targeted block** (Minecraft's F3, lessons 10–11;
  `src/navigation/targeting.js`, `target.js`, `src/hud/blockTarget.js`).
  While Blocks is drawn, in any mode, the HUD's pose block shows a BLOCK
  line for the block under the crosshair (Walk, Fly) or under the mouse
  pointer (Spectator): "39.321408 -76.629200 · L47 (47 m) · terrain · 3DEP
  1 m", the column's centre to half a block (6 decimals at 1 m, 4 at
  30 m), the level and its base above sea level, the material (terrain,
  building) and the elevation source; the tooltip names the chunk and the
  block's region column. The ray (the camera's direction, or Cesium's
  pick ray at the pointer) is walked through the store's occupancy in the
  Blocks region's frame, up to 2,048 blocks (20 km at most); where that
  finds nothing (it leaves the loaded chunks, or starts outside them), the
  depth pick there is snapped to the block it lies on. Looked for at most
  every 100 ms after a frame, and at once on a pointer move; hidden when
  nothing is targeted. The same facts ride on the Walk/Fly block outline's
  lines as their `id`, for a later click to dig.
- **The model** (`src/navigation/movement.js`, `worlds.js`) is pure:
  state, keys and a time step give the next state, with the body a column
  1.8 m tall, sliding along walls, a ceiling stopping a jump, and the
  vertical step exact under constant acceleration (a jump peaks at 1.25 m
  at any frame rate). A blocked step is closed on the wall by bisection
  (to 1/256 of the step), so the body comes to rest against it rather than
  a frame's travel short (18 cm at Fly's speed). Buildings (the store's
  structures layer) are blocks like any other: occupancy and topSolid
  include them.

Checked in Chromium on a synthetic flat tileset at Baltimore: Walk held
the eye 1.620 m (±0.000001) above the tiles over 116 frames of W for 2 s,
8.60 m covered; Fly rose 7.6 m in a second; a Blocks world put the eye
1.62 m over the block tops; leaving restored inputs, collision and the
field of view.
Against buildings (2026-10-27, a 1 m Blocks world built with
setStructure): a 2-block wall stopped a walker 0.00002 m from it and it
slid 6.1 m along it at 45°; a 1-block plinth was walked up, a 2-block one
not even jumping, and a jump landed on a 1-block ledge; in a hollow
building (a room carved from a structure) a jump's head peaked at 33.99 m
under a 34 m ceiling; Fly stopped at a building's wall and rested on its
roof; the outline sat on the wall block under the crosshair (12 edges, its
corners exact), a building block.

## Navigation controls

How Walk and Fly are driven, Minecraft's way, from the keyboard and mouse,
a gamepad, the Controls card, and the view, compass and waypoints around
them. All of it applies only while the **Move** drop-down beside Render
says Walk or Fly; Spectator is GEV's own camera and keeps its own
controls (below). The movement itself is "Walk and Fly" above.

### Keys

Defaults (Minecraft Java's, where it has one). Every key is
`KeyboardEvent.code`, so the layout's letters do not matter; the movement
keys can be rebound in the Controls card. No Ctrl anywhere: Ctrl+W closes
the browser tab, and a page cannot stop it.

| Action               | Walk                            | Fly                             | Spectator   |
| -------------------- | ------------------------------- | ------------------------------- | ----------- |
| Move                 | W A S D, the arrows             | W A S D, the arrows             | GEV's own   |
| Look                 | the mouse, the pointer captured | the mouse, the pointer captured | GEV's own   |
| Capture / release    | click the globe / Esc           | click the globe / Esc           | —           |
| Jump / up            | Space (jump)                    | Space (up, 7.5 m/s)             | —           |
| Sneak / down         | Shift (sneak: hold, or toggle)  | Shift (down)                    | —           |
| Sprint               | W twice within 300 ms, held     | W twice: double speed           | —           |
| Fly speed            | —                               | the wheel: 1.25× a notch        | —           |
| Walk here / Fly here | —                               | —                               | G / Shift+G |
| View                 | T: first, behind, in front      | T                               | —           |
| Set home / go home   | B / Shift+B                     | B / Shift+B                     | —           |

Esc lets the pointer go and stays in the mode; the Move drop-down (or a
gamepad's Start) goes back to Spectator. The movement keys are taken in the
capture phase, outside form fields, so the app's own shortcuts (D cycles
detection) wait while a mode is on; T and B are not the app's, and do
nothing in Spectator.

### Gamepad

`src/navigation/gamepad.js` (worker2's), Minecraft Bedrock's layout on
the standard mapping, an input source beside the keyboard
(`addInputSource`). It is polled only while Walk or Fly is on and a pad
is connected.

| Control              | Walk                          | Fly                       |
| -------------------- | ----------------------------- | ------------------------- |
| Left stick           | move, at the tilt's speed     | move, at the tilt's speed |
| Right stick          | look                          | look                      |
| A                    | jump                          | up                        |
| B                    | sneak                         | down                      |
| LT / RT              | —                             | down / up                 |
| Stick click (either) | sprint, until the stick rests | double speed              |
| Start                | leave for Spectator           | leave for Spectator       |
| Back (Select)        | to Fly                        | to Walk                   |
| D-pad left / right   | —                             | fly speed down / up       |

A stick part way walks part speed (per axis the larger of the stick and a
key wins, never faster than a key on the diagonal). The right stick turns
at 600 pointer-lock pixels a second at full tilt, the tilt squared past the
dead zone so a small tilt aims finely. Start, Back and the D-pad fire once
a press. Its settings (dead zone 0–0.5, 0.15; sensitivity 0.5–3×; invert
X; invert Y) are the Controls card's Gamepad section, kept under
`gev.nav.gamepad`, and never compound with the mouse's.

### The Controls card

The gear beside Move opens it (worker1's, `src/navigation/settings.js`),
kept in this browser (`gev.nav.settings`), never in a link, applied at
once:

- **Mouse**: sensitivity (0.1–2×), invert Y.
- **View**: the vertical field of view (30–110°, 70°); the sprint widening
  (10° over 0.2 s, Minecraft's dynamic FOV) on or off; view bobbing on or
  off.
- **Speeds**: walk (4.3 m/s), sprint (5.6), fly (10.8; the wheel moves it
  from there for the session, between 1 and 50).
- **Sneak**: Hold (while Shift is down) or Toggle (press once).
- **Keys**: a button per action showing its key. A click shows "Press a
  key…"; the next key is bound (one key an action once rebound), Esc
  cancels, Backspace leaves the action unbound. Refused, with the reason:
  the app's own shortcuts (1–7, H, O, V, F, D, C, Esc, `) unless the key
  is that action's own default (D is Walk's right), a key another action
  has, Ctrl, the system key, and F1–F12.
- **Gamepad**: the section above, added by the gamepad source through
  `navSettings().registerSection`.
- **Reset** puts everything back, the keys and the sections too.

### Third person, the compass, home and waypoints

- **T** cycles the view: first person, **behind** the walker, **in front**
  of it looking back (Minecraft's F5, which a browser keeps for reloading).
  The camera stands 4 m from the eye along the look direction and is
  pulled in to just short of a block or the surface between them
  (`src/navigation/view.js`: the Blocks occupancy's raycast, else the
  trusted surface walked in 0.25 m steps; never nearer than 0.3 m). The
  walker still moves and looks; the camera only watches. An orange
  0.6 × 1.8 m box stands where the walker stands, turned to its heading
  (`playerMarker.js`, one primitive moved by its model matrix). The choice
  is kept in this browser (`gev.nav.view`); the HUD's MODE line says
  "· 3rd" (or "· 3rd, front"). The view button beside Move does the same.
- **The compass**: a small rose in the HUD's pose block while a mode is
  on, turning with the walker's heading, N in red, the straight-ahead mark
  at the top; with a home set, an orange tick on the rim points to it
  (the great-circle bearing less the heading).
- **Home**: **B** (or **Set home** beside Move) keeps where the walker
  stands: its longitude, latitude, eye height, the block level underfoot
  and its heading. **Shift+B** (or **Home**) goes back there, walking in
  from Spectator, keeping Walk or Fly otherwise. Going uses the navigation
  store's entry with a pose (`store.requestEntry(mode, pose)`), and the
  walker is placed the way each frame places it (third person, the field
  of view, the marker).
- **Places**: a list of waypoints under the same card: a name and **Add
  here** keep where the walker stands (up to 50, the oldest go), a click on
  one goes there, ✕ deletes it. Each row says where: "39.32140, −76.62920 ·
  level 36".

Home and waypoints are kept in this browser (`gev.nav.home`,
`gev.nav.waypoints`), never in a link, as absolute places, so they outlive
the Blocks region they were set in (a region is anchored at the camera and
moves on with it).

### What Spectator keeps

Spectator is GEV's own camera, unchanged: its mouse and touch controls,
Cesium's collision, the app's keyboard shortcuts (H, O, V, F, D, C, 1–7,
Esc), the search and its flights. Nothing of the above listens there
except G and Shift+G (and the Here button), which walk or fly onto the
block under the pointer, and a gamepad's walk-here, read only while a pad
is registered. A link without `nav=` opens in Spectator, as every link
from before Walk and Fly does.

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
