"""
Personal fork: Cottereau's drawn borders, extracted from the video's frames
as polygons in lon/lat, for a PRIVATE comparison layer beside Cliopatria.

    D:\\gev-tools\\cottereau-venv\\Scripts\\python.exe -I extractBorders.py
        <build dir> <video> <first>-<last>

PRIVACY: the video is Cottereau's copyrighted work and so is what this
extracts from it. The geometry is for the user's personal use only: it is
written under the build directory (on E:, outside the repository), never
committed, never published. Frames are decoded in memory and never written.

The build directory (prepared by borders.mjs) holds samples.json (per
sample: its time, year, framing and labels with their track ids) and the
Cliopatria polygons of the matched polities (cliopatria.json and
cliopatria.f64). Each sample is written as samples/<index>.json.gz, whole
(a temporary file renamed), and a sample already there is skipped: a
stopped run resumes.

Per frame:
1. The sea: the map's one flat light blue (fitFraming.sea_mask).
2. Separators: the thin grey border lines (a black-hat: thin and darker
   than both sides; wide dark fills are not lines) and every jump of colour
   between neighbouring pixels (two fills meeting). The label text is
   painted out first: inside each OCR box, the pixels far from the box's
   own background take its colour, so the fill runs on under the label.
3. Regions: connected components of what is left, split by colour where
   two fills touch without a line, crumbs dropped; every separator pixel
   then goes to the nearest region, so the polygons tile.
4. Unclaimed land is the near-white fill; the off-white cream is a fill
   like any other (Cottereau draws many small polities in it).
5. Each region is named by the label whose point falls in it (or, for a
   label set beside its polity, the nearest coloured region close by). Two
   labels in one region split it by nearest label (flagged "split"). A
   region with no label joins the nearest region of its colour within
   JOIN_PX (an exclave, a colony, an island; flagged "joined"), else it is
   kept as "unlabelled" with its colour.
6. Each polity's regions are traced (holes kept), simplified to about a
   pixel, and projected with the sample's framing (inverse Miller).
7. Its area in km2, and its overlap (intersection over union, by area)
   with the Cliopatria polygon of its matched name in that year.
"""

import gzip
import importlib.util
import json
import math
import os
import sys
import time

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('fitFraming', os.path.join(HERE, 'fitFraming.py'))
_fit = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fit)
sea_mask = _fit.sea_mask

R_KM = 6371.0
FORMAT = 1
LINE_BLACKHAT = 25  # a thin line's darkness over its surroundings
COLOUR_EDGE = 24  # a jump in a channel between neighbours: two fills meeting
TEXT_DIFF = 20  # a text pixel's distance from its box's background (strokes and rims)
MIN_REGION_PX = 25  # crumbs smaller than this are separators
SPLIT_STD = 18  # a region this mixed in colour is split by colour
JOIN_PX = 800  # an unlabelled region joins its colour this close (full res)
SAME_COLOUR = 14  # two fills this close (max channel) are one colour
LABEL_REACH = 3.0  # a label beside its polity (over the sea): nearest within 3 label heights
MIN_HOLE_PX = 30  # a hole smaller than this is a speck of text, not a hole
SIMPLIFY_PX = 1.0
YEAR_BOX = (1600, 1620, 2250, 1920)  # x0, y0, x1, y1: the year and its ornament


# --- the projection -------------------------------------------------------------


def miller_forward(lon, lat):
    return np.radians(lon), 1.25 * np.log(np.tan(np.pi / 4 + 0.4 * np.radians(lat)))


def miller_inverse(u, v):
    return np.degrees(u), np.degrees(2.5 * np.arctan(np.exp(0.8 * v)) - 0.625 * np.pi)


def pixel_to_lonlat(framing, x, y):
    u = (np.asarray(x, float) - framing['tx']) / framing['sx']
    v = (framing['ty'] - np.asarray(y, float)) / framing['sy']
    return miller_inverse(u, v)


def lonlat_to_pixel(framing, lon, lat):
    u, v = miller_forward(np.asarray(lon, float), np.asarray(lat, float))
    return framing['sx'] * u + framing['tx'], framing['ty'] - framing['sy'] * v


def row_area_km2(framing, height):
    """Each pixel row's area per pixel, km2: R^2 cos(lat) dlon dlat, with
    Miller's dv/dlat = 1 / cos(0.8 lat)."""
    y = np.arange(height) + 0.5
    _, lat = pixel_to_lonlat(framing, np.zeros(height), y)
    phi = np.radians(lat)
    return R_KM ** 2 * np.cos(phi) * (1 / framing['sx']) * (np.cos(0.8 * phi) / framing['sy'])


# --- segmentation ---------------------------------------------------------------


def paint_out_text(frame, boxes, sea):
    """The frame with its label text painted out (`sea`, a bool mask, updated
    in place: the text of a label over the sea is sea): inside each OCR box (and the
    year box), every pixel far from the box's background (its commonest
    colour: the fill the label sits on) takes that colour. Left as a
    separator, text would cut the fill into islands between the letters."""
    painted = frame.copy()
    height, width = frame.shape[:2]
    rects = [(cx - w * 0.55 - 3, cy - h * 0.6 - 3, cx + w * 0.55 + 3, cy + h * 0.6 + 3) for cx, cy, w, h in boxes]
    rects.append(YEAR_BOX)
    for x0, y0, x1, y1 in rects:
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(width, int(math.ceil(x1))), min(height, int(math.ceil(y1)))
        if x1 <= x0 or y1 <= y0:
            continue
        patch = frame[y0:y1, x0:x1].astype(np.int16)
        q = (patch // 16).reshape(-1, 3)
        packed = np.bincount(q[:, 0] * 256 + q[:, 1] * 16 + q[:, 2], minlength=4096)
        mode = int(np.argmax(packed))
        bins = np.array([mode // 256, (mode // 16) % 16, mode % 16])
        # The mode bin's own mean colour (not its centre), as the fill.
        in_mode = (q == bins).all(axis=1)
        background = patch.reshape(-1, 3)[in_mode].mean(axis=0)
        far = np.max(np.abs(patch - background), axis=2) > TEXT_DIFF
        # The strokes' cores (black, or white on a darker fill) and a rim
        # round them; a grey border line through the box is not text, and
        # stays to separate the polities it divides.
        gray = patch.mean(axis=2)
        light = (patch.min(axis=2) > 225) & (background.mean() < 200)
        core = far & ((gray < 80) | light)
        text = (cv2.dilate(core.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & far
        box_sea = sea[y0:y1, x0:x1]
        over_sea = box_sea.mean() > 0.5
        # White strokes on a dark fill are sea-coloured, so the sea mask has
        # taken them: on land they are text all the same.
        light_text = (cv2.dilate((core & light).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0) & far
        text &= ~box_sea | (light_text if not over_sea else False)
        painted[y0:y1, x0:x1][text] = np.round(background).astype(np.uint8)
        # A label over the sea: its text is sea (else a sea-coloured island
        # of painted text would be the region it names).
        if over_sea:
            box_sea[text] = True
        else:
            box_sea[text] = False
    return painted


def line_mask(frame):
    """Thin grey lines: darker than both sides, at most a few pixels wide."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    blackhat = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, np.ones((7, 7), np.uint8))
    return blackhat > LINE_BLACKHAT


def colour_edges(frame):
    """Where the colour jumps (more than COLOUR_EDGE in a channel to the next
    pixel): two fills meeting, with or without a line between them. The
    video's compression noise stays well under it, two polities' fills well
    over it, so a region never runs from one fill into another."""
    f = frame.astype(np.int16)
    dx = np.abs(np.diff(f, axis=1)).max(axis=2) > COLOUR_EDGE
    dy = np.abs(np.diff(f, axis=0)).max(axis=2) > COLOUR_EDGE
    edges = np.zeros(frame.shape[:2], bool)
    edges[:, 1:] |= dx
    edges[:, :-1] |= dx
    edges[1:, :] |= dy
    edges[:-1, :] |= dy
    return edges


def segment(frame, boxes):
    """The frame's regions: (ids, table). ids: int32 per pixel, 0 for the sea,
    else a region id; table: id -> {colour (B, G, R), px, bbox, white}."""
    height, width = frame.shape[:2]
    sea = sea_mask(frame).astype(bool)
    # The year box is no land: counted with the sea.
    x0, y0, x1, y1 = YEAR_BOX
    sea[y0:y1, x0:x1] = True
    frame = paint_out_text(frame, boxes, sea)
    separators = line_mask(frame) | colour_edges(frame)
    fill = (~sea & ~separators).astype(np.uint8)
    count, comp, cstats, _ = cv2.connectedComponentsWithStats(fill, connectivity=4)
    comp = comp.astype(np.int32)
    flat = comp.ravel()
    sizes = np.bincount(flat, minlength=count)
    pixels = frame.reshape(-1, 3).astype(np.float64)
    sums = np.stack([np.bincount(flat, weights=pixels[:, c], minlength=count) for c in range(3)], 1)
    squares = np.stack([np.bincount(flat, weights=pixels[:, c] ** 2, minlength=count) for c in range(3)], 1)
    del pixels
    with np.errstate(invalid='ignore', divide='ignore'):
        means = sums / sizes[:, None]
        stds = np.sqrt(np.maximum(0, squares / sizes[:, None] - means ** 2))
    next_id = count
    # Two fills touching without a line: split by colour.
    for cid in np.nonzero((sizes > 200) & (stds.max(axis=1) > SPLIT_STD))[0]:
        if cid == 0:
            continue
        x0, y0, bw, bh = cstats[cid][:4]
        x1, y1 = x0 + bw, y0 + bh
        window = comp[y0:y1, x0:x1]
        inside = window == cid
        patch = frame[y0:y1, x0:x1].astype(np.int32)
        # Its dominant colours (5% of it or more; antialiased edges are not
        # one), each pixel to the nearest, each colour's parts their own.
        quant = patch // 24
        key = quant[:, :, 0] * 1024 + quant[:, :, 1] * 32 + quant[:, :, 2]
        counts = np.bincount(key[inside], minlength=32768)
        dominant = np.nonzero(counts >= 0.05 * inside.sum())[0]
        if len(dominant) < 2:
            continue
        centres = np.stack([(dominant // 1024) * 24 + 12, ((dominant // 32) % 32) * 24 + 12, (dominant % 32) * 24 + 12], 1)
        pix = patch[inside]
        nearest = np.argmin(np.abs(pix[:, None, :] - centres[None, :, :]).max(axis=2), axis=1)
        assigned = np.full(inside.shape, -1, np.int32)
        assigned[inside] = nearest
        for k in range(len(dominant)):
            n, sub = cv2.connectedComponents((assigned == k).astype(np.uint8), connectivity=4)
            if n <= 1:
                continue
            ids = np.where(sub > 0, sub + next_id - 1, 0)
            window[sub > 0] = ids[sub > 0]
            next_id += n - 1
    # The final components: crumbs (fewer than MIN_REGION_PX) are separators.
    own = fill.astype(bool)
    sizes = np.bincount(comp.ravel(), minlength=next_id)
    valid = sizes >= MIN_REGION_PX
    valid[0] = False  # the components' background: sea and separators
    # A border line no darker than the fill beside it is no black-hat: it
    # comes out as a thin, grey region of its own. Thin (about 4 px or less
    # across, on average) and neutral grey: a separator.
    flat = comp.ravel()
    pixels = frame.reshape(-1, 3).astype(np.float64)
    means = np.stack([np.bincount(flat, weights=pixels[:, c], minlength=next_id) for c in range(3)], 1) / np.maximum(1, sizes)[:, None]
    del pixels
    spread = means.max(axis=1) - means.min(axis=1)
    greyish = (spread < 20) & (means.mean(axis=1) > 60) & (means.mean(axis=1) < 200)
    order = np.argsort(flat, kind='stable')
    starts = np.searchsorted(flat[order], np.arange(next_id + 1))
    width_ = comp.shape[1]
    for cid in np.nonzero(valid & greyish)[0]:
        members = order[starts[cid]:starts[cid + 1]]
        xs, ys = members % width_, members // width_
        extent = (xs.max() - xs.min() + 1) + (ys.max() - ys.min() + 1)
        if sizes[cid] < 4 * extent:
            valid[cid] = False
    # Separators and crumbs go to the nearest region (the sea keeps its own).
    keep = valid[comp] | sea
    ids = np.where(sea, 0, comp)
    if (~keep).any():
        src = (~keep).astype(np.uint8)
        _, nearest = cv2.distanceTransformWithLabels(src, cv2.DIST_L2, 3, labelType=cv2.DIST_LABEL_PIXEL)
        # DIST_LABEL_PIXEL numbers the zero pixels (kept ones) in scan order from 1.
        lookup = np.concatenate([[0], ids[keep]])
        ids = np.where(keep, ids, lookup[nearest])
    comp = np.where(sea, 0, ids).astype(np.int32)
    own &= valid[comp]
    sizes = np.bincount(comp.ravel(), minlength=next_id)
    table = {int(cid): {'px': int(sizes[cid])} for cid in np.nonzero(valid & (sizes > 0))[0]}
    # Colour over each region's own fill pixels (not the separators it took).
    region_colour(frame, comp, own, table)
    for cid, entry in table.items():
        b, g, r = entry['colour']
        entry['white'] = min(b, g, r) >= 245 and max(b, g, r) - min(b, g, r) <= 6
    bbox(comp, table)
    return comp, table


def region_colour(frame, comp, own, table):
    """Each region's mean colour over its own fill pixels (not the separators it took)."""
    ids = np.where(own, comp, 0).ravel()
    n = int(comp.max()) + 1
    counts = np.bincount(ids, minlength=n)
    pixels = frame.reshape(-1, 3).astype(np.float64)
    for c in range(3):
        sums = np.bincount(ids, weights=pixels[:, c], minlength=n)
        for cid, entry in table.items():
            entry.setdefault('colour', [0.0, 0.0, 0.0])
            entry['colour'][c] = float(sums[cid] / counts[cid]) if counts[cid] else 0.0


def bbox(comp, table):
    """Each region's box and centroid, in one pass (sorted by id, not a scan per region)."""
    flat = comp.ravel()
    order = np.argsort(flat, kind='stable')
    ids = flat[order]
    width = comp.shape[1]
    xs = order % width
    ys = order // width
    starts = np.searchsorted(ids, np.arange(int(comp.max()) + 2))
    for cid in table:
        a, b = starts[cid], starts[cid + 1]
        if a == b:
            continue
        x, y = xs[a:b], ys[a:b]
        table[cid]['bbox'] = [int(x.min()), int(y.min()), int(x.max()) + 1, int(y.max()) + 1]
        table[cid]['centroid'] = [float(x.mean()), float(y.mean())]


# --- naming ---------------------------------------------------------------------


def colour_close(a, b):
    return max(abs(a[i] - b[i]) for i in range(3)) <= SAME_COLOUR


def gap_px(a, b):
    """The gap between two boxes [x0, y0, x1, y1] (0 when they overlap)."""
    dx = max(0, max(a[0], b[0]) - min(a[2], b[2]))
    dy = max(0, max(a[1], b[1]) - min(a[3], b[3]))
    return math.hypot(dx, dy)


def region_for_label(comp, table, label):
    """The region under a label's point, or None when it is over the sea or
    unclaimed land (then beside_candidates says where it may belong)."""
    height, width = comp.shape
    x = min(width - 1, max(0, int(round(label['x']))))
    y = min(height - 1, max(0, int(round(label['y']))))
    cid = int(comp[y, x])
    if cid and cid in table and not table[cid]['white']:
        return cid
    return None


def beside_candidates(comp, table, label):
    """For a label set beside its polity (over the sea, or over unclaimed
    land): the coloured regions within LABEL_REACH label heights, best
    first: the nearest, except that among those about as near (within 1.5
    times its distance and 10 px) the largest comes first (a label beside
    Japan names Honshu, not an islet); a large region further off never
    wins over the small one the label sits by."""
    height, width = comp.shape
    x = min(width - 1, max(0, int(round(label['x']))))
    y = min(height - 1, max(0, int(round(label['y']))))
    reach = max(60, int(LABEL_REACH * label.get('h', 30)))
    x0, y0 = max(0, x - reach), max(0, y - reach)
    window = comp[y0:min(height, y + reach + 1), x0:min(width, x + reach + 1)]
    scored = []
    for cand in np.unique(window):
        cand = int(cand)
        if not cand or cand not in table or table[cand]['white']:
            continue
        ys, xs = np.nonzero(window == cand)
        d = math.sqrt(float(np.min((xs + x0 - x) ** 2 + (ys + y0 - y) ** 2)))
        scored.append((d, cand))
    if not scored:
        return []
    scored.sort()
    near = scored[0][0] * 1.5 + 10
    first = sorted((c for c in scored if c[0] <= near), key=lambda c: -table[c[1]]['px'])
    rest = [c for c in scored if c[0] > near]
    return [cand for _, cand in first + rest]


def name_regions(comp, table, labels, hint=None):
    """Each region's owner: labels inside a region first; then each label set
    beside its polity takes the best region near it that no label inside
    has; a region two labels share is split by nearest label; the unlabelled
    regions join the nearest of their colour."""
    owners = {}
    beside = set()
    outside = []
    for i, label in enumerate(labels):
        cid = region_for_label(comp, table, label)
        if cid is None:
            outside.append(i)
        else:
            owners.setdefault(cid, []).append(i)
    for i in outside:
        candidates = beside_candidates(comp, table, labels[i])
        # The matched Cliopatria polity, when there is one: a candidate
        # centred in its polygons first (which side the label belongs to).
        inside = hint(labels[i]) if hint else None
        if inside:
            def centred(cid):
                return inside(*table[cid]['centroid'])
            candidates = [c for c in candidates if centred(c)] + [c for c in candidates if not centred(c)]
        for cid in candidates:
            if cid not in owners:
                owners[cid] = [i]
                beside.add(i)
                break
    assignment = {}  # region -> label index
    flags = {}  # label index -> set of flags
    next_id = int(comp.max()) + 1
    for cid, idx in list(owners.items()):
        # A label inside the region names it: one that only reached it from
        # beside (over the sea, or over unclaimed land) is set aside.
        inside = [i for i in idx if i not in beside]
        if inside and len(inside) < len(idx):
            idx = inside
        if len(idx) == 1:
            assignment[cid] = idx[0]
            continue
        # Two labels in one region: nearest label (Voronoi inside the region).
        x0, y0, x1, y1 = table[cid]['bbox']
        window = comp[y0:y1, x0:x1]
        inside = window == cid
        ys, xs = np.nonzero(inside)
        points = np.array([[labels[i]['x'] - x0, labels[i]['y'] - y0] for i in idx])
        d = (xs[:, None] - points[None, :, 0]) ** 2 + (ys[:, None] - points[None, :, 1]) ** 2
        nearest = np.argmin(d, axis=1)
        for k, i in enumerate(idx):
            sub = np.zeros(inside.shape, bool)
            sub[ys[nearest == k], xs[nearest == k]] = True
            if not sub.any():
                continue
            new = cid if k == 0 else next_id
            if k:
                next_id += 1
                window[sub] = new
                table[new] = dict(table[cid])
                table[new]['px'] = int(sub.sum())
            assignment[new] = i
            flags.setdefault(i, set()).add('split')
        table[cid]['px'] = int((window == cid).sum())
    # Unlabelled coloured regions: join the nearest labelled region of their
    # colour. Not a colour several polities share in this frame (Cottereau's
    # cream for small polities): that is a fill, not one polity's.
    joined = {}
    labelled = [(cid, i) for cid, i in assignment.items()]
    shared = set()
    for cid, i in labelled:
        others = {j for c, j in labelled if colour_close(table[c]['colour'], table[cid]['colour'])}
        if len(others) >= 3:
            shared.add(cid)
    for cid, entry in table.items():
        if cid in assignment or entry['white']:
            continue
        if any(colour_close(entry['colour'], table[s]['colour']) for s in shared):
            continue
        best, best_gap = None, None
        for lcid, i in labelled:
            if not colour_close(entry['colour'], table[lcid]['colour']):
                continue
            g = gap_px(entry['bbox'], table[lcid]['bbox'])
            if g <= JOIN_PX and (best_gap is None or g < best_gap):
                best, best_gap = i, g
        if best is not None:
            joined[cid] = best
            flags.setdefault(best, set()).add('joined')
    for i in beside:
        flags.setdefault(i, set()).add('beside')
    return assignment, joined, flags


# --- tracing --------------------------------------------------------------------


def trace(mask, framing, offset=(0, 0)):
    """A mask's polygons in lon/lat: [[outer, hole, ...], ...], each ring
    [[lon, lat], ...] (pixel centres), simplified to about a pixel."""
    contours, hierarchy = cv2.findContours(mask.astype(np.uint8), cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    if hierarchy is None:
        return []
    hierarchy = hierarchy[0]
    polygons = {}
    for k, contour in enumerate(contours):
        simple = cv2.approxPolyDP(contour, SIMPLIFY_PX, True).reshape(-1, 2).astype(float)
        if len(simple) < 3:
            continue
        lon, lat = pixel_to_lonlat(framing, simple[:, 0] + offset[0] + 0.5, simple[:, 1] + offset[1] + 0.5)
        ring = [[round(float(a), 4), round(float(b), 4)] for a, b in zip(lon, lat)]
        parent = hierarchy[k][3]
        if parent >= 0 and cv2.contourArea(contour) < MIN_HOLE_PX:
            continue  # a speck left by the text
        if parent < 0:
            polygons.setdefault(k, [None])[0] = ring
        else:
            polygons.setdefault(parent, [None]).append(ring)
    return [rings for rings in polygons.values() if rings[0] is not None]


def encode_rings(polygons):
    """Polygons as integer rings at 1e-4 degrees, the first vertex absolute and
    each later one a delta (as the Natural Earth packs are)."""
    out = []
    for rings in polygons:
        encoded = []
        for ring in rings:
            flat, px, py = [], 0, 0
            for lon, lat in ring:
                x, y = int(round(lon * 1e4)), int(round(lat * 1e4))
                flat += [x - px, y - py]
                px, py = x, y
            encoded.append(flat)
        out.append(encoded)
    return out


# --- Cliopatria ------------------------------------------------------------------


def load_cliopatria(build):
    path = os.path.join(build, 'cliopatria.json')
    if not os.path.exists(path):
        return {}
    index = json.load(open(path, encoding='utf8'))
    coords = np.fromfile(os.path.join(build, 'cliopatria.f64'), dtype='<f8').reshape(-1, 2)
    by_name = {}
    for record in index['records']:
        by_name.setdefault(record['name'], []).append(record)
    return {'byName': by_name, 'coords': coords}


def cliopatria_mask(clio, name, year, framing, window):
    """The Cliopatria polygons of `name` alive in `year`, drawn into the window
    (x0, y0, x1, y1) of the frame's pixels: a bool mask, or None."""
    records = [r for r in clio.get('byName', {}).get(name, []) if r['from'] <= year <= r['to']]
    if not records:
        return None
    x0, y0, x1, y1 = window
    mask = np.zeros((y1 - y0, x1 - x0), np.uint8)
    coords = clio['coords']
    for record in records:
        for polygon in record['polygons']:
            for k, (start, end) in enumerate(polygon):
                ring = coords[start:end]
                x, y = lonlat_to_pixel(framing, ring[:, 0], ring[:, 1])
                pts = np.stack([x - x0, y - y0], 1).round().astype(np.int32)
                cv2.fillPoly(mask, [pts], 1 if k == 0 else 0)
    return mask.astype(bool)


# --- one sample ------------------------------------------------------------------


def colour_hex(colour):
    b, g, r = [int(round(c)) for c in colour]
    return f'#{r:02x}{g:02x}{b:02x}'


def extract(frame, sample, framing, clio=None):
    """One sample's polygons and statistics (see the module's steps)."""
    height, width = frame.shape[:2]
    boxes = [b[:4] for b in sample.get('boxes', [])]
    comp, table = segment(frame, boxes)
    labels = sample['labels']
    def hint(label):
        """Whether a pixel lies in the label's matched Cliopatria polity
        (its polygons that year, projected), or None without one."""
        name = label.get('cliopatria')
        records = [r for r in (clio or {}).get('byName', {}).get(name, []) if r['from'] <= sample['year'] <= r['to']] if name else []
        if not records:
            return None
        coords = clio['coords']
        polygons = []
        for r in records:
            for polygon in r['polygons']:
                rings = []
                for start, end in polygon:
                    ring = coords[start:end]
                    x, y = lonlat_to_pixel(framing, ring[:, 0], ring[:, 1])
                    rings.append(np.stack([x, y], 1).astype(np.float32))
                polygons.append(rings)

        def inside(px, py):
            for rings in polygons:
                if cv2.pointPolygonTest(rings[0], (float(px), float(py)), False) >= 0 and not any(
                    cv2.pointPolygonTest(hole, (float(px), float(py)), False) > 0 for hole in rings[1:]
                ):
                    return True
            return False

        return inside

    assignment, joined, flags = name_regions(comp, table, labels, hint)
    area_row = row_area_km2(framing, height)
    owner = {}  # region -> label index
    owner.update(assignment)
    owner.update(joined)
    polygons = []
    labelled_px = 0
    by_label = {}
    for cid, i in owner.items():
        by_label.setdefault(i, []).append(cid)
    for i, cids in by_label.items():
        label = labels[i]
        x0 = min(table[c]['bbox'][0] for c in cids)
        y0 = min(table[c]['bbox'][1] for c in cids)
        x1 = max(table[c]['bbox'][2] for c in cids)
        y1 = max(table[c]['bbox'][3] for c in cids)
        window = comp[y0:y1, x0:x1]
        mask = np.isin(window, cids)
        px = int(mask.sum())
        labelled_px += px
        area = float((mask * area_row[y0:y1, None]).sum())
        main = max(cids, key=lambda c: table[c]['px'])
        entry = {
            'track': label.get('track'),
            'label': label['text'],
            'cliopatria': label.get('cliopatria'),
            'wikidata': label.get('wikidata'),
            'colour': colour_hex(table[main]['colour']),
            'areaKm2': round(area, 1),
            'flags': sorted(flags.get(i, set())),
            'regions': len(cids),
            'polygons': encode_rings(trace(mask, framing, (x0, y0))),
        }
        if clio and label.get('cliopatria'):
            entry['iou'] = iou(comp, cids, clio, label['cliopatria'], sample['year'], framing, (x0, y0, x1, y1), area_row)
        polygons.append(entry)
    unlabelled = []
    unclaimed_px = 0
    for cid, entry in table.items():
        if entry['white']:
            unclaimed_px += entry['px']
            continue
        if cid in owner:
            continue
        x0, y0, x1, y1 = entry['bbox']
        mask = comp[y0:y1, x0:x1] == cid
        area = float((mask * area_row[y0:y1, None]).sum())
        lon, lat = pixel_to_lonlat(framing, entry['centroid'][0], entry['centroid'][1])
        unlabelled.append({
            'colour': colour_hex(entry['colour']),
            'areaKm2': round(area, 1),
            'px': entry['px'],
            'lon': round(float(lon), 3),
            'lat': round(float(lat), 3),
            'polygons': encode_rings(trace(mask, framing, (x0, y0))),
        })
    land_px = int((comp > 0).sum())
    return {
        'format': FORMAT,
        'index': sample['index'],
        't': sample['t'],
        'year': sample['year'],
        'framing': framing['id'],
        'polygons': polygons,
        'unlabelled': unlabelled,
        'stats': {
            'landPx': land_px,
            'labelledPx': labelled_px,
            'unclaimedPx': unclaimed_px,
            'unlabelledPx': int(sum(u['px'] for u in unlabelled)),
            'regions': len(table),
            'labels': len(labels),
            'labelsPlaced': len(by_label),
            'split': sum(1 for f in flags.values() if 'split' in f),
            'joined': len(joined),
            'beside': sum(1 for f in flags.values() if 'beside' in f),
        },
    }


def iou(comp, cids, clio, name, year, framing, window, area_row):
    """Intersection over union, by area, of a polity's regions with its
    Cliopatria polygons (both within the frame, land only), or None."""
    height, width = comp.shape
    records = [r for r in clio.get('byName', {}).get(name, []) if r['from'] <= year <= r['to']]
    if not records:
        return None
    # The window grows to hold the Cliopatria polygons' boxes too (clipped to the frame).
    x0, y0, x1, y1 = window
    for record in records:
        bx0, by0 = lonlat_to_pixel(framing, record['box'][0], record['box'][3])
        bx1, by1 = lonlat_to_pixel(framing, record['box'][2], record['box'][1])
        x0, y0 = min(x0, int(bx0)), min(y0, int(by0))
        x1, y1 = max(x1, int(math.ceil(bx1))), max(y1, int(math.ceil(by1)))
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(width, x1), min(height, y1)
    if x1 <= x0 or y1 <= y0:
        return None
    land = comp[y0:y1, x0:x1] > 0
    ours = np.isin(comp[y0:y1, x0:x1], cids)
    theirs = cliopatria_mask(clio, name, year, framing, (x0, y0, x1, y1))
    if theirs is None:
        return None
    theirs &= land
    weights = area_row[y0:y1, None]
    inter = float(((ours & theirs) * weights).sum())
    union = float(((ours | theirs) * weights).sum())
    return round(inter / union, 4) if union else None


def write_atomic(path, payload):
    tmp = f'{path}.{os.getpid()}.tmp'
    with gzip.open(tmp, 'wt', encoding='utf8') as out:
        json.dump(payload, out, separators=(',', ':'))
    os.replace(tmp, path)


def main():
    build, video, span = sys.argv[1:4]
    first, last = [int(v) for v in span.split('-')]
    samples = json.load(open(os.path.join(build, 'samples.json'), encoding='utf8'))
    framings = {f['id']: f for f in samples['framings']}
    clio = load_cliopatria(build)
    out_dir = os.path.join(build, 'samples')
    os.makedirs(out_dir, exist_ok=True)
    capture = cv2.VideoCapture(video)
    for sample in samples['samples'][first:last + 1]:
        target = os.path.join(out_dir, f"{sample['index']:04d}.json.gz")
        if os.path.exists(target):
            continue
        started = time.time()
        capture.set(cv2.CAP_PROP_POS_MSEC, sample['t'] * 1000)
        ok, frame = capture.read()
        if not ok:
            print(f"[borders] no frame at {sample['t']} s", flush=True)
            continue
        result = extract(frame, sample, framings[sample['framing']], clio)
        result['seconds'] = round(time.time() - started, 2)
        write_atomic(target, result)
        s = result['stats']
        print(
            f"[borders] sample {sample['index']} ({sample['year']}): {len(result['polygons'])} polities, "
            f"{len(result['unlabelled'])} unlabelled, labelled {100 * s['labelledPx'] / max(1, s['landPx'] - s['unclaimedPx']):.1f}% of claimed land, "
            f"{result['seconds']} s",
            flush=True,
        )
    capture.release()


if __name__ == '__main__':
    main()
