"""
Personal fork: tests of extractBorders.py on synthetic frames drawn here
(no frame of the video): the regions between border lines and colour
changes, label text painted out, an exclave joined to its polity, a region
two labels share split, a colour with no label kept apart, the projection
both ways and pixel areas; the split's nearest label in chunks (the dense
answer, within a memory bound for a region holding many labels), a
frame without sea skipped, and a small polity's label beside a giant
bounded by its matched polity's area (beside and by joins), and the
labels whose own polity a region mostly is choosing first. Run by src/tooling/cottereauBorders.test.mjs
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
