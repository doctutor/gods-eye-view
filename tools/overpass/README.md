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

| File                                 | What it is                                                               |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `docker-compose.yml`                 | The service, its settings and the database volume                        |
| `.env.example`                       | The paths: copy to `.env` (ignored by git)                               |
| `initdb/10-import-pbf.sh`            | The planet import (below)                                                |
| `docker-compose.clone.yml`           | Not in use: a clone of dev.overpass-api.de instead of the import (below) |
| `initdb-clone/10-clone-resumable.sh` | The clone, resumable after a restart                                     |
| `../../scripts/overpass-status.mjs`  | `npm run overpass:status` and `npm run overpass:recover`                 |
| `../../scripts/overpass-backup.mjs`  | `npm run overpass:backup` and `npm run overpass:restore` (below)         |

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
import the script finds where the updates start, on the configured feed and
without downloading anything:

```sh
pyosmium-get-changes --server "$OVERPASS_DIFF_URL" -D <the planet's date> -f /db/replicate_id
```

Then it leaves `/db/init_done`. The entrypoint skips its own init and starts
serving: the dispatcher, nginx, the hourly diffs and the areas loop. The diffs
from the planet's date to now are applied by that loop, while the server
already answers.

The smoke test (below) found two things the image needs here:

- **The start of the updates.** The image's way of finding it,
  `update_overpass.sh -O <pbf>`, makes pyosmium compare the feed with the one
  the PBF's header names, string for string. It refused Geofabrik's own feed
  for a trailing slash, and the planet's header names the minutely feed while
  this setup uses hourly. `-D <date>` finds the same sequence on any feed.
  Feed URLs here have no trailing slash (pyosmium adds `/state.txt` itself).
- **`/db`'s mode.** The image's `/db` is the overpass user's home, made 0700
  by Debian 12's adduser, and a named volume keeps that mode. Then the CGI
  (fcgiwrap, as nginx) cannot reach the dispatcher's socket, and every query
  answers "open64: 13 Permission denied /db/db//osm3s_osm_base". The script
  runs `chmod o+x /db` on every start.

An import cannot resume. If one stops (a reboot, Docker restarting), the
script finds `/db/import_started` without `/db/init_done` on the next start
and waits, saying so in the log, instead of importing over a half-written
database. Start again with `docker compose down -v` (it deletes the volume)
and `docker compose up -d`.

## Clone instead of import

Not in use: the planet import above runs. This is ready to switch, and
docs/PERSONAL-FORK.md ("Local Overpass: clone or import") has the numbers
behind it. The user decides.

Overpass's install guide calls cloning "the recommended way to populate the
database". The image's clone mode (`OVERPASS_MODE=clone`) downloads the
database files of dev.overpass-api.de's latest clone:

- **Base:** nodes, ways, relations, their tags and maps, 302 GB.
- **Metadata (`OVERPASS_META=yes`):** `*_meta` and the user files, 103 GB
  more.
- **Attic:** history, about 400 GB more.
- **No areas:** they are built here afterwards, as after an import.

The sizes are from the 2026-10-20 clone's listing. Its blocks are lz4 and
its maps uncompressed (the method byte of each `.idx` header: 2 and 0),
where the import writes gz (1), so a clone is larger than the same data
imported here.

`docker-compose.clone.yml` is an override that switches to it:

- clone mode, without metadata (none of the app's queries reads it, and 405
  GB would not fit on D:);
- the minutely diffs, because the clone's `replicate_id` counts the minutely
  feed (7336388 for the 2026-10-20 clone, when the hourly feed was at
  123684);
- `initdb-clone/10-clone-resumable.sh` in place of the import.

The image's own `download_clone.sh` deletes every file before fetching it,
so a container restarted mid-clone downloads all 302 GB again. The
resumable script keeps what is there:

- a file already at the server's size is skipped;
- a partial one resumes from its last byte (`curl -C -`);
- the clone it began is named in `/db/clone-base-url`. If the server no
  longer has it (two were listed on 2026-10-22), the files go and the newest clone
  starts, since two clones' files must never mix.

It logs to `/db/clone.log` every 10 minutes (`[clone] downloaded 12%; 36
of 302 GB`), which `npm run overpass:status` reads. It was tried against a
local stand-in server serving files of the real names: a partial file
resumed, a complete one was skipped, a vanished clone started over, and
every file matched byte for byte.

To switch, with the import's database given up (`down -v` deletes it):

```bash
cd tools/overpass
# In .env (";" separates the files on Windows):
#   COMPOSE_FILE=docker-compose.yml;docker-compose.clone.yml
docker compose down -v
docker compose up -d
npm run overpass:status
```

Without metadata, the verification query below answers node 1 without its
version and timestamp. The app is unaffected.

## After a surprise restart

`npm run overpass:status` says which state the server is in, and
`npm run overpass:recover` prints what to run for it. Neither runs any
compose command.

| State                                                           | What to do                                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Docker is not running                                           | Start Docker Desktop; the container starts with it (`restart: unless-stopped`) |
| Import cut off at N%: the database is incomplete, cannot resume | `docker compose down -v && docker compose up -d` (deletes the database)        |
| Import in progress                                              | Nothing; a restart now means starting again                                    |
| Clone in progress                                               | Nothing; a restart resumes it                                                  |
| Serving                                                         | Nothing; the diffs catch up from `/db/replicate_id`                            |
| Database lost or damaged (a disk or Docker failure)             | `npm run overpass:restore -- latest` prints the plan; add `--yes` to run it    |

After any restart, also look at the status's `Backup:` line:

- a backup older than 14 days is called out, so take a new one once the
  server serves again (`npm run overpass:backup`);
- a `<date>.partial` directory under the backups is a copy the restart cut
  off. It is never a backup; the next backup removes it.

An import that a restart cuts off is not restarted over itself: on the next
start `initdb/10-import-pbf.sh` finds `/db/import_started` without
`/db/init_done`, logs "did not finish; the database is incomplete", and
waits.

## Backup and restore

There is no second SSD, so the recovery plan for the database is a copy on
E:, not a new clone (300 GB, about 10 h).

```bash
npm run overpass:backup                        # to E:/gev-data/overpass-backup/<yyyymmdd>
npm run overpass:status                        # its "Backup:" line: newest, age, replicate_id, size
npm run overpass:restore -- latest             # prints the plan; changes nothing
npm run overpass:restore -- 20261025 --yes     # does it (refused while the live database is healthy)
npm run overpass:backup -- --adopt E:/gev-data/overpass-backup/20261025   # a copy made by hand: writes its manifest
```

`--dir` (or `OVERPASS_BACKUP_DIR`) moves the backups, and `--keep` (2) sets
how many complete ones stay. `--docker-drive` (or `OVERPASS_DOCKER_DRIVE`,
`D:/`) is where the restore checks for room.

**What a backup does** (`scripts/overpass-backup.mjs`):

1. **Waits for a clean point**: no `update_from_dir` or `pyosmium` running,
   no `/db/diffs/changes.osc` waiting, `/db/changes.log`'s last line
   "Update finished with status code: 3", and `replicate_id` no older than
   the last backup's. It takes two such probes 20 s apart with the same
   `replicate_id`.
   - Between catch-up batches no process runs at all, so "nothing running"
     alone is not a clean point.
   - `/proc/<pid>/comm` holds at most 15 characters: `update_from_dir` is
     exactly 15, and `pyosmium-get-changes` appears as `pyosmium-get-ch`.
     They are compared whole; a 14-character string once missed a running
     update.
2. **Pauses the writers** with SIGSTOP: `update_overpass_loop.sh`,
   `update_overpass.sh`, `update_from_dir`, `pyosmium-get-changes`,
   `rules_loop.sh` and its `osm3s_query --progress --rules`.
   - The dispatchers and nginx go on, so queries are answered throughout.
   - If an update slipped in between the check and the pause, it resumes
     them and waits again.
   - SIGCONT always follows: when it finishes, when it fails, and on Ctrl+C
     or SIGTERM. A power cut needs nothing, since the container's processes
     start afresh.
3. **Copies the volume** from a second, read-only container (sockets left
   out) into `<yyyymmdd>.partial`, logging GB copied, rate and ETA every
   30 s.
   - It checks the drive for the volume's size plus 5% first.
   - The tar is streamed over the container's stdout into Windows'
     `tar.exe`, not written through a bind mount.
4. **Checks every file's size** against the volume's list, writes
   `manifest.json`, and renames the directory to `<yyyymmdd>`, or
   `<yyyymmdd>-2` for a second backup that day.
   - `manifest.json` holds `replicate_id`, the data timestamp, the size,
     the duration, and every file with its size.
   - A directory without that manifest, a `.partial` above all, is never a
     backup.
5. **Only then removes** the oldest complete backups beyond `--keep`.

A failed copy leaves its `.partial` and changes nothing else; the next run
removes it. `backup.lock` in the backups directory stops a second backup
running at once.

A copy made by hand before this script (a directory named `<yyyymmdd>` holding
/db's `replicate_id` and `db/`) becomes a backup with `--adopt <dir>`: its
manifest is written from the files on disk and marked `adopted`, since its
sizes were not checked against the volume when it was made.

**The copy's speed** (measured 2026-10-25, on one 1.13 GB database file
while the updater ran at 77% of a core catching up): through a bind mount into a Windows folder, 4.4 MB/s; streamed over stdout into `tar.exe`, 10.5 MB/s; the stream alone, counted and dropped, 11.2 MB/s. So the stream is 2.4 times the bind mount, and reading the volume through Docker is now the limit, not the target drive. A full backup is about 384 GB: some 10 h at 10.5 MB/s, less with the writers paused. The first copy, made by hand through a bind mount to E:, ran at about 13 MB/s.

**A restore** (`npm run overpass:restore -- <name|latest>`):

- **It refuses:**
  - with no complete backup by that name;
  - while the live database answers with data under three days old, since
    replacing a healthy database is the wrong move (`--force` overrides);
  - when the Docker drive's free space, plus what the old volume frees
    inside Docker's disk image, is under the backup's size plus 5%.
- **Without `--yes`** it prints the plan and stops.
- **With `--yes`:**
  1. `docker compose rm -sf` stops and removes the container.
  2. `docker volume rm gev-overpass-db` deletes the volume; the live
     database is gone from here on.
  3. `docker volume create` makes it again, and the backup streams in
     (host `tar.exe` into `docker run -i … tar -x`).
  4. `docker compose up -d` starts the container.
- **Afterwards** it watches `replicate_id` for up to an hour and says when
  it passes the backup's own, which means the updater is catching up from
  there.

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
Desktop's VM gets half the RAM by default (8 GB), and it stays there: the
desktop keeps the other half. `update_database` holds up to its flush size
before writing to disk, so `OVERPASS_FLUSH_SIZE` in `.env` is set to 4 for
the 8 GB VM. The image's default is 16, and lower values are lighter and
slower. If the import is killed for memory (`docker inspect gev-overpass`
shows `OOMKilled: true`), lower it to 2 and start again (`docker compose
down -v`).

With a bigger VM, for example 10 GB and 8 processors in
`%UserProfile%\.wslconfig` (then `wsl --shutdown` and restart Docker
Desktop), 8 is enough:

```ini
[wsl2]
memory=10GB
processors=8
```

Time, estimated from the OSM wiki ("on the order of 24 hours or more" for a
planet import; areas "may take up to 24 hours"):

| Phase                                                         | Estimate on this PC                                     |
| ------------------------------------------------------------- | ------------------------------------------------------- |
| Download (95 GB)                                              | 2-3 h at 100 Mbit/s or more (S3 has no bandwidth limit) |
| Import                                                        | 24-48 h                                                 |
| Catch-up diffs (from the planet's date to now), while serving | a few hours (one hourly diff every few minutes)         |
| Areas (`is_in`), in the background while serving              | up to 24 h for the first pass                           |

The server answers queries once the import is done, with the planet's data
(up to a week old) until the catch-up ends. Until the first areas pass ends,
`is_in` (the app's administrative-area lookups) answers nothing.

Two things in the image look like failures and are not, or are fixed here:

- **`OVERPASS_SPACE` must be at least twice the areas rule's limit.** The
  dispatcher refuses any query that asks for more than half of its space
  with `Dispatcher_Client::request_read_and_idx::protocol_error`, and
  `rules/areas.osm3s` asks for 4 GiB. With the image's default (or 4 GiB)
  the areas loop fails after 36 s every 6 minutes and no area is ever
  built. `docker-compose.yml` sets 8 GiB; it is a cap on what queries may
  claim together, not memory that is reserved (measured 2026-10-23).
- **`Context error: File /db/db//osm3s_osm_base present` right after a
  start.** The updater runs the instant the container starts; when the
  dispatcher is not up yet it decides to write the files directly, then
  finds the dispatcher running. It retries an hour later through the
  dispatcher and succeeds, with the same diff file. Nothing is lost.

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

The progress lines read like `[import] planet read 42%; database 96G`. The
percentage is osmium's own progress bar (`osmium cat --progress`, kept in
`/db/import-progress.txt`): how much of the PBF it has read. The pipe holds
osmium to `update_database`'s pace, so the percentage tracks the import.

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

| Command                                                                                                                             | Result                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nslookup overpass-api.de` (and against 1.1.1.1)                                                                                    | 65.109.112.52, 162.55.144.139 and two IPv6 on both: DNS fine                                                                                                                                                              |
| `curl -4/-6 https://overpass-api.de/api/status`                                                                                     | schannel `SEC_E_ILLEGAL_MESSAGE` after TCP connects in 0.16 s                                                                                                                                                             |
| `openssl s_client -connect overpass-api.de:443` (and `-tls1_2`)                                                                     | TLS 1.3 works; TLS 1.2 gets alert 40: the server is TLS 1.3 only, and Windows 10's schannel has none                                                                                                                      |
| Node `fetch` of `/api/status` and `/api/interpreter` (app's User-Agent)                                                             | HTTP 406 from nginx: non-browser clients refused                                                                                                                                                                          |
| `openssl s_client` per backend, browser User-Agent, `/api/status`                                                                   | lambert: 200, "Rate limit: 2, 2 slots available now" (not blocked); gall: 502, "currently at capacity"                                                                                                                    |
| Node `fetch` to private.coffee, maps.mail.ru, osm.jp                                                                                | timeout after TLS, 504, expired certificate                                                                                                                                                                               |
| `Get-ComputerInfo`, `Win32_OptionalFeature`, `wsl --status`                                                                         | Hypervisor present; WSL and VirtualMachinePlatform enabled; WSL default version 2                                                                                                                                         |
| Docker Desktop installer, `wsl --update` (by the user)                                                                              | Docker Desktop 4.96, engine 29.9.1, WSL2 backend                                                                                                                                                                          |
| Docker Desktop disk image location (by the manager)                                                                                 | `D:\DockerDesktop\DockerDesktopWSL`                                                                                                                                                                                       |
| `curl -sSIL https://planet.openstreetmap.org/pbf/planet-latest.osm.pbf`                                                             | `planet-261012.osm.pbf`, 95,380,942,829 bytes, on the AWS mirror                                                                                                                                                          |
| `docker compose config --quiet`                                                                                                     | the compose file is valid                                                                                                                                                                                                 |
| `npm run overpass:status`                                                                                                           | "not answering (ECONNREFUSED)": nothing started yet                                                                                                                                                                       |
| `docker pull wiktorn/overpass-api:0.7.62`                                                                                           | 481 MB                                                                                                                                                                                                                    |
| Smoke test: `monaco-latest.osm.pbf` from Geofabrik (693 KB, md5 OK), a Monaco diff feed in an override file, `docker compose up -d` | Imported in 4 s (78 MB database). First run: no `/db/replicate_id` (`-O` refused the feed), and every query answered "Permission denied" on the dispatcher's socket (`/db` 0700). Both fixed in `initdb/10-import-pbf.sh` |
| Smoke test again, `docker restart`                                                                                                  | Updates from sequence 4941, diff 4942 applied; `/api/status` "Rate limit: 8, 8 slots available now"; the Node query with the app's User-Agent 200 in 168 ms with metadata; `npm run overpass:status` "answering"; healthy |
| `docker compose down -v`                                                                                                            | The smoke container and volume removed                                                                                                                                                                                    |

Add the download, the import's start and end, the database's size and the
first verification here as they happen.
