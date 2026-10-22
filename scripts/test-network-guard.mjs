// Personal fork: unit tests stay offline. Not part of upstream God's Eye View.
//
// `npm test` loads test-network-guard-preload.mjs, which installs this,
// before every test file (node --import). A connection to anything but this
// machine is refused before a byte (or a DNS query) leaves: fetch() rejects,
// a socket fails the way an unreachable host does, and the test file fails
// with the host and the frames that asked for it, even when the code under
// test swallows the error (a catalog pack that reports "unavailable", a
// retry loop). http, https and tls connect through net.Socket, so one hook
// covers them with fetch(); a fetch mock or a faked https.request never gets
// this far.
//
// A test that talks to a fixture server on another address names it in
// GEV_TEST_ALLOW_HOSTS (comma-separated; `*` allows every host), read at
// connect time so the test can set it itself.
import net from 'node:net';

export const ALLOW_HOSTS_ENV = 'GEV_TEST_ALLOW_HOSTS';
export const OFFLINE_CODE = 'EGEVTESTOFFLINE';

const bare = (host) =>
  String(host)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');

/** Whether a connect target is this machine. */
export function isLocalHost(host) {
  if (host == null || host === '') return true; // net's default: localhost
  const name = bare(host);
  if (name === 'localhost' || name.endsWith('.localhost')) return true;
  if (net.isIPv4(name)) return name.startsWith('127.') || name === '0.0.0.0';
  if (net.isIPv6(name)) {
    if (name === '::1' || name === '::' || name === '0:0:0:0:0:0:0:1')
      return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(name);
    return Boolean(mapped) && isLocalHost(mapped[1]);
  }
  return false;
}

/** Hosts a test allowed through GEV_TEST_ALLOW_HOSTS. */
export function allowedHosts(env = process.env) {
  return String(env[ALLOW_HOSTS_ENV] || '')
    .split(',')
    .map(bare)
    .filter(Boolean);
}

/** Whether a connection to `host` is allowed. */
export function connectionAllowed(host, env = process.env) {
  if (isLocalHost(host)) return true;
  const allowed = allowedHosts(env);
  return allowed.includes('*') || allowed.includes(bare(host));
}

/**
 * Where a net.Socket#connect call goes, from any of its call shapes, or null
 * for a pipe or Unix socket (always local).
 */
export function connectTarget(args) {
  let [first, second] = args;
  // net.connect() hands the socket its already-normalized [options, cb].
  if (Array.isArray(first)) [first] = first;
  if (first && typeof first === 'object') {
    if (first.path != null) return null;
    return { host: first.host ?? first.hostname, port: first.port };
  }
  if (typeof first === 'number' || /^\d+$/.test(String(first)))
    return {
      host: typeof second === 'string' ? second : undefined,
      port: first,
    };
  return null; // connect(path)
}

/** Where a fetch() call goes, or null for a non-network scheme. */
export function fetchTarget(input) {
  let url;
  try {
    url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input?.url,
    );
  } catch {
    return null; // fetch() itself rejects a URL it cannot parse
  }
  if (!/^(?:https?|wss?):$/.test(url.protocol)) return null;
  return { host: url.hostname, port: url.port };
}

/**
 * The refusal. node:test prints a file-level error by its message alone, so
 * the frames that asked for the connection (outside node's own) go in it.
 */
export function offlineError({ host, port }) {
  const where = `${host}${port != null && port !== '' ? `:${port}` : ''}`;
  const error = new Error(
    `unit tests stay offline: a connection to ${where} was refused ` +
      `(a test that means it sets ${ALLOW_HOSTS_ENV}=${host})`,
  );
  const frames = String(error.stack)
    .split('\n')
    .slice(1)
    .filter((line) => !/\(node:|at node:|test-network-guard/.test(line))
    .slice(0, 8);
  if (frames.length) error.message += `\n${frames.join('\n')}`;
  error.code = OFFLINE_CODE;
  error.host = host;
  return error;
}

/**
 * Hook fetch() and net.Socket#connect, layered over whatever is there now.
 * `report` receives each refusal; the default rethrows it outside the
 * caller's reach, which node:test reports as a failure of the test file.
 * `socketPrototype` and `global` are injectable for the guard's own tests.
 * Returns the uninstall function.
 */
export function installNetworkGuard({
  env = process.env,
  report = (error) => {
    queueMicrotask(() => {
      throw error;
    });
  },
  socketPrototype = net.Socket.prototype,
  global = globalThis,
} = {}) {
  const connect = socketPrototype.connect;
  socketPrototype.connect = function guardedConnect(...args) {
    const target = connectTarget(args);
    if (!target || connectionAllowed(target.host, env))
      return connect.apply(this, args);
    const error = offlineError(target);
    report(error);
    // Fail the socket the way an unreachable host would.
    process.nextTick(() => this.destroy(error));
    return this;
  };
  const fetch = global.fetch;
  if (typeof fetch === 'function')
    global.fetch = function guardedFetch(input, init) {
      const target = fetchTarget(input);
      if (!target || connectionAllowed(target.host, env))
        return fetch.call(this, input, init);
      const error = offlineError(target);
      report(error);
      return Promise.reject(error);
    };
  return () => {
    socketPrototype.connect = connect;
    if (typeof fetch === 'function') global.fetch = fetch;
  };
}
