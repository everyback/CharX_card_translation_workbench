#!/usr/bin/env bash
set -euo pipefail
bundle=$1
mapfile -t request < "$bundle/request.txt"
mode=${request[0]:-}
deployment=${request[1]:-}
container=${request[2]:-}
patch=${request[3]:-}
expected_image=${request[4]:-}
selected_target=${request[5]:-}
selected_frontend=${request[6]:-}
selected_server=${request[7]:-}
expected_target_hash=${request[8]:-}
expected_frontend_hash=${request[9]:-}
expected_server_hash=${request[10]:-}
if [[ $mode == probe ]]; then
  { docker ps --format '{{.Names}}' 2>/dev/null || true; } | while IFS= read -r name; do
    [[ $name =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$ ]] && printf 'CONTAINER\t%s\n' "$name"
  done
  for base in /opt /srv /home /var/www /app; do
    [[ -d $base ]] || continue
    find "$base" -maxdepth 7 \( -name node_modules -o -name .git -o -name save -o -name backups \) -prune -o -type f \( -path '*/src/ts/plugins/plugins.svelte.ts' -o -path '*/dist/assets/database*.js' \) -print 2>/dev/null || true
  done | while IFS= read -r file; do
    case "$file" in
      */src/ts/plugins/plugins.svelte.ts) root=${file%/src/ts/plugins/plugins.svelte.ts} ;;
      */dist/assets/database*.js) root=${file%/dist/assets/*} ;;
      *) continue ;;
    esac
    printf 'ROOT\t%s\n' "$root"
  done | sort -u
  exit 0
fi
if [[ $deployment == bare ]]; then
  bash "$bundle/bare-runner.sh" "$bundle"
  exit
fi
[[ $deployment == docker ]] || { echo 'Invalid deployment mode' >&2; exit 2; }
[[ $container =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$ ]] || { echo 'Invalid container name' >&2; exit 2; }
if [[ $mode == history || $mode == remove ]]; then
  revision=$(cat "$bundle/patches/risuai/install.mjs" "$bundle/patches/risuai/scripts/"*.mjs | sha256sum | cut -d ' ' -f1)
  bash "$bundle/docker-history.sh" "$mode" "$container" "$selected_target" "$expected_image" "$revision"
  exit
fi
case "$mode" in discover|preflight|apply) ;; *) echo 'Invalid mode' >&2; exit 2;; esac
case "$patch" in preset-switch|api-profiles|image-router|read-performance|read-cache|list-cache) ;; *) echo 'Invalid patch' >&2; exit 2;; esac
image=$(docker inspect -f '{{.Image}}' "$container")
[[ $image =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid running image' >&2; exit 2; }
state=$(docker inspect -f '{{.State.Running}}' "$container")
[[ $state == true ]] || { echo 'RisuAI container is not running' >&2; exit 2; }
if [[ $mode != discover && $image != "$expected_image" ]]; then echo 'Running image changed; reconnect and preflight again' >&2; exit 3; fi
case "$patch" in
  read-performance|list-cache) roles=(frontend server) ;;
  *) roles=(frontend) ;;
esac
list_candidates() {
  local role=$1
  case "$role" in
    target) docker exec "$container" sh -c 'test -f /app/src/ts/plugins/plugins.svelte.ts && printf "%s\n" /app/src/ts/plugins/plugins.svelte.ts || true' ;;
    server) docker exec "$container" sh -c 'test -f /app/server/node/server.cjs && printf "%s\n" /app/server/node/server.cjs || true' ;;
    frontend)
      if [[ $patch == api-profiles ]]; then
        docker exec "$container" sh -c 'find /app/dist/assets -maxdepth 1 -type f -name "index*.js" -print' | sort
      else
        docker exec "$container" sh -c 'find /app/dist/assets -maxdepth 1 -type f -name "database*.js" -print' | sort
      fi ;;
  esac
}
valid_path() {
  local role=$1 value=$2
  case "$role:$value" in
    target:/app/src/ts/plugins/plugins.svelte.ts|server:/app/server/node/server.cjs) return 0 ;;
    frontend:/app/dist/assets/*)
      local name=${value##*/}
      if [[ $patch == api-profiles ]]; then [[ $name =~ ^index([.-][a-zA-Z0-9_-]+)?\.js$ ]]
      else [[ $name =~ ^database(\.svelte)?([.-][a-zA-Z0-9_-]+)?\.js$ ]]; fi ;;
    *) return 1 ;;
  esac
}
selected_for() {
  case "$1" in target) printf '%s' "$selected_target";; frontend) printf '%s' "$selected_frontend";; server) printf '%s' "$selected_server";; esac
}
expected_hash_for() {
  case "$1" in target) printf '%s' "$expected_target_hash";; frontend) printf '%s' "$expected_frontend_hash";; server) printf '%s' "$expected_server_hash";; esac
}
hash_remote() { docker exec "$container" sha256sum "$1" | cut -d ' ' -f1; }
if [[ $mode == discover ]]; then
  printf 'IMAGE\t%s\n' "$image"
  version=$(docker exec "$container" node -p 'try { String(require("/app/package.json").version || "unknown") } catch { "unknown" }' 2>/dev/null || printf unknown)
  [[ $version =~ ^[a-zA-Z0-9.+_-]{1,80}$ ]] || version=unknown
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container")
  [[ $health =~ ^[a-zA-Z]+$ ]] || health=unknown
  printf 'IDENTITY\t{"kind":"docker","version":"%s","health":"%s"}\n' "$version" "$health"
  for role in "${roles[@]}"; do
    while IFS= read -r file; do
      [[ -n $file ]] || continue
      valid_path "$role" "$file" || { echo 'Unexpected path in container' >&2; exit 3; }
      printf 'TARGET\t%s\t%s\t%s\n' "$role" "$file" "$(hash_remote "$file")"
    done < <(list_candidates "$role")
  done
  exit 0
fi
stage=$(mktemp -d /tmp/cardloom-targets-XXXXXX)
lock=''
trap 'rm -rf "$stage"; if [[ -n $lock ]]; then rmdir "$lock"; fi' EXIT
if [[ $mode == apply ]]; then
  install -d -m 700 /opt/cardloom-patch-backups
  lock="/opt/cardloom-patch-backups/.docker-$container.lock"
  mkdir "$lock" 2>/dev/null || { lock=''; echo 'Another Docker patch operation is active' >&2; exit 3; }
fi
mkdir -p "$stage/targets" "$stage/backups"
args=(--patch "$patch")
for role in "${roles[@]}"; do
  file=$(selected_for "$role")
  expected=$(expected_hash_for "$role")
  valid_path "$role" "$file" || { echo "Invalid $role target" >&2; exit 2; }
  [[ $expected =~ ^[a-f0-9]{64}$ ]] || { echo "Invalid $role checksum" >&2; exit 2; }
  list_candidates "$role" | grep -Fqx -- "$file" || { echo "Target no longer exists: $file" >&2; exit 3; }
  current=$(hash_remote "$file")
  [[ $current == "$expected" ]] || { echo "Target changed: $file" >&2; exit 3; }
  docker cp "$container:$file" "$stage/targets/$role.${file##*.}"
  copied=$(sha256sum "$stage/targets/$role.${file##*.}" | cut -d ' ' -f1)
  [[ $copied == "$expected" ]] || { echo "Copied target changed: $file" >&2; exit 3; }
  args+=("--$role" "/targets/$role.${file##*.}")
done
run_installer() {
  docker run --rm --network none -v "$bundle/patches:/patches:ro" -v "$stage/targets:/targets:rw" -v "$stage/backups:/backups:rw" \
    node:22-alpine node /patches/risuai/install.mjs "${args[@]}" "$@"
}
printf 'IMAGE\t%s\n' "$image"
if [[ $mode == preflight ]]; then
  printf 'RUNTIME\tdocker-container-node\tnode:22-alpine\n'
  run_installer
  exit 0
fi
# Recheck the exact container image and each source before creating a new image.
[[ $(docker inspect -f '{{.Image}}' "$container") == "$image" ]] || { echo 'Image changed during preparation' >&2; exit 3; }
for role in "${roles[@]}"; do
  [[ $(hash_remote "$(selected_for "$role")") == "$(expected_hash_for "$role")" ]] || { echo "Target changed during preparation: $role" >&2; exit 3; }
done
preview=$(run_installer)
printf '%s\n' "$preview"
if ! grep -q ': ready ' <<< "$preview"; then echo 'NO_CHANGES'; exit 0; fi
changes=$(docker diff "$container")
if grep -E '^[ACD] /app/' <<< "$changes" | grep -vE '^[ACD] /app/save(/|$)' | grep -q .; then
  echo 'Unrecorded application edits found in container; image replacement refused' >&2
  exit 3
fi
run_installer --apply --backup-dir /backups
space=$(df -Pk /var/lib/docker | awk 'NR==2 {print $4}')
[[ $space =~ ^[0-9]+$ && $space -ge 1048576 ]] || { echo 'Insufficient free space for a rollback image (need 1 GiB)' >&2; exit 3; }
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$container")
service=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$container")
config=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$container")
working=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$container")
[[ $project =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ && $service =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || { echo 'Unsupported Compose labels' >&2; exit 3; }
[[ $working == /* && -d $working ]] || { echo 'Missing Compose working directory' >&2; exit 3; }
IFS=, read -r -a configs <<< "$config"
[[ ${#configs[@]} -ge 1 && ${#configs[@]} -le 8 ]] || { echo 'Unsupported Compose file list' >&2; exit 3; }
compose_args=()
for config_file in "${configs[@]}"; do
  [[ $config_file == /* && -f $config_file ]] || { echo 'Compose file missing' >&2; exit 3; }
  compose_args+=(-f "$config_file")
done
backup_dir=$(mktemp -d /opt/cardloom-patch-backups/docker-XXXXXXXXXXXX)
stamp=${backup_dir##*/}
printf '%s\n' "$image" > "$backup_dir/original-image"
cp -p "${configs[0]}" "$backup_dir/compose.original.yml"
chmod 600 "$backup_dir/"*
old_tag="cardloom-risu-backup:$stamp"
new_tag="cardloom-risu-patch:$stamp"
docker tag "$image" "$old_tag"
{
  printf 'FROM %s\n' "$old_tag"
  for role in "${roles[@]}"; do
    file=$(selected_for "$role")
    printf 'COPY targets/%s.%s %s\n' "$role" "${file##*.}" "$file"
  done
} > "$stage/Dockerfile"
docker build --pull=false -q -t "$new_tag" -f "$stage/Dockerfile" "$stage" >/dev/null
new_image=$(docker image inspect -f '{{.Id}}' "$new_tag")
[[ $new_image =~ ^sha256:[a-f0-9]{64}$ ]] || exit 3
for value in "$working" "${configs[@]}"; do
  [[ $value != *$'\n'* && $value != *$'\t'* ]] || { echo 'Unsupported Compose path' >&2; exit 3; }
done
revision=$(cat "$bundle/patches/risuai/install.mjs" "$bundle/patches/risuai/scripts/"*.mjs | sha256sum | cut -d ' ' -f1)
printf '%s\n' "$container" "$patch" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$image" "$new_image" "$project" "$service" "$working" "$revision" > "$backup_dir/record.txt"
printf '%s\n' "${configs[@]}" > "$backup_dir/configs.txt"
sha256sum -- "${configs[@]}" > "$backup_dir/config-hashes"
cp -p "$stage/backups/"* "$backup_dir/"
cp "$bundle/docker-history.sh" /opt/cardloom-patch-backups/docker-history.sh
printf 'prepared\n' > "$backup_dir/state"
# Compose override stays private and documents the exact image the running service uses.
override="$backup_dir/patch-override.yml"
printf 'services:\n  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$new_tag" > "$override"
chmod 600 "$override"
cd "$working"
rollback() {
  printf 'services:\n  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$old_tag" > "$backup_dir/rollback.yml"
  if docker compose -p "$project" "${compose_args[@]}" -f "$backup_dir/rollback.yml" up -d --no-deps --force-recreate "$service"; then
    sleep 5
    local restored_image restored_state restored_health
    restored_image=$(docker inspect -f '{{.Config.Image}}' "$container" 2>/dev/null || true)
    restored_state=$(docker inspect -f '{{.State.Running}}' "$container" 2>/dev/null || true)
    restored_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null || true)
    if [[ $restored_image == "$old_tag" && $restored_state == true && ( $restored_health == healthy || $restored_health == running ) ]]; then
      echo "Original image restored and healthy/running: $old_tag" >&2
      return 0
    fi
  fi
  echo "Automatic rollback was not verified; inspect $container and $backup_dir" >&2
  return 1
}
if ! docker compose -p "$project" "${compose_args[@]}" -f "$override" up -d --no-deps --force-recreate "$service"; then
  printf 'failed\n' > "$backup_dir/state"
  rollback || true

  echo 'Deployment failed. See rollback result above.' >&2
  exit 4
fi
new_container=$(docker compose -p "$project" "${compose_args[@]}" -f "$override" ps -q "$service")
sleep 5
for _ in 1 2 3 4 5 6 7 8 9 10; do
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$new_container")
  [[ $health == healthy || $health == running ]] && break
  [[ $health == unhealthy || $health == exited ]] && break
  sleep 3
done
if [[ $health != healthy && $health != running ]]; then
  printf 'failed\n' > "$backup_dir/state"
  rollback || true

  echo 'Health check failed. See rollback result above.' >&2
  exit 4
fi
[[ $(docker inspect -f '{{.Image}}' "$new_container") == "$new_image" ]] || { echo 'Deployed image verification failed' >&2; rollback || true; exit 4; }
for role in "${roles[@]}"; do
  file=$(selected_for "$role")
  patched_hash=$(sha256sum "$stage/targets/$role.${file##*.}" | cut -d ' ' -f1)
  if [[ $(hash_remote "$file") != "$patched_hash" ]]; then
    printf 'failed\n' > "$backup_dir/state"
    echo 'Runtime files do not match the patched image; check bind mounts' >&2
    rollback || true
    exit 4
  fi
done
printf 'deployed\n' > "$backup_dir/state"
printf 'INSTALLED\t%s\t%s\t%s\n' "$new_tag" "$old_tag" "$backup_dir"
