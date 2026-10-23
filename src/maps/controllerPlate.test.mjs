// Personal fork: the map controller's plate for the Custom cutouts layer:
// the globe shown in a colour under an active 3D tileset, overlays re-hosted
// on it, and the stack exactly as before without it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MapSourceController } from './controller.js';
import { createDefaultMapSources } from './defaultSources.js';
import { resolveImageryHost } from './imageryHost.js';

function fixture() {
  const tileset = { show: true, imageryLayers: { tileset: true } };
  const registry = createDefaultMapSources({ googleTileset: tileset });
  for (const source of registry.sources) {
    if (!source.imagery) continue;
    const provider = {
      id: source.descriptor.id,
      errorEvent: { addEventListener: () => () => {} },
    };
    source.imagery = async () => provider;
    source.terrain = {
      id: 'keyless',
      create: async () => ({ provider: { id: 'terrain' } }),
    };
  }
  const original = { name: 'cesium default' };
  const viewer = {
    scene: {
      globe: { show: true, baseColor: original },
      requestRender() {},
      frameState: {
        creditDisplay: { addStaticCredit() {}, removeStaticCredit() {} },
      },
      primitives: { add() {}, remove() {} },
    },
    imageryLayers: { globe: true, add() {}, remove() {} },
  };
  const controller = new MapSourceController(viewer, {
    registry,
    createImageryLayer: (provider) => ({ provider }),
  });
  return { viewer, controller, tileset, original };
}

test('the plate shows the globe in its colour under the 3D tiles, and overlays host on it', async () => {
  const { viewer, controller, tileset, original } = fixture();
  await controller.setStack('photoreal');
  assert.equal(viewer.scene.globe.show, false, 'Google 3D hides the globe');
  assert.equal(resolveImageryHost({ viewer, tileset }).kind, 'tileset');
  let heard = 0;
  controller.subscribe(() => heard++);

  const black = { name: 'black' };
  controller.setPlate(black);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(viewer.scene.globe.baseColor, black);
  assert.equal(controller.hasPlate(), true);
  assert.equal(heard, 1, 'subscribers re-host their overlays');
  assert.equal(
    resolveImageryHost({ viewer, tileset: controller.getImageryHostTileset() })
      .kind,
    'globe',
  );
  assert.equal(tileset.show, true, 'the tiles stay');

  controller.setPlate(black);
  assert.equal(heard, 1, 'the same plate again changes nothing');
  const white = { name: 'white' };
  controller.setPlate(white);
  assert.equal(viewer.scene.globe.baseColor, white);

  controller.setPlate(null);
  assert.equal(viewer.scene.globe.show, false, 'without it: as before');
  assert.equal(viewer.scene.globe.baseColor, original);
  assert.equal(controller.hasPlate(), false);
  assert.equal(heard, 3);
});

test('on a globe stack the plate changes nothing, and it comes back with Google 3D', async () => {
  const { viewer, controller } = fixture();
  await controller.setStack('osm');
  const black = { name: 'black' };
  controller.setPlate(black);
  assert.equal(controller.hasPlate(), false);
  assert.equal(
    viewer.scene.globe.show,
    true,
    'the globe stack shows it anyway',
  );
  assert.notEqual(viewer.scene.globe.baseColor, black, 'not painted');

  await controller.setStack('photoreal');
  assert.equal(viewer.scene.globe.show, true, 'the plate under the tiles');
  assert.equal(viewer.scene.globe.baseColor, black);
  assert.equal(controller.hasPlate(), true);

  await controller.setStack('osm');
  assert.equal(controller.hasPlate(), false);
  controller.setPlate(null);
  await controller.setStack('photoreal');
  assert.equal(viewer.scene.globe.show, false);
});

test('the cutouts layer on the real controller: overlays re-host and come back, toggle after toggle, with no listener left over', async () => {
  const { createCustomCutoutsLayer } =
    await import('../layers/customCutouts/index.js');
  const { createCutoutStore } =
    await import('../layers/customCutouts/store.js');
  const { viewer, controller, tileset, original } = fixture();
  await controller.setStack('photoreal');
  const ring = [
    [-76.7, 39.2],
    [-76.5, 39.2],
    [-76.5, 39.37],
    [-76.7, 39.37],
  ];
  const store = createCutoutStore({
    initial: {
      enabled: false,
      plate: 'black',
      cutouts: [
        {
          source: 'osm:133345',
          name: 'Baltimore',
          visible: true,
          rings: [ring],
        },
      ],
    },
  });
  const clipped = [];
  const layer = createCustomCutoutsLayer({
    store,
    source: { cutout: async () => null, areasAt: async () => ({ areas: [] }) },
    cesium: { Color: class {} },
    clipping: {
      supported: () => true,
      apply: (scene, target) => clipped.push(target),
      clear: () => clipped.push(null),
      state: () => ({}),
    },
  });
  layer.init(viewer);
  layer.attachMapStackController(controller);
  // A draped overlay as the Earth Engine layers do it: on every settle it
  // asks where to drape.
  const hosts = [];
  controller.subscribe(() =>
    hosts.push(
      resolveImageryHost({
        viewer,
        tileset: controller.getImageryHostTileset(),
      }).kind,
    ),
  );
  const listeners = controller._subscribers.size;
  for (let round = 0; round < 5; round++) {
    layer.enable(viewer);
    assert.equal(viewer.scene.globe.show, true, `round ${round}: the plate`);
    assert.equal(hosts.at(-1), 'globe', 'overlays on the plate');
    assert.equal(clipped.at(-1), tileset);
    layer.disable();
    assert.equal(viewer.scene.globe.show, false, 'Google 3D as before');
    assert.equal(viewer.scene.globe.baseColor, original);
    assert.equal(hosts.at(-1), 'tileset', 'overlays back on the tiles');
    assert.equal(clipped.at(-1), null);
  }
  assert.equal(
    controller._subscribers.size,
    listeners,
    'no listener added by toggling',
  );
  assert.deepEqual(
    hosts,
    Array.from({ length: 10 }, (_, i) => (i % 2 ? 'tileset' : 'globe')),
    'one re-host per change, no echoes',
  );
  // Hidden cutouts: the controller untouched.
  layer.enable(viewer);
  layer.setVisible('osm:133345', false);
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(controller.hasPlate(), false);
  layer.destroy();
  assert.equal(
    controller._subscribers.size,
    listeners - 1,
    'destroy lets go of the controller',
  );
});
