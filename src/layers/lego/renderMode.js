// Personal fork: the render mode the ANALYSIS heading's drop-down picks
// ('colour', the default, 'lego' or 'blocks'), and the Lego elevation
// exaggeration, both kept in this browser. One store, shared by the panel,
// the Lego controller (index.js), the Blocks controller
// (src/layers/blocks/index.js) and the share link, which carries Blocks as
// `bk=1`.

export const RENDER_MODE_STORAGE_KEY = 'gev.render.mode';
export const EXAGGERATION_STORAGE_KEY = 'gev.render.legoExaggeration';
/** Blocks' Buildings switch, when chosen ('1' or '0'); unchosen: on where Overpass answers. */
export const BUILDINGS_STORAGE_KEY = 'gev.render.blocksBuildings';
export const RENDER_MODES = Object.freeze(['colour', 'lego', 'blocks']);
/**
 * The share hash's Blocks switch: `bk=1` in Blocks, `bk=1.b0` in Blocks
 * with its Buildings turned off, absent otherwise (links from before the
 * Buildings switch read as they did).
 */
export const BLOCKS_PARAM = 'bk';

/** `bk`'s value: '1' in Blocks, '1.b0' with Buildings off, '' otherwise. */
export const encodeBlocksParam = (mode, buildings = null) =>
  mode === 'blocks' ? (buildings === false ? '1.b0' : '1') : '';

const BLOCKS_VALUE = /^1(?:\.b([01]))?$/;

/** Whether `bk`'s value asks for Blocks ('1', '1.b0', '1.b1'). */
export const decodeBlocksParam = (value) =>
  BLOCKS_VALUE.test(String(value ?? '').trim());

/** The Buildings choice in `bk`'s value: false for '.b0', true for '.b1', else null. */
export function decodeBlocksBuildings(value) {
  const match = BLOCKS_VALUE.exec(String(value ?? '').trim());
  return match?.[1] === '0' ? false : match?.[1] === '1' ? true : null;
}

/** What the page's hash asks of Blocks: {blocks, buildings}. */
function linkBlocksState() {
  try {
    const hash = String(globalThis.location?.hash || '').slice(1);
    const value = new URLSearchParams(hash).get(BLOCKS_PARAM);
    return {
      blocks: decodeBlocksParam(value),
      buildings: decodeBlocksBuildings(value),
    };
  } catch {
    return { blocks: false, buildings: null };
  }
}

/** The stored Buildings choice: true, false, or null (never chosen). */
export function readBuildings(storage) {
  try {
    const value = storage?.getItem(BUILDINGS_STORAGE_KEY);
    return value === '1' ? true : value === '0' ? false : null;
  } catch {
    return null;
  }
}

function storageOf(storage) {
  if (storage !== undefined) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The stored mode, else colour. */
export function readRenderMode(storage) {
  try {
    const value = storage?.getItem(RENDER_MODE_STORAGE_KEY);
    return RENDER_MODES.includes(value) ? value : 'colour';
  } catch {
    return 'colour';
  }
}

/** The stored exaggeration (1 to 5), else null (never chosen). */
export function readExaggeration(storage) {
  try {
    const raw = storage?.getItem(EXAGGERATION_STORAGE_KEY);
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
  } catch {
    return null;
  }
}

/**
 * The exaggeration when none was chosen: 2× on a flat basemap (columns on
 * the ellipsoid, where low country barely rises), 1× on terrain or the
 * photoreal tiles (the columns stand on the ground's own relief).
 */
export const defaultExaggeration = (flat) => (flat ? 2 : 1);

/**
 * Whether a map stack is a flat map (a drawn basemap, where the default
 * exaggeration is 2×) rather than imagery or the photoreal tiles (1×), from
 * what the map-stack catalog says of it: the Countries styles, OSM and the
 * keyless styles are maps, except the NASA marbles (satellite imagery);
 * photoreal, Bing (Ion) and Esri imagery are not. Decided by the basemap,
 * not by the terrain: the globe keeps Cesium World Terrain under a blank or
 * CARTO style too. Null when there is no stack to say.
 */
export function isFlatBasemap(stack) {
  if (!stack?.kind) return null;
  if (stack.kind === 'countries-basemap' || stack.kind === 'osm') return true;
  if (stack.kind === 'keyless-basemap') return stack.group !== 'nasa';
  return false;
}

/**
 * @param {{storage?: Storage|null, linkBlocks?: boolean,
 *   linkBuildings?: boolean|null}} [options]
 *   `linkBlocks`: a link asked for Blocks (`bk=1`), which wins over the
 *   stored mode for this page without overwriting it; a link without `bk`
 *   keeps the stored mode, as links did before Blocks. `linkBuildings`:
 *   the link's Buildings choice (`bk=1.b0`: off), for this page likewise.
 */
export function createRenderModeStore({
  storage,
  linkBlocks = false,
  linkBuildings = null,
} = {}) {
  const store = storageOf(storage);
  let mode = linkBlocks ? 'blocks' : readRenderMode(store);
  let exaggeration = readExaggeration(store);
  let buildings = linkBuildings ?? readBuildings(store);
  const listeners = new Set();
  const emit = () => {
    for (const listener of listeners) {
      try {
        listener({ mode, exaggeration, buildings });
      } catch (error) {
        console.warn('[Lego] render mode listener failed:', error);
      }
    }
  };
  const save = (key, value) => {
    try {
      store?.setItem(key, String(value));
    } catch {
      /* private mode: kept for this page only */
    }
  };
  return {
    getMode: () => mode,
    /** The chosen exaggeration, else the default for the ground (flat or not). */
    getExaggeration: (flat = true) => exaggeration ?? defaultExaggeration(flat),
    /** Whether the user chose one (gev.render.legoExaggeration). */
    isExaggerationSet: () => exaggeration !== null,
    setMode(next) {
      if (!RENDER_MODES.includes(next) || next === mode) return;
      mode = next;
      save(RENDER_MODE_STORAGE_KEY, mode);
      emit();
    },
    /** Blocks' Buildings choice: true, false, or null (never chosen). */
    getBuildings: () => buildings,
    setBuildings(next) {
      const value = next === true;
      if (value === buildings) return;
      buildings = value;
      save(BUILDINGS_STORAGE_KEY, value ? '1' : '0');
      emit();
    },
    setExaggeration(next) {
      const value = Math.round(Number(next));
      if (!(value >= 1 && value <= 5) || value === exaggeration) return;
      exaggeration = value;
      save(EXAGGERATION_STORAGE_KEY, exaggeration);
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Whether the page's link asked for Blocks. */
    linkAskedForBlocks: () => linkBlocks,
    /** `bk`'s value now ('' when it is not written). */
    param: () => encodeBlocksParam(mode, buildings),
  };
}

let shared = null;
/**
 * The page's store, the one the panel, both controllers and the share link
 * use; made the first time it is asked for, from this browser's storage and
 * the page's hash (`bk`).
 */
export function renderModeStore() {
  const link = linkBlocksState();
  shared ||= createRenderModeStore({
    linkBlocks: link.blocks,
    linkBuildings: link.buildings,
  });
  return shared;
}
