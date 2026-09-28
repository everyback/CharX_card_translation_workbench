#!/usr/bin/env bash
set -euo pipefail
mode=$1
container=$2
record_id=${3:-}
expected=${4:-}
available_revision=${5:-}
base=/opt/cardloom-patch-backups
[[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$ ]] || exit 2
image=$(docker inspect -f '{{.Image}}' "$container")
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || exit 2
clean_application_layer() {
  local changes
  changes=$(docker diff "$container") || return 1
  # A whole-image rollback must not discard unrecorded application edits.
  ! grep -E '^[ACD] /app/' <<< "$changes" | grep -vE '^[ACD] /app/save(/|$)' | grep -q .
}
if [[ $mode == history ]]; then
  printf 'IMAGE\t%s\n' "$image"
  for directory in "$base"/docker-*; do
    [[ -d $directory && ! -L $directory && -f $directory/record.txt && -f $directory/state ]] || continue
    mapfile -t record < "$directory/record.txt"
    [[ ${record[0]:-} == "$container" ]] || continue
    state=$(< "$directory/state")
    removable=false
    if [[ $state == deployed && ${record[4]:-} == "$image" ]]; then
      before=$(docker image inspect -f '{{.Id}}' "${record[3]}" 2>/dev/null || true)
      if [[ $before == "${record[3]}" ]] && sha256sum -c --status "$directory/config-hashes" && clean_application_layer; then removable=true; fi
    fi
    printf 'RECORD\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${directory##*/}" "${record[1]}" "${record[2]}" "$state" "${record[8]:-}" "$directory" "$removable" "$available_revision"
  done
  exit 0
fi
[[ $mode == remove && $record_id =~ ^docker-[a-zA-Z0-9_-]+$ && $expected == "$image" ]] || { echo 'Invalid rollback request or image changed' >&2; exit 3; }
directory="$base/$record_id"
[[ -d $directory && ! -L $directory && -f $directory/record.txt ]] || exit 3
mapfile -t record < "$directory/record.txt"
[[ ${record[0]} == "$container" && ${record[4]} == "$image" && $(< "$directory/state") == deployed ]] || { echo 'Only the current recorded image can be rolled back' >&2; exit 3; }
[[ ${record[3]} =~ ^sha256:[a-f0-9]{64}$ && ${record[5]} =~ ^[a-zA-Z0-9_-]+$ && ${record[6]} =~ ^[a-zA-Z0-9_-]+$ && ${record[7]} == /* ]] || exit 3
sha256sum -c --status "$directory/config-hashes" || { echo 'Compose configuration changed; rollback refused' >&2; exit 3; }
clean_application_layer || { echo 'Unrecorded application edits found in container; rollback refused' >&2; exit 3; }
docker image inspect "${record[3]}" >/dev/null
mkdir "$base/.docker-$container.lock" 2>/dev/null || { echo 'Another Docker patch operation is active' >&2; exit 3; }
trap 'rmdir "$base/.docker-$container.lock"' EXIT
compose=(-p "${record[5]}")
while IFS= read -r file; do
  [[ $file == /* && -f $file ]] || exit 3
  compose+=(-f "$file")
done < "$directory/configs.txt"
cd "${record[7]}"
printf 'services:\n  %s:\n    image: %s\n    pull_policy: never\n' "${record[6]}" "${record[3]}" > "$directory/rollback.yml"
check_health() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    local actual health
    actual=$(docker inspect -f '{{.Image}}' "$container" 2>/dev/null || true)
    health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
    [[ $actual == "$1" && ( $health == healthy || $health == running ) ]] && return 0
    sleep 3
  done
  return 1
}
if docker compose "${compose[@]}" -f "$directory/rollback.yml" up -d --no-deps --force-recreate "${record[6]}" && check_health "${record[3]}"; then
  printf 'removed\n' > "$directory/state"
  printf 'STATE\t{"removed":true}\n'
else
  if docker compose "${compose[@]}" -f "$directory/patch-override.yml" up -d --no-deps --force-recreate "${record[6]}" && check_health "${record[4]}"; then
    echo 'Rollback failed; patched image restored and verified' >&2
  else
    printf 'recovery-required\n' > "$directory/state"
    echo 'Rollback and recovery failed; manual recovery required' >&2
  fi
  exit 4
fi
