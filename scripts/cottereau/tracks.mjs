/**
 * Labels tracked through the video: the same text (allowing OCR slips) at
 * about the same place in nearby samples is one track, with its first and
 * last year, its median position (lon/lat, so a track survives a change
 * of framing) and the spellings it was read as. A label moves as its
 * polity grows and shrinks, so "the same place" is a few hundred km.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import { haversineKm } from './cliopatria.mjs';

/** A name folded for comparison: lower case, accents and punctuation gone (a "." kept). */
export function foldName(text) {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’'`´]/g, '')
    .replace(/[^\p{L}\p{N}.]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Levenshtein distance. */
export function levenshtein(a, b) {
  if (a === b) return 0;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const kept = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      previous = kept;
    }
  }
  return row[b.length];
}

/** Similarity of two texts, 0 to 1, on their folded forms. */
export function textSimilarity(a, b) {
  const x = foldName(a);
  const y = foldName(b);
  if (!x.length || !y.length) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// A direction a name may say: the same polity's halves are other polities.
const DIRECTIONS = new Map([
  ['north', 'north'],
  ['northern', 'north'],
  ['south', 'south'],
  ['southern', 'south'],
  ['east', 'east'],
  ['eastern', 'east'],
  ['west', 'west'],
  ['western', 'west'],
  ['upper', 'upper'],
  ['lower', 'lower'],
]);

/** The directions a folded name says, as words or run into one ("southkorea"). */
export function directionsOf(folded) {
  const out = new Set();
  for (const word of folded.split(/[\s-]+/)) {
    if (DIRECTIONS.has(word)) out.add(DIRECTIONS.get(word));
    else
      for (const [prefix, direction] of DIRECTIONS)
        if (word.length >= prefix.length + 4 && word.startsWith(prefix))
          out.add(direction);
  }
  return out;
}

/** Whether two texts each say a direction, and not the same one ("East Francia", "West Francia"). */
export function directionsDiffer(a, b) {
  const da = directionsOf(foldName(a));
  const db = directionsOf(foldName(b));
  return da.size > 0 && db.size > 0 && ![...da].some((d) => db.has(d));
}

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** OCR slips the tracker forgives: similar enough to be the same label. */
const SAME_TEXT = 0.75;

/**
 * Track the samples' labels. `samples`: [{t, year, labels: [{text, lon,
 * lat, size}]}] in order (size: the label's line height over the
 * framing's scale, comparable across framings). A label joins the track
 * with the most similar text within `maxKm` of where it was last seen, if
 * that was at most `maxGap` samples ago; else it starts one.
 */
export function trackLabels(samples, { maxKm = 450, maxGap = 4 } = {}) {
  const tracks = [];
  const active = [];
  samples.forEach((sample, index) => {
    for (let i = active.length - 1; i >= 0; i--)
      if (index - active[i].lastIndex > maxGap) active.splice(i, 1);
    const taken = new Set();
    // Exact texts first, then the slips.
    const order = [...sample.labels].sort(
      (a, b) =>
        Number(!active.some((t) => t.lastText === b.text)) -
        Number(!active.some((t) => t.lastText === a.text)),
    );
    for (const label of order) {
      let best = null;
      let bestScore = 0;
      for (const track of active) {
        if (taken.has(track)) continue;
        const km = haversineKm(
          track.lastLon,
          track.lastLat,
          label.lon,
          label.lat,
        );
        if (km > maxKm) continue;
        const similar =
          track.lastText === label.text
            ? 1
            : textSimilarity(track.lastText, label.text);
        // East is not West: a label of the other direction is another label.
        if (similar < SAME_TEXT || directionsDiffer(track.lastText, label.text))
          continue;
        const score = similar - km / (10 * maxKm);
        if (score > bestScore) {
          bestScore = score;
          best = track;
        }
      }
      if (!best) {
        best = { id: tracks.length, points: [] };
        tracks.push(best);
        active.push(best);
      }
      taken.add(best);
      best.points.push({ t: sample.t, year: sample.year, ...label });
      best.lastText = label.text;
      best.lastLon = label.lon;
      best.lastLat = label.lat;
      best.lastIndex = index;
    }
  });
  return tracks.map(summarise);
}

/** A track's facts from its points. */
export function summarise(track) {
  const counts = new Map();
  for (const p of track.points)
    counts.set(p.text, (counts.get(p.text) || 0) + 1);
  const variants = [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([text, n]) => ({ text, n }));
  const years = track.points.map((p) => p.year);
  return {
    id: track.id,
    text: variants[0].text,
    variants,
    firstYear: Math.min(...years),
    lastYear: Math.max(...years),
    firstT: track.points[0].t,
    lastT: track.points.at(-1).t,
    samples: track.points.length,
    lon: median(track.points.map((p) => p.lon)),
    lat: median(track.points.map((p) => p.lat)),
    size: median(track.points.map((p) => p.size)),
    framings: [...new Set(track.points.map((p) => p.framing))].filter(
      (f) => f !== undefined,
    ),
    points: track.points,
  };
}

/**
 * Tracks that are one label split by the tracker (an OCR slip held for
 * longer than its gap, a label that jumped across a cut) joined: similar
 * text, close in place, and one starting about when the other ends.
 */
export function mergeTracks(
  tracks,
  { maxKm = 600, maxYears = 60, similar = 0.8 } = {},
) {
  const sorted = [...tracks].sort((a, b) => a.firstT - b.firstT);
  const out = [];
  for (const track of sorted) {
    const into = out.find(
      (o) =>
        track.firstT >= o.firstT &&
        track.firstYear - o.lastYear <= maxYears &&
        textSimilarity(o.text, track.text) >= similar &&
        !directionsDiffer(o.text, track.text) &&
        haversineKm(o.lon, o.lat, track.lon, track.lat) <= maxKm,
    );
    if (into) {
      into.points.push(...track.points);
      into.points.sort((a, b) => a.t - b.t);
      Object.assign(into, summarise({ id: into.id, points: into.points }));
    } else out.push({ ...track });
  }
  return out.map((t, i) => ({ ...t, id: i }));
}
