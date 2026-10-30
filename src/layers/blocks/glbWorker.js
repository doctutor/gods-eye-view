/**
 * Personal fork: the Blocks GLB worker (glbService.js). It keeps the
 * chunks' packed parts (glbStore.js) and answers each message {id, op,
 * ...args} with {id, glb?, versions?, stats} (the GLB's buffer
 * transferred) or {id, error}; 'forget' and 'forgetAll' are not answered.
 */
import { createGlbStore } from './glbStore.js';

const store = createGlbStore();

self.addEventListener('message', (event) => {
  const { id, op, key, version, parts, chunk, members } = event.data || {};
  try {
    if (op === 'forget') return store.forget(key);
    if (op === 'forgetAll') return store.forgetAll();
    let answer;
    if (op === 'put') answer = { glb: store.put(key, version, parts, chunk) };
    else if (op === 'revive') answer = { glb: store.revive(key, version) };
    else if (op === 'batch') answer = store.batch(members);
    else throw new Error(`unknown op ${op}`);
    self.postMessage(
      { id, ...answer, stats: store.stats() },
      answer.glb ? [answer.glb.buffer] : [],
    );
  } catch (error) {
    self.postMessage({ id, error: String(error?.message || error) });
  }
});
