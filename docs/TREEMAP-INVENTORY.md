# Treemap inventory: every dataset, field, unit and hierarchy GEV holds

Personal fork, 2026-11-11. An analysis for the treemap browser: a
mini-window driven by an address of the form

    [unit]/[variable]://[grouping][/ or x][grouping]…

for example `km²/surface area://administrative boundaries` (countries >
regions > counties, a rectangle's area its surface area). Left of `://`
the rectangle's size: a unit, then a variable measured in it. Right of it
how that total is cut, by what the data already contains. The same data
drives the globe and the treemap. This document lists what there is to
choose from; it designs no window.

Every count is measured, on 2026-11-11 unless a row says otherwise, from a
build manifest, a bundled file, a disk cache or a free list endpoint of the
local server (read-only; nothing asked of Earth Engine, Overpass, OpenSky
or FIRMS). "unknown / live" means nothing on disk says how many. Paths are
relative to the checkout; `.gev-cache/` is the server's cache folder
(junctions to the internal and external drives), and the raw downloads sit
on the external drive under `gev-data/`.

**Conventions.**

- **Tier.** A: global, on disk or one request away. B: global, but only
  through a request per area (Earth Engine rasters, Overpass, per-tile
  APIs). C: a regional dataset. D: a live stream.
- **Level.** nom (nominal), ord (ordinal), interval, ratio (Stevens).
  Positions, times, years and temperatures in °C are interval; angles are
  interval and circular.
- **Sum.** For a ratio field: **E** extensive (additive over records: it
  can size a rectangle: area, length, count, people, volume, energy, money
  spent), **I** intensive (not additive: density, mean, median, share,
  rate, speed, height; colour or bins only). A field that is additive only
  within one record or one partition says so. An intensive field times its
  extensive base is extensive again (elevation × area = volume): 4.2 lists
  each one's base and product, and 4.1 lists the products under their
  units.
- **Unit.** SI base or derived form; where the stored unit differs it is
  given as stored → SI (kn → m/s, ft² → m², acre → m²). "none" for codes
  and text, "count" for a number of things.
- **Derivable** measures are not stored but follow from what is: a
  polygon's area (m², E), a line's length (m, E), a record count (count,
  E), a duration (s, E).

## 1. Datasets

One row per layer or dataset. Layers by their panel id
(`src/ui/layerNames.js`); Earth Engine layers by `src/data/earthEngineLayers.js`.

### 1.1 Places, boundaries and the built world

| Dataset (layer)                                                        | Entity                              | Geometry | Count (measured from)                                                                                                                                                    | Tier                        | Lives in                                                                                |
| ---------------------------------------------------------------------- | ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- | --------------------------------------------------------------------------------------- |
| Overture division areas (boundaries fill, cutouts)                     | administrative unit                 | polygon  | 43,345: county 38,933, region 3,929, country 219 + 159 sea, dependency 53 + 52 sea (areas manifest)                                                                      | A                           | `.gev-cache/overture/build/areas/` (193 MB); `/api/boundaries/areas/*`                  |
| Overture boundary lines (`ee-admin-boundaries` level 0 when built)     | border line                         | polyline | 87,530: county 78,771, region 8,202, country 557; 47 disputed (boundaries manifest)                                                                                      | A                           | `.gev-cache/overture/build/boundaries/` (50 MB); `/api/boundaries/tile/*`               |
| Overture localities (`localities`)                                     | populated place or neighbourhood    | point    | 4,639,407 in 265 countries (build `c572a53cd594` manifest)                                                                                                               | A                           | `.gev-cache/overture/build/c572a53cd594/`; `/api/overture`                              |
| Natural Earth populated places (`localities`, bundled)                 | populated place                     | point    | 7,342 (file length)                                                                                                                                                      | A                           | `src/data/local_data/natural_earth/populated_places.json`                               |
| Natural Earth countries, states and provinces (cutouts pack, outlines) | country; state or province          | polygon  | 260 countries; 4,587 states and provinces in 241 countries, 105 type names (file lengths)                                                                                | A                           | `src/data/local_data/natural_earth/{countries,states_provinces}.json`                   |
| US counties (cutouts pack)                                             | county                              | polygon  | 3,235 (file length)                                                                                                                                                      | C                           | `src/data/local_data/us_census_counties/counties.json`                                  |
| Natural Earth marine areas and regions                                 | ocean, sea, island, region name     | polygon  | 292 marine, 1,046 regions (file lengths)                                                                                                                                 | A                           | `src/data/local_data/natural_earth/{marine,regions}.json`                               |
| San Francisco neighbourhoods (annotation resolver)                     | neighbourhood                       | polygon  | 41                                                                                                                                                                       | C                           | `src/data/local_data/neighborhoods/san-francisco.json`                                  |
| Overture places (`places`)                                             | point of interest                   | point    | 64,735,759 (of 81,455,423 read; places manifest)                                                                                                                         | A                           | `.gev-cache/overture/places/` (2.42 GB); `/api/overture/places`                         |
| Overture infrastructure (`street-assets` pins)                         | street fixture                      | point    | 11,192,582: street lamp 6,448,036, fire hydrant 2,533,349, traffic signals 2,008,803, charging station 202,394 (infrastructure manifest)                                 | A                           | `.gev-cache/overture/infrastructure/` (91 MB); `/api/overture/infrastructure`           |
| Overture buildings (`ee-buildings` outside Open Buildings)             | building footprint                  | polygon  | 579,463,210: US 164,043,095, Europe 415,420,115; 212,933,097 with a height (buildings manifest)                                                                          | C (conterminous US, Europe) | `.gev-cache/overture/buildings/` (13.3 GB)                                              |
| Overture roads (`roads`, bike lanes in `street-assets`)                | road segment                        | polyline | 170,479,230 segments (287,338,689 pieces at the finest level): US 62,891,172, Europe 107,588,058 (roads manifest)                                                        | C (conterminous US, Europe) | `.gev-cache/overture/roads/` (5.9 GB); `/api/roads`                                     |
| Overture divisions hierarchy                                           | division with its parents           | —        | 4,688,229 rows (raw parquet); not built                                                                                                                                  | A (raw only)                | raw `division` parquet, 582 MB                                                          |
| Property records (`property-sales`)                                    | property record (in a building pin) | point    | 145,616,857 records in 112,491,498 pins (build `642429061468`)                                                                                                           | C (US)                      | property index, 10.25 GB on the internal drive; `/api/property`                         |
| Maryland parcels (cutouts `mdp:`)                                      | parcel                              | polygon  | per click; 1 cached                                                                                                                                                      | D (Maryland)                | `/api/parcels/md`; `.gev-cache/md-parcels/`                                             |
| Census tracts (`ee-census-tracts` local modes)                         | census tract                        | polygon  | 85,184 tracts in 56 state FIPS, 3,235 counties (census build manifest)                                                                                                   | C (US, PR)                  | `.gev-cache/census/build/` (57 MB); `/api/census`                                       |
| Census tracts, TIGER 2020 (`ee-census-tracts` outline mode)            | census tract                        | polygon  | 85,528 (Earth Engine table)                                                                                                                                              | B                           | `TIGER/2020/TRACT`                                                                      |
| Blocks tilesets (Render: Blocks)                                       | 3D Tiles tile of block meshes       | mesh     | 7 boxes, 37,144 tiles, 56.1 GB: lower48-120 18,820, europe-120 14,612, lower48-480 1,508, europe-480 1,316, baltimore-metro-30 556, two harbour boxes 332 (build states) | C                           | tile trees on the external drive and in `.gev-cache/blocks-tiles/`; `/api/blocks/tiles` |

### 1.2 Water and terrain

| Dataset (layer)                                                 | Entity                 | Geometry                   | Count (measured from)                                                                                            | Tier                    | Lives in                                                                               |
| --------------------------------------------------------------- | ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------- |
| HydroSHEDS v2 network (`rivers` drawn network)                  | river reach            | polyline                   | 20,990,675 reaches, 635,073,076 vertices: North America 11,558,529, South America 9,432,146 (rivers v2 manifest) | C (Americas)            | `.gev-cache/rivers/v2/` (836 MB); `/api/rivers/v2`                                     |
| River names (OSM waterways, matched to v2)                      | name group; named line | polyline, label point      | 802,835 name groups from 5,825,096 OSM ways; 63,138 labels; 2,655,000 v2 reaches named (names manifest)          | A (lines), C (matching) | `.gev-cache/rivers/names/` (1.55 GB); `/api/rivers/names`                              |
| HydroRIVERS v1 + Free-Flowing Rivers (`ee-rivers`, reach click) | river reach            | polyline                   | 8,477,883 (Earth Engine table); 52 reaches cached by clicks                                                      | B (table), D (clicks)   | `WWF/HydroSHEDS/v1/FreeFlowingRivers`; `/api/rivers/reach`; `.gev-cache/rivers/reach/` |
| Natural Earth river labels (bundled)                            | river                  | label points               | 1,097                                                                                                            | A                       | `src/data/local_data/natural_earth/river_names.json`                                   |
| Dams (`local-dams`)                                             | dam or hydro plant     | polygon (688), point, line | 704 (file length)                                                                                                | A                       | `src/data/local_data/dams/dams.geojsonl`                                               |
| `ee-elevation`                                                  | DEM cell               | raster                     | 6 sources, 1 m to 231 m; 11,907 kept answers in `.gev-cache/raster-values`                                       | B                       | Earth Engine (`src/data/demStack.js`); `/api/raster/values`                            |
| `ee-terrain-slope`, `ee-terrain-aspect`, `ee-terrain-hillshade` | DEM cell               | raster                     | as Elevation                                                                                                     | B                       | Earth Engine `ee.Terrain`                                                              |
| `ee-elevation-contours`                                         | contour line mask      | raster (picture)           | as Elevation                                                                                                     | B                       | Earth Engine                                                                           |
| `ee-surface-water`                                              | 30 m cell              | raster                     | `JRC/GSW1_4/GlobalSurfaceWater`                                                                                  | B                       | Earth Engine                                                                           |
| `ee-inundation`                                                 | 250 m cell             | raster                     | 913 flood events 2000–2018                                                                                       | B                       | `GLOBAL_FLOOD_DB/MODIS_EVENTS/V1`                                                      |
| MODIS water mask (Elevation's water plane)                      | 250 m cell             | raster                     | `MODIS/006/MOD44W/2015_01_01`                                                                                    | B                       | Earth Engine, with Elevation                                                           |

### 1.3 Land, people and knowledge

| Dataset (layer)                             | Entity                          | Geometry         | Count (measured from)                                                                        | Tier | Lives in                                                                       |
| ------------------------------------------- | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `ee-land-cover`                             | 10 m cell                       | raster           | 11 classes; ESA WorldCover 2021 (v200) and 2020 (v100)                                       | B    | Earth Engine                                                                   |
| `ee-forest-types`                           | 10 m cell                       | raster           | 3 classes; `JRC/GFC2020_subtypes/V1`                                                         | B    | Earth Engine                                                                   |
| `ee-forest-loss`                            | 30 m cell                       | raster           | loss years 2001–2025; Hansen v1.13                                                           | B    | Earth Engine                                                                   |
| `ee-tree-canopy`                            | 1.2 m (Meta) or 10 m (ETH) cell | raster           | 170 Meta tiles                                                                               | B    | Earth Engine                                                                   |
| `ee-buildings` (Open Buildings)             | 0.5 m cell; footprint           | raster; polygon  | 46 coverage boxes (Africa, South and Southeast Asia, Latin America)                          | B    | `GOOGLE/Research/open-buildings-temporal/v1`, `.../open-buildings/v3/polygons` |
| `ee-population`                             | 100 m cell                      | raster           | 4 epochs served (1975–2020) of GHSL P2023A                                                   | B    | Earth Engine                                                                   |
| `ee-admin-boundaries` (Earth Engine)        | administrative unit             | polygon          | LSIB 2017 279 countries; GAUL 2025 level 1 3,104, level 2 43,819                             | B    | Earth Engine tables (outlines only)                                            |
| Wikipedia grid (`wikipedia-coverage`)       | 0.05° cell                      | raster           | 1,259,442 enwiki articles in 486,898 cells, 5 levels (grid header)                           | A    | `.gev-cache/wikipedia/grid.bin` (276 MB)                                       |
| Wikipedia H3                                | H3 cell, res 0–7                | hexagon          | 734,514 cells at res 7 … 122 at res 0                                                        | A    | `.gev-cache/wikipedia/h3.bin` (44 MB)                                          |
| Wikipedia points                            | article                         | point            | 2,640,556 articles from 11 wikis on 860,035 Wikidata items (points manifest)                 | A    | `.gev-cache/wikipedia/points/` (283 MB)                                        |
| GHSL population grid (per-capita base)      | 0.05° cell; H3 cell             | raster; hexagon  | world total 7,794,374,709 people (2020)                                                      | A    | `.gev-cache/wikipedia/{population,capita}.bin`                                 |
| World history, Cliopatria (`world-history`) | polity in one period            | polygon (3 LODs) | 13,797 records: 13,412 polities, 385 relations; 1,637 polity names; −3400 to 2024 (manifest) | A    | `.gev-cache/world-history/` (76 MB); `/api/world-history`                      |
| Cottereau borders (private)                 | polity polygon per sampled year | polygon          | a private build outside the repository; not a treemap source                                 | —    | `COTTEREAU_BORDERS_DIR`                                                        |

### 1.4 Cameras, sites and infrastructure

| Dataset (layer)                                             | Entity                 | Geometry                     | Count (measured from)                                                                                              | Tier                                                         | Lives in                                                                           |
| ----------------------------------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `cctv`                                                      | camera                 | point (+ view cone)          | about 79,857 in the proximity index (sum of 22 packs); 3,999 served in the capped catalog; camindex 64,514 on disk | A (camindex, linked, NPS, USGS), C (agency packs), B (Windy) | `.gev-cache/camindex/`, `cctv-linked/`, `cctv-packs/`; `/api/cctv/*`               |
| `alpr-cameras`                                              | ALPR camera (OSM node) | point                        | unknown / live (hourly OSM tiles)                                                                                  | C (US, Canada)                                               | `tiles.dontgetflocked.com` vector tiles                                            |
| `baltimore-enforcement-cameras`                             | enforcement camera     | point                        | 336: red light 180, fixed speed 21, portable speed 128, truck height 7 (ArcGIS count)                              | C                                                            | Baltimore City ArcGIS, per session                                                 |
| `baltimore-citiwatch-cameras`                               | CitiWatch camera       | point                        | 861 (ArcGIS count)                                                                                                 | C                                                            | Baltimore City ArcGIS, per session                                                 |
| `recorded-video`                                            | geolocated video       | point                        | 1,792 Wikidata videos on 1,308 items; 37 + 18 from YouTube searches (caches)                                       | A (Wikidata), B (YouTube)                                    | `.gev-cache/recorded-video/`                                                       |
| Street level (Mapillary, Panoramax, KartaView, Street View) | image; sequence        | point; polyline              | unknown / live; 23 indoor panoramas cached                                                                         | B                                                            | provider tiles; `.gev-cache/{mapillary,streetview-indoor}/`                        |
| `military-installations`                                    | military area (OSM)    | polygon, label point         | 36,466 named areas (bundled); live Overpass per view                                                               | A (bundle), B (live)                                         | `src/data/local_data/osm_military_names/names.json`; `/api/military-installations` |
| `local-datacenters`                                         | data centre (OSM)      | polygon (3,509), point (834) | 4,351 (file length)                                                                                                | A                                                            | `src/data/local_data/datacenters/datacenters.geojsonl`                             |
| `telegeography-submarine-cables`                            | cable; landing point   | multiline; point             | 694 cables in 712 features; 1,917 landing points                                                                   | A                                                            | `src/data/local_data/telegeography_submarine_cables/`                              |

### 1.5 Live feeds

| Dataset (layer)     | Entity                      | Geometry              | Count (measured)                                   | Tier                    | Lives in                                |
| ------------------- | --------------------------- | --------------------- | -------------------------------------------------- | ----------------------- | --------------------------------------- |
| `flights`           | aircraft (ICAO address)     | point + altitude      | unknown / live (not asked: spends OpenSky credits) | D                       | OpenSky → `/api/flights`                |
| `military`          | military aircraft           | point                 | 116 (65 positioned)                                | D                       | adsb.lol → `/api/military`              |
| `local-adsb`        | aircraft heard locally      | point                 | 0 (no receiver configured)                         | D                       | `/api/local-receivers/aircraft`, WebUSB |
| `ais-live-vessels`  | vessel (MMSI)               | point + short track   | 29,832                                             | D                       | AISStream → `/api/vessels`              |
| `satellites`        | orbiting object (NORAD id)  | propagated point      | 826 core + 10,619 Starlink; 15,884 active in cache | A                       | CelesTrak → `/api/celestrak/*`          |
| `rocket-launches`   | launch                      | point (pad)           | 23 in 30 days                                      | A                       | Launch Library 2 → `/api/launches`      |
| `earthquakes`       | event                       | point + depth         | 34 at M ≥ 2.5 of 197 in the day                    | D                       | USGS feed (browser)                     |
| `local-firms`       | thermal anomaly pixel       | point                 | 175,840 (stale cache of 2026-10-18)                | A                       | NASA FIRMS → `/api/firms`               |
| `fire-perimeters`   | incident                    | multipolygon          | 64 in 18 states                                    | C (US)                  | NIFC WFIGS → `/api/fire-perimeters`     |
| `gnss-integrity`    | 0.5° cell of aircraft fixes | rectangle             | unknown / live (per view)                          | B                       | adsb.lol → `/api/gnss-integrity`        |
| `weather-radar`     | pixel of a picture          | raster (colours only) | 13 frames                                          | C (CONUS)               | NOAA nowCOAST → `/api/weather/*`        |
| `weather-satellite` | pixel of a picture          | raster (colours only) | 8 global + 13 regional frames                      | A, C                    | NOAA nowCOAST                           |
| `weather-lightning` | pixel of a picture          | raster (colours only) | 13 frames                                          | C                       | NOAA nowCOAST                           |
| `weather-cyclones`  | storm                       | point, track, cone    | 1                                                  | C (Atlantic, N Pacific) | NHC → `/api/cyclones`                   |
| `wind`              | 1° cell                     | raster                | 65,160 cells                                       | A                       | GFS or IFS → `/api/wind`                |
| `air-quality`       | monitoring station          | point                 | 134 stations in 5 zones                            | C (Canada)              | ECCC (browser)                          |
| `traffic`           | flow segment                | polyline              | unknown / live (per tile)                          | B                       | TomTom → `/api/tomtom/*`                |
| `transit`           | vehicle                     | point (+ trail)       | 9,647 in 16 feeds                                  | C                       | GTFS-Realtime → `/api/transit/*`        |
| `bikeshare`         | docking station             | point                 | 13,349 in 52 systems                               | C                       | GBFS → `/api/gbfs/*`                    |
| `radio`             | internet radio station      | point                 | 750 in 101 countries                               | A                       | Radio Browser → `/api/radio/stations`   |
| `recent-imagery`    | satellite granule           | polygon               | unknown / live (per box)                           | B                       | NASA CMR (browser)                      |

### 1.6 Computed layers (no data of their own)

| Layer                | What it computes                                                        | Count       |
| -------------------- | ----------------------------------------------------------------------- | ----------- |
| `directions`         | a route and its steps (OSRM)                                            | per request |
| `grid`               | graticule and MGRS lines for the view                                   | per view    |
| `custom-cutouts`     | up to 12 user-picked shapes (OSM relation, bundled pack, parcel, drawn) | per link    |
| `military-awareness` | nearby contacts per feed around a subject                               | per subject |

## 2. Fields

Per dataset, every field a record carries, then what can be derived.
Identity fields (ids, keys, URLs, colours) are nominal and listed only
where they link to something.

### 2.1 Overture division areas

| Field             | Meaning                                     | Unit | Level      | Sum |
| ----------------- | ------------------------------------------- | ---- | ---------- | --- |
| id                | the division area's id (not the division's) | none | nom        | —   |
| subtype           | country, dependency, region, county         | none | ord (rank) | —   |
| kind              | land or sea                                 | none | nom        | —   |
| country           | ISO 3166-1 alpha-2                          | none | nom        | —   |
| region            | ISO 3166-2                                  | none | nom        | —   |
| name, nameEn      | names                                       | none | nom        | —   |
| box, band offsets | Mercator box, polygon bands                 | none | —          | —   |

Derivable: area in m² (E) from the finest band (121,846,314 vertices in
all bands). Not stored: population, the division id, admin level.

### 2.2 Overture boundary lines

| Field | Meaning                                                       | Unit | Level | Sum |
| ----- | ------------------------------------------------------------- | ---- | ----- | --- |
| class | one of 7: subtype × land or maritime × disputed × perspective | none | nom   | —   |

Derivable: length in m (E). Not stored: line id, the units on either side.

### 2.3 Overture localities

| Field               | Meaning                                                                                            | Unit           | Level                     | Sum                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------------------- | -------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| lon, lat            | position                                                                                           | °              | interval                  | —                                                                                    |
| population          | Overture population                                                                                | count (people) | ratio                     | E, but nested places overlap (a city and its neighbourhoods): sum one kind at a time |
| prominence          | cartographic prominence 0–100                                                                      | none           | ord                       | —                                                                                    |
| minZoom             | zoom the place is named from                                                                       | none           | ord                       | —                                                                                    |
| kind                | city, town, village, hamlet, locality, localadmin, county, macrohood, neighborhood, microhood (10) | none           | nom (roughly ord by size) | —                                                                                    |
| country             | ISO 3166-1 alpha-2                                                                                 | none           | nom                       | —                                                                                    |
| region              | ISO 3166-2                                                                                         | none           | nom                       | —                                                                                    |
| name, es, ru, local | names                                                                                              | none           | nom                       | —                                                                                    |
| wikidata            | Wikidata item                                                                                      | none           | nom                       | —                                                                                    |

By kind: hamlet 1,712,328, village 1,558,002, neighborhood 728,226,
microhood 237,753, macrohood 156,594, locality 113,333, town 103,177,
city 14,199, county 8,300, localadmin 7,495.

### 2.4 Natural Earth and US Census packs

| Pack                         | Fields                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| populated places             | name, es, ru (nom); rank (scalerank, ord); z (min zoom, ord); pop (POP_MAX, people, ratio, E but metro maxima overlap); cap: country 216, region 2,357 (nom); c (country, nom); at (°) |
| countries                    | name, alt, country, iso (alpha-3), iso2, type (Country, Constituent country) (nom); polygons                                                                                           |
| states and provinces         | name, alt, postal, type (105 names), country, iso2, iso (ISO 3166-2) (nom); rank (ord); label (°); polygons                                                                            |
| US counties                  | name, full, lsad, state, st, geoid (5-digit FIPS) (nom); polygons                                                                                                                      |
| marine, regions              | name, featurecla (ocean, sea, bay, island…) (nom); polygons                                                                                                                            |
| river labels                 | name, ru (nom); rank (ord); at (°)                                                                                                                                                     |
| San Francisco neighbourhoods | name (nom); polygon                                                                                                                                                                    |

Derivable: polygon areas (m², E).

### 2.5 Overture places

| Field          | Meaning                                                                                                        | Unit | Level    | Sum |
| -------------- | -------------------------------------------------------------------------------------------------------------- | ---- | -------- | --- |
| x, y           | position, 2²⁸ Mercator grid                                                                                    | none | interval | —   |
| confidence     | Overture confidence, 0.5–1                                                                                     | none | ratio    | I   |
| category       | 11 codes: food, shopping, health, education, transport, lodging, public, religion, recreation, charging, other | none | nom      | —   |
| basic          | Overture `basic_category`                                                                                      | none | nom      | —   |
| name           | primary name                                                                                                   | none | nom      | —   |
| brand          | brand name                                                                                                     | none | nom      | —   |
| source         | first source (Meta 43.2 M, BrightQuery 9.1 M, Microsoft 6.1 M, Foursquare 4.1 M…)                              | none | nom      | —   |
| website, phone | contact (39.2 M, 53.2 M have one)                                                                              | none | nom      | —   |

Stored aggregates: place counts per H3 cell, resolutions 0–7, by category
and by confidence (≥ 0.5, ≥ 0.8) (count, E). Category totals: food
8.66 M, shopping 11.10 M, health 4.42 M, education 3.04 M, transport
3.44 M, lodging 2.44 M, public 2.30 M, religion 1.80 M, recreation
4.90 M, charging 56,410, other 22.57 M. Not stored: address, country,
region, the full Overture taxonomy path (read in the build, then dropped).

### 2.6 Overture infrastructure (street assets)

| Field    | Meaning                                                                 | Unit | Level    | Sum |
| -------- | ----------------------------------------------------------------------- | ---- | -------- | --- |
| x, y     | position (a line's or area's box centre)                                | none | interval | —   |
| category | 4 classes: street lamp, fire hydrant, traffic signals, charging station | none | nom      | —   |
| name     | name (270,548 have one)                                                 | none | nom      | —   |
| source   | OpenStreetMap                                                           | none | nom      | —   |

Stored aggregates: counts per H3 cell, resolutions 0–7, by class (E). The
layer's bike lanes are road segments with the bike flag (2.8).

### 2.7 Overture buildings

| Field   | Meaning                                                      | Unit | Level | Sum |
| ------- | ------------------------------------------------------------ | ---- | ----- | --- |
| height  | whole metres 1–255, 0 unknown (29,811,549 from floors × 3 m) | m    | ratio | I   |
| polygon | footprint, 2²⁸ grid                                          | none | —     | —   |

Stored aggregates per density cell (D14 about 2.4 km, D18 153 m, D19
76 m): building count (E), footprint area m² (E), Σ height × area =
volume m³ (E), area with a known height m² (E). Derivable per building:
footprint area (m², E), volume (m³, E). Read but kept only as manifest
tallies: class (none 469.9 M, residential 87.7 M, outbuilding 7.9 M,
agricultural 4.2 M, commercial 3.0 M, industrial 2.9 M, then civic,
service, education, religious, transportation, entertainment, medical,
military) and source (OpenStreetMap 338.0 M, Microsoft 217.1 M, IGN
España 12.0 M, Esri 11.7 M, Google 0.62 M).

### 2.8 Overture roads

| Field    | Meaning                                                                                   | Unit              | Level                           | Sum |
| -------- | ----------------------------------------------------------------------------------------- | ----------------- | ------------------------------- | --- |
| class    | 17 classes, motorway … bridleway                                                          | none              | nom (roughly ord by importance) | —   |
| subclass | link, sidewalk, crosswalk, parking aisle, driveway, alley, cycle crossing, none           | none              | nom                             | —   |
| flags    | bridge, tunnel, link, under construction, bike designated, bike allowed, bike denied, mph | none              | nom (8 booleans)                | —   |
| surface  | 7 codes + none                                                                            | none              | nom                             | —   |
| speed    | highest maximum speed                                                                     | km/h or mph → m/s | ratio                           | I   |
| source   | OpenStreetMap 165.7 M, TomTom 4.76 M                                                      | none              | nom                             | —   |
| name     | primary name (55.8 M named)                                                               | none              | nom                             | —   |

Derivable: length in m (E). Not stored: segment id, so the finest level's
pieces cannot be regrouped into segments.

### 2.9 Property records

| Field                   | Meaning                                                                                 | Unit             | Level                  | Sum        |
| ----------------------- | --------------------------------------------------------------------------------------- | ---------------- | ---------------------- | ---------- |
| street, unit, city, zip | address                                                                                 | none             | nom                    | —          |
| state                   | state code                                                                              | none             | nom                    | —          |
| county                  | 5-digit county FIPS                                                                     | none             | nom                    | —          |
| apn                     | parcel number                                                                           | none             | nom                    | —          |
| type                    | single family, condo, townhouse, apartment, multi family, manufactured, land, other (8) | none             | nom                    | —          |
| beds                    | bedrooms                                                                                | count            | ratio                  | E          |
| baths2                  | bathrooms × 2                                                                           | count            | ratio                  | E          |
| sqft                    | floor area                                                                              | ft² → m²         | ratio                  | E          |
| lot                     | lot area                                                                                | ft² → m²         | ratio                  | E          |
| year                    | year built                                                                              | year             | interval               | —          |
| soldPrice, soldDay      | last sale price and date                                                                | USD; day         | ratio; interval        | E per sale |
| tax[]                   | up to 12 years: year, amount, assessment                                                | year; USD/a; USD | interval; ratio; ratio | E          |
| sales[]                 | up to 10 sales: day, price                                                              | day; USD         | interval; ratio        | E per sale |

Stored aggregates per H3 cell, resolutions 0–7 (859,967 cells at res 7):
properties (count, E), sales since 2015 (count, E), median price (USD,
I), median price per ft² (USD/ft² → USD/m², I), median year built
(interval). Derivable: price per m² (I); value summed per county or ZIP
(E).

### 2.10 Census tracts

| Field  | Meaning                                                                         | Unit       | Level    | Sum |
| ------ | ------------------------------------------------------------------------------- | ---------- | -------- | --- |
| GEOID  | state (2) + county (3) + tract (6)                                              | none       | nom      | —   |
| income | ACS 2020–2024 median household income (B19013_001E); 83,828 known               | USD (2024) | ratio    | I   |
| lst    | mean June–August 2018–2023 land surface temperature, water masked; 85,150 known | °C         | interval | I   |
| rings  | polygons                                                                        | ° × 10⁶    | —        | —   |

Derivable: tract area (m², E). Not stored: population, households, land
area, margins of error, county and state names.

### 2.11 Blocks tilesets

| Field                           | Meaning                                                                                                      | Unit        | Level           | Sum |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------- | --------------- | --- |
| level, kind                     | block size of the level; group or fill tile                                                                  | m; none     | ratio; nom      | —   |
| ci, cj, blockM                  | chunk index and block size (property table)                                                                  | none; m     | interval; ratio | —   |
| vertices, indices, faces, bytes | per-tile mesh statistics (build state)                                                                       | count; byte | ratio           | E   |
| material                        | air, terrain, water, building, grass, forest, road (7), baked into vertex colour; water a separate primitive | none        | nom             | —   |

Faces at the finest level: lower48-120 536.5 M, europe-120 389.6 M,
baltimore-metro-30 6.2 M. Not stored: block counts (greedy meshing merges
faces), heights as values.

### 2.12 HydroSHEDS v2 network

| Field    | Meaning                                                                     | Unit | Level          | Sum |
| -------- | --------------------------------------------------------------------------- | ---- | -------------- | --- |
| order    | 1–8 from upstream area, `ceil(8 − log10(UPLAND_SKM))`; 1 the largest basins | none | ord (inverted) | —   |
| geometry | zigzag-delta Mercator line                                                  | none | —              | —   |

Stored aggregates: reaches and km per order (manifest `byOrder`; order 8
alone 13,615,744 reaches, 22,165,593 km). Read from the source and
dropped: UPLAND_SKM (km²), ORD_STRAH, LENGTH_KM, STRM_ID, STRM_DN; never
read: MAIN_BAS, NODE_ID, UP_CELLS. Derivable: length (m, E).

### 2.13 River names

| Field                             | Meaning                         | Unit | Level | Sum |
| --------------------------------- | ------------------------------- | ---- | ----- | --- |
| name, name:en, wikidata, waterway | name group (OSM)                | none | nom   | —   |
| source                            | osm, direct or inherited match  | none | nom   | —   |
| strahler                          | Strahler order 1–15 of the line | none | ord   | —   |

Stored aggregates: named share by order (manifest `rates.byOrder`; 12.6 %
of v2 reaches named).

### 2.14 HydroRIVERS v1 and Free-Flowing Rivers (reach click, `ee-rivers`)

| Field                    | Meaning                                                                  | Unit     | Level          | Sum                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------ | -------- | -------------- | --------------------------------------------------------------------------------------------------- |
| NOID, REACH_ID           | reach id                                                                 | none     | nom            | —                                                                                                   |
| NDOID                    | next-down reach (0 terminal)                                             | none     | nom (link)     | —                                                                                                   |
| RIV_ORD                  | discharge decade 1 (≥ 100,000 m³/s) to 10                                | none     | ord (inverted) | —                                                                                                   |
| DIS_AV_CMS               | long-term mean discharge at the outlet                                   | m³/s     | ratio          | accumulated downstream: additive only across disjoint outlets (terminal reaches per ocean or basin) |
| LENGTH_KM                | reach length                                                             | km → m   | ratio          | E                                                                                                   |
| UPLAND_SKM               | upstream area                                                            | km² → m² | ratio          | accumulated: additive only across disjoint outlets                                                  |
| CSI                      | connectivity status index 0–100                                          | %        | ratio          | I                                                                                                   |
| CSI_FF, CSI_FF2          | free-flowing flag; class 1 free-flowing, 2 good connectivity, 3 impacted | none     | nom; ord       | —                                                                                                   |
| CSI_D                    | dominant pressure: DOF, DOR, SED, USE, RDD, URB, NAN                     | none     | nom            | —                                                                                                   |
| BB_ID, BB_NAME, BB_OCEAN | backbone river, its name, its ocean                                      | none     | nom            | —                                                                                                   |
| BB_LEN_KM                | backbone length                                                          | km → m   | ratio          | E per backbone                                                                                      |
| BAS_ID, BAS_NAME         | basin                                                                    | none     | nom            | —                                                                                                   |
| COUNTRY, CONTINENT       | place                                                                    | none     | nom            | —                                                                                                   |

Cached path answers add, downstream: terminal, reach count, lengthKm,
mouth; upstream: reach count, lengthKm, maxOrder. The meanings of CSI and
BB_* are from the Free-Flowing Rivers publication, not this code.

### 2.15 Dams and data centres (bundled OSM extracts)

| Dataset      | Field                                                           | Meaning                                             | Unit  | Level | Sum                   |
| ------------ | --------------------------------------------------------------- | --------------------------------------------------- | ----- | ----- | --------------------- |
| dams         | name, operator (221), osm_id                                    | identity                                            | none  | nom   | —                     |
| dams         | source_layer                                                    | power plant 594, reservoir 53, generator 39…        | none  | nom   | —                     |
| dams         | plant:source                                                    | hydro 625, tidal 1, waste 1                         | none  | nom   | —                     |
| dams         | plant:method, type                                              | water storage, run of the river; reservoir, turbine | none  | nom   | —                     |
| dams         | output                                                          | electrical output (309 parse, 144.8 GW in all)      | W     | ratio | E                     |
| dams         | height                                                          | dam height (30 parse)                               | m     | ratio | I                     |
| dams         | ref:US:NID                                                      | US national dam inventory id (54)                   | none  | nom   | —                     |
| data centres | name (3,405), operator (2,619; 1,352 linked to Wikidata), owner | identity                                            | none  | nom   | —                     |
| data centres | building:levels (374)                                           | floors                                              | count | ratio | I                     |
| data centres | height (154)                                                    | m                                                   | ratio | I     |
| data centres | capacity (3)                                                    | IT load                                             | W     | ratio | E (too sparse to use) |

Derivable: footprint area (m², E) for 3,517 data-centre polygons and the
692 dam polygons. Neither carries a country, state or city.

### 2.16 Elevation and terrain (Earth Engine)

| Layer / plane              | Meaning                                                                                        | Unit     | Level               | Sum                             |
| -------------------------- | ---------------------------------------------------------------------------------------------- | -------- | ------------------- | ------------------------------- |
| `ee-elevation` value       | height above sea level, mean of the cell above 1.5 × native; fills masked outside −500…9,000 m | m        | interval            | I                               |
| `ee-elevation` water plane | share of the cell that is water (MOD44W)                                                       | fraction | ratio               | I; × cell area = water area (E) |
| `ee-terrain-slope`         | slope 0–90                                                                                     | °        | ratio               | I                               |
| `ee-terrain-aspect`        | bearing 0–360 (sampled, never averaged)                                                        | °        | interval (circular) | I                               |
| `ee-terrain-hillshade`     | shading 0–255                                                                                  | none     | —                   | picture only                    |
| `ee-elevation-contours`    | 0/1 line mask, 20–500 m spacing by zoom                                                        | none     | —                   | picture only                    |

DEM stack: GMTED2010 231 m (`USGS/GMTED2010_FULL`), FABDEM 30 m, 3DEP
10 m and 1 m (US), ArcticDEM 2 m (north of 60° N), REMA 8 m (south of
60° S).

### 2.17 Water, land and people (Earth Engine)

| Layer / mode                                      | Meaning                                        | Unit     | Level                       | Sum                                                                |
| ------------------------------------------------- | ---------------------------------------------- | -------- | --------------------------- | ------------------------------------------------------------------ |
| `ee-surface-water` occurrence                     | share of time with water, 1–100                | %        | ratio                       | I                                                                  |
| `ee-surface-water` change                         | change in occurrence, −100…100                 | %        | interval                    | I                                                                  |
| `ee-surface-water` seasonality                    | months a year with water, 1–12                 | month    | ratio                       | I                                                                  |
| `ee-inundation` count                             | flood events, less permanent water             | count    | ratio                       | E over time, I over area                                           |
| `ee-inundation` duration                          | flooded days, less permanent water             | d → s    | ratio                       | E over time, I over area                                           |
| `ee-land-cover` (WorldCover v200, v100)           | class index 0–10 (below)                       | none     | nom                         | — ; class × cell area = class area (E, exact at native resolution) |
| `ee-forest-types`                                 | 1 naturally regenerating, 2 primary, 3 planted | none     | nom                         | — ; × cell area (E)                                                |
| `ee-forest-loss`                                  | loss year 1–25 = 2001–2025                     | year     | interval (nominal per cell) | — ; cell area per year = area lost (E, native resolution only)     |
| `ee-tree-canopy` meta, eth                        | canopy height, 0 masked                        | m        | ratio                       | I                                                                  |
| `ee-buildings` count                              | buildings                                      | km⁻²     | ratio                       | I; × km² = buildings (E)                                           |
| `ee-buildings` cover                              | share of ground built                          | fraction | ratio                       | I; × area = built area (E)                                         |
| `ee-buildings` height                             | mean building height, presence ≥ 0.05          | m        | ratio                       | I                                                                  |
| `ee-population` density-2020, -2000, -1990, -1975 | people per km² (GHSL 100 m count × 100)        | km⁻²     | ratio                       | I; × km² = people (E)                                              |
| `ee-admin-boundaries` level0, 1, 2                | outlines; no attribute read                    | —        | —                           | —                                                                  |
| `ee-census-tracts` tracts                         | outlines; no attribute read                    | —        | —                           | —                                                                  |

WorldCover classes (code → index): 10 tree cover 0, 20 shrubland 1,
30 grassland 2, 40 cropland 3, 50 built-up 4, 60 bare or sparse
vegetation 5, 70 snow and ice 6, 80 permanent water 7, 90 herbaceous
wetland 8, 95 mangroves 9, 100 moss and lichen 10. Flat: no class
hierarchy is stored. Earth Engine reads the pyramid level nearest the
cell: MEAN for continuous layers, MODE for classes, so a coarse cell of a
class layer is one class, not shares.

### 2.18 Self-hosted values (the same `/api/raster/values` service)

| Layer / mode                            | Meaning                                                    | Unit               | Level                  | Sum                       |
| --------------------------------------- | ---------------------------------------------------------- | ------------------ | ---------------------- | ------------------------- |
| Overture buildings count, cover, height | as `ee-buildings`, from the density cells                  | km⁻²; fraction; m  | ratio                  | I (the cells' sums are E) |
| `wikipedia-coverage` articles           | articles per km²                                           | km⁻²               | ratio                  | I                         |
| `wikipedia-coverage` text               | wikitext bytes per km²                                     | byte/km²           | ratio                  | I                         |
| `wikipedia-coverage` count              | articles                                                   | count              | ratio                  | E                         |
| `property-sales` price, ppsf, year      | median sale price; median price per ft²; median year built | USD; USD/ft²; year | ratio; ratio; interval | I                         |
| `property-sales` sales, properties      | sales since 2015; properties                               | count              | ratio                  | E                         |
| census income, lst                      | as 2.10                                                    | USD; °C            | ratio; interval        | I                         |

### 2.19 Wikipedia coverage

| Store                   | Field                                             | Meaning                                                   | Unit        | Level | Sum           |
| ----------------------- | ------------------------------------------------- | --------------------------------------------------------- | ----------- | ----- | ------------- |
| grid (0.05°, 5 levels)  | counts                                            | primary geotagged enwiki articles                         | count       | ratio | E             |
| grid                    | bytes                                             | summed wikitext size                                      | byte        | ratio | E             |
| H3 (res 0–7)            | articles, bytes                                   | as the grid                                               | count; byte | ratio | E             |
| H3                      | area                                              | cell area                                                 | km² → m²    | ratio | E             |
| population grid, capita | people per 0.05° cell and per H3 cell (GHSL 2020) | count                                                     | ratio       | E     |
| points                  | pageId, qid, title, GeoData type                  | identity                                                  | none        | nom   | —             |
| points                  | wiki                                              | language (11: en, de, fr, es, ru, ja, zh, it, pt, pl, nl) | none        | nom   | —             |
| points                  | wikis                                             | languages with an article (bitmask)                       | count       | ratio | I per article |
| points                  | bytes                                             | article size                                              | byte        | ratio | E             |
| points                  | dim                                               | GeoData object size                                       | m           | ratio | I             |
| points                  | cls                                               | landmark, place, nature, other                            | none        | nom   | —             |

Served, not stored: articles per km² and per 100,000 people, bytes per
km² and per person (I).

### 2.20 World history (Cliopatria)

| Field               | Meaning                           | Unit     | Level      | Sum                                                                                  |
| ------------------- | --------------------------------- | -------- | ---------- | ------------------------------------------------------------------------------------ |
| name                | polity                            | none     | nom        | —                                                                                    |
| type                | polity or relation                | none     | nom        | —                                                                                    |
| from, to            | first and last year of the period | year     | interval   | — ; to − from = duration (a, E)                                                      |
| area                | Cliopatria area                   | km² → m² | ratio      | E within one year among polities (records overlap across periods and with relations) |
| memberOf            | parent polity (2,678 records)     | none     | nom (link) | —                                                                                    |
| wikipedia, wikidata | links (wikidata on 13,792)        | none     | nom        | —                                                                                    |
| label, box          | label point, bounding box         | °        | interval   | —                                                                                    |

Stored structures: records per polity (with its largest record and span),
50-year buckets from −3400, and Cottereau spans with confidence (high
867, medium 582, low 725; ord).

### 2.21 Cameras

| Layer                 | Field                                                          | Meaning                                                                                | Unit        | Level           | Sum  |
| --------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------- | --------------- | ---- |
| `cctv`                | pack                                                           | source pack (22: agency packs, camindex, linked, featured, NPS, USGS, Windy)           | none        | nom             | —    |
| `cctv`                | provider                                                       | operator or publisher (35 in the served catalog)                                       | none        | nom             | —    |
| `cctv`                | cityId                                                         | pack-specific group (Caltrans district, TxDOT district, DelDOT county, Windy country…) | none        | nom             | —    |
| `cctv`                | city                                                           | free-text place                                                                        | none        | nom             | —    |
| `cctv`                | category                                                       | traffic, ski, meteo, airport, volcano…                                                 | none        | nom             | —    |
| `cctv`                | feedType, sourceKind                                           | image, hls, mjpeg, youtube, link; source kind                                          | none        | nom             | —    |
| `cctv`                | coordinatesQuality                                             | site, area, region, operator geotag, vessel                                            | none        | ord             | —    |
| `cctv`                | headingConfidence                                              | low, high                                                                              | none        | ord             | —    |
| `cctv`                | headingDeg, pitchDeg                                           | view bearing, tilt                                                                     | °           | interval        | —    |
| `cctv`                | fovDeg, rangeM, mountHeightM                                   | field of view, view depth, mount height                                                | °, m, m     | ratio           | I    |
| `cctv`                | groundElevationM                                               | ground height                                                                          | m           | interval        | —    |
| `cctv`                | audio, liveStatus, license, timeZone, model, manufacturer (55) | properties                                                                             | none        | nom             | —    |
| `cctv`                | vessel {courseDeg, speedKn}                                    | moving cameras                                                                         | °; kn → m/s | interval; ratio | I    |
| `alpr-cameras`        | operator, manufacturer, cameraType, zone                       | OSM tags                                                                               | none        | nom             | —    |
| `alpr-cameras`        | directionDeg                                                   | facing                                                                                 | °           | interval        | —    |
| `alpr-cameras`        | lastVerified, osmTimestamp                                     | dates                                                                                  | time        | interval        | —    |
| Baltimore enforcement | kind                                                           | red light, fixed speed, portable speed, truck height                                   | none        | nom             | —    |
| Baltimore CitiWatch   | title, details                                                 | location text                                                                          | none        | nom             | —    |
| `recorded-video`      | source                                                         | wikidata, youtube geotag, landmark                                                     | none        | nom             | —    |
| `recorded-video`      | kind                                                           | news, tour, event, vlog, music, other                                                  | none        | nom             | —    |
| `recorded-video`      | durationS                                                      | length                                                                                 | s           | ratio           | E    |
| `recorded-video`      | views                                                          | view count (server only)                                                               | count       | ratio           | E    |
| `recorded-video`      | publishedAt, recordedAt                                        | dates                                                                                  | time        | interval        | —    |
| `recorded-video`      | coordinatesQuality                                             | site, area, region, about                                                              | none        | ord             | —    |
| `recorded-video`      | channelTitle, landmarkQid, wikidataId                          | links                                                                                  | none        | nom             | —    |
| `recorded-video`      | youtubeRank                                                    | rank in search results                                                                 | none        | ord             | —    |
| landmarks             | kind, sitelinks                                                | landmark type; Wikidata sitelinks                                                      | none; count | nom; ratio      | —; I |
| street level          | provider, sequence, creator                                    | provider; sequence (link); contributor                                                 | none        | nom             | —    |
| street level          | capturedAt                                                     | capture time                                                                           | time        | interval        | —    |
| street level          | isPano, onFoot                                                 | flags                                                                                  | none        | nom             | —    |
| street level          | quality (Mapillary)                                            | quality score                                                                          | none        | ratio           | I    |
| street level          | nb_pictures, nb_360_pictures (Panoramax grid)                  | pictures per cell                                                                      | count       | ratio           | E    |

Derivable: camera counts at any level (E); sequence length (m, E).
Dropped upstream fields that would be useful parents: Baltimore's
quadrant and police district, CitiWatch's edit history.

### 2.22 Military areas and submarine cables

| Layer                            | Field                                         | Meaning                                                                                                                     | Unit | Level | Sum |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---- | ----- | --- |
| `military-installations`         | class                                         | military land 26,659, base 2,741, range 1,950, barracks 1,739, airfield 1,703, training area 1,417, naval base 257 (bundle) | none | nom   | —   |
| `military-installations`         | name                                          | name or class label                                                                                                         | none | nom   | —   |
| `military-installations`         | areaM2                                        | area on the ellipsoid (bundle only; about 481,602 km² in all)                                                               | m²   | ratio | E   |
| `military-installations`         | bbox, footprint                               | extent, polygon                                                                                                             | °    | —     | —   |
| `telegeography-submarine-cables` | id, name, feature_id                          | cable and its part                                                                                                          | none | nom   | —   |
| landing points                   | name ("Town, Country"; 186 countries), is_tbd | landing                                                                                                                     | none | nom   | —   |

Derivable: cable length (m, E; about 1,915,812 km over all features),
footprint areas of live military records (m², E). Not stored: cable
capacity, owners, ready date, cable-to-landing links; military branch,
operator, country.

### 2.23 Aircraft (`flights`, `military`, `local-adsb`)

| Field                                         | Meaning                                                                                      | Unit              | Level               | Sum |
| --------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------- | ------------------- | --- |
| icao24 / hex                                  | aircraft address                                                                             | none              | nom                 | —   |
| callsign, registration, squawk                | identity                                                                                     | none              | nom                 | —   |
| originCountry (flights)                       | state that allocated the address, not where the aircraft is                                  | none              | nom                 | —   |
| klass                                         | light, airliner, widebody, quadjet, bizjet, turboprop, fastjet, helicopter, glider, uav (10) | none              | nom                 | —   |
| category                                      | emitter category (OpenSky 0–20; ADS-B A0–D7)                                                 | none              | nom                 | —   |
| typeCode, typeName (adsbdb; type on military) | ICAO type; manufacturer and type                                                             | none              | nom                 | —   |
| airline, route {origin, destination} (adsbdb) | operator; airports                                                                           | none              | nom                 | —   |
| operator (military)                           | readsb ownOp; empty on all 116                                                               | none              | nom                 | —   |
| emergency {kind, severity}                    | squawk emergency                                                                             | none              | nom; ord            | —   |
| altitude, geoAltitudeM                        | barometric, ellipsoid height                                                                 | ft or m → m       | interval            | —   |
| velocity / speedMps / groundSpeedKt           | ground speed                                                                                 | m/s, kn → m/s     | ratio               | I   |
| track, true_track                             | course                                                                                       | °                 | interval (circular) | —   |
| verticalRate                                  | climb rate                                                                                   | m/s, ft/min → m/s | interval            | —   |
| turnRateDps                                   | turn rate                                                                                    | °/s → rad/s       | interval            | —   |
| onGround                                      | flag                                                                                         | none              | nom                 | —   |
| messageCount (local)                          | messages received                                                                            | count             | ratio               | E   |
| rssiDbfs (local)                              | signal level                                                                                 | dBFS              | interval            | —   |
| band (local)                                  | 1090 or 978 MHz                                                                              | none              | nom                 | —   |
| lastContact, positionTime                     | times                                                                                        | time              | interval            | —   |

Derivable: aircraft count (E), track length (m, E) and duration (s, E)
from trails, route distance (m).

### 2.24 Vessels (`ais-live-vessels`)

| Field                   | Meaning                           | Unit     | Level               | Sum |
| ----------------------- | --------------------------------- | -------- | ------------------- | --- |
| mmsi, imo (9,025), name | identity                          | none     | nom                 | —   |
| type                    | AIS ship type 0–99 (26,689 known) | none     | nom                 | —   |
| destination             | free text (14,647)                | none     | nom                 | —   |
| speed                   | speed over ground                 | kn → m/s | ratio               | I   |
| course, heading         | course over ground; heading       | °        | interval (circular) | —   |
| last_position_epoch     | time                              | s        | interval            | —   |
| track samples           | up to 64 {lat, lon, t}            | —        | —                   | —   |

Measured split by AIS type family (tens digit): 3x (fishing, towing,
dredging, military, sailing, pleasure) 8,004; 0x (not available) 4,859;
7x cargo 4,425; none 3,143; 5x (pilot, SAR, tug, law enforcement…) 2,734;
6x passenger 2,339; 8x tanker 2,023; 9x other 1,777; 4x high speed 316;
2x 175; 1x 27. Derivable: vessel count (E), track length (m, E), flag
state from the MMSI's first three digits (a lookup the code does not
make).

### 2.25 Space (`satellites`, `rocket-launches`)

| Layer      | Field                                                                                              | Meaning                                                    | Unit                                     | Level                                   | Sum |
| ---------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------- | --------------------------------------- | --- |
| satellites | noradId, name                                                                                      | identity                                                   | none                                     | nom                                     | —   |
| satellites | group                                                                                              | stations, visual, gps-ops, glo-ops, galileo, geo, starlink | none                                     | nom                                     | —   |
| satellites | satelliteClass                                                                                     | station, nav, geo, visual, comms                           | none                                     | nom                                     | —   |
| satellites | TLE: epoch; inclination, RAAN, argument of perigee, mean anomaly; eccentricity; mean motion; BSTAR | elements                                                   | time; °; none; rev/d → Hz; 1/earth radii | interval; interval; ratio; ratio; ratio | I   |
| satellites | propagated altitude, speed                                                                         | position                                                   | m; m/s                                   | interval; ratio                         | I   |
| launches   | name, status, provider, mission, launchSite, orbit                                                 | identity, outcome, operator                                | none                                     | nom                                     | —   |
| launches   | launchTime                                                                                         | time                                                       | time                                     | interval                                | —   |
| launches   | payloads[]: type, manufacturer, operator, destination                                              | payload                                                    | none                                     | nom                                     | —   |
| launches   | payloads[]: amount, massKg                                                                         | number, mass                                               | count; kg                                | ratio                                   | E   |
| launches   | recoveryStages[]: category, serial, status, recoveryType                                           | stage                                                      | none                                     | nom                                     | —   |
| launches   | recoveryStages[]: flightNumber                                                                     | reuse count                                                | none                                     | ord                                     | —   |
| launches   | recoveryStages[]: downrangeKm                                                                      | distance                                                   | km → m                                   | ratio                                   | I   |
| launches   | timeline[]: offsetSeconds                                                                          | event offset                                               | s                                        | interval                                | —   |

Derivable: orbital period (s), regime LEO/MEO/GEO from mean motion (ord),
apogee and perigee (m). Not stored: satellite operator and country (would
need SATCAT), the rocket configuration and pad country (present in the
raw Launch Library cache, dropped by the normalizer).

### 2.26 Hazards (`earthquakes`, `local-firms`, `fire-perimeters`, `weather-cyclones`)

| Layer           | Field                           | Meaning                                 | Unit        | Level           | Sum                             |
| --------------- | ------------------------------- | --------------------------------------- | ----------- | --------------- | ------------------------------- |
| earthquakes     | mag                             | magnitude (logarithmic)                 | none        | interval        | — ; 10^(1.5 M) energy is E      |
| earthquakes     | depthKm                         | depth                                   | km → m      | ratio           | I                               |
| earthquakes     | time                            | time                                    | ms          | interval        | —                               |
| earthquakes     | place                           | "10 km NE of X"                         | none        | nom             | —                               |
| FIRMS           | frp                             | fire radiative power                    | MW → W      | ratio           | E (1,617,588 MW over the cache) |
| FIRMS           | confidence                      | VIIRS low, nominal, high; MODIS 0–100 % | none        | ord             | —                               |
| FIRMS           | brightness, brightnessTi5       | brightness temperature                  | K           | interval        | —                               |
| FIRMS           | daynight, satellite, instrument | flags, platform                         | none        | nom             | —                               |
| FIRMS           | acqMs                           | acquisition time                        | ms          | interval        | —                               |
| fire perimeters | category                        | wildfire or prescribed                  | none        | nom             | —                               |
| fire perimeters | acres                           | burned area                             | acre → m²   | ratio           | E (784,188 acres over 64)       |
| fire perimeters | containedPct                    | containment                             | %           | ratio           | I                               |
| fire perimeters | personnel                       | people assigned                         | count       | ratio           | E                               |
| fire perimeters | costToDate                      | cost                                    | USD         | ratio           | E                               |
| fire perimeters | complexity                      | incident type 5 → 1                     | none        | ord             | —                               |
| fire perimeters | cause, behavior, complexName    | text                                    | none        | nom             | —                               |
| fire perimeters | state, county                   | ISO 3166-2; county name                 | none        | nom             | —                               |
| fire perimeters | discoveredTime, updatedTime     | time                                    | ms          | interval        | —                               |
| cyclones        | classification                  | TD, TS, HU…                             | none        | ord             | —                               |
| cyclones        | basin                           | AL, EP, CP                              | none        | nom             | —                               |
| cyclones        | windKt, gustKt                  | sustained wind, gusts                   | kn → m/s    | ratio           | I                               |
| cyclones        | pressureHpa                     | central pressure                        | hPa → Pa    | ratio           | I                               |
| cyclones        | movement                        | direction, speed                        | °; kn → m/s | interval; ratio | I                               |
| cyclones        | advisoryNumber                  | advisory                                | none        | ord             | —                               |
| cyclones        | forecastPoints[].tauHours       | lead time                               | h → s       | interval        | —                               |

Derivable: event count (E), perimeter polygon area (m², E), Saffir-Simpson
category from wind (ord).

### 2.27 Weather fields (`wind`, `air-quality`, `gnss-integrity`, the weather pictures)

| Layer                       | Field              | Meaning                                                             | Unit         | Level             | Sum |
| --------------------------- | ------------------ | ------------------------------------------------------------------- | ------------ | ----------------- | --- |
| wind                        | u, v               | 10 m wind components                                                | m/s          | interval (signed) | —   |
| wind                        | scalar             | 2 m temperature or sea-level pressure                               | °C; hPa → Pa | interval; ratio   | I   |
| wind                        | model              | gfs or ifs                                                          | none         | nom               | —   |
| air quality                 | value              | AQHI index 1–10+                                                    | none         | interval          | —   |
| air quality                 | band               | low, moderate, high, very high                                      | none         | ord               | —   |
| air quality                 | zone               | ECCC zone (5)                                                       | none         | nom               | —   |
| GNSS                        | nic, nacp          | integrity and accuracy categories 0–11                              | none         | ord               | —   |
| GNSS cell                   | aircraft, degraded | aircraft seen; degraded                                             | count        | ratio             | E   |
| GNSS cell                   | percentDegraded    | share degraded                                                      | %            | ratio             | I   |
| GNSS cell                   | level              | low, medium, high                                                   | none         | ord               | —   |
| radar, satellite, lightning | pixel colour       | reflectivity dBZ, IR brightness K, strike density — as colours only | —            | —                 | —   |

Derivable: wind speed (m/s, I) and direction (°).

### 2.28 Ground transport (`traffic`, `transit`, `bikeshare`)

| Layer     | Field                                       | Meaning                                | Unit     | Level               | Sum |
| --------- | ------------------------------------------- | -------------------------------------- | -------- | ------------------- | --- |
| traffic   | trafficLevel                                | current ÷ free-flow speed              | fraction | ratio               | I   |
| traffic   | roadType, roadCategory, roadSubcategory     | road                                   | none     | nom                 | —   |
| traffic   | closure, leftHandTraffic                    | flags                                  | none     | nom                 | —   |
| transit   | feed                                        | 16 feeds (agency, region text)         | none     | nom                 | —   |
| transit   | routeId, tripId, directionId, stopId, label | links                                  | none     | nom                 | —   |
| transit   | status                                      | incoming, stopped, in transit          | none     | nom                 | —   |
| transit   | occupancy                                   | empty … full                           | none     | ord                 | —   |
| transit   | bearing                                     | heading of the vehicle                 | °        | interval (circular) | —   |
| transit   | speedMps                                    | speed                                  | m/s      | ratio               | I   |
| transit   | timestamp                                   | time                                   | s        | interval            | —   |
| bikeshare | system                                      | 52 systems (city text)                 | none     | nom                 | —   |
| bikeshare | capacity                                    | docks (31 systems publish it; 224,062) | count    | ratio               | E   |
| bikeshare | bikesAvailable, docksAvailable              | live availability                      | count    | ratio               | E   |
| bikeshare | isInstalled, isRenting, isReturning         | flags                                  | none     | nom                 | —   |

Derivable: segment length (m, E), vehicle and station counts (E). Transit
mode (bus, tram, subway, rail, ferry) is inferred from route ids; route
names would need the GTFS static files.

### 2.29 Other feeds (`radio`, `recent-imagery`, `directions`)

| Layer          | Field                          | Meaning               | Unit           | Level    | Sum |
| -------------- | ------------------------------ | --------------------- | -------------- | -------- | --- |
| radio          | countryCode, country, state    | place                 | none           | nom      | —   |
| radio          | tags, languages, codec         | properties            | none           | nom      | —   |
| radio          | bitrate                        | stream bitrate        | kbit/s → bit/s | ratio    | I   |
| radio          | clickCount                     | listens (server only) | count          | ratio    | E   |
| recent imagery | product                        | S30, L30, VIIRS       | none           | nom      | —   |
| recent imagery | timeStart, timeEnd             | time                  | time           | interval | —   |
| recent imagery | cloud                          | cloud cover           | %              | ratio    | I   |
| directions     | distanceM, durationS           | route and step totals | m; s           | ratio    | E   |
| directions     | step type, modifier, name, ref | manoeuvre             | none           | nom      | —   |
| directions     | profile                        | car, bike, foot       | none           | nom      | —   |

## 3. Hierarchies

Containment where each child has one parent. **Stored** means the parent
is a field or a code prefix on the child; **in code** means a fixed
table in the source maps child to parent; **lookup** means a table the
fork does not hold; **join** means a spatial join.

### 3.1 Places

| Hierarchy                | Levels                                                                                                                                                                           | How the parent is known                                                                                                                                                                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overture administrative  | country > dependency > region > county > localadmin > locality > macrohood > neighborhood > microhood                                                                            | Stored only as ISO codes: areas and localities carry country (alpha-2) and region (ISO 3166-2), so county → region → country is a key join. A locality's county or a neighbourhood's locality: the raw parquet's `parent_division_id` (4,688,229 rows, read in 28 s in the build) or a join. |
| Continent > country      | continent > country                                                                                                                                                              | Not stored anywhere but on clicked river reaches (`CONTINENT`). A lookup of about 250 ISO codes.                                                                                                                                                                                             |
| Natural Earth            | country > state or province; country > populated place                                                                                                                           | Stored: `iso2`/`country` on states, a country index on populated places.                                                                                                                                                                                                                     |
| US census                | state (2) > county (5) > tract (11)                                                                                                                                              | Stored: GEOID prefixes on tracts, FIPS on property records and the counties pack.                                                                                                                                                                                                            |
| US property              | state > county FIPS > ZIP or city > building pin > record                                                                                                                        | Stored on each record; pins hold their records.                                                                                                                                                                                                                                              |
| GAUL 2025 (Earth Engine) | ADM0 > ADM1 > ADM2                                                                                                                                                               | The public tables carry parent codes per row (not read by this code; check the field names before use). LSIB countries link to GAUL only by a join or an ISO crosswalk.                                                                                                                      |
| Grids                    | H3 res 0 > … > 7; Wikipedia grid 0.8° > … > 0.05°; Blocks levels 30,720 > 7,680 > 1,920 > 480 > 120 > 30 m; buildings density D14 > D18 > D19; MGRS zone > 100 km > 10 km > 1 km | Exact by arithmetic (`cellToParent`, index halving, ×4 levels); the MGRS lines are computed, not data.                                                                                                                                                                                       |

### 3.2 Water

| Hierarchy                | Levels                                                                                                               | How the parent is known                                                                                                                 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| HydroRIVERS v1 / FFR     | continent > basin (`BAS_ID`) > backbone (`BB_ID`) > reach; next-down graph (`NDOID`); discharge order `RIV_ORD` 1–10 | Stored on every reach, but the fork holds only clicked reaches (52 cached); the 8,477,883-reach table is in Earth Engine.               |
| HydroSHEDS v2 (Americas) | order 1–8 > reach                                                                                                    | Only the order is stored. Basin (`MAIN_BAS`) and next-down (`STRM_DN`) are in the raw files only: about 4–5 minutes to read them again. |
| River names              | name group > named line; Strahler 1–15                                                                               | Stored.                                                                                                                                 |
| Surface-water classes    | none                                                                                                                 | —                                                                                                                                       |

### 3.3 Time

| Hierarchy            | Levels                                                                               | How the parent is known                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Calendar             | year > month > day > hour                                                            | Derivable from every time field: flights, vessels, quakes, FIRMS, perimeters, cyclones, transit, imagery, video dates, Mapillary captures, sale dates, tax years, launch times. |
| Built and loss years | year built; forest-loss year 2001–2025; GHSL epochs 1975–2020; WorldCover 2020, 2021 | Stored as years.                                                                                                                                                                |
| History              | 50-year bucket > polity > period record; `memberOf` parent polity                    | Buckets and polity groups stored; `memberOf` stored by name (2,678 records).                                                                                                    |

### 3.4 Taxonomies

| Hierarchy          | Levels                                                                                                                                         | How the parent is known                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Places             | category (11) > basic category > place; brand > place                                                                                          | Stored. The full Overture taxonomy path is read in the build and dropped (still in the raw files).                                         |
| Street assets      | subtype (emergency, transportation) > class (4) > asset                                                                                        | Class stored; subtype in code (`src/data/overtureInfrastructure.js`).                                                                      |
| Roads              | class group (major, minor, path) > class (17) > subclass (8) > segment                                                                         | Class and subclass stored; groups in code.                                                                                                 |
| Buildings          | class (13 + none) > building                                                                                                                   | Read, kept only as build tallies; the raw files are not kept (footers only), so restoring it per building means reading the release again. |
| Land cover         | WorldCover 11 classes, flat; forest types 3, flat                                                                                              | Stored values.                                                                                                                             |
| Cameras            | pack (22) > provider > cityId > camera; camindex directory (opencctv, openeagleeye, pocketworld) > operator host > camera; category; feed type | Stored.                                                                                                                                    |
| ALPR               | operator > manufacturer > camera                                                                                                               | Stored as free-text tags.                                                                                                                  |
| Military areas     | class (7) > area                                                                                                                               | Stored; branch and operator not extracted.                                                                                                 |
| Data centres, dams | operator > site; dam source layer > plant method > dam                                                                                         | Stored as OSM tags (sparse).                                                                                                               |
| Submarine cables   | cable > part; landing country > landing point                                                                                                  | Part stored; country only inside the landing name; cable → landing needs a join.                                                           |
| Aircraft           | class (10) > ICAO type > aircraft; airline > aircraft; emitter category                                                                        | Class and type stored (type and airline only after an adsbdb lookup).                                                                      |
| Vessels            | AIS family (tens digit) > ship type (0–99) > vessel                                                                                            | Type stored; family in code (`src/data/vesselLabels.js`).                                                                                  |
| Satellites         | class (5) > group (7) > object                                                                                                                 | Group stored, class in code; operator, country and constellation need SATCAT.                                                              |
| Launches           | provider > launch > payload; payload operator, manufacturer                                                                                    | Stored.                                                                                                                                    |
| Fires              | instrument > satellite > detection; complex > incident; state > county > incident                                                              | Stored.                                                                                                                                    |
| Transit            | feed > route > trip > vehicle; mode                                                                                                            | Ids stored; mode inferred in code; route names need GTFS static files.                                                                     |
| Bikeshare          | brand > system > station                                                                                                                       | Stored.                                                                                                                                    |
| Radio              | country > state > station; tag category (8)                                                                                                    | Country and state stored; categories in code.                                                                                              |
| Street level       | provider > sequence > image; contributor                                                                                                       | Stored.                                                                                                                                    |
| Imagery            | product > day > granule                                                                                                                        | Stored.                                                                                                                                    |
| Wikipedia          | language > article; class (4)                                                                                                                  | Stored.                                                                                                                                    |

## 4. Synthesis

### 4.1 The unit tree (left of `://`)

Base quantity > unit > the variables that can size a rectangle. **Stored**
variables are extensive fields held as they are; **derived** variables are
products of an intensive field and its extensive base (4.2), each given
as field × base, the user's "elevation as a function of surface area".
"(geometry)" marks a measure computed from shapes.

| Quantity    | Unit  | Stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Derived (intensive × base)                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Number      | count | records of any dataset (every layer); people (Overture localities, one kind at a time; Natural Earth places, overlapping; GHSL grid); buildings (Overture density cells); places by category (Overture H3 counts); street assets by class (H3 counts); articles (Wikipedia grid, H3, points); properties, sales, bedrooms, bathrooms (property); payloads (launches); personnel (fire perimeters); docks, bikes available (bikeshare); aircraft, degraded aircraft (GNSS cells); messages (local ADS-B); pictures (Panoramax grid); mesh faces, vertices (Blocks) | people = `ee-population` density × cell area; buildings = `ee-buildings` count density × cell area; articles = Wikipedia articles per km² × area, or articles per 100,000 people × people ÷ 10⁵; flood events × area is area-events (below)                                                                                                                                                                                                                                           |
| Length      | m     | river length (v2 km per order; FFR `LENGTH_KM`, `BB_LEN_KM`); route distance (directions)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | road length, boundary length, cable length, sequence length, track length (geometry); distance = speed × time (aircraft, vessels, transit); contained perimeter = containment % × perimeter (fire perimeters)                                                                                                                                                                                                                                                                         |
| Area        | m²    | polity area (Cliopatria, within one year); floor and lot area (property, ft²); burned area (fire perimeters, acres); military area (bundle `areaM2`); building footprint (Overture density cells); H3 cell area (Wikipedia)                                                                                                                                                                                                                                                                                                                                       | administrative, tract, polygon and footprint areas (geometry); water area = water-plane fraction × cell area; built area = `ee-buildings` cover × cell area; class area = land-cover, forest-type or forest-loss-year indicator × cell area (native resolution); mean water area = surface-water occurrence % × area; cloudy area = cloud cover % × granule area; floor area = building levels × footprint (data centres); camera view area = ½ × field of view (rad) × range² (cctv) |
| Area × time | m²·s  | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | flooded area-time = `ee-inundation` duration × cell area; water area-months = surface-water seasonality × area; flooded area-events = `ee-inundation` count × cell area (m², counted per event)                                                                                                                                                                                                                                                                                       |
| Volume      | m³    | building volume (Overture density cells: Σ height × footprint)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | land volume above sea level = elevation × surface area; canopy volume = canopy height × area; building volume = `ee-buildings` height × built area, or height × footprint (data centres, Overture buildings); flow volume = discharge × time                                                                                                                                                                                                                                          |
| Mass        | kg    | payload mass (launches)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Time        | s     | video duration (recorded video); route duration (directions); polity duration (Cliopatria `to − from`, years)                                                                                                                                                                                                                                                                                                                                                                                                                                                     | travel time at the limit = road length ÷ speed limit; track duration (geometry of trails)                                                                                                                                                                                                                                                                                                                                                                                             |
| Power       | W     | fire radiative power (FIRMS, MW); hydro output (dams, 309 of 704); data-centre IT load (3, too sparse)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Energy      | J     | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | earthquake energy ≈ 10^(1.5 M + 4.8) J from magnitude                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Money       | USD   | sale price, assessment (property); tax (USD a year, property); fire cost to date (perimeters)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | value = median price per ft² × floor area; sales value ≈ median sale price × sales (an estimate: a median is not a mean); household income = median income × households (households not stored)                                                                                                                                                                                                                                                                                       |
| Information | byte  | wikitext size (Wikipedia grid, H3, points); tile size (Blocks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | bytes = text bytes per km² × area, or bytes per person × people                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Flow        | m³/s  | mean discharge (FFR `DIS_AV_CMS`): additive only across disjoint outlets, e.g. river mouths per ocean or basin                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### 4.2 Intensive fields: base and additive product

Every intensive ratio or interval field, the extensive base it is "per",
and the additive product of the two. A field with no meaningful base can
size rectangles only as a relative comparison (largest mean slope first),
never as a partition whose parts add up to a whole.

| Intensive field                                            | Dataset                                          | Unit           | Base (per)                                | Product                                         | Product unit |
| ---------------------------------------------------------- | ------------------------------------------------ | -------------- | ----------------------------------------- | ----------------------------------------------- | ------------ |
| elevation                                                  | `ee-elevation`, Blocks                           | m              | surface area                              | land volume above sea level (negative below it) | m³           |
| water-plane fraction                                       | `ee-elevation`                                   | fraction       | cell area                                 | water area                                      | m²           |
| canopy height                                              | `ee-tree-canopy`                                 | m              | area                                      | canopy volume (height envelope)                 | m³           |
| building height                                            | Overture buildings, `ee-buildings`, data centres | m              | footprint or built area                   | building volume                                 | m³           |
| building count density                                     | `ee-buildings`                                   | km⁻²           | area                                      | buildings                                       | count        |
| built cover                                                | `ee-buildings`                                   | fraction       | area                                      | built area                                      | m²           |
| population density                                         | `ee-population`                                  | km⁻²           | area                                      | people                                          | count        |
| surface-water occurrence                                   | `ee-surface-water`                               | %              | area                                      | mean water area                                 | m²           |
| surface-water seasonality                                  | `ee-surface-water`                               | month          | area                                      | water area-months                               | m²·month     |
| flood events, flooded days                                 | `ee-inundation`                                  | count; d       | cell area                                 | flooded area-events; flooded area-time          | m²; m²·s     |
| land-cover, forest-type class                              | `ee-land-cover`, `ee-forest-types`               | class          | cell area (indicator per class)           | class area                                      | m²           |
| forest-loss year                                           | `ee-forest-loss`                                 | year           | cell area (indicator per year)            | area lost in that year                          | m²           |
| articles per km², bytes per km²                            | Wikipedia                                        | km⁻²; byte/km² | area                                      | articles; bytes                                 | count; byte  |
| articles per 100,000 people, bytes per person              | Wikipedia                                        | 10⁻⁵; byte     | people                                    | articles; bytes                                 | count; byte  |
| median sale price                                          | property cells                                   | USD            | sales                                     | sales value (estimate)                          | USD          |
| median price per ft²                                       | property cells                                   | USD/ft²        | floor area                                | value                                           | USD          |
| median household income                                    | census tracts                                    | USD            | households (not stored)                   | household income                                | USD          |
| speed limit                                                | Overture roads                                   | m/s            | length (as length ÷ speed)                | travel time at the limit                        | s            |
| speed                                                      | aircraft, vessels, transit, cyclone motion       | m/s            | time                                      | distance                                        | m            |
| mean discharge                                             | FFR reaches                                      | m³/s           | time                                      | flow volume (per year: × 3.156 × 10⁷ s)         | m³           |
| containment                                                | fire perimeters                                  | %              | perimeter length                          | contained perimeter                             | m            |
| percent degraded                                           | GNSS cells                                       | %              | aircraft                                  | degraded aircraft (also stored)                 | count        |
| cloud cover                                                | recent imagery                                   | %              | granule area                              | cloudy area                                     | m²           |
| building levels                                            | data centres                                     | count          | footprint                                 | floor area                                      | m²           |
| field of view, range                                       | `cctv`                                           | °, m           | each other                                | view-cone area ½ θ r²                           | m²           |
| place confidence, Mapillary quality, FIRMS confidence      | Overture, street level, FIRMS                    | none           | none                                      | relative only                                   | —            |
| slope, aspect                                              | Earth Engine terrain                             | °              | none                                      | relative only                                   | —            |
| land surface temperature, brightness temperature           | census, FIRMS                                    | °C, K          | none (heat needs mass and heat capacity)  | relative only                                   | —            |
| magnitude                                                  | earthquakes                                      | none           | none (energy is derived from it directly) | relative only, or energy (4.1)                  | —            |
| depth, altitude, mount height, dam height, Wikipedia `dim` | earthquakes, aircraft, cctv, dams, Wikipedia     | m              | none                                      | relative only                                   | —            |
| wind speed, gusts, central pressure                        | wind, cyclones                                   | m/s; Pa        | none                                      | relative only                                   | —            |
| AQHI, connectivity index (CSI), traffic level              | air quality, FFR, traffic                        | none           | none                                      | relative only                                   | —            |
| median year built, polity years                            | property, world history                          | year           | none (differences are durations)          | relative only                                   | —            |
| bitrate                                                    | radio                                            | bit/s          | listening time (not stored)               | —                                               | —            |
| satellite mean motion, eccentricity, propagated speed      | satellites                                       | Hz; none; m/s  | none                                      | relative only                                   | —            |
| sitelinks, languages per article, sharedBy                 | recorded video, Wikipedia                        | count per item | none                                      | relative only                                   | —            |
| upstream area                                              | FFR, v2                                          | m²             | none (accumulated along the network)      | additive only across disjoint outlets           | m²           |

### 4.3 Grouping variables (right of `://`)

Nominal and ordinal fields, with their cardinality where it is known, then
interval and ratio fields worth binning.

| Variable                                                        | Datasets                                                                                                             | Level                   | Cardinality                                              |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------- |
| country (ISO alpha-2)                                           | Overture areas (273), localities (265), Natural Earth (260 countries), radio (101), cable landings (186, from names) | nom                     | 273                                                      |
| region (ISO 3166-2)                                             | Overture areas, localities; Natural Earth states (4,587); fire perimeters                                            | nom                     | 3,929 region units                                       |
| county                                                          | Overture areas (38,933); US FIPS (3,235); property; perimeters                                                       | nom                     | 38,933                                                   |
| division subtype                                                | Overture areas: country, dependency, region, county                                                                  | ord                     | 4                                                        |
| locality kind                                                   | Overture localities                                                                                                  | nom                     | 10                                                       |
| state, county, tract (US)                                       | census, property, counties pack                                                                                      | nom                     | 56; 3,235; 85,184                                        |
| ZIP, city                                                       | property                                                                                                             | nom                     | —                                                        |
| place category                                                  | Overture places                                                                                                      | nom                     | 11                                                       |
| place basic category, brand, source                             | Overture places                                                                                                      | nom                     | not counted                                              |
| street-asset class                                              | Overture infrastructure                                                                                              | nom                     | 4                                                        |
| road class, subclass, surface                                   | Overture roads                                                                                                       | nom                     | 17; 8; 8                                                 |
| road flags (bridge, tunnel, bike…)                              | Overture roads                                                                                                       | nom                     | 8 booleans                                               |
| building class, source                                          | Overture buildings (tallies only)                                                                                    | nom                     | 14; 6                                                    |
| property type                                                   | property                                                                                                             | nom                     | 8                                                        |
| land cover                                                      | `ee-land-cover`                                                                                                      | nom                     | 11                                                       |
| forest type                                                     | `ee-forest-types`                                                                                                    | nom                     | 3                                                        |
| forest-loss year                                                | `ee-forest-loss`                                                                                                     | interval                | 25                                                       |
| population epoch                                                | `ee-population`                                                                                                      | interval                | 4                                                        |
| river order (v2), discharge order, Strahler order               | rivers                                                                                                               | ord                     | 8; 10; 15                                                |
| free-flowing class, dominant pressure                           | FFR                                                                                                                  | ord; nom                | 3; 7                                                     |
| basin, backbone river                                           | FFR                                                                                                                  | nom                     | — (per click)                                            |
| camera pack, provider, category, feed type, coordinates quality | `cctv`                                                                                                               | nom; ord                | 22; 35 served; —; 5; 5                                   |
| enforcement camera kind                                         | Baltimore                                                                                                            | nom                     | 4                                                        |
| video source, video kind                                        | recorded video                                                                                                       | nom                     | 3; 6                                                     |
| military class                                                  | military areas                                                                                                       | nom                     | 7                                                        |
| data-centre operator                                            | data centres                                                                                                         | nom                     | hundreds (top: AWS 290, Equinix 174, Digital Realty 163) |
| dam source layer, plant source                                  | dams                                                                                                                 | nom                     | — ; 3                                                    |
| cable                                                           | submarine cables                                                                                                     | nom                     | 694                                                      |
| aircraft class, emitter category                                | aircraft                                                                                                             | nom                     | 10; 21                                                   |
| ICAO type, airline                                              | aircraft (after lookup)                                                                                              | nom                     | 42 types among 116 military aircraft                     |
| AIS ship family, ship type                                      | vessels                                                                                                              | nom                     | 10; 100                                                  |
| satellite group, class                                          | satellites                                                                                                           | nom                     | 7; 5                                                     |
| launch provider, status, payload type                           | launches                                                                                                             | nom                     | —                                                        |
| fire instrument, satellite, confidence                          | FIRMS                                                                                                                | nom; ord                | 2; 5; 3                                                  |
| fire category, cause, complexity                                | perimeters                                                                                                           | nom; nom; ord           | 2; 3; 5                                                  |
| storm basin, classification                                     | cyclones                                                                                                             | nom; ord                | 3; —                                                     |
| AQHI band, zone                                                 | air quality                                                                                                          | ord; nom                | 4; 5                                                     |
| GNSS level                                                      | GNSS                                                                                                                 | ord                     | 3                                                        |
| transit feed, mode, occupancy                                   | transit                                                                                                              | nom; nom; ord           | 16; 5; —                                                 |
| bikeshare system                                                | bikeshare                                                                                                            | nom                     | 52                                                       |
| radio country, tag category                                     | radio                                                                                                                | nom                     | 101; 8                                                   |
| imagery product                                                 | recent imagery                                                                                                       | nom                     | 3                                                        |
| Wikipedia language, class                                       | Wikipedia points                                                                                                     | nom                     | 11; 4                                                    |
| polity, record type, 50-year bucket, span confidence            | world history                                                                                                        | nom; nom; interval; ord | 1,637; 2; 109; 3                                         |
| Blocks level, material                                          | Blocks                                                                                                               | ord; nom                | 6; 7                                                     |
| H3 resolution, grid level                                       | every H3 and grid store                                                                                              | ord                     | 8; 5                                                     |

Interval and ratio fields worth binning: elevation, slope, aspect (eight
compass sectors), canopy and building height, year built, sale price and
price per m², income, land surface temperature, population and building
density, magnitude, depth, altitude, speed, discharge (by decade, as
`RIV_ORD` does), confidence, containment, cloud cover, AQHI value, and
every time field by year, month, day or hour.

## 5. The universal join

Every record has a place, so any dataset can be cut by any spatial
partition. What is precomputed today, and what a join would cost.

### 5.1 Precomputed

| Dataset                                      | Partition already on the record                        |
| -------------------------------------------- | ------------------------------------------------------ |
| Overture localities                          | country, region (ISO)                                  |
| Overture areas                               | country, region (ISO); county → region by code         |
| Natural Earth places and states; US counties | country; state                                         |
| Property                                     | state, county FIPS, ZIP, city                          |
| Census tracts                                | state, county (GEOID)                                  |
| Fire perimeters                              | state (ISO 3166-2), county name                        |
| Radio                                        | country (ISO), state                                   |
| Clicked river reaches                        | country, continent, basin                              |
| Air quality; cyclones                        | ECCC zone; ocean basin                                 |
| Overture places, infrastructure              | H3 counts res 0–7 (a grid, not an administrative unit) |
| Overture buildings                           | density cells D14, D18, D19 (a grid)                   |
| Wikipedia, GHSL population                   | 0.05° grid and H3 res 0–7 (grids)                      |
| Property                                     | H3 res 0–7 (a grid)                                    |

### 5.2 To compute

Rough costs, single-threaded Node, against the 43,345 Overture units
(about 2,000 vertices each at the finest band) with the grid index the
server's `identify` already uses:

| Dataset                                                     | Records                           | Join                                         | Rough cost                                                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overture places                                             | 64.7 M points                     | point in polygon                             | tens of minutes naively; a few minutes if H3 res-7 cells are labelled once and only cells crossing a border are tested point by point                                        |
| Overture infrastructure                                     | 11.2 M points                     | point in polygon                             | a sixth of places                                                                                                                                                            |
| Overture buildings                                          | 579 M polygons                    | via density cells                            | join the D18/D19 cells instead of footprints: the cells hold count, area and volume as sums, so nothing is lost                                                              |
| Overture roads                                              | 287 M pieces                      | line in polygon                              | midpoint assignment (cheap, approximate) or clipping at borders (exact length per unit, costly)                                                                              |
| HydroSHEDS v2                                               | 21 M reaches                      | midpoint in polygon                          | re-read the raw files (4–5 min) plus minutes of joins; the built files keep no reach id                                                                                      |
| Wikipedia points                                            | 2.6 M points                      | point in polygon                             | about a minute                                                                                                                                                               |
| Wikipedia and GHSL grids                                    | 26 M base cells                   | rasterize the units onto the 0.05° grid once | minutes, then free                                                                                                                                                           |
| H3 stores (Wikipedia, places, property)                     | up to 860,000 cells at res 7      | label each cell by its centre                | seconds                                                                                                                                                                      |
| Cameras, military areas, data centres, dams, cable landings | under 100,000 each                | point in polygon                             | seconds                                                                                                                                                                      |
| World history                                               | 13,797 polygons                   | polygon overlay with modern countries        | seconds to a minute (bounding-box prefilter)                                                                                                                                 |
| Live feeds                                                  | up to tens of thousands a refresh | point in polygon per refresh                 | milliseconds to seconds                                                                                                                                                      |
| Earth Engine rasters                                        | per area                          | `reduceRegions` over the units               | Earth Engine tiles from the day's budget: one request per unit and level, so a country > region > county tree is tens of thousands of requests and wants a precomputed table |

One labelling serves all: an H3 res-7 (or 0.05°) cell → unit table,
computed once from the Overture areas, lets every point dataset and every
grid store be cut by country, region or county with a lookup, leaving
exact point-in-polygon tests only for the cells that straddle a border.
