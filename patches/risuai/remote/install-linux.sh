#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALLER="$SCRIPT_DIR/install-remote.mjs"
ROOT="${RISUAI_ROOT:-}"
MODE=""
PATCH=""
APPLY=0
PATCHES=(plugin-v21-import preset-switch api-profiles image-router read-performance read-cache list-cache)

usage() {
  cat <<'HELP'
用法：bash install-linux.sh [--root RisuAI目录] [--mode bridge|patch|both] [--patch 补丁名] [--apply]

不传参数时自动搜索 RisuAI 并交互选择。始终先预检；预检通过后输入 INSTALL 才会写入。
--apply 适合自动化：预检通过后直接应用。
HELP
}

fail() {
  printf '安装停止：%s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --root|--mode|--patch)
      (($# >= 2)) || fail "$1 缺少值"
      case "$1" in
        --root) ROOT="$2" ;;
        --mode) MODE="$2" ;;
        --patch) PATCH="$2" ;;
      esac
      shift 2
      ;;
    --apply) APPLY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail "未知选项：$1" ;;
  esac
done

[[ -f "$INSTALLER" ]] || fail "安装包不完整：找不到 install-remote.mjs"
command -v node >/dev/null 2>&1 || fail "找不到 Node.js。请先在 RisuAI 所在环境安装 Node.js 18 或更高版本。"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' || fail "需要 Node.js 18 或更高版本。"

if [[ -z "$ROOT" ]]; then
  discovered="$(node "$INSTALLER" --discover)" || fail "自动搜索 RisuAI 失败"
  roots=()
  while IFS= read -r -d '' candidate; do roots+=("$candidate"); done < <(
    printf '%s' "$discovered" | node -e '
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => {
        const paths = JSON.parse(input);
        if (!Array.isArray(paths)) process.exit(1);
        for (const path of paths) process.stdout.write(path + "\0");
      });'
  )
  ((${#roots[@]})) || fail "没有找到 RisuAI。用 --root 指定源码、构建或容器目录。"
  if ((${#roots[@]} == 1)); then
    ROOT="${roots[0]}"
  else
    printf '找到多个 RisuAI 目录：\n'
    for i in "${!roots[@]}"; do printf '  %d. %s\n' "$((i + 1))" "${roots[i]}"; done
    read -r -p "选择目录编号 [1-${#roots[@]}]：" choice || fail "没有选择目录"
    [[ "$choice" =~ ^[0-9]+$ ]] && ((choice >= 1 && choice <= ${#roots[@]})) || fail "目录编号无效"
    ROOT="${roots[choice - 1]}"
  fi
fi
[[ -d "$ROOT" ]] || fail "RisuAI 目录不存在：$ROOT"
printf 'RisuAI 目录：%s\n' "$ROOT"

if [[ -z "$MODE" ]]; then
  printf '\n安装内容：\n  1. 桥接插件\n  2. 选择一个补丁\n  3. 补丁和桥接插件\n'
  read -r -p '选择 [1/2/3]：' choice || fail "没有选择安装内容"
  case "$choice" in
    1) MODE=bridge ;;
    2) MODE=patch ;;
    3) MODE=both ;;
    *) fail "安装内容编号无效" ;;
  esac
fi
[[ "$MODE" == bridge || "$MODE" == patch || "$MODE" == both ]] || fail "--mode 只能是 bridge、patch 或 both"

if [[ "$MODE" == patch || "$MODE" == both ]]; then
  if [[ -z "$PATCH" ]]; then
    printf '\n可选补丁：\n'
    for i in "${!PATCHES[@]}"; do printf '  %d. %s\n' "$((i + 1))" "${PATCHES[i]}"; done
    read -r -p "选择编号 [1-${#PATCHES[@]}]：" choice || fail "没有选择补丁"
    [[ "$choice" =~ ^[0-9]+$ ]] && ((choice >= 1 && choice <= ${#PATCHES[@]})) || fail "补丁编号无效"
    PATCH="${PATCHES[choice - 1]}"
  fi
fi

run_installer() {
  local args=(--root "$ROOT" --mode "$1")
  if [[ "$1" == patch ]]; then args+=(--patch "$PATCH"); fi
  if [[ "$2" == preview ]]; then
    printf '\n预检 %s...\n' "$1"
    node "$INSTALLER" "${args[@]}"
  else
    node "$INSTALLER" "${args[@]}" --apply
  fi
}

if [[ "$MODE" == patch || "$MODE" == both ]]; then run_installer patch preview; fi
if [[ "$MODE" == bridge || "$MODE" == both ]]; then run_installer bridge preview; fi
if (( ! APPLY )); then
  read -r -p '全部预检通过。输入 INSTALL 安装；其他内容退出：' answer || { printf '已取消，未修改 RisuAI。\n'; exit 0; }
  if [[ "$answer" != INSTALL ]]; then printf '已取消，未修改 RisuAI。\n'; exit 0; fi
fi
if [[ "$MODE" == patch || "$MODE" == both ]]; then run_installer patch apply; fi
if [[ "$MODE" == bridge || "$MODE" == both ]]; then run_installer bridge apply; fi
printf '\n安装完成。请按目标部署方式重新构建或重启 RisuAI，并在浏览器核验。\n'
