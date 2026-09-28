import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPatchAgent, PatchAgentError } from '../server/application/patches/patch-agent-service.js';

test('patch agent discovers targets only inside configured directories', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'workbench-patch-agent-'));
  try {
    const root = path.join(temporary, 'risuai');
    const sourceDir = path.join(root, 'src', 'ts', 'plugins');
    mkdirSync(sourceDir, { recursive: true });
    const target = path.join(sourceDir, 'plugins.svelte.ts');
    const outside = path.join(temporary, 'plugins.svelte.ts');
    writeFileSync(target, 'source');
    writeFileSync(outside, 'outside');
    const agent = createPatchAgent({
      enabled: true,
      roots: [root],
      backupDirectory: path.join(temporary, 'backup'),
      installerPath: path.resolve('patches/risuai/install.mjs'),
      testMode: true,
    });
    assert.equal(agent.status().configured, true);
    assert.equal(agent.status().testMode, true);
    assert.deepEqual(agent.discover('plugin-v21-import').installations[0]?.targets.target, [target]);
    await assert.rejects(
      agent.run({ patch: 'plugin-v21-import', target: outside, apply: false }),
      (error: unknown) => error instanceof PatchAgentError && error.statusCode === 403,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('patch agent stays unavailable until an accessible target root is configured', () => {
  const agent = createPatchAgent({ enabled: true, roots: [], backupDirectory: os.tmpdir() });
  assert.equal(agent.status().configured, false);
  assert.throws(() => agent.discover('preset-switch'), PatchAgentError);
});

test('desktop runtime root selection enables the agent without exposing arbitrary commands', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'workbench-patch-agent-runtime-'));
  try {
    const agent = createPatchAgent({
      enabled: true,
      roots: [],
      backupDirectory: path.join(temporary, 'backup'),
      installerPath: path.resolve('patches/risuai/install.mjs'),
      allowRuntimeRoots: true,
    });
    assert.equal(agent.status().configured, false);
    assert.equal(agent.status().canChooseRoot, true);
    agent.setRoots([temporary]);
    assert.equal(agent.status().configured, true);
    assert.throws(() => agent.setRoots([path.join(temporary, '..', 'a'), path.join(temporary, '..', 'b'), path.join(temporary, '..', 'c'), path.join(temporary, '..', 'd'), path.join(temporary, '..', 'e')]), PatchAgentError);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
