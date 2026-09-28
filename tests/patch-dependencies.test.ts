import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { installRisuPatch } from '../patches/risuai/install.mjs';

const dependencies = JSON.parse(fs.readFileSync('patches/risuai/scripts/dependencies.json', 'utf8'));

test('list cache blocks each missing prerequisite before preview or writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-dependencies-'));
  try {
    const frontend = path.join(dir, 'frontend.js');
    const server = path.join(dir, 'server.cjs');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir);
    for (const missing of ['all', 'read-performance', 'read-cache']) {
      const sources: Record<string, string> = { frontend: '', server: '' };
      for (const dependency of dependencies['list-cache']) {
        if (missing === 'all' || dependency.patch === missing) continue;
        for (const [role, anchors] of Object.entries(dependency.checks)) {
          sources[role] += (anchors as string[]).join('\n');
        }
      }
      fs.writeFileSync(frontend, sources.frontend);
      fs.writeFileSync(server, sources.server);
      for (const apply of [false, true]) {
        assert.throws(() => installRisuPatch({ patch: 'list-cache', frontend, server, apply, backupDir }), (error: Error) => {
          assert.match(error.message, /请先安装/);
          for (const dependency of dependencies['list-cache']) {
            assert.equal(error.message.includes(dependency.name), missing === 'all' || missing === dependency.patch);
          }
          return true;
        });
      }
      assert.equal(fs.readFileSync(frontend, 'utf8'), sources.frontend);
      assert.equal(fs.readFileSync(server, 'utf8'), sources.server);
      assert.deepEqual(fs.readdirSync(backupDir), []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('present dependencies pass the gate; removing one component fails again', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-dependencies-present-'));
  try {
    const frontend = path.join(dir, 'frontend.js');
    const server = path.join(dir, 'server.cjs');
    const sources: Record<string, string> = { frontend: 'const keysCacheStore = true;\n', server: 'const __risuListEtag = true;\n' };
    // Stand-in scripts exercise dependency detection independently of version-specific transforms.
    for (const dependency of dependencies['list-cache']) {
      for (const [role, anchors] of Object.entries(dependency.checks)) sources[role] += (anchors as string[]).map((anchor) => `// ${anchor}\n`).join('');
    }
    fs.writeFileSync(frontend, sources.frontend);
    fs.writeFileSync(server, sources.server);
    const args = { patch: 'list-cache', frontend, server, apply: false, backupDir: '' };
    assert.ok(installRisuPatch(args).every((result: { changed: boolean }) => !result.changed));
    fs.writeFileSync(server, sources.server.replace('__risuListCache', 'removed'));
    assert.throws(() => installRisuPatch(args), /请先安装.*远程读取性能/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('downloaded toolkits include the dependency manifest', () => {
  const page = fs.readFileSync('src/pages/plugins/PluginManagerPage.tsx', 'utf8');
  assert.match(page, /'scripts\/dependencies.json': dependencySource/);
  assert.match(page, /'scripts\/state-store.mjs': stateStoreSource/);
  assert.match(page, /'patch-state.mjs': patchStateSource/);
});
