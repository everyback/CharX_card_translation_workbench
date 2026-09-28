import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installRisuPatch } from '../patches/risuai/install.mjs';
import { inspectState, removeEntry, readState, writeState, hash, withStateLock } from '../patches/risuai/scripts/state-store.mjs';
import { createPatchAgent } from '../server/application/patches/patch-agent-service.js';

const scripts = path.resolve('patches/risuai/scripts');
const original = 'function LQ(){let e=Q.db,t=e.botPresets;if(e.botPresetsId===-1)return;return t[e.botPresetsId]}\nfunction zQ(e=0,t=!0){t&&LQ();let n=Q.db,r=n.botPresets[e];return r}';
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-lifecycle-'));
  const root = path.join(directory, 'project');
  const backups = path.join(directory, 'backups');
  fs.mkdirSync(root); fs.mkdirSync(backups);
  const file = path.join(root, 'database.js');
  fs.writeFileSync(file, original);
  const manifest = path.join(directory, 'manifest.json');
  const args = { patch: 'preset-switch', frontend: file, apply: true, backupDir: backups, manifest };
  return { directory, root, backups, file, manifest, args, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
test('install records revision; verify and remove restore exact bytes and retain audit history', () => {
  const f = fixture();
  try {
    installRisuPatch(f.args);
    const result = inspectState(f.manifest, f.root, scripts);
    assert.equal(result.records[0].canRemove, true);
    assert.match(result.records[0].revision, /^[a-f0-9]{64}$/);
    const oldState = readState(f.manifest);
    oldState.patches[0].revision = 'old-revision';
    writeState(f.manifest, oldState);
    assert.equal(inspectState(f.manifest, f.root, scripts).records[0].updateAvailable, true);
    assert.equal(inspectState(f.manifest, f.backups, scripts).records.length, 0);
    removeEntry(f.manifest, f.root, result.records[0].id, scripts);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(inspectState(f.manifest, f.root, scripts).records[0].state, 'removed');
    assert.throws(() => removeEntry(f.manifest, f.root, result.records[0].id, scripts), /已卸载/);
  } finally { f.cleanup(); }
});
test('restore refuses drift, corrupt backup, wrong target and dependent patches', () => {
  const f = fixture();
  try {
    installRisuPatch(f.args);
    const entry = readState(f.manifest).patches[0];
    const patched = fs.readFileSync(f.file);
    fs.appendFileSync(f.file, '\n// later manual edit');
    assert.throws(() => removeEntry(f.manifest, f.root, entry.id, scripts), /已变化/);
    fs.writeFileSync(f.file, patched);
    const backup = fs.readFileSync(entry.targets[0].backup);
    fs.writeFileSync(entry.targets[0].backup, 'bad backup');
    assert.throws(() => removeEntry(f.manifest, f.root, entry.id, scripts), /备份校验/);
    fs.writeFileSync(entry.targets[0].backup, backup);
    assert.throws(() => removeEntry(f.manifest, f.backups, entry.id, scripts), /not found/);
    const state = readState(f.manifest);
    state.patches.push({ ...entry, id: 'later', patch: 'read-cache' });
    writeState(f.manifest, state);
    assert.throws(() => removeEntry(f.manifest, f.root, entry.id, scripts), /后续补丁/);
    assert.deepEqual(fs.readFileSync(f.file), patched);
  } finally { f.cleanup(); }
});
test('manifest write failure rolls back installed files and leaves backup available', () => {
  const f = fixture();
  const write = fs.renameSync;
  try {
    fs.renameSync = ((from, to) => { if (to === f.manifest) throw new Error('injected manifest failure'); return write(from, to); }) as typeof write;
    assert.throws(() => installRisuPatch(f.args), /injected manifest failure/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
    assert.equal(fs.readdirSync(f.backups).length, 1);
    assert.equal(fs.existsSync(f.manifest + '.lock'), false);
  } finally { fs.renameSync = write; f.cleanup(); }
});
test('restore transaction recovers already-restored files when another write fails', () => {
  const f = fixture();
  const write = fs.writeFileSync;
  try {
    installRisuPatch(f.args);
    const state = readState(f.manifest);
    const entry = state.patches[0];
    const second = path.join(f.root, 'second.js');
    const backup = path.join(f.backups, 'second.bak');
    fs.writeFileSync(second, 'after'); fs.writeFileSync(backup, 'before');
    entry.targets.push({ file: second, backup, before: hash('before'), after: hash('after') });
    writeState(f.manifest, state);
    const before = fs.readFileSync(f.file);
    let fail = true;
    fs.writeFileSync = ((file, data, options) => { if (file === second && fail) { fail = false; throw new Error('injected write failure'); } return write(file, data, options); }) as typeof write;
    assert.throws(() => removeEntry(f.manifest, f.root, entry.id, scripts), /injected write failure/);
    assert.deepEqual(fs.readFileSync(f.file), before);
    assert.equal(fs.readFileSync(second, 'utf8'), 'after');
    assert.equal(readState(f.manifest).patches[0].removedAt, undefined);
  } finally { fs.writeFileSync = write; f.cleanup(); }
});
test('state lock refuses concurrent mutation', () => {
  const f = fixture();
  try { withStateLock(f.manifest, () => assert.throws(() => installRisuPatch(f.args), /Another patch operation/)); }
  finally { f.cleanup(); }
});
test('local agent requires matching preview and one-use restore token', async () => {
  const f = fixture();
  try {
    const agent = createPatchAgent({ enabled: true, roots: [f.root], backupDirectory: f.backups });
    const input = { patch: 'preset-switch', frontend: f.file, apply: true, confirm: 'INSTALL' };
    await assert.rejects(agent.run(input), /重新预检/);
    await agent.run({ ...input, apply: false });
    fs.appendFileSync(f.file, '\n// drift');
    await assert.rejects(agent.run(input), /重新预检/);
    fs.writeFileSync(f.file, original);
    await agent.run({ ...input, apply: false });
    await agent.run(input);
    const history = await agent.history(f.root);
    assert.ok(history.records[0].removeToken);
    await agent.remove(history.records[0].removeToken);
    await assert.rejects(agent.remove(history.records[0].removeToken), /过期/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  } finally { f.cleanup(); }
});
