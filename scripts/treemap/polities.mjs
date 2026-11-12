// Personal fork: the treemap's m2/polity-area table: the area of every
// Cliopatria polity alive in each 50-year period, as the World history
// index (`npm run world-history:build`) holds it. Not part of upstream
// God's Eye View.
//
// A period is sampled at its middle year (the last period at Cliopatria's
// last year): each polity record alive then counts with the area
// Cliopatria gives it. Relations (a polity's union with its members) are
// left out, and so is a member (MemberOf) whose parent is alive then: the
// parent, a name in brackets like "(British Empire)", holds its members'
// land, and is labelled without the brackets. Land that two polities
// claim counts in each.
import fs from 'node:fs';
import path from 'node:path';
import { encodeTable } from '../../server/providers/treemap/table.js';
import { CLIOPATRIA_LAST_YEAR } from '../../src/data/worldHistory.js';

export const POLITIES_TABLE_VERSION = 3;
export const PERIOD_YEARS = 50;
export const FIRST_PERIOD = -3400;

/** The World history index current.json names: {id, index}. */
export function readWorldHistory(dir) {
  const { manifest: name } = JSON.parse(
    fs.readFileSync(path.join(dir, 'current.json'), 'utf8'),
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const index = JSON.parse(
    fs.readFileSync(path.join(dir, manifest.index), 'utf8'),
  );
  return { id: manifest.id || name, index };
}

const yearText = (year) => (year < 0 ? `${-year} BCE` : `${year}`);
/** A period's label: "1900–1949", "500 BCE–451 BCE". */
export const periodLabel = (start, end) =>
  `${yearText(start)}–${yearText(end)}`;
/** A polity's key: its name, a "/" (the path's separator) made "∕". */
export const polityKey = (name) => name.replace(/\//g, '∕');

/**
 * @param {{index: object, lastYear?: number}} options the loaded World
 *   history index ({records: [{name, from, to, area (km²), type, box}]})
 */
export function buildPolitiesTable({ index, lastYear = CLIOPATRIA_LAST_YEAR }) {
  const records = index.records.filter(
    (record) => record.type !== 'relation' && record.name && record.area > 0,
  );
  const rows = [];
  const labels = { 'history.period': {}, 'history.polity': {} };
  const geo = { 'history.period': {}, 'history.polity': {} };
  let periods = 0;
  for (let start = FIRST_PERIOD; start <= lastYear; start += PERIOD_YEARS) {
    const end = Math.min(start + PERIOD_YEARS - 1, lastYear);
    let year = Math.min(start + PERIOD_YEARS / 2, lastYear);
    if (year === 0) year = 1;
    const living = records.filter(
      (record) => record.from <= year && record.to >= year,
    );
    const names = new Set(living.map((record) => record.name));
    const alive = new Map();
    for (const record of living) {
      // A member of a polity alive then is inside its parent's land.
      if (record.memberOf && names.has(record.memberOf)) continue;
      const key = polityKey(record.name);
      const held = alive.get(key);
      if (!held || record.area > held.area) alive.set(key, record);
    }
    if (!alive.size) continue;
    periods++;
    const period = String(start);
    labels['history.period'][period] = periodLabel(start, end);
    for (const [key, record] of alive) {
      labels['history.polity'][key] = record.name.replace(/^\((.*)\)$/, '$1');
      if (record.box && !geo['history.polity'][key])
        geo['history.polity'][key] = `box:${record.box.join(',')}`;
      rows.push({
        keys: [period, key],
        value: record.area * 1e6,
        count: 1,
      });
    }
  }
  return {
    table: encodeTable({
      variable: 'm2/polity-area',
      dims: ['history.period', 'history.polity'],
      rows,
      labels,
      geo,
      exact: false,
      note: 'Each polity as Cliopatria draws it at the middle year of the period; land two polities claim counts in each. Above the periods the total is no area: periods are added, so the same land is counted once per period.',
      attribution: 'Cliopatria (Seshat Global History Databank), CC BY 4.0',
    }),
    stats: { periods, rows: rows.length },
  };
}
