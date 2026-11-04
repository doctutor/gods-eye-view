// Personal fork: the map controller's tileset suppression (Blocks' tiles
// draw the world): the active 3D tileset and the plate's globe hidden while
// any reason holds, the tileset still the stack's and the overlays' host,
// a switch meanwhile honouring it, and everything as before after.
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
  let renders = 0;
  const viewer = {
    scene: {
      globe: { show: true, baseColor: { name: 'cesium default' } },
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
    requestRender: () => renders++,
  });
  return { viewer, controller, tileset, renders: () => renders };
}

test('suppressed, the 3D tileset hides but stays the host; released, it shows again; reasons count apart', async () => {
  const { viewer, controller, tileset, renders } = fixture();
  await controller.setStack('photoreal');
  assert.equal(tileset.show, true);
  const before = renders();

  assert.equal(controller.setTilesetSuppressed('blocks-tiles', true), true);
  assert.equal(tileset.show, false, 'hidden');
  assert.equal(viewer.scene.globe.show, false, 'and no globe under it');
  assert.equal(controller.isTilesetSuppressed(), true);
  assert.equal(
    controller.getImageryHostTileset(),
    tileset,
    'still the overlays’ host',
  );
  assert.equal(resolveImageryHost({ viewer, tileset }).kind, 'tileset');
  assert.ok(renders() > before, 'a render asked');

  // A second reason holds it after the first lets go.
  controller.setTilesetSuppressed('other', true);
  controller.setTilesetSuppressed('blocks-tiles', false);
  assert.equal(tileset.show, false);
  controller.setTilesetSuppressed('other', false);
  assert.equal(tileset.show, true, 'shown once nothing suppresses');
  assert.equal(controller.isTilesetSuppressed(), false);
  assert.equal(controller.getImageryHostTileset(), tileset);
});

test('a switch while suppressed: a globe stack is untouched, and back on Google 3D the tileset stays hidden until released', async () => {
  const { viewer, controller, tileset } = fixture();
  await controller.setStack('photoreal');
  controller.setTilesetSuppressed('blocks-tiles', true);

  await controller.setStack('osm');
  assert.equal(tileset.show, false);
  assert.equal(viewer.scene.globe.show, true, 'a globe stack shows its globe');
  assert.equal(controller.getImageryHostTileset(), null, 'no tileset host');

  // The switch's own reset honours the suppression.
  await controller.setStack('photoreal');
  assert.equal(tileset.show, false, 'not shown by the switch');
  assert.equal(viewer.scene.globe.show, false);
  assert.equal(controller.getImageryHostTileset(), tileset);

  controller.setTilesetSuppressed('blocks-tiles', false);
  assert.equal(tileset.show, true);
});

test('suppressed, the plate’s globe hides too and hasPlate says so; released, the plate is back', async () => {
  const { viewer, controller, tileset } = fixture();
  await controller.setStack('photoreal');
  const black = { name: 'black' };
  controller.setPlate(black);
  assert.equal(viewer.scene.globe.show, true);

  controller.setTilesetSuppressed('blocks-tiles', true);
  assert.equal(tileset.show, false);
  assert.equal(viewer.scene.globe.show, false, 'the plate hidden with it');
  assert.equal(controller.hasPlate(), false);

  controller.setTilesetSuppressed('blocks-tiles', false);
  assert.equal(tileset.show, true);
  assert.equal(viewer.scene.globe.show, true, 'the plate back');
  assert.equal(viewer.scene.globe.baseColor, black);
  assert.equal(controller.hasPlate(), true);
});

test('suppression on a globe stack changes nothing', async () => {
  const { viewer, controller, tileset } = fixture();
  await controller.setStack('osm');
  controller.setTilesetSuppressed('blocks-tiles', true);
  assert.equal(viewer.scene.globe.show, true);
  assert.equal(tileset.show, false, 'hidden by the globe stack anyway');
  controller.setTilesetSuppressed('blocks-tiles', false);
  assert.equal(viewer.scene.globe.show, true);
});
