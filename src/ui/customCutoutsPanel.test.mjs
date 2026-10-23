// Personal fork: the CUSTOM CUTOUTS panel's words (src/ui/customCutoutsPanel.js)
// for each state of the layer, without a DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  levelTag,
  lookupText,
  rowStatus,
  statusText,
} from './customCutoutsPanel.js';

const view = (reason, cutouts = []) => ({ reason, cutouts });

test('the status line says why nothing is cut, or how many cutouts are', () => {
  assert.match(statusText(view('needs-3d')), /Google 3D map/);
  assert.match(statusText(view('no-webgl2')), /WebGL2/);
  assert.match(statusText(view('empty')), /Add a cutout/);
  assert.match(statusText(view('none-visible')), /hidden/);
  assert.equal(
    statusText(view('', [{ visible: true }, { visible: false }])),
    '1 cutout cut from Google 3D',
  );
  assert.equal(
    statusText(view('', [{ visible: true }, { visible: true }])),
    '2 cutouts cut from Google 3D',
  );
});

test('rows and lookups: levels, fetch states, and why a lookup is empty', () => {
  assert.equal(levelTag(6), 'L6');
  assert.equal(levelTag(null), '');
  assert.equal(rowStatus({ status: 'loading' }), 'LOADING');
  assert.equal(rowStatus({ status: 'failed' }), 'NOT FOUND');
  assert.equal(rowStatus({ status: 'ready' }), '');
  assert.equal(lookupText({ areas: [{}], from: 'overpass' }), '');
  assert.match(lookupText({ areas: [{}], from: 'packs' }), /bundled/);
  assert.match(
    lookupText({ areas: [], reason: 'unconfigured' }),
    /No Overpass configured/,
  );
  assert.match(lookupText({ areas: [], reason: 'failed' }), /try again/);
  assert.match(lookupText({ areas: [] }), /No administrative area/);
});
