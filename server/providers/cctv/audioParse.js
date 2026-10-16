// Personal fork: does a camera stream carry sound? Pure playlist/container parsers.

/** Audio codecs as they appear in HLS CODECS attributes. */
const AUDIO_CODEC = /(?:^|[\s,"])(?:mp4a|ac-3|ec-3|opus|mp3|flac|vorbis)\b/i;
/** MPEG-TS PMT stream types that carry audio. */
export const TS_AUDIO_STREAM_TYPES = Object.freeze([
  0x03, 0x04, 0x0f, 0x11, 0x81, 0x87,
]);

/** A playlist attribute list (`A=1,B="x,y"`) as an object. */
function attributes(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let match;
  while ((match = re.exec(line)))
    out[match[1]] = match[2].replace(/^"|"$/g, '');
  return out;
}

/**
 * What an HLS playlist says about sound.
 * - `{result}`: 'audio' or 'silent' from a master playlist's EXT-X-MEDIA or
 *   CODECS, or 'unknown' (encrypted, malformed);
 * - `{next: {kind: 'variant'|'segment'|'init', uri}}`: look further.
 * @param {string} text
 */
export function classifyPlaylist(text) {
  const body = String(text || '');
  if (!body.startsWith('#EXTM3U')) return { result: 'unknown' };
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const key = lines.find((line) => line.startsWith('#EXT-X-KEY:'));
  if (key && attributes(key).METHOD !== 'NONE') return { result: 'unknown' };
  if (lines.some((line) => line.startsWith('#EXT-X-STREAM-INF:'))) {
    if (
      lines.some(
        (line) =>
          line.startsWith('#EXT-X-MEDIA:') && attributes(line).TYPE === 'AUDIO',
      )
    )
      return { result: 'audio' };
    const codecs = [];
    let variant = null;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
      codecs.push(attributes(lines[i]).CODECS ?? null);
      const uri = lines
        .slice(i + 1)
        .find((line) => line && !line.startsWith('#'));
      variant ||= uri || null;
    }
    if (codecs.some((value) => value && AUDIO_CODEC.test(value)))
      return { result: 'audio' };
    if (codecs.length && codecs.every((value) => value))
      return { result: 'silent' };
    return variant
      ? { next: { kind: 'variant', uri: variant } }
      : { result: 'unknown' };
  }
  const map = lines.find((line) => line.startsWith('#EXT-X-MAP:'));
  if (map) {
    const uri = attributes(map).URI;
    return uri ? { next: { kind: 'init', uri } } : { result: 'unknown' };
  }
  if (!lines.some((line) => line.startsWith('#EXTINF:')))
    return { result: 'unknown' };
  const segment = lines.find((line) => line && !line.startsWith('#'));
  return segment
    ? { next: { kind: 'segment', uri: segment } }
    : { result: 'unknown' };
}

/** Bytes after a TS packet's header and adaptation field, or null. */
function tsPayload(bytes, at) {
  const control = (bytes[at + 3] >> 4) & 0x3;
  if (control === 0 || control === 2) return null;
  let start = at + 4;
  if (control === 3) start += 1 + bytes[at + 4];
  return start < at + 188 ? start : null;
}

/** One PSI section from a packet that starts it: [sectionStart, end) or null. */
function psiSection(bytes, at) {
  if (!(bytes[at + 1] & 0x40)) return null;
  const payload = tsPayload(bytes, at);
  if (payload === null) return null;
  const start = payload + 1 + bytes[payload];
  if (start + 3 > at + 188) return null;
  const length = ((bytes[start + 1] & 0x0f) << 8) | bytes[start + 2];
  return { start, end: Math.min(start + 3 + length, at + 188) };
}

/**
 * Audio in an MPEG-TS segment, from its PAT and PMT: 'audio', 'silent' (a PMT
 * without an audio stream) or 'unknown' (no PMT found in the bytes).
 * @param {Uint8Array} bytes
 */
export function tsAudio(bytes) {
  let first = -1;
  for (let i = 0; i < Math.min(bytes.length, 188 * 4); i++)
    if (bytes[i] === 0x47 && bytes[i + 188] === 0x47) {
      first = i;
      break;
    }
  if (first < 0) return 'unknown';
  const pmtPids = new Set();
  let sawPmt = false;
  for (let at = first; at + 188 <= bytes.length; at += 188) {
    if (bytes[at] !== 0x47) break;
    const pid = ((bytes[at + 1] & 0x1f) << 8) | bytes[at + 2];
    if (pid === 0) {
      const section = psiSection(bytes, at);
      if (!section || bytes[section.start] !== 0x00) continue;
      for (let i = section.start + 8; i + 4 <= section.end - 4; i += 4) {
        const program = (bytes[i] << 8) | bytes[i + 1];
        if (program !== 0)
          pmtPids.add(((bytes[i + 2] & 0x1f) << 8) | bytes[i + 3]);
      }
    } else if (pmtPids.has(pid)) {
      const section = psiSection(bytes, at);
      if (!section || bytes[section.start] !== 0x02) continue;
      sawPmt = true;
      const infoLength =
        ((bytes[section.start + 10] & 0x0f) << 8) | bytes[section.start + 11];
      for (let i = section.start + 12 + infoLength; i + 5 <= section.end - 4;) {
        if (TS_AUDIO_STREAM_TYPES.includes(bytes[i])) return 'audio';
        const esLength = ((bytes[i + 3] & 0x0f) << 8) | bytes[i + 4];
        i += 5 + esLength;
      }
    }
  }
  return sawPmt ? 'silent' : 'unknown';
}

const MP4_CONTAINERS = new Set(['moov', 'trak', 'mdia']);

/**
 * Audio in an MP4 / fMP4 init segment: a trak whose handler is 'soun'.
 * 'silent' when a moov with tracks has none; 'unknown' when no moov is in
 * the bytes (it may sit at the end of the file, or this is a media segment).
 * @param {Uint8Array} bytes
 */
export function mp4Audio(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = (at) =>
    String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  let sawMoov = false;
  let tracks = 0;
  function walk(start, end, depth) {
    let at = start;
    while (at + 8 <= end) {
      let size = view.getUint32(at);
      const kind = type(at + 4);
      let header = 8;
      if (size === 1) {
        if (at + 16 > end) return null;
        size = Number(view.getBigUint64(at + 8));
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header) return null;
      const boxEnd = Math.min(at + size, end);
      if (kind === 'moov') sawMoov = true;
      if (kind === 'trak') tracks++;
      if (kind === 'hdlr' && at + header + 12 <= boxEnd) {
        if (type(at + header + 8) === 'soun') return 'audio';
      } else if (MP4_CONTAINERS.has(kind) && depth < 6) {
        const found = walk(at + header, boxEnd, depth + 1);
        if (found) return found;
      }
      at += size;
    }
    return null;
  }
  if (walk(0, bytes.length, 0)) return 'audio';
  return sawMoov && tracks > 0 ? 'silent' : 'unknown';
}

/** An EBML variable-length integer at `at`: {value, length} or null. */
function vint(bytes, at, keepMarker) {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = value * 256 + bytes[at + i];
    if (bytes[at + i] !== 0xff) unknown = false;
  }
  return { value, length, unknown: !keepMarker && unknown };
}

const EBML_SEGMENT = 0x18538067;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_CLUSTER = 0x1f43b675;

/**
 * Audio in a WebM/Matroska header: a TrackEntry with TrackType 2.
 * 'silent' when Tracks lists no audio; 'unknown' without a Tracks element.
 * @param {Uint8Array} bytes
 */
export function webmAudio(bytes) {
  let sawTracks = false;
  function walk(start, end) {
    let at = start;
    while (at < end) {
      const id = vint(bytes, at, true);
      if (!id) return null;
      const size = vint(bytes, at + id.length, false);
      if (!size) return null;
      const dataStart = at + id.length + size.length;
      const dataEnd = size.unknown
        ? end
        : Math.min(dataStart + size.value, end);
      if (id.value === EBML_CLUSTER) return null;
      if (id.value === EBML_TRACKS) sawTracks = true;
      if (id.value === EBML_TRACK_TYPE && bytes[dataStart] === 2)
        return 'audio';
      if (
        id.value === EBML_SEGMENT ||
        id.value === EBML_TRACKS ||
        id.value === EBML_TRACK_ENTRY
      ) {
        const found = walk(dataStart, dataEnd);
        if (found) return found;
      }
      at = dataEnd;
    }
    return null;
  }
  if (walk(0, bytes.length)) return 'audio';
  return sawTracks ? 'silent' : 'unknown';
}

/** Which parser a segment's bytes need: MPEG-TS sync byte, else ISO BMFF. */
export function segmentAudio(bytes) {
  if (bytes[0] === 0x47 && bytes[188] === 0x47) return tsAudio(bytes);
  if (bytes[0] === 0x1a && bytes[1] === 0x45) return webmAudio(bytes);
  return mp4Audio(bytes);
}
