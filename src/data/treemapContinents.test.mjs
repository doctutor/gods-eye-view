// Personal fork: the treemap's continents (treemapContinents.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  TREEMAP_CONTINENTS,
  TREEMAP_CONTINENT_CODES,
  continentOfCountry,
  treemapContinent,
} from './treemapContinents.js';

test('seven continents, every code in exactly one, boxes in degrees', () => {
  assert.equal(TREEMAP_CONTINENTS.length, 7);
  assert.equal(
    new Set(TREEMAP_CONTINENT_CODES).size,
    TREEMAP_CONTINENT_CODES.length,
  );
  for (const code of TREEMAP_CONTINENT_CODES) assert.match(code, /^[A-Z]{2}$/);
  for (const { id, box } of TREEMAP_CONTINENTS) {
    assert.equal(treemapContinent(id).id, id);
    const [w, s, e, n] = box;
    assert.ok(Math.abs(w) <= 180 && Math.abs(e) <= 180 && s < n, id);
  }
  // The areas build's codes include Overture's disputed X* areas; about 250
  // ISO codes and the X* ones.
  assert.ok(TREEMAP_CONTINENT_CODES.length >= 270);
});

test("a country's continent: M49, the Americas split at Panama", () => {
  const cases = {
    FR: 'europe',
    RU: 'europe',
    TR: 'asia',
    CY: 'asia',
    EG: 'africa',
    PA: 'north-america',
    CO: 'south-america',
    GL: 'north-america',
    AU: 'oceania',
    AQ: 'antarctica',
    XK: 'europe',
    fr: 'europe',
  };
  for (const [code, continent] of Object.entries(cases))
    assert.equal(continentOfCountry(code), continent, code);
  assert.equal(continentOfCountry('ZZ'), null);
  assert.equal(continentOfCountry(null), null);
  assert.equal(treemapContinent('atlantis'), null);
});
