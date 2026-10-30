/**
 * Personal fork: the dev and preview servers answer on both loopback
 * addresses. `--host localhost` binds the first address localhost resolves
 * to, ::1 on this machine, and only that one; Node's own clients (the
 * Blocks warm-up, the tileset build, the harness proxy) race localhost's
 * addresses with 250 ms a try (net autoSelectFamily), so a client whose
 * event loop is busy as it connects gives up on ::1 and tries 127.0.0.1,
 * where nothing listened: "fetch failed" (ETIMEDOUT or ECONNREFUSED) with
 * the server healthy, 15 to 27 a tileset build and a few a harness shot
 * (2026-10-30). This plugin listens on the other loopback address too, with
 * the same handler, so the fallback connects; it closes with the server,
 * and waits for the port across a restart. Only a loopback bind gets a
 * twin: a wildcard bind already covers both, and a LAN address is left
 * alone.
 */
import http from 'node:http';

/** How often, and how long apart, a twin asks for its port again. */
export const TWIN_LISTEN_TRIES = 10;
export const TWIN_LISTEN_WAIT_MS = 200;

/** The other loopback address of a bound one, or null. */
export function otherLoopback(address) {
  if (address === '::1' || address === '::ffff:127.0.0.1') return '127.0.0.1';
  if (address === '127.0.0.1') return '::1';
  return null;
}

/**
 * Once `httpServer` listens on a loopback address, listen on the other one
 * at the same port with `handler`; close it, and its connections, when
 * `httpServer` closes. A port the other address cannot have (another
 * process, or no IPv6) leaves the server as it was, with a warning.
 * @returns {{twin: () => http.Server|null}} for tests
 */
export function listenOnBothLoopbacks(
  httpServer,
  handler,
  {
    warn = console.warn,
    wait = TWIN_LISTEN_WAIT_MS,
    tries = TWIN_LISTEN_TRIES,
  } = {},
) {
  let twin = null;
  let closed = false;
  const sockets = new Set();
  httpServer.on('listening', () => {
    closed = false;
    const bound = httpServer.address();
    const other =
      bound && typeof bound === 'object' ? otherLoopback(bound.address) : null;
    if (!other) return;
    const server = http.createServer(handler);
    server.keepAliveTimeout = httpServer.keepAliveTimeout;
    server.headersTimeout = httpServer.headersTimeout;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    let left = tries;
    server.on('error', (error) => {
      // The old server's twin may still hold the port during a restart.
      if (error.code === 'EADDRINUSE' && --left > 0 && !closed) {
        setTimeout(() => server.listen(bound.port, other), wait);
        return;
      }
      if (twin === server) twin = null;
      warn(
        `[loopback] not answering on ${other}:${bound.port} too (${error.code || error.message})`,
      );
    });
    twin = server;
    server.listen(bound.port, other);
  });
  httpServer.on('close', () => {
    closed = true;
    for (const socket of sockets) socket.destroy();
    twin?.close();
    twin = null;
  });
  return { twin: () => twin };
}

/**
 * For a Node client of the local server: connect to the first address a
 * name resolves to (the one `--host localhost` bound, as Vite resolves it
 * the same way), not a 250 ms race between localhost's addresses that a
 * busy event loop loses. Process-wide; only for a process whose
 * connections are local (a remote host with broken IPv6 wants the race).
 * @param {typeof import('node:net')} net
 */
export function connectWithoutRace(net) {
  net.setDefaultAutoSelectFamily(false);
}

/** The Vite plugin: both loopback addresses for the dev and preview servers. */
export function loopbackPlugin() {
  const attach = (server) => {
    if (server.httpServer)
      listenOnBothLoopbacks(server.httpServer, server.middlewares);
  };
  return {
    name: 'both-loopbacks',
    configureServer: attach,
    configurePreviewServer: attach,
  };
}
