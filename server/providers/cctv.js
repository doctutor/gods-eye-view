import { createCctvCatalog } from './cctv/catalog.js';
import {
  normalizeFeedType,
  isVideoFeedType,
  toFiniteNumber,
} from './cctv/normalize.js';
import {
  buildSyntheticCctvSvg,
  proxyMediaResponse,
  fetchCctvImageFromUpstream,
  fetchTxdotSnapshot,
  fetchCctvMediaUpstream,
  watchDownstreamClose,
} from './cctv/media.js';
import {
  CCTV_FRAME_FETCH_TIMEOUT_MS,
  CCTV_MAX_SOURCES_CEILING,
} from './cctv/constants.js';
import { sanitizeCctvRangeHeader } from './cctv/range.js';
import { createHlsPuller } from './cctv/stream.js';
import { createFrameCache } from './cctv/frameCache.js';
import { createFeaturedQueueRoutes } from './cctv/featuredQueue.js';
// Personal fork: whether a camera's stream carries sound.
import { createAudioProbe } from './cctv/audioProbe.js';
import { discardResponseBody } from './common/http.js';
import { googleServerApiKey } from './places/google-key.js';
export { CCTV_FRAME_FETCH_TIMEOUT_MS, fetchCctvImageFromUpstream };
/**
 * Vite plugin: CCTV camera proxy with source registry, frame/media serving,
 * fallback chain (upstream -> Street View -> synthetic SVG), and health tracking.
 *
 * Endpoints:
 *   GET /api/cctv/sources        — list all registered camera sources
 *   GET /api/cctv/health         — per-camera health/status report
 *   GET /api/cctv/stream/:id     — stream info (feedType, URLs) for a camera
 *   GET /api/cctv/media/:id      — proxy live video/image media from upstream
 *   GET /api/cctv/frame/:id      — single frame with fallback chain
 *
 * @returns {import('vite').Plugin}
 */
export function cctvProxy({ sourceRoot = process.cwd() } = {}) {
  const getCctvSources = createCctvCatalog({ sourceRoot });
  /** @type {Map<string,{id:string,status:string,sourceKind:string,label:string,message:string,updatedAt:number}>} */
  const health = new Map();
  /** Cap on health map entries to prevent unbounded growth. Sized to the
   * CCTV_MAX_SOURCES ceiling so health/status observability is never evicted
   * for any catalog the proxy can actually serve. */
  const HEALTH_MAX_ENTRIES = CCTV_MAX_SOURCES_CEILING;
  /** Live HLS strategies (see ./cctv/stream.js). Shared across dev and preview. */
  const puller = createHlsPuller();
  // Personal fork: upstream frames kept for their Cache-Control lifetime.
  const frameCache = createFrameCache();

  /** Update the health entry for a camera, evicting the oldest entry if at capacity. */
  const setHealth = (cameraId, patch) => {
    // Evict oldest entries if the health map grows beyond the cap
    if (!health.has(cameraId) && health.size >= HEALTH_MAX_ENTRIES) {
      const oldest = health.keys().next().value;
      health.delete(oldest);
    }
    const prev = health.get(cameraId) || {};
    health.set(cameraId, {
      id: cameraId,
      status: patch.status || prev.status || 'unknown',
      sourceKind: patch.sourceKind || prev.sourceKind || 'unknown',
      label: patch.label || prev.label || '',
      message: patch.message || prev.message || '',
      updatedAt: Date.now(),
    });
  };

  /**
   * Personal fork: probed sound per camera, kept apart from health so an
   * audio-only row never invents a status or source kind.
   */
  const audioProbe = createAudioProbe();
  audioProbe.load();
  const audioById = new Map();
  const noteAudio = (cameraId, audio) => {
    if (!audio || audio === 'unknown') return;
    audioById.delete(cameraId);
    audioById.set(cameraId, audio);
    while (audioById.size > HEALTH_MAX_ENTRIES)
      audioById.delete(audioById.keys().next().value);
  };
  /**
   * Probe a camera's sound the first time its stream is asked for, a few
   * seconds later so the probe never races the viewer's own first request.
   */
  const AUDIO_PROBE_DELAY_MS = 3000;
  const probeAudio = (cameraId, source) => {
    if (!source || audioProbe.peek(source)) return;
    const timer = setTimeout(() => {
      audioProbe
        .request(source)
        .then((audio) => noteAudio(cameraId, audio))
        .catch(() => {});
    }, AUDIO_PROBE_DELAY_MS);
    timer.unref?.();
  };
  let audioSweepStarted = false;
  /** CCTV_AUDIO_SWEEP=1: probe the catalog's streams at the per-host pace. */
  const startAudioSweep = (sources) => {
    if (audioSweepStarted || process.env.CCTV_AUDIO_SWEEP !== '1') return;
    audioSweepStarted = true;
    const streams = sources.filter((source) =>
      ['hls', 'mp4', 'webm'].includes(normalizeFeedType(source.feedType)),
    );
    audioProbe
      .sweep(streams, { onResult: noteAudio })
      .then((count) => {
        const { probes, requests } = audioProbe.stats();
        console.log(
          `[CCTV:audio] sweep checked ${count} streams (${probes} probes, ${requests} requests)`,
        );
      })
      .catch(() => {});
  };

  /** Snapshot all camera health entries as an array. */
  const listHealth = () => {
    const rows = Array.from(health.values(), (entry) =>
      audioById.has(entry.id)
        ? { ...entry, audio: audioById.get(entry.id) }
        : entry,
    );
    for (const [id, audio] of audioById)
      if (!health.has(id)) rows.push({ id, audio });
    return rows;
  };

  /** Build a JSON payload describing stream info (feedType, URLs) for a camera. */
  const buildStreamPayload = (source, cameraId) => {
    const feedType = normalizeFeedType(source?.feedType || 'image');
    return {
      id: cameraId,
      feedType,
      mediaUrl: isVideoFeedType(feedType)
        ? `/api/cctv/media/${encodeURIComponent(cameraId)}`
        : null,
      frameUrl: `/api/cctv/frame/${encodeURIComponent(cameraId)}`,
      provider: source?.provider || '',
      sourceKind:
        source?.sourceKind || (source?.url ? 'configured' : 'fallback'),
    };
  };

  /**
   * Fetch a Google Street View static image as a fallback frame. Server-side
   * call, never reaches the browser — prefers GOOGLE_MAPS_SERVER_API_KEY
   * (#33: a key scoped to Street View Static/Places, restricted by server IP
   * rather than HTTP referrer) and falls back to the browser-exposed
   * GOOGLE_MAPS_API_KEY for setups that haven't split the two yet.
   */
  const streetViewFallback = async ({ lat, lon, heading, fov, pitch }) => {
    const streetViewKey = googleServerApiKey();
    if (!streetViewKey || !Number.isFinite(lat) || !Number.isFinite(lon))
      return null;
    try {
      const sv = new URL('https://maps.googleapis.com/maps/api/streetview');
      sv.searchParams.set('size', '960x540');
      sv.searchParams.set('location', `${lat},${lon}`);
      sv.searchParams.set(
        'heading',
        String(Number.isFinite(heading) ? heading : 0),
      );
      sv.searchParams.set(
        'fov',
        String(Number.isFinite(fov) ? Math.max(20, Math.min(120, fov)) : 80),
      );
      sv.searchParams.set(
        'pitch',
        String(Number.isFinite(pitch) ? Math.max(-40, Math.min(20, pitch)) : 0),
      );
      sv.searchParams.set('source', 'outdoor');
      sv.searchParams.set('return_error_code', 'true');
      sv.searchParams.set('key', streetViewKey);

      const svResp = await fetch(sv.toString(), {
        headers: { 'User-Agent': 'gods-eye-view-cctv-proxy/1.0' },
        signal: AbortSignal.timeout(CCTV_FRAME_FETCH_TIMEOUT_MS),
      });
      const svType = svResp.headers.get('content-type') || '';
      if (!svResp.ok || !svType.startsWith('image/')) {
        await discardResponseBody(svResp);
        return null;
      }

      return {
        ok: true,
        body: Buffer.from(await svResp.arrayBuffer()),
        contentType: svType,
      };
    } catch {
      return null;
    }
  };

  /** The fields a camera source exposes to the browser. */
  const publicSource = (source) => ({
    id: source.id,
    pack: source.pack,
    name: source.name,
    city: source.city,
    cityId: source.cityId,
    provider: source.provider,
    lat: source.lat,
    lon: source.lon,
    headingDeg: source.headingDeg,
    headingConfidence: source.headingConfidence || '',
    pitchDeg: source.pitchDeg,
    fovDeg: source.fovDeg,
    rangeM: source.rangeM,
    mountHeightM: source.mountHeightM,
    groundElevationM: source.groundElevationM,
    feedType: normalizeFeedType(source.feedType),
    sourceKind: source.sourceKind || (source.url ? 'configured' : 'fallback'),
    poseSource: source.poseSource,
    license: source.license,
    credit: source.credit || '',
    code: source.code || '',
    groundHeights: source.groundHeights || null,
    // Personal fork: sound, when known without a request or from the cache.
    ...(audioProbe.peek(source) ? { audio: audioProbe.peek(source) } : {}),
    // Personal fork: provenance of featured streams (cctv/featured.js) and
    // dynamic webcams (cctv/windy.js).
    ...(source.embed || source.licenseClass
      ? {
          ...(source.embed ? { embed: source.embed } : {}),
          liveStatus: source.liveStatus,
          category: source.category,
          coordinatesQuality: source.coordinatesQuality,
          operatorUrl: source.operatorUrl,
          licenseClass: source.licenseClass,
        }
      : {}),
  });

  /**
   * Personal fork: id lookup over every indexed camera, so frames and media
   * resolve a camera loaded by proximity like one in the capped catalog.
   * Rebuilt only when the catalog refreshes.
   */
  let lookupFor = null;
  let lookup = { get: () => undefined };
  const sourceLookup = (sources) => {
    const index = getCctvSources.index?.() || [];
    if (lookupFor?.sources === sources && lookupFor?.index === index)
      return lookup;
    const map = new Map(index.map((source) => [source.id, source]));
    for (const source of sources) map.set(source.id, source);
    lookupFor = { sources, index };
    lookup = {
      // Cameras from dynamic sources (Windy) are remembered by the source.
      get: (id) => map.get(id) ?? getCctvSources.dynamic?.(id) ?? undefined,
    };
    return lookup;
  };

  const installMiddleware = (server) => {
    server.httpServer?.on('close', () => {
      puller.shutdown();
    });
    // Personal fork: the featured-cam review queue (cctv/featuredQueue.js);
    // an accepted cam is in the next catalog refresh.
    server.middlewares.use(
      '/api/cctv/featured',
      createFeaturedQueueRoutes({
        sourceRoot,
        onAccepted: () => getCctvSources.invalidate?.(),
      }),
    );
    server.middlewares.use('/api/cctv', async (req, res) => {
      try {
        const sources = await getCctvSources();
        const sourceById = sourceLookup(sources);
        startAudioSweep(sources);
        const url = new URL(req.url || '/', 'http://localhost');

        if (url.pathname === '/sources' && url.searchParams.has('near')) {
          // Personal fork: every indexed camera near a point, uncapped.
          const [lat, lon] = String(url.searchParams.get('near'))
            .split(',')
            .map(Number);
          const near = await getCctvSources.near?.(lat, lon, {
            radiusKm: Number(url.searchParams.get('radiusKm')),
            limit: Number(url.searchParams.get('limit')),
          });
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ sources: (near || []).map(publicSource) }));
          return;
        }

        if (url.pathname === '/sources') {
          const body = {
            trimmedPacks: getCctvSources.trimmedPacks?.() ?? [],
            sources: sources.map(publicSource),
          };
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(body));
          return;
        }

        if (url.pathname === '/health') {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify({ cameras: listHealth() }));
          return;
        }

        if (url.pathname.startsWith('/stream/')) {
          const cameraId =
            decodeURIComponent(url.pathname.replace('/stream/', '').trim()) ||
            'camera';
          const source = sourceById.get(cameraId);
          const payload = buildStreamPayload(source, cameraId);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(JSON.stringify(payload));
          return;
        }

        if (url.pathname.startsWith('/media/')) {
          const match = /^\/media\/([^/]+)(?:\/(seg_(\d+)\.ts))?$/.exec(
            url.pathname,
          );
          if (!match) {
            res.writeHead(404);
            res.end();
            return;
          }
          const cameraId = decodeURIComponent(match[1]);
          const source = sourceById.get(cameraId);
          const mediaUrl = source?.url || '';
          const feedType = normalizeFeedType(source?.feedType || 'image');
          const leaseId = url.searchParams.get('lease');
          if (feedType === 'hls' && !/^[a-f0-9-]{36}$/i.test(leaseId || '')) {
            res.writeHead(400);
            res.end();
            return;
          }
          if (req.method === 'DELETE') {
            if (leaseId) puller.release(cameraId, leaseId);
            res.writeHead(204);
            res.end();
            return;
          }
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          if (!match[2]) probeAudio(cameraId, source);
          if (feedType === 'hls') {
            if (
              !/^https?:\/\//i.test(mediaUrl) ||
              !/\.m3u8(?:\?|$)/i.test(mediaUrl)
            ) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error:
                    'This stream requires an unsupported transport; use the frame fallback',
                }),
              );
              return;
            }
            if (match[2]) {
              const body = puller.getSegment(
                cameraId,
                url.searchParams.get('session'),
                Number(match[3]),
                leaseId,
              );
              res.writeHead(body ? 200 : 404, {
                'Content-Type': 'video/mp2t',
                'Cache-Control': 'no-store',
              });
              res.end(body || undefined);
              return;
            }
            const downstream = watchDownstreamClose(res);
            let entry;
            const cancelPending = () => {
              if (entry) puller.release(cameraId, leaseId);
            };
            try {
              entry = await puller.ensure(cameraId, mediaUrl, leaseId);
              if (downstream.closed) {
                cancelPending();
                return;
              }
              downstream.signal.addEventListener('abort', cancelPending, {
                once: true,
              });
              if (!(await puller.waitReady(entry, downstream.signal)))
                throw new Error('Stream unavailable');
              const playlist = await puller.buildPlaylist(
                entry,
                cameraId,
                leaseId,
              );
              if (downstream.closed) return;
              if (!playlist) throw new Error('Stream unavailable');
              setHealth(cameraId, {
                status: 'ok',
                sourceKind: 'live',
                label: source?.provider || 'Configured source',
                message: 'Live HLS connected',
              });
              res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Cache-Control': 'no-store',
                'X-CCTV-Source': 'hls-pull',
                'X-CCTV-Session': entry.token,
              });
              res.end(playlist);
            } catch {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'fallback',
                label: source?.provider || 'Configured source',
                message: 'Live HLS unavailable',
              });
              if (!downstream.closed) {
                res.writeHead(503, {
                  'Content-Type': 'application/json',
                  'Cache-Control': 'no-store',
                  'Retry-After': '2',
                });
                res.end(JSON.stringify({ error: 'Live stream unavailable' }));
              }
            } finally {
              downstream.signal.removeEventListener('abort', cancelPending);
            }
            return;
          }
          if (match[2] || req.method !== 'GET') {
            res.writeHead(404);
            res.end();
            return;
          }

          if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) {
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'fallback',
              label: source?.provider || 'No upstream URL',
              message: 'No stream URL configured',
            });
            res.writeHead(404, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: 'No media URL configured for this camera',
              }),
            );
            return;
          }

          // Bound before the request goes out: most of the wait is before any
          // header arrives, and a viewer who leaves during it must take the
          // upstream request with them.
          const downstream = watchDownstreamClose(res);
          try {
            const upstreamHeaders = {
              'User-Agent': 'gods-eye-view-cctv-proxy/1.0',
            };
            // Never forward the client's own string: a Range this proxy does
            // not accept is dropped and the request proceeds without one.
            const requestRange = sanitizeCctvRangeHeader(req.headers?.range);
            if (requestRange) upstreamHeaders.Range = requestRange;
            const upstream = await fetchCctvMediaUpstream(mediaUrl, {
              headers: upstreamHeaders,
              signal: downstream.signal,
            });
            if (downstream.closed) {
              // The headers arrived for a viewer who is no longer there.
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              return;
            }
            const contentType = upstream.headers.get('content-type') || '';
            if (!upstream.ok) {
              try {
                await upstream.body?.cancel();
              } catch {
                /* already closed */
              }
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: `Upstream HTTP ${upstream.status}`,
              });
              res.writeHead(upstream.status, {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store',
              });
              res.end(
                JSON.stringify({
                  error: `Upstream returned ${upstream.status}`,
                }),
              );
              return;
            }

            if (
              isVideoFeedType(feedType) &&
              !(
                contentType.startsWith('video/') ||
                contentType.includes('mpegurl')
              )
            ) {
              setHealth(cameraId, {
                status: 'degraded',
                sourceKind: 'upstream',
                label: source?.provider || 'Configured source',
                message: `Unexpected media type ${contentType || 'unknown'}`,
              });
            } else {
              setHealth(cameraId, {
                status: 'ok',
                sourceKind: isVideoFeedType(feedType) ? 'live' : 'snapshot',
                label: source?.provider || 'Configured source',
                message: isVideoFeedType(feedType)
                  ? 'Live stream connected'
                  : 'Snapshot feed connected',
              });
            }

            await proxyMediaResponse(res, upstream, {
              sourceHeader: isVideoFeedType(feedType)
                ? 'live-media'
                : 'upstream-image',
            });
            return;
          } catch (error) {
            if (downstream.closed) {
              // The viewer left mid-request. That is not a camera fault and
              // there is nobody to answer.
              return;
            }
            const timedOut =
              error?.name === 'AbortError' || error?.name === 'TimeoutError';
            // GET /api/cctv/health serializes `message`, and the CCTV panel
            // renders it as a status label, so the raw error would leave the
            // server by a different door than the sanitized body below and
            // land on screen.
            //
            // The log line drops the text too, unlike the catch at the bottom
            // of this file: a media-fetch failure names the camera's upstream
            // host, and these lines get pasted into issues. The status codes
            // below carry the diagnosis — 504 for a timeout, 502 otherwise.
            console.warn('[CCTV Proxy] media fetch failed');
            setHealth(cameraId, {
              status: 'degraded',
              sourceKind: 'upstream',
              label: source?.provider || 'Configured source',
              message: 'Media fetch failed',
            });
            res.writeHead(timedOut ? 504 : 502, {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            });
            res.end(
              JSON.stringify({
                error: timedOut
                  ? 'Upstream media timeout'
                  : 'Media proxy failed',
              }),
            );
            return;
          }
        }

        if (!url.pathname.startsWith('/frame/')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'not found' }));
          return;
        }

        const cameraId =
          decodeURIComponent(url.pathname.replace('/frame/', '').trim()) ||
          'camera';
        const source = sourceById.get(cameraId);
        const label = url.searchParams.get('label') || source?.name || cameraId;
        const city = url.searchParams.get('city') || source?.city || '';
        const lat = Number(url.searchParams.get('lat') || source?.lat);
        const lon = Number(url.searchParams.get('lon') || source?.lon);
        const heading = Number(
          url.searchParams.get('heading') || source?.headingDeg,
        );
        const fov = Number(url.searchParams.get('fov') || source?.fovDeg);
        const pitch = Number(url.searchParams.get('pitch') || source?.pitchDeg);

        // Personal fork: a linked webcam that only has an operator page
        // (cctv/linked.js) has no frame to fetch, and must not spend a Street
        // View call on every refresh.
        if (normalizeFeedType(source?.feedType) === 'link') {
          setHealth(cameraId, {
            status: 'ok',
            sourceKind: 'link',
            label: source?.provider || 'Linked webcam',
            message: 'Opens on the operator’s site',
          });
          res.writeHead(200, {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'synthetic',
          });
          res.end(
            buildSyntheticCctvSvg({
              cameraId,
              label,
              city,
              status: 'OPENS ON OPERATOR SITE',
            }),
          );
          return;
        }

        // Only use server-registered upstream URLs — never accept client-supplied URLs
        // (prevents SSRF via ?upstream= query parameter)
        const upstreamCandidate =
          source?.snapshotUrl ||
          (!isVideoFeedType(normalizeFeedType(source?.feedType))
            ? source?.url
            : '');

        const upstreamImage =
          source?.sourceKind === 'txdot-its'
            ? await fetchTxdotSnapshot(upstreamCandidate)
            : await frameCache.get(upstreamCandidate, () =>
                fetchCctvImageFromUpstream(upstreamCandidate),
              );
        if (upstreamImage?.ok) {
          setHealth(cameraId, {
            status: 'ok',
            sourceKind: 'snapshot',
            label: source?.provider || 'Configured source',
            message: 'Upstream snapshot active',
          });
          res.writeHead(200, {
            'Content-Type': upstreamImage.contentType,
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'upstream-image',
          });
          res.end(upstreamImage.body);
          return;
        }

        const sv = await streetViewFallback({
          lat,
          lon,
          heading,
          fov,
          pitch,
        });
        if (sv?.ok) {
          setHealth(cameraId, {
            status: 'degraded',
            sourceKind: 'streetview',
            label: 'Google Street View',
            message: 'Fallback Street View frame',
          });
          res.writeHead(200, {
            'Content-Type': sv.contentType,
            'Cache-Control': 'no-store',
            'X-CCTV-Source': 'streetview',
          });
          res.end(sv.body);
          return;
        }

        const svg = buildSyntheticCctvSvg({
          cameraId,
          label,
          city,
          status: source?.url
            ? 'UPSTREAM UNAVAILABLE'
            : 'NO UPSTREAM CONFIGURED',
        });

        setHealth(cameraId, {
          status: 'degraded',
          sourceKind: 'synthetic',
          label: source?.provider || 'Synthetic fallback',
          message: source?.url
            ? 'Upstream unavailable'
            : 'No source configured',
        });

        res.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'no-store',
          'X-CCTV-Source': 'synthetic',
        });
        res.end(svg);
      } catch (error) {
        console.error('[CCTV Proxy]', error?.message || String(error));
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'CCTV proxy error' }));
      }
    });
  };
  return {
    name: 'cctv-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
