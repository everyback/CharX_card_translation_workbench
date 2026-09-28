import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = new URL('../patches/risuai/scripts/patch-custom-model-profiles.mjs', import.meta.url);
const patch = fs.readFileSync(script, 'utf8');

test('API profile controls keep creation, replacement, rename and deletion distinct', () => {
  assert.match(patch, /_pb\.textContent="新建配置"/);
  assert.match(patch, /_po\.textContent="覆盖配置"/);
  assert.match(patch, /_pn\.textContent="重命名"/);
  assert.match(patch, /if\(i\.some\(function\(e\)\{return String\(e\.name\)===r\}\)\)/);
  assert.match(patch, /window\.confirm\("覆盖配置/);
  assert.match(patch, /\{\.\.\.n,name:t\}/);
  assert.match(patch, /当前填写的 API 设置不会清空/);
});

test('replays over the deployed profile revision and recognizes its own output', () => {
  const old = patch.match(/^const previousProfiles = (.*)$/m)?.[1];
  assert.ok(old);
  const oldBundle = Function(`return ${old}`)() as string;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-profiles-patch-'));
  try {
    const input = path.join(dir, 'input.js');
    const output = path.join(dir, 'output.js');
    const repeat = path.join(dir, 'repeat.js');
    fs.writeFileSync(input, `}from"./database.svelte-vu9TBkgf.js";${oldBundle}`);
    execFileSync(process.execPath, [fileURLToPath(script), input, output]);
    const upgraded = fs.readFileSync(output, 'utf8');
    assert.match(upgraded, /_pn\.textContent="重命名"/);
    assert.match(upgraded, /_po\.textContent="覆盖配置"/);
    assert.doesNotMatch(upgraded, /_pb\.textContent="保存配置"/);
    execFileSync(process.execPath, [fileURLToPath(script), output, repeat]);
    assert.equal(fs.readFileSync(repeat, 'utf8'), upgraded);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cached index asset activation changes the URL and backs up HTML', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risu-asset-activation-'));
  try {
    const asset = path.join(dir, 'index-original.js');
    const html = path.join(dir, 'index.html');
    const backup = path.join(dir, 'backup');
    fs.mkdirSync(backup);
    fs.writeFileSync(asset, 'new bundle');
    fs.writeFileSync(html, '<script type="module" src="/assets/index-original.js"></script>');
    execFileSync(process.execPath, [fileURLToPath(new URL('../patches/risuai/remote/activate-cached-asset.mjs', import.meta.url)), asset, html, backup]);
    assert.equal(fs.readFileSync(path.join(backup, 'index.html'), 'utf8'), '<script type="module" src="/assets/index-original.js"></script>');
    assert.match(fs.readFileSync(html, 'utf8'), /src="\/assets\/index-[a-f0-9]{12}\.js"/);
    const newName = fs.readFileSync(html, 'utf8').match(/assets\/(index-[a-f0-9]{12}\.js)/)?.[1];
    assert.ok(newName);
    assert.equal(fs.readFileSync(path.join(dir, newName), 'utf8'), 'new bundle');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
