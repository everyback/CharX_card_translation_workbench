#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readState, writeState, withStateLock, revisionFor } from './scripts/state-store.mjs';

const scriptDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scripts');
const dependencies = JSON.parse(fs.readFileSync(path.join(scriptDir, 'dependencies.json'), 'utf8'));

const plans = {
  'plugin-v21-import': { target: ['patch-plugin-v21-import.mjs'] },
  'preset-switch': { frontend: ['patch-preset-switch.mjs'] },
  'api-profiles': { frontend: ['patch-custom-model-profiles.mjs'] },
  'image-router': { frontend: ['patch-image-router.mjs'] },
  'read-performance': {
    frontend: ['patch-read-batch.mjs'],
    server: ['patch-read-batch-server.mjs'],
  },
  'read-cache': { frontend: ['patch-read-cache.mjs', 'patch-read-cache-evict.mjs'] },
  'list-cache': {
    frontend: ['patch-list-local-cache.mjs'],
    server: ['patch-list-etag-server.mjs'],
  },
};

function usage() {
  return [
    'Usage: node patches/risuai/install.mjs --patch NAME --target FILE | --frontend FILE [--server FILE] [--apply --backup-dir DIR --manifest FILE]',
    'Default is a read-only preflight. --apply requires an existing backup directory.',
    `Patches: ${Object.keys(plans).join(', ')}`,
  ].join('\n');
}

function parseArgs(argv) {
  const args = { patch: '', target: '', frontend: '', server: '', apply: false, backupDir: '', manifest: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return null;
    if (arg === '--apply') { args.apply = true; continue; }
    if (!['--patch', '--target', '--frontend', '--server', '--backup-dir', '--manifest'].includes(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    args[arg.slice(2).replace('backup-dir', 'backupDir')] = value;
  }
  if (!Object.hasOwn(plans, args.patch)) throw new Error(`Unknown patch: ${args.patch || '(none)'}`);
  const required = Object.keys(plans[args.patch]);
  for (const role of required) if (!args[role]) throw new Error(`Missing --${role} for ${args.patch}`);
  for (const role of ['target', 'frontend', 'server']) {
    if (args[role] && !required.includes(role)) throw new Error(`--${role} does not apply to ${args.patch}`);
  }
  if (args.apply && !args.backupDir) throw new Error('--apply requires --backup-dir');
  if (!args.apply && args.backupDir) throw new Error('--backup-dir requires --apply');
  if (!args.apply && args.manifest) throw new Error('--manifest requires --apply');
  if (args.manifest && !path.isAbsolute(args.manifest)) throw new Error('--manifest must be an absolute path');
  return args;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function updateManifest(file, patch, records) {
  const manifest = readState(file);
  manifest.patches.push({ id: randomUUID(), patch, revision: revisionFor(patch, scriptDir), installedAt: new Date().toISOString(), installer: 'cardloom-risuai-patch', targets: records });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeState(file, manifest);
}

function targetFile(value) {
  const resolved = path.resolve(value);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Target must be a regular file: ${resolved}`);
  return { path: resolved, mode: stat.mode, uid: stat.uid, gid: stat.gid, original: fs.readFileSync(resolved) };
}

function runPatch(scriptName, input, output) {
  const result = spawnSync(process.execPath, [path.join(scriptDir, scriptName), input, output], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${scriptName}: ${(result.stderr || result.stdout || 'patch failed').trim().slice(0, 1500)}`);
  if (!fs.existsSync(output)) throw new Error(`${scriptName} did not produce output`);
}

export function installRisuPatch(args) {
  if (args.apply && args.manifest) return withStateLock(args.manifest, () => performInstall(args));
  return performInstall(args);
}
function performInstall(args) {
  const roles = Object.keys(plans[args.patch]);
  const targets = roles.map((role) => ({ role, ...targetFile(args[role]) }));
  const missing = (dependencies[args.patch] || []).filter((dependency) =>
    Object.entries(dependency.checks).some(([role, anchors]) => {
      const source = targets.find((target) => target.role === role)?.original.toString('utf8');
      return !source || !anchors.every((anchor) => source.includes(anchor));
    }));
  if (missing.length) {
    throw new Error(`缺少前置补丁：请先安装 ${missing.map((item) => `「${item.name}」(${item.patch})`).join('、')}，再重新预检当前补丁。目标文件未改动。`);
  }
  if (new Set(targets.map((entry) => entry.path.toLowerCase())).size !== targets.length) {
    throw new Error('Each patch role needs a different target file');
  }
  let backupDir = '';
  if (args.apply) {
    backupDir = fs.realpathSync(path.resolve(args.backupDir));
    if (!fs.statSync(backupDir).isDirectory()) throw new Error('Backup path is not a directory');
    for (const target of targets) {
      if (backupDir === path.dirname(target.path)) throw new Error('Backup directory must differ from the target directory');
    }
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-patch-'));
  const prepared = [];
  try {
    // Prepare every output before changing any target; each underlying script checks its own version anchors.
    for (const target of targets) {
      let input = target.path;
      for (const [index, script] of plans[args.patch][target.role].entries()) {
        const output = path.join(scratch, `${target.role}-${index}${path.extname(target.path)}`);
        runPatch(script, input, output);
        input = output;
      }
      const patched = fs.readFileSync(input);
      if (path.extname(target.path) !== '.ts') {
        const moduleType = target.role === 'server' ? 'commonjs' : 'module';
        const check = spawnSync(process.execPath, ['--check', `--input-type=${moduleType}`], { input: patched, encoding: 'utf8' });
        if (check.status !== 0) throw new Error(`Syntax check failed for ${target.role}: ${check.stderr.trim().slice(0, 700)}`);
      }
      prepared.push({ ...target, patched, before: sha256(target.original), after: sha256(patched) });
    }

    if (!args.apply) return prepared.map(({ role, path: file, before, after }) => ({ role, file, before, after, changed: before !== after }));

    const changed = prepared.filter((item) => item.before !== item.after);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const installed = [];
    try {
      for (const item of changed) {
        if (sha256(fs.readFileSync(item.path)) !== item.before) throw new Error(`Target changed since preflight: ${item.path}`);
        const backup = path.join(backupDir, `${path.basename(item.path)}.${args.patch}.${stamp}.${item.before.slice(0, 12)}.bak`);
        fs.writeFileSync(backup, item.original, { flag: 'wx', mode: 0o600 });
        const staged = `${item.path}.risu-patch-${process.pid}.tmp`;
        try {
          fs.writeFileSync(staged, item.patched, { flag: 'wx', mode: item.mode });
          if (process.platform !== 'win32') fs.chownSync(staged, item.uid, item.gid);
          fs.renameSync(staged, item.path);
        } finally {
          if (fs.existsSync(staged)) fs.unlinkSync(staged);
        }
        installed.push({ item, backup });
        if (sha256(fs.readFileSync(item.path)) !== item.after) throw new Error(`Readback mismatch: ${item.path}`);
      }
    if (args.manifest && changed.length) {
      updateManifest(args.manifest, args.patch, installed.map(({ item, backup }) => ({
        role: item.role, file: item.path, backup, before: item.before, after: item.after,
      })));
    }
    } catch (error) {
      for (const { item, backup } of installed.reverse()) fs.copyFileSync(backup, item.path);
      throw error;
    }
    return prepared.map(({ role, path: file, before, after }) => ({ role, file, before, after, changed: before !== after, applied: before !== after }));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args) console.log(usage());
    else {
      const result = installRisuPatch(args);
      for (const item of result) console.log(`${item.role}: ${item.changed ? args.apply ? 'installed' : 'ready' : 'already present'} ${item.file}\n  ${item.before} -> ${item.after}`);
      if (!args.apply) console.log('Preflight only. Re-run with --apply --backup-dir DIR to install.');
    }
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 1;
  }
}
