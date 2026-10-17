// Personal fork: whether a camera's stream carries sound (server cctv/audioProbe.js).

import { msg } from '../../i18n/marker.js';

/**
 * 'audio' a sound track was found; 'silent' none (or a still/link);
 * 'likely' YouTube, whose streams always carry a track that may be silence;
 * 'unknown' not probed yet or nothing could be read.
 */
export const AUDIO_STATES = Object.freeze([
  'audio',
  'silent',
  'likely',
  'unknown',
]);

/** The camera's sound state from its health row, then its catalog record. */
export function resolveAudio(health, camera) {
  if (AUDIO_STATES.includes(health?.audio)) return health.audio;
  if (AUDIO_STATES.includes(camera?.audio)) return camera.audio;
  return 'unknown';
}

/** True when the camera probably has sound to hear. */
export function hasSound(camera) {
  return camera?.audio === 'audio' || camera?.audio === 'likely';
}

/** Meta-line word: 'sound', 'sound likely', 'silent', or '' when unknown. */
export function audioMetaLabel(camera) {
  switch (camera?.audio) {
    case 'audio':
      return msg('sound');
    case 'likely':
      return msg('sound likely');
    case 'silent':
      return msg('silent');
    default:
      return '';
  }
}
