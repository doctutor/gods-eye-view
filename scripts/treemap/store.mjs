// Personal fork: the treemap tables' directory as the build keeps it: a
// manifest naming one file per table, each written whole before the
// manifest switches to it, and a table rebuilt only when its signature
// (its inputs' build ids and the code's version) changes. Not part of
// upstream God's Eye View.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  TREEMAP_MANIFEST,
  TREEMAP_MANIFEST_FORMAT,
  tableStem,
} from '../../server/providers/treemap/sources.js';

export const signatureOf = (value) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 12);

export function readManifest(dir) {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(dir, TREEMAP_MANIFEST), 'utf8'),
    );
    if (manifest?.format === TREEMAP_MANIFEST_FORMAT) return manifest;
  } catch {
    /* none yet */
  }
  return { format: TREEMAP_MANIFEST_FORMAT, tables: {}, files: {} };
}

function writeAtomic(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}

/** Whether an entry (a table or a file) is built with this signature. */
export function isCurrent(dir, entry, signature) {
  return Boolean(
    entry &&
    entry.signature === signature &&
    fs.existsSync(path.join(dir, entry.file)),
  );
}

/**
 * Write one JSON file under the directory and switch the manifest's entry
 * (`tables` by variable, or `files` by name) to it; the entry's old file
 * goes once the manifest names the new one.
 */
export function publish(
  dir,
  { section, name, json, signature, seconds, extra = {} },
) {
  fs.mkdirSync(path.join(dir, 'tables'), { recursive: true });
  const file = `tables/${tableStem(name)}-${signature}.json`;
  const text = JSON.stringify(json);
  writeAtomic(path.join(dir, file), text);
  const manifest = readManifest(dir);
  const old = manifest[section][name]?.file;
  manifest[section][name] = {
    file,
    signature,
    builtAt: new Date().toISOString(),
    seconds: Math.round(seconds * 10) / 10,
    bytes: Buffer.byteLength(text),
    ...extra,
  };
  manifest.builtAt = new Date().toISOString();
  writeAtomic(
    path.join(dir, TREEMAP_MANIFEST),
    JSON.stringify(manifest, null, 2),
  );
  if (old && old !== file)
    try {
      fs.rmSync(path.join(dir, old));
    } catch {
      /* gone */
    }
  return manifest[section][name];
}
