/**
 * The build stamp: a token the server bakes into every document it serves
 * and also answers at BUILD_STAMP_PATH, so a page can tell whether the
 * code it runs is the code the server now serves. The page side is
 * src/buildStamp.js, which polls the path and reloads a page whose stamp
 * the server no longer answers (when the page is hidden or its user has
 * been idle a while). Personal fork: a tab Chrome restored from its cache
 * ran modules days older than the ones the server served (2026-10-29: a
 * morning of Blocks views drawn by a build from before the curved frame;
 * Vite's modules say no-cache, which a normal load revalidates and a
 * session restore does not), and a tab left open across a restart the
 * socket of which never reconnects is the same case. Vite's own client
 * reloads a page when its socket reconnects; this is the check for the
 * documents that one misses.
 *
 * The dev server's stamp is new at every start and again at every change
 * to a module of the page or to a document (a stylesheet swaps in place
 * and keeps the stamp). A build's stamp is the build's, written to
 * dist/build-stamp.json beside the documents that carry it.
 */

/** Where the server answers `{ stamp }` (src/buildStamp.js reads the same). */
export const BUILD_STAMP_PATH = '/build-stamp.json';
/** The document's `<meta name>` carrying the stamp it was served with. */
export const BUILD_STAMP_META = 'gev-build-stamp';

/** A stamp: the moment plus a few random characters, in case two share it. */
export function newBuildStamp(now = Date.now(), random = Math.random) {
  const salt = Math.floor(random() * 36 ** 4)
    .toString(36)
    .padStart(4, '0');
  return `${new Date(now).toISOString()}-${salt}`;
}

/** A stylesheet: Vite swaps it into the page without a reload. */
const STYLESHEET = /\.(?:css|scss|sass|less|styl|stylus|pcss|postcss)$/i;

/**
 * Whether a file change in the dev server means pages must reload for the
 * current code: a module of the page (anything in the module graph but a
 * stylesheet) or a document (index.html, the template fragments).
 */
export function changeOutdatesPages(file, modules = []) {
  if (STYLESHEET.test(file)) return false;
  return modules.length > 0 || /\.html?$/i.test(file);
}

/** The Vite plugin: the meta tag, the JSON answer, the stamp's renewals. */
export function buildStampPlugin({
  now = Date.now,
  random = Math.random,
} = {}) {
  let stamp = newBuildStamp(now(), random);
  const body = () => JSON.stringify({ stamp });
  return {
    name: 'build-stamp',
    /** The current stamp (tests). */
    get stamp() {
      return stamp;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = String(req.url || '').split('?')[0];
        if (path !== BUILD_STAMP_PATH) return next();
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(body());
      });
    },
    transformIndexHtml: {
      order: 'post',
      handler: () => [
        {
          tag: 'meta',
          attrs: { name: BUILD_STAMP_META, content: stamp },
          injectTo: 'head',
        },
      ],
    },
    hotUpdate({ file, modules }) {
      // Once per change: Vite calls the hook for each environment.
      if (this.environment?.name !== 'client') return;
      if (changeOutdatesPages(file, modules))
        stamp = newBuildStamp(now(), random);
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: BUILD_STAMP_PATH.slice(1),
        source: body(),
      });
    },
  };
}
