// Personal fork: both loopback addresses (build/loopback.js). A Node client
// racing localhost's addresses (net autoSelectFamily, 250 ms a try) with a
// busy event loop gives up on the one the server bound and lands where none
// listens; the twin listener, or a client that does not race, connects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  connectWithoutRace,
  listenOnBothLoopbacks,
  loopbackPlugin,
  otherLoopback,
} from '../../build/loopback.js';

const listen = (server, port, host) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server.address().port));
  });
const close = (server) =>
  new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
const answering = (name) => (req, res) => res.end(name);

/** One GET on its own connection: the body, or the error's code. */
const get = (host, port) =>
  new Promise((resolve) => {
    http
      .get({ host, port, path: '/', agent: false }, (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve(body));
      })
      .on('error', (error) => resolve(error.code || error.message));
  });

/** Whether this machine can bind both loopback addresses. */
async function bothLoopbacks() {
  for (const host of ['::1', '127.0.0.1']) {
    const probe = http.createServer();
    try {
      await listen(probe, 0, host);
    } catch {
      return false;
    } finally {
      probe.close();
    }
  }
  return true;
}

test('otherLoopback: each loopback address names the other; any other bind none', () => {
  assert.equal(otherLoopback('::1'), '127.0.0.1');
  assert.equal(otherLoopback('::ffff:127.0.0.1'), '127.0.0.1');
  assert.equal(otherLoopback('127.0.0.1'), '::1');
  for (const address of ['::', '0.0.0.0', '192.168.1.20', 'fe80::1', undefined])
    assert.equal(otherLoopback(address), null);
});

test('a server bound to one loopback address answers on the other too, until it closes', async (t) => {
  if (!(await bothLoopbacks())) return t.skip('no IPv6 loopback here');
  const server = http.createServer(answering('A'));
  const both = listenOnBothLoopbacks(server, answering('A'), {
    warn: () => {},
  });
  const port = await listen(server, 0, '::1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await get('::1', port), 'A');
  assert.equal(await get('127.0.0.1', port), 'A');
  assert.ok(both.twin());
  await close(server);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(both.twin(), null);
  assert.equal(await get('127.0.0.1', port), 'ECONNREFUSED');
});

test('across a restart the new server takes the other address once the old one lets it go', async (t) => {
  if (!(await bothLoopbacks())) return t.skip('no IPv6 loopback here');
  const first = http.createServer(answering('A'));
  listenOnBothLoopbacks(first, answering('A'), { warn: () => {} });
  const port = await listen(first, 0, '127.0.0.1');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await get('::1', port), 'A');
  // Vite's restart: the old server closes, the new one listens at once.
  const closing = close(first);
  const second = http.createServer(answering('B'));
  const both = listenOnBothLoopbacks(second, answering('B'), {
    warn: () => {},
    wait: 20,
  });
  await closing;
  await listen(second, port, '127.0.0.1');
  for (let i = 0; i < 50 && !both.twin()?.listening; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await get('::1', port), 'B');
  assert.equal(await get('127.0.0.1', port), 'B');
  await close(second);
});

test('a wildcard or LAN bind gets no twin; an address another process holds is a warning, not a failure', async (t) => {
  const wildcard = http.createServer(answering('W'));
  const none = listenOnBothLoopbacks(wildcard, answering('W'));
  await listen(wildcard, 0, '0.0.0.0');
  assert.equal(none.twin(), null);
  await close(wildcard);
  if (!(await bothLoopbacks())) return t.skip('no IPv6 loopback here');
  const holder = http.createServer(answering('other process'));
  const port = await listen(holder, 0, '127.0.0.1');
  const server = http.createServer(answering('A'));
  const warnings = [];
  const both = listenOnBothLoopbacks(server, answering('A'), {
    warn: (line) => warnings.push(line),
    wait: 5,
    tries: 3,
  });
  await listen(server, port, '::1');
  for (let i = 0; i < 50 && !warnings.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(
    warnings[0],
    /not answering on 127\.0\.0\.1:\d+ too \(EADDRINUSE\)/,
  );
  assert.equal(both.twin(), null);
  assert.equal(await get('::1', port), 'A');
  await close(server);
  await close(holder);
});

test('loopbackPlugin attaches to the dev and the preview server', () => {
  const plugin = loopbackPlugin();
  assert.equal(plugin.name, 'both-loopbacks');
  for (const hook of ['configureServer', 'configurePreviewServer']) {
    const listeners = [];
    const httpServer = { on: (event) => listeners.push(event) };
    plugin[hook]({ httpServer, middlewares: () => {} });
    assert.deepEqual(listeners, ['listening', 'close']);
    // Middleware mode has no server of its own: nothing to attach.
    plugin[hook]({ httpServer: null, middlewares: () => {} });
  }
});

test('connectWithoutRace turns the process-wide address race off', () => {
  let set = null;
  connectWithoutRace({ setDefaultAutoSelectFamily: (value) => (set = value) });
  assert.equal(set, false);
});

/**
 * Five GETs to localhost:port from a child process whose event loop is
 * busy 400 ms just after each connection attempt starts.
 */
async function busyClient(port, { race = true } = {}) {
  const code = `
    import http from 'node:http';
    import net from 'node:net';
    import diagnostics from 'node:diagnostics_channel';
    ${race ? '' : 'net.setDefaultAutoSelectFamily(false);'}
    const busy = (ms) => { const end = Date.now() + ms; while (Date.now() < end); };
    diagnostics.subscribe('net.client.socket', ({ socket }) =>
      socket.once('connectionAttempt', () => process.nextTick(() => busy(400))));
    const results = [];
    for (let i = 0; i < 5; i++)
      results.push(await new Promise((resolve) =>
        http.get({ host: 'localhost', port: ${port}, agent: false }, (res) => {
          res.resume(); res.on('end', () => resolve('ok'));
        }).on('error', (error) => resolve(error.code || error.message))));
    console.log(JSON.stringify(results));
  `;
  // Asynchronously: this process is the server it asks.
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--input-type=module', '-e', code],
    { timeout: 60_000 },
  );
  const results = JSON.parse(stdout.trim());
  assert.equal(results.length, 5);
  return results;
}

test("the race: a busy client fails on localhost's second address unless the server answers there or the client does not race", async (t) => {
  if (!(await bothLoopbacks())) return t.skip('no IPv6 loopback here');
  const addresses = (await dns.lookup('localhost', { all: true })).map(
    (entry) => entry.address,
  );
  if (addresses.length < 2 || !net.getDefaultAutoSelectFamily())
    return t.skip('localhost has one address here, or no race by default');
  // As `--host localhost`: the first address localhost resolves to only.
  const only = http.createServer(answering('A'));
  const port = await listen(only, 0, addresses[0]);
  const raced = await busyClient(port);
  assert.ok(
    raced.every((result) => result !== 'ok'),
    `expected failures, got ${raced}`,
  );
  assert.deepEqual(
    await busyClient(port, { race: false }),
    Array(5).fill('ok'),
  );
  await close(only);
  // With the twin on the other address, the racing client connects.
  const twinned = http.createServer(answering('A'));
  listenOnBothLoopbacks(twinned, answering('A'), { warn: () => {} });
  const again = await listen(twinned, 0, addresses[0]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(await busyClient(again), Array(5).fill('ok'));
  await close(twinned);
});
