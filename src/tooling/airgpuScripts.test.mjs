// Personal fork: the AirGPU variant of the MSFS renderer's provisioning
// (tools/msfs-renderer/airgpu-*.ps1, airgpu-serve.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseServeArgs,
  serveOnce,
} from '../../tools/msfs-renderer/airgpu-serve.mjs';

const DIR = path.join('tools', 'msfs-renderer');
const SCRIPTS = ['airgpu-setup.ps1', 'airgpu-smoke.ps1', 'airgpu-buildbox.ps1'];
const read = (name) => fs.readFileSync(path.join(DIR, name), 'utf8');
const README = read('README.md');
const AIRGPU = README.slice(README.indexOf('## AirGPU (opportunistic)'));

/** The names a script gives its Step or Check blocks. */
const blockNames = (source, word) =>
  [...source.matchAll(new RegExp(`^${word} '([^']+)'`, 'gm'))].map((m) => m[1]);

test(
  'the AirGPU scripts parse as PowerShell',
  { skip: process.platform !== 'win32' },
  () => {
    for (const name of SCRIPTS) {
      const file = path.resolve(DIR, name).replace(/'/g, "''");
      const check = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }`,
        ],
        { encoding: 'utf8', timeout: 60_000 },
      );
      assert.equal(check.status, 0, `${name}: ${check.stdout}${check.stderr}`);
    }
  },
);

test('the README names every step and check of the AirGPU scripts', () => {
  assert.ok(AIRGPU.length > 1000, 'the AirGPU section is there');
  const names = [
    ...blockNames(read('airgpu-setup.ps1'), 'Step'),
    ...blockNames(read('airgpu-buildbox.ps1'), 'Step'),
    ...blockNames(read('airgpu-smoke.ps1'), 'Check'),
  ];
  assert.ok(names.length >= 20, `found ${names.length}`);
  for (const name of names)
    assert.ok(AIRGPU.includes(`\`${name}\``), `the README lacks \`${name}\``);
});

test('AirGPU supplies the driver and Parsec; the scripts ask for and keep no credential', () => {
  const setup = read('airgpu-setup.ps1');
  assert.doesNotMatch(setup, /nvidia-gaming|parsec-windows\.exe|GridSwCert/);
  assert.doesNotMatch(setup, /shutdown\.exe|Restart-Computer/);
  for (const name of SCRIPTS) {
    const source = read(name);
    assert.doesNotMatch(
      source,
      /Read-Host|Get-Credential|ConvertTo-SecureString|OBS_WEBSOCKET_PASSWORD\s*=/,
      name,
    );
    assert.doesNotMatch(
      source,
      /https:\/\/[^\s'"]*@github\.com|ghp_|github_pat_/,
      name,
    );
  }
  // The build box clones the public fork and copies nothing up.
  const box = read('airgpu-buildbox.ps1');
  assert.match(box, /https:\/\/github\.com\/doctutor\/gods-eye-view\.git/);
  assert.doesNotMatch(
    box,
    /(Copy-Item|Get-Content|Set-Content|Invoke-WebRequest|-OutFile)[^\n]*\.env\b/,
  );
});

test('the one-shot server: its arguments, one file at a random path, once', async (t) => {
  assert.deepEqual(parseServeArgs(['a.zip']), {
    file: 'a.zip',
    port: 8765,
    minutes: 30,
  });
  assert.deepEqual(parseServeArgs(['a.zip', '--port', '0', '--minutes', '5']), {
    file: 'a.zip',
    port: 0,
    minutes: 5,
  });
  assert.throws(() => parseServeArgs([]), /usage/);
  assert.throws(() => parseServeArgs(['a', 'b']), /one file/);
  assert.throws(() => parseServeArgs(['a', '--port', '70000']), /--port/);
  assert.throws(() => parseServeArgs(['a', '--open']), /unknown option/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-serve-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'points.zip');
  fs.writeFileSync(file, Buffer.from('zip bytes'));
  const served = await serveOnce({ file, port: 0, host: '127.0.0.1' });
  t.after(() => served.close());
  assert.match(served.urlPath, /^\/[0-9a-f]{32}\/points\.zip$/);
  const base = `http://127.0.0.1:${served.port}`;
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/points.zip`)).status, 404);
  const wrong = served.urlPath.replace(/^\/./, (m) =>
    m === '/0' ? '/1' : '/0',
  );
  assert.equal((await fetch(`${base}${wrong}`)).status, 404);
  const answer = await fetch(`${base}${served.urlPath}`);
  assert.equal(answer.status, 200);
  assert.equal(await answer.text(), 'zip bytes');
  assert.equal(await served.done, 'downloaded');
  await assert.rejects(
    fetch(`${base}${served.urlPath}`),
    'stopped after one download',
  );
});
