import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installRisuPatch } from '../patches/risuai/install.mjs';
import { findRisuRoots } from '../patches/risuai/remote/install-remote.mjs';

const source = [
  'function LQ(){let e=Q.db,t=e.botPresets;if(e.botPresetsId===-1)return;return t[e.botPresetsId]}',
  'function zQ(e=0,t=!0){t&&LQ();let n=Q.db,r=n.botPresets[e];return r}',
].join('\n');

function withFixture(run: (target: string, backups: string) => void) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-installer-test-'));
  try {
    const target = path.join(dir, 'database.js');
    const backups = path.join(dir, 'backups');
    fs.mkdirSync(backups);
    fs.writeFileSync(target, source);
    run(target, backups);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('patch installer previews without mutation and applies with a rollback copy', () => {
  withFixture((target, backups) => {
    const args = { patch: 'preset-switch', frontend: target, target: '', server: '', apply: false, backupDir: '' };
    const preview = installRisuPatch(args);
    assert.equal(preview[0].changed, true);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
    assert.deepEqual(fs.readdirSync(backups), []);

    const manifest = path.join(backups, 'manifest.json');
    const applied = installRisuPatch({ ...args, apply: true, backupDir: backups, manifest });
    assert.equal(applied[0].after, createHash('sha256').update(fs.readFileSync(target)).digest('hex'));
    assert.match(fs.readFileSync(target, 'utf8'), /__codexPresetExists/);
    const copies = fs.readdirSync(backups).filter((name) => name.endsWith('.bak'));
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(backups, copies[0]), 'utf8'), source);
    assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).patches.length, 1);
    assert.equal(installRisuPatch(args)[0].changed, false);
  });
});

test('patch installer rejects an unknown build without changing the target', () => {
  withFixture((target, backups) => {
    fs.writeFileSync(target, 'function unrelated() {}');
    assert.throws(() => installRisuPatch({ patch: 'preset-switch', frontend: target, target: '', server: '', apply: true, backupDir: backups }), /Expected exactly one preset anchor/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'function unrelated() {}');
    assert.deepEqual(fs.readdirSync(backups), []);
  });
});

test('windows remote entry discovers a bounded RisuAI root without reading save contents', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-auto-discovery-'));
  try {
    const root = path.join(dir, 'RisuAI');
    const save = path.join(root, 'save');
    fs.mkdirSync(save, { recursive: true });
    const database = path.join(save, Buffer.from('database/database.bin', 'utf8').toString('hex'));
    fs.writeFileSync(database, 'fixture');
    fs.writeFileSync(path.join(root, '.env'), 'SHOULD_NOT_BE_READ=secret');
    assert.deepEqual(findRisuRoots([dir]), [root]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
