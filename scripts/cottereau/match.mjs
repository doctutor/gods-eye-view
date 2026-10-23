/**
 * A label track matched to a Cliopatria polity. The candidates are the
 * records alive in the track's years whose polygons hold its position or
 * come near it, grouped by name. Then, in order:
 *
 * 1. name + place: a name (or its Wikipedia title) like the label's,
 *    within NAME_KM;
 * 2. abbreviation + place: a label of abbreviated words ("Eng.", "Se.")
 *    whose every word begins one of a candidate's, in order, within
 *    ABBREVIATION_KM;
 * 3. place + time: the label sits in the polity (or within PLACE_KM) while
 *    it lives, its name no help (Cottereau's "Kievan Rus'" against
 *    Cliopatria's own name for it): the best name breaks a tie, then the
 *    label's size against the polity's area (a larger polity, a larger
 *    font: fitted on the confident matches).
 *
 * A record of the same name far away (FAR_KM and more) is never the
 * match: it is noted as refused.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import { aliveIn, boxNear, distanceKm } from './cliopatria.mjs';
import { foldName, textSimilarity } from './tracks.mjs';

export const NAME_KM = 300;
// A near-exact name may sit further off: a small polity's label is often
// set beside it (Polonnaruwa off Sri Lanka's coast).
export const EXACT_NAME_KM = 700;
export const NEAR_PLACE_KM = 250;
export const ABBREVIATION_KM = 200;
export const PLACE_KM = 50;
export const FAR_KM = 1000;

// Words a polity's name may carry that a map label leaves out.
const GENERIC = new Set(
  'the of and kingdom kingdoms empire empires sultanate caliphate dynasty khanate khaganate state states republic principality duchy grand emirate confederation confederacy chiefdom chiefdoms polity polities city cities league tribe tribes period culture people realm crown county civilization civilisation'.split(
    ' ',
  ),
);
const singular = (word) =>
  word.length > 4 && /[^s]s$/.test(word) ? word.slice(0, -1) : word;
const core = (folded) =>
  folded
    .split(' ')
    .filter((w) => !GENERIC.has(w))
    .join(' ');

/** Whether every word of an abbreviated label begins a word of the name, in order ("Se." → "Seljuk Empire"). */
export function abbreviates(label, name) {
  const words = foldName(label).split(' ').filter(Boolean);
  if (!words.some((w) => w.endsWith('.'))) return false;
  const target = foldName(name).replace(/\./g, '').split(' ').filter(Boolean);
  let at = 0;
  for (const word of words) {
    const stem = word.replace(/\.$/, '');
    if (!stem) return false;
    while (at < target.length && !target[at].startsWith(stem)) at += 1;
    if (at === target.length) return false;
    // A whole word must be the word ("Rus" is not "Russia" unless it is abbreviated).
    if (!word.endsWith('.') && target[at] !== stem) return false;
    at += 1;
  }
  return true;
}

/** How alike a label and a polity's names are, 0 to 1. */
export function nameScore(label, names) {
  const l = foldName(label).replace(/\./g, '');
  let best = 0;
  for (const name of names) {
    if (!name) continue;
    const n = foldName(name).replace(/\./g, '');
    if (!n) continue;
    if (l === n) return 1;
    best = Math.max(best, textSimilarity(l, n));
    const lc = core(l);
    const nc = core(n);
    if (lc && nc) {
      if (lc === nc) best = Math.max(best, 0.95);
      else best = Math.max(best, textSimilarity(lc, nc) * 0.97);
      // Every word of the label in the name ("Roman" in "Roman Empire"),
      // or beginning one ("Minoa" for "Minoan", "Akkad" for "Akkadian"), a
      // plural taken as its singular ("Ottomans", "Timurids").
      const words = lc.split(' ').map(singular);
      const target = nc.split(' ');
      if (
        words.every((w) =>
          target.some((t) => t === w || (w.length >= 4 && t.startsWith(w))),
        )
      )
        best = Math.max(best, 0.85);
      // A shared stem ("France" and "French Fifth Republic"): a hint, not a match.
      else if (
        words.length === 1 &&
        words[0].length >= 4 &&
        target.some(
          (t) => t.length >= 4 && t.slice(0, 4) === words[0].slice(0, 4),
        )
      )
        best = Math.max(best, 0.7);
    }
  }
  return best;
}

/**
 * The candidates of a track: Cliopatria's names alive in its years with a
 * record near its position, each {name, distanceKm, overlap (years), area,
 * wikipedia, wikidata, type, nameScore, abbreviation}.
 */
export function candidatesOf(track, records, { nearKm = 600 } = {}) {
  const groups = new Map();
  for (const record of aliveIn(records, track.firstYear, track.lastYear)) {
    if (!boxNear(record, track.lon, track.lat, nearKm)) continue;
    const km = distanceKm(record, track.lon, track.lat);
    if (km > nearKm) continue;
    let group = groups.get(record.name);
    if (!group) {
      group = {
        name: record.name,
        distanceKm: Infinity,
        overlap: 0,
        area: 0,
        wikipedia: record.wikipedia,
        wikidata: record.wikidata,
        type: record.type,
      };
      groups.set(record.name, group);
    }
    group.distanceKm = Math.min(group.distanceKm, km);
    group.overlap +=
      Math.min(record.to, track.lastYear) -
      Math.max(record.from, track.firstYear) +
      1;
    group.area = Math.max(group.area, record.area);
    group.wikipedia ||= record.wikipedia;
    group.wikidata ||= record.wikidata;
    if (record.type === 'POLITY') group.type = 'POLITY';
  }
  const names = track.variants?.map((v) => v.text) || [track.text];
  for (const group of groups.values()) {
    group.nameScore = Math.max(
      ...names.map((text) => nameScore(text, [group.name, group.wikipedia])),
    );
    group.abbreviation = names.some(
      (text) =>
        abbreviates(text, group.name) || abbreviates(text, group.wikipedia),
    );
  }
  return [...groups.values()];
}

/** The names of Cliopatria alive in a track's years like its label, wherever they are (for refusals). */
export function sameNameElsewhere(track, records, { minScore = 0.9 } = {}) {
  const out = new Map();
  for (const record of aliveIn(records, track.firstYear, track.lastYear)) {
    if (out.has(record.name)) continue;
    if (nameScore(track.text, [record.name, record.wikipedia]) < minScore)
      continue;
    out.set(record.name, record);
  }
  return [...out.values()];
}

/**
 * A size model: log10(area) from log10(label size), fitted on confident
 * matches; null until there are enough.
 */
export function fitSizeModel(pairs) {
  const xs = [];
  const ys = [];
  for (const { size, area } of pairs)
    if (size > 0 && area > 0) {
      xs.push(Math.log10(size));
      ys.push(Math.log10(area));
    }
  if (xs.length < 10) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  return { slope, intercept: my - slope * mx, n: xs.length };
}

const byBest = (key) => (a, b) => key(b) - key(a);
/** Cliopatria's bracketed twin of a polity: it with its dependencies ("(Kingdom of France)"). */
export const bracketed = (name) => /^\(.*\)$/.test(name);
/** A name less its brackets. */
export const unbracketed = (name) => String(name).replace(/^\((.*)\)$/, '$1');

/**
 * Match a track: {name, wikidata, wikipedia, confidence: high | medium |
 * low, reason, distanceKm, nameScore, alternatives} or {name: null,
 * reason} when nothing fits; `refused` lists same-name records far away.
 */
export function matchTrack(track, records, { sizeModel = null } = {}) {
  const candidates = candidatesOf(track, records);
  const result = (group, confidence, reason) => ({
    name: group.name,
    wikidata: group.wikidata || null,
    wikipedia: group.wikipedia || null,
    confidence,
    reason,
    distanceKm: Math.round(group.distanceKm),
    nameScore: Math.round(group.nameScore * 1000) / 1000,
    alternatives: candidates
      .filter((c) => c !== group)
      .sort(byBest((c) => c.nameScore - c.distanceKm / 1000))
      .slice(0, 3)
      .map((c) => ({
        name: c.name,
        distanceKm: Math.round(c.distanceKm),
        nameScore: Math.round(c.nameScore * 1000) / 1000,
      })),
  });
  const refusedOf = () =>
    sameNameElsewhere(track, records)
      .filter(
        (r) =>
          !candidates.some((c) => c.name === r.name && c.distanceKm < FAR_KM),
      )
      .map((r) => {
        const km = distanceKm(r, track.lon, track.lat);
        return km >= FAR_KM
          ? { name: r.name, distanceKm: Math.round(km) }
          : null;
      })
      .filter(Boolean);

  // 1. name + place.
  const named = candidates
    .filter(
      (c) =>
        (c.nameScore >= 0.8 && c.distanceKm <= NAME_KM) ||
        (c.nameScore >= 0.95 && c.distanceKm <= EXACT_NAME_KM),
    )
    .sort(
      byBest(
        (c) =>
          c.nameScore -
          c.distanceKm / 3000 +
          (c.type === 'POLITY' ? 0.001 : 0) -
          (bracketed(c.name) ? 0.002 : 0),
      ),
    );
  if (named.length) {
    const best = named[0];
    const confidence =
      (best.nameScore >= 0.9 && best.distanceKm <= 100) ||
      (best.nameScore >= 0.99 && best.distanceKm <= NAME_KM)
        ? 'high'
        : 'medium';
    return result(best, confidence, 'name+place');
  }
  // 2. abbreviation + place.
  const abbreviated = candidates
    .filter((c) => c.abbreviation && c.distanceKm <= ABBREVIATION_KM)
    .sort(byBest((c) => -c.distanceKm + c.nameScore * 100));
  if (abbreviated.length) {
    const best = abbreviated[0];
    // One letter ("B.") says little: a guess by place.
    const letters = Math.min(
      ...foldName(track.text)
        .split(' ')
        .map((w) => w.replace(/\./g, '').length),
    );
    const confidence =
      letters <= 1
        ? 'low'
        : abbreviated.length === 1 && best.distanceKm <= 50
          ? 'high'
          : 'medium';
    return result(best, confidence, 'abbreviation+place');
  }
  // 3. place + time.
  // Within PLACE_KM; failing that within NEAR_PLACE_KM (a city state's
  // label set apart from its neighbours'), the nearest first.
  let placed = candidates.filter((c) => c.distanceKm <= PLACE_KM);
  const nearOnly = !placed.length;
  if (nearOnly)
    placed = candidates.filter((c) => c.distanceKm <= NEAR_PLACE_KM);
  if (placed.length) {
    const predicted =
      sizeModel && track.size > 0
        ? sizeModel.intercept + sizeModel.slope * Math.log10(track.size)
        : null;
    const sizeFit = (c) =>
      predicted === null || !(c.area > 0)
        ? 0
        : -Math.abs(Math.log10(c.area) - predicted);
    // How much of the label's life the polity covers.
    const span = track.lastYear - track.firstYear + 1;
    const covers = (c) => Math.min(1, c.overlap / span);
    placed.sort(
      byBest(
        (c) =>
          (c.nameScore >= 0.5 ? c.nameScore * 10 : 0) +
          sizeFit(c) +
          covers(c) -
          c.distanceKm / 100 +
          (c.type === 'POLITY' ? 0.5 : 0),
      ),
    );
    const best = placed[0];
    const reason =
      best.nameScore >= 0.5
        ? 'place+time+name'
        : predicted !== null
          ? 'place+time+size'
          : 'place+time';
    // By place alone, with no likeness of name, it is a guess: often a
    // polity Cottereau shows inside one Cliopatria has.
    const confidence =
      !nearOnly && best.nameScore >= 0.6 && covers(best) >= 0.5
        ? 'medium'
        : 'low';
    return { ...result(best, confidence, reason), refused: refusedOf() };
  }
  return {
    name: null,
    reason: candidates.length
      ? 'nothing near enough'
      : 'no polity alive near it',
    refused: refusedOf(),
    alternatives: candidates
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, 3)
      .map((c) => ({
        name: c.name,
        distanceKm: Math.round(c.distanceKm),
        nameScore: Math.round(c.nameScore * 1000) / 1000,
      })),
  };
}

/**
 * A track's Cliopatria names year by year: a label lives through several
 * of Cliopatria's polities ("France" through its republics and empires).
 * At each sample's year, among the records alive then near the track, the
 * same choice as matchTrack's: a like name within NAME_KM (EXACT_NAME_KM
 * for an exact one), else an abbreviation within ABBREVIATION_KM, else
 * the main match while it lives, else the polity holding the label
 * ('continued' when the main match was by name: the label goes on while
 * Cliopatria renames what is under it, else 'place').
 * Consecutive years of one name are one period: [{name, wikidata, from,
 * to, reason}].
 */
export function periodsOf(track, records, main = null) {
  const near = aliveIn(records, track.firstYear, track.lastYear).filter((r) =>
    boxNear(r, track.lon, track.lat, EXACT_NAME_KM),
  );
  const texts = track.variants?.map((v) => v.text) || [track.text];
  const scores = new Map();
  const info = near.map((r) => {
    if (!scores.has(r.name))
      scores.set(r.name, {
        score: Math.max(
          ...texts.map((t) => nameScore(t, [r.name, r.wikipedia])),
        ),
        abbreviation: texts.some(
          (t) => abbreviates(t, r.name) || abbreviates(t, r.wikipedia),
        ),
      });
    return {
      record: r,
      km: distanceKm(r, track.lon, track.lat),
      ...scores.get(r.name),
    };
  });
  const choose = (year) => {
    const alive = info.filter(
      ({ record }) => record.from <= year && record.to >= year,
    );
    const named = alive
      .filter(
        (c) =>
          (c.score >= 0.8 && c.km <= NAME_KM) ||
          (c.score >= 0.95 && c.km <= EXACT_NAME_KM) ||
          (c.score >= 0.65 && c.km <= PLACE_KM),
      )
      .sort(
        (a, b) =>
          b.score - a.score ||
          Number(bracketed(a.record.name)) - Number(bracketed(b.record.name)) ||
          a.km - b.km,
      );
    if (named.length) return [named[0].record, 'name'];
    const abbreviated = alive
      .filter((c) => c.abbreviation && c.km <= ABBREVIATION_KM)
      .sort((a, b) => a.km - b.km);
    if (abbreviated.length) return [abbreviated[0].record, 'abbreviation'];
    const same =
      main?.name &&
      alive.find((c) => c.record.name === main.name && c.km <= NEAR_PLACE_KM);
    if (same) return [same.record, 'main match'];
    const placed = alive
      .filter(
        (c) =>
          c.km <= PLACE_KM &&
          c.record.type === 'POLITY' &&
          !/^\(/.test(c.record.name),
      )
      .sort((a, b) => a.km - b.km || a.record.area - b.record.area);
    // The label named its polity, and goes on while Cliopatria renames the
    // polity under it ("France": its republics and empires): continued.
    const byName = /^(name|abbreviation)/.test(main?.reason || '');
    if (placed.length)
      return [placed[0].record, byName ? 'continued' : 'place'];
    return [null, null];
  };
  const periods = [];
  const years = [...new Set((track.points || []).map((p) => p.year))].sort(
    (a, b) => a - b,
  );
  if (!years.length) years.push(track.firstYear, track.lastYear);
  for (const year of years) {
    const [record, reason] = choose(year);
    const last = periods.at(-1);
    if (record && last && last.name === record.name && last.reason === reason)
      last.to = year;
    else if (record)
      periods.push({
        name: record.name,
        wikidata: record.wikidata || null,
        from: year,
        to: year,
        reason,
      });
    else if (last && last.name !== null)
      periods.push({ name: null, from: year, to: year, reason: 'none' });
    else if (last) last.to = year;
    else periods.push({ name: null, from: year, to: year, reason: 'none' });
  }
  return periods;
}
