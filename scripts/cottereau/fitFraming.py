"""
Personal fork: fit one framing of Cottereau's "History of the World: Every
Year" map: which projection, and the pixel mapping of its frame.

    D:\\gev-tools\\cottereau-venv\\Scripts\\python.exe -I fitFraming.py
        <video> <seconds> <land.json> <guess.json> <out.json> [projections]

The frame at <seconds> is decoded from the video in memory and never
written anywhere (it is Cottereau's work). Its sea is a flat light blue,
segmented into a land/sea mask, and its coastline is that mask's edge.
Natural Earth's land (src/data/local_data/natural_earth/countries.json,
decoded into land.json by fitFramings.mjs) is projected with each candidate
projection and drawn into a mask of the frame's size; the pixel mapping
x = sx * u + tx, y = ty - sy * v (u, v the projection's coordinates, in
radians) is fitted by Nelder-Mead on the chamfer distance between the two
coastlines, from the rough start in guess.json. The residuals (each
observed coastline pixel's distance to the fitted coastline, in km at its
latitude) say which projection the map is.

Only numbers leave this script: the fit, never an image.
"""

import json
import math
import sys

import cv2
import numpy as np

R_KM = 6371.0
SCALE = 0.5  # fit at half resolution (1920 x 960)

# Robinson's table: latitude 0..90 by 5, X (parallel length), Y (distance from the equator).
ROB_X = [1.0, 0.9986, 0.9954, 0.9900, 0.9822, 0.9730, 0.9600, 0.9427, 0.9216,
         0.8962, 0.8679, 0.8350, 0.7986, 0.7597, 0.7186, 0.6732, 0.6213, 0.5722, 0.5322]
ROB_Y = [0.0, 0.0620, 0.1240, 0.1860, 0.2480, 0.3100, 0.3720, 0.4340, 0.4958,
         0.5571, 0.6176, 0.6769, 0.7346, 0.7903, 0.8435, 0.8936, 0.9394, 0.9761, 1.0]


def robinson(lon, lat):
    a = np.abs(lat)
    xs = np.interp(a, np.arange(0, 91, 5), ROB_X)
    ys = np.interp(a, np.arange(0, 91, 5), ROB_Y)
    return 0.8487 * xs * np.radians(lon), 1.3523 * ys * np.sign(lat)


def inverse_robinson(u, v):
    ys = np.clip(np.abs(v) / 1.3523, 0, 1)
    lat = np.interp(ys, ROB_Y, np.arange(0, 91, 5)) * np.sign(v)
    xs = np.interp(np.abs(lat), np.arange(0, 91, 5), ROB_X)
    return np.degrees(u / (0.8487 * xs)), lat


PROJECTIONS = {
    'equirectangular': (
        lambda lon, lat: (np.radians(lon), np.radians(lat)),
        lambda u, v: (np.degrees(u), np.degrees(v)),
    ),
    'mercator': (
        lambda lon, lat: (np.radians(lon), np.log(np.tan(np.pi / 4 + np.radians(np.clip(lat, -85, 85)) / 2))),
        lambda u, v: (np.degrees(u), np.degrees(2 * np.arctan(np.exp(v)) - np.pi / 2)),
    ),
    'miller': (
        lambda lon, lat: (np.radians(lon), 1.25 * np.log(np.tan(np.pi / 4 + 0.4 * np.radians(lat)))),
        lambda u, v: (np.degrees(u), np.degrees(2.5 * np.arctan(np.exp(0.8 * v)) - 0.625 * np.pi)),
    ),
    'gall': (
        lambda lon, lat: (np.radians(lon) / math.sqrt(2), (1 + math.sqrt(2) / 2) * np.tan(np.radians(lat) / 2)),
        lambda u, v: (np.degrees(u * math.sqrt(2)), np.degrees(2 * np.arctan(v / (1 + math.sqrt(2) / 2)))),
    ),
    'robinson': (robinson, inverse_robinson),
}


def sea_mask(frame, tolerance=10):
    """The sea: the map's one flat light blue. Bluish pixels first, then only
    those close to their commonest colour (some polities are painted in
    blues near the sea's: Kievan Rus', Sweden, the Tibetan Kingdoms)."""
    b, g, r = [frame[:, :, i].astype(np.int16) for i in range(3)]
    spread = np.max(frame, axis=2).astype(np.int16) - np.min(frame, axis=2)
    bluish = (b - r >= 10) & (b - r <= 40) & (b >= 185) & (spread <= 45) & (g >= r)
    colours, counts = np.unique(frame[bluish] // 2, axis=0, return_counts=True)
    sea_colour = colours[np.argmax(counts)].astype(np.int16) * 2 + 1
    near = np.max(np.abs(frame.astype(np.int16) - sea_colour), axis=2) <= tolerance
    # The coastline's antialiased edge pixels stay with the land they blend into.
    return (bluish & near).astype(np.uint8)


def edges(mask):
    k = np.ones((3, 3), np.uint8)
    return cv2.morphologyEx(mask, cv2.MORPH_GRADIENT, k) > 0


def nelder_mead(f, x0, steps, iterations=400):
    n = len(x0)
    simplex = [np.array(x0, float)]
    for i in range(n):
        p = np.array(x0, float)
        p[i] += steps[i]
        simplex.append(p)
    values = [f(p) for p in simplex]
    for _ in range(iterations):
        order = np.argsort(values)
        simplex = [simplex[i] for i in order]
        values = [values[i] for i in order]
        centroid = np.mean(simplex[:-1], axis=0)
        reflected = centroid + (centroid - simplex[-1])
        fr = f(reflected)
        if fr < values[0]:
            expanded = centroid + 2 * (centroid - simplex[-1])
            fe = f(expanded)
            simplex[-1], values[-1] = (expanded, fe) if fe < fr else (reflected, fr)
        elif fr < values[-2]:
            simplex[-1], values[-1] = reflected, fr
        else:
            contracted = centroid + 0.5 * (simplex[-1] - centroid)
            fc = f(contracted)
            if fc < values[-1]:
                simplex[-1], values[-1] = contracted, fc
            else:
                for i in range(1, n + 1):
                    simplex[i] = simplex[0] + 0.5 * (simplex[i] - simplex[0])
                    values[i] = f(simplex[i])
        if np.max(np.abs(np.array(values) - values[0])) < 1e-4:
            break
    best = int(np.argmin(values))
    return simplex[best], values[best]


def main():
    video, seconds, land_file, guess_file, out_file = sys.argv[1:6]
    wanted = sys.argv[6].split(',') if len(sys.argv) > 6 else list(PROJECTIONS)
    capture = cv2.VideoCapture(video)
    capture.set(cv2.CAP_PROP_POS_MSEC, float(seconds) * 1000)
    ok, frame = capture.read()
    capture.release()
    if not ok:
        raise SystemExit(f'no frame at {seconds} s')
    height, width = frame.shape[:2]
    guess = json.load(open(guess_file, encoding='utf8'))
    small = cv2.resize(frame, (int(width * SCALE), int(height * SCALE)), interpolation=cv2.INTER_AREA)
    h, w = small.shape[:2]
    sea = sea_mask(small)
    valid = np.ones((h, w), bool)
    for x0, y0, x1, y1 in guess.get('ignore', []):  # the year box, the title
        valid[int(y0 * SCALE):int(y1 * SCALE), int(x0 * SCALE):int(x1 * SCALE)] = False
    observed = edges(sea) & valid
    # Distance from every pixel to the nearest observed coastline pixel.
    dist_obs = cv2.distanceTransform((~observed).astype(np.uint8), cv2.DIST_L2, 3)
    rings = [np.array(r, float) for r in json.load(open(land_file, encoding='utf8'))]
    results = {}
    for name in wanted:
        forward, inverse = PROJECTIONS[name]
        projected = [forward(r[:, 0], r[:, 1]) for r in rings]
        # A start from the rough control points: least squares per axis.
        cps = guess['controlPoints']
        u, v = forward(np.array([c['lon'] for c in cps], float), np.array([c['lat'] for c in cps], float))
        px = np.array([c['x'] for c in cps], float)
        py = np.array([c['y'] for c in cps], float)
        sx, tx = np.polyfit(u, px, 1)
        msy, ty = np.polyfit(v, py, 1)
        start = [sx, tx, -msy, ty]

        def render(params):
            sx, tx, sy, ty = params
            mask = np.zeros((h, w), np.uint8)
            polys = []
            for pu, pv in projected:
                xs = (sx * pu + tx) * SCALE
                ys = (ty - sy * pv) * SCALE
                if xs.max() < -50 or xs.min() > w + 50 or ys.max() < -50 or ys.min() > h + 50:
                    continue
                polys.append(np.stack([xs, ys], axis=1).round().astype(np.int32))
            cv2.fillPoly(mask, polys, 1)
            return mask

        def cost(params):
            land = render(params)
            rendered = edges(1 - land) & valid
            if rendered.sum() < 100:
                return 1e9
            # Both ways: rendered to observed, observed to rendered.
            dist_ren = cv2.distanceTransform((~rendered).astype(np.uint8), cv2.DIST_L2, 3)
            a = np.minimum(dist_obs[rendered], 25).mean()
            b = np.minimum(dist_ren[observed], 25).mean()
            return a + b

        best, value = nelder_mead(cost, start, [abs(start[0]) * 0.02, 40, abs(start[2]) * 0.02, 40], 300)
        best, value = nelder_mead(cost, best, [abs(best[0]) * 0.004, 8, abs(best[2]) * 0.004, 8], 300)
        # Residuals in km: each observed coastline pixel's distance to the fitted one.
        land = render(best)
        rendered = edges(1 - land) & valid
        dist_ren = cv2.distanceTransform((~rendered).astype(np.uint8), cv2.DIST_L2, 3)
        ys, xs = np.nonzero(observed)
        d_px = dist_ren[ys, xs] / SCALE  # full-resolution pixels
        sx, tx, sy, ty = best
        uu = (xs / SCALE - tx) / sx
        vv = (ty - ys / SCALE) / sy
        lon, lat = inverse(uu, vv)
        # Local km per pixel: horizontal and vertical by finite differences, their geometric mean.
        lon2, lat2 = inverse(uu + 1 / sx, vv)
        lon3, lat3 = inverse(uu, vv - 1 / sy)
        kx = R_KM * np.radians(np.abs(lon2 - lon)) * np.cos(np.radians(lat))
        ky = R_KM * np.radians(np.abs(lat3 - lat))
        km = d_px * np.sqrt(kx * ky)
        inside = np.isfinite(km)
        km = km[inside]
        results[name] = {
            'sx': float(sx), 'tx': float(tx), 'sy': float(sy), 'ty': float(ty),
            'aspect': float(sy / sx),
            'cost': float(value),
            # The tail is mostly what the reference lacks (Natural Earth's
            # countries count the Great Lakes as land; the video draws them
            # as water) and islets: the median and p75 measure the fit.
            'residualKm': {
                'median': float(np.median(km)),
                'p75': float(np.percentile(km, 75)),
                'p90': float(np.percentile(km, 90)),
                'mean': float(np.mean(np.minimum(km, 500))),
                'within25': float(np.mean(km <= 25)),
            },
            'coastPixels': int(observed.sum()),
        }
        print(name, json.dumps(results[name]['residualKm']), 'aspect', round(sy / sx, 4), 'cost', round(value, 3))
    json.dump({'frame': {'width': width, 'height': height, 'seconds': float(seconds)}, 'fits': results}, open(out_file, 'w', encoding='utf8'), indent=1)


if __name__ == '__main__':
    main()
