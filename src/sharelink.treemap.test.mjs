// Personal fork: the TREEMAP panel's token in the share link's `ui` param.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ShareLinkManager,
  decodePanelStateParams,
  SHARE_PANEL_TOKENS,
  SHARE_PANEL_RETIRED_TOKENS,
  SHARE_UI_OTHER_TOKENS,
} from './sharelink.js';

const encode = (specs) => {
  const params = new URLSearchParams('v=2');
  ShareLinkManager.prototype._encodePanelStateParam.call(null, params, {
    specs,
  });
  return params;
};

test('the treemap panel’s state round-trips on its own token', () => {
  for (const collapsed of [false, true]) {
    const params = encode([{ id: 'treemap-panel', collapsed }]);
    assert.equal(params.get('ui'), `tm.c.${collapsed ? 1 : 0}`);
    const decoded = decodePanelStateParams(new URLSearchParams(params));
    assert.deepEqual(
      decoded.specs.map(({ id, collapsed: c }) => [id, c]),
      [['treemap-panel', collapsed]],
    );
  }
  // Beside another panel, each keeps its own.
  const both = decodePanelStateParams(
    encode([
      { id: 'cctv-panel', collapsed: true },
      { id: 'treemap-panel', collapsed: false },
    ]),
  );
  assert.deepEqual(
    both.specs.map(({ id, collapsed }) => [id, collapsed]).sort(),
    [
      ['cctv-panel', true],
      ['treemap-panel', false],
    ],
  );
});

test('a retired token opens nothing, and no live panel reuses one', () => {
  assert.equal(
    decodePanelStateParams(new URLSearchParams('v=2&ui=k.c.0')),
    null,
  );
  assert.equal(new Set(SHARE_PANEL_TOKENS).size, SHARE_PANEL_TOKENS.length);
  for (const token of [...SHARE_PANEL_RETIRED_TOKENS, ...SHARE_UI_OTHER_TOKENS])
    assert.ok(!SHARE_PANEL_TOKENS.includes(token), token);
  assert.ok(SHARE_PANEL_TOKENS.includes('tm'));
});
