#!/usr/bin/env bash
set -euo pipefail
bundle=$1
mapfile -t request < "$bundle/request.txt"
mode=${request[0]:-}
root=${request[2]:-}
patch=${request[3]:-}
expected_revision=${request[4]:-}
[[ $root == /* && $root != *$'\t'* && $root != *'..'* ]] || { echo 'Invalid project directory' >&2; exit 2; }
root=$(realpath -e -- "$root")
[[ -d $root ]] || { echo 'Project directory missing' >&2; exit 2; }
[[ -f $root/src/ts/plugins/plugins.svelte.ts || -d $root/dist/assets ]] || { echo 'Not a RisuAI source or build directory' >&2; exit 2; }
case "$patch" in
  plugin-v21-import) roles=(target) ;;
  read-performance|list-cache) roles=(frontend server) ;;
  preset-switch|api-profiles|image-router|read-cache) roles=(frontend) ;;
  *) echo 'Unsupported patch' >&2; exit 2 ;;
esac
revision=$(printf '%s' "$root" | sha256sum | cut -d ' ' -f1)
revision="sha256:$revision"
[[ $mode == discover || $mode == history || $mode == remove || $revision == "$expected_revision" ]] || { echo 'Project changed; reconnect' >&2; exit 3; }
candidates() {
  case "$1" in
    target) [[ -f $root/src/ts/plugins/plugins.svelte.ts && ! -L $root/src/ts/plugins/plugins.svelte.ts ]] && printf '%s\n' "$root/src/ts/plugins/plugins.svelte.ts" || true ;;
    server) [[ -f $root/server/node/server.cjs && ! -L $root/server/node/server.cjs ]] && printf '%s\n' "$root/server/node/server.cjs" || true ;;
    frontend)
      if [[ $patch == api-profiles ]]; then pattern='index*.js'; else pattern='database*.js'; fi
      find "$root/dist/assets" -maxdepth 1 -type f -name "$pattern" -print 2>/dev/null | sort || true ;;
  esac
}
if [[ $mode == discover ]]; then
  printf 'IMAGE\t%s\n' "$revision"
  for role in "${roles[@]}"; do
    while IFS= read -r file; do
      [[ -n $file && $file != *$'\t'* ]] && printf 'TARGET\t%s\t%s\t%s\n' "$role" "$file" "$(sha256sum "$file" | cut -d ' ' -f1)"
    done < <(candidates "$role")
  done
  exit 0
fi
[[ $mode == preflight || $mode == apply || $mode == history || $mode == remove ]] || { echo 'Invalid mode' >&2; exit 2; }
if [[ $mode == history && ! -f /opt/cardloom-patch-backups/manifest.json ]]; then
  printf 'STATE\t{"records":[],"deployment":"bare","runtimeVerified":false}\n'
  exit 0
fi
runtime=host
if command -v docker >/dev/null; then
  docker info >/dev/null 2>&1 || { echo 'Docker is installed but unavailable; check daemon and permissions.' >&2; exit 2; }
  runtime=docker
  printf 'RUNTIME\tdocker-runner\tnode:22-alpine\n'
else
node_bin=$(command -v node || true)
[[ -n $node_bin ]] || { echo '裸部署预检失败：宿主机未找到 Node.js。需要 Node.js 18 或更高版本。' >&2; exit 2; }
node_major=$($node_bin -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
[[ $node_major =~ ^[0-9]+$ && $node_major -ge 18 ]] || { echo "裸部署预检失败：宿主机 Node.js 版本不足（当前 ${node_major:-未知}，需要 18+）。请检查 sudo 的 PATH。" >&2; exit 2; }
printf 'RUNTIME\thost-node\t%s\t%s\n' "$node_bin" "$node_major"
fi
run_installer() {
  if [[ $runtime == docker ]]; then
    local access=ro
    local mounts=()
    if [[ ${1:-} == --apply ]]; then
      access=rw
      mounts+=(--mount 'type=bind,src=/opt/cardloom-patch-backups,dst=/opt/cardloom-patch-backups')
    fi
    docker run --rm --network none \
      -v "$bundle/patches:/patches:ro" -v "$root:$root:$access" "${mounts[@]}" \
      node:22-alpine node /patches/risuai/install.mjs "${args[@]}" "$@"
  else
    "$node_bin" "$bundle/patches/risuai/install.mjs" "${args[@]}" "$@"
  fi
}
if [[ $mode == history || $mode == remove ]]; then
  command=status
  access=ro
  extra=()
  if [[ $mode == remove ]]; then
    command=remove
    access=rw
    [[ ${request[5]:-} =~ ^[a-f0-9-]{32,36}$ ]] || { echo 'Invalid record id' >&2; exit 2; }
    extra=(--id "${request[5]}")
  fi
  state_args=("$command" --manifest /opt/cardloom-patch-backups/manifest.json --root "$root" "${extra[@]}")
  if [[ $runtime == docker ]]; then
    docker run --rm --network none -v "$bundle/patches:/patches:ro" -v "$root:$root:$access" \
      -v "/opt/cardloom-patch-backups:/opt/cardloom-patch-backups:$access" \
      node:22-alpine node /patches/risuai/patch-state.mjs "${state_args[@]}"
  else
    "$node_bin" "$bundle/patches/risuai/patch-state.mjs" "${state_args[@]}"
  fi
  exit 0
fi
args=(--patch "$patch")
for role in "${roles[@]}"; do
  case "$role" in target) file=${request[5]:-}; expected=${request[8]:-} ;; frontend) file=${request[6]:-}; expected=${request[9]:-} ;; server) file=${request[7]:-}; expected=${request[10]:-} ;; esac
  [[ $expected =~ ^[a-f0-9]{64}$ ]] || { echo 'Invalid target hash' >&2; exit 2; }
  candidates "$role" | grep -Fqx -- "$file" || { echo "Target is outside selected project: $role" >&2; exit 3; }
  [[ $(realpath -e -- "$file") == "$file" && $file == "$root/"* && ! -L $file ]] || { echo 'Target is outside the project or a symlink' >&2; exit 3; }
  [[ $(sha256sum "$file" | cut -d ' ' -f1) == "$expected" ]] || { echo "Target changed: $role" >&2; exit 3; }
  args+=("--$role" "$file")
done
printf 'IMAGE\t%s\n' "$revision"
if [[ $mode == preflight ]]; then
  run_installer
  exit 0
fi
preview=$(run_installer)
printf '%s\n' "$preview"
if ! grep -q ': ready ' <<< "$preview"; then echo NO_CHANGES; exit 0; fi
backup_dir=$(mktemp -d /opt/cardloom-patch-backups/bare-XXXXXXXX 2>/dev/null) || {
  install -d -m 700 /opt/cardloom-patch-backups
  backup_dir=$(mktemp -d /opt/cardloom-patch-backups/bare-XXXXXXXX)
}
run_installer --apply --backup-dir "$backup_dir" --manifest /opt/cardloom-patch-backups/manifest.json
cp "$bundle/patches/risuai/patch-state.mjs" /opt/cardloom-patch-backups/patch-state.mjs
mkdir -p /opt/cardloom-patch-backups/scripts
cp "$bundle/patches/risuai/scripts/"*.mjs "$bundle/patches/risuai/scripts/dependencies.json" /opt/cardloom-patch-backups/scripts/
printf 'INSTALLED\t%s\t%s\n' "$root" "$backup_dir"
