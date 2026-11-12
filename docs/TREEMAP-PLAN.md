# The treemap navigator

Personal fork. A new mini-window beside Display, CCTV, Street Level and
Context: an interactive treemap over the data God's Eye View already
holds, as an analysis layer that triangulates the globe. The globe hides
half the world and shows one place at a time; the treemap shows a whole
total in one window, cut the ways the data can be cut. The same data
drives both. The data it stands on is listed in
[TREEMAP-INVENTORY.md](TREEMAP-INVENTORY.md).

Not part of upstream God's Eye View. The design patterns come from the
user's exploratory `wwwtopdf` treemap app (a measure switch, variables as
ordered pills, depth per variable, a pre-aggregated cube, the view in the
URL), adapted, not copied: this code base is plain JavaScript without
React, d3 or DuckDB.

## The address

```text
<unit>/<variable>://<grouping>[/<grouping> | *<grouping>]…
m2/surface-area://admin.continent/admin.country/admin.region/admin.district
```

- **Left of `://`: what a rectangle's size means.** A unit, then a
  variable measured in it. Three sizing modes:
  - `additive`: an extensive ratio variable (area, length, count, people,
    money). Every level is a true total.
  - `product`: an intensive variable times its extensive base (elevation
    × surface area = land volume, m³). Every level is a true total; the
    intensive value is total ÷ base at any rectangle.
  - `relative`: an intensive variable with no base (slope, an index).
    Siblings compare; a parent is not a sum, and the window says so.
- **Right of `://`: how that total is cut**, an ordered list of
  groupings. `/` descends a hierarchy stored in the data (each child has
  one parent: country / region / district). `*` overlays an independent
  partition (boundaries × land cover); it is shown as `×`, and the two
  sides can be swapped. Both draw as nesting, in the order written.
- A grouping is `family.level`: `admin.country`, `place.category`,
  `time.year`, `h3.4`.

## The catalogue

Once a quantity is chosen, the window offers ready-made pill sequences in
the manager's order of interest, each with a line saying what it reveals.
The catalogue is data in the repository
(`src/data/treemapCatalog.js`), curated by hand and extended over time;
it is not a model called at run time. The pills stay editable.

First set (`needs` names the build step a sequence waits on):

| Quantity             | Variable (id)                                                                | Mode     | Sequences, in order                                                                                                    | What it reveals                                                                             |
| -------------------- | ---------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Area, m²             | surface area (`m2/surface-area`)                                             | additive | `admin.continent/admin.country/admin.region/admin.district`; `admin.country*landcover.class` (phase 2)                 | The shape of the administered world; how much of each country is forest, crop, bare, built. |
| Number, count        | people (`count/people`)                                                      | additive | `admin.continent/admin.country/admin.region/locality.place`; `admin.country*locality.kind`                             | Where people are, against where land is; city countries and village countries.              |
| Number, count        | places (`count/places`)                                                      | additive | `place.category/admin.country/admin.region`; `admin.country/place.category`                                            | What the mapped economy consists of, and where mapping is thin.                             |
| Number, area, volume | buildings (`count/buildings`, `m2/building-footprint`, `m3/building-volume`) | additive | `admin.continent/admin.country/admin.region` for each                                                                  | The built world three ways: sprawl against height.                                          |
| Number, information  | Wikipedia (`count/wikipedia-articles`, `byte/wikipedia-text`)                | additive | `wikipedia.language/admin.country`; `admin.country/wikipedia.class`                                                    | Which places the world has written about, and in which language.                            |
| Area, m²             | historical polity area (`m2/polity-area`)                                    | additive | `history.period/history.polity`                                                                                        | Empires rising and shrinking, period by period. A period must be the first grouping.        |
| Number, count        | aircraft now, vessels now (`count/aircraft`, `count/vessels`)                | additive | `aircraft.class/aircraft.type`; `vessel.family/vessel.type`; `admin.country/aircraft.class` (after the label endpoint) | The live picture the globe half-hides, in one window.                                       |
| Volume, m³ (phase 2) | land volume (`m3/land-volume`)                                               | product  | `admin.continent/admin.country`                                                                                        | Elevation by surface area: Tibet and the Andes against the flat giants.                     |

## The service (server)

`/api/treemap`, same-site, GET only, read-only, from tables built once
under the gev cache (`treemap/`). No Earth Engine, Overpass or other
metered call is made while answering.

```text
GET /api/treemap/catalog
  → { schema: 'treemap/1',
      variables: [{ id, available: boolean, why?: string, asOf?: string,
                    groupings: [groupingId…] }],        // which cuts each variable supports
      groupings: [{ id, family, level, kind: 'hierarchy'|'overlay',
                    parent?: groupingId, cardinality?: number }] }

GET /api/treemap/node?address=<address>&path=<key>/<key>…&depth=1|2&limit=<n>&offset=<n>
  → { schema: 'treemap/1', address, mode, unit,
      path: [{ key, label, grouping }],                 // the node asked for, root first
      total: { value, count },                          // this node's own total
      level: { grouping, label },                       // what its children are
      children: [{ key, label, value, count?, share,    // share of this node, 0..1
                   hasChildren, geo?: GeoRef,
                   children?: [...], rest?: Rest }],    // when depth = 2
      rest: { count, value } | null,                    // the children past limit: the "…" tile
      exact: boolean, note?: string, attribution: string }

GET /api/treemap/geo?ref=<GeoRef>
  → GeoJSON (a simplified outline, or a box) for the globe to draw
POST /api/treemap/label   { points: [[lon, lat]…] }     // phase 1b, for live layers
  → { units: [{ country, region, district } | null…] }
```

- Children are sorted by value, largest first. `limit` defaults to 200;
  the rest is one `rest` entry, and `offset` pages into it.
- In mode `product` (an intensive quantity times its base: land volume)
  the total and every child also carry `base?` (the base variable's
  value under it: land area in m²) and `mean?` (value ÷ base: the mean
  elevation in m, to 0.1; null where the base is 0). Both are optional; the
  window computes value ÷ base when `mean` is absent.
- `GeoRef` is a short string: `area:<overture id>`, `h3:<cell>`,
  `box:w,s,e,n`, `point:lon,lat`.
- Area's root is the planet (510,072,000 km²): the administered land,
  plus one "oceans and unclaimed" tile for the remainder.
- An address the tables cannot answer is a 400 with the reason; a variable
  whose table is not built is `available: false` in the catalogue.

### Tables to build (`npm run treemap:build`)

1. **Unit areas**: geodesic area of every Overture division area (land),
   summed up the stored ISO links; a continent for every country (a
   lookup of about 250 ISO codes, in the repository).
2. **The cell labelling**: every H3 res-7 cell (or the grid a store
   already uses) → country, region, district, exact point-in-polygon only
   for cells on a border. One table serves every point and grid store.
3. **Per-variable tables** from stores already on disk: localities'
   population by unit and kind; places per category per unit; buildings'
   count, footprint and volume per unit; Wikipedia articles and bytes per
   language, class and unit; Cliopatria polity area per 50-year period.

Phase 2, with their own costs stated before running: land cover area per
country and mean elevation per country (Earth Engine, from the day's
budget), census tracts, basins, roads and rivers by unit.

### As built

Calls made where the plan was silent:

- **Tables are cubes.** A table is rows of keys (one per grouping it can
  be cut by), a value and a count (scripts/treemap, server/providers/treemap/table.js).
  A node filters the rows by its path and groups them by the address's next
  grouping. So any order of a table's groupings answers, and `/` between
  groupings that are not one hierarchy (`place.category/admin.country`) nests
  them exactly as `*` would.
- **Remainders are tiles.** Where a parent's children do not cover it, the
  rest is one tile keyed `~`: "No region", "No district", "Other places".
  A remainder under 0.1% of its parent is a seam between two outlines,
  not a tile, and is dropped. A parent's total is then the sum of its
  tiles, so shares add to 1. A child has children (`hasChildren`) only if
  it breaks down into something other than its own remainder.
- **The planet.** Its area is the WGS84 authalic sphere's, 510,065,622 km²;
  the plan's 510,072,000 is the rounded sphere. "Oceans and unclaimed" is
  the planet minus every country and dependency's land, keyed `ocean` at
  every admin level.
- **Overlapping claims.** Overture's disputed areas (X* codes: Kashmir
  sectors, the Kurils and others) are counted as their own countries, so land
  that two claims cover counts twice.
- **Continents.** They follow the UN M49 regions, with the Americas split at
  Panama (src/data/treemapContinents.js). Russia is in Europe; Turkey and
  Cyprus are in Asia.
- **Areas.** Each is computed from the areas build's finest band (2^24 Web
  Mercator steps), as land on the WGS84 ellipsoid, holes taken out.
- **People.** Only settlements count (city, town, village, hamlet, other
  localities). Neighbourhoods, counties and municipalities are left out, so
  a person is not counted twice through their district. Each region keeps
  its 100 largest places as tiles; the rest are one "Other places" tile per
  kind. A place's key is its Wikidata id, else `n<index>`. The table is
  `exact: false` with a note: it is not a census.
- **Depth 2.** Each child shows at most 50 of its own children, with the
  rest in that child's `rest`.
- **Live variables.** Aircraft and vessels are `available: true` in the
  catalogue (the window counts them from the layers). `/node` answers
  them with a 400 saying so.
- **The cell labelling** (server/providers/treemap/labeller.js). The
  localities carry their own country and region, so people needs no
  labelling. Every other store's points or cells are labelled from the
  Overture areas rasterised one z 6 tile at a time: 1,024 pixels a side,
  so a pixel is about 610 m at the equator. Larger units are drawn first,
  so enclaves and disputed areas lie on top. A point reads its pixel;
  one on a pixel no land covers (a coast) takes the nearest labelled
  pixel within 2, else it is at sea, in the `ocean` tile. Exact
  point-in-polygon against a country of a million points costs
  milliseconds a point. With rasters, 200,000 points take under a second.
  Drawing a tile takes tens to hundreds of milliseconds, so live points
  scattered over the world can't draw on demand: 20,000 random points took
  494 s through a 24-tile cache. So the `labels` step draws every tile
  some land unit meets, once, and stores each as runs of equal pixels
  (zstd-compressed, one file, its index in the manifest's
  `files.labels`). The other steps and `POST /api/treemap/label` read
  those runs; a lookup is a binary search in a row's runs. The same
  20,000 points take 4.7 s cold (decoding about 1,500 tiles) and 2.3 s
  warm, measured with the CPU taken by another project.
- **`POST /api/treemap/label`** takes at most 20,000 points (a body of
  at most 1 MB). It answers the contract's `{ units }` in the points' order:
  `{country, region, district}` with the tables' keys (ISO country, ISO
  3166-2 region else the area's id, the district's id), `null` at sea or
  for anything not a point. It answers 503 until the labelling is built.
- **Places** come from the places index's H3 resolution 7 counts (about
  5 km² a cell), each cell given whole to the unit holding its centre. All
  places the index keeps count (confidence 0.5 and up). Its categories are
  the Places layer's eleven, "other" included.
- **Buildings, footprint and volume** come from the buildings build's D18
  density cells (about 150 m), each labelled at its centre. The build covers
  the conterminous US and Europe only, and the note says so. A volume is
  Σ height × footprint over the known heights, plus the rest of the
  footprint at the cell's mean known height, or 5 m where the cell knows
  none.
- **Wikipedia** counts each geotagged article of the eleven wikis once, at
  its primary coordinate, in its own wiki's language. Its kind is the
  points index's class (place, landmark, nature, other). Its bytes are the
  article's size. Articles at sea go to the `ocean` tile. Wikipedia has no
  district level; country and region only.
- **Polity area** samples each 50-year period at its middle year (the
  last, 2000–2024, at 2024). Relations are left out, and so is a member
  (MemberOf) whose parent is alive then: the parent, a bracketed name like
  "(British Empire)", holds its members' land. It is labelled without the
  brackets, and the area is Cliopatria's. Periods come largest first, like
  every level; the window may sort them by key (the start year) for a
  timeline.
- **Rows are refused when empty.** A step that reads its store but finds
  no rows (a changed format) publishes nothing and says so. Each table's
  version is in its signature, so a rule change rebuilds it once.

Built on 2026-11-11 from the Overture areas build 21c6d7d7da09a9b1 and the
localities build c572a53cd594, into `.gev-cache/treemap` (D:):

| Table                                              |         Rows |    File |        Build |
| -------------------------------------------------- | -----------: | ------: | -----------: |
| m2/surface-area (43,132 land units, 49.5 M points) |       40,946 | 5.47 MB |       15.4 s |
| outlines (the band each unit is drawn from)        | 43,132 units | 2.42 MB | in the above |
| count/people (608,957 settlements)                 |      113,286 | 8.73 MB |        5.3 s |

Land comes to 150.3 M km², 29.5% of the planet. The people in mapped
places come to 5.16 billion.

Step 3, built on 2026-11-12 while all 16 cores were taken by another
project's browsers, so the times are roughly twice a quiet machine's:

| Table                                                        |    Rows |             File | Build |
| ------------------------------------------------------------ | ------: | ---------------: | ----: |
| m2/polity-area (109 periods, Cliopatria via World history)   |   4,337 |          0.18 MB | 0.4 s |
| count/wikipedia-articles and byte/wikipedia-text (2,640,556) |  44,025 | 1.12 and 1.27 MB | 217 s |
| count/places (64,735,759 places in 2,277,190 res-7 cells)    | 324,502 |         11.48 MB | 191 s |
| count/buildings, m2/building-footprint, m3/building-volume   |  15,192 | 1.9, 2.0, 2.0 MB | 361 s |
| labels (the cell labelling: 3,768 z 6 tiles of runs)         |       — |         22.82 MB | 106 s |

The buildings come to 579,463,210 in 112,939,372 cells. 22,252 Wikipedia
articles are at sea.

Notes the tables carry, added on 2026-11-12 after the first set was
checked on 4173:

- Polity area: above the periods the total is no area. Periods are added,
  so the same land is counted once per period.
- People: the 5.16 billion are about two thirds of GHSL's 7.79 billion for 2020. A country short of its census is short of mapped figures, not of
  people.
- Surface area: the continents are the UN M49 regions. Russia is wholly in
  Europe (23.6 M km²), and Turkey and Cyprus are in Asia.

### Phase 2 (Earth Engine, under a cap of 3,000 requests)

- **The grid.** The world is cut into 15° boxes, 288 of them from 84° N
  to 90° S, each asked at most 640 cells a side. A cell is about 2.5 km,
  narrower in longitude toward the poles. Each box is one
  `image:computePixels`, asked through the server's own Earth Engine
  service (server/providers/rasterValues' adapters), so every request is
  counted in its daily ledger (`.gev-cache/earth-engine/usage.json`).
  Each answer is kept under the tables' directory (`ee/`, a `.f32` and a
  `.json` a box), so a rebuild asks only for what is missing.
  `npm run treemap:build` never asks: its `landcover` step reads the kept
  boxes only. The `earthengine` step asks, only when named
  (`--only earthengine`), within `--max-requests` and never past 600 a
  run. It stops on a 429 and after 5 boxes fail in a row.
- **The spend.** Land cover asked all 288 boxes. I had chosen land boxes
  from the stored labelling, but its tiles cover open sea wherever a large
  unit's box spans it, so the estimate of about 150 was wrong: only 182
  boxes hold land. With 2 probe requests, that made 290. Elevation then
  asked only the 182 boxes where land cover found land. A box costs about
  1.5 requests there, because the values service asks once more when Earth
  Engine gives no answer in 120 s, and samples when a mean fails. The PC
  crashed at 01:52 with 36 elevation boxes kept and 58 requests spent (3 of
  them probes). Resumed at 09:12 with a cap of 252, the stack's mean over 30 m
  FABDEM at mid and low latitudes failed at this scale: "Object too large"
  (about 182 MB, then sampled, 2 requests) 16 times, no answer in 120 s
  10 times, "memory capacity exceeded" twice. That was about 3 requests a
  box late on. It was stopped at 92 boxes and 450 requests. The 90 boxes
  still missing (69° N to 66° S) were each asked once for a plain
  GMTED2010 sample, with no second try (a no-answer counts as failed): 1
  probe and 89 requests, none failed. Antarctica had been left out,
  because WorldCover has no data south of 60° S and so no box there "held
  land". Its 48 boxes were asked from the stack's polar source, REMA and
  the stack's mean: 1 probe and 47 requests, none failed.
  **Total: 588 requests on the day's ledger** (land cover 290, elevation
  298), under the 600 stop and the cap of 3,000.
- **Land cover** (`m2/surface-area+landcover`, a second table of the same
  variable). It is ESA WorldCover 2021, read at each cell from its
  pyramid's most common class, by continent, country, region and the
  eleven classes. Each country's classes are scaled to its land in the
  areas table, so `admin.country*landcover.class` and its swap
  `landcover.class*admin.country` total what the admin cut does. The
  service answers an address from the first of a variable's tables that
  has every grouping asked for, and the catalogue lists their union.
  WorldCover stops at 60° S, so Antarctica has no land cover, and the
  land here is about 137 of the 150 million km². Built in 48 s from the
  kept boxes, 0 requests.
- **Land volume** (`m3/land-volume`, mode product). Each cell's area times
  its elevation above the sea, ice surfaces included, by continent, country
  and region. The 230 boxes come from mixed sources:
  - 90 GMTED2010 samples and 58 GMTED2010 means;
  - 24 REMA means and 24 stack means over Antarctica;
  - 16 FABDEM samples and 10 FABDEM means;
  - 8 ArcticDEM means over Greenland.
  The note lists them too. Each tile and the node's total carry `base`
  (land area, m²) and `mean` (value ÷ base: the mean elevation, m); see
  the contract. In all, 115.5 M km³ over 149.6 M km², a mean of 772 m.
  Asia has a mean of 1,046 m and Antarctica 1,760 m: REMA and ArcticDEM are
  heights above the ellipsoid, and coastal cells at sea level pull a
  mean down. China has 1,824 m, Greenland 1,812 m and Europe 366 m. Built
  from the kept boxes in about 2.5 minutes.

## The window (client)

- **Where**: a mini-window in the panel column with the others,
  collapsible, with a larger pop-out size. Its state (address, path) is in
  the share link.
- **Address bar**: a quantity drop-down (quantity > unit > variable,
  filter as you type), a sequence drop-down (the catalogue's order, each
  with its "reveals" line), and the pills: remove, reorder, add from the
  groupings that variable supports, `/` or `×` between two.
- **The treemap**: squarified, on a canvas, two levels drawn at once (a
  parent's frame and label, its children inside). Click a tile to go in,
  the breadcrumb to go out. Tiles too small to read merge into one "…"
  tile per parent; clicking it pages in more. Hover: label, value with its
  unit scaled (km², millions), share of parent and of the whole, count.
  Colour by the first grouping's member, so a country keeps its colour as
  the cut changes. A `relative` view carries a "not a sum" note.
- **Sources**: the service for built tables; for live layers (aircraft,
  vessels) the records already in the browser, aggregated in the page to
  the same node shape. One source interface, two implementations.
- **The globe**: hovering a tile outlines its `geo` on the globe;
  double-click flies there. More linking (the view filtering the treemap,
  a selection filtering layers) waits until the data is better known.

### As built (window)

- **Code**: `src/app/treemap.js` (installed from `app/tools.js`), the panel
  `ui/treemapPanel.js`, the bar `ui/treemapAddressBar.js`, the globe link
  `ui/treemapGlobe.js`, the layout `data/treemapLayout.js` (its own
  squarify), the sources `data/treemapSources.js`, the live layers'
  source `app/treemapLive.js`, the fallback sample `data/treemapSample.js`,
  the state and the share link's path `data/treemapStore.js`. Addresses go
  through the shared parser (`data/treemapAddress.js`) and the menus read
  the shared catalogue (`data/treemapCatalog.js`) directly.
- **Address bar**: the address as text on top (`*` shown as `×`, `×` and
  spaces read back), Enter applies it, Escape puts it back; a bad one shows
  the parser's or the catalogue's message (the service's catalogue, when it
  lists the variable, says which cuts it takes). Text, pills and menus are
  the one address in the store. Both drop-downs filter as you type (Enter
  takes the first match); a variable the service lists as unavailable, or
  does not list, is dimmed with its `why` (else "Not built yet").
- **Colour**: the first cut's member sets the hue family. At the root each
  member has its own hue and its children shades of it; inside a member the
  drawn level's tiles fan out about the family's hue (±34°) by their rank,
  stepped by the golden ratio so neighbours in size, which squarify sets
  side by side, part clearly, with four lightness steps; a child stays
  within 8° of its parent.
- **Live by place**: a live variable cut by `admin.*` (aircraft "Countries,
  then classes") posts its points to `POST /api/treemap/label` (at most
  20,000 a call) and counts by the answers in the page: null is the
  service's `ocean` tile, a point not yet answered (the service down) waits
  in "Not placed yet". Each aircraft's or vessel's answer is kept 3 minutes,
  or until it has moved half a degree, so a refresh posts only those.
  Countries are named by the browser (`Intl.DisplayNames`, in the page's
  language), continents by the shared table, regions by the service's area
  table, asked once per country when the window is inside it. Vessels take
  the same cuts. A live view is read again every 15 s while it is shown and
  nothing is hovered.
- **Product**: a `product` answer's tile shows its intensive value in the
  hover card (land volume: the mean elevation in m), from the tile's `mean`
  when the answer gives it, else `value ÷ base` (the window reads a
  per-tile `base`, the base variable's value under it).
- **Links**: a link carrying `tm` opens the panel unless its `ui` state
  says how the panel was.
- **Time cuts**: `history.period` (and any `time.*` grouping) is laid in
  its keys' order (start years, before Christ first) as strips left to
  right, each as wide as its share, the service's largest-first order put
  aside; the polities inside a strip are squarified as usual. The strips
  run a hue gradient from early (blue) to late (amber).
- **Globe**: the service's outlines (`area:` MultiPolygons, `box:`
  continents) drawn as ground lines along rhumb lines (a box's edges follow
  their parallels), the 120 largest rings of an outline (Russia has 890);
  double-click flies to the extent, the narrow way round across the
  antimeridian.
- **Panel**: `#treemap-panel` in the right rail, before CONTEXT, collapsed
  at first; the panel layout's portable path lifts it out (its pop-out
  button: `popOutPanel`/`dockPanel`, at most 1180 × 820, 72 % × 78 % of the
  viewport). Nothing is asked of the service until it is first opened.
- **Share link**: `tm=<address>|<path>` (the path's keys each
  URI-encoded, joined by `/`; the service's own `path` is the raw keys);
  left out for the default address at its root. The panel's open/collapsed
  state is the `ui` param's token `tm` (`k` was the retired Map Stack
  panel's: an old link must not open the treemap; sharelink.js keeps the
  retired tokens).
- **Sources**: one window source. The service while `/api/treemap/catalog`
  answers (asked once a page; the header says TABLES), else a rounded
  page-local sample of area and people by continent, country and region
  (the header says SAMPLE; the same keys as the service). `count/aircraft`
  and `count/vessels` always come from the live layers' records in the page
  (the flights and AIS layers' `treemapRecords()`), read again at each
  load; with the layer off the variable is unavailable, "Turn the layer on
  to count it". A local source that lacks a cut below the first stops the
  view there and says so in its answer's own `stops` field (the grouping it
  stopped before); the service never sends it. The catalogue is asked at
  every load (the service's part is kept), so a live layer switched on
  shows up.
- **Failure states**: a variable not in the catalogue says "not built yet:
  pick another quantity"; one marked unavailable shows its `why`; a 400
  shows the service's reason; anything else "The treemap did not load".
  The sequence menu disables a sequence that waits on a table (`needs`) or
  on its first cut; a deeper cut not built only stops the view there.
- **Joins**: `/` and `×` both draw as nesting (cut by the first, then each
  child by the second); `×` marks an overlay that needs an intersection.

## Order of work

1. This plan and the catalogue's first set (manager).
2. Tables 1 and 2, the service with `m2/surface-area` and `count/people`,
   and `src/data/treemapCatalog.js` (worker2). The window against that
   contract, starting on a fixture of it (worker3).
3. The remaining first-set variables as their tables land; the label
   endpoint and the live sources.
4. Phase 2: land cover and land volume, then the inventory's wider list.
