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
  The rasters are drawn per build and per server and not stored, so there
  is no separate table file.
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

The buildings come to 579,463,210 in 112,939,372 cells. 22,252 Wikipedia
articles are at sea.

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

## Order of work

1. This plan and the catalogue's first set (manager).
2. Tables 1 and 2, the service with `m2/surface-area` and `count/people`,
   and `src/data/treemapCatalog.js` (worker2). The window against that
   contract, starting on a fixture of it (worker3).
3. The remaining first-set variables as their tables land; the label
   endpoint and the live sources.
4. Phase 2: land cover and land volume, then the inventory's wider list.
