// Personal fork: keeping drawn tiles on disk for the local tile servers.
// Not part of upstream God's Eye View.
import fs from 'node:fs';
import path from 'node:path';

/**
 * Keep a drawn tile on disk: a temp file of its own, then a rename, tried
 * again a few times when Windows refuses it (EPERM, EBUSY, EACCES: another
 * process, or a reader of the same file, has it open). A tile already there
 * counts as kept. Failures are logged (once a minute), never thrown:
 * serving matters more than keeping. `label` names the server in the log;
 * `empty: false` keeps nothing for an empty tile.
 */
export function keepTile(
  file,
  body,
  {
    renameSync = fs.renameSync,
    log = console.warn,
    label = 'tiles',
    empty = true,
  } = {},
) {
  const temporary = `${file}.${process.pid}.${(tempSerial += 1)}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!body) {
      // An empty tile is marked, when the server reads markers.
      if (empty) fs.writeFileSync(`${file}.empty`, '');
      return empty;
    }
    fs.writeFileSync(temporary, body);
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(temporary, file);
        return true;
      } catch (error) {
        const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
        if (!busy || attempt >= KEEP_RETRIES) throw error;
        sleepSync(KEEP_RETRY_MS * (attempt + 1));
      }
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    if (fs.existsSync(file)) return true;
    if (Date.now() - lastKeepWarning > 60_000) {
      lastKeepWarning = Date.now();
      log(
        `[${label}] tile not kept (${error?.code || error?.message}): ${file}`,
      );
    }
    return false;
  }
}
let tempSerial = 0;
let lastKeepWarning = -Infinity;
const KEEP_RETRIES = 4;
const KEEP_RETRY_MS = 25;
const sleepSync = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
