# Colour scales: the Earth Engine layers

Personal fork. The shared colour-scale model (`src/maps/colourScale.js`:
palette, floor and ceiling, log, linear or sqrt, invert, outside clamp or
hide; its panel widget `src/ui/colourScaleWidget.js`) applies to every
raster layer. This page is the Earth Engine side:
each layer's default scale, as the provider draws it today, and how a scale
the user chooses reaches the map Earth Engine makes
(`server/providers/earthEngine.js`).

## Defaults per layer and mode

Values are in the layer's own units: the floor and ceiling a user sets are
in these units, whatever the provider's internal space. "Native" is the
transform the provider applies before visualizing (`log10` in `imageNode`,
`sqrt` in the DEM stack), so its `vis` min/max are in that space; the
"default floor / ceiling" columns convert them back. Palettes are the
records' hex stops, low to high (`src/data/earthEngineLayers.js`).

| Layer id               | Mode           | Units                        | Native | Default floor | Default ceiling | `vis` min–max | Palette (low → high)                                           | Notes                                                            |
| ---------------------- | -------------- | ---------------------------- | ------ | ------------- | --------------- | ------------- | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `ee-elevation`         | —              | m above sea level            | sqrt   | 0             | 6,400           | 0–80          | 2b6a2e 5f9a3c a9c15f e8dc8a d2a564 a66a3e 8a5a44 c9c3bd ffffff | DEM stack; negative heights clamp to 0 before the root           |
| `ee-terrain-slope`     | —              | degrees                      | linear | 0             | 45              | 0–45          | 1a9850 91cf60 fee08b fc8d59 d73027                             | DEM stack, `Terrain.slope`                                       |
| `ee-terrain-aspect`    | —              | degrees from north           | linear | 0             | 360             | 0–360         | 3288bd 99d594 fee08b fc8d59 3288bd                             | circular palette (N at both ends); a window cuts the circle      |
| `ee-terrain-hillshade` | —              | brightness 0–255             | linear | 0             | 255             | 0–255         | 000000 ffffff                                                  | `Terrain.hillshade` (315°, 45°)                                  |
| `ee-forest-loss`       | —              | year of loss (value − 2000)  | linear | 1 (2001)      | 25 (2025)       | 1–25          | ffff00 ff9900 ff0000 990000                                    | zero masked (`selfMask`); far views capped at 3,000 km           |
| `ee-population`        | `density-YYYY` | people per km²               | log10  | 1             | 10,000          | 0–4           | fed976 fecc5c fd8d3c f03b20 bd0026                             | count × 100 per km²; under 1 masked (`atLeast`); four epochs     |
| `ee-surface-water`     | `occurrence`   | % of months with water       | linear | 1             | 100             | 1–100         | d4f0ff 8cc8f0 3d8fd6 0b4fa8 08306b                             | masked by `max_extent`; zero masked                              |
| `ee-surface-water`     | `change`       | percentage points (−100…100) | linear | −50           | 50              | −50–50        | b2182b ef8a62 fddbc7 d1e5f0 67a9cf 2166ac                      | diverging; zero masked (`nonzero`)                               |
| `ee-surface-water`     | `seasonality`  | months a year                | linear | 1             | 12              | 1–12          | b9f2e6 5fc4d8 1f78b4 0b2f7a                                    | zero masked                                                      |
| `ee-buildings`         | `count`        | buildings per km²            | log10  | 1             | 10,000          | 0–4           | fcc5c0 fa9fb5 f768a1 c51b8a 7a0177                             | fractional count × 4,000,000; under 1 masked                     |
| `ee-buildings`         | `cover`        | share of ground built (0–1)  | linear | 0 (0%)        | 0.5 (50%)       | 0–0.5         | fcc5c0 fa9fb5 f768a1 c51b8a 7a0177                             | under 0.02 masked                                                |
| `ee-buildings`         | `height`       | m                            | linear | 0             | 30              | 0–30          | 440154 3b528b 21918c 5ec962 fde725                             | height ÷ presence, presence ≥ 0.05; footprints overlay from z 15 |
| `ee-tree-canopy`       | `meta`, `eth`  | m                            | linear | 0             | 40              | 0–40          | f7fcb9 addd8e 41ab5d 006837 00321a                             | two datasets, one scale                                          |
| `ee-inundation`        | `count`        | floods recorded              | linear | 0.1           | 10              | 0.1–10        | c6e6f5 74b9e3 2b7bc4 0b3d91 2a0b5e                             | under 0.1 masked                                                 |
| `ee-inundation`        | `duration`     | days under water             | log10  | 1             | 316             | 0–2.5         | fee8c8 fdbb84 e34a33 b30000 4d0000                             | under 1 day masked                                               |

**Not windowed** (no continuous ramp, so the model offers nothing or a
palette swap only):

| Layer id                | Modes                      | Why                                                                                           |
| ----------------------- | -------------------------- | --------------------------------------------------------------------------------------------- |
| `ee-forest-types`       | —                          | categorical: class codes 1, 10, 20 remapped to 1–3 (three colours)                            |
| `ee-land-cover`         | `v200`, `v100`             | categorical: 11 WorldCover classes remapped to 0–10, the dataset's own colours                |
| `ee-rivers`             | `free-flowing`, `pressure` | categorical per reach (CSI_FF2, CSI_D), drawn by `Collection.style`, one colour per class     |
| `ee-rivers`             | `network`, `network-rest`  | lines in the ink (light/dark), width by order                                                 |
| `ee-elevation-contours` | —                          | lines in the ink; contour steps follow the zoom                                               |
| `ee-admin-boundaries`   | levels                     | lines in the ink                                                                              |
| `ee-census-tracts`      | `tracts`; `income`, `lst`  | outlines in the ink; income and LST are drawn by the local census server, not by Earth Engine |

## How a chosen scale reaches Earth Engine

A layer's tiles are `/api/earth-engine/tile/<layer>[/<mode>]/<variant>/<ink>/<z>/<x>/<y>?v=<hash>`.
A chosen scale adds `&s=<token>`: the model's own hash fields
(`<palette code>.<floor>.<ceiling>.<flags>`, `encodeScaleFields`, the same
grammar as the share hash's `cs`). Without one the map request, its hash
and its tiles are exactly the defaults above.

Each layer (mode) registers the model's defaults built from the table
(`eeScaleDefaults` in `src/data/earthEngineScale.js`: the scale kind, units,
the record's stops as the `default` palette, floor–ceiling as the fixed
range) with the app's store (`colourScales()`), and its row carries the
widget (`scaleRowControl`, the slider spanning `eeSliderRange`, wider than
the default window where the data runs past it). A chosen scale's legend
replaces the layer's own; an untouched row is as before.

The server reads the token against the same defaults (`decodeScaleToken`):
the model normalised, an automatic floor or ceiling taken from the default
window (a log window over a range that starts at 0 starts at a thousandth
of the ceiling), the palette's stops (`paletteStopsHex`; `default` is the
layer's own). Then it turns that concrete scale into the map request:

- **Floor and ceiling** become the visualization's min and max, converted
  into the layer's internal space for the chosen scale: log scale
  → `log10(floor)`, `log10(ceiling)` (values at or below zero masked);
  linear → as given; sqrt (elevation's default) → `sqrt`.
- **Log or linear** replaces the layer's native transform: a log10 layer
  drawn linear loses its `Image.log10`; a linear one drawn log gains one.
- **Palette** stops are the visualization's `paletteColors` (hex, up to 32);
  **invert** reverses them.
- **Outside: hide** masks the image below the floor and above the ceiling
  (`Image.updateMask` with `gte` and `lte` in the drawn space); clamp is
  Earth Engine's default.

Each (layer, variant, ink, mode, scale) is its own map: the map key and the
request hash include the scale, so the disk cache keeps each scale's tiles
apart and the browser's URL carries the token. Maps for chosen scales are
kept in a small per-session cache (the last 48 scales), so moving back to a
window used before makes no new map, and the client asks only 300 ms after
the slider settles (the store tells it of each change; only the layer's own
keys count, `ee-census-tracts:*` included).

Diverging (surface-water change, zero centred) and circular (aspect) are
flags on the defaults (`defaultScale(...).diverging`, `.centre`,
`.circular`) for the widget; the provider draws any window as given.
Census tracts' income and LST are drawn by the local census server
(`server/providers/census.js`, `src/data/censusScale.js`); the Earth Engine
row shows their widget (`censusScaleControl`) in those modes.
