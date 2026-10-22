#!/bin/bash
# Personal fork (tools/overpass, docker-compose.clone.yml): fills the
# database by cloning dev.overpass-api.de's, for wiktorn/overpass-api, run by
# its entrypoint before its own init (/docker-entrypoint-initdb.d). Not in
# use until the compose override is switched on (README.md, "Clone instead
# of import").
#
# The image's clone (download_clone.sh) deletes each file before fetching
# it, so a container that restarts mid-clone downloads all of it again.
# This keeps what is there:
# - A file already at the server's size is skipped.
# - A partial one resumes from its last byte (curl -C -).
# - The clone it started is named in /db/clone-base-url. If the server no
#   longer has it (two were listed on 2026-10-22), the files go and the newest
#   clone starts, since two clones' files must never mix.
# On success it leaves /db/init_done, as the image's clone does, so the
# entrypoint skips its own and starts serving (supervisord: the dispatcher,
# nginx, the diffs from /db/replicate_id and the areas loop).
#
# The entrypoint executes this file, or sources it when it is not
# executable, so it never exits on success; a failure stops the container,
# and its restart policy starts it again, which resumes.
set -eo pipefail

UA='gods-eye-view-personal-fork/0.1 (overpass clone)'

clone_log() {
  echo "$(date -u '+%FT%TZ') [clone] $*" | tee -a /db/clone.log
}

# The files download_clone.sh fetches (wiktorn/overpass-api:0.7.62), each
# with its .idx; FILES_META only with OVERPASS_META=yes.
FILES_BASE="nodes.bin nodes.map node_tags_local.bin node_tags_global.bin node_frequent_tags.bin node_keys.bin \
ways.bin ways.map way_tags_local.bin way_tags_global.bin way_frequent_tags.bin way_keys.bin \
relations.bin relations.map relation_roles.bin relation_tags_local.bin relation_tags_global.bin relation_frequent_tags.bin relation_keys.bin"
FILES_META="nodes_meta.bin ways_meta.bin relations_meta.bin user_data.bin user_indices.bin"

# A URL's Content-Length, or nothing.
remote_size() {
  curl -fsSI -A "$UA" --retry 5 --retry-delay 15 "$1" | tr -d '\r' |
    awk 'tolower($1) == "content-length:" { size = $2 } END { print size }'
}

# Bring file $2 to $3 bytes from URL $1, resuming; 20 attempts.
fetch_to_size() {
  local url="$1" file="$2" size="$3" have
  for _ in $(seq 1 20); do
    have=$(stat -c %s "$file" 2>/dev/null || echo 0)
    if [[ "$have" -eq "$size" ]]; then return 0; fi
    if [[ "$have" -gt "$size" ]]; then rm -f "$file"; fi
    curl -fsS -A "$UA" -L -C - --retry 5 --retry-delay 30 -o "$file" "$url" || sleep 30
  done
  have=$(stat -c %s "$file" 2>/dev/null || echo 0)
  if [[ "$have" -ne "$size" ]]; then
    clone_log "Gave up on $url at $have of $size bytes; the next start resumes it"
    return 1
  fi
}

# Every 10 minutes (CLONE_PROGRESS_SECONDS): how much of the clone is here.
clone_progress() {
  local total="$1" every="${CLONE_PROGRESS_SECONDS:-600}" have
  while sleep "$every"; do
    have=$(du -sb /db/db 2>/dev/null | cut -f1)
    clone_log "downloaded $((have * 100 / total))%; $((have / 1000000000)) of $((total / 1000000000)) GB"
  done
}

clone_db() {
  local source="${OVERPASS_CLONE_SOURCE:-https://dev.overpass-api.de/api_drolbr/}"
  local base=""
  mkdir -p /db/db /db/diffs
  touch /db/changes.log
  echo "# Netscape HTTP Cookie File" >/db/cookie.jar
  echo "${OVERPASS_COOKIE_JAR_CONTENTS}" >>/db/cookie.jar
  chown -R overpass:overpass /db/cookie.jar /db/changes.log /db/diffs

  if [[ "${OVERPASS_META:-no}" == "attic" ]]; then
    clone_log "OVERPASS_META=attic is not supported by this clone (about 400 GB more); use no or yes"
    return 1
  fi
  if [[ -s /db/clone-base-url ]]; then
    base=$(cat /db/clone-base-url)
    if [[ -z "$(remote_size "$base/replicate_id" || true)" ]]; then
      clone_log "The clone $base is no longer on the server: its files go, and the newest clone starts"
      rm -rf /db/db
      mkdir -p /db/db
      base=""
    else
      clone_log "Resuming the clone $base"
    fi
  fi
  if [[ -z "$base" ]]; then
    base=$(curl -fsS -A "$UA" --retry 5 --retry-delay 30 "${source}trigger_clone")
    if [[ "$base" != http* ]]; then
      clone_log "No clone named by ${source}trigger_clone: ${base:0:200}"
      return 1
    fi
    echo "$base" >/db/clone-base-url
  fi

  local files="$FILES_BASE"
  if [[ "${OVERPASS_META:-no}" == "yes" ]]; then files="$files $FILES_META"; fi
  local names=() sizes=() total=0 name part size
  for name in $files; do
    for part in "$name" "$name.idx"; do
      size=$(remote_size "$base/$part" || true)
      if [[ ! "$size" =~ ^[0-9]+$ ]]; then
        clone_log "No size for $base/$part"
        return 1
      fi
      names+=("$part")
      sizes+=("$size")
      total=$((total + size))
      sleep 1
    done
  done
  clone_log "Cloning $base: ${#names[@]} files, $((total / 1000000000)) GB (meta: ${OVERPASS_META:-no})"

  clone_progress "$total" &
  local monitor=$! i
  for i in "${!names[@]}"; do
    if [[ "${sizes[i]}" -eq 0 ]]; then
      : >"/db/db/${names[i]}"
    elif ! fetch_to_size "$base/${names[i]}" "/db/db/${names[i]}" "${sizes[i]}"; then
      kill "$monitor" 2>/dev/null || true
      return 1
    fi
  done
  kill "$monitor" 2>/dev/null || true

  curl -fsS -A "$UA" --retry 5 --retry-delay 30 -o /db/db/replicate_id "$base/replicate_id"
  cp /db/db/replicate_id /db/replicate_id
  cp -r /app/etc/rules /db/db
  chown -R overpass:overpass /db/*
  touch /db/init_done
  clone_log "Done ($(du -sh /db/db | cut -f1)); updates from sequence $(cat /db/replicate_id) of ${OVERPASS_DIFF_URL:-?}. Serving now; the areas (is_in) are built in the background."
}

# Every start, as in initdb/10-import-pbf.sh: the CGI (fcgiwrap, as nginx)
# must reach the dispatcher's socket in /db/db, and the image's /db is 0700.
chmod o+x /db

if [[ ! -f /db/init_done ]]; then
  clone_db
fi
