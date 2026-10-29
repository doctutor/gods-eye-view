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
  their water is OSM's), and the answer adds a water plane: JRC Global
  Surface Water 1.4's occurrence ≥ 50 % as 0 or 1, the mean over each
  cell (the share of it that is water), from the same computePixels call
  as the heights (another band in the NPY, no extra tile counted). The
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
