// Personal fork: the SOUND tag in the camera picker and the meta line.
import assert from 'node:assert/strict';
import test from 'node:test';
import { audioTag, cameraSearchText, rankCameras } from './cctvCameraList.js';
import { poselessMetaText } from './cctvPanelKind.js';
import {
  AUDIO_STATES,
  audioMetaLabel,
  hasSound,
  resolveAudio,
} from '../layers/cctv/audio.js';

const cams = [
  {
    id: 'a',
    city: 'Baltimore',
    name: 'Harbor mic',
    feedType: 'hls',
    audio: 'audio',
  },
  {
    id: 'b',
    city: 'Baltimore',
    name: 'Inner Harbor',
    feedType: 'youtube',
    embed: { provider: 'youtube' },
    audio: 'likely',
  },
  {
    id: 'c',
    city: 'Baltimore',
    name: 'I-95',
    feedType: 'hls',
    audio: 'silent',
  },
  {
    id: 'd',
    city: 'Baltimore',
    name: 'MD-295',
    feedType: 'hls',
    audio: 'unknown',
  },
  { id: 'e', city: 'Baltimore', name: 'Old cam', feedType: 'image' },
];

test('audio state comes from health, then the catalog, else unknown', () => {
  assert.deepEqual(AUDIO_STATES, ['audio', 'silent', 'likely', 'unknown']);
  assert.equal(resolveAudio({ audio: 'audio' }, { audio: 'silent' }), 'audio');
  assert.equal(resolveAudio({}, { audio: 'likely' }), 'likely');
  assert.equal(resolveAudio(null, { audio: 'bogus' }), 'unknown');
  assert.equal(resolveAudio(null, null), 'unknown');
});

test('SOUND tags audio and likely cameras, and typing "sound" filters to them', () => {
  assert.equal(audioTag(cams[0]), 'SOUND');
  assert.equal(audioTag(cams[1]), 'SOUND');
  assert.equal(audioTag(cams[2]), '');
  assert.equal(hasSound(cams[3]), false);
  assert.equal(
    cameraSearchText(cams[0]),
    'Baltimore · Harbor mic · VIDEO · SOUND',
  );
  assert.equal(
    cameraSearchText(cams[1]),
    'Baltimore · Inner Harbor · YOUTUBE · SOUND',
  );
  assert.equal(cameraSearchText(cams[2]), 'Baltimore · I-95 · VIDEO');
  const found = rankCameras(cams, null, 'sound').map(
    (entry) => entry.camera.id,
  );
  assert.deepEqual(found.sort(), ['a', 'b']);
  assert.deepEqual(
    rankCameras(cams, null, 'harbor sound')
      .map((e) => e.camera.id)
      .sort(),
    ['a', 'b'],
  );
});

test('the meta line says sound, sound likely or silent; nothing when unknown', () => {
  assert.equal(audioMetaLabel(cams[0]), 'sound');
  assert.equal(audioMetaLabel(cams[1]), 'sound likely');
  assert.equal(audioMetaLabel(cams[2]), 'silent');
  assert.equal(audioMetaLabel(cams[3]), '');
  assert.equal(audioMetaLabel(cams[4]), '');
  const embed = {
    ...cams[1],
    provider: 'Harbor Cams',
    category: 'harbor',
    coordinatesQuality: 'area',
    lat: 39.29,
    lon: -76.61,
    timeZone: 'America/New_York',
    licenseClass: 'embed-only',
  };
  assert.equal(
    poselessMetaText(embed, Date.UTC(2026, 5, 21, 18, 5)).split('\n')[0],
    'Baltimore · HARBOR · PIN AT AREA · Harbor Cams · sound likely',
  );
});
