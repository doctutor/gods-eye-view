// Personal fork: the Titles toggle's preference: the link wins on load,
// then this browser's, then on; and the link's `ui` param round-trips.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TITLES_STORAGE_KEY,
  createTitlesPreference,
  decodeTitlesParam,
  encodeTitlesParam,
  titlesFromHash,
} from './titles.js';

const memory = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
};
const fakeHost = () => {
  const calls = [];
  return { calls, set: (v) => calls.push(v), get: () => calls.at(-1) };
};

test('the Titles setting round-trips through the ui param beside the panels', () => {
  const params = new URLSearchParams({ v: '2', ui: 'd.c.0_c.c.1.x' });
  encodeTitlesParam(params, false);
  assert.equal(params.get('ui'), 'd.c.0_c.c.1.x_tl.v.0');
  assert.equal(decodeTitlesParam(params), false);
  // Written again, never twice.
  encodeTitlesParam(params, false);
  assert.equal(params.get('ui'), 'd.c.0_c.c.1.x_tl.v.0');
  // On is the default: nothing written, the panels' part kept.
  encodeTitlesParam(params, true);
  assert.equal(params.get('ui'), 'd.c.0_c.c.1.x');
  assert.equal(decodeTitlesParam(params), null);
  const alone = new URLSearchParams({ v: '2' });
  encodeTitlesParam(alone, true);
  assert.equal(alone.has('ui'), false);
  encodeTitlesParam(alone, false);
  assert.equal(titlesFromHash(`#${alone}`), false);
  // A link of another version carries no setting.
  assert.equal(decodeTitlesParam(new URLSearchParams({ ui: 'tl.v.0' })), null);
  assert.equal(titlesFromHash(''), null);
});

test('the link wins on load, then the stored choice, then on', () => {
  const stored = memory({ [TITLES_STORAGE_KEY]: '0' });
  const host = fakeHost();
  const fromLink = createTitlesPreference({
    storage: stored,
    hash: '#v=2&ui=tl.v.1',
    host,
  });
  assert.equal(fromLink.get(), true);
  assert.deepEqual(host.calls, [true]);
  assert.equal(
    createTitlesPreference({
      storage: stored,
      hash: '#v=2',
      host: fakeHost(),
    }).get(),
    false,
  );
  assert.equal(
    createTitlesPreference({
      storage: memory(),
      hash: '',
      host: fakeHost(),
    }).get(),
    true,
  );
});

test('a change is applied to the host, kept and told', () => {
  const storage = memory();
  const host = fakeHost();
  const titles = createTitlesPreference({ storage, hash: '', host });
  const told = [];
  const off = titles.subscribe((v) => told.push(v));
  titles.set(false);
  titles.set(false);
  assert.deepEqual(host.calls, [true, false]);
  assert.equal(storage.map.get(TITLES_STORAGE_KEY), '0');
  assert.deepEqual(told, [false]);
  off();
  titles.set(true);
  assert.deepEqual(told, [false]);
  assert.equal(storage.map.get(TITLES_STORAGE_KEY), '1');
});
