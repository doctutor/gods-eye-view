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
