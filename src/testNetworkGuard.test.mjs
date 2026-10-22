// Personal fork: the guard that keeps unit tests offline
// (scripts/test-network-guard.mjs). Not part of upstream God's Eye View.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ALLOW_HOSTS_ENV,
  OFFLINE_CODE,
  connectTarget,
  connectionAllowed,
  fetchTarget,
  installNetworkGuard,
  isLocalHost,
} from '../scripts/test-network-guard.mjs';
import { NETWORK_GUARD_ARGS } from '../scripts/run-unit-tests.mjs';

test('this machine is local; every other host is not', () => {
  for (const host of [
    undefined,
    '',
    'localhost',
    'LOCALHOST',
    'app.localhost',
    '127.0.0.1',
    '127.8.9.10',
    '0.0.0.0',
    '::1',
    '[::1]',
    '::',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
  ])
    assert.equal(isLocalHost(host), true, String(host));
  for (const host of [
    'example.com',
    'localhost.example.com',
    '10.0.0.5',
    '192.168.1.2',
    '128.0.0.1',
    '::ffff:10.0.0.5',
    '2001:db8::1',
    'qlever.cs.uni-freiburg.de',
  ])
    assert.equal(isLocalHost(host), false, host);
});

test('GEV_TEST_ALLOW_HOSTS lets a named host, or every host, through', () => {
  assert.equal(connectionAllowed('fixture.lan', {}), false);
  const env = { [ALLOW_HOSTS_ENV]: ' Fixture.LAN , 10.0.0.5 ' };
  assert.equal(connectionAllowed('fixture.lan', env), true);
  assert.equal(connectionAllowed('10.0.0.5', env), true);
  assert.equal(connectionAllowed('10.0.0.6', env), false);
  assert.equal(connectionAllowed('anything', { [ALLOW_HOSTS_ENV]: '*' }), true);
});

test('every shape of a socket connect names its host, and a pipe none', () => {
  assert.deepEqual(connectTarget([{ host: 'a.example', port: 443 }]), {
    host: 'a.example',
    port: 443,
  });
  assert.deepEqual(connectTarget([[{ host: 'b.example', port: 80 }, null]]), {
    host: 'b.example',
    port: 80,
  });
  assert.deepEqual(connectTarget([8080, 'c.example']), {
    host: 'c.example',
    port: 8080,
  });
  assert.deepEqual(connectTarget(['8080']), { host: undefined, port: '8080' });
  assert.equal(connectTarget([{ path: '\\\\.\\pipe\\x' }]), null);
  assert.equal(connectTarget(['/tmp/socket']), null);
  assert.deepEqual(fetchTarget('https://d.example:8443/x'), {
    host: 'd.example',
    port: '8443',
  });
  assert.deepEqual(fetchTarget(new URL('http://127.0.0.1/')), {
    host: '127.0.0.1',
    port: '',
  });
  assert.deepEqual(fetchTarget({ url: 'wss://e.example/' }), {
    host: 'e.example',
    port: '',
  });
  assert.equal(fetchTarget('data:text/plain,hi'), null);
  assert.equal(fetchTarget('/relative'), null);
});

test('a refused connection never reaches the real connect or fetch', async () => {
  const connected = [];
  const fetched = [];
  const reported = [];
  const socketPrototype = {
    connect(...args) {
      connected.push(args);
      return this;
    },
  };
  const global = {
    fetch: async (input) => {
      fetched.push(String(input));
      return 'answered';
    },
  };
  const env = { [ALLOW_HOSTS_ENV]: 'fixture.lan' };
  const uninstall = installNetworkGuard({
    env,
    report: (error) => reported.push(error),
    socketPrototype,
    global,
  });
  const socket = Object.create(socketPrototype);
  let destroyed = null;
  socket.destroy = (error) => (destroyed = error);

  socket.connect({ host: '127.0.0.1', port: 1 });
  socket.connect({ host: 'fixture.lan', port: 2 });
  socket.connect({ path: '\\\\.\\pipe\\gev' });
  assert.equal(connected.length, 3, 'local, allowed and pipe connect');
  assert.equal(socket.connect({ host: 'a.example', port: 443 }), socket);
  assert.equal(connected.length, 3, 'the refused one did not');
  await new Promise((resolve) => process.nextTick(resolve));
  assert.equal(
    destroyed?.code,
    OFFLINE_CODE,
    'the socket fails like a dead host',
  );

  assert.equal(await global.fetch('http://localhost:4000/x'), 'answered');
  assert.equal(await global.fetch('https://fixture.lan/x'), 'answered');
  await assert.rejects(global.fetch('https://b.example/x'), (error) => {
    assert.equal(error.code, OFFLINE_CODE);
    assert.equal(error.host, 'b.example');
    return true;
  });
  assert.deepEqual(fetched, [
    'http://localhost:4000/x',
    'https://fixture.lan/x',
  ]);

  assert.deepEqual(
    reported.map((error) => error.host),
    ['a.example', 'b.example'],
  );
  assert.match(
    reported[0].message,
    /a connection to a\.example:443 was refused/,
  );
  assert.match(reported[0].message, /GEV_TEST_ALLOW_HOSTS=a\.example/);
  assert.match(
    reported[1].message,
    /testNetworkGuard\.test\.mjs/,
    'the asker is named',
  );

  uninstall();
  socket.connect({ host: 'a.example', port: 443 });
  assert.equal(connected.length, 4, 'uninstalled');
});

test('npm test fails a file that reaches a real host, even if it swallows the error', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-net-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'leaks.test.mjs');
  // Nothing leaves the machine: the guard refuses before any DNS lookup.
  fs.writeFileSync(
    file,
    [
      "import test from 'node:test';",
      "import http from 'node:http';",
      "import https from 'node:https';",
      "test('a swallowed fetch', async () => {",
      "  await fetch('https://leak-fetch.example/').catch(() => {});",
      '});',
      "test('an https request', async () => {",
      "  await new Promise((done) => https.get('https://leak-https.example/', done).on('error', done));",
      '});',
      "test('a local server is fine', async (t) => {",
      "  const server = http.createServer((_q, r) => r.end('ok')).listen(0, '127.0.0.1');",
      "  await new Promise((done) => server.once('listening', done));",
      '  t.after(() => server.close());',
      '  const { port } = server.address();',
      "  if ((await (await fetch(`http://localhost:${port}/`)).text()) !== 'ok') throw new Error('no answer');",
      '});',
      '',
    ].join('\n'),
  );
  const env = { ...process.env };
  delete env[ALLOW_HOSTS_ENV];
  // A test process's own marker, which turns a nested `node --test` off.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(
    process.execPath,
    [...NETWORK_GUARD_ARGS, '--test', '--test-reporter=spec', file],
    { encoding: 'utf8', env, timeout: 60_000 },
  );
  const out = `${run.stdout}\n${run.stderr}`;
  assert.notEqual(run.status, 0, out);
  assert.match(out, /a connection to leak-fetch\.example was refused/);
  assert.match(out, /a connection to leak-https\.example:443 was refused/);
  assert.match(out, /leaks\.test\.mjs:5/, 'the fetch that asked is named');
  assert.match(out, /✔ a local server is fine/);
});
