import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  BUILD_STAMP_META,
  BUILD_STAMP_PATH,
  buildStampPlugin,
  changeOutdatesPages,
  newBuildStamp,
} from '../../build/buildStamp.js';
import * as page from '../buildStamp.js';

test('the page and the server agree on the path and the meta name', () => {
  assert.equal(page.BUILD_STAMP_PATH, BUILD_STAMP_PATH);
  assert.equal(page.BUILD_STAMP_META, BUILD_STAMP_META);
});

test('a stamp is the moment plus four random characters', () => {
  assert.equal(
    newBuildStamp(Date.UTC(2026, 9, 29, 12, 0, 0), () => 0),
    '2026-10-29T12:00:00.000Z-0000',
  );
  assert.match(newBuildStamp(), /^\d{4}-\d\d-\d\dT[\d:.]+Z-[0-9a-z]{4}$/);
  assert.notEqual(
    newBuildStamp(0, () => 0.1),
    newBuildStamp(0, () => 0.2),
  );
});

test('a module or a document change outdates pages; a stylesheet does not', () => {
  const mod = [{ id: '/src/main.js' }];
  assert.equal(changeOutdatesPages('/p/src/main.js', mod), true);
  assert.equal(changeOutdatesPages('/p/index.html', []), true);
  assert.equal(
    changeOutdatesPages('/p/src/ui/templates/cockpit.html', []),
    true,
  );
  assert.equal(
    changeOutdatesPages('/p/style.css', [{ id: '/style.css' }]),
    false,
  );
  assert.equal(changeOutdatesPages('/p/src/x.scss', mod), false);
  assert.equal(changeOutdatesPages('/p/scratch.txt', []), false);
  assert.equal(changeOutdatesPages('/p/src/new.js', []), false);
});

test('the plugin renews its stamp only for a client change that outdates pages', () => {
  let t = 0;
  const plugin = buildStampPlugin({ now: () => ++t, random: () => 0 });
  const first = plugin.stamp;
  const client = { environment: { name: 'client' } };
  plugin.hotUpdate.call(client, { file: '/p/style.css', modules: [{}] });
  assert.equal(plugin.stamp, first);
  plugin.hotUpdate.call(
    { environment: { name: 'ssr' } },
    { file: '/p/a.js', modules: [{}] },
  );
  assert.equal(plugin.stamp, first);
  plugin.hotUpdate.call(client, { file: '/p/a.js', modules: [{}] });
  assert.notEqual(plugin.stamp, first);
});

test('the document gets a meta tag and the build a JSON file with the stamp', () => {
  const plugin = buildStampPlugin();
  const tags = plugin.transformIndexHtml.handler('<html></html>', {});
  assert.deepEqual(tags, [
    {
      tag: 'meta',
      attrs: { name: BUILD_STAMP_META, content: plugin.stamp },
      injectTo: 'head',
    },
  ]);
  const emitted = [];
  plugin.generateBundle.call({ emitFile: (file) => emitted.push(file) });
  assert.deepEqual(emitted, [
    {
      type: 'asset',
      fileName: 'build-stamp.json',
      source: JSON.stringify({ stamp: plugin.stamp }),
    },
  ]);
});

test('the dev server answers the stamp uncached and stamps its document', async (t) => {
  const { createServer } = await import('vite');
  const { createBrowserViteConfig } = await import('../../build/vite.js');
  const base = createBrowserViteConfig();
  const plugin = base.plugins.find((p) => p?.name === 'build-stamp');
  assert.ok(plugin, 'createBrowserViteConfig installs the build stamp');
  const vite = await createServer({
    ...base,
    root: fileURLToPath(new URL('../../', import.meta.url)),
    configFile: false,
    envFile: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: base.plugins.filter((p) =>
      ['application-component-templates', 'build-stamp'].includes(p?.name),
    ),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      ...base.server,
      host: '127.0.0.1',
      port: 0,
      hmr: false,
      watch: null,
    },
  });
  await vite.listen();
  t.after(() => vite.close());
  const { port } = vite.httpServer.address();
  const get = (path) =>
    new Promise((resolve, reject) => {
      const request = httpRequest(
        { host: '127.0.0.1', port, path, headers: { Host: 'localhost' } },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body,
            }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    });
  const answer = await get(`${BUILD_STAMP_PATH}?x=1`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['cache-control'], 'no-store');
  assert.match(answer.headers['content-type'], /application\/json/);
  assert.deepEqual(JSON.parse(answer.body), { stamp: plugin.stamp });
  const document = await get('/');
  assert.equal(document.status, 200);
  assert.ok(
    document.body.includes(
      `<meta name="${BUILD_STAMP_META}" content="${plugin.stamp}">`,
    ),
    'the document carries the stamp',
  );
  const other = await get('/build-stamp.jsonx');
  assert.notEqual(other.headers['cache-control'], 'no-store');
});
