/**
 * Checkpoints for the Wikipedia points build, so a build a restart
 * killed resumes instead of reading every wiki's dumps again (the page
 * tables alone are gigabytes). Each wiki's articles, once its three dumps
 * are joined (pointStore.mjs WikiArticles), are written to
 * `<build dir>/points-checkpoints/<wiki>.<key>.bin`, keyed by its dumps
 * (each one's Last-Modified and ETag), the points format and whether
 * secondary coordinates are kept. A rerun with the same dumps reads the
 * checkpoint and folds it into the union as the dumps would have been;
 * the index comes out byte for byte the same. A wiki's articles depend on
 * its own dumps alone (the union is rebuilt from them in order), so a
 * changed wiki, or another list of wikis, costs only the wikis changed.
 *
 * The directory sits beside points/, not in it: the index's files come
 * and go with every build, the checkpoints stay. A checkpoint is written
 * whole, synced, then renamed into place, so one there is complete.
 *
 * File: "GEVWPCK1", a Uint32 header length, the header (JSON: the wiki,
 * the key's dumps, the join's stats, the counts, the types), padding to
 * 8 bytes, then the columns in COLUMNS' order, each padded to 8.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WikiArticles } from './pointStore.mjs';

export const CHECKPOINT_FORMAT = 1;
const MAGIC = Buffer.from('GEVWPCK1', 'latin1');

/** The checkpoints' directory for a build's points/ directory. */
export const checkpointDir = (pointsDir) =>
  path.join(path.dirname(pointsDir), 'points-checkpoints');

/**
 * A wiki's checkpoint key from its three dumps' metadata ({lastModified,
 * etag} each), or null when a dump has neither (nothing to key on).
 */
export function checkpointKey({ wiki, dumps, pointsFormat, secondary }) {
  const tables = {};
  for (const table of ['geo_tags', 'page', 'page_props']) {
    const meta = dumps[table] || {};
    if (!meta.lastModified && !meta.etag) return null;
    tables[table] = {
      lastModified: meta.lastModified || null,
      etag: meta.etag || null,
    };
  }
  const key = {
    checkpoint: CHECKPOINT_FORMAT,
    pointsFormat,
    wiki: wiki.key,
    secondary: !!secondary,
    dumps: tables,
  };
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(key))
    .digest('hex')
    .slice(0, 16);
  return { ...key, hash, file: `${wiki.key}.${hash}.bin` };
}

// [name, type, rows]: 'a' per article, 'c' per coordinate.
const COLUMNS = [
  ['page', Uint32Array, 'a'],
  ['bytes', Float64Array, 'a'],
  ['qid', Float64Array, 'a'],
  ['first', Uint32Array, 'a'],
  ['count', Uint32Array, 'a'],
  ['titleStarts', Uint32Array, 'a'],
  ['x', Uint32Array, 'c'],
  ['y', Uint32Array, 'c'],
  ['dim', Float64Array, 'c'],
  ['type', Uint16Array, 'c'],
  ['flags', Uint8Array, 'c'],
];
const pad8 = (n) => (8 - (n % 8)) % 8;
const ZEROS = Buffer.alloc(8);

function viewOf(articles, name) {
  if (name === 'titleStarts') return articles.titles.starts.view();
  return articles[name].view();
}

/**
 * Write a wiki's articles as its checkpoint under `dir` (a temporary
 * file, synced, renamed into place); its other checkpoints go. Returns
 * the file's path.
 */
export function writeCheckpoint(dir, key, articles, stats) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, key.file);
  const header = Buffer.from(
    JSON.stringify({
      checkpoint: CHECKPOINT_FORMAT,
      key,
      stats,
      articles: articles.articles,
      coordinates: articles.coordinates,
      titleBytes: articles.titles.used,
      types: articles.types,
      writtenAt: new Date().toISOString(),
    }),
    'utf8',
  );
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(temporary, 'w');
  try {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(header.length);
    const write = (buf) => {
      let at = 0;
      while (at < buf.length) at += fs.writeSync(fd, buf, at);
    };
    write(MAGIC);
    write(length);
    write(header);
    write(ZEROS.subarray(0, pad8(12 + header.length)));
    for (const [name] of COLUMNS) {
      const view = viewOf(articles, name);
      const bytes = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      write(bytes);
      write(ZEROS.subarray(0, pad8(bytes.length)));
    }
    write(articles.titles.bytes.subarray(0, articles.titles.used));
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(temporary, file);
  for (const name of fs.readdirSync(dir))
    if (name.startsWith(`${key.wiki}.`) && name !== key.file)
      fs.rmSync(path.join(dir, name), { force: true });
  return file;
}

/** A checkpoint's header, or null when the file is not a whole checkpoint. */
export function readCheckpointHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12) return null;
    if (!head.subarray(0, 8).equals(MAGIC)) return null;
    const length = head.readUInt32LE(8);
    const json = Buffer.alloc(length);
    if (fs.readSync(fd, json, 0, length, 12) !== length) return null;
    const header = JSON.parse(json.toString('utf8'));
    let size = 12 + length + pad8(12 + length);
    for (const [, Type, rows] of COLUMNS) {
      const n =
        (rows === 'a' ? header.articles : header.coordinates) *
        Type.BYTES_PER_ELEMENT;
      size += n + pad8(n);
    }
    size += header.titleBytes;
    if (fs.fstatSync(fd).size !== size) return null;
    return { ...header, headerBytes: length, size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * A wiki's articles from its checkpoint for `key`, read column by column
 * into their arrays (no second copy), with the join's stats; null when
 * there is none, or it is not whole.
 */
export function readCheckpoint(dir, key) {
  const file = path.join(dir, key.file);
  if (!fs.existsSync(file)) return null;
  const header = readCheckpointHeader(file);
  if (
    !header ||
    header.checkpoint !== CHECKPOINT_FORMAT ||
    header.key?.hash !== key.hash
  )
    return null;
  const articles = new WikiArticles();
  articles.types = header.types;
  const fd = fs.openSync(file, 'r');
  try {
    let at = 12 + header.headerBytes + pad8(12 + header.headerBytes);
    const read = (buf) => {
      let done = 0;
      while (done < buf.length) {
        const n = fs.readSync(fd, buf, done, buf.length - done, at + done);
        if (!n) throw new Error(`${file} ended early`);
        done += n;
      }
      at += buf.length;
    };
    for (const [name, Type, rows] of COLUMNS) {
      const count = rows === 'a' ? header.articles : header.coordinates;
      const array = new Type(Math.max(16, count));
      read(Buffer.from(array.buffer, 0, count * Type.BYTES_PER_ELEMENT));
      at += pad8(count * Type.BYTES_PER_ELEMENT);
      const column =
        name === 'titleStarts' ? articles.titles.starts : articles[name];
      column.array = array;
      column.length = count;
    }
    const titleBytes = Buffer.allocUnsafe(Math.max(16, header.titleBytes));
    read(titleBytes.subarray(0, header.titleBytes));
    articles.titles.bytes = titleBytes;
    articles.titles.used = header.titleBytes;
  } finally {
    fs.closeSync(fd);
  }
  return { articles, stats: header.stats, header };
}

/** The checkpoints under `dir`: [{wiki, file, articles, coordinates, bytes, dumps, writtenAt}]. */
export function listCheckpoints(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.bin')) continue;
    const header = readCheckpointHeader(path.join(dir, name));
    if (!header) continue;
    out.push({
      wiki: header.key.wiki,
      file: name,
      articles: header.articles,
      coordinates: header.coordinates,
      bytes: header.size,
      secondary: header.key.secondary,
      pointsFormat: header.key.pointsFormat,
      dumps: header.key.dumps,
      writtenAt: header.writtenAt,
    });
  }
  return out;
}
