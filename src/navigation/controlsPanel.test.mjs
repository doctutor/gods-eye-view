// Personal fork: the Walk and Fly Controls card's key capture
// (src/navigation/controlsPanel.js): Esc cancels, Backspace clears,
// refusals said and the capture kept, the keys named.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTION_LABELS,
  createKeyCapture,
  keyLabel,
  refusalMessage,
} from './controlsPanel.js';
import { ACTIONS, createNavSettings } from './settings.js';

const fresh = () => createNavSettings({ storage: null });

test('every action has a label, and keys are named as on the keyboard', () => {
  for (const action of ACTIONS) assert.ok(ACTION_LABELS[action], action);
  assert.equal(keyLabel('KeyW'), 'W');
  assert.equal(keyLabel('Digit3'), '3');
  assert.equal(keyLabel('ArrowUp'), '↑');
  assert.equal(keyLabel('ShiftLeft'), 'Left Shift');
  assert.equal(keyLabel('Space'), 'Space');
  assert.equal(keyLabel('Escape'), 'Esc');
  assert.equal(keyLabel('Numpad8'), 'Numpad 8');
  assert.equal(keyLabel(''), '—');
  assert.equal(keyLabel('IntlRo'), 'IntlRo');
});

test('the capture: a key binds, Esc cancels, Backspace clears', () => {
  const settings = fresh();
  const capture = createKeyCapture(settings);
  assert.equal(capture.key({ code: 'KeyR' }), null, 'not listening');
  capture.start('sprint');
  assert.equal(capture.action, 'sprint');
  assert.deepEqual(capture.key({ code: 'KeyR' }), {
    outcome: 'bound',
    message: 'Sprint: R',
  });
  assert.equal(capture.action, null);
  assert.deepEqual(settings.codesFor('sprint'), ['KeyR']);
  // Esc cancels: nothing changes.
  capture.start('jump');
  assert.equal(capture.key({ code: 'Escape' }).outcome, 'cancelled');
  assert.deepEqual(settings.codesFor('jump'), ['Space']);
  // Backspace clears.
  capture.start('jump');
  assert.deepEqual(capture.key({ code: 'Backspace' }), {
    outcome: 'cleared',
    message: 'Jump (Fly: up): no key',
  });
  assert.deepEqual(settings.codesFor('jump'), []);
  assert.equal(capture.start('bogus'), null);
});

test('refused keys are said, and the capture keeps listening', () => {
  const settings = fresh();
  const capture = createKeyCapture(settings);
  capture.start('jump');
  let result = capture.key({ code: 'KeyH' });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.message, 'H is one of the app’s own shortcuts');
  assert.equal(capture.action, 'jump', 'still listening');
  result = capture.key({ code: 'KeyA' });
  assert.equal(result.message, 'A is already Left');
  result = capture.key({ code: 'ControlLeft' });
  assert.equal(
    result.message,
    'Left Ctrl belongs to the browser (Ctrl+W closes the tab)',
  );
  assert.equal(
    capture.key({ code: 'F5' }).message,
    'F5 belongs to the browser',
  );
  assert.equal(capture.key({ code: 'KeyJ' }).outcome, 'bound');
  assert.deepEqual(settings.codesFor('jump'), ['KeyJ']);
  assert.equal(
    refusalMessage({ ok: false, reason: 'invalid' }, 'KeyQ'),
    'Q cannot be bound',
  );
});
