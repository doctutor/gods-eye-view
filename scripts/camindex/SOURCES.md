# camindex sources

camindex (`node scripts/camindex/index.mjs`) reads public camera directories
and writes `.gev-cache/camindex/catalog.json`. The app's `camindex` pack
(`server/providers/cctv/camindex.js`) reads that file. Each source below is
read under its own rules. A new source starts with a section here, written
before its adapter.

These rules apply to every source:

- robots.txt is read first, and a path it disallows is never requested. If
  robots.txt can't be read because of a server error, nothing on that host is
  read in that run.
- Each host gets one request at a time, at least 1.5 s apart. A 429 or 503
  answer pauses the host for its `Retry-After` time (30 s when none is given)
  and widens the gap for the rest of the run. After five failures in a row,
  the run leaves the host alone.
- Requests identify themselves:
  `gods-eye-view-personal-fork/0.1 camindex (+https://github.com/doctutor/gods-eye-view)`.
- Every page read is kept on disk under `.gev-cache/camindex/http/`
  (gitignored) and is not requested again for a week. A rerun replays from
  disk, so an interrupted run resumes cheaply.
- Downloaded pages are untrusted data. Only their schema.org JSON-LD and a few
  fixed patterns are parsed, and nothing in them is executed. Every URL taken
  from a page is checked against the source's host and path shape.
- Size and time are bounded: 4 MB per page, 3 MB per still, 30 s per request.
  Redirects are followed only within the same host, at most 3 hops.

## OpenCCTV (opencctv.org)

A public directory of about 45,000 camera pages, browsable without an account.

**Terms.** The site's terms forbid scraping, bulk downloading, overloading the
service and bypassing rate limits. camindex reads only what robots.txt allows,
at the pace above, and keeps every page it reads on disk instead of reading it
again. It never calls the site's API and never relays the site's video.

**robots.txt** (checked 2026-10-16):

- Allowed: `/cameras/`, `/livetraffic/`, `/satellites`, `/open-cameras`,
  `/about`. Everything else is allowed by default too, including `/still/`
  and the sitemaps.
- Disallowed: `/api/` and `/admin`.

**What is read:**

- Listing pages (the default way in): `/cameras/category/<category>?page=N`
  and `/cameras/united-states/maryland[/category/<category>]?page=N`. Each
  page lists 16 cameras in an ItemList, with each camera's name, page URL,
  coordinates and place, so one request covers 16 cameras.
- Camera pages, only when a listing card has no coordinates, or with
  `--page-details`. Each page's ImageObject gives name, caption (which states
  the category), coordinates, address and the still URL.
- Sitemaps (`--via sitemap`): `/sitemap.xml` and
  `/sitemap-cameras-{1,2,3}.xml`, then each camera page.
- Stills, during `verify`: `/still/<id>.jpg`, which is each page's og:image.
  Each still is fetched once a week at most. Only its status, type, size and
  SHA-1 are kept, not the image.

**What is not read:** anything under `/api/`. That includes `/api/feed/…`,
the image URLs that listing cards carry. camindex never fetches the
operator's own stream either: pages don't publish it, and camindex doesn't
look for it.

**Common Crawl instead** (`--via commoncrawl [--cc-index CC-MAIN-…]`): this
reads camera pages from Common Crawl's copy rather than from opencctv.org.
It queries the CDX index at index.commoncrawl.org one index page at a time,
then reads each WARC record from data.commoncrawl.org with a Range request.
Every answer is cached, so the run is resumable. The index answered 502 and
504 on 2026-10-16, so this path hasn't been run against the live service.

**Scopes:**

| Scope         | Listings read                                                                         |
| ------------- | ------------------------------------------------------------------------------------- |
| `default`     | `non-traffic` plus `maryland`                                                         |
| `non-traffic` | nature, beach, ski, airport, satellite, weather                                       |
| `maryland`    | Maryland's category listings, plus the whole-region listing for uncategorized cameras |
| `all`         | every category, including traffic (about 22,000 cameras)                              |

**Verification:** a camera counts as live when its still answers 200 with
`image/*` and at least 1 KB. A still that three or more cameras share byte
for byte is a placeholder card, not a view. Dead cameras and placeholders are
left out of the catalog. Unchecked cameras go in with `liveStatus: 'unknown'`.
Maryland is verified first, then scenic cameras, then the rest.

Uncached stills come from the site's origin, and the origin rate-limits them.
On 2026-10-16 it answered 503 (Retry-After 600 s) after about 50 stills in
3 minutes, twice. So `verify` paces stills on opencctv.org at one per 16 s,
which keeps a run under 40 per 10 minutes. `--gap-ms` can only slow that
down. A 429 or 503 marks the camera `error`, not dead, and the next run
retries it. Bulk verification is not the plan for this source; the first run
stopped after 53 stills. The intended way is lazy: a still the app fetches
because someone opened that camera counts as its check (see the follow-up
below).

**Follow-up (not built): lazy verification.** The frame route already
fetches a camera's still when someone views it and records the result in
its health map. A small store, for example
`.gev-cache/camindex/observed.json` (`{id: {status, at}}`, written by the
CCTV provider with a debounce), would keep those results: live on an image
of at least 1 KB, dead on a 404 or non-image answer, placeholder by hash. The
camindex pack would apply them when it loads (dead ones dropped, live marked
`live`), and `build` would fold them into `verify.json`. The index would then
correct itself from real use without extra requests. A nightly re-verify, if
one is added, uses the pacing above.

**In the app:**

- `sourceKind` is `opencctv` and `publishSignal` is `directory-still`.
- `licenseClass` is `display-only`: the app shows the directory's published
  still and links the camera page; it frames nothing.
- `coordinatesQuality` is `site`.
- `category` is the directory's category in the app's words: nature, beach,
  ski, airport, satellite, meteo (the directory's "weather") or traffic. A
  camera in several categories takes the first one in that order.
- The camera shows the directory's published still: `feedType` is `image` and
  `snapshotUrl` is `/still/<id>.jpg`. The still goes through the app's frame
  route like any image camera.
- The frame route keeps each upstream frame for its Cache-Control lifetime,
  s-maxage before max-age (`server/providers/cctv/frameCache.js`). An open
  panel therefore asks opencctv.org for a still at most once every 600 s, not
  every 10 s.
- The camera page is the operator link ("OPEN ON OPENCCTV.ORG").

**What is not used:** the Embed button's iframe, which is the camera page
itself. On 2026-10-16 every opencctv.org page, `/embed/<id>` included, was
served with `X-Frame-Options: SAMEORIGIN`, so a browser refuses to show it
inside another site. camindex neither records nor frames it.

## Open-Eagle-Eye (github.com/stuchapin909/Open-Eagle-Eye)

An MIT-licensed registry of about 31,500 public still cameras (mostly road
agencies' snapshots), kept as one JSON file and checked nightly by the
project's own GitHub Action.

**Terms.** MIT. camindex reads the published data file only, and never runs
the project's code.

**robots.txt** (checked 2026-10-16): raw.githubusercontent.com answers 404
for robots.txt, which counts as no restrictions.

**What is read:** one file,
`https://raw.githubusercontent.com/stuchapin909/Open-Eagle-Eye/master/cameras.json`
(about 14 MB; the adapter allows up to 32 MB for this one request). It is read
at most once a week and replayed from disk in between. The file is on the
`master` branch; the same path under `main` answers 404.

**What is kept:** rows with coordinates, an https image URL and no
credentials. A row is dropped when `auth` is `true` or an object naming a
requirement (`{"required": …}`); `auth: {}` means none. Rows whose exact URL
was already seen are kept once. Rows are not deduplicated against other
sources here; `catalog.js` does that across sources.

**In the app:**

- `sourceKind` is `openeagleeye`, `publishSignal` is `operator-page`, and
  `licenseClass` is `display-only`.
- `credit` is "via Open-Eagle-Eye (MIT)". `provider` is the operator's
  hostname (for example `fl511.com`), and `operatorUrl` is the image URL's
  origin, not the image itself.
- The camera shows the operator's own still: `feedType` is `image`, and
  `snapshotUrl` is the registry's URL. Some URLs have no file extension
  (`511on.ca/map/Cctv/1`); they are image endpoints too.
- `category` is mapped as highway → traffic, city → city, beach → beach,
  airport → airport, volcano → volcano and wildlife → nature. Other
  categories (port, ferry, aurora, dam, stadium, construction) are kept as
  given.
- `coordinatesQuality` is `site`. `timeZone` is the row's IANA zone, when Intl
  knows it, so the panel's local-time line shows civil time.

**Verification:** `verify --source openeagleeye` checks stills like any other
source, at each host's pace. Their own `verified` flag is kept as
`upstreamVerified` and does not make a camera `live`.

## PocketWorld (pocketworld.org)

A directory of public webcams, part of a site offering free, keyless JSON
APIs with open CORS. Its terms require attribution, permit personal and
development use, and forbid bypassing rate limits or mirroring the service.

**robots.txt** (checked 2026-10-16): `Allow: /` for every agent, with
`Crawl-delay: 1`. camindex reads it at one request per 2 s, slower than that.

**API first.** Its llms.txt lists a webcams endpoint,
`/api/webcams/<country>`, which `/api` does not document. Each run asks
`/api/webcams/US` once. On 2026-10-16 it answered `502` (Cloudflare origin
error) for US and IS alike, so the run reads the listing pages instead. The
API's JSON is not parsed until it answers and its shape is known.

**What is read** (server-rendered pages; each card states name, coordinates,
format and the operator's source link):

- `/webcams/type/<tag>`: 36 cards per page, no pagination. The scope
  `non-traffic` (the default) reads nature, beach, urban, airport, port,
  railway, religion and sound. `all` adds sports, business and traffic.
- `/webcams/video`: 36 cards.
- City and country pages (`/webcams/city/<cc>/<city>`,
  `/webcams/country/<cc>`) from `/sitemap-media.xml`, in its order, until the
  limit. Localized copies (`/<lang>/webcams/…`) are skipped.

The first run stops at 2,000 cameras (`--limit` changes that), so the yield is
seen before scaling. `--scope maryland` reads only the Maryland city pages
the sitemap lists (Annapolis, Ocean City and Washington DC on 2026-10-16) and
keeps every card inside camindex's Maryland box, traffic included. Cards without coordinates are skipped. On city and
country pages, a card whose operator host looks like a road agency (dot, 511,
traffic, transport, roads, highway and similar) counts as traffic and is left
out in the `non-traffic` scope.

**Classification** follows linked.js's operator-link rules, with the card's
stated format as a tiebreak:

| Card                              | `feedType`                                     | `licenseClass` |
| --------------------------------- | ---------------------------------------------- | -------------- |
| YouTube video                     | `youtube` with `embed` (thumbnail as snapshot) | `embed-only`   |
| HLS video with an https `.m3u8`   | `hls`                                          | `display-only` |
| Updating image (https)            | `image`, the source as `snapshotUrl`           | `display-only` |
| Motion JPEG (https)               | `mjpeg`                                        | `display-only` |
| Operator player, or anything else | `link` with `operatorUrl`                      | `display-only` |

**In the app:** `sourceKind` is `pocketworld`, `publishSignal` is
`directory-link`, `credit` is "via PocketWorld (pocketworld.org)", `provider`
is the source's hostname, and `coordinatesQuality` is `site`, or `area` when
three or more cards sit on the same exact point (a town's pin: on 2026-10-16
several Ocean City cameras shared 38.330, -75.090). `category` comes
from the type page a card was seen on (port is shown as harbor, urban as
city, religion as religious), and is otherwise `webcam`.

**Not served yet:** the app's camindex pack
(`server/providers/cctv/camindex.js`) serves only `image` cameras and does not
pass `timeZone` through. The `youtube`, `hls`, `mjpeg` and `link` cameras and
the time zones are in catalog.json for the pack to take up.
