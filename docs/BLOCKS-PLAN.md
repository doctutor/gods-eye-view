# Blocks: a block world as a render mode

Personal fork. A third **Render** mode beside Colour and Lego that shows a
raster layer, first Elevation, the way Minecraft shows terrain: a grid of
cubes anchored to the world, lit by faces, read by shape rather than colour.
Written 2026-10-27 from the discussion in the manager session; the three
workers build from this page.

## Goal and the first milestone

The interest is reality-grounded exploration, not mining, crafting or
combat. Minecraft is taken as ten years of refinement in _representing and
navigating_ 3D space; what it settled is listed below and copied where it
fits a platform whose core is a real-world coordinate system.

**Milestone 1 (representation).** With the blank base map and the
Elevation layer on, Render: Blocks reads elevation better than Render:
Colour does, under today's camera. The test view is Baltimore at a few
hundred metres (the Elevation layer in PET rainbow at 0–100 m is the thing
to beat). Navigation (walking, flying, collision) is milestone 2 and must not
be designed out.

## What Minecraft settled

Representation

1. The grid is anchored to the world, not the camera: one block is one unit,
   integer coordinates, forever. (Lego re-cuts its window as the camera
   moves, so a hill changes shape as you approach it.)
2. Blocks are cubes: height and width share a unit; elevation is countable.
3. The top block is a material (grass, stone, sand, snow, water), not a
   colour from a ramp. Elevation is carried by shape and light; colour is
   free to say what the ground is.
4. Lighting is the shape channel: fixed per-face shading (top brightest,
   north/south next, east/west darkest), sky light, and ambient occlusion
   at block edges ("smooth lighting", Beta 1.3).
5. Water is a flat surface at a known level; below the surface is filled,
   so "what occupies this point?" always has an answer.
6. Chunks stream around the player to a render distance with fog at the
   edge, and persist.
7. A flat Cartesian frame; locally a tangent plane is fine.

Navigation (milestone 2)

8. Embodied eye 1.62 m up, gravity, collision, walk 4.3 m/s, sprint 5.6,
   jump 1.25 m, swim; 70° FOV.
9. Three travel modes: walk, creative fly, spectator (no-clip). Spectator
   is GEV's camera today.
10. Yaw and pitch only, never roll; a crosshair and a block outline so you
    always know which block you are looking at.
11. F3: xyz, block, chunk, facing. The HUD camera readout is F3; its
    click-to-edit is `/tp`.
12. Wayfinding by noted coordinates, a compass, maps that fill in as you
    explore, a home point, day and night.

## Decisions (2026-10-27, with the user)

1. Built inside GEV as a layer, in Cesium. Clone ideas freely from
   Minecraft, Luanti/Mineclonia, Cubyz, Craft and Arnis; the constraint is a
   canonical real-world coordinate system at the core.
2. Block size = the selected elevation source's cell: 1 m where 3DEP lidar
   exists, 10 m on 3DEP 10 m, 30 m on FABDEM/GLO-30, 2 m ArcticDEM. The grid
   itself shows the data's precision, the same rule the HUD uses.
3. Milestone 1 material: one terrain material plus water at sea level, a
   pure test of geometry and light against the colour map. Real land cover
   (ESA WorldCover 10 m) as the top block is the next data layer; the
   material hook is in from the start.
4. Light: the real sun when it is above 15°, otherwise a fixed study sun;
   ambient occlusion always; the HUD says which sun is in effect.
5. Underground: filled columns. The camera does not pass under the surface
   (milestone 2 enforces it). Nothing may block a later block-break and
   block-stack capability: the store carries an edits overlay from day one.
6. World anchoring: persistent chunks on the world grid, streamed by
   distance with fog at the edge, replacing the per-window re-cut.
7. Navigation is milestone 2.
8. The UI name is **Blocks** (not Lego, not Minecraft).

## Architecture

### Region and grid (`src/layers/blocks/grid.js`)

A **region** is a local east-north-up tangent frame at an origin snapped to
a global graticule of the block size, with `blockM` fixed for the region
(decision 2). Columns are integer `(i, j)` east and north of the origin;
levels are integer `y` with `y = 0` the block whose base is mean sea level
(`level = floor(heightMslM / blockM)`). Chunks are `CHUNK_COLUMNS = 64`
columns a side (16 is Minecraft's; 64 keeps the primitive count sane at 1 m).

```js
createRegion({ lon0, lat0, blockM })
  → { lon0, lat0, blockM, toLocal(lon, lat) → {x, y} m,
      toLonLat(x, y), columnOf(x, y) → {i, j}, chunkOf(i, j) → {ci, cj},
      chunkBounds(ci, cj) → {west, south, east, north} degrees,
      chunkOrigin(ci, cj) → {x, y} m }
chunkKey(ci, cj) → 'ci:cj'
```

A region is good for a few tens of kilometres (tangent-plane error at 50 km
is 0.2 m, under a block). Beyond that a new region is anchored; milestone 1
uses one region around the camera and re-anchors when it leaves it.

### Store (`src/layers/blocks/store.js`)

A chunk is a column heightfield plus a sparse **edits overlay**:

```js
MATERIALS = { AIR: 0, TERRAIN: 1, WATER: 2 }   // land cover ids follow
NONE = -2147483648
createChunk({ ci, cj, top: Int32Array, material: Uint8Array,
              water: Int32Array })               // CHUNK_COLUMNS² each
chunk.occupancy(i, j, y) → material id
  // edits.get(key) ?? (y <= top ? material : y <= water ? WATER : AIR)
chunk.setBlock(i, j, y, material)              // writes the overlay
chunk.edits                                    // iterable of {i, j, y, material}
chunk.version                                  // bumps on every edit
chunk.topSolid(i, j)                           // top after edits
```

`occupancy` is the answer to "what occupies this point?" and the hook for
collision (milestone 2), picking, section cuts and future break/stack. Edits
are serialisable per chunk key; persistence is out of scope for now but
nothing may assume the overlay is empty.

### Mesh (`src/layers/blocks/mesh.js`, `lighting.js`)

Culled face meshing per chunk (a face is emitted where a solid block meets
air or water; water surfaces where water meets air), greedy merging of
same-material, same-shade faces on a row. Colour per vertex = material
colour × face shade × ambient occlusion × sun term, baked:

```js
FACE_SHADE = { up: 1.0, down: 0.5, north: 0.8, south: 0.8, east: 0.6, west: 0.6 }
AO = [1.0, 0.8, 0.6, 0.5]              // by occluding neighbours at a vertex
sunTerm(normal, sunDir) → 0.6 … 1.0    // never black on the shadow side
buildChunkMesh(chunk, { neighbours: {n, s, e, w}, blockM, sunDir })
  → { positions: Float32Array,       // ENU metres from the chunk origin
      normals: Float32Array,
      colors: Uint8Array,            // RGBA
      indices: Uint32Array,
      faces: number }
```

Pure functions, tested without Cesium. Water faces carry alpha.

### Source (`src/layers/blocks/source.js`)

Chunk heights come from the existing `GET /api/raster/values` for
`ee-elevation` (`src/data/rasterValues.js`; see "Raster values (for Lego
mode)" in PERSONAL-FORK.md): one request per chunk at `cells =
CHUNK_COLUMNS`, the chunk's bounds from the region. `blockM` for a region
is the stack's native cell in the window (the header's `cellSizeM` when the
request is made at the native size: 1, 2, 10 or 30 m). Heights are mean sea
level as the stack reports them; the region's ENU origin sits on the
ellipsoid, so the renderer adds the geoid undulation once per region
(`ellipsoidalToMslDisplayM`'s inverse). A column at or below 0 m is water
at level 0 (the sea); nodata is `NONE`. In-memory LRU of chunks by key; the
server's 30-day disk cache does the rest.

```js
createChunkSource({ fetchValues })
  → { regionFor(lon, lat, windowM) → Promise<{ blockM, source }>,
      loadChunk(region, ci, cj) → Promise<chunk> }
```

### Renderer (`src/layers/blocks/renderer.js`)

One `Cesium.Primitive` per chunk from the mesh's typed arrays, model
matrix `Transforms.eastNorthUpToFixedFrame(regionOrigin)` plus the chunk
origin, a custom appearance whose fragment shader applies distance fog
toward the sky colour (Cesium's own fog is the globe's). Depth is written
so `pickPosition` and the HUD's AGL/PX land on the blocks; the HUD's data
floor names the block size ("· Blocks 1 m"). Sun direction from the app's
sun position with the 15° rule; a fixed study sun otherwise.

```js
createBlocksRenderer({ viewer })
  → { setRegion(region), upsert(key, mesh), remove(key), setSun(dir, {fixed}),
      setFog({ startM, endM }), keys(), destroy() }
```

### Controller (`src/layers/blocks/index.js`)

Streaming on `camera.moveEnd` and a 500 ms tick while moving: the chunk set
within the render distance (`R = 512 blocks`: 512 m at 1 m, 15 km at 30 m)
ordered by distance, loaded, meshed and upserted under a per-tick budget;
chunks beyond `R × 1.25` removed. Milestone 1 is a single level of detail.
Wiring: `renderMode.js` gains `'blocks'`; the Analysis heading drop-down
reads Colour | Lego | Blocks; the share hash carries it (`bk`); the status
line under the heading says "Blocks: 1 m cubes · 412 chunks · 3DEP 1 m".
Blocks needs the Elevation layer on; otherwise the status line says so.

### Ownership

| Worker  | Modules                                                                    | Tests                                                      |
| ------- | -------------------------------------------------------------------------- | ---------------------------------------------------------- |
| worker1 | grid.js, store.js, mesh.js, lighting.js                                    | pure, node                                                 |
| worker2 | source.js, renderer.js, sun/fog                                            | node with a fake scene; a real Cesium Primitive smoke test |
| worker3 | index.js, renderMode, UI, hash, status, i18n, docs, the comparison harness | node + puppeteer screenshots                               |

The interfaces above are the contract; a worker who must change one says so
in their report and the manager propagates it.

## Milestones

1. **Representation** (this page): Blocks on blank + Elevation beats
   Colour at Baltimore. Deliverables: the modules above, a side-by-side
   screenshot pair from the puppeteer harness, the docs section.
2. **Navigation**: walk / fly / spectator with `occupancy` collision, eye
   1.62 m, screen-matched FOV, a crosshair with the looked-at block
   outlined, the HUD naming the mode.
3. **Materials**: land cover as the top block; water bodies from the
   elevation stack's water mask; buildings from OSM footprints (Arnis-style)
   as stacked blocks.
4. **Interaction**: break and stack through the edits overlay, persisted
   per region.
5. **Any scale**: the block follows the pixel footprint up a pyramid of
   aggregated levels, so a continent reads as blocks too (the section
   "Milestone 5" below).

## Status, end of 2026-10-27

Milestones 1–3 shipped on `local-fixes` the same day, in eighteen merges;
the "Blocks" section of PERSONAL-FORK.md describes what exists. Beyond the
page above:

- Chunks come in 4×4 groups (one raster-values request each) and a coarse
  ring of 4 m blocks out to 4 × the fine reach (one request per 4×4
  groups); fog ends at the far ring, sky-coloured under the atmosphere.
  Skirts close the fine/coarse seam both ways. A fresh 1 m view at
  Baltimore is about 41 raster-values and 4 Overpass requests (anchoring
  mid-supergroup, in progress, brings that to ~38 and ~2); the server's
  Earth Engine budget is 20,000 tiles a day. Nothing loads while the camera
  is above 4 × R2 blocks or in flight.
- Meshing runs in a Web Worker pool (3 workers); the renderer draws one
  opaque and one water primitive per group (500 draws → 48, frame CPU ~3×
  less), with block-edge lines and a per-block dither on tops.
- Buildings, parts with `min_height`, level roofs, and the top-block
  materials water / grass / forest / road come from one Overpass query per
  supergroup to the local clone; the Buildings switch sits beside Render
  (`bk=1.b0` off).
- Navigation: Move: Spectator | Walk | Fly beside Render; G / Shift+G
  "here" onto the targeted block; the lift back to Spectator; the F3-style
  BLOCK line; `nav=walk|fly` in the link. Verified live in Chrome on real
  3DEP 1 m data at Baltimore with 915 real buildings.
- Still open: milestone 4 (the edits overlay exists, nothing writes it from
  the UI); `roof:shape`; bridges at ground level; waterway lines (in
  progress); the sun's re-light costs a re-mesh of the ring every ~12 min of
  daylight.

## Navigation controls, evening of 2026-10-27

Asked for while the user was away: Minecraft-like controls that never
interfere with GEV's own. Shipped in seven merges (PERSONAL-FORK.md
"Navigation controls" has the tables):

- Minecraft's key map in Walk and Fly only: WASD/arrows, Space jump, Shift
  sneak (1.3 m/s, eye 0.3 m lower, never off an edge), W twice to sprint
  with the FOV widening, the wheel for fly speed, G / Shift+G here, T for
  first/third person, B / Shift+B set/go home. No Ctrl anywhere.
- A Controls card (gear beside Move): sensitivity, invert Y, FOV, speeds,
  sneak hold/toggle, bobbing, every action rebindable with refusals for the
  app's shortcuts, other actions' keys and the browser's own; Reset.
- A gamepad (Bedrock's layout) as an input source, with its own settings
  section; in Spectator it pans, orbits and zooms Cesium's camera and A
  walks here, and the mouse and keys are untouched.
- Third person (behind / in front, pulled in by blocks), a compass with the
  home bearing, home and up to 50 waypoints kept absolutely in
  localStorage, never in the link.
- Spectator keeps GEV's camera, collision, shortcuts and flights; links
  without `nav=` open there.

## Milestone 5: Blocks at any scale (2026-10-28, with the user)

The user asked for a continent in the style of Minecraft. The footprint
rule that governs the HUD governs this too: a block is never finer than
the data and never finer than about two screen pixels, so from orbit the
block has to be big. Today `blockM` is pinned to the source's native cell
and a ceiling (`ceilingM`, 4 × R2 × blockM) holds Blocks above it. This
milestone lets the block follow the footprint instead, so Blocks draws at
every altitude with about the same number of columns on screen, and the
ceiling becomes the top of a pyramid rather than a wall.

### Decisions

1. **The block size follows the pixel footprint.** `blockM` for a region
   is the smallest pyramid level ≥ max(native cell, FOOTPRINT_BLOCKS × PX),
   with `FOOTPRINT_BLOCKS = 2` and PX the HUD's pixel footprint at the view
   centre (`src/hud/cameraState.js`). The pyramid is the native cells
   (1, 2, 8, 10, 30 m) continued by ×4 from 30 m: 120, 480, 1,920, 7,680,
   30,720 m. A level changes with hysteresis (×2 either way) so a view
   near a boundary does not re-anchor on every move.
2. **The vertical step is decoupled from the horizontal cell.** A region
   gains `levelM` (metres per level) beside `blockM`. At native cells a
   block is a cube (`levelM = blockM`, no visible change). Above 30 m the
   rule is `levelM = max(30 m, blockM / 32)`: 120 m blocks on 30 m
   levels, 1,920 m on 60 m, 30,720 m on 960 m. Appalachia at 10 km cells
   is then tens of steps, not a fifth of one. The Relief ×n control
   (`renderMode.js` exaggeration, kept in the browser) multiplies the drawn height
   of every level, as Colour already does; the readouts keep the real
   metres.
3. **Coarse blocks are aggregates, served and cached.** A coarse cell is
   the mean of the source over the cell (Earth Engine's reduce at that
   scale through the existing `cells=` request), never a sample, so a
   30 km block over the Rockies is their mean height. The server's 30-day
   disk cache keeps every level; a fresh view costs 17 to 27 lattice tiles at any
   scale. A warm-up script (`npm run blocks:pyramid -- --bbox … --levels`)
   may precompute the coarse levels for a continent once; the 231 m
   ocean source is the pyramid's floor at sea.
4. **The two rings become N rings.** The fine disc plus one coarse ring is
   the K = 1 case; the controller keeps K rings, each 4 × the previous
   cell and reach, until the outermost ring's reach passes the horizon or
   the top level. R1 = 512 blocks stays.
5. **Beyond a few hundred kilometres the grid is curved.** One tangent
   plane is wrong at continental reach (the Earth falls 300 km under it at
   a 2,000 km radius). Levels of 1,920 m and up stand each column on the
   ellipsoid: the mesher keeps integer block space, the quad writer
   places vertices by lon/lat/height, and greedy runs are capped so a
   quad's chord error stays under a pixel. The 1 m to 480 m levels keep
   the flat frame (0.2 m error at 50 km).
6. **Top-down is a style, not geometry.** At pitch −90 only top faces
   show, so a "Blocks" visualisation mode of the Elevation layer, computed
   in Earth Engine (reproject to the level's cell, quantise to `levelM`,
   flat-shade each cell by the quantised hillshade, draw cell edges) gives
   the continental picture at the cost of the Elevation tiles alone. One
   map id per coarse level; the client shows the one whose cell matches
   the footprint. It is the cheap first deliverable and the fallback when
   geometry cannot build.

### Work and ownership

| Step | Owner                | What                                                                                                                                                                                                                                                                                                                                                                              |
| ---- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | worker1              | `levelM` through grid, store (`level = floor(h / levelM)`), mesh (`writeQuads` scales the slice axis by `levelM`, u/v by `blockM`), lighting, occupancy, the walker's step-up and jump (still metres), targeting, the BLOCK line. Tests. Default `levelM = blockM`.                                                                                                               |
| B    | worker2              | source: `regionFor` takes the wanted cell and returns the pyramid level; `loadGroup` at any level; the server's coarse elevation cells mean-aggregated (check `rasterValues.js` / `earthEngine.js`; if the EE path samples, reduce). Renderer: K rings of regions, fog from the outermost. Then step F.                                                                           |
| C    | worker3              | Controller: `blockM` from the footprint with hysteresis, `levelM` by the rule, Relief multiplies the drawn height, the ceiling replaced by the top level's, re-anchor on a level change, status line ("Blocks: 1.9 km cells · 60 m levels · relief ×3 · FABDEM 30 m"), HUD data floor, docs. Harness: Baltimore at 300 m, 5 km, 50 km, 500 km and 3,000 km, Blocks beside Colour. |
| D    | worker1 + worker2    | The curved frame (decision 5): grid gives per-column lon/lat; the quad writer places vertices on the ellipsoid above 480 m; renderer model matrix per chunk. After the first screenshots from C.                                                                                                                                                                                  |
| F    | worker2 then worker3 | The Earth Engine "Blocks" mode of the Elevation layer (decision 6): server mode and map ids per level; the client swaps by footprint; the panel's Render drop-down shows it as the top-down fallback.                                                                                                                                                                             |

Order: A, B and the server half of F are independent and start at once;
C integrates as A and B land (the manager merges in that order and tells
worker3); D after C's screenshots say which views need it. Budget: the
20,000 tile day is unchanged; one fresh view at any level is 17 to 27 lattice tiles as measured (3 × 3 fine + 3 × 3 coarse by design, up to 4 × 4 where the 1 m disc straddles tile edges).
Success: Baltimore to the Appalachians to the continent in one descent
without leaving Blocks, every level reading as a block map, and the
3,000 km view beside Colour judged by the user.

## Out of scope now

The 1 m lidar download for a local terrain mesh (separate approval), the
Google tiles as a block source (Voxel Earth-style), exporting to a Minecraft
or Luanti world (Arnis exists for that; a side experiment at most).

## Status, 2026-10-29

Milestone 5 shipped on `local-fixes` (cd1bdd6d, pushed, 9,188 tests). The
"Blocks at any scale" section of PERSONAL-FORK.md describes what exists.
Against the decisions:

1. **Footprint.** The block is the smallest pyramid level at least the
   native cell and 2 × the HUD's PX at the view's centre, asked of the
   source as `regionFor(lon, lat, windowM, { wantedM })`. A level changes
   only ×2 past it either way, and only once the camera has been still for
   2 s. The status line and the HUD name the cell ("1.9 km cells · 60 m
   levels").
2. **Level height.** `levelM` is a cube up to 30 m, else max(30 m, blockM /
   32), through grid, store, mesh, lighting and the walker. Relief ×N draws
   the levels and the region's base as Cesium draws the globe; the readouts
   keep true metres.
3. **Aggregates.** A coarse cell is the mean of the valid heights over it,
   water at level 0 where under half is land or the mean is at or below
   0 m. It is served on a global lattice of 512 cells a side, with a 120 s
   timeout and retries, and cached for 30 days. `npm run blocks:pyramid`
   warms a box.
4. **N rings.** Past the fine disc and its coarse ring, each further ring
   is the next level at least 4 × the cell before, R1 blocks of it, until
   one passes the horizon (the ground distance, × 1.25). At continental
   levels the fine ring is capped at the horizon too. They are drawn
   through `renderer.setRegions`, with the fog from the outermost ring.
5. **Curved grid.** From 1,920 m cells every column stands on the
   ellipsoid, and the edges and dither come from the per-vertex block
   coordinate.
6. **Top-down style.** The Elevation layer's `blocks-<cellM>` mode drapes
   at 8 px a cell, from two zooms under each level's own to 14. It drapes
   over blocks coarser than 30 m and where Blocks cannot build, and the
   HUD's floor names it ("Blocks style 31 km") until blocks draw.

The record: Baltimore, real data from the app server at cd1bdd6d, the Blocks
shot of each pair (its Colour twin beside it). The ring time runs from the
Elevation layer coming on until the status line settles.

| View         | Level                    | Chunks (fine + coarse) | Values requests | Overpass | Ring time |
| ------------ | ------------------------ | ---------------------- | --------------- | -------- | --------- |
| 300 m −45    | 1 m cubes                | 320 + 668              | 57              | 3        | 30.5 s    |
| 300 m −90    | 1 m cubes                | 320 + 668              | 57              | 3        | 29.0 s    |
| 5 km −45     | 8 m cubes                | 320 + 456              | 51              | 20       | 28.3 s    |
| 5 km −90     | 8 m cubes                | 320 + 456              | 51              | 20       | 29.3 s    |
| 50 km −45    | 120 m cells, 30 m levels | 320 + 436              | 44              | 0        | 32.3 s    |
| 50 km −90    | 120 m cells, 30 m levels | 320 + 436              | 44              | 0        | 33.0 s    |
| 500 km −45   | 1.9 km cells, 60 m       | 304 + 129              | 24              | 0        | 23.1 s    |
| 500 km −90   | 1.9 km cells, 60 m       | 304 + 129              | 26 (2 failed)   | 0        | 24.0 s    |
| 3,000 km −45 | 7.7 km cells, 240 m      | 336 + 23               | 21              | 0        | 63.3 s    |
| 3,000 km −90 | 7.7 km cells, 240 m      | 336 + 29               | 21              | 0        | 16.3 s    |

Every values request was answered 200, apart from two at 500 km −90 that
failed at the connection. The coarse column counts the coarse ring and the
rings past it. The 300 m view drew 1,497 buildings, the 5 km view 9,935.

**The cost of a fresh view**:

- 21 to 57 values requests: the probe plus the lattice tiles of the fine
  disc, its coarse ring and the rings past it. Each is one Earth Engine
  tile against the 20,000-tile day, and a view seen before costs nothing.
- Overpass: 3 queries at 1 m, 20 at 8 m (land cover), none above 30 m
  blocks (`STRUCTURES_MAX_BLOCK_M`).
- From 50 km up, the style drape: 65 to 156 Earth Engine tiles at the
  shot, where the Colour twin took 32 to 282.

**Known not done:**

- Nothing walks on cells of 1,920 m and up. Walk and Fly read the flat
  frame, and the curved regions are not one.
- The rings stop at the horizon, at most R1 blocks each. There are no
  skirts between rings: where two meet, the outer ring overlaps the inner
  ring's edge or leaves a gap of up to half a chunk, in the fog.
- The style drapes only within each level's zoom band (two zooms under its
  own to 14). The server answers coarser tiles blank, so a view whose
  tiles fall below the band shows no drape for that level.
- 5 km −45: east of a north-south line through the camera, the 8 m ground
  and its coarse ring came back flat, one level with the buildings
  standing on it (already there in the 2026-10-28 run). It was the 480 m
  ring drawn over the 8 m disc: the ring filter kept a chunk by its centre.
  Fixed in 30cbcefe by farthestDistance and renderer.setRingHoles.
- 3,000 km −90: the −74.04° gap is gone, but thin streaks remain along the
  coast (New Jersey, Long Island) and in the water near it.
- 3,000 km −45 took 63 s to settle, the slowest view.
- 5,465 km −90 on a 1600 × 900 window (31 km cells): North America drew
  streaked and out of place. The controller anchored a region half a
  supergroup south and west of the camera in degrees, which grows with the
  block: 3,932 km a leg at 7,680 m, and 15,728 km (141°) at 30,720 m,
  which put the anchor past the South Pole (lat0 −99.8°, about 80° S in
  Antarctica) with the camera's ground 13,500 km from it, past a
  hemisphere, where the curved grid's azimuthal mapping is distorted.
  Fixed by `anchorFor` (index.js): the curved levels (1,920 m and up)
  anchor at the camera's ground point, since without buildings there and
  with the values on the global lattice the supergroup alignment helps
  nothing; the flat levels keep the shift, south along the meridian and
  west along the camera's parallel in metres (the camera mid-supergroup in
  the region's own metres), capped so the anchor is never more than
  1,000 km from the ground point, and never past a pole or the
  antimeridian. The blue square over Lake Superior in the same view
  (about 47.7° N 86.9° W) is GMTED2010 storing a rectangle of the lake as
  0 m, its sea value; a lake-water mask (JRC Global Surface Water) waits
  on the user.
- Lakes above the fine levels (option A, approved 2026-10-29): the
  Elevation values ask `water=1` at every level over 30 m
  (`source.js asksWater`; 30 m and under keep their requests and caches,
  their water is OSM's), and the answer adds a water plane: MODIS
  MOD44W's land-water mask for 2015 (250 m, 0 land, 1 water), the mean
  over each cell (the share of it that is water), from the same
  computePixels call as the heights (another band in the NPY, no extra
  tile counted). The first source, JRC Global Surface Water's occurrence
  ≥ 50 %, failed live: occurrence is masked wherever water never was, so
  a coarse pyramid pixel is the mean of its water pixels alone, and at
  30 km cells 584 of 3,840 cells over the US interior read as at least
  half water (the 5,000 km view speckled blue from the Plains to the
  Lakes). MOD44W is valid over land, so its pyramid averages the dry
  pixels too. Its share is read from at most 4 × 4 samples a cell
  (`WATER_MAX_PIXELS`): at the heights' 256 a fresh 1,920 m tile took
  102 s against 40 s without the plane, and the harness's views stopped
  at "24 loading" (ring tiles still on their way at 3 minutes). A plane
  Earth Engine refuses is answered with the heights alone, not kept, so
  Blocks still draws.
- Cold coarse views (2026-10-30): a fresh lattice tile took 16 to 111 s,
  and a 512-cell tile at 1,920 m twice passed the server's 120 s (a 503,
  then the same heavy request again). Measured through an env-gated knob
  (GEV_VALUES_EXPERIMENTS=1: `&maxPixels`, `&scale`, never cached): fewer
  samples a cell (64, 16) is 4–20 × faster but moves the means by metres
  (Kansas 1,920 m: 64 samples p99 2.4 m, 16 samples mean 2 m), so not
  taken. Two changes taken: the mean declares the read band's own cell
  (FABDEM 30 m, GMTED 231 m), not the stack's finest (3DEP's 1 m had a
  120 m cell over the US read FABDEM at 7.5 m: 18–20 s a fresh tile, 4 s
  after, means within 0.05 m on average); and the lattice tiles at 480
  and 1,920 m are 256 cells a side (`latticeCells`), 6 to 12 s fresh
  against 55 to 111 s, four times the tiles there. The source's tile cache
  counts a 256-cell tile as a quarter (`latticeWeight`).

  Fresh tiles, plain, one at a time (512 cells unless said; "band" scale):

  | Level                  | 256 samples a cell (as before) | 64     | 16     | 256 cells a side |
  | ---------------------- | ------------------------------ | ------ | ------ | ---------------- |
  | 120 m over 3DEP (Ohio) | 18.1 s (stack scale), 4.0 s    |        |        |                  |
  | 480 m (Iowa)           | 110.7 s                        |        |        | 6.4 s            |
  | 1,920 m (Sahara)       | 96.4 s; another > 2 × 120 s    | 18.8 s | 14.1 s | 12.3 s           |
  | 7,680 m (Australia)    | 37.4 s                         | 8.9 s  | 2.0 s  | 7.2 s            |

  Means against the reading before, over the same lattice tile (max, mean,
  p99 of |difference|; cells over 1 m):

  | Tile              | Change     | Max    | Mean    | p99    | > 1 m                  |
  | ----------------- | ---------- | ------ | ------- | ------ | ---------------------- |
  | Baltimore 120 m   | band scale | 11.4 m | 0.035 m | 0.24 m | 116 of 202k (81 coast) |
  | Kansas 1,920 m    | band scale | 2.2 m  | 0.046 m | 0.35 m | 101 of 206k            |
  | Kansas 1,920 m    | 64 samples | 11.2 m | 0.34 m  | 2.4 m  | 11,259                 |
  | Kansas 1,920 m    | 16 samples | 74.2 m | 2.08 m  | 14.0 m | 123,292                |
  | Australia 7,680 m | 64 samples | 97.3 m | 0.12 m  | 1.4 m  | 3,904                  |

  The "coast" cells flip between the sea (0 m) and land at the half-land
  threshold. Cache: the band scale makes every coarse tile over 3DEP and
  every 7,680 and 30,720 m tile a new version (the base band's tiles
  outside 3DEP and the Arctic keep theirs), and the 256-cell lattice gives
  every 480 and 1,920 m tile a new key; a warm-up comes after both. The
  plane rides on `raster-values/1` after the values, named in the
  header's `planes`, so a reader that does not ask never gets it and one
  that gets it but knows only the values reads them as before; the
  plane's requests hash to another cache version. The rule
  (`columnsFromHeights`): at or below 0 m the sea as before; above 0 m a
  column at least `LAKE_SHARE` (0.5) water is a lake, water at
  floor(h / levelM) over a bed one level below; nodata stays NONE. A
  group's coarse column takes the mean of its fine shares. The Blocks
  style (`blocksStyleExpression`) colours a cell at least half water as
  water at its own level, so the drape and the columns agree.

- After a search flew the camera from the opening view (15,000 km over
  30° N 40° W) to Europe or the United States at 30,720 m, 8 to 67 chunks
  stayed "loading" for minutes and the view never settled, though every
  values request was answered. Two causes in the controller (index.js):
  the 30,720 m region never re-anchored (`reanchorRadiusM` was 2 × R1
  blocks, 31,457 km: past half the planet), and a chunk held but no longer
  in the ring (the camera moved on, or the ring shrank with the horizon)
  was neither meshed nor dropped while its group stayed within 1.25 × R1,
  so it counted as loading for ever and the tick stopped. Now a held chunk
  no longer wanted, not drawn and not on its way is dropped each tick
  (`dropUnwanted`: fine, coarse without data, rings), and a curved region
  (1,920 m and up, anchored at the ground point) re-anchors past
  `CURVED_REANCHOR_M`, 2,000 km, where its azimuthal mapping stretches
  1.7 % (1,920 m keeps 1,966 km; the flat levels are unchanged).

**The harness** (`scripts/qa-blocks-compare.mjs`, the PNGs beside
`report.json`, with each shot's status lines and values requests in order):

```sh
node scripts/qa-blocks-compare.mjs --build --out <dir outside the repository> --altitudes 300,5000,50000,500000,3000000
node scripts/qa-blocks-compare.mjs --build --out <dir> --live http://localhost:4173 --altitudes 300,5000,50000,500000,3000000
node scripts/qa-blocks-compare.mjs --dist <an existing build> --out <dir> --live http://localhost:4173 --altitudes 500000
```

This record's frames are `.claude/blocks-compare/final-scale-*.png` in the
main checkout, with `final-scale-report.json`.

### Refresh across location changes (QA, 2026-10-29)

One live pass in one page, Blocks and Elevation on (`bk=1`, `lo=f.e.1`,
`map=blank-black`, `hv=1`, `hud=tactical`). Each step goes through the app's
location search (`qa-blocks-compare.mjs --sequence --live`). "First blocks"
runs from the flight's end to the first chunk drawn, 2 s of it the anchor's
deliberate wait. "Settled" runs to the last chunk upsert, with nothing loading
after it for 2 s. The Earth Engine budget went from 3,449 to 3,607 tiles.

| Step                   | Where the search put the camera  | Blocks at settle           | First blocks | Settled | Upserts | Values / drape tiles / Overpass | EE tiles | Long tasks (total, max) | fps  | Heap max |
| ---------------------- | -------------------------------- | -------------------------- | ------------ | ------- | ------- | ------------------------------- | -------- | ----------------------- | ---- | -------- |
| Europe                 | 51° N 10° E at 136 m, AGL −260 m | 30 m cubes                 | 4.3 s        | 57.9 s  | 1,731   | 34 / 50 / 21                    | 52       | 53 (6.5 s, 468 ms)      | 48.5 | 732 MB   |
| United States          | 28.6° N 180° at 13,180 km        | 31 km cells                | 3.4 s        | 6.5 s   | 160     | 2 / 76 / 0                      | 2        | 6 (1.0 s, 229 ms)       | 47.7 | 702 MB   |
| Lake Tahoe, California | at 136 m, AGL −1,785 m           | 1 m cubes                  | 5.1 s        | 49.2 s  | 1,113   | 53 / 67 / 4                     | 55       | 33 (4.8 s, 404 ms)      | 49.9 | 762 MB   |
| Baltimore, Maryland    | 47 km                            | 120 m cells, 30 m levels   | 2.0 s        | 15.6 s  | 772     | 35 / 112 / 0                    | 5        | 37 (4.5 s, 501 ms)      | 35.0 | 1,071 MB |
| a Baltimore street     | 320 m                            | 1 m cubes, 1,513 buildings | 0.5 s        | 35.5 s  | 1,211   | 62 / 28 / 4                     | 30       | 30 (4.3 s, 561 ms)      | 46.0 | 1,025 MB |

Every step changed level once and anchored once, with no hysteresis thrash.
The HUD's readouts matched the camera at every settle.

Findings, by what a user would notice:

1. "Europe" and "Lake Tahoe" leave the screen black: the camera is
   underground. The geocoder types both as `point_of_interest`, so
   `geocodeNavigationMode` frames them at street range (`searchAndFlyTo`'s
   point branch, `src/locations.js`). With the globe hidden by Blocks, neither
   the arrival guard (`src/cameraGroundGuard.js`) nor the search's ground
   floor finds a surface to lift it to. Blocks then builds the unseen ground
   (107 of the pass's Earth Engine tiles). Fixed in two parts:
   - A result typed only `point_of_interest` / `establishment` is framed by
     its viewport's size (`viewportNavigationMode`): a region over 1,000 km
     across, an area over 2 km. "Europe" now frames the continent from
     9,425 km, and "Lake Tahoe" frames the lake from 70 km.
   - The arrival guard takes a ground fallback, asked once when nothing
     rendered answers under a hidden globe. `src/app/blocks.js` gives it one
     point values probe.
   - Google's own answers differ from the harness's. The harness builds
     without a Google key (it lives in `.env`, which the worktree does not
     have), so its searches fell through to the server's `/api/geocode`. The
     app's Google geocoder answers "Europe" as `continent`, `establishment`,
     `natural_feature`, which flew a capped swath over the Baltic. A
     `continent`, or any viewport over 4,000 km, is now a region framed
     whole. The Rocky Mountains, at about 2,700 km, stay a swath.
2. "United States" framed the mid-Pacific. Its viewport runs from −180 to
   180, which `viewportMetrics` read as 0° wide at 180°. Fixed: a full wrap
   reads 360° wide, and `placeFramingViewport` frames a box wider than half
   the globe about its geocoded location (the lower 48). Google's own box for the
   United States is 107° wide (173.3° W to 66.3° W, with Alaska and
   Hawaii), and its fit landed off Oregon. Boxes wider than 100° are now
   framed about their location too.
3. Near the ground, settling takes 35 to 58 s, with 30 to 53 main-thread long
   tasks a step (up to 0.56 s) and 35 fps at 120 m blocks under the drape.
   Open: performance work for the user to decide.
4. The JS heap reached 1.07 GB and did not come back down below 700 MB.
   Open: performance work.
5. A quick cached view kept the previous level: the ticker stopped before
   the 2 s settle's level check. It showed in `--build`, not live. Fixed in
   `tick()`, with a test.
6. Values requests per fresh view ran 34 to 62 with the rings, and the drape
   took 28 to 112 tiles a step. Open: performance work.
7. `setRingHoles` was called on every tick. Fixed: now only on change.

### Land cover cut off along the chunk grid (QA, 2026-10-29)

At a Baltimore street with Buildings off, the roads and a park's greens
covered some chunks and stopped at hard chunk edges. The OSM land cover
(roads, greens, water) is painted with `setSurface` into the very chunk
objects `source.js` keeps and hands out again. The Buildings switch both
stopped the structures pass and cleared only the buildings, so every chunk
painted while Buildings was on kept its paint, and chunks first loaded with
it off stayed bare. Traced live: unchecked, 262 of 320 fine chunks were
still painted 34 s later. Overpass answered every query, and the structures
pass reached every fine chunk.

Since this fix the land cover is independent of Buildings: it paints on
every fine chunk from its first load, switch on or off. The switch governs
the buildings alone, raised or dropped in place from each chunk's kept
answer, with no new query. Bridge decks are roads and stay. Paint comes off
only where land cover cannot be drawn: Overpass missing, or blocks coarser
than 30 m (`clearSurfaces` in `store.js`).

#### Performance pass (findings 3, 4 and 6, 2026-10-29)

Measured with `qa-blocks-compare.mjs --sequence --live --no-minify` (a CPU
profile, the heap after a forced collection and its live sites, what the
controller and renderer hold, each values request's cell), the same five
steps before and after, each run alone.

| Step               | Settled                     | Long tasks (count, total) | Values requests | Drape tiles | Heap after GC |
| ------------------ | --------------------------- | ------------------------- | --------------- | ----------- | ------------- |
| Europe             | 6.5 → 5.2 s                 | 6, 1.4 s → 3, 0.8 s       | 1 → 2           | 156 → 100   | 39 → 35 MB    |
| United States      | 11.1 → 5.1 s                | 21, 2.5 s → 4, 1.1 s      | 30 → 1          | 245 → 119   | 42 → 39 MB    |
| Lake Tahoe         | not settled (241 s) → 109 s | 260, 46.8 s → 183, 46.7 s | 43 → 42         | 140 → 114   | 46 → 44 MB    |
| Baltimore          | 22.6 → 15.2 s               | 59, 10.2 s → 26, 3.9 s    | 35 → 34         | 112 → 112   | 47 → 46 MB    |
| a Baltimore street | 23.3 → 20.5 s               | 57, 8.9 s → 38, 5.7 s     | 62 → 51         | 28 → 23     | 57 → 55 MB    |

The before run's United States search fell back to a camera flight. The
after run's reused the region already anchored from Europe, so it asked one
values request. That row is not a like-for-like comparison.

What each finding turned out to be:

- **4, the heap: churn, not a leak.** After a forced collection the retained
  JS heap stays at 35 to 57 MB across the five steps. The previous
  location's chunks are released, and the live sites are Cesium's shader
  cache and the current chunks. The 1 to 2 GB peaks are geometry garbage
  awaiting collection. Typed-array backing stores live outside the JS heap,
  so these numbers do not measure them.
- **3, the long tasks: Cesium's synchronous geometry pipeline**, plus depth
  picks. At Lake Tahoe the main thread spent:
  - `combineInstances`: 11.8 s;
  - `createTypedArray`: 7.1 s;
  - `cloneAttribute`: 5.2 s;
  - `BoundingSphere.fromVertices`: about 5 s, the renderer's own on every
    geometry;
  - `readPixels`: 6 s, the footprint's depth pick, asked two or three times
    a tick.

  Fixed here:
  - each chunk's bounding sphere is computed once, when it arrives;
  - the footprint is reused for a second while the camera is still;
  - a batch is rebuilt after 3 s of quiet, not 1.5 s.

  Each chunk passed through Cesium about 2.65 times: once alone, then about
  1.65 times in batch rebuilds (2.3 rebuilds a batch). At Lake Tahoe it was
  more than three, since the batches under the view's centre rebuild after
  250 ms of quiet.

  The options are:
  - (1) a longer quiet before a rebuild;
  - (2) skipping the lone draw while a batch streams;
  - (3) taking the geometry off the main thread.

  (3) is chosen, as its own branch, and (1) is its interim, in this branch.

- **6, the requests: the rings, and a drape hidden under drawn blocks.**
  - A fresh view asked the probe, the fine disc's lattice tiles (up to 4 × 4
    with whole groups), the coarse ring's supergroups, and 4 to 16 tiles a
    ring. The plan's 18 predated the rings.
  - Each ring now asks at most its nearest 3 × 3 tiles, counted by the
    chunk's group, as the source loads them.
  - At coarse levels the rings reach the horizon, so the drape is now
    shown only while blocks build and where Blocks cannot build.
- **Caveat: the harness overstates tile counts.** Request interception
  disables Puppeteer's browser cache, so its tile counts overstate the
  app's; a tile seen before costs no Earth Engine budget either way (the
  server's disk cache).
- **Follow-up, not in this branch:** the app's layout every frame,
  `querySelectorAll`, `getBoundingClientRect`, `layoutRightPanelRail` and
  the widget's resize check, cost 2 to 4 s of main thread a step.

## Milestone 6: a precomputed block tileset (2026-10-29, with the user)

The user's goal: moving the camera in Blocks should be as fast and as
reliable as in the default Google 3D Tiles mode. Today it is not. Google's
tiles are a precomputed level-of-detail tree streamed from a CDN: Cesium
picks the tiles for the view, draws the coarse ones first and refines in
place as finer ones arrive, and nothing is computed per view. Blocks builds
its world per view: heights reduced in Earth Engine on first request,
buildings and land cover queried from Overpass per group, meshes built in
the browser on the main thread, the level re-anchored and rebuilt on change.
The refresh QA above measured 35 to 58 s to settle near the ground, and the
user's own view (a Baltimore street at 297 m, Buildings off) showed the
land-cover paint landing on some chunks and not their neighbours. Storage is
not what stops a tree of our own: a quantised block world compresses far
better than photoreal meshes.

| Coverage                           | Cells      | Raw 16-bit | Meshed, rough |
| ---------------------------------- | ---------- | ---------- | ------------- |
| Lower 48 at 30 m                   | 9 × 10⁹    | 18 GB      | 3 to 8 GB     |
| A city at 1 m (Baltimore, 240 km²) | 2.4 × 10⁸  | 0.5 GB     | ~100 MB       |
| The planet at 30 m                 | 5.7 × 10¹¹ | 1.1 TB     | 100 to 200 GB |
| The planet at 1 m                  | 5 × 10¹⁴   |            | no such data  |

### Decisions

1. **Build once, stream like Google.** A build script takes a bounding box
   and a finest level, pyramids a local DEM into the block levels (the same
   pyramid as milestone 5: native, then ×4 from 30 m), quantises each level
   to its `levelM`, bakes the sea and the lakes (milestone 5's water rules),
   paints land cover and roads and raises buildings from the local Overpass
   clone, greedy-meshes every tile and writes a 3D Tiles 1.1 tileset
   (glTF tiles, implicit quadtree) under the gev cache. Minecraft itself
   generates a chunk once and stores it in a region file.
2. **The client adds it as a Cesium tileset.** Cesium's own traversal then
   gives the coarse-first, refine-in-place behaviour, with no re-anchor on
   a level change. The Blocks look (flat lit faces, edges, dither, relief)
   moves into a `CustomShader` on the tileset, fed by the per-vertex block
   coordinate the mesher already writes. Relief ×N scales the tileset's
   model matrix or the shader's height, never a rebuild.
3. **The live controller becomes the fallback**, outside the built boxes and
   at levels the build did not reach, and it keeps the walker: Walk and Fly
   need the column store for footing and targeting, so under the walker the
   fine disc is still sourced live (or decoded from the tiles, a later
   step). The HUD names the source ("Blocks tiles 2026-10 · lower 48").
4. **Where it lives.** The served tileset on D: (`D:\gev-cache\blocks-tiles`,
   small random reads, beside the server's other caches; 22 GB free with
   the Overpass guard at 12 GB), its inputs and a copy on E: (the spinning
   external, single-stream writes only). A country at 30 m plus a few
   cities at 1 m fits D: today; a planet at 30 m does not, and is the point
   where a new SSD stops being optional.
5. **Inputs, with the user's yes before any download.** Heights: Copernicus
   GLO-30 (30 m, public, about 10 GB as cloud-optimised GeoTIFFs for the
   lower 48) rather than Earth Engine, whose 20,000-tile day would take
   months for a country; USGS 3DEP 1 m for Baltimore (about 0.5 GB; the
   earlier lidar download was never approved and this one needs its own
   yes). Water: the milestone 5 rules on the same DEM, plus the lake mask.
   Buildings, land cover, roads: the local Overpass clone, now a snapshot;
   the tileset is dated by its inputs and rebuilt when the user chooses.
6. **Scope of the first build.** The lower 48 at 30 m and above, Baltimore
   at 1 m, roughly a weekend of compute on this PC, run as a resumable job
   (tiles are written atomically, a rerun skips what exists) and never with
   more than the default Node heap. Success: Baltimore to the continent and
   back without a visible rebuild, the first picture within a second of a
   flight's end, and the street view's roads and greens whole.

### Work and ownership

| Step | Owner                       | What                                                                                                                                                                                          |
| ---- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A    | worker1, after blocks-paint | `scripts/blocks-tileset.mjs`: DEM ingest and pyramid, quantise, water, greedy mesh per tile to glTF, implicit tileset JSON; a tiny box first (one Baltimore chunk at 30 m) with golden tests. |
| B    | worker1                     | Structures in the build: buildings, land cover and roads from the Overpass clone through the existing structures rules, per tile.                                                             |
| C    | worker3, after blocks-perf  | Client: `Cesium3DTileset` under the Blocks render mode, the CustomShader look, relief, the HUD source line, the live controller as fallback outside the built boxes and under the walker.     |
| D    | manager, with the user      | The downloads (decision 5), the lower-48 build on E: → D:, the comparison with Google's mode on the five-step sequence.                                                                       |

Order: A before C's tileset work (C needs real tiles); B and C in
parallel once A's tiny box builds. The live pipeline's fixes in flight
(the lake mask, the drape and ring budgets, the paint bug) land first; they
are the fallback's quality and the build's rules.

### Step A, the first cut (2026-10-29)

`npm run blocks:tileset -- --bbox <w,s,e,n> --levels <finest m> --out <dir>`
(`scripts/blocks-tileset.mjs`; `--coarsest`, `--base`, `--dry-run`). Heights
and water only; structures are step B.

- **Inputs.** The live source itself (`source.js` `createChunkSource`) reads
  every level: the lattice tiles, `columnsFromHeights`, the sea at 0 m, the
  water plane's lakes above 30 m. Its height reader is anything that answers
  the values request (`{layer, mode, box, cells, water}` → `{header, values,
water}`). Today that is the app server's `GET /api/raster/values` (read-only,
  its 30-day cache). A local DEM reader slots in by answering the same request
  once decision 5's downloads are approved.
- **Levels.** The ×4 flat chain only: 30, 120 and 480 m, each on `levelMFor`
  levels (30 m for all three). Curved levels (1,920 m and up) and the native
  steps under 30 m (1, 2, 8, 10 m do not nest by 4) are later cuts. By
  default the build runs from the finest level up to the first level whose
  one group holds the box.
- **One frame.** Every level shares one anchor: the box's south-west corner
  on the coarsest level's graticule. A group of one level (4 × 4 chunks, 256
  columns) is then exactly one chunk of the next level up.
- **The tree is explicit.** A tile's 16 children are the finer groups under
  its 16 chunks. A child the box does not reach is that chunk of the parent
  level alone (a fill tile, a leaf), so a REPLACE refinement never leaves a
  hole. Sixteen children is not a quadtree. Implicit tiling would need a
  content-free depth between every two levels and availability bitstreams;
  at this size (17 tiles, a 9 KB tileset.json) that costs more than it
  saves. A country build splits the tree into external tilesets per coarse
  tile instead. The depth is the pyramid level, coarsest at 0.
  `geometricError` is the tile's block size (0 at the leaves); the tileset's
  is eight times the coarsest block.
- **Tile frame and glTF.** The root's transform is the anchor's east-north-up
  frame on the ellipsoid. Each tile's transform moves it to its south-west
  corner. Positions are y up as glTF has them (east, up, −north; Cesium's
  `Y_UP_TO_Z_UP` turns them back). Heights are mean sea level, each vertex
  dropped onto the ellipsoid's curve under the tangent plane. The client
  raises the tileset by the geoid's undulation, as the live datum offset does.
  Since step B the GLB is the shared Blocks encoder's (`src/layers/blocks/gltf.js`,
  worker3's): the same bytes the live renderer draws, for the same shader.
  Layout v2 (2026-10-30), 28 bytes a vertex where v1 took 36:
  - `POSITION` (float, kept: 16 bits over a 123 km tile would step 1.9 m);
  - `NORMAL` (BYTE, `KHR_mesh_quantization`) on a 4-byte stride, its fourth
    byte `_FEATURE_ID_0` (UNSIGNED_BYTE): one row a chunk in an
    `EXT_structural_metadata` table (`ci`, `cj`, `blockM`);
  - `COLOR_0` (normalised bytes, the mesher's study-sun colour; alpha for water);
  - `_BLOCKCOORD` (SHORT on an 8-byte stride: the block point in half blocks,
    the chunk's columns folded modulo 4,096; the shader reads it × 0.5).

  The opaque primitives come first, then the water's (`alphaMode: BLEND`),
  all `KHR_materials_unlit`. Indices are always 16-bit: a kind past 65,535
  vertices is split into several primitives by its triangles, each with
  its own vertices. Then `EXT_meshopt_compression` (below). On the curved
  levels the tiles' greedy runs are capped for a 4 px cell (the tileset's
  `maximumScreenSpaceError`), √2 longer than the live 8 px rule.

- **Seams.** Inside a tile, chunks mesh against their neighbours. Along a
  tile's border, they hang skirts (`mesh.js` `skirt`) down to the lowest ground
  any built level has there, so a tile beside a finer or coarser one shows no
  gap.
- **Writes.** Each file is written atomically (a temporary name, then a
  rename). Since step B a rerun skips what exists unchanged (below).

The tiny box, a 30 m group over Baltimore's harbour (sea, land, and the 120 m
level's reservoirs as its only lakes), was built from the server's cache.
Results:

| Build                                                 | Tiles | Size  | Vertices | Largest tile             |
| ----------------------------------------------------- | ----- | ----- | -------- | ------------------------ |
| `--levels 30` (120 m root, one 30 m group, 15 fill)   | 17    | 13 MB | 288 k    | 6.3 MB (the 120 m group) |
| `--levels 120` (480 m root, one 120 m group, 15 fill) | 17    | 33 MB | 712 k    | 14 MB (the 480 m group)  |

The 30 m group over the flat harbour is 1.3 MB.

Coarse tiles are the heavy ones: 30 m levels terrace 123 km of rolling ground
into many steps. Headroom for later:

- 16-bit indices per chunk primitive;
- quantised normals and block coordinates (`KHR_mesh_quantization`);
- `EXT_meshopt_compression`, measured below.

**`EXT_meshopt_compression`, measured once (2026-10-29).** Each stream of
today's float layout went through meshoptimizer's codecs (the package
Cesium decodes with), as built and after `reorderMesh` (gltfpack's vertex
cache and fetch order). The decode is the best of three in Node's WASM
decoder, which Cesium also runs, on this PC.

| Tile                      | Vertices | GLB     | gzip   | meshopt | meshopt + gzip | Decode |
| ------------------------- | -------- | ------- | ------ | ------- | -------------- | ------ |
| 480 m root (123 km)       | 300 k    | 14.1 MB | 2.9 MB | 2.8 MB  | 1.5 MB         | 18 ms  |
| 120 m group               | 132 k    | 6.2 MB  | 1.2 MB | 1.3 MB  | 0.7 MB         | 5 ms   |
| 30 m group with buildings | 143 k    | 6.6 MB  | 1.3 MB | 1.3 MB  | 0.8 MB         | 4 ms   |

Reordered meshopt plus the transport's gzip makes a tile about nine times
smaller, and its decode is a few milliseconds, under one frame. gzip alone
gets about five times, so serving the tiles compressed is the first step and
costs nothing. The shared encoder's BYTE normals and 16-bit indices shrink
the raw tile before either.

Applied since step B (with the manager's yes; `meshoptimizer` 1.0.1 is a
pinned devDependency, the version Cesium's own engine depends on). Every
tile the build writes is compressed (`compressGlb`):

- each primitive's vertices are reordered as its triangles use them;
- the vertex attributes are encoded as ATTRIBUTES and the indices as
  TRIANGLES into the GLB's buffer;
- the uncompressed layout stays as a fallback buffer with no data, so the
  extension is required.

The app's own Cesium decodes it with no addition: a test runs Cesium's
`GltfLoader` and buffer view loader on a tile and gets the encoder's
triangles back exactly, and the frames below are meshopt tiles drawn in the
app.

Cesium calls the decoder without waiting for its WASM, which instantiates
when Cesium loads. In a page that is long done before a tile arrives; a
Node test has to wait for it.

The tiny box with the shared encoder and meshopt:

| Tile                        | Float layout (step A/B) | Shared encoder + meshopt |
| --------------------------- | ----------------------- | ------------------------ |
| 480 m root (`--levels 120`) | 14.1 MB                 | 2.9 MB                   |
| 120 m group                 | 6.2 MB                  | 1.3 MB                   |
| 30 m group with buildings   | 6.6 MB                  | 1.3 MB                   |
| 30 m group, ground only     | 4.1 MB                  | 0.8 MB                   |
| Box at 30 m, all 18 tiles   | 22.2 MB                 | 4.8 MB                   |
| Box at 120 m, all 17 tiles  | 33 MB                   | 7.0 MB                   |

That is about 4.7 times smaller on disk, before the transport's gzip.

**Levels under 30 m: the options (for when the 1 m download is approved).**
The native steps 1, 2, 8 and 10 m do not nest by four, and this tree needs
each level to be four times the one under it.

1. _A ×4 chain down from 30 m: 7.5 m, then 1.875 m._ Each level is resampled
   from 3DEP 1 m (the mean over each cell, as the server's coarse levels do
   now), with `levelM` equal to the block size: cubes.
   - It is the same tree, the same fill leaves and the same skirts, so
     nothing new is needed in the build or in step C.
   - The blocks are no longer the live mode's sizes: 1.875 m against 1 or
     2 m, 7.5 m against 8 or 10 m. The live controller's pyramid would move
     to match, or the tiles and the fallback would differ in size where they
     meet.
   - It needs the DEM resampled once per level (cheap beside the meshing),
     plus a buildings rule at 1.875 m (heights round to whole blocks, as
     today).
   - Storage: about 16× the 7.5 m level for the 1.875 m one. For Baltimore's
     240 km² that is roughly 68 M columns, a few GB meshed.
2. _Native trees joined by skirts._ The 10 m and 1 m levels each get their
   own tree with its own anchor graticule, under a parent level that does
   not divide them evenly. The parent's tile is replaced by the finer tree's
   tiles that overlap it, and the seams between them are covered by skirts.
   - The blocks keep the live mode's sizes, and nothing is resampled.
   - But a child tile no longer lies inside one parent chunk. A refined
     parent then either leaves slivers uncovered or overlaps its children,
     which shows as z-fighting under REPLACE. Fixing that needs clipping
     (per-tile clipping polygons in step C) or ADD refinement with the
     parent's covered part cut out.
   - It is more code in the build and in the client, for a mismatch the user
     would see only at the seams.

_Recommendation:_ the ×4 chain (option 1). It keeps the tree regular,
reuses everything built, and the block sizes it changes (1 → 1.875 m, 8 or
10 → 7.5 m) are a choice the live pyramid can follow. Decide with the 1 m
download.

### Step B, structures in the build (2026-10-29)

- **What and where.** At the levels the live controller applies them
  (`STRUCTURES_MAX_BLOCK_M`, 30 m and finer; nothing above), every built
  group is read through the live source (`structures.js`
  `createStructuresSource`, `applyStructures`). That covers the land cover
  (roads, greens, OSM water), the bridge decks and the buildings.
  - The queries go through the app server's `/api/overpass` (the local
    clone), one at a time and 700 ms apart, as the live Blocks paces them.
    There is one query per group at 30 m; above 2 m blocks a group is not
    cut from a supergroup's query, so this matches live.
  - The source's cached chunks are never painted: each variant works on its
    own copies.
- **Two tilesets over one tree, as the Buildings switch has them.**
  - `tileset.json` draws the fine levels with their buildings.
  - `tileset-ground.json` draws them without (index.js `withoutBuildings`:
    the land cover and the decks are kept).
  - The coarse tiles are one file shared by both; the fine tiles have their
    own (`30m/g0_0.glb`, `30m/g0_0.ground.glb`).
  - The client (step C) shows one or the other, so land cover never depends
    on the switch.
- **Streamed structures (2026-10-30).** A streamed build (more than 64
  finest groups) applies the structures too, group by group: each tile at
  30 m and finer reads its group's Overpass answer when it is built (one
  query a group, the same pacing), and makes both variants from it, so
  every tile's variants are built together. Coarser levels share one file.
  A test shows a streamed build with structures writes the very tiles a
  held one does. `--hold` keeps a box past the threshold in memory.
- **Resume.** `build-state.json` beside the tiles holds each tile's inputs'
  digest, its bounding box and its counts. The digest covers:
  - the mesher fingerprint (since 2026-10-30, replacing a hash of the code's
    text): two synthetic fill tiles of one chunk carrying every input class
    (sea, a lake, stepped land, nodata, a road, a park, a building, a deck;
    flat at 30 m and curved at 1,920 m, with skirts and shaded corners),
    meshed and encoded exactly as real tiles and hashed. A refactor that
    keeps the bytes keeps every tile; any change to what a tile holds
    rebuilds them all;
  - the build's own output settings, by value: the level's lattice side,
    `--land-only`, the split depth, the meshopt settings;
  - the tile and its skirt floors;
  - every column of its chunks: the heightfield, surfaces and structures.

  A tile written with an unchanged digest is kept and not meshed again. The
  state is written after every tile, so an interrupted build loses at most
  one tile. The inputs are still read on a rerun, so a heights or an OSM
  change rebuilds exactly the tiles it touches.

- **The tiny box** (Baltimore's harbour, 30 m). It takes one Overpass query
  a run (1 to 6 s); the heights come from the server's cache.
  - Before meshopt, the 30 m group was 6.9 MB with buildings (143 k
    vertices) and 4.3 MB ground only, against 1.3 MB bare: buildings' walls
    and land-cover boundaries break the greedy merges. With the shared
    encoder and meshopt it is 1.36 MB and 0.83 MB (the table above).
  - Frames of the tiles in the app's own Cesium, beside live Blocks at
    30 m from the same camera (the harness, read-only against the app
    server), are in `.claude/blocks-compare/tileset/`. The buildings,
    roads, parks and water match column for column. The look differs (the
    tiles carry only the baked colours; edges and dither are step C's
    shader), and past the box the 120 m fill tiles stand without land
    cover.

### Curved levels and the country tree (2026-10-30)

- **Curved builds.** A build whose coarsest level is 1,920 m or more is
  curved (`plan.curved`).
  - Its anchor is the coarsest level's graticule point at the box's middle,
    not its south-west corner. The azimuthal map is truest there: for the
    lower 48 the map stretches about 3 % across the bearing at the corners,
    2,700 km out.
  - Every level, 480 m included, uses that one curved map (`createRegion`
    takes `curved`, and `mesh.js` asks for it), so a 480 m group is exactly
    one 1,920 m chunk.
  - Each chunk is meshed by the live mesher's curved placement: every column
    corner is stood on the ellipsoid at its level, and greedy runs are
    capped by `curvedRunCap`.
  - Each tile has its own east-north-up frame at the middle of its ground.
    The vertices move from the anchor's frame into it, so they stay small
    and its box stays tight. A tile's transform is its parent's frame
    inverted, times its own.
  - Several root groups (four around a middle anchor) hang under a root with
    no content and a bounding sphere.
- **Coarse levels drawn a step lower (`coarseDropM`).** A column's top block
  stands on [L·step, (L+1)·step] with L = floor(h / step), so it can stand
  up to a step above its ground.
  - At 30,720 m the step is 960 m: a street at 50 m stood as a block 960 m
    tall. Until the finer tiles were in, a camera at 300 m was inside it
    and saw sky (worker3's page-load trace, a Baltimore street).
  - At the levels whose step is coarser than 30 m (1,920 m and up), the
    build draws the whole level one step lower. That covers land, water,
    lake beds and skirts. A top is then floor(h / step) × step, at or below
    its ground, and the sea's surface is at 0 m.
  - Skirt floors work in drawn metres, so a finer tile's skirt reaches a
    lowered coarse neighbour.
  - Only the drawing moves. The columns, the summaries, `--land-only`'s sea
    test and the live mesher are as they were (a 60 m step where a live
    1,920 m ring meets a tile edge is nothing at that scale). The mesher
    fingerprint is unchanged; a dropped tile's digest carries the drop.
  - The small boxes (the metro, the two harbours) are built with
    `--coarsest 1920`, at most 60 m over the ground. The big trees take the
    drop on their next rebuild.
- **The chord bound, tested.** Over a synthetic curved box at 1,920 m, no
  top face runs more than `curvedRunCap` (57) cells, and the middle of every
  straight edge sags at most 235 m under its level (a pixel of an 8 px cell
  is 240 m). The cap bounds runs, not faces: a face capped both ways sags
  417 m at its middle, about 1.7 px. Capping runs at the cap divided by √2
  would bound the faces too, at about twice the quads on curved levels.
  That is the live mesher's rule as well, so it is left as it is pending a
  decision.
- **External tilesets.** Every `--split-depth` levels below the root (2 by
  default), a subtree goes into its own JSON, `subtrees/<level>m/g<gi>_<gj>.json`.
  - Its root has no transform: it is in the referencing tile's frame.
  - Its paths are written from its folder (`../../`).
  - The main tileset holds the top levels and the references, and Cesium
    loads a subtree when its traversal reaches it. A test resolves the paths
    with Cesium's own loader.
- **Streamed builds.** A finest level with more than 64 groups (or
  `--stream`) is never held whole.
  - A first pass reads every chunk once and keeps only its lowest tops,
    along each edge and over the whole chunk (`chunkSummary`).
  - Then each tile's chunks are read again when it is built (the server's
    cache answers), meshed, written and let go.
  - Skirt floors come from the summaries. They equal the column-scan floors
    where a level's chunk edges lie on the border, and are deeper (never
    shallower) where a coarser level's chunks straddle it.
  - Memory is a few hundred chunks, whatever the box. Every line also goes
    to `build.log`, and the run reports Earth Engine's day before and after.

### The lower 48 at 480 m, and 120 m measured (2026-10-30)

- **Built:** `-125,24,-66,50` at 480 m and up (curved, streamed), into
  `D:\gev-cache\blocks-tiles\lower48-480\`. It is 1,508 tiles and 4.5 GB, with
  82 external tilesets and a 170 KB tileset.json. It took 18 minutes, every
  read a hit in the server's cache.
  - The 480 m level holds 4.06 GB of it: a 2.4 MB median tile, and up to
    22 MB in the Rockies, where 30 m levels terrace the relief.
  - Frames of the tiles beside live Blocks from a continental camera and over
    the Front Range are in `.claude/blocks-compare/tileset/lower48-*`.
- **For the client (step C):** Cesium's `dynamicScreenSpaceError` (on by
  default) subtracts a fog term of up to 24 px from far tiles' error. From
  5,000 km that drives the root's error negative, and the tileset never
  refines past its coarsest level. Set it off on the Blocks tileset. A
  `maximumScreenSpaceError` of 4 matches the live mode's block size at both
  cameras (7,680 m continental, 1,920 m from 500 km).
- **120 m, measured** (one 480 m group of the lower-48 plan, 16 groups at
  120 m, over each area):

  | Sample      | Size at 120 m | A group               | Its 480 m tile | Ratio | Meshing |
  | ----------- | ------------- | --------------------- | -------------- | ----- | ------- |
  | Front Range | 63.8 MB       | 4.0 MB (largest 8.6)  | 8.4 MB         | 7.6×  | 13 s    |
  | Kansas      | 14.7 MB       | 0.92 MB (largest 1.7) | 2.2 MB         | 6.8×  | 3.5 s   |

  The 120 m size follows its 480 m tile closely, so the lower 48 at 120 m
  (16,427 groups, 5,333 lattice tiles at 512 cells) is estimated from the
  480 m build, each tile's ratio interpolated by its density:
  - the 120 m level is **28 to 33 GB**, about 30 GB;
  - with the levels above it, the tree is **33 to 38 GB**. That would not
    fit D:, so it goes to E: or is trimmed (the user's call).
  - Uniform densities would bound it at 15 GB (all plains) to 66 GB (all
    mountains); 70 % of the 480 m bytes are in 296 rugged groups.

  Time: about 0.19 s of meshing a MB, so roughly 1.6 h, plus two cached read
  passes (about 35 minutes): **2 to 2.5 hours once the cache is warm**.
  Warming the 5,333 lattice tiles first takes about 4 to 5 hours at the
  warm-up's 2.9 s a tile, and 5,333 of Earth Engine's 20,000-tile day.

### Where the trees live (2026-10-30)

A tree over a few GB lives on E: under `E:\gev-data\blocks-tiles\<name>\`,
written there by the build (`--out E:/gev-data/blocks-tiles/<name>`). The
build writes each file once, in turn, so the spinning external's
single-stream rule holds. It is joined into the served root by a directory
junction, `mklink /J D:\gev-cache\blocks-tiles\<name> E:\gev-data\blocks-tiles\<name>`,
so the server's tiles route finds every tree under one root. A junction is
removed with `rmdir` on the link, never a recursive delete, which would
follow it into E:.

| Tree                           | Where                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| `baltimore-harbour-30`, `-120` | D: (small; `--coarsest 1920`, 65 and 50 MB, rebuilt 2026-10-30)                            |
| `baltimore-metro-30`           | E:, junctioned in (`--coarsest 1920`, both variants, 376 MiB, rebuilt 2026-10-30)          |
| `lower48-480`                  | E:, junctioned in (3.3 GB in layout v2 without fans, rebuilt 2026-10-30; was 4.5 GB on D:) |
| `europe-480`                   | E:, junctioned in (2.6 GB in layout v2 without fans; was 3.4 GB)                           |
| `lower48-120`                  | E:, junctioned in (`--land-only`, 18,820 tiles, 26.5 GiB, 2 h 47 min, built 2026-10-30)    |

### Step C, the client on the tiles (2026-10-30)

The precomputed tiles draw where a built box covers the view
(`src/app/blocksTiles.js`, a `Cesium3DTileset` with the live chunks' shader;
the controller's plan in `src/layers/blocks/tiles.js`). The live controller
is the fallback outside the boxes, below a box's finest level and under the
walker; the two never draw the same ground.

- **Modes.** 'tiles': the view's cell is at or over the box's floor, the
  tiles alone (no live region, no ceiling). 'hybrid': the live chunks draw
  the levels finer than the floor about the camera; the tiles the rest,
  outside a hole. 'off': no box, live as before.
- **The hole.** It opens only as far as the live chunks are drawn
  (`drawnReachM`): closed until every chunk of the fine disc is drawn, then
  the fine disc's reach, the coarse ring's and each ring's as it comes in,
  so the tiles are the picture until the live chunks replace them. The
  shader cuts the circle; an octagon of clipping planes inscribed in it
  culls the tiles wholly inside before they load (a shader-only hole left
  Cesium refining the tiles under the camera, the nearest and heaviest, to
  discard them). A camera under a tile's top before the live hole opens
  (at the street the 120 m tiles draw until the 1 m disc is in) opens a hole
  of two floor blocks about itself the frame it is found.
- **Refinement.** 4 px for a box finer than 480 m; 8 px for a coarse tree
  (finest 480 m or more) below 1,500 km, 4 px over 2,000 km (hysteresis
  between). Cesium's own cache (512 MB, 512 MB over). A cache guard steps
  the error floor 1.25× each time the cache frees after an overflow, so a
  view that overflows settles instead of swinging; it lets go when the camera
  moves or stops. `dynamicScreenSpaceError` off.
- **Sockets.** Cesium asks the page's own server at most 4 requests at once
  (`TILES_REQUESTS_PER_SERVER`). Its scheduler allows 18 a server, sized for
  HTTP/2; the page's server speaks HTTP/1.1, where the browser opens six
  sockets a host, shared by the tiles, the Earth Engine imagery and the
  app's own fetches. With the tiles holding all six, the live region's
  values probe waited 10 to 20 s before it was sent (Lake Tahoe,
  2026-10-30). Two stay free. A tree with more tiles a view (the 120 m
  tree) leans on this harder: keep the cap, or serve the tiles over HTTP/2
  or from a second origin, before raising it.
- **Programs.** Cesium links a Model's shader programs the first frame it
  draws, and checks each link at once (`getProgramParameter`), so the main
  thread waits for the GPU process to compile it: 1.1 s at Lake Tahoe,
  2026-10-30, while the live chunks loaded. The link itself is free; the
  wait is the cost. Three things keep links out of flights:
  - **No style drape under the tiles.** In 'hybrid' the tiles draw the
    whole frame (every screen sample is in the box), so the Elevation
    layer's Blocks style is not draped while the live region builds:
    showing the globe for it linked the globe's surface programs (8 at
    Lake Tahoe) and asked the style's tiles.
  - **The same clipping planes on every Blocks Model.** Cesium compiles a
    Model's programs with its clipping planes' count and state as defines,
    so the tiles' planes switching on when the live hole opened linked a
    new set mid-flight. Every Blocks Model, live and tile, now carries
    eight planes (`blocksClippingPlanes`, `CLIPPING_SIDES`), always on,
    parked where they clip nothing (`parkedPlanes`: facing up, 10⁷ km out)
    until the tiles' hole moves them. Cesium still gives a tile the
    tileset's planes only where they cut it, so in 'hybrid' the tiles use
    a set with planes and one without: eight programs in all (opaque,
    translucent and two depth variants, each way), the fewest the look
    allows.
  - **A pre-warm at the first Blocks status** (`prewarmPrograms`): three
    Models a millimetre across (a live batch's feature table with the
    parked planes, a tile's with them and without; `prewarmBlocksGlb`)
    drawn ahead of the eye, half the camera's height out (10 m to 100 km)
    and following it each frame, far under a pixel, and removed two frames
    after they are ready. Under the ground the globe occluded them and
    Cesium culled the draw; placed once, a shared link's flight carried the
    camera away before they were ready; either way nothing was linked. The
    harness's --prewarm-check holds them and reads the scene back at the
    canvas's centre: 1 and 3 of 4,096 pixels change by more than two levels
    (at 300 m and 5,000 km, for the frames they stand), no quad.
    Lake Tahoe now links none (26 before); the app's start 19 (37). The city
    still links three or four programs whose text matches one linked at the
    start (some other input of Cesium's shader cache differs): about 0.1 s,
    left.
- **Look.** The live chunks and the tiles mesh alike: faces at 120 m and up
  are two triangles split by their corners' shading (`FAN_BELOW_M`), live
  480 m regions are curved as the tiles' 480 m level is
  (`LIVE_CURVED_BLOCK_M`), the glTF layout v2 (28 bytes a vertex) for both.
  Fog runs to the eye's horizon; the geoid raises the tiles as the live
  datum does. HUD: "Blocks tiles 2026-10 · lower 48 · 480 m".

Measured (five steps against adfe59ff, worker1's v2 trees, 2026-10-30): the
two tile-only steps draw at 0 ms and settle at once (64 tiles loaded at the
continental views, 37 to 54 MB); heap peaks a third of before (2,074 MB to
682 MB at Lake Tahoe); long tasks down on every step; no rebuild on a level
change; the Lake Tahoe thrash (the same 16 tiles fetched 7 times, 92 to 100
unloads) gone at 8 px, 2 unloads, no request repeated after the flight.

**Open items.**

1. **The first picture where the tiles refine.** The tiles loaded during a
   flight draw at its end (49 at Lake Tahoe, 36 at the street), but the
   harness counts 0 ms only when every tile the view wants is in, else the
   first new tile after the flight: 2.3 to 7.3 s at Lake Tahoe. Either the
   harness counts the tiles drawn at the flight's end as the first picture,
   or the refinement is made faster (fewer requests churned while the hole
   widens: 168 requests for 53 tiles in one run).

   **Done without a change of its own (2026-10-30).** The socket cap and the
   region set at the flight's end (item 2) took both: at Lake Tahoe the
   harness's first picture is 137 ms, and the step asks 93 tile requests
   for 63 tiles, none asked again after the flight (the 7 asked twice are
   Cesium's own cancellations while the camera flies).

2. **Late live anchoring, the next performance target.** The live region is
   set 3 to 15 s after a flight: the controller waits for the camera to be
   still after moveEnd (moveEnd itself is unreliable), then asks the source
   for the region (`regionFor`) on a server loaded by the builds. Until then
   a hybrid view shows the tiles alone, and a street view the 120 m tiles.

   **Done (personal/blocks-anchor, 2026-10-30).** Measured first: after
   each flight Cesium's moveEnd came about 0.5 s later and the app's 2 s
   settle wait followed (2.2 to 2.5 s on every step), and at Lake Tahoe the
   region's values probe was not even sent for 10.8 s (18 s in another
   run): the tiles held all six of the browser's sockets to the page's
   HTTP/1.1 server, Cesium allowing itself 18. Now a flight's end is the
   camera settled (`flightEnded`, checked after each render; a camera moved
   by hand and a page opening on a shared link still wait), Cesium asks the
   page's server at most 4 at once (`TILES_REQUESTS_PER_SERVER`) and the
   probe goes at the browser's high priority. The region is set 0 to 0.5 s
   after the flight's end and its first chunk drawn within 1.4 s (Lake
   Tahoe 22.5 s before, the city 3.3 s, the street 4.0 s); the harness's
   first picture is under a second on every step. A probe asked ahead at
   the flight's target would save at most its own round trip (0.3 to
   0.5 s): not done.

### Walk and Fly on the tiles (scoping, 2026-10-30)

Decision 3 keeps the walker on live chunks: Walk and Fly read the column
store (`src/navigation/worlds.js` `createBlockWorld`: `surfaceBelow`,
`blocked`, `waterAt` and the ray walk for targeting), which only the live
controller fills. Standing on the tiles directly would need that store, or
its answers, from a tile. Three ways, with what each costs:

1. **Cesium's own picking on the tiles** (`enableCollision`, then
   `Cesium3DTileset.getHeight` and `pick` against the loaded tiles' CPU
   geometry). Footing from `getHeight` under the feet; targeting from a pick
   (its feature row names the chunk, its position snapped to a block by the
   tile's level and the region's map, curved or flat). Cost: Cesium keeps
   every loaded tile's geometry on the CPU as well (Lake Tahoe's 886 MB of
   tiles would roughly double in memory); a pick per query, and `blocked`
   (walls ahead) needs several a step; nothing knows water from land
   without reading the water primitive. A day's work, a large memory bill.
2. **Decoding the tile under the walker into the column store.** The GLB is
   in the browser's cache: decode it in a worker (`readBlocksGlb`, layout
   v2), take each column's top from its top faces' half-block points and
   its water from the water primitive, and fill 64 × 64 chunks as the live
   source does; `createBlockWorld` then works unchanged. Cost: 100 to 300 ms
   a 13 to 17 MB tile in a worker, 2 to 3 days (the decode, the curved
   placement's inverse for the column grid, the buildings variant's
   structures, tests), and a second reader to keep in step with the build's
   format. It stands on the floor's blocks: 30 m in a city box, 120 m to
   480 m elsewhere, coarser than anything one walks on.
3. **A small live disc under the walker, as now.** Walking means being at
   the ground, where the view wants blocks finer than any box's floor, so
   the plan is 'hybrid' and the live fine disc is already drawn around the
   camera; since the flight's end anchors the region (0 to 0.5 s) it is
   there almost at once. Cost: none beyond what is built; the walker
   stands on exactly the blocks drawn at its scale. The gap is entering Walk
   high over a tile-only view: the live region anchors as the camera comes
   down, and until then the surface frame (the globe's height) carries the
   walker, as it does today.

**Recommendation: 3.** It costs nothing, matches what is drawn, and the
tile levels the other two would stand on are too coarse to walk on. Revisit
2 only if a box's floor reaches walking scale (1 to 2 m city tiles), where a
decoded tile would save the live values requests under the walker.

### Warming the values cache for the builds (2026-10-29 and 30)

The coarse trees (480 m and up over the lower 48 and Europe, 120 m over the
lower 48) read their heights through 4173's `/api/raster/values` cache, so
the cache was warmed first with `scripts/blocks-pyramid.mjs --server`
(GET only, concurrency 2, between merges so 4173 did not restart under it).
The union boxes and the 120 m list are worker1's: the tiles each build
actually reads, overhang included. Spend is the day's Earth Engine counter
before and after, so it includes retries.

| Run     | Box and levels                                  | Asked | Fetched (cached) | Failed           | Wall    | Spend |
| ------- | ----------------------------------------------- | ----- | ---------------- | ---------------- | ------- | ----- |
| 1       | Lower 48 (−125, 24, −66, 50), 30,720 to 480 m   | 155   | 105 (39)         | 11, then stopped | 400 s   | 147   |
| 1b      | the same, again                                 | 1,422 | 1,276 (146)      | 0                | 3,685 s | 1,276 |
| 2       | worker1's lower-48 union boxes, 30,720 to 480 m | 1,714 | 276 (1,438)      | 0                | 724 s   | 282   |
| 3       | Europe (−11, 35, 32, 71), 30,720 to 480 m       | 1,427 | 1,420 (5)        | 2                | 4,369 s | 1,722 |
| 4       | worker1's Europe union boxes, 30,720 to 480 m   | 1,827 | 380 (1,447)      | 1, and a burst   | 1,013 s | 386   |
| 5       | worker1's lower-48 120 m list, part 1 of 2      | 1,989 | 1,947 (38)       | 4                | 5,827 s | 2,519 |
| 6       | the same list, part 2 of 2                      | 1,989 | 1,969 (16)       | 4                | 5,895 s | 1,987 |
| retry   | the 8 tiles runs 5 and 6 missed                 | 8     | 8                | 0                | 44 s    | 8     |
| recheck | run 4's 480 m box                               | 1,610 | 0 (1,610)        | 0                | 8 s     | 0     |

- **Failures.** Every failure apart from the two bursts below was a lone
  Earth Engine 503 ("memory capacity exceeded", once "please try again")
  on a single tile, never two in a row; the next run over the same box, or
  the retry pass, answered each. No 429s.
- **Bursts.** Run 1 stopped on its failure window when the dev server
  restarted itself on a server merge mid-run: from then on server changes
  were merged only in announced gaps between runs. Run 4's first 7,680 m
  pass met 20 "fetch failed" in a row while 4173 was healthy and cached the
  tiles anyway (the connection dropped, not Earth Engine); the script now
  retries a dropped connection once after a second and logs the cause, and
  the rerun answered all 24.
- **The day.** 8,653 of the 20,000 tiles by the end (325 before run 1).
  Every tile on worker1's lists is cached: the recheck of the largest box
  answered 1,610 of 1,610 from the cache in 8 s.

### The record, and where it stands (2026-10-30)

One measured pass of the five steps and a page load at a Baltimore street,
on the morning's baseline (039deebb: live chunks only, the Primitive
renderer, no tiles) and on the day's final client (local-fixes 11044111:
the Model renderer, the tiles, the box switch) with the trees served at
15:00 UTC, back to back (`scripts/qa-blocks-compare.mjs --sequence`, then
`--altitudes 297 --pitches -10,-45 --load-frames --frame-eval scripts/qa-blocks-timeline.js`).
Quiet but for worker2's Europe 120 m values warm-up, which the harness
recorded beside every run; the baseline's steps also waited for a full unit
suite to end first. One run each: a record, not a verdict on any one
number.

The steps. First picture and settled are ms after the flight's end; long
tasks are their count and total ms; links are the shader programs linked
during the step and the ms the main thread waited on them; heap peaks are
the JS heap and the buffers (MB); requests are the values requests and the
tile requests during the step.

| Step               | Build    | First picture | Settled | Long tasks  | Links / waiting | Heap peaks (JS / buffers) | Values | Tiles | Box and mode                   |
| ------------------ | -------- | ------------- | ------- | ----------- | --------------- | ------------------------- | ------ | ----- | ------------------------------ |
| Continent          | baseline | 1,092         | 5,178   | 2 / 567     | 41 / 6,589      | 48 / 201                  | 1      | 0     | live, 30,720 m                 |
|                    | final    | 0             | 0       | 0 / 0       | 19 / 2,362      | 52 / 124                  | 0      | 68    | tiles, `europe-480`            |
| Country            | baseline | 519           | 5,513   | 1 / 447     | 3 / 20          | 49 / 205                  | 1      | 0     | live, 30,720 m                 |
|                    | final    | 0             | 0       | 0 / 0       | 0 / 0           | 51 / 93                   | 0      | 64    | tiles, `lower48-120`           |
| Lake Tahoe         | baseline | 517           | 27,470  | 80 / 10,866 | 14 / 1,370      | 60 / 2,162                | 42     | 0     | live, 30,720 → 120 m           |
|                    | final    | 157           | 22,096  | 7 / 446     | 0 / 0           | 91 / 333                  | 0      | 149   | tiles, `lower48-120`           |
| The city           | baseline | 1,923         | 15,786  | 32 / 4,847  | 9 / 386         | 70 / 1,515                | 34     | 0     | live, 120 m                    |
|                    | final    | 164           | 3,363   | 0 / 0       | 4 / 98          | 104 / 223                 | 0      | 218   | tiles, `baltimore-harbour-30`  |
| A Baltimore street | baseline | 551           | 18,095  | 26 / 4,389  | 4 / 228         | 131 / 959                 | 51     | 0     | live, 120 → 1 m                |
|                    | final    | 446           | 11,415  | 10 / 2,034  | 0 / 0           | 199 / 415                 | 31     | 34    | hybrid, `baltimore-harbour-30` |

- The continent's 19 links in the final build are the app's start (Cesium's
  own and the pre-warm's), not the tiles.
- Lake Tahoe settles late in both: the final's 22 s is the 120 m tree
  refining (886 MB of tiles, 73 unloads under the cache guard), with seven
  long tasks where the baseline had eighty.
- The city's 4 links (98 ms) are the programs left open in step C (their
  text matches one linked at the start).

The page load at the street (ms from the page's navigation, from
`scripts/qa-blocks-timeline.js`):

| Pitch | Build    | Splash gone | Tiles drawn           | Box switch                                            | Cover gaps       | Values | Tiles | Live region ready |
| ----- | -------- | ----------- | --------------------- | ----------------------------------------------------- | ---------------- | ------ | ----- | ----------------- |
| −10°  | baseline | 9,472       | none (no tiles)       | —                                                     | —                | 55     | 0     | after 20 s        |
|       | final    | 7,297       | 4,478 (`lower48-120`) | `baltimore-harbour-30` asked at 6,363, drawn at 7,767 | 200 ms, at 7,767 | 33     | 180   | by 20 s           |
| −45°  | baseline | 6,939       | none (no tiles)       | —                                                     | —                | 55     | 0     | after 20 s        |
|       | final    | 7,094       | 2,376 (`lower48-120`) | `baltimore-harbour-30` asked at 5,861, drawn at 7,915 | none             | 33     | 180   | by 20 s           |

- In the final build the ground is drawn under the splash: the lower 48's
  120 m tree from 2.4 to 4.5 s, the harbour box once it covers the view.
- The one gap: 200 ms just after the switch at −10°. The switch checks
  the new box's cover only in the frame it swaps; in the frames after, some
  tile in view was not in yet. A switch that waits for a few covering
  frames would close it.
- The baseline has no tiles: its far ground is the live coarse rings (606
  coarse chunks against the final's 208), ready after 20 s.

**Where it stands.**

- **Tiles only.** Wherever a built box covers the whole view at or above
  its floor: the continent and the country views (`europe-480`,
  `lower48-480`, `lower48-120`), Lake Tahoe (`lower48-120`) and the city
  view (`baltimore-harbour-30`, `baltimore-metro-30`, from 30 m). No live
  region and no values requests; the first picture is the tiles already
  loaded.
- **Hybrid.** Under a box's floor: at a Baltimore street the live chunks
  draw the 1 m disc and its rings out to the hole (2,048 m once they are
  in), the harbour box's tiles everything past it.
- **Live only.** Outside every box (anywhere but the lower 48, Europe and
  the Baltimore boxes), and the levels under 30 m everywhere: the live
  controller as before milestone 6.

**Open items.**

1. **The big trees' rebuild with the drop.** `lower48-480`, `lower48-120`
   and `europe-480` still stand their coarse levels on their heights
   (960 m steps at 30,720 m), so a camera low over a held lower-48 tile
   can stand inside a block. Worker1's build-only drop (ae760936: from
   1,920 m up the tiles are drawn one level lower) goes into those trees
   at their next rebuilds; the three Baltimore boxes were rebuilt with
   `--coarsest 1920` instead.
2. **The 1 m city levels.** A box finer than 30 m waits on the lidar and
   DEM download, which needs its own yes.
3. **Walk and Fly on the tiles.** Deferred: the walker stands on the live
   disc under it (the scoping section's recommendation 3).
4. **The city's 4 links.** About 0.1 s; programs whose text matches one
   linked at the start. Left.
5. **The switch's one-frame cover.** The 200 ms gap above.

**Known costs.**

- **The values warm-up's pace by latitude** (worker2, Europe 120 m, run 8,
  concurrency 2): about 3 s a tile to 57° N (1,200 tiles an hour; the lower
  48 at 120 m ran 2.9 to 3.0 s throughout, 24 to 50° N), 13.4 s a tile from
  57 to 60° N and 16.7 s from 60 to 64° N (215 to 270 an hour). There were
  no failures and 4173 answered in 5 ms, so Earth Engine itself is slower
  there (the water plane over lakes, fjords and coasts is the guess). Plan
  a northern box at 15 to 19 s a tile.
- **The day's budget.** 11,979 of the 20,000 Earth Engine tiles by 15:06
  UTC, about 12,500 expected when the warm-up ends. The spend tracks the
  tiles fetched almost one for one (retries add 0 to 30 %), so a warm-up
  spends at its pace: about 1,200 an hour in the south, 215 to 270 north of
  57° N.
