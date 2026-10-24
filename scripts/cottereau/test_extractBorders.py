"""
Personal fork: tests of extractBorders.py on synthetic frames drawn here
(no frame of the video): the regions between border lines and colour
changes, label text painted out, an exclave joined to its polity, a region
two labels share split, a colour with no label kept apart, the projection
both ways and pixel areas. Run by src/tooling/cottereauBorders.test.mjs
(or directly: python -I test_extractBorders.py).
"""

import importlib.util
import math
import os
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


if __name__ == '__main__':
    unittest.main()
