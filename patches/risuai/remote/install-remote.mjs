#!/usr/bin/env node
/**
 * RisuAI 远程安装入口。
 *
 * 这个文件只调用随包附带的固定安装器，不执行用户传入的 shell 命令。
 * 默认是只读预检；只有显式传入 --apply 才会写入 RisuAI 文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
// 仓库内位于 patches/risuai/remote；下载包内位于包根目录。
const packageRoot = path.basename(scriptDirectory) === 'remote'
  ? path.resolve(scriptDirectory, '../../..')
  : scriptDirectory;
const patchInstaller = path.join(packageRoot, 'patches', 'risuai', 'install.mjs');
const bridgeInstaller = path.join(packageRoot, 'bridge-plugin', 'install-risu-v2-plugin.cjs');
const bridgePlugin = path.join(packageRoot, 'bridge-plugin', 'risu-bridge.plugin.js');
const ignored = new Set(['node_modules', '.git', 'data', 'save', 'backups', 'storage', 'dist-electron']);
const patchRoles = {
  'plugin-v21-import': ['target'],
  'preset-switch': ['frontend'],
  'api-profiles': ['frontend'],
  'image-router': ['frontend'],
  'read-performance': ['frontend', 'server'],
  'read-cache': ['frontend'],
  'list-cache': ['frontend', 'server'],
};

function usage() {
  return `RisuAI 远程安装包

Windows 双击入口：
  install-windows.cmd
  install-windows.ps1

Linux Bash 交互入口：
  bash install-linux.sh

首次使用（只读预检）：
  node install-remote.mjs --root /path/to/risuai --mode bridge
  node install-remote.mjs --root /path/to/risuai --mode patch --patch preset-switch

确认预检输出后安装：
  node install-remote.mjs --root /path/to/risuai --mode bridge --apply
  node install-remote.mjs --root /path/to/risuai --mode patch --patch preset-switch --apply

选项：
  --root DIR          RisuAI 源码、构建或容器挂载目录（默认 RISUAI_ROOT 或当前目录）
  --auto              自动查找常见 RisuAI 目录；找到多个时请显式传 --root
  --discover          只输出自动发现到的 RisuAI 目录（JSON）
  --mode bridge|patch 安装桥接插件或源码/构建补丁
  --patch NAME       ${Object.keys(patchRoles).join(', ')}
  --save-dir DIR     RISUSAVE 目录；不填时自动查找
  --target FILE      plugin-v21-import 的源码文件
  --frontend FILE    构建补丁的前端文件
  --server FILE      read-performance/list-cache 的 server.cjs
  --backup-dir DIR   补丁备份目录；不填时放在 RisuAI 目录旁边
  --apply            通过预检后才写入文件
  --help             显示帮助`;
}

function parseArgs(argv) {
  const args = { root: process.env.RISUAI_ROOT || process.cwd(), mode: '', patch: '', saveDir: process.env.RISU_SAVE_DIR || '', target: '', frontend: '', server: '', backupDir: '', apply: false, auto: false, discover: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--apply') { args.apply = true; continue; }
    if (arg === '--auto') { args.auto = true; continue; }
    if (arg === '--discover') { args.discover = true; continue; }
    const key = { '--root': 'root', '--mode': 'mode', '--patch': 'patch', '--save-dir': 'saveDir', '--target': 'target', '--frontend': 'frontend', '--server': 'server', '--backup-dir': 'backupDir' }[arg];
    if (!key) throw new Error(`未知选项：${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少值`);
    args[key] = value;
  }
  if (args.discover) return args;
  if (!['bridge', 'patch'].includes(args.mode)) throw new Error('必须指定 --mode bridge 或 --mode patch');
  if (args.mode === 'patch' && !Object.hasOwn(patchRoles, args.patch)) throw new Error(`未知补丁：${args.patch || '(未指定)'}`);
  return args;
}

function exists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function databasePath(saveDir) {
  return path.join(saveDir, Buffer.from('database/database.bin', 'utf8').toString('hex'));
}

function directoryExists(directory) {
  try { return fs.statSync(directory).isDirectory(); } catch { return false; }
}

function hasRisuMarker(root) {
  const directMarkers = [
    path.join(root, 'src', 'ts', 'plugins', 'plugins.svelte.ts'),
    path.join(root, 'dist', 'database.svelte.js'),
  ];
  if (directMarkers.some((marker) => exists(marker))) return true;
  return [root, path.join(root, 'save'), path.join(root, 'server', 'save'), path.join(root, 'data', 'save')]
    .some((saveDir) => exists(databasePath(saveDir)));
}

function defaultSearchRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return [
    process.env.RISUAI_ROOT,
    process.cwd(),
    path.dirname(packageRoot),
    path.join(home, 'RisuAI'),
    path.join(home, 'risuai'),
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Desktop') : '',
    process.env.OneDrive ? path.join(process.env.OneDrive, 'Documents') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'RisuAI') : '',
    process.env.APPDATA ? path.join(process.env.APPDATA, 'RisuAI') : '',
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'RisuAI') : '',
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'RisuAI') : '',
    '/app',
    '/opt/risuai',
  ].filter(Boolean);
}

/**
 * Find likely RisuAI roots without walking arbitrary user data deeply.
 * The caller can pass roots in tests or for a controlled deployment.
 */
export function findRisuRoots(searchRoots = defaultSearchRoots()) {
  const found = new Set();
  const ignoredDirectories = new Set(['node_modules', '.git', 'data', 'save', 'backups', 'storage', 'dist-electron', 'AppData']);
  const queue = [];
  for (const candidate of searchRoots) {
    if (typeof candidate === 'string' && candidate) queue.push({ directory: path.resolve(candidate), depth: 0 });
  }
  let inspected = 0;
  while (queue.length && inspected < 3000) {
    const current = queue.shift();
    if (!directoryExists(current.directory)) continue;
    if (hasRisuMarker(current.directory)) found.add(current.directory);
    if (current.depth >= 3) continue;
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      inspected += 1;
      if (inspected >= 3000) break;
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      queue.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
    }
  }
  return [...found].sort((left, right) => left.localeCompare(right));
}

function autoRoot() {
  const roots = findRisuRoots();
  if (roots.length === 1) return roots[0];
  if (!roots.length) throw new Error('没有自动找到 RisuAI 目录。请用 --root 指定 RisuAI 目录。');
  throw new Error(`自动找到多个 RisuAI 目录，请用 --root 指定其中一个：\n${roots.join('\n')}`);
}

function findSaveDir(root, explicit) {
  const candidates = [explicit, root, path.join(root, 'save'), path.join(root, 'server', 'save'), path.join(root, 'data', 'save'), '/app/save'].filter(Boolean).map((value) => path.resolve(value));
  const found = candidates.find((candidate) => exists(databasePath(candidate)));
  if (!found) throw new Error(`找不到 RISUSAVE 数据库。请用 --save-dir 指定目录（已检查：${candidates.join(', ')}）`);
  return found;
}

function findTargets(root, patch) {
  const roles = patchRoles[patch];
  const result = { target: [], frontend: [], server: [] };
  const queue = [{ directory: path.resolve(root), depth: 0 }];
  let inspected = 0;
  while (queue.length && inspected < 10000) {
    const current = queue.shift();
    let entries;
    try { entries = fs.readdirSync(current.directory, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      inspected += 1;
      const file = path.join(current.directory, entry.name);
      if (entry.isDirectory() && current.depth < 7 && !ignored.has(entry.name)) queue.push({ directory: file, depth: current.depth + 1 });
      if (!entry.isFile()) continue;
      if (roles.includes('target') && entry.name === 'plugins.svelte.ts') result.target.push(file);
      if (roles.includes('server') && entry.name === 'server.cjs') result.server.push(file);
      if (roles.includes('frontend') && (patch === 'api-profiles' ? /^index(?:[.-][\w-]+)?\.js$/.test(entry.name) : /^database(?:\.svelte)?(?:[.-][\w-]+)?\.js$/.test(entry.name))) result.frontend.push(file);
    }
  }
  return result;
}

function oneTarget(value, discovered, role) {
  if (value) return path.resolve(value);
  if (discovered.length === 1) return discovered[0];
  if (!discovered.length) throw new Error(`找不到 ${role} 目标文件，请用 --${role} 指定。`);
  throw new Error(`${role} 找到多个目标文件，请用 --${role} 指定其中一个：\n${discovered.join('\n')}`);
}

function runNode(script, args) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`安装器退出码：${result.status ?? 1}`);
}

function defaultBackup(root) {
  const parent = path.dirname(path.resolve(root));
  return path.join(parent, `${path.basename(path.resolve(root))}-cardloom-backups`);
}

function installBridge(args) {
  const saveDir = findSaveDir(args.root, args.saveDir);
  console.log(`RISUSAVE：${saveDir}`);
  if (!args.apply) {
    console.log('预检通过后，重新运行同一命令并加 --apply 才会写入。');
    return;
  }
  runNode(bridgeInstaller, ['--plugin', bridgePlugin, '--save-dir', saveDir]);
}

function installPatch(args) {
  const discovered = findTargets(args.root, args.patch);
  const command = ['--patch', args.patch];
  for (const role of patchRoles[args.patch]) command.push(`--${role}`, oneTarget(args[role], discovered[role], role));
  if (args.apply) {
    const backupDir = path.resolve(args.backupDir || defaultBackup(args.root));
    fs.mkdirSync(backupDir, { recursive: true });
    command.push('--apply', '--backup-dir', backupDir, '--manifest', path.join(backupDir, 'manifest.json'));
    console.log(`备份目录：${backupDir}`);
  }
  runNode(patchInstaller, command);
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] || '')).href) {
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) console.log(usage());
    else if (args.discover) console.log(JSON.stringify(findRisuRoots(), null, 2));
    else {
      if (args.auto) args.root = autoRoot();
      console.log(`RisuAI 目录：${path.resolve(args.root)}`);
      if (args.mode === 'bridge') installBridge(args);
      else installPatch(args);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error('\n' + usage());
    process.exitCode = 1;
    }
  }
}
