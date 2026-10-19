import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the builds keep their raw downloads (the HydroSHEDS ZIPs, the
 * census boundaries, the Overture files and footers, the Wikipedia dump):
 * by default under each build's own cache directory, as `raw/`; with
 * GEV_RAW_DIR set (say a NAS share, `X:\gev-data`), under
 * `GEV_RAW_DIR/<build>/raw`, so a rebuild or a new region on another disk
 * reuses what was downloaded once. The derived builds stay where they are.
 *
 * A share can be slow or gone. Every build checks the raw directory first
 * (`checkRawDir`), in a child process with a time limit, so a dead share
 * says so instead of hanging the build on a blocked file call.
 *
 * Personal fork tooling; not part of upstream God's Eye View.
 */

export const RAW_DIR_ENV = 'GEV_RAW_DIR';
/** How long the raw directory may take to answer the check. */
export const RAW_CHECK_TIMEOUT_MS = 20_000;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * GEV_RAW_DIR from the repository's .env and .env.local (Vite's order:
 * .env.local wins), for builds run without them loaded. Only this one key
 * is read.
 */
export function rawDirFromDotEnv(root = REPO_ROOT) {
  let value;
  for (const name of ['.env', '.env.local']) {
    let text = '';
    try {
      text = fs.readFileSync(path.join(root, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?GEV_RAW_DIR\s*=\s*(.*?)\s*$/.exec(line);
      if (match) value = match[1].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return value;
}

/** GEV_RAW_DIR (the environment's, else .env's) as an absolute path, or null. */
export function rawRoot(env = process.env, { root = REPO_ROOT } = {}) {
  const value = String(
    (RAW_DIR_ENV in env ? env[RAW_DIR_ENV] : rawDirFromDotEnv(root)) || '',
  ).trim();
  return value ? path.resolve(value) : null;
}

/**
 * A build's raw directory: GEV_RAW_DIR/<build>/raw when set, else
 * `fallback` (the build's own raw/ under its cache directory).
 */
export function rawDirFor(build, fallback, env = process.env, options = {}) {
  if (!/^[a-z][a-z0-9-]*$/.test(build))
    throw new Error(`bad build name ${build}`);
  const root = rawRoot(env, options);
  return root ? path.join(root, build, 'raw') : fallback;
}

/** How a build's status names its raw directory. */
export function rawDirLabel(dir, env = process.env) {
  return rawRoot(env) ? `${dir} (${RAW_DIR_ENV})` : dir;
}

// The check run in a child: make the directory, write a file, rename it,
// read it back, remove it; or, to read only, list it.
// A failure prints one line tagged GEV_RAW_CHECK (its code and message).
const READ_PROBE = `
const fs = require('node:fs');
try {
  fs.readdirSync(process.argv[1]);
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error('GEV_RAW_CHECK ' + (error.code || '') + ': ' + error.message);
    process.exit(3);
  }
}
`;
const PROBE = `
const fs = require('node:fs');
const path = require('node:path');
const dir = process.argv[1];
try {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, '.gev-raw-check.' + process.pid + '.tmp');
  const file = path.join(dir, '.gev-raw-check.' + process.pid);
  fs.writeFileSync(tmp, 'ok');
  fs.renameSync(tmp, file);
  if (fs.readFileSync(file, 'utf8') !== 'ok') throw new Error('read back differs');
  fs.rmSync(file);
} catch (error) {
  console.error('GEV_RAW_CHECK ' + (error.code || '') + ': ' + error.message);
  process.exit(3);
}
`;

/**
 * Check that a raw directory can be written (made, written, renamed, read,
 * removed), or with `write: false` read (a status), within `timeoutMs`.
 * Throws an Error that says what to do.
 * @returns {{dir: string, ms: number}}
 */
export function checkRawDir(
  dir,
  { env = process.env, timeoutMs = RAW_CHECK_TIMEOUT_MS, write = true } = {},
) {
  const started = Date.now();
  const result = spawnSync(
    process.execPath,
    ['-e', write ? PROBE : READ_PROBE, dir],
    {
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  const where = rawRoot(env) ? `${dir} (from ${RAW_DIR_ENV})` : dir;
  if (result.error?.code === 'ETIMEDOUT' || result.signal)
    throw new Error(
      `The raw directory ${where} did not answer within ${Math.round(timeoutMs / 1000)} s: is the share connected? Connect it, or unset ${RAW_DIR_ENV} to keep raw files in the cache.`,
    );
  if (result.error || result.status !== 0) {
    const detail = (
      String(result.stderr || '')
        .split('\n')
        .find((line) => line.startsWith('GEV_RAW_CHECK ')) ||
      result.error?.message ||
      ''
    ).replace(/^GEV_RAW_CHECK /, '');
    throw new Error(
      `The raw directory ${where} cannot be ${write ? 'written' : 'read'}${detail ? ` (${detail.trim().slice(0, 200)})` : ''}. Fix it, or unset ${RAW_DIR_ENV} to keep raw files in the cache.`,
    );
  }
  return { dir, ms: Date.now() - started };
}
