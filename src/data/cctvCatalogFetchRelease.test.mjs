import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  loadAustinSourcesFromOpenData,
  loadCalgarySourcesFromOpenData,
  loadCaltransSourcesFromOpenData,
  loadDelDOTSourcesFromOpenData,
  loadDriveBcSourcesFromOpenData,
  loadFintrafficSourcesFromOpenData,
  loadMdotSourcesFromOpenData,
  loadNswSourcesFromOpenData,
  loadOntarioSourcesFromOpenData,
  loadTarkteeSourcesFromDatex,
  loadTflSourcesFromOpenData,
  loadTxdotSourcesFromOpenData,
  loadVegvesenSourcesFromOpenData,
} from '../../server/providers/cctv/sources.js';
import { discardResponseBody } from '../../server/providers/common/http.js';

/**
 * A response whose body is a live stream that never ends, plus a flag that
 * flips when the stream is cancelled. Dropping such a response leaves undici's
 * parser paused on a body nobody drains; when the upstream later closes the TLS
 * socket the parser can hit `assert(!this.paused)` and crash the dev server
 * (seen after "[CCTV] Ontario 511 camera download failed: 400").
 */
const streamingResponse = (init = {}) => {
  const state = { cancelled: false };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"error":'));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { response: new Response(body, init), state };
};

/** Mock fetch so every call answers with a fresh streaming response. */
const mockFetch = (t, init) => {
  const issued = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const entry = streamingResponse(init);
    issued.push(entry);
    return entry.response;
  });
  return issued;
};

const CATALOG_LOADERS = {
  Austin: loadAustinSourcesFromOpenData,
  Calgary: loadCalgarySourcesFromOpenData,
  Caltrans: loadCaltransSourcesFromOpenData,
  DelDOT: loadDelDOTSourcesFromOpenData,
  DriveBC: loadDriveBcSourcesFromOpenData,
  Fintraffic: loadFintrafficSourcesFromOpenData,
  MDOT: loadMdotSourcesFromOpenData,
  NSW: loadNswSourcesFromOpenData,
  Ontario: loadOntarioSourcesFromOpenData,
  Tarktee: loadTarkteeSourcesFromDatex,
  TfL: loadTflSourcesFromOpenData,
  TxDOT: loadTxdotSourcesFromOpenData,
  Vegvesen: loadVegvesenSourcesFromOpenData,
};

for (const [name, load] of Object.entries(CATALOG_LOADERS)) {
  test(`${name}: a non-OK catalog response is cancelled, not dropped`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const issued = mockFetch(t, { status: 400 });
    assert.deepEqual(await load(), []);
    assert.ok(issued.length > 0, 'the loader fetched its catalog');
    issued.forEach(({ state }, index) =>
      assert.equal(state.cancelled, true, `response #${index} was cancelled`),
    );
  });
}

for (const [name, load] of Object.entries({
  Calgary: loadCalgarySourcesFromOpenData,
  Fintraffic: loadFintrafficSourcesFromOpenData,
  MDOT: loadMdotSourcesFromOpenData,
  Vegvesen: loadVegvesenSourcesFromOpenData,
})) {
  test(`${name}: a refused redirect is cancelled, not dropped`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    const issued = mockFetch(t, {
      status: 302,
      headers: { Location: 'https://example.invalid/' },
    });
    assert.deepEqual(await load(), []);
    assert.equal(issued.length, 1);
    assert.equal(issued[0].state.cancelled, true);
  });
}

test('Tarktee: when one DATEX request rejects, the other response is released', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const survivor = streamingResponse({ status: 200 });
  let call = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    call += 1;
    if (call === 1) throw new Error('network down');
    return survivor.response;
  });
  assert.deepEqual(await loadTarkteeSourcesFromDatex(), []);
  assert.equal(call, 2);
  assert.equal(survivor.state.cancelled, true);
});

test('discardResponseBody never throws', async () => {
  await discardResponseBody(undefined);
  await discardResponseBody(null);
  await discardResponseBody(new Response(null, { status: 204 }));

  const consumed = new Response('done');
  await consumed.text();
  await discardResponseBody(consumed);

  const locked = streamingResponse();
  locked.response.body.getReader();
  await discardResponseBody(locked.response);
  assert.equal(locked.state.cancelled, false, 'a locked body is left alone');

  const live = streamingResponse();
  await discardResponseBody(live.response);
  assert.equal(live.state.cancelled, true);
});
