import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRemotePatchService, parseDiscovery, RemotePatchError, requestLines, validateRemoteProfile, type RemoteRequest } from '../server/application/patches/remote-ssh-service.js';
import { createTemporarySshKeyStore } from '../server/application/patches/temporary-ssh-keys.js';

const image = 'sha256:' + 'a'.repeat(64);
const hash = 'b'.repeat(64);
const file = '/app/dist/assets/database.svelte-test.js';
const discovery = `IMAGE\t${image}\nTARGET\tfrontend\t${file}\t${hash}`;

test('remote restore requires fresh target-bound one-use confirmation and locks concurrent operations', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-history-'));
  try {
    const keyFile = path.join(dir, 'key'); writeFileSync(keyFile, 'fixture');
    let release: (() => void) | undefined;
    const service = createRemotePatchService(async (_profile, request) => {
      if (request.mode === 'history') return `IMAGE\t${image}\nRECORD\tdocker-fixture\tpreset-switch\t2026-09-27\tdeployed\trevision\t/opt/backup\ttrue`;
      if (request.mode === 'remove') {
        assert.equal(request.image, image); assert.equal(request.files?.target, 'docker-fixture');
        await new Promise<void>((resolve) => { release = resolve; });
        return 'STATE\t{"removed":true}';
      }
      return discovery;
    }, true);
    await service.connect({ host: 'example.org', user: 'ubuntu', keyFile, deployment: 'docker', target: 'risuai' });
    await assert.rejects(service.remove('not-confirmed'), /过期/);
    const first = await service.history();
    const fresh = await service.history();
    await assert.rejects(service.remove(first.records[0].removeToken), /过期/);
    const removing = service.remove(fresh.records[0].removeToken);
    await assert.rejects(service.discover('preset-switch'), /正在进行/);
    assert.throws(() => service.disconnect(), /进行中/);
    release!(); await removing;
    await assert.rejects(service.remove(fresh.records[0].removeToken), /过期/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('dropped key stays local and is released when the SSH target disconnects', async () => {
  const keys = createTemporarySshKeyStore();
  const fakeKey = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n');
  try {
    assert.throws(() => keys.stage(Buffer.from('not a key')), RemotePatchError);
    assert.throws(() => keys.stage(Buffer.alloc(64 * 1024 + 1)), RemotePatchError);
    const reference = keys.stage(fakeKey);
    const localFile = keys.resolve(reference);
    assert.ok(localFile && existsSync(localFile));
    const service = createRemotePatchService(async (profile, request) => {
      assert.equal(profile.keyFile, localFile);
      assert.equal(profile.keyReference, reference);
      return request.mode === 'probe' ? 'CONTAINER\trisuai' : discovery;
    }, true, keys);
    const input = { host: 'example.org', user: 'ubuntu', keyFile: reference };
    assert.deepEqual(await service.probe(input), { containers: ['risuai'], roots: [] });
    assert.equal(service.status().connected, false);
    await service.connect({ ...input, deployment: 'docker', target: 'risuai' });
    assert.equal('keyFile' in service.status(), false);
    assert.ok(existsSync(localFile));
    service.disconnect();
    assert.equal(keys.resolve(reference), undefined);
    assert.equal(existsSync(localFile), false);
    await assert.rejects(service.probe(input), RemotePatchError);
  } finally { keys.clear(); }
});

test('staged Windows key passes the OpenSSH private-key permission check', { skip: process.platform !== 'win32' }, () => {
  const source = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-fixture-'));
  const keys = createTemporarySshKeyStore();
  try {
    const original = path.join(source, 'test-key');
    execFileSync('ssh-keygen.exe', ['-q', '-t', 'ed25519', '-N', '', '-f', original], { windowsHide: true });
    const reference = keys.stage(readFileSync(original));
    const staged = keys.resolve(reference);
    assert.ok(staged);
    const publicKey = execFileSync('ssh-keygen.exe', ['-y', '-f', staged], { encoding: 'utf8', windowsHide: true });
    assert.match(publicKey, /^ssh-ed25519 /);
    const acl = execFileSync('icacls.exe', [staged], { encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(acl, /CodexSandboxUsers/i);
  } finally {
    keys.clear();
    rmSync(source, { recursive: true, force: true });
  }
});

test('remote profile only accepts an existing local key and safe SSH/container identifiers', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-profile-'));
  const keyFile = path.join(dir, 'key.pem');
  try {
    writeFileSync(keyFile, 'test key');
    const valid = { host: 'example.org', user: 'ubuntu', deployment: 'docker', target: 'risuai', keyFile };
    assert.equal(validateRemoteProfile(valid).host, 'example.org');
    assert.throws(() => validateRemoteProfile({ ...valid, host: '-oProxyCommand=evil' }), RemotePatchError);
    assert.throws(() => validateRemoteProfile({ ...valid, user: 'ubuntu;id' }), RemotePatchError);
    assert.throws(() => validateRemoteProfile({ ...valid, keyFile: path.join(dir, 'missing') }), RemotePatchError);
    assert.throws(() => validateRemoteProfile({ ...valid, target: 'risuai\nother' }), RemotePatchError);
    assert.equal(validateRemoteProfile({ ...valid, deployment: 'bare', target: '/opt/risuai' }).target, '/opt/risuai');
    assert.throws(() => validateRemoteProfile({ ...valid, deployment: 'bare', target: '/opt/../etc' }), RemotePatchError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('SSH output rejects untrusted target paths and unknown roles', () => {
  const identified = parseDiscovery(discovery + '\nIDENTITY\t{"kind":"docker","version":"2026.8.160","health":"running"}', 'preset-switch');
  assert.equal(identified.identity?.version, '2026.8.160');
  assert.throws(() => parseDiscovery(discovery + '\nIDENTITY\t{}', 'preset-switch'), RemotePatchError);
  assert.deepEqual(parseDiscovery(discovery, 'preset-switch'), { image, targets: [{ role: 'frontend', file, hash }] });
  assert.throws(() => parseDiscovery(`IMAGE\t${image}\nTARGET\tfrontend\t/app/dist/assets/../../save/data.js\t${hash}`, 'preset-switch'), RemotePatchError);
  assert.throws(() => parseDiscovery(`IMAGE\t${image}\nTARGET\tserver\t/app/server/node/server.cjs\t${hash}`, 'preset-switch'), RemotePatchError);
  assert.deepEqual(parseDiscovery(`IMAGE\t${image}\nTARGET\ttarget\t/opt/risuai/src/ts/plugins/plugins.svelte.ts\t${hash}`, 'plugin-v21-import', 'bare').targets[0]?.role, 'target');
  assert.throws(() => parseDiscovery(`IMAGE\t${image}\nTARGET\ttarget\t/opt/risuai/../src/ts/plugins/plugins.svelte.ts\t${hash}`, 'plugin-v21-import', 'bare'), RemotePatchError);
});

test('probe inventories targets without retaining an SSH profile', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-probe-'));
  try {
    const keyFile = path.join(dir, 'key.pem'); writeFileSync(keyFile, 'test key');
    const service = createRemotePatchService(async (_profile, request) => {
      assert.equal(request.mode, 'probe');
      return 'CONTAINER\trisuai\nCONTAINER\trisuai-test\nROOT\t/opt/risuai\n';
    }, true);
    assert.deepEqual(await service.probe({ host: 'example.org', user: 'ubuntu', keyFile }), { containers: ['risuai', 'risuai-test'], roots: ['/opt/risuai'] });
    assert.equal(service.status().connected, false);
    await assert.rejects(service.probe({ host: 'example.org', user: 'ubuntu', keyFile: '/missing' }), RemotePatchError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bare deployment locks selected file and uses the same preflight token', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-bare-'));
  try {
    const keyFile = path.join(dir, 'key.pem'); writeFileSync(keyFile, 'test key');
    const bareFile = '/opt/risuai/dist/assets/database.svelte-test.js';
    const calls: RemoteRequest[] = [];
    const service = createRemotePatchService(async (_profile, request) => {
      calls.push(request);
      if (request.mode === 'discover') return `IMAGE\t${image}\nTARGET\tfrontend\t${bareFile}\t${hash}`;
      if (request.mode === 'preflight') return `IMAGE\t${image}\nfrontend: ready ${bareFile}`;
      return 'INSTALLED\t/opt/risuai\t/opt/backup';
    }, true);
    await service.connect({ host: 'example.org', user: 'ubuntu', keyFile, deployment: 'bare', target: '/opt/risuai' });
    assert.ok(service.status().patches.includes('plugin-v21-import'));
    await service.discover('preset-switch');
    await assert.rejects(service.preflight('preset-switch', { frontend: '/opt/other/dist/assets/database.js' }), RemotePatchError);
    const result = await service.preflight('preset-switch', { frontend: bareFile });
    assert.equal(result.changed, true);
    assert.match(requestLines(calls.at(-1)!), /^preflight\nbare\n\/opt\/risuai\npreset-switch\n/);
    assert.equal((await service.apply(result.token)).installed, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('preflight locks selected container targets and apply needs its one-use token', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-plan-'));
  try {
    const keyFile = path.join(dir, 'key.pem'); writeFileSync(keyFile, 'test key');
    const calls: RemoteRequest[] = [];
    const service = createRemotePatchService(async (_profile, request) => {
      calls.push(request);
      if (request.mode === 'discover') return discovery;
      if (request.mode === 'preflight') return `IMAGE\t${image}\nfrontend: ready /targets/frontend.js\n ${hash} -> ${'c'.repeat(64)}`;
      return 'INSTALLED\tnew\told\t/backup';
    }, true);
    await service.connect({ host: 'example.org', user: 'ubuntu', deployment: 'docker', target: 'risuai', keyFile });
    assert.equal('keyFile' in service.status(), false);
    await service.discover('preset-switch');
    await assert.rejects(service.preflight('preset-switch', { frontend: '/app/dist/assets/other.js' }), RemotePatchError);
    const preview = await service.preflight('preset-switch', { frontend: file });
    assert.equal(preview.changed, true);
    assert.equal(calls.at(-1)?.image, image);
    assert.equal(calls.at(-1)?.hashes?.frontend, hash);
    await assert.rejects(service.apply('wrong-token'), RemotePatchError);
    assert.equal((await service.apply(preview.token)).installed, true);
    await assert.rejects(service.apply(preview.token), RemotePatchError);
    await assert.rejects(service.discover('plugin-v21-import'), RemotePatchError);
    assert.equal(service.disconnect().connected, false);
    await assert.rejects(service.discover('preset-switch'), RemotePatchError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
