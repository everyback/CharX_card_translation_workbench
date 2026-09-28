import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const script = path.resolve('patches/risuai/remote/install-linux.sh');
const bash = process.platform === 'win32' ? (() => {
  const git = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (git.status !== 0) return null;
  const candidate = path.resolve(git.stdout.trim(), '../../..', 'bin/bash.exe');
  return fs.existsSync(candidate) ? candidate : null;
})() : 'bash';

const source = [
  'function LQ(){let e=Q.db,t=e.botPresets;if(e.botPresetsId===-1)return;return t[e.botPresetsId]}',
  'function zQ(e=0,t=!0){t&&LQ();let n=Q.db,r=n.botPresets[e];return r}',
].join('\n');

test('Linux Bash installer previews before confirmation and backs up on apply', { skip: !bash }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-linux-install-'));
  try {
    const root = path.join(directory, 'RisuAI');
    fs.mkdirSync(root);
    const target = path.join(root, 'database.js');
    fs.writeFileSync(target, source);
    const args = [script.replaceAll('\\', '/'), '--root', root.replaceAll('\\', '/'), '--mode', 'patch', '--patch', 'preset-switch'];

    const cancelled = spawnSync(bash!, args, { input: 'NO\n', encoding: 'utf8' });
    assert.equal(cancelled.status, 0, cancelled.stderr);
    assert.match(cancelled.stdout, /预检 patch/);
    assert.match(cancelled.stdout, /已取消/);
    assert.equal(fs.readFileSync(target, 'utf8'), source);

    const installed = spawnSync(bash!, args, { input: 'INSTALL\n', encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(fs.readFileSync(target, 'utf8'), /__codexPresetExists/);
    const backups = fs.readdirSync(path.join(directory, 'RisuAI-cardloom-backups'));
    assert.equal(backups.filter((name) => name.endsWith('.bak')).length, 1);
    const manifest = path.join(directory, 'RisuAI-cardloom-backups', 'manifest.json');
    const state = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    assert.equal(state.patches.length, 1);
    assert.equal(state.patches[0].patch, 'preset-switch');
    const removed = spawnSync(process.execPath, [path.resolve('patches/risuai/patch-state.mjs'), 'remove', '--manifest', manifest, '--root', root, '--id', state.patches[0].id], { encoding: 'utf8' });
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Linux Bash installer checks both targets before applying either', { skip: !bash }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-linux-both-'));
  try {
    const root = path.join(directory, 'RisuAI');
    fs.mkdirSync(root);
    const target = path.join(root, 'database.js');
    fs.writeFileSync(target, source);
    const args = [script.replaceAll('\\', '/'), '--root', root.replaceAll('\\', '/'), '--mode', 'both', '--patch', 'preset-switch', '--apply'];
    const result = spawnSync(bash!, args, { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /找不到 RISUSAVE/);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
    assert.equal(fs.existsSync(path.join(directory, 'RisuAI-cardloom-backups')), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
