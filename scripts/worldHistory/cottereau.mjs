import { CONFIDENCES } from '../../src/data/worldHistory.js';

/**
 * Cottereau's labels as year spans on Cliopatria's polities, from
 * data/cottereau/ (matches.json, tracks.json; see docs "Cottereau's world
 * history against Cliopatria"). Each matched track's periods name the
 * Cliopatria polity under its label year by year; the samples are a second
 * of video apart, so a period runs on to the next one's start (the last to
 * the track's last year). A period matched by name or abbreviation keeps
 * Cottereau's label text, and its label stands where the video set it;
 * one matched by place alone (or carried on from another polity) is
 * labelled with the Cliopatria name, at the polygon.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

const BY_NAME = new Set(['name', 'abbreviation']);

/**
 * @param {{matches: object[]}} matchesFile matches.json
 * @param {{tracks: object[]}} [tracksFile] tracks.json (label positions)
 * @returns {{track: number, label: string, name: string, from: number,
 *   to: number, confidence: string, byName: boolean, lon?: number,
 *   lat?: number}[]}
 */
export function cottereauSpans(matchesFile, tracksFile = { tracks: [] }) {
  const where = new Map(
    (tracksFile.tracks || []).map((track) => [track.id, track]),
  );
  const spans = [];
  for (const match of matchesFile.matches || []) {
    if (!match.name || !CONFIDENCES.includes(match.confidence)) continue;
    const periods = [...(match.periods || [])].sort((a, b) => a.from - b.from);
    const lastYear = Array.isArray(match.years) ? match.years[1] : null;
    periods.forEach((period, i) => {
      if (!period.name) return;
      const next = periods[i + 1];
      const to = next
        ? Math.max(period.to, next.from - 1)
        : Math.max(period.to, Number.isFinite(lastYear) ? lastYear : period.to);
      const byName =
        match.confidence !== 'low' &&
        (BY_NAME.has(period.reason) ||
          (period.reason === 'main match' &&
            match.reason !== 'place+time+size'));
      const track = where.get(match.track);
      spans.push({
        track: match.track,
        label: byName ? String(match.text || period.name) : period.name,
        name: period.name,
        from: period.from,
        to,
        confidence: match.confidence,
        byName,
        ...(byName && Number.isFinite(track?.lon)
          ? { lon: track.lon, lat: track.lat }
          : {}),
      });
    });
  }
  return spans;
}
