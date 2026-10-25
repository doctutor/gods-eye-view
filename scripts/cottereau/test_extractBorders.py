"""
Personal fork: tests of extractBorders.py on synthetic frames drawn here
(no frame of the video): the regions between border lines and colour
changes, label text painted out, an exclave joined to its polity, a region
two labels share split, a colour with no label kept apart, the projection
both ways and pixel areas; the split's nearest label in chunks (the dense
answer, within a memory bound for a region holding many labels), a
frame without sea skipped, and a small polity's label beside a giant
bounded by its matched polity's area (beside and by joins), and the
labels whose own polity a region mostly is choosing first; a border line
under a label still dividing, a line darker in red alone, fills meeting
over three pixels, a fade skipped, a label's two lines one label, and one
polity's labels naming its fill together. Run by src/tooling/cottereauBorders.test.mjs
(or directly: python -I test_extractBorders.py).
"""

import importlib.util
import math
import os
import tracemalloc
import unittest

import cv2
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('extractBorders', os.path.join(HERE, 'extractBorders.py'))
eb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(eb)

SEA = (237, 226, 217)  # BGR, the video's sea
WHITE = (252, 252, 252)  # unclaimed
CREAM = (236, 244, 252)  # small polities
GREEN = (90, 180, 90)
RED = (60, 60, 200)
LINE = (140, 140, 140)
W, H = 3840, 1920  # full size, so the year box sits where it does
FRAMING = {'id': 1, 'sx': 1945.8, 'tx': -439.4, 'sy': 1945.8, 'ty': 1952.7}


def synthetic():
    """Sea; a land block of unclaimed white; on it a green polity with a
    label, its island exclave across a strait, a red polity, two cream ones
    divided by a grey line, and a purple polity nobody names; a block where
    two labels share one fill."""
    f = np.zeros((H, W, 3), np.uint8)
    f[:] = SEA
    cv2.rectangle(f, (200, 200), (2000, 1200), WHITE, -1)
    cv2.rectangle(f, (300, 300), (800, 700), GREEN, -1)
    cv2.rectangle(f, (300, 300), (800, 700), LINE, 2)
    cv2.rectangle(f, (400, 1300), (550, 1450), GREEN, -1)  # the exclave, an island off the coast
    cv2.rectangle(f, (900, 300), (1300, 700), RED, -1)
    cv2.rectangle(f, (900, 300), (1300, 700), LINE, 2)
    cv2.rectangle(f, (300, 800), (1100, 1100), CREAM, -1)
    cv2.rectangle(f, (300, 800), (1100, 1100), LINE, 2)
    cv2.line(f, (700, 800), (700, 1100), LINE, 2)  # cream | cream
    cv2.rectangle(f, (1400, 800), (1600, 1000), (160, 60, 140), -1)  # purple, no label
    cv2.rectangle(f, (1400, 800), (1600, 1000), LINE, 2)
    cv2.rectangle(f, (2400, 700), (3200, 1100), (60, 160, 220), -1)  # orange, two labels, no line
    cv2.rectangle(f, (2400, 700), (3200, 1100), LINE, 2)
    # The green polity's label, in black, across its middle.
    cv2.putText(f, 'Greenland', (380, 520), cv2.FONT_HERSHEY_SIMPLEX, 2.2, (20, 20, 20), 6, cv2.LINE_AA)
    (tw, th), _ = cv2.getTextSize('Greenland', cv2.FONT_HERSHEY_SIMPLEX, 2.2, 6)
    boxes = [[380 + tw / 2, 520 - th / 2, tw, th + 10]]
    labels = [
        {'text': 'Greenland', 'x': 380 + tw / 2, 'y': 520 - th / 2, 'w': tw, 'h': th, 'track': 1, 'cliopatria': None},
        {'text': 'Redland', 'x': 1100, 'y': 500, 'w': 120, 'h': 30, 'track': 2, 'cliopatria': None},
        {'text': 'West', 'x': 500, 'y': 950, 'w': 80, 'h': 30, 'track': 3, 'cliopatria': None},
        {'text': 'East', 'x': 900, 'y': 950, 'w': 80, 'h': 30, 'track': 4, 'cliopatria': None},
        {'text': 'North', 'x': 2600, 'y': 900, 'w': 80, 'h': 30, 'track': 5, 'cliopatria': None},
        {'text': 'South', 'x': 3000, 'y': 900, 'w': 80, 'h': 30, 'track': 6, 'cliopatria': None},
    ]
    return f, boxes, labels


class Borders(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.frame, cls.boxes, cls.labels = synthetic()
        cls.comp, cls.table = eb.segment(cls.frame, cls.boxes)

    def region_at(self, x, y):
        return int(self.comp[y, x])

    def test_regions_between_lines_and_colours(self):
        green = self.region_at(350, 350)
        red = self.region_at(1000, 400)
        west, east = self.region_at(400, 1000), self.region_at(1000, 1000)
        self.assertNotEqual(green, 0)
        self.assertNotEqual(green, red)
        self.assertNotEqual(west, east, 'a grey line divides two cream polities')
        self.assertEqual(self.region_at(100, 100), 0, 'the sea')
        self.assertTrue(self.table[self.region_at(250, 250)]['white'], 'unclaimed land')
        self.assertFalse(self.table[west]['white'], 'cream is a fill, not unclaimed')
        self.assertEqual(self.region_at(1900, 1700), 0, 'the year box is no land')

    def test_label_text_is_painted_out(self):
        green = self.region_at(350, 350)
        # Inside the letters, and between them, is the same green region.
        x, y = int(self.labels[0]['x']), int(self.labels[0]['y'])
        window = self.comp[y - 20:y + 20, x - 150:x + 150]
        self.assertEqual(set(np.unique(window).tolist()), {green})
        self.assertEqual(eb.region_for_label(self.comp, self.table, self.labels[0]), green)

    def test_naming_joins_an_exclave_and_splits_a_shared_fill(self):
        comp = self.comp.copy()
        table = {k: dict(v) for k, v in self.table.items()}
        assignment, joined, flags = eb.name_regions(comp, table, self.labels)
        green = int(comp[350, 350])
        exclave = int(comp[1375, 475])
        self.assertEqual(assignment[green], 0)
        self.assertEqual(joined.get(exclave), 0, 'the island of its colour joins it')
        self.assertIn('joined', flags[0])
        purple = int(comp[900, 1500])
        self.assertNotIn(purple, assignment)
        self.assertNotIn(purple, joined, 'a colour nobody names stays unlabelled')
        north, south = int(comp[900, 2500]), int(comp[900, 3100])
        self.assertNotEqual(north, south, 'two labels on one fill split it')
        self.assertEqual(assignment[north], 4)
        self.assertEqual(assignment[south], 5)
        self.assertIn('split', flags[4])

    def test_extract_traces_projected_polygons(self):
        sample = {'index': 7, 't': 100.0, 'year': 1200, 'boxes': self.boxes, 'labels': self.labels}
        result = eb.extract(self.frame, sample, FRAMING)
        by_label = {p['label']: p for p in result['polygons']}
        self.assertEqual(sorted(by_label), ['East', 'Greenland', 'North', 'Redland', 'South', 'West'])
        green = by_label['Greenland']
        self.assertEqual(green['regions'], 2)
        self.assertEqual(len(green['polygons']), 2, 'its block and its island')
        # Decoded, the first ring sits where the block is drawn.
        ring = green['polygons'][0][0]
        lon, lat, xs, ys = 0, 0, [], []
        for i in range(0, len(ring), 2):
            lon += ring[i]
            lat += ring[i + 1]
            x, y = eb.lonlat_to_pixel(FRAMING, lon / 1e4, lat / 1e4)
            xs.append(float(x))
            ys.append(float(y))
        self.assertTrue(min(xs) > 280 and max(xs) < 820, (min(xs), max(xs)))
        self.assertEqual(len(result['unlabelled']), 1, 'the purple polity')
        self.assertGreater(green['areaKm2'], 0)
        s = result['stats']
        self.assertEqual(s['labelsPlaced'], 6)
        self.assertGreater(s['labelledPx'], 0)

    def test_projection_both_ways_and_areas(self):
        for lon, lat in [(0, 0), (30, 45), (-120, -33), (140, 70)]:
            x, y = eb.lonlat_to_pixel(FRAMING, lon, lat)
            lon2, lat2 = eb.pixel_to_lonlat(FRAMING, x, y)
            self.assertAlmostEqual(float(lon2), lon, places=9)
            self.assertAlmostEqual(float(lat2), lat, places=9)
        # A box 10 by 10 degrees at 40-50 N: its pixels' areas against the sphere's.
        x0, y0 = eb.lonlat_to_pixel(FRAMING, 10, 50)
        x1, y1 = eb.lonlat_to_pixel(FRAMING, 20, 40)
        rows = eb.row_area_km2(FRAMING, H)
        y0i, y1i = int(round(float(y0))), int(round(float(y1)))
        measured = rows[y0i:y1i].sum() * (float(x1) - float(x0))
        exact = 6371.0 ** 2 * math.radians(10) * (math.sin(math.radians(50)) - math.sin(math.radians(40)))
        self.assertLess(abs(measured - exact) / exact, 0.01)


class Bounds(unittest.TestCase):
    def test_nearest_label_in_chunks_is_the_dense_answer(self):
        rng = np.random.default_rng(7)
        ys, xs = np.nonzero(np.ones((120, 90), bool))
        points = rng.uniform(0, 120, (17, 2))
        points[3] = points[5]  # a tie: the first wins, as argmin says
        dense = np.argmin((xs[:, None] - points[None, :, 0]) ** 2 + (ys[:, None] - points[None, :, 1]) ** 2, axis=1)
        saved = eb.SPLIT_CELLS
        try:
            eb.SPLIT_CELLS = 100  # many small chunks
            np.testing.assert_array_equal(eb.nearest_label(xs, ys, points), dense)
        finally:
            eb.SPLIT_CELLS = saved

    def test_a_region_holding_many_labels_splits_within_a_memory_bound(self):
        # One region of 3 M px holding 200 labels: all at once that is a
        # 3 M x 200 matrix of distances (4.8 GB); in chunks, tens of MB.
        h, w = 1500, 2000
        comp = np.zeros((h, w), np.int32)
        comp[:, :] = 1
        table = {1: {'px': h * w, 'bbox': (0, 0, w, h), 'white': False, 'colour': (90, 180, 90), 'centroid': (w / 2, h / 2)}}
        labels = [{'text': f'L{k}', 'x': 10 + (k % 20) * 99, 'y': 10 + (k // 20) * 149, 'h': 20} for k in range(200)]
        tracemalloc.start()
        try:
            assignment, joined, flags = eb.name_regions(comp, table, labels)
            peak = tracemalloc.get_traced_memory()[1]
        finally:
            tracemalloc.stop()
        self.assertEqual(sorted(assignment.values()), list(range(200)))
        self.assertTrue(all('split' in flags[i] for i in range(200)))
        self.assertLess(peak, 400 * 2 ** 20, f'peak {peak / 2 ** 20:.0f} MB')

    def test_a_frame_without_sea_is_skipped(self):
        frame = np.full((H, W, 3), 17, np.uint8)  # the fade to black at the end
        sample = {'index': 1042, 't': 1043.5, 'year': 2025, 'boxes': [], 'labels': [{'text': 'Russia', 'x': 3000, 'y': 400, 'h': 40}]}
        result = eb.extract(frame, sample, FRAMING)
        self.assertEqual(result['skipped'], 'no-sea')
        self.assertEqual(result['polygons'], [])
        self.assertEqual(result['extractor'], eb.EXTRACTOR_VERSION)
        # A map is not.
        frame, boxes, labels = synthetic()
        result = eb.extract(frame, {'index': 1, 't': 1.0, 'year': 1, 'boxes': boxes, 'labels': labels}, FRAMING)
        self.assertNotIn('skipped', result)


CRIMSON = (80, 28, 215)  # BGR; its border lines are darker in red alone
CRIMSON_LINE = (60, 20, 150)  # its mean under 80, as in the frames: a letter's core to the old painting


class Version5(unittest.TestCase):
    """Border lines under labels, faint lines, soft meetings of fills,
    fades, a label's two lines, and one polity's labels in one fill."""

    def test_a_border_line_under_a_label_still_divides(self):
        # Two crimson polities divided by a darker crimson line; a white
        # label set on the line, its letters' feet on it (as "Neu." on
        # Austrasia's border in 613), its box over it.
        f = np.zeros((H, W, 3), np.uint8)
        f[:] = SEA
        cv2.rectangle(f, (200, 200), (1400, 900), CRIMSON, -1)
        cv2.line(f, (200, 550), (1400, 550), CRIMSON_LINE, 2)
        cv2.putText(f, 'Neu.', (700, 547), cv2.FONT_HERSHEY_SIMPLEX, 1.6, (255, 255, 255), 4, cv2.LINE_AA)
        (tw, th), _ = cv2.getTextSize('Neu.', cv2.FONT_HERSHEY_SIMPLEX, 1.6, 4)
        boxes = [[700 + tw / 2, 547 - th / 2, tw, th + 10]]
        comp, table = eb.segment(f, boxes)
        self.assertNotEqual(int(comp[400, 750]), int(comp[700, 750]), 'the line divides them under the label')
        self.assertNotEqual(int(comp[400, 300]), int(comp[700, 300]))
        self.assertEqual(eb.region_for_label(comp, table, {'x': boxes[0][0], 'y': boxes[0][1]}), int(comp[400, 750]))
        # Painted out as before, the label joins them.
        sea = eb.sea_mask(f).astype(bool)
        painted = eb.paint_out_text(f, [b[:4] for b in boxes], sea.copy())
        seps = eb.line_mask(painted) | eb.colour_edges(painted)
        n, before = cv2.connectedComponents((~sea & ~seps).astype(np.uint8), connectivity=4)
        self.assertEqual(before[400, 750], before[700, 750])

    def test_a_black_label_touching_a_grey_line_is_painted_out(self):
        # Its letters are thin dark lines too: they are no border.
        f = np.zeros((H, W, 3), np.uint8)
        f[:] = SEA
        cv2.rectangle(f, (200, 200), (1400, 900), CREAM, -1)
        cv2.line(f, (200, 520), (1400, 520), LINE, 2)
        cv2.putText(f, 'Tajikistan', (600, 560), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (20, 20, 20), 3, cv2.LINE_AA)
        (tw, th), _ = cv2.getTextSize('Tajikistan', cv2.FONT_HERSHEY_SIMPLEX, 1.2, 3)
        boxes = [[600 + tw / 2, 560 - th / 2, tw, th + 10]]
        comp, table = eb.segment(f, boxes)
        below = int(comp[700, 700])
        self.assertNotEqual(int(comp[400, 700]), below, 'the line divides')
        x, y = int(boxes[0][0]), int(boxes[0][1])
        window = comp[y - 5:y + 5, x - tw // 3:x + tw // 3]
        self.assertEqual(set(np.unique(window).tolist()), {below}, 'the letters are its fill')

    def test_a_line_darker_in_one_channel_is_a_line(self):
        f = np.zeros((200, 200, 3), np.uint8)
        f[:] = CRIMSON
        cv2.line(f, (0, 100), (199, 100), (58, 22, 161), 2)  # 1764's colony lines
        f = cv2.GaussianBlur(f, (3, 3), 0)  # the video's softness
        gray = cv2.cvtColor(f, cv2.COLOR_BGR2GRAY)
        grey_only = cv2.morphologyEx(gray, cv2.MORPH_BLACKHAT, np.ones((7, 7), np.uint8)) > eb.LINE_BLACKHAT
        self.assertFalse(grey_only[95:106, 50].any(), 'in grey it is too faint')
        self.assertTrue(eb.line_mask(f)[95:106, 50].any(), 'in red it is a line')
        self.assertFalse(eb.line_mask(f)[20:80, :].any(), 'the flat fill is none')

    def test_fills_meeting_over_three_pixels_separate(self):
        f = np.zeros((100, 120, 3), np.uint8)
        f[:, :60] = (111, 117, 73)  # BGR, the Ottomans' teal
        f[:, 63:] = (76, 112, 27)  # Nejd's green
        f[:, 60] = (97, 117, 57)
        f[:, 61] = (87, 107, 41)
        f[:, 62] = (78, 110, 30)
        steps = np.abs(np.diff(f.astype(int), axis=1)).max(axis=2)
        self.assertLessEqual(int(steps.max()), eb.COLOUR_EDGE, 'no one step is an edge')
        edges = eb.colour_edges(f)
        self.assertTrue(edges[50, 58:65].any())
        self.assertFalse(edges[50, :55].any() or edges[50, 68:].any())

    def test_a_fade_is_skipped(self):
        frame, boxes, labels = synthetic()
        dimmed = (frame.astype(np.float32) * 0.93).astype(np.uint8)
        result = eb.extract(dimmed, {'index': 551, 't': 552.0, 'year': 799, 'boxes': boxes, 'labels': labels}, FRAMING)
        self.assertEqual(result['skipped'], 'fade')
        self.assertEqual(result['polygons'], [])

    def test_a_labels_two_lines_are_one_label(self):
        comp = np.ones((400, 400), np.int32)
        table = {1: {'px': 160000, 'bbox': (0, 0, 400, 400), 'white': False, 'colour': (75, 193, 231), 'centroid': (200, 200)}}
        labels = [
            {'text': 'America', 'x': 201, 'y': 230, 'w': 140, 'h': 37, 'track': 1358, 'cliopatria': None},
            {'text': 'Russian', 'x': 200, 'y': 185, 'w': 130, 'h': 34, 'track': 1357, 'cliopatria': 'Russian Empire'},
            {'text': 'Far', 'x': 60, 'y': 380, 'w': 50, 'h': 30, 'track': 9, 'cliopatria': None},
        ]
        merged = eb.merge_lines(comp, table, labels)
        self.assertEqual([l['text'] for l in merged], ['Russian America', 'Far'])
        self.assertEqual(merged[0]['track'], 1357)
        self.assertEqual(merged[0]['cliopatria'], 'Russian Empire')
        assignment, joined, flags = eb.name_regions(comp, table, merged[:1])
        self.assertEqual(assignment, {1: 0}, 'one label, its region whole')
        # Two unmatched lines may be two polities: not merged.
        apart = [dict(labels[0]), dict(labels[1], cliopatria=None)]
        self.assertEqual(len(eb.merge_lines(comp, table, apart)), 2)
        # Nor two lines matched to two polities.
        two = [dict(labels[0], cliopatria='Alaska'), labels[1]]
        self.assertEqual(len(eb.merge_lines(comp, table, two)), 2)

    def test_beside_a_region_partly_its_polity_before_a_larger_one_not_at_all(self):
        # Sarawak's label over the sea between its crimson strip (a third of
        # it in Cliopatria's Sarawak) and the larger Dutch Borneo (none).
        comp, table, labels = TwoPasses.world()
        labels = [dict(labels[0], cliopatria='Kingdom of Sarawak')]
        shares = {1: 0.0, 2: 0.3}
        assignment = eb.name_regions(comp, table, labels, lambda label: lambda cid: shares[cid])[0]
        self.assertEqual(assignment, {2: 0})
        self.assertEqual(eb.name_regions(comp, table, labels)[0], {1: 0}, 'without a hint, the larger')

    def test_one_polity_s_labels_in_one_fill_name_it_together(self):
        comp = np.ones((300, 900), np.int32)
        table = {1: {'px': 270000, 'bbox': (0, 0, 900, 300), 'white': False, 'colour': (129, 75, 105), 'centroid': (450, 150)}}
        labels = [
            {'text': 'Byzantine', 'x': 150, 'y': 100, 'w': 120, 'h': 30, 'cliopatria': 'Eastern Roman Empire'},
            {'text': 'Empire', 'x': 450, 'y': 200, 'w': 90, 'h': 30, 'cliopatria': 'Eastern Roman Empire'},
            {'text': 'Avars', 'x': 800, 'y': 150, 'w': 70, 'h': 30, 'cliopatria': 'Avar Khaganate'},
        ]
        assignment, joined, flags = eb.name_regions(comp, table, labels)
        self.assertEqual(sorted(assignment.values()), [0, 2], 'Empire names it with Byzantine')
        theirs = [cid for cid, i in assignment.items() if i == 0][0]
        # Byzantine's part reaches past the midpoint to Empire's cell.
        self.assertEqual(int(comp[200, 450]), theirs)
        self.assertEqual(int(comp[150, 850]), [cid for cid, i in assignment.items() if i == 2][0])
        self.assertEqual(flags[0], {'split'})
        # Alone in their fill, one polity's labels do not split it at all.
        comp = np.ones((300, 900), np.int32)
        assignment, joined, flags = eb.name_regions(comp, {1: dict(table[1])}, labels[:2])
        self.assertEqual(assignment, {1: 0})
        self.assertEqual(flags, {})


class Claims(unittest.TestCase):
    """A small polity's label set beside a giant: the bound on its claim."""

    @staticmethod
    def world():
        # Over a strip of sea (x 200..229): a giant on the left, the small
        # polity's own island on the right, both 15 px from the label; a
        # second piece of the giant's colour further right, unlabelled.
        comp = np.zeros((400, 600), np.int32)
        comp[:, :200] = 1
        comp[190:210, 230:250] = 2
        comp[100:300, 400:600] = 3
        def entry(cid, colour):
            ys, xs = np.nonzero(comp == cid)
            return {'px': int(len(xs)), 'bbox': (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1),
                    'white': False, 'colour': colour, 'centroid': (float(xs.mean()), float(ys.mean()))}
        table = {1: entry(1, (40, 90, 200)), 2: entry(2, (200, 90, 40)), 3: entry(3, (40, 90, 200))}
        labels = [{'text': 'Small', 'x': 215, 'y': 200, 'h': 20, 'cliopatria': 'Small'}]
        return comp, table, labels

    def test_without_a_bound_the_nearby_giant_is_taken(self):
        comp, table, labels = self.world()
        assignment, joined, flags = eb.name_regions(comp, table, labels)
        self.assertEqual(assignment, {1: 0}, 'about as near, the larger first')
        self.assertEqual(joined, {3: 0}, "and the giant's other piece joins it")

    def test_a_beside_label_never_claims_far_more_than_its_polity(self):
        comp, table, labels = self.world()
        own = table[2]['px']
        assignment, joined, flags = eb.name_regions(comp, table, labels, claim=lambda label: eb.MAX_CLAIM * own)
        self.assertEqual(assignment, {2: 0}, 'its own island')
        self.assertEqual(joined, {}, "the giant's colour is not its")
        self.assertEqual(flags[0], {'beside'})

    def test_a_join_stops_at_the_bound(self):
        comp, table, labels = self.world()
        labels[0]['x'] = 100  # inside the giant: it names it
        assignment, joined, flags = eb.name_regions(comp, table, labels, claim=lambda label: 1.1 * table[1]['px'])
        self.assertEqual(assignment, {1: 0})
        self.assertEqual(joined, {}, 'the second piece would take it past its bound')
        unbounded = eb.name_regions(comp, table, labels)[1]
        self.assertEqual(unbounded, {3: 0})

    def test_the_matched_polity_in_pixels(self):
        coords = np.array([[0, 0], [10, 0], [10, 10], [0, 10], [2, 2], [4, 2], [4, 4], [2, 4]], float)
        clio = {'byName': {'Sq': [{'from': 1, 'to': 5, 'polygons': [[[0, 4], [4, 8]]]}]}, 'coords': coords}
        px = eb.cliopatria_px(clio, 'Sq', 3, FRAMING)
        x, y = eb.lonlat_to_pixel(FRAMING, coords[:4, 0], coords[:4, 1])
        outer = abs(float(np.dot(x, np.roll(y, -1)) - np.dot(np.roll(x, -1), y))) / 2
        self.assertLess(px, outer, 'the hole taken out')
        self.assertGreater(px, 0.9 * outer)
        self.assertIsNone(eb.cliopatria_px(clio, 'Sq', 9, FRAMING), 'not alive that year')


class TwoPasses(unittest.TestCase):
    """Two labels over the sea between a giant and an islet: the one whose
    matched polity the giant mostly is takes it, whichever comes first."""

    @staticmethod
    def world():
        comp = np.zeros((400, 600), np.int32)
        comp[:, :200] = 1  # the Mamluks' Egypt
        comp[190:210, 230:250] = 2  # an islet
        def entry(cid):
            ys, xs = np.nonzero(comp == cid)
            return {'px': int(len(xs)), 'bbox': (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1),
                    'white': False, 'colour': (40, 90, 200) if cid == 1 else (200, 90, 40), 'centroid': (float(xs.mean()), float(ys.mean()))}
        table = {1: entry(1), 2: entry(2)}
        labels = [
            {'text': 'Banu Sulaym', 'x': 212, 'y': 195, 'h': 20, 'cliopatria': 'Hafsid Dynasty'},
            {'text': 'Mamluks', 'x': 218, 'y': 205, 'h': 20, 'cliopatria': 'Mamluk Sultanate'},
        ]
        return comp, table, labels

    def test_by_label_order_the_first_takes_the_giant(self):
        comp, table, labels = self.world()
        assignment = eb.name_regions(comp, table, labels)[0]
        self.assertEqual(assignment, {1: 0, 2: 1})

    def test_a_label_whose_polity_a_region_mostly_is_takes_it_first(self):
        comp, table, labels = self.world()
        def hint(label):
            if label['cliopatria'] != 'Mamluk Sultanate':
                return lambda cid: False  # the Hafsids are elsewhere
            return lambda cid: cid == 1
        assignment, joined, flags = eb.name_regions(comp, table, labels, hint)
        self.assertEqual(assignment, {1: 1, 2: 0}, "Egypt the Mamluks', the islet Banu Sulaym's")
        self.assertEqual(flags[0], {'beside'})
        self.assertEqual(flags[1], {'beside'})


if __name__ == '__main__':
    unittest.main()
