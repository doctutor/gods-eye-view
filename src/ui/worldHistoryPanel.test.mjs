// Personal fork: the WORLD HISTORY panel's words (src/ui/worldHistoryPanel.js)
// for each state of the layer, and its picker's ranking, without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  entryTag,
  filterNames,
  statusText,
  yearNote,
} from './worldHistoryPanel.js';
import {
  areaText,
  cardDetails,
  spanText,
  wikipediaUrl,
  yearText,
} from '../layers/worldHistory/presentation.js';

const view = (patch) => ({
  enabled: true,
  status: 'ready',
  mode: 'cottereau',
  year: -500,
  count: 10,
  ...patch,
});

test('the status line: off, not built, failed, loading, and how many polities show', () => {
  assert.match(statusText(view({ enabled: false })), /off/);
  assert.match(
    statusText(view({ status: 'not-built' })),
    /npm run world-history:build/,
  );
  assert.match(
    statusText(view({ status: 'failed', error: 'HTTP 500' })),
    /HTTP 500/,
  );
  assert.equal(statusText(view({ status: 'loading' })), 'Loading 500 BC…');
  assert.equal(statusText(view({})), '10 polities Cottereau shows in 500 BC');
  assert.equal(
    statusText(view({ count: 1, year: 1 })),
    '1 polity Cottereau shows in 1 AD',
  );
  assert.equal(
    statusText(view({ mode: 'all', count: 137, year: 1500 })),
    '137 Cliopatria polities in 1500 AD',
  );
});

test('years, spans, areas, the 2025 note and the list tags', () => {
  assert.equal(yearText(-500), '500 BC');
  assert.equal(yearText(1), '1 AD');
  assert.equal(spanText(-27, 476), '27 BC – 476 AD');
  assert.equal(spanText(1066, 1066), '1066 AD');
  assert.equal(areaText(5263199), '5,263,199 km²');
  assert.equal(
    yearNote(view({ year: 2025 })),
    'Cliopatria ends in 2024: 2025 shows 2024',
  );
  assert.equal(yearNote(view({ year: 2024 })), '');
  assert.equal(entryTag({ state: 'absent' }, -500), 'NOT IN 500 BC');
  assert.equal(entryTag({ state: 'absent' }, 2025), 'NOT IN 2024 AD');
  assert.equal(entryTag({ state: 'loading' }, 1), 'LOADING');
  assert.equal(entryTag({ state: 'failed' }, 1), 'FAILED');
  assert.equal(entryTag({ state: 'ready' }, 1), '');
});

test('the card: Cottereau’s label over Cliopatria’s name, years, area, Wikipedia, the credit', () => {
  const record = {
    name: 'Roman Empire',
    from: -31,
    to: 394,
    area: 5263199,
    wikipedia: 'Roman Empire',
  };
  assert.deepEqual(cardDetails(record, { title: 'Roman' }), [
    'Cliopatria: Roman Empire',
    '31 BC – 394 AD',
    '5,263,199 km²',
    'Wikipedia: Roman Empire',
    'Cliopatria (Seshat Global History Databank), CC BY 4.0',
  ]);
  assert.equal(
    cardDetails(record, { title: 'Roman Empire' })[0],
    '31 BC – 394 AD',
  );
  assert.equal(
    wikipediaUrl("Kingdom of Ma'in"),
    "https://en.wikipedia.org/wiki/Kingdom_of_Ma'in",
  );
  assert.equal(wikipediaUrl(''), '');
});

test('the picker: a name starting so first, then a word, then anywhere; each by size', () => {
  const names = [
    { name: '(Alliance of Alpha and Beta)', area: 12000 },
    { name: 'Alpha Kingdom', area: 5000 },
    { name: 'Greater Alpha', area: 9000 },
    { name: 'Kalpa', area: 99999 },
    { name: 'Ålpine Union', area: 10 },
    { name: 'Beta', area: 1 },
  ];
  assert.deepEqual(
    filterNames(names, 'alp').map((n) => n.name),
    [
      'Alpha Kingdom',
      'Ålpine Union',
      '(Alliance of Alpha and Beta)',
      'Greater Alpha',
      'Kalpa',
    ],
  );
  assert.deepEqual(
    filterNames(names, 'alpha k').map((n) => n.name),
    ['Alpha Kingdom'],
  );
  assert.deepEqual(
    filterNames(names, '', 2).map((n) => n.name),
    ['Kalpa', '(Alliance of Alpha and Beta)'],
  );
  assert.deepEqual(filterNames(names, 'zzz'), []);
});
