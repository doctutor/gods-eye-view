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

EXTRACTOR_VERSION names what this writes: bump it whenever a change can
change any sample's output (here or in fitFraming.sea_mask), and only
then. borders.mjs keys a build on it and the inputs, so a change that
leaves the output as it was (speed, memory) keeps the samples written.

Per frame:
0. A frame in which the sea is not found (under MIN_SEA_SHARE of it: the
   opening, the fade-out at the end, a cross-fade between framings) is no
   map: it is written as skipped, with no polygons, and left out of the
   build's samples. So is a fade (a dip between framings, the whole map
   dimmed), whose sea is off the map's one sea colour.
1. The sea: the map's one flat light blue (fitFraming.sea_mask).
2. Separators: the thin border lines (a black-hat: thin and darker than
   both sides, in grey or in any one channel, so a crimson's darker lines
   count; wide dark fills are not lines) and every jump of colour between
   neighbouring pixels, or over three (two fills meeting). The label text
   is painted out first: inside each OCR box, the pixels far from the box's
   own background take its colour, so the fill runs on under the label;
   but not a border line through the box, nor the strokes over it.
3. Regions: connected components of what is left, split by colour where
   two fills touch without a line, crumbs dropped; every separator pixel
   then goes to the nearest region, so the polygons tile.
4. Unclaimed land is the near-white fill; the off-white cream is a fill
   like any other (Cottereau draws many small polities in it).
5. Each region is named by the label whose point falls in it (or, for a
   label set beside its polity, the nearest coloured region close by: one
   mostly inside its matched Cliopatria polity first, then one partly
   inside it, and such labels before the others; but
   never one over MAX_CLAIM times its matched Cliopatria polity's area:
   a small polity's label over the sea is not the giant's beside it). One
   label set on two lines is one label. Labels of several polities in one
   region split it by nearest label (flagged "split"); labels matched to
   one Cliopatria polity there name it together. A
   region with no label joins the nearest region of its colour within
   JOIN_PX (an exclave, a colony, an island; flagged "joined"; within the
   same MAX_CLAIM of a matched polity's area), else it is
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
# What this writes (see above). 1: the first full run. 2: frames without
# a sea are skipped (they were one region the size of the frame). 3: a
# label set beside its polity, or a region joining one, never claims more
# than MAX_CLAIM times its matched Cliopatria polity's area. 4: a beside
# label's own region is one mostly (MOSTLY_OWN) inside its matched polity,
# not one whose centroid is; and labels with such a region choose first.
# 5: border lines through a label's box are kept, lines darker in one
# channel and fills meeting over three pixels separate, fades are skipped,
# one label's two lines are one label, and the labels of one matched polity
# in one fill are not split from each other.
EXTRACTOR_VERSION = 5
MOSTLY_OWN = 0.5  # a region this much inside a label's matched polity is that label's side
SOME_OWN = 0.1  # a region this much inside it comes before one wholly outside
MAX_CLAIM = 6  # a beside or joined claim over 6x the matched polity is another polity's (none with IoU >= 0.2 above it)
MIN_SEA_SHARE = 0.05  # a map shows at least this much sea (0.27 at the closest framing; a fade 0)
SEA_BGR = np.array([237, 226, 217])  # the map's sea, in every framing (#d9e2ed)
FADE_TOLERANCE = 6  # a sea further off than this in a channel is a fade's (799's: 15 darker)
LINE_GAP = 0.6  # two labels this close (of a line's height) one above the other are one label's lines
LINE_ALIGN = 0.25  # and their centres this close across (of the wider line)
SPLIT_CELLS = 4_000_000  # pixel x label distances held at once in a split (32 MB)
LINE_BLACKHAT = 25  # a thin line's darkness over its surroundings
LINE_BLACKHAT_CHANNEL = 32  # the same in any one channel (a crimson's darker lines: 48 to 64)
LINE_MARGIN = 10  # how far outside a label's box a border line is looked for
LINE_OUTSIDE_PX = 8  # a line with this many pixels outside the box runs on: a border, not a letter
LINE_KEEP_PX = 2  # a letter's rim this close to a border line through its box stays
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


def border_lines(lines, rect, shape, letters=None):
    """The border lines through a label's box: the lines (a bool mask of the
    whole frame) inside the box that run on outside it (LINE_OUTSIDE_PX or
    more of their pixels within LINE_MARGIN of it, outside), as a mask of
    the box. A letter's strokes stay inside its box; a border runs on.
    `letters` (a mask of the box) are never lines: black letters are thin
    dark strokes too, and one touching a border would take the word."""
    x0, y0, x1, y1 = rect
    height, width = shape
    wx0, wy0 = max(0, x0 - LINE_MARGIN), max(0, y0 - LINE_MARGIN)
    wx1, wy1 = min(width, x1 + LINE_MARGIN), min(height, y1 + LINE_MARGIN)
    window = lines[wy0:wy1, wx0:wx1].copy()
    inner = (slice(y0 - wy0, y1 - wy0), slice(x0 - wx0, x1 - wx0))
    if letters is not None:
        window[inner] &= ~letters
    if not window.any():
        return np.zeros((y1 - y0, x1 - x0), bool)
    n, comp = cv2.connectedComponents(window.astype(np.uint8), connectivity=8)
    outside = np.ones(window.shape, bool)
    outside[inner] = False
    counts = np.bincount(comp[outside], minlength=n)
    runs_on = counts >= LINE_OUTSIDE_PX
    runs_on[0] = False
    return runs_on[comp[inner]]


def paint_out_text(frame, boxes, sea, lines=None):
    """The frame with its label text painted out (`sea`, a bool mask, updated
    in place: the text of a label over the sea is sea): inside each OCR box (and the
    year box), every pixel far from the box's background (its commonest
    colour: the fill the label sits on) takes that colour. Left as a
    separator, text would cut the fill into islands between the letters.
    With `lines` (the frame's line mask), a border line through the box (one
    that runs on outside it; the letters are never one) stays, with the
    text within LINE_KEEP_PX of it: painted, a label set against a border
    joins the two polities it divides. A letter set right across a line is
    painted all the same."""
    painted = frame.copy()
    height, width = frame.shape[:2]
    rects = [(cx - w * 0.55 - 3, cy - h * 0.6 - 3, cx + w * 0.55 + 3, cy + h * 0.6 + 3) for cx, cy, w, h in boxes]
    rects.append(YEAR_BOX)
    keep_kernel = np.ones((2 * LINE_KEEP_PX + 1, 2 * LINE_KEEP_PX + 1), np.uint8)
    for k, (x0, y0, x1, y1) in enumerate(rects):
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
        if lines is not None and k < len(boxes):
            # Never the letters (of the label's shade, white or black,
            # whichever the box has more of: a dark line under white letters
            # is a line), nor the fill between white letters (darker than
            # both sides, so a black-hat line, but the fill's own colour).
            dark = far & (gray < 80)
            letters = far & light if (far & light).sum() > dark.sum() else dark
            border = border_lines(lines, (x0, y0, x1, y1), (height, width), letters | ~far)
            if border.any():
                text &= ~(cv2.dilate(border.astype(np.uint8), keep_kernel) > 0)
        painted[y0:y1, x0:x1][text] = np.round(background).astype(np.uint8)
        # A label over the sea: its text is sea (else a sea-coloured island
        # of painted text would be the region it names).
        if over_sea:
            box_sea[text] = True
        else:
            box_sea[text] = False
    return painted


def line_mask(frame):
    """Thin lines: darker than both sides, at most a few pixels wide. Grey
    lines by their grey; a fill's own darker shade (a crimson's border
    lines, which are darker in red alone) by any one channel."""
    kernel = np.ones((7, 7), np.uint8)
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    lines = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, kernel) > LINE_BLACKHAT
    for c in range(3):
        lines |= cv2.morphologyEx(np.ascontiguousarray(frame[:, :, c]), cv2.MORPH_BLACKHAT, kernel) > LINE_BLACKHAT_CHANNEL
    return lines


def colour_edges(frame):
    """Where the colour jumps (more than COLOUR_EDGE in a channel to the next
    pixel, or to the one after it: the compression spreads some fills' meeting
    over three pixels): two fills meeting, with or without a line between them. The
    video's compression noise stays well under it, two polities' fills well
    over it, so a region never runs from one fill into another."""
    f = frame.astype(np.int16)
    edges = np.zeros(frame.shape[:2], bool)
    dx = np.abs(np.diff(f, axis=1)).max(axis=2) > COLOUR_EDGE
    dy = np.abs(np.diff(f, axis=0)).max(axis=2) > COLOUR_EDGE
    edges[:, 1:] |= dx
    edges[:, :-1] |= dx
    edges[1:, :] |= dy
    edges[:-1, :] |= dy
    dx2 = np.abs(f[:, 2:] - f[:, :-2]).max(axis=2) > COLOUR_EDGE
    dy2 = np.abs(f[2:] - f[:-2]).max(axis=2) > COLOUR_EDGE
    for k in range(3):
        edges[:, k:edges.shape[1] - 2 + k] |= dx2
        edges[k:edges.shape[0] - 2 + k, :] |= dy2
    return edges


def segment(frame, boxes, sea=None):
    """The frame's regions: (ids, table). ids: int32 per pixel, 0 for the sea,
    else a region id; table: id -> {colour (B, G, R), px, bbox, white}.
    `sea` the frame's sea mask when it is known already."""
    height, width = frame.shape[:2]
    sea = (sea_mask(frame) if sea is None else sea).astype(bool)
    # The year box is no land: counted with the sea.
    x0, y0, x1, y1 = YEAR_BOX
    sea[y0:y1, x0:x1] = True
    frame = paint_out_text(frame, boxes, sea, line_mask(frame) & ~sea)
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


def merge_lines(comp, table, labels):
    """The labels with one label's lines read as one ("Russian" over
    "America"): two labels in one region, one above the other (the gap
    between them under LINE_GAP of a line's height, their centres within
    LINE_ALIGN of the wider across, the heights alike), of which one is
    matched, or both to the same Cliopatria polity. The merged label
    keeps the matched one's track and match, the texts in reading order,
    and sits between them. Split by nearest label, the lines would cut one
    polity in two."""
    regions = [region_for_label(comp, table, label) for label in labels]
    order = sorted(range(len(labels)), key=lambda i: labels[i]['y'])
    merged = {}  # index of the lower line -> index of the label it joins
    for a in order:
        if a in merged:
            continue
        top = labels[a]
        for b in order:
            if b == a or b in merged or regions[b] is None or regions[b] != regions[a]:
                continue
            low = labels[b]
            if low['y'] <= top['y']:
                continue
            h = max(top['h'], low['h'])
            gap = (low['y'] - low['h'] / 2) - (top['y'] + top['h'] / 2)
            if not (-0.2 * h <= gap <= LINE_GAP * h):
                continue
            if abs(low['x'] - top['x']) > LINE_ALIGN * max(top['w'], low['w']):
                continue
            if max(top['h'], low['h']) > 1.4 * min(top['h'], low['h']):
                continue
            # One matched (the other line is no polity's name), or both to
            # one polity; two unmatched lines may be two polities.
            names = {top.get('cliopatria'), low.get('cliopatria')} - {None}
            if len(names) != 1:
                continue
            merged[b] = a
            break
    if not merged:
        return labels
    out = []
    lower = {a: b for b, a in merged.items()}
    for i, label in enumerate(labels):
        if i in merged:
            continue
        if i not in lower:
            out.append(label)
            continue
        low = labels[lower[i]]
        own = label if label.get('cliopatria') or not low.get('cliopatria') else low
        out.append({
            **own,
            'text': f"{label['text']} {low['text']}",
            'x': (label['x'] + low['x']) / 2,
            'y': (label['y'] + low['y']) / 2,
            'w': max(label['w'], low['w']),
            'h': (low['y'] + low['h'] / 2) - (label['y'] - label['h'] / 2),
            'lines': 2,
        })
    return out


def nearest_label(xs, ys, points):
    """For each pixel (xs, ys), the index of the nearest point (squared
    distance; the first on a tie). In chunks of pixels, so a region holding
    many labels never needs a pixels x labels matrix at once: at most
    SPLIT_CELLS distances. The same arithmetic as all at once, so the same
    answer."""
    points = np.asarray(points, dtype=np.float64)
    nearest = np.empty(len(xs), np.intp)
    step = max(1, SPLIT_CELLS // max(1, len(points)))
    for start in range(0, len(xs), step):
        cx = xs[start:start + step]
        cy = ys[start:start + step]
        d = (cx[:, None] - points[None, :, 0]) ** 2 + (cy[:, None] - points[None, :, 1]) ** 2
        nearest[start:start + step] = np.argmin(d, axis=1)
    return nearest


def name_regions(comp, table, labels, hint=None, claim=None):
    """Each region's owner: labels inside a region first; then each label set
    beside its polity takes the best region near it that no label inside
    has; a region two labels share is split by nearest label; the unlabelled
    regions join the nearest of their colour. `claim(i)`: the most pixels
    label i may take beside it or by joins (MAX_CLAIM times its matched
    polity's area), or None (no match: no bound)."""
    caps = {}

    def cap(i):
        if claim is None:
            return None
        if i not in caps:
            caps[i] = claim(labels[i])
        return caps[i]

    owners = {}
    beside = set()
    outside = []
    for i, label in enumerate(labels):
        cid = region_for_label(comp, table, label)
        if cid is None:
            outside.append(i)
        else:
            owners.setdefault(cid, []).append(i)
    plans = []
    for i in outside:
        candidates = beside_candidates(comp, table, labels[i])
        # The matched Cliopatria polity, when there is one: a candidate
        # mostly inside it first (which side the label belongs to), then
        # one partly inside it (SOME_OWN) before one wholly outside it, however
        # large (Sarawak's strip before the Dutch Borneo beside it).
        inside = hint(labels[i]) if hint else None
        shares = {c: float(inside(c)) for c in candidates} if inside else {}
        own = [c for c in candidates if shares.get(c, 0) >= MOSTLY_OWN]
        some = [c for c in candidates if SOME_OWN <= shares.get(c, 0) < MOSTLY_OWN]
        plans.append((i, own, own + some + [c for c in candidates if c not in own and c not in some]))

    def take(i, candidates):
        for cid in candidates:
            if cid in owners:
                continue
            # Not a region far larger than the polity it would name.
            if cap(i) is not None and table[cid]['px'] > cap(i):
                continue
            owners[cid] = [i]
            beside.add(i)
            return True
        return False

    # First every label with a region of its own matched polity, so one set
    # beside its neighbour (first by label order) does not take the region
    # another label's polity is (Banu Sulaym's over the Mamluks' Egypt);
    # then the rest, as near and as large as before.
    placed = set()
    for i, own, _ in plans:
        if own and take(i, own):
            placed.add(i)
    for i, _, candidates in plans:
        if i not in placed:
            take(i, candidates)
    assignment = {}  # region -> label index
    flags = {}  # label index -> set of flags
    next_id = int(comp.max()) + 1
    for cid, idx in list(owners.items()):
        # A label inside the region names it: one that only reached it from
        # beside (over the sea, or over unclaimed land) is set aside.
        inside = [i for i in idx if i not in beside]
        if inside and len(inside) < len(idx):
            idx = inside
        # Labels of one Cliopatria polity in one fill name it together: the
        # first of them (in label order) has it whole.
        groups = {}
        for i in idx:
            name = labels[i].get('cliopatria')
            groups.setdefault(name if name else ('own', i), []).append(i)
        firsts = [members[0] for members in groups.values()]
        if len(firsts) == 1:
            assignment[cid] = firsts[0]
            continue
        # Labels of several polities in one region: nearest label (Voronoi
        # inside the region), each polity's labels their cells together.
        group_of = {i: members[0] for members in groups.values() for i in members}
        x0, y0, x1, y1 = table[cid]['bbox']
        window = comp[y0:y1, x0:x1]
        inside = window == cid
        ys, xs = np.nonzero(inside)
        points = np.array([[labels[i]['x'] - x0, labels[i]['y'] - y0] for i in idx])
        nearest = np.array([firsts.index(group_of[i]) for i in idx])[nearest_label(xs, ys, points)]
        for k, i in enumerate(firsts):
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
    claimed = {}  # label index -> pixels it has
    for cid, i in labelled:
        claimed[i] = claimed.get(i, 0) + table[cid]['px']
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
        # The nearest of its colour (the first on a tie), unless that would
        # take the polity past its claim: then the next nearest.
        options = []
        for k, (lcid, i) in enumerate(labelled):
            if not colour_close(entry['colour'], table[lcid]['colour']):
                continue
            g = gap_px(entry['bbox'], table[lcid]['bbox'])
            if g <= JOIN_PX:
                options.append((g, k, i))
        for g, k, i in sorted(options):
            if cap(i) is not None and claimed[i] + entry['px'] > cap(i):
                continue
            joined[cid] = i
            claimed[i] += entry['px']
            flags.setdefault(i, set()).add('joined')
            break
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


def cliopatria_px(clio, name, year, framing):
    """The area, in a framing's pixels, of the Cliopatria polygons of `name`
    alive in `year` (outer rings less their holes; the shoelace on the
    projected rings, as borders.mjs computes it), or None."""
    records = [r for r in clio.get('byName', {}).get(name, []) if r['from'] <= year <= r['to']]
    if not records:
        return None
    coords = clio['coords']
    total = 0.0
    for record in records:
        for polygon in record['polygons']:
            for k, (start, end) in enumerate(polygon):
                ring = coords[start:end]
                x, y = lonlat_to_pixel(framing, ring[:, 0], ring[:, 1])
                area = abs(float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))) / 2
                total += area if k == 0 else -area
    return max(0.0, total)


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


def skipped(sample, framing, reason, sea_share):
    """A sample that is no map: written so a resumed run passes it, but with
    no polygons, and left out of the build's samples."""
    return {
        'format': FORMAT,
        'extractor': EXTRACTOR_VERSION,
        'index': sample['index'],
        't': sample['t'],
        'year': sample['year'],
        'framing': framing['id'],
        'skipped': reason,
        'seaShare': round(sea_share, 4),
        'polygons': [],
        'unlabelled': [],
        'stats': {'landPx': 0, 'labelledPx': 0, 'unclaimedPx': 0, 'unlabelledPx': 0, 'regions': 0,
                  'labels': len(sample['labels']), 'labelsPlaced': 0, 'split': 0, 'joined': 0, 'beside': 0},
    }


def extract(frame, sample, framing, clio=None):
    """One sample's polygons and statistics (see the module's steps)."""
    height, width = frame.shape[:2]
    boxes = [b[:4] for b in sample.get('boxes', [])]
    sea = sea_mask(frame)
    sea_share = float(sea.mean())
    if sea_share < MIN_SEA_SHARE:
        return skipped(sample, framing, 'no-sea', sea_share)
    # A fade (a dip between framings) dims the whole map: its sea is off the
    # map's one sea colour, and its unclaimed land is no longer white.
    sea_colour = frame[sea.astype(bool)].mean(axis=0)
    if np.abs(sea_colour - SEA_BGR).max() > FADE_TOLERANCE:
        return skipped(sample, framing, 'fade', sea_share)
    comp, table = segment(frame, boxes, sea)
    labels = merge_lines(comp, table, sample['labels'])
    def hint(label):
        """How much of a region (the share of its pixels) lies inside the
        label's matched Cliopatria polity that year, or None without one. A
        centroid would fall in a gap of a large region's polity (the
        Mamluks' 1372 ring leaves out south Sinai)."""
        name = label.get('cliopatria')
        if not (clio and name) or not any(r['from'] <= sample['year'] <= r['to'] for r in clio.get('byName', {}).get(name, [])):
            return None

        def inside(cid):
            x0, y0, x1, y1 = table[cid]['bbox']
            theirs = cliopatria_mask(clio, name, sample['year'], framing, (x0, y0, x1, y1))
            if theirs is None:
                return 0.0
            ours = comp[y0:y1, x0:x1] == cid
            return int((ours & theirs).sum()) / max(1, int(ours.sum()))

        return inside

    claims = {}

    def claim(label):
        """MAX_CLAIM times the label's matched Cliopatria polity's area that
        year, in this frame's pixels (its polygons projected), or None."""
        name = label.get('cliopatria')
        if name not in claims:
            claims[name] = None
            px = cliopatria_px(clio, name, sample['year'], framing) if clio and name else None
            if px:
                claims[name] = MAX_CLAIM * px
        return claims[name]

    assignment, joined, flags = name_regions(comp, table, labels, hint, claim)
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
        'extractor': EXTRACTOR_VERSION,
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
            'lines': sum(1 for label in labels if label.get('lines')),
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
        if result.get('skipped'):
            print(
                f"[borders] sample {sample['index']} ({sample['year']}): skipped, {result['skipped']} "
                f"(sea {100 * result['seaShare']:.1f}% of the frame)",
                flush=True,
            )
            continue
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
