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
const SCRIPTS = [
  'airgpu-setup.ps1',
  'airgpu-smoke.ps1',
  'airgpu-display.ps1',
  'airgpu-buildbox.ps1',
];
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

// airgpu-setup.ps1 -ObsConfigOnly DIR: the files OBS 32 reads, written
// into DIR as if it were %APPDATA%\obs-studio, and nothing else.
function obsConfig(dir, ...extra) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.resolve(DIR, 'airgpu-setup.ps1'),
      '-ObsConfigOnly',
      dir,
      ...extra,
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
}

test(
  'the OBS files: WebSocket, profile, encoder, scene and user.ini, with a password made once and never printed',
  { skip: process.platform !== 'win32' },
  (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-obs-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    // OBS's own user.ini, with settings of its own that must stay.
    fs.writeFileSync(
      path.join(dir, 'user.ini'),
      '[General]\nPre19Defaults=false\n\n[Basic]\nProfile=Untitled\nConfigOnNewProfile=true\n\n[BasicWindow]\ngeometry=abc\n',
    );
    const first = obsConfig(
      dir,
      '-ObsCanvas',
      '3840x2160',
      '-ObsOutput',
      '1920x1080',
      '-ObsCodec',
      'h264',
      '-ObsCqp',
      '20',
    );
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.match(
      first.stdout,
      /written; canvas 3840x2160, output 1920x1080, h264 CQP 20 at 60 fps/,
    );
    const read = (...parts) =>
      fs.readFileSync(path.join(dir, ...parts), 'utf8');
    const json = (...parts) => {
      const text = read(...parts);
      assert.notEqual(
        text.charCodeAt(0),
        0xfeff,
        `${parts.join('/')} has no BOM`,
      );
      return JSON.parse(text);
    };

    const password = read('obs-websocket.txt');
    assert.match(password, /^[A-Za-z0-9]{24}$/);
    assert.ok(!first.stdout.includes(password), 'the password is not printed');
    assert.deepEqual(json('plugin_config', 'obs-websocket', 'config.json'), {
      alerts_enabled: false,
      auth_required: true,
      first_load: false,
      server_enabled: true,
      server_password: password,
      server_port: 4455,
    });

    const ini = read('basic', 'profiles', 'GEV', 'basic.ini');
    for (const line of [
      'Name=GEV',
      'BaseCX=3840',
      'BaseCY=2160',
      'OutputCX=1920',
      'OutputCY=1080',
      'FPSCommon=60',
      'Mode=Advanced',
      'RecType=Standard',
      'RecFormat2=hybrid_mp4',
      'RecEncoder=obs_nvenc_h264_tex',
      String.raw`RecFilePath=C:\gev\recordings`,
    ])
      assert.ok(ini.split(/\r?\n/).includes(line), `basic.ini has ${line}`);
    assert.match(ini, /^\[General\]/, 'sections in order');
    assert.deepEqual(json('basic', 'profiles', 'GEV', 'recordEncoder.json'), {
      rate_control: 'CQP',
      cqp: 20,
      preset: 'p5',
      tune: 'hq',
      multipass: 'qres',
      profile: 'high',
      bf: 2,
      keyint_sec: 2,
    });

    const scenes = json('basic', 'scenes', 'GEV.json');
    assert.equal(scenes.name, 'GEV');
    assert.equal(scenes.current_program_scene, 'GEV');
    const byId = Object.fromEntries(scenes.sources.map((s) => [s.id, s]));
    assert.deepEqual(Object.keys(byId).sort(), [
      'game_capture',
      'monitor_capture',
      'scene',
    ]);
    assert.equal(byId.game_capture.settings.capture_mode, 'window');
    assert.equal(
      byId.game_capture.settings.window,
      'Microsoft Flight Simulator 2024::FlightSimulator2024.exe',
    );
    assert.equal(
      byId.game_capture.settings.priority,
      2,
      'matched by its executable',
    );
    assert.equal(
      byId.monitor_capture.settings.monitor_id,
      String.raw`\\.\DISPLAY1`,
    );
    const items = byId.scene.settings.items;
    assert.deepEqual(
      items.map((i) => [i.name, i.visible]),
      [
        ['Display (fallback)', false],
        ['MSFS 2024 (game capture)', true],
      ],
    );
    for (const item of items) {
      assert.equal(item.bounds_type, 2, 'scaled to fit');
      assert.deepEqual(item.bounds, { x: 3840, y: 2160 });
    }

    const user = read('user.ini');
    for (const line of [
      'Pre19Defaults=false',
      'FirstRun=true',
      'Profile=GEV',
      'ProfileDir=GEV',
      'SceneCollection=GEV',
      'SceneCollectionFile=GEV',
      'ConfigOnNewProfile=true',
      'geometry=abc',
    ])
      assert.ok(user.split(/\r?\n/).includes(line), `user.ini has ${line}`);
    assert.ok(!user.includes('Profile=Untitled'));

    // Again: nothing to write, and the same password.
    const again = obsConfig(
      dir,
      '-ObsCanvas',
      '3840x2160',
      '-ObsOutput',
      '1920x1080',
      '-ObsCodec',
      'h264',
      '-ObsCqp',
      '20',
    );
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /: unchanged;/);
    assert.equal(read('obs-websocket.txt'), password);
    // OBS rewrites its files in its own layout: still nothing to write.
    const sceneFile = path.join(dir, 'basic', 'scenes', 'GEV.json');
    fs.writeFileSync(
      sceneFile,
      JSON.stringify(JSON.parse(fs.readFileSync(sceneFile, 'utf8'))),
    );
    assert.match(
      obsConfig(
        dir,
        '-ObsCanvas',
        '3840x2160',
        '-ObsOutput',
        '1920x1080',
        '-ObsCodec',
        'h264',
        '-ObsCqp',
        '20',
      ).stdout,
      /: unchanged;/,
    );
    // A new option: written again (HEVC by default).
    assert.match(
      obsConfig(dir, '-ObsCanvas', '1920x1080').stdout,
      /written; canvas 1920x1080, output 1920x1080, hevc CQP 18 at 60 fps/,
    );
    assert.match(
      read('basic', 'profiles', 'GEV', 'basic.ini'),
      /RecEncoder=obs_nvenc_hevc_tex/,
    );
  },
);
