#!/usr/bin/env node
// Personal fork: serves one file, once, from an AirGPU build box
// (airgpu-buildbox.ps1 -Serve), so a build's output can be fetched from the
// user's PC. Not part of upstream God's Eye View.
//
//   node airgpu-serve.mjs <file> [--port 8765] [--minutes 30]
//
// The file is at /<32 random hex digits>/<its name> and nowhere else; any
// other request is a bare 404. The server stops after one complete
// download, or after --minutes. Plain HTTP: for public data only (the
// Wikipedia points are built from Wikimedia's public dumps), never for
// anything that needs a key. The script that starts it opens the port to
// one address only.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** argv → {file, port, minutes}; throws on nonsense. */
export function parseServeArgs(argv) {
  const options = { file: '', port: 8765, minutes: 30 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') options.port = Number(argv[++i]);
    else if (arg === '--minutes') options.minutes = Number(argv[++i]);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else if (!options.file) options.file = arg;
    else throw new Error(`one file only (${arg})`);
  }
  if (!options.file) throw new Error('usage: airgpu-serve.mjs <file>');
  if (
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error('--port takes 0 to 65535');
  if (!(options.minutes > 0)) throw new Error('--minutes takes a number');
  return options;
}

/**
 * Serve `file` once at a random path.
 * @returns {Promise<{port: number, urlPath: string, sha256: string,
 *   done: Promise<'downloaded'|'timeout'>, close: () => void}>}
 */
export async function serveOnce({
  file,
  port = 8765,
  minutes = 30,
  host = '0.0.0.0',
  token = crypto.randomBytes(16).toString('hex'),
}) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${file} is not a file`);
  const name = path.basename(file);
  const urlPath = `/${token}/${encodeURIComponent(name)}`;
  const sha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(file))
    .digest('hex');
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  let sent = false;
  const server = http.createServer((req, res) => {
    if (sent || req.method !== 'GET' || req.url !== urlPath) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size),
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    });
    const stream = fs.createReadStream(file);
    stream.pipe(res);
    // The whole file went out: no second download.
    res.on('finish', () => {
      sent = true;
      stop('downloaded');
    });
  });
  const timer = setTimeout(() => stop('timeout'), minutes * 60_000);
  function stop(reason) {
    clearTimeout(timer);
    server.close();
    server.closeAllConnections?.();
    finish(reason);
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    urlPath,
    sha256,
    done,
    close: () => stop('closed'),
  };
}

async function main() {
  const options = parseServeArgs(process.argv.slice(2));
  const served = await serveOnce(options);
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  console.log(
    `Serving ${path.basename(options.file)} once, for ${options.minutes} minutes.`,
  );
  console.log(`SHA-256 ${served.sha256}`);
  console.log(
    "From your PC, with the machine's public address (AirGPU shows it):",
  );
  console.log(
    `  curl -fo ${path.basename(options.file)} http://<public address>:${served.port}${served.urlPath}`,
  );
  if (addresses.length)
    console.log(`(this machine's own addresses: ${addresses.join(', ')})`);
  const reason = await served.done;
  console.log(
    reason === 'downloaded'
      ? 'Downloaded once; stopped.'
      : 'Time is up; stopped.',
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
