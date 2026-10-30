// Personal fork: where the Blocks chunks' geometry lives while it is drawn
// (docs/BLOCKS-PLAN.md, option 3): each chunk's packed parts (packMesh.js),
// by key, and the GLBs made from them (gltf.js encodeBatchGlb), a chunk's
// own and a batch's. Pure: the GLB worker (glbWorker.js) runs it, so the
// page holds no geometry but the GLBs on their way to Cesium; where there
// are no workers the page runs it itself (glbService.js).

import { encodeBatchGlb, packedBytes } from './gltf.js';

/** A coarse chunk ('c:gi:gj') comes back with the mesh it had: kept aside when taken away. */
const PARKED = /^c:/;

export function createGlbStore() {
  /** key → {version, parts: {opaque, water}, chunk: [ci, cj]} */
  const held = new Map();
  /** key → {parts, chunk}: coarse chunks taken away, for when they come back. */
  const parked = new Map();

  /**
   * GLB of entries (each {parts, chunk} or null, with its offset): a
   * chunk's opaque faces feature s, its water n + s; the property table's
   * ci, cj and water name them.
   */
  function glbOf(entries) {
    const n = entries.length;
    const ci = new Int32Array(2 * n);
    const cj = new Int32Array(2 * n);
    const water = new Uint8Array(2 * n);
    entries.forEach((entry, s) => {
      ci[s] = ci[n + s] = entry?.chunk?.[0] ?? 0;
      cj[s] = cj[n + s] = entry?.chunk?.[1] ?? 0;
      water[n + s] = 1;
    });
    return encodeBatchGlb({
      chunks: entries.map((entry) => ({
        opaque: entry?.parts?.opaque ?? null,
        water: entry?.parts?.water ?? null,
        offset: entry?.offset,
      })),
      features: { count: 2 * n, properties: { ci, cj, water } },
    });
  }

  const alone = (entry) => glbOf([entry]);

  return {
    /** A chunk's parts at a version: kept, and its own GLB. */
    put(key, version, parts, chunk) {
      const entry = { version, parts, chunk };
      held.set(key, entry);
      parked.delete(key);
      return alone(entry);
    },

    /** A coarse chunk back with the parts it had: kept again, and its GLB. */
    revive(key, version) {
      const kept = parked.get(key) || held.get(key);
      if (!kept) throw new Error(`Blocks GLB store: nothing kept for ${key}`);
      const entry = { version, parts: kept.parts, chunk: kept.chunk };
      held.set(key, entry);
      parked.delete(key);
      return alone(entry);
    },

    /** A chunk taken away (a coarse one kept aside). */
    forget(key) {
      const entry = held.get(key);
      held.delete(key);
      if (entry && PARKED.test(key)) parked.set(key, entry);
    },

    /** Every chunk taken away, kept aside or not (another region). */
    forgetAll() {
      held.clear();
      parked.clear();
    },

    /**
     * A batch's GLB: its members ({key, offset}) in order, each as kept now
     * (one not kept draws nothing), and the version of each it holds (null
     * for none), for the renderer to hide what moved on meanwhile.
     */
    batch(members) {
      const entries = members.map(({ key, offset }) => {
        const entry = held.get(key);
        return entry ? { ...entry, offset } : null;
      });
      return {
        glb: glbOf(entries),
        versions: entries.map((entry) => entry?.version ?? null),
      };
    },

    /** Chunks kept and kept aside, and their bytes. */
    stats() {
      let bytes = 0;
      for (const map of [held, parked])
        for (const { parts } of map.values())
          bytes += packedBytes(parts?.opaque) + packedBytes(parts?.water);
      return { chunks: held.size, parked: parked.size, bytes };
    },
  };
}
