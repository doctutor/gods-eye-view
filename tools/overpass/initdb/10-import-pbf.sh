#!/bin/bash
# Personal fork (tools/overpass): the planet import for wiktorn/overpass-api,
# run by its entrypoint before its own init (/docker-entrypoint-initdb.d).
#
# The image's init copies the planet into /db with curl and converts it to
# an .osm.bz2 file there (OVERPASS_PLANET_PREPROCESS), which it then reads
# three times. This streams the PBF as OSM XML straight into update_database
# instead: the command init_osm3s.sh runs (`bunzip2 < planet | update_database
# --db-dir ... --meta ...`), with osmium in place of bunzip2. No intermediate
# file; the only disk it needs is the database's. On success it leaves
# /db/init_done, so the entrypoint skips its own init and starts serving
# (supervisord: the dispatcher, nginx, the hourly diffs and the areas).
#
# The entrypoint executes this file, or sources it when it is not
# executable, so it never exits on success.
set -eo pipefail

import_log() {
  echo "$(date -u '+%FT%TZ') [import] $*" | tee -a /db/import.log
}

# Every 10 minutes: how much of the PBF osmium has read (the pipe holds it
# to update_database's pace, so this is the import's progress).
import_progress() {
  local pbf="$1"
  local total
  total=$(stat -c %s "$pbf")
  while sleep 600; do
    local pid=""
    for p in /proc/[0-9]*; do
      if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q '^osmium cat'; then
        pid="${p#/proc/}"
        break
      fi
    done
    [[ -n "$pid" ]] || return 0
    local read
    read=$(awk '/^rchar:/ { print $2 }' "/proc/$pid/io" 2>/dev/null || echo 0)
    import_log "read $((read / 1000000000)) of $((total / 1000000000)) GB of the planet ($((read * 100 / total))%); database $(du -sh /db/db 2>/dev/null | cut -f1)"
  done
}

import_pbf() {
  local pbf="${PLANET_PBF:-/planet/planet-latest.osm.pbf}"
  local meta=""
  case "${OVERPASS_META:-no}" in
    attic) meta="--keep-attic" ;;
    yes) meta="--meta" ;;
  esac
  local compression="${OVERPASS_COMPRESSION:-gz}"
  local flush="${OVERPASS_FLUSH_SIZE:-16}"

  if [[ -f /db/import_started ]]; then
    # update_database cannot resume: a stopped import leaves a database
    # that is neither empty nor whole. Wait here instead of restarting it.
    import_log "An import started at $(cat /db/import_started) did not finish; the database is incomplete."
    import_log "Remove it and start again: docker compose down -v && docker compose up -d"
    exec sleep infinity
  fi
  if [[ ! -s "$pbf" ]]; then
    import_log "No planet at $pbf: set PLANET_DIR and PLANET_FILE in tools/overpass/.env"
    exit 1
  fi

  # The data's date, for the database and the first diff: the planet's
  # header has it; otherwise the newest object in the file (a full read).
  local version
  version=$(osmium fileinfo -g header.option.osmosis_replication_timestamp "$pbf" 2>/dev/null || true)
  if [[ -z "${version// /}" ]]; then
    import_log "No replication timestamp in the header; reading the file for its newest object"
    version=$(osmium fileinfo -e -g data.timestamp.last "$pbf")
  fi

  date -u '+%FT%TZ' >/db/import_started
  import_log "Importing $pbf ($(du -h "$pbf" | cut -f1), data of $version) ${meta:-without metadata}"
  touch /db/changes.log
  mkdir -p /db/diffs /db/db
  echo "# Netscape HTTP Cookie File" >/db/cookie.jar
  echo "${OVERPASS_COOKIE_JAR_CONTENTS}" >>/db/cookie.jar
  chown -R overpass:overpass /db/cookie.jar /db/changes.log /db/diffs

  import_progress "$pbf" &
  local monitor=$!
  # shellcheck disable=SC2086 # $meta is one flag or none
  osmium cat --no-progress -f osm -o - "$pbf" |
    /app/bin/update_database --db-dir=/db/db/ $meta "--version=$version" \
      "--compression-method=$compression" "--map-compression-method=$compression" \
      "--flush-size=$flush"
  kill "$monitor" 2>/dev/null || true

  import_log "Database written ($(du -sh /db/db | cut -f1)); applying the diffs since $version"
  cp -r /app/etc/rules /db/db
  chown -R overpass:overpass /db/*
  # As the image does after its init: the first diffs, their start found
  # from the planet's date (pyosmium-get-changes -O), then /db/replicate_id.
  /app/bin/update_overpass.sh -O "$pbf"
  if [[ ! -s /db/replicate_id ]]; then
    import_log "No /db/replicate_id after the first update: the hourly updates cannot start."
    import_log "Write the planet's replication sequence number into /db/replicate_id (see README.md)."
  fi
  touch /db/init_done
  rm -f /db/import_started
  chown -R overpass:overpass /db/*
  import_log "Done. Serving now; areas (is_in) are built in the background."
}

if [[ ! -f /db/init_done ]]; then
  import_pbf
fi
