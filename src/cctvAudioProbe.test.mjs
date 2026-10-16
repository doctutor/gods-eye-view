// Personal fork: CCTV sound detection — parsers, probe, pacing and cache.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  classifyPlaylist,
  mp4Audio,
  segmentAudio,
  tsAudio,
  webmAudio,
} from '../server/providers/cctv/audioParse.js';
import {
  AUDIO_HOST_INTERVAL_MS,
  AUDIO_MEDIA_BYTES,
  createAudioProbe,
  probeStream,
  probeUrl,
  staticAudio,
} from '../server/providers/cctv/audioProbe.js';

// ── Fixtures ────────────────────────────────────────────────────────────

/** One 188-byte TS packet carrying `payload` (padded with 0xff). */
function tsPacket(pid, payload, { start = true } = {}) {
  const packet = new Uint8Array(188).fill(0xff);
  packet.set([0x47, (start ? 0x40 : 0) | (pid >> 8), pid & 0xff, 0x10]);
  packet.set(payload, 4);
  return packet;
}

/** PAT naming one program whose PMT is on `pmtPid`. */
function patPayload(pmtPid) {
  const length = 5 + 4 + 4;
  return [
    0x00, // pointer field
    0x00,
    0xb0 | (length >> 8),
    length & 0xff,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0x00,
    0x01,
    0xe0 | (pmtPid >> 8),
    pmtPid & 0xff,
    0xde,
    0xad,
    0xbe,
    0xef,
  ];
}

/** PMT listing elementary streams [[streamType, pid], …]. */
function pmtPayload(streams) {
  const entries = streams.flatMap(([type, pid]) => [
    type,
    0xe0 | (pid >> 8),
    pid & 0xff,
    0xf0,
    0x00,
  ]);
  const length = 9 + entries.length + 4;
  return [
    0x00,
    0x02,
    0xb0 | (length >> 8),
    length & 0xff,
    0x00,
    0x01,
    0xc1,
    0x00,
    0x00,
    0xe1,
    0x00,
    0xf0,
    0x00,
    ...entries,
    0xde,
    0xad,
    0xbe,
    0xef,
  ];
}

function tsSegment(streams) {
  const packets = [
    tsPacket(0, patPayload(0x1000)),
    tsPacket(0x1000, pmtPayload(streams)),
    tsPacket(0x100, [0x00, 0x00, 0x01, 0xe0], { start: true }),
  ];
  const out = new Uint8Array(188 * packets.length);
  packets.forEach((packet, i) => out.set(packet, i * 188));
  return out;
}
const TS_WITH_AUDIO = tsSegment([
  [0x1b, 0x100], // H.264 video
  [0x0f, 0x101], // AAC audio
]);
const TS_VIDEO_ONLY = tsSegment([[0x1b, 0x100]]);

/** An ISO BMFF box. */
function box(type, ...children) {
  const body = children.flatMap((child) => [...child]);
  const size = 8 + body.length;
  return Uint8Array.from([
    (size >>> 24) & 0xff,
    (size >>> 16) & 0xff,
    (size >>> 8) & 0xff,
    size & 0xff,
    ...[...type].map((c) => c.charCodeAt(0)),
    ...body,
  ]);
}
const hdlr = (handler) =>
  box(
    'hdlr',
    Uint8Array.from([
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...[...handler].map((c) => c.charCodeAt(0)),
      ...new Array(12).fill(0),
      0,
    ]),
  );
const trak = (handler) => box('trak', box('mdia', hdlr(handler)));
const concat = (...parts) => Uint8Array.from(parts.flatMap((p) => [...p]));
const MP4_WITH_AUDIO = concat(
  box('ftyp', Uint8Array.from([0x69, 0x73, 0x6f, 0x6d])),
  box('moov', trak('vide'), trak('soun')),
);
const MP4_VIDEO_ONLY = concat(
  box('ftyp', Uint8Array.from([0x69, 0x73, 0x6f, 0x6d])),
  box('moov', trak('vide')),
);

/** An EBML element with a one-byte size. */
const ebml = (id, ...children) => {
  const body = children.flatMap((child) => [...child]);
  return Uint8Array.from([...id, 0x80 | body.length, ...body]);
};
const trackEntry = (type) =>
  ebml([0xae], Uint8Array.from([0xd7, 0x81, 0x01]), ebml([0x83], [type]));
function webm(...types) {
  const header = ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], [0x77]));
  const tracks = ebml([0x16, 0x54, 0xae, 0x6b], ...types.map(trackEntry));
  // Segment with an unknown size, as live WebM writes it.
  const segment = Uint8Array.from([
    0x18,
    0x53,
    0x80,
    0x67,
    0x01,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    0xff,
    ...tracks,
  ]);
  return concat(header, segment);
}

// ── Parsers ─────────────────────────────────────────────────────────────

test('MPEG-TS: the PMT says whether an audio stream is present', () => {
  assert.equal(tsAudio(TS_WITH_AUDIO), 'audio');
  assert.equal(tsAudio(TS_VIDEO_ONLY), 'silent');
  for (const type of [0x03, 0x04, 0x11, 0x81, 0x87])
    assert.equal(
      tsAudio(
        tsSegment([
          [0x1b, 0x100],
          [type, 0x101],
        ]),
      ),
      'audio',
    );
  // No PMT in the bytes (only video packets): nothing known.
  assert.equal(tsAudio(tsPacket(0x100, [0, 0, 1, 0xe0])), 'unknown');
  assert.equal(tsAudio(new Uint8Array(400)), 'unknown');
  assert.equal(segmentAudio(TS_WITH_AUDIO), 'audio');
});

test('MP4 and fMP4: a trak handler of soun is audio', () => {
  assert.equal(mp4Audio(MP4_WITH_AUDIO), 'audio');
  assert.equal(mp4Audio(MP4_VIDEO_ONLY), 'silent');
  // moov at the end of the file (not in the head): unknown, not silent.
  assert.equal(
    mp4Audio(concat(box('ftyp', [1, 2, 3, 4]), box('mdat', [0, 0, 0, 0]))),
    'unknown',
  );
  assert.equal(segmentAudio(MP4_WITH_AUDIO), 'audio');
});

test('WebM: TrackType 2 is audio', () => {
  assert.equal(webmAudio(webm(1, 2)), 'audio');
  assert.equal(webmAudio(webm(1)), 'silent');
  assert.equal(segmentAudio(webm(1, 2)), 'audio');
  assert.equal(
    webmAudio(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x80])),
    'unknown',
  );
});

test('HLS playlists: EXT-X-MEDIA and CODECS answer; others point further', () => {
  const master = (inf, extra = '') =>
    `#EXTM3U\n${extra}#EXT-X-STREAM-INF:BANDWIDTH=800000${inf}\nchunklist.m3u8\n`;
  assert.deepEqual(classifyPlaylist(master(',CODECS="avc1.4d401f"')), {
    result: 'silent',
  });
  assert.deepEqual(
    classifyPlaylist(master(',CODECS="avc1.4d401f,mp4a.40.2"')),
    { result: 'audio' },
  );
  for (const codec of ['ac-3', 'ec-3', 'opus'])
    assert.deepEqual(
      classifyPlaylist(master(`,CODECS="avc1.64001f,${codec}"`)),
      {
        result: 'audio',
      },
    );
  assert.deepEqual(
    classifyPlaylist(
      master(
        ',AUDIO="aac"',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="en",URI="a.m3u8"\n',
      ),
    ),
    { result: 'audio' },
  );
  assert.deepEqual(classifyPlaylist(master('')), {
    next: { kind: 'variant', uri: 'chunklist.m3u8' },
  });
  assert.deepEqual(
    classifyPlaylist(
      '#EXTM3U\n#EXTINF:2.0,\nseg_1.ts\n#EXTINF:2.0,\nseg_2.ts\n',
    ),
    { next: { kind: 'segment', uri: 'seg_1.ts' } },
  );
  assert.deepEqual(
    classifyPlaylist('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n'),
    { next: { kind: 'init', uri: 'init.mp4' } },
  );
  assert.deepEqual(
    classifyPlaylist(
      '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:2,\na.ts\n',
    ),
    { result: 'unknown' },
  );
  assert.deepEqual(classifyPlaylist('<html>'), { result: 'unknown' });
});

// ── Probe ───────────────────────────────────────────────────────────────

/** A fetch over a URL → body map; records each request and its headers. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, headers: init.headers || {}, redirect: init.redirect });
    const body = routes[url];
    if (body === undefined) return new Response('', { status: 404 });
    return new Response(typeof body === 'string' ? body : Buffer.from(body));
  };
  return { fetchImpl, calls };
}

const hls = (url, extra = {}) => ({
  id: extra.id || url,
  feedType: 'hls',
  url,
  ...extra,
});

test('HLS probe: CODECS answer in one request; no codec info costs one segment', async () => {
  const mdot = 'https://strmr5.sha.maryland.gov/rtplive/abc/playlist.m3u8';
  const silent = fakeFetch({
    [mdot]:
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.42e01e"\nchunklist_w1.m3u8\n',
  });
  assert.deepEqual(await probeStream(hls(mdot), silent), {
    audio: 'silent',
    requests: 1,
  });
  assert.equal(silent.calls[0].redirect, 'error');

  const base = 'https://cams.example.org/live/cam1/';
  const deep = fakeFetch({
    [`${base}index.m3u8`]:
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nmedia.m3u8\n',
    [`${base}media.m3u8`]:
      '#EXTM3U\n#EXTINF:2,\nseg_9.ts\n#EXTINF:2,\nseg_10.ts\n',
    [`${base}seg_9.ts`]: TS_WITH_AUDIO,
  });
  assert.deepEqual(await probeStream(hls(`${base}index.m3u8`), deep), {
    audio: 'audio',
    requests: 3,
  });

  const fmp4 = fakeFetch({
    [`${base}f.m3u8`]:
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\na.m4s\n',
    [`${base}init.mp4`]: MP4_VIDEO_ONLY,
  });
  assert.deepEqual(await probeStream(hls(`${base}f.m3u8`), fmp4), {
    audio: 'silent',
    requests: 2,
  });

  // A variant on another origin is refused, like the HLS relay refuses it.
  const escape = fakeFetch({
    [`${base}x.m3u8`]:
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nhttps://evil.example/v.m3u8\n',
  });
  assert.equal(
    (await probeStream(hls(`${base}x.m3u8`), escape)).audio,
    'unknown',
  );
  assert.equal(escape.calls.length, 1);
});

test('MP4/WebM probe reads only the head of the file, with a Range header', async () => {
  const url = 'https://video.example.org/cam.mp4';
  const { fetchImpl, calls } = fakeFetch({ [url]: MP4_WITH_AUDIO });
  assert.deepEqual(
    await probeStream({ id: 'm', feedType: 'mp4', url }, { fetchImpl }),
    { audio: 'audio', requests: 1 },
  );
  assert.equal(calls[0].headers.Range, `bytes=0-${AUDIO_MEDIA_BYTES - 1}`);
  const webmUrl = 'https://video.example.org/cam.webm';
  const second = fakeFetch({ [webmUrl]: webm(1) });
  assert.equal(
    (await probeStream({ id: 'w', feedType: 'webm', url: webmUrl }, second))
      .audio,
    'silent',
  );
});

test('shortcuts: YouTube is likely, stills and links are silent, no request', async () => {
  assert.equal(
    staticAudio({ feedType: 'youtube', embed: { provider: 'youtube' } }),
    'likely',
  );
  for (const feedType of ['image', 'mjpeg', 'link'])
    assert.equal(staticAudio({ feedType }), 'silent', feedType);
  // A Windy or OpenCCTV still is an image; their hosts are never probed.
  assert.equal(
    staticAudio({ feedType: 'image', url: 'https://images.windy.com/x.jpg' }),
    'silent',
  );
  assert.equal(
    staticAudio({ feedType: 'hls', url: 'https://cdn.opencctv.org/a.m3u8' }),
    'unknown',
  );
  assert.equal(
    staticAudio({ feedType: 'hls', url: 'https://a.example/s.m3u8' }),
    null,
  );
  assert.equal(
    probeUrl({ feedType: 'hls', url: 'https://a.example/page.html' }),
    null,
  );
  assert.equal(
    probeUrl({ feedType: 'hls', url: 'ftp://a.example/s.m3u8' }),
    null,
  );
  assert.equal(
    probeUrl({ feedType: 'hls', url: 'https://u:p@a.example/s.m3u8' }),
    null,
  );
  const { fetchImpl, calls } = fakeFetch({});
  const probe = createAudioProbe({
    fetchImpl,
    cachePath: path.join(tmpdir(), 'gev-audio-none', 'x.json'),
  });
  assert.equal(
    await probe.request({
      id: 'yt',
      feedType: 'youtube',
      embed: { provider: 'youtube' },
    }),
    'likely',
  );
  assert.equal(
    await probe.request({ id: 'still', feedType: 'image' }),
    'silent',
  );
  assert.equal(calls.length, 0);
});

function tempCache(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'gev-audio-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'cctv-audio.json');
}

const silentMaster =
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.42e01e"\nc.m3u8\n';

test('probes are paced per host: one in flight, at least 2 s apart; hosts run side by side', async (t) => {
  const clock = { t: 0 };
  const slept = [];
  const routes = {};
  const sources = [];
  for (const host of ['a.example', 'a.example', 'a.example', 'b.example']) {
    const url = `https://${host}/cam${sources.length}.m3u8`;
    routes[url] = silentMaster;
    sources.push(hls(url, { id: `cam${sources.length}` }));
  }
  const { fetchImpl, calls } = fakeFetch(routes);
  const probe = createAudioProbe({
    fetchImpl,
    cachePath: tempCache(t),
    now: () => clock.t,
    sleep: async (ms) => {
      slept.push(ms);
      clock.t += ms;
    },
  });
  const results = await Promise.all(sources.map((s) => probe.request(s)));
  assert.deepEqual(results, ['silent', 'silent', 'silent', 'silent']);
  // Host a waited twice; host b never.
  assert.deepEqual(slept, [AUDIO_HOST_INTERVAL_MS, AUDIO_HOST_INTERVAL_MS]);
  assert.equal(calls.length, 4);
  assert.deepEqual(probe.stats().byHost, { 'a.example': 3, 'b.example': 1 });
  // Asking again (also twice at once) answers from the cache.
  await Promise.all([probe.request(sources[0]), probe.request(sources[0])]);
  assert.equal(calls.length, 4);
});

test('results persist for 7 days; an unknown is retried after a day', async (t) => {
  const cachePath = tempCache(t);
  const clock = { t: Date.UTC(2026, 9, 16) };
  const url = 'https://c.example/s.m3u8';
  const broken = 'https://c.example/broken.m3u8';
  const { fetchImpl, calls } = fakeFetch({ [url]: silentMaster });
  const first = createAudioProbe({
    fetchImpl,
    cachePath,
    now: () => clock.t,
    sleep: async () => {},
  });
  assert.equal(await first.request(hls(url, { id: 's' })), 'silent');
  assert.equal(await first.request(hls(broken, { id: 'b' })), 'unknown');
  await first.flush();
  assert.equal(calls.length, 2);

  const second = createAudioProbe({
    fetchImpl,
    cachePath,
    now: () => clock.t,
    sleep: async () => {},
  });
  await second.load();
  assert.equal(second.peek(hls(url, { id: 's' })), 'silent');
  assert.equal(second.peek(hls(broken, { id: 'b' })), 'unknown');
  // A changed URL is a different stream.
  assert.equal(
    second.peek(hls('https://c.example/new.m3u8', { id: 's' })),
    null,
  );

  clock.t += 2 * 86_400_000;
  assert.equal(second.peek(hls(url, { id: 's' })), 'silent');
  assert.equal(second.peek(hls(broken, { id: 'b' })), null);

  clock.t += 6 * 86_400_000;
  assert.equal(second.peek(hls(url, { id: 's' })), null);
  assert.equal(await second.request(hls(url, { id: 's' })), 'silent');
  assert.equal(calls.length, 3);
});

test('the sweep probes only unknown streams and reports each result', async (t) => {
  const routes = {
    'https://d.example/1.m3u8': silentMaster,
    'https://e.example/2.m3u8':
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="avc1.4d,mp4a.40.2"\nc.m3u8\n',
  };
  const { fetchImpl, calls } = fakeFetch(routes);
  const probe = createAudioProbe({
    fetchImpl,
    cachePath: tempCache(t),
    sleep: async () => {},
  });
  const seen = {};
  const count = await probe.sweep(
    [
      hls('https://d.example/1.m3u8', { id: 'one' }),
      hls('https://e.example/2.m3u8', { id: 'two' }),
      { id: 'still', feedType: 'image' },
    ],
    { onResult: (id, audio) => (seen[id] = audio) },
  );
  assert.equal(count, 2);
  assert.deepEqual(seen, { one: 'silent', two: 'audio' });
  assert.equal(calls.length, 2);
  assert.equal(
    await probe.sweep([hls('https://d.example/1.m3u8', { id: 'one' })]),
    0,
  );
});
