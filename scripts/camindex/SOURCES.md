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

| Scope | Listings read |
| --- | --- |
| `default` | `non-traffic` plus `maryland` |
| `non-traffic` | nature, beach, ski, airport, satellite, weather |
| `maryland` | Maryland's category listings, plus the whole-region listing for uncategorized cameras |
| `all` | every category, including traffic (about 22,000 cameras) |

**Verification:** a camera counts as live when its still answers 200 with
`image/*` and at least 1 KB. A still that three or more cameras share byte
for byte is a placeholder card, not a view. Dead cameras and placeholders are
left out of the catalog. Unchecked cameras go in with `liveStatus: 'unknown'`.
Maryland is verified first, then scenic cameras, then the rest.

**In the app:**

- `sourceKind` is `opencctv` and `publishSignal` is `directory-embed`.
- `licenseClass` is `embed-only`.
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
