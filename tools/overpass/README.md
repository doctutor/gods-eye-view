# Local Overpass API

A full-planet [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API)
on this PC, for the app's `OVERPASS_UPSTREAMS`: the parts of the app that
still ask Overpass (Street assets' sparse fallbacks, the CCTV layer's
OpenStreetMap-linked webcams, the military installations, the annotation and
footprint lookups) need a server of our own, because overpass-api.de now
answers 406 to non-browser clients and the public mirrors are overloaded
(diagnosed 2026-10-20).

- Image: [`wiktorn/overpass-api:0.7.62`](https://github.com/wiktorn/Overpass-API)
- Data: the full planet with metadata (`--meta`), no history (no attic),
  updated hourly from `planet.openstreetmap.org/replication/hour/`.
- Port: `127.0.0.1:12345` (localhost only).

## Files

| File                                | What it is                                        |
| ----------------------------------- | ------------------------------------------------- |
| `docker-compose.yml`                | The service, its settings and the database volume |
| `.env.example`                      | The paths: copy to `.env` (ignored by git)        |
| `initdb/10-import-pbf.sh`           | The planet import (below)                         |
| `../../scripts/overpass-status.mjs` | `npm run overpass:status`                         |

## How the import works

The image's own `init` mode copies the planet into the database volume with
curl, converts it there to an `.osm.bz2` XML file (the README's
`OVERPASS_PLANET_PREPROCESS` example), and reads that file three times
(`osmium fileinfo -e` for the date, `init_osm3s.sh`, `update_overpass.sh -O`).
For the planet that is 95 GB copied plus an XML file several times larger,
before the database itself.

`initdb/10-import-pbf.sh` replaces that. The image runs it before its own
init (`/docker-entrypoint-initdb.d`), and it does what `init_osm3s.sh` does,
which is only `bunzip2 < planet | update_database --db-dir ... --meta ...`,
with osmium in place of bunzip2:

```sh
osmium cat -f osm -o - /planet/planet-261012.osm.pbf |
  /app/bin/update_database --db-dir=/db/db/ --meta --version=<the planet's date> \
    --compression-method=gz --map-compression-method=gz --flush-size=8
```

There is no intermediate file, and the PBF is read once, read-only. After the
import it runs the image's first update (`update_overpass.sh -O <pbf>`,
which finds the first diff from the planet's date and writes
`/db/replicate_id`) and leaves `/db/init_done`. The entrypoint then skips its
own init and starts serving: the dispatcher, nginx, the hourly diffs and the
areas loop.

An import cannot resume. If one stops (a reboot, Docker restarting), the
script finds `/db/import_started` without `/db/init_done` on the next start
and waits, saying so in the log, instead of importing over a half-written
database. Start again with `docker compose down -v` (it deletes the volume)
and `docker compose up -d`.

## Disk

| Step         | Where                                                    | Space                                                   |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------- |
| Planet PBF   | `E:\gev-data\osm` (the `PLANET_DIR`)                     | 95.4 GB (`planet-261012.osm.pbf`, 95,380,942,829 bytes) |
| Intermediate | none                                                     | 0 (streamed)                                            |
| Database     | Docker's disk image, `D:\DockerDesktop\DockerDesktopWSL` | about 200-300 GB; plan for 300 GB free                  |
| Diffs        | the database volume                                      | small (hourly files, deleted once applied)              |

The OSM wiki gives "about 200 GB - 300 GB" for a compressed planet database
with metadata and history; this one has no history, so it should land at the
low end or under it. That is an estimate: measure it after the import
(`docker system df -v`) and correct this table.

Docker Desktop's disk image grows as the database grows and does not shrink
on its own when data is deleted. The PBF can be deleted after the import,
since the updates come from the replication diffs.

## Memory and time

This PC has a Ryzen 7 1800X (8 cores, 16 threads) and 16 GB of RAM. Docker
Desktop's VM gets half the RAM by default (8 GB). For the import, give it
10 GB and 8 processors in `%UserProfile%\.wslconfig`:

```ini
[wsl2]
memory=10GB
processors=8
```

Then run `wsl --shutdown` and start Docker Desktop again. This is a
recommendation only: nothing here writes that file. `OVERPASS_FLUSH_SIZE=8`
(the image's default is 16) keeps `update_database` lighter. If the import is
killed for memory (`docker inspect gev-overpass` shows `OOMKilled: true`),
lower it to 4 and start again.

Time, estimated from the OSM wiki ("on the order of 24 hours or more" for a
planet import; areas "may take up to 24 hours"):

| Phase                                            | Estimate on this PC                                     |
| ------------------------------------------------ | ------------------------------------------------------- |
| Download (95 GB)                                 | 2-3 h at 100 Mbit/s or more (S3 has no bandwidth limit) |
| Import                                           | 24-48 h                                                 |
| Catch-up diffs (from the planet's date to now)   | a few hours (one hourly diff every few minutes)         |
| Areas (`is_in`), in the background while serving | up to 24 h for the first pass                           |

The server answers queries once the import and the catch-up are done. Until
the first areas pass ends, `is_in` (the app's administrative-area lookups)
answers nothing.

## Commands

All from `tools/overpass`, in Git Bash or PowerShell.

### 1. Download the planet

Download the dated file, not `planet-latest`, so a resumed download cannot
mix two weeks' planets. Find the current date first (the redirect names it):

```bash
curl -sSIL https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf | grep -i '^location:'
```

That gave `planet-261012.osm.pbf` (2026-10-12) on 2026-10-20. Then download
it with resume (`-C -`), and its checksum:

```bash
mkdir -p /e/gev-data/osm && cd /e/gev-data/osm
curl -fL -C - -o planet-261012.osm.pbf https://planet.openstreetmap.org/pbf/planet-261012.osm.pbf
curl -fL -o planet-261012.osm.pbf.md5 https://planet.openstreetmap.org/pbf/planet-261012.osm.pbf.md5
md5sum -c planet-261012.osm.pbf.md5
```

planet.openstreetmap.org redirects to its AWS mirror
(`osm-planet-us-west-2.s3.dualstack.us-west-2.amazonaws.com`). The wiki's
rules: download with a command-line tool (never a browser), check the size
first, prefer HTTPS, and mirrors are "no longer necessary" for bandwidth.
The S3 buckets can also be listed with
`aws s3 ls --no-sign-request s3://osm-planet-us-west-2/planet/pbf/2026/`.
Git Bash's curl (Windows TLS) reaches both hosts. Only overpass-api.de needs
TLS 1.3, which Windows 10's TLS lacks.

### 2. Configure and start

```bash
cp .env.example .env        # set PLANET_DIR and PLANET_FILE
docker compose up -d
docker compose logs -f      # the import's progress, every 10 minutes
```

### 3. Monitor

```bash
npm run overpass:status                                  # container, answering, data and areas age
docker compose logs --tail 20 overpass                   # import progress and updates
docker exec gev-overpass tail -n 5 /db/import.log        # the import's own log
docker exec gev-overpass du -sh /db/db                   # the database's size so far
docker exec gev-overpass tail -n 5 /db/changes.log       # the hourly updates
docker system df -v                                      # the volume's size on D:
```

The progress lines read like
`[import] read 40 of 95 GB of the planet (42%); database 96G`. That is how
much of the PBF osmium has read; the pipe holds it to `update_database`'s
pace, so it tracks the import.

### 4. Verify

```bash
curl http://localhost:12345/api/status
```

Then one node, from Node, with the app's User-Agent (what the app's proxy
sends):

```bash
node -e "fetch('http://localhost:12345/api/interpreter',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':'gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)'},body:'data='+encodeURIComponent('[out:json][timeout:10];node(1);out meta;')}).then(r=>r.json()).then(j=>console.log(j.osm3s,j.elements[0]))"
```

It should print `timestamp_osm_base` within the last hour or two, and node 1
with its version and timestamp (metadata present).

### 5. Point the app at it

In the repository's `.env`:

```
OVERPASS_UPSTREAMS=http://localhost:12345/api/interpreter
```

The proxy (`server/providers/overpass/constants.js`) accepts `http:` URLs.
The military installations and the CCTV webcams read the same variable.

### Stop, start, update, remove

```bash
docker compose stop          # stops serving and updating (the data stays)
docker compose start         # resumes; the hourly diffs catch up
docker compose pull          # a newer image: change the tag in docker-compose.yml first
docker compose down          # removes the container, keeps the volume
docker compose down -v       # removes the database too (a new import)
```

The hourly diffs run on their own while the container runs
(`OVERPASS_UPDATE_SLEEP=3600`). After a long stop they catch up from
`/db/replicate_id`.

## Command log

What was run to set this up, in order (2026-10-20). Requests to
overpass-api.de were a handful, with no retry loops.

| Command                                                                 | Result                                                                                                 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `nslookup overpass-api.de` (and against 1.1.1.1)                        | 65.109.112.52, 162.55.144.139 and two IPv6 on both: DNS fine                                           |
| `curl -4/-6 https://overpass-api.de/api/status`                         | schannel `SEC_E_ILLEGAL_MESSAGE` after TCP connects in 0.16 s                                          |
| `openssl s_client -connect overpass-api.de:443` (and `-tls1_2`)         | TLS 1.3 works; TLS 1.2 gets alert 40: the server is TLS 1.3 only, and Windows 10's schannel has none   |
| Node `fetch` of `/api/status` and `/api/interpreter` (app's User-Agent) | HTTP 406 from nginx: non-browser clients refused                                                       |
| `openssl s_client` per backend, browser User-Agent, `/api/status`       | lambert: 200, "Rate limit: 2, 2 slots available now" (not blocked); gall: 502, "currently at capacity" |
| Node `fetch` to private.coffee, maps.mail.ru, osm.jp                    | timeout after TLS, 504, expired certificate                                                            |
| `Get-ComputerInfo`, `Win32_OptionalFeature`, `wsl --status`             | Hypervisor present; WSL and VirtualMachinePlatform enabled; WSL default version 2                      |
| Docker Desktop installer, `wsl --update` (by the user)                  | Docker Desktop 4.96, engine 29.9.1, WSL2 backend                                                       |
| Docker Desktop disk image location (by the manager)                     | `D:\DockerDesktop\DockerDesktopWSL`                                                                    |
| `curl -sSIL https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf` | `planet-261012.osm.pbf`, 95,380,942,829 bytes, on the AWS mirror                                       |
| `docker compose config --quiet`                                         | the compose file is valid                                                                              |
| `npm run overpass:status`                                               | "not answering (ECONNREFUSED)": nothing started yet                                                    |

Add the download, the import's start and end, the database's size and the
first verification here as they happen.
