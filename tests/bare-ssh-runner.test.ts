import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { requestLines } from '../server/application/patches/remote-ssh-service.js';

const bash = process.platform === 'win32' ? path.resolve('D:/Program Files/Git/bin/bash.exe') : 'bash';
const toShell = (value: string) => process.platform === 'win32' ? `/${value[0].toLowerCase()}${value.slice(2).replaceAll('\\', '/')}` : value;
const source = [
  'function LQ(){let e=Q.db,t=e.botPresets;if(e.botPresetsId===-1)return;return t[e.botPresetsId]}',
  'function zQ(e=0,t=!0){t&&LQ();let n=Q.db,r=n.botPresets[e];return r}',
].join('\n');

test('bare SSH runner discovers only project files and checks locked hashes', { skip: process.platform === 'win32' && !fs.existsSync(bash) }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cardloom-bare-runner-'));
  try {
    const project = path.join(directory, 'risuai');
    const assets = path.join(project, 'dist', 'assets');
    const bundle = path.join(directory, 'bundle');
    const bin = path.join(directory, 'bin');
    const log = path.join(directory, 'docker.log');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\n' "$@" >> "$DOCKER_TEST_LOG"
if [[ $1 == info ]]; then exit "${'$'}{DOCKER_TEST_FAILURE:-0}"; fi
while [[ $1 != node:22-alpine ]]; do shift; done
shift 3
exec node "$DOCKER_TEST_BUNDLE/patches/risuai/install.mjs" "$@"
`, { mode: 0o755 });
    fs.mkdirSync(assets, { recursive: true });
    fs.mkdirSync(path.join(bundle, 'patches'), { recursive: true });
    fs.cpSync(path.resolve('patches/risuai'), path.join(bundle, 'patches', 'risuai'), { recursive: true });
    const target = path.join(assets, 'database.svelte-test.js');
    fs.writeFileSync(target, source);
    const root = toShell(project);
    const file = toShell(target);
    const sha = (input: string) => createHash('sha256').update(input).digest('hex');
    const image = `sha256:${sha(root)}`;
    const request = (mode: 'discover' | 'preflight', hash = sha(source), failure = '0') => {
      fs.writeFileSync(path.join(bundle, 'request.txt'), requestLines({ mode, deployment: 'bare', target: root, patch: 'preset-switch', image, files: { frontend: file }, hashes: { frontend: hash } }));
      return spawnSync(bash, [toShell(path.resolve('patches/risuai/remote/bare-runner.sh')), toShell(bundle)], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, DOCKER_TEST_LOG: toShell(log), DOCKER_TEST_BUNDLE: toShell(bundle), DOCKER_TEST_FAILURE: failure } });
    };
    const found = request('discover');
    assert.equal(found.status, 0, found.stderr);
    assert.match(found.stdout, /TARGET\tfrontend\t/);
    const preview = request('preflight');
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /frontend: ready/);
    assert.match(preview.stdout, /RUNTIME\tdocker-runner\tnode:22-alpine/);
    const dockerArgs = fs.readFileSync(log, 'utf8');
    assert.ok(dockerArgs.includes(`${root}:${root}:ro`));
    assert.match(dockerArgs, /--network\nnone/);
    const unavailable = request('preflight', sha(source), '1');
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /Docker is installed but unavailable/);
    assert.notEqual(request('preflight', '0'.repeat(64)).status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), source);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
