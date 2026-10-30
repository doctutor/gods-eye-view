// Personal fork: which mutations re-run the panel rails' layout
// (src/ui/panelLayoutController.js isLayoutMutation): panels coming and
// going and the classes that move them, never text or the panels' insides,
// whose sizes the ResizeObservers report.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isLayoutMutation } from './panelLayoutController.js';

/** A fake element: its parent, its id and the selectors it matches. */
const element = (id, parent = null, matches = []) => ({
  id,
  parentElement: parent,
  matches: (selector) =>
    selector.split(',').some((part) => matches.includes(part.trim())),
});

test('the rails re-lay out for panels added or removed and for the classes that move them; not for text, nor for anything inside a panel', () => {
  const stack = element('right-context-rail');
  const hud = element('intel-hud');
  const panel = element('pp-toggles', stack);
  const control = element('lego-sides', element('lego-wrap', panel));
  const status = element('lego-status', element('lego-wrap', panel));
  const obstacle = element('hud-top-right', hud, ['#intel-hud .hud-top-right']);
  const compass = element('hud-compass', element('hud-bottom', hud));
  const scope = {
    stack,
    hud,
    obstacleSelector: '#intel-hud .hud-top-right, #command-dock',
  };
  const yes = (record) => assert.equal(isLayoutMutation(record, scope), true);
  const no = (record) => assert.equal(isLayoutMutation(record, scope), false);
  // A panel added to or taken from the rail.
  yes({ type: 'childList', target: stack });
  // A panel collapsed, floated or hidden; the HUD's variant; an obstacle's class.
  yes({ type: 'attributes', attributeName: 'class', target: panel });
  yes({ type: 'attributes', attributeName: 'hidden', target: panel });
  yes({ type: 'attributes', attributeName: 'class', target: stack });
  yes({ type: 'attributes', attributeName: 'data-variant', target: hud });
  yes({ type: 'attributes', attributeName: 'class', target: obstacle });
  // The Blocks status line's text, a control hidden in a panel, the compass
  // inside the HUD: sizes, for the ResizeObservers.
  no({ type: 'childList', target: status });
  no({ type: 'characterData', target: status });
  no({ type: 'attributes', attributeName: 'hidden', target: control });
  no({ type: 'attributes', attributeName: 'hidden', target: compass });
  no({ type: 'childList', target: panel });
  no(null);
  no({ type: 'attributes' });
});
