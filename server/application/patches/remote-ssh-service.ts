import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { patchRoles, type PatchName, type PatchRole } from './patch-agent-service.js';

const execFileAsync = promisify(execFile);
const remoteCommand = "sudo -n bash -c 'set -euo pipefail; d=$(mktemp -d /tmp/cardloom-ssh-XXXXXX); trap \"rm -rf \\\"$d\\\"\" EXIT; tar -xz -C \"$d\"; bash \"$d/ssh-runner.sh\" \"$d\"'";
const allowedHost = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/;
const allowedUser = /^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/;
const allowedContainer = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/;
const sha = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const requiredRoles = ['target', 'frontend', 'server'] as const;
const remotePatchNames = ['preset-switch', 'api-profiles', 'image-router', 'read-performance', 'read-cache', 'list-cache'] as const;
export type RemoteProfile = { host: string; user: string; keyFile: string; keyReference?: string; deployment: 'docker' | 'bare'; target: string };
export type SshKeyStore = { resolve(reference: string): string | undefined; retain?(reference: string): void; release(reference: string): void };
export type RemoteTarget = { role: PatchRole; file: string; hash: string };
export class RemotePatchError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); this.name = 'RemotePatchError'; }
}
function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw new RemotePatchError(`${label}无效。`);
  return value.trim();
}
export function validateRemoteProfile(raw: Record<string, unknown>, keyStore?: SshKeyStore): RemoteProfile {
  const host = text(raw.host, '服务器地址');
  const user = text(raw.user, 'SSH 用户');
  const deployment = raw.deployment;
  const target = text(raw.target, '部署目标');
  const keyInput = text(raw.keyFile, 'SSH 密钥路径');
  if (!allowedHost.test(host) || host.includes('..') || host.endsWith('.')) throw new RemotePatchError('服务器地址必须是主机名或 IP。');
  if (!allowedUser.test(user) || (deployment !== 'docker' && deployment !== 'bare')) throw new RemotePatchError('SSH 用户或部署方式无效。');
  if (deployment === 'docker' ? !allowedContainer.test(target) : !target.startsWith('/') || target.split('/').includes('..') || /[\t\r\n]/.test(target)) throw new RemotePatchError('容器名或部署目录无效。');
  const keyReference = keyInput.startsWith('ssh-key:') ? keyInput : undefined;
  const keyFile = keyReference ? keyStore?.resolve(keyReference) : keyInput;
  if (!keyFile || !path.isAbsolute(keyFile)) throw new RemotePatchError('SSH 密钥必须填写本机绝对路径，或重新拖入私钥文件。');
  let actual: string;
  try {
    if (!lstatSync(keyFile).isFile()) throw new Error();
    actual = realpathSync(keyFile);
    if (!lstatSync(actual).isFile()) throw new Error();
  } catch { throw new RemotePatchError('SSH 密钥文件不存在或不可读取。'); }
  return { host, user, deployment, target, keyFile: actual, ...(keyReference ? { keyReference } : {}) };
}
function patchName(value: unknown, deployment: RemoteProfile['deployment']): PatchName {
  if (typeof value !== 'string' || !(deployment === 'bare' ? [...remotePatchNames, 'plugin-v21-import'] : remotePatchNames).includes(value as typeof remotePatchNames[number])) throw new RemotePatchError('补丁名称不受支持。');
  return value as PatchName;
}
export function parseDiscovery(output: string, patch: PatchName, deployment: RemoteProfile['deployment'] = 'docker') {
  const lines = output.trim().split(/\r?\n/);
  const first = lines.shift()?.split('\t');
  if (first?.[0] !== 'IMAGE' || !imageId.test(first[1] || '')) throw new RemotePatchError('服务器未返回有效的容器镜像信息。', 502);
  const targets: RemoteTarget[] = [];
  let identity: { kind: string; version: string; health: string } | undefined;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('IDENTITY\t')) {
      if (identity) throw new RemotePatchError('目标身份重复。', 502);
      let value;
      try { value = JSON.parse(line.slice(9)); } catch { throw new RemotePatchError('目标身份无效。', 502); }
      if (!value || value.kind !== 'docker' || typeof value.version !== 'string' || !/^[a-zA-Z0-9.+_-]{1,80}$/.test(value.version) || typeof value.health !== 'string' || !/^[a-zA-Z]+$/.test(value.health)) throw new RemotePatchError('目标身份无效。', 502);
      identity = value;
      continue;
    }
    const parts = line.split('\t');
    const role = parts[1] as PatchRole;
    if (parts.length !== 4 || parts[0] !== 'TARGET' || !(patchRoles[patch] as readonly string[]).includes(role) || !sha.test(parts[3]) || !validRemotePath(patch, role, parts[2], deployment)) {
      throw new RemotePatchError('服务器返回了无效的目标文件信息。', 502);
    }
    targets.push({ role, file: parts[2], hash: parts[3] });
  }
  return { image: first[1], targets, ...(identity ? { identity } : {}) };
}
function validRemotePath(patch: PatchName, role: PatchRole, file: string, deployment: RemoteProfile['deployment']): boolean {
  if (deployment === 'bare') return file.startsWith('/') && !file.split('/').includes('..') && (role === 'target' ? file.endsWith('/src/ts/plugins/plugins.svelte.ts') : role === 'server' ? file.endsWith('/server/node/server.cjs') : new RegExp(`/dist/assets/${patch === 'api-profiles' ? 'index' : 'database'}[\\w.-]*\\.js$`).test(file));
  if (role === 'target') return file === '/app/src/ts/plugins/plugins.svelte.ts';
  if (role === 'server') return file === '/app/server/node/server.cjs';
  if (!file.startsWith('/app/dist/assets/')) return false;
  const name = file.slice('/app/dist/assets/'.length);
  return patch === 'api-profiles' ? /^index(?:[.-][\w-]+)?\.js$/.test(name) : /^database(?:\.svelte)?(?:[.-][\w-]+)?\.js$/.test(name);
}
export type RemoteRequest = {
  mode: 'probe' | 'discover' | 'preflight' | 'apply' | 'history' | 'remove'; deployment: RemoteProfile['deployment']; target: string; patch: PatchName;
  image?: string; files?: Partial<Record<PatchRole, string>>; hashes?: Partial<Record<PatchRole, string>>;
};
export function requestLines(request: RemoteRequest): string {
  return [request.mode, request.deployment, request.target, request.patch, request.image || '', ...requiredRoles.map((role) => request.files?.[role] || ''), ...requiredRoles.map((role) => request.hashes?.[role] || '')].join('\n') + '\n';
}
export type RemoteTransport = (profile: RemoteProfile, request: RemoteRequest) => Promise<string>;
export function createSshTransport(patchRoot = path.resolve(process.cwd(), 'patches/risuai')): RemoteTransport {
  return async (profile, request) => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-package-'));
    try {
      const packageDir = path.join(work, 'package');
      mkdirSync(path.join(packageDir, 'patches', 'risuai'), { recursive: true });
      cpSync(path.join(patchRoot, 'scripts'), path.join(packageDir, 'patches', 'risuai', 'scripts'), { recursive: true });
      copyFileSync(path.join(patchRoot, 'install.mjs'), path.join(packageDir, 'patches', 'risuai', 'install.mjs'));
      copyFileSync(path.join(patchRoot, 'patch-state.mjs'), path.join(packageDir, 'patches', 'risuai', 'patch-state.mjs'));
      copyFileSync(path.join(patchRoot, 'remote', 'ssh-runner.sh'), path.join(packageDir, 'ssh-runner.sh'));
      copyFileSync(path.join(patchRoot, 'remote', 'bare-runner.sh'), path.join(packageDir, 'bare-runner.sh'));
      copyFileSync(path.join(patchRoot, 'remote', 'docker-history.sh'), path.join(packageDir, 'docker-history.sh'));
      writeFileSync(path.join(packageDir, 'request.txt'), requestLines(request), { mode: 0o600 });
      const archive = path.join(work, 'payload.tgz');
      await execFileAsync('tar', ['-czf', archive, '-C', packageDir, '.'], { timeout: 30_000, windowsHide: true });
      return await new Promise<string>((resolve, reject) => {
        const child = spawn('ssh', [
          '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
          '-o', 'IdentitiesOnly=yes', '-i', profile.keyFile, `${profile.user}@${profile.host}`, remoteCommand,
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let total = 0;
        const timer = setTimeout(() => child.kill(), request.mode === 'apply' || request.mode === 'remove' ? 180_000 : 90_000);
        const collect = (list: Buffer[]) => (chunk: Buffer) => { total += chunk.length; if (total > 1024 * 1024) child.kill(); else list.push(chunk); };
        child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
        child.on('error', reject);
        child.on('close', (code) => {
          clearTimeout(timer);
          const err = Buffer.concat(stderr).toString('utf8').trim();
          const out = Buffer.concat(stdout).toString('utf8').trim();
          if (code !== 0) reject(new RemotePatchError((err || out || `SSH 退出码 ${code}`).slice(0, 1800), 502));
          else resolve(out);
        });
        void pipeline(createReadStream(archive), child.stdin).catch(() => { child.kill(); });
      });
    } finally { rmSync(work, { recursive: true, force: true }); }
  };
}
export function createRemotePatchService(transport: RemoteTransport, enabled: boolean, keyStore?: SshKeyStore) {
  let profile: RemoteProfile | null = null;
  let discovery: { patch: PatchName; image: string; targets: RemoteTarget[] } | null = null;
  let pending: { token: string; expires: number; patch: PatchName; image: string; files: Partial<Record<PatchRole, string>>; hashes: Partial<Record<PatchRole, string>> } | null = null;
  let busy = false;
  const removals = new Map<string, { id: string; image?: string; expires: number }>();
  function ensureEnabled() { if (!enabled) throw new RemotePatchError('远程补丁功能只在本机工作台启用。', 403); }
  function getProfile() { ensureEnabled(); if (!profile) throw new RemotePatchError('请先连接服务器。', 409); return profile; }
  function status() { return { enabled, connected: Boolean(profile), host: profile?.host, user: profile?.user, deployment: profile?.deployment, target: profile?.target, patches: profile?.deployment === 'bare' ? ['plugin-v21-import', ...remotePatchNames] : [...remotePatchNames] }; }
  async function probe(raw: Record<string, unknown>) {
    ensureEnabled();
    const candidate = validateRemoteProfile({ ...raw, deployment: 'docker', target: 'probe' }, keyStore);
    const output = await transport(candidate, { mode: 'probe', deployment: 'docker', target: '', patch: 'preset-switch' });
    const containers: string[] = []; const roots: string[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [kind, value, ...extra] = line.split('\t');
      if (extra.length || !value || (kind === 'CONTAINER' ? !allowedContainer.test(value) : kind !== 'ROOT' || !value.startsWith('/') || value.split('/').includes('..'))) throw new RemotePatchError('服务器返回了无效的部署列表。', 502);
      (kind === 'CONTAINER' ? containers : roots).push(value);
    }
    return { containers, roots };
  }
  async function connect(raw: Record<string, unknown>) {
    removals.clear();
    ensureEnabled(); const candidate = validateRemoteProfile(raw, keyStore);
    const patch: PatchName = 'preset-switch';
    const output = await transport(candidate, { mode: 'discover', deployment: candidate.deployment, target: candidate.target, patch });
    parseDiscovery(output, patch, candidate.deployment);
    if (profile?.keyReference && profile.keyReference !== candidate.keyReference) keyStore?.release(profile.keyReference);
    if (candidate.keyReference) keyStore?.retain?.(candidate.keyReference);
    profile = candidate; discovery = null; pending = null;
    return status();
  }
  async function discover(value: unknown) {
    const current = getProfile(); const patch = patchName(value, current.deployment);
    const result = parseDiscovery(await transport(current, { mode: 'discover', deployment: current.deployment, target: current.target, patch }), patch, current.deployment);
    discovery = { patch, ...result }; pending = null;
    return result;
  }
  async function preflight(value: unknown, selected: unknown) {
    pending = null;
    const current = getProfile(); const patch = patchName(value, current.deployment);
    if (!discovery || discovery.patch !== patch) throw new RemotePatchError('请先读取当前容器目标。', 409);
    if (!selected || typeof selected !== 'object' || Array.isArray(selected)) throw new RemotePatchError('请选择目标文件。');
    const raw = selected as Record<string, unknown>;
    const files: Partial<Record<PatchRole, string>> = {};
    const hashes: Partial<Record<PatchRole, string>> = {};
    for (const role of patchRoles[patch]) {
      const file = text(raw[role], `${role} 目标文件`);
      const target = discovery.targets.find((item) => item.role === role && item.file === file);
      if (!target) throw new RemotePatchError(`${role} 目标不属于当前容器。`, 403);
      files[role] = file; hashes[role] = target.hash;
    }
    const output = await transport(current, { mode: 'preflight', deployment: current.deployment, target: current.target, patch, image: discovery.image, files, hashes });
    pending = null;
    if (!output.includes('IMAGE\t' + discovery.image)) throw new RemotePatchError('预检时容器镜像发生变化。', 409);
    const changed = /:\sready\s/.test(output);
    if (changed) pending = { token: randomUUID(), expires: Date.now() + 15 * 60_000, patch, image: discovery.image, files, hashes };
    return { output: output.slice(0, 8000), changed, token: pending?.token || null };
  }
  async function apply(tokenValue: unknown) {
    const current = getProfile();
    if (typeof tokenValue !== 'string' || !pending || pending.token !== tokenValue || Date.now() > pending.expires) throw new RemotePatchError('预检已过期，请重新预检。', 409);
    const plan = pending; pending = null; removals.clear();
    try {
      const output = await transport(current, { mode: 'apply', deployment: current.deployment, target: current.target, patch: plan.patch, image: plan.image, files: plan.files, hashes: plan.hashes });
      discovery = null;
      return { output: output.slice(0, 10000), installed: output.includes('INSTALLED\t') };
    } finally { discovery = null; }
  }
  async function history() {
    const current = getProfile();
    removals.clear();
    const output = await transport(current, { mode: 'history', deployment: current.deployment, target: current.target, patch: 'preset-switch' });
    let result: { records: Array<Record<string, unknown>>; image?: string };
    const state = output.split('\n').find((line) => line.startsWith('STATE\t'));
    if (state) result = JSON.parse(state.slice(6));
    else {
      const image = output.split('\n').find((line) => line.startsWith('IMAGE\t'))?.slice(6);
      if (!imageId.test(image || '')) throw new RemotePatchError('无法核验当前镜像。', 502);
      result = { image, records: output.split('\n').filter((line) => line.startsWith('RECORD\t')).map((line) => {
        const [, id, patch, installedAt, state, revision, backup, eligible, availableRevision] = line.split('\t');
        if (!/^docker-[a-zA-Z0-9_-]+$/.test(id)) throw new RemotePatchError('安装记录无效。', 502);
        return { id, patch, installedAt, state, revision, availableRevision, updateAvailable: Boolean(availableRevision && revision !== availableRevision), backup, canRemove: eligible === 'true', reason: state === 'removed' ? '已回滚' : eligible === 'true' ? '' : '不是当前镜像，或配置/备份已变化', targets: [] };
      }).reverse() };
    }
    if (!Array.isArray(result.records)) throw new RemotePatchError('安装记录无效。', 502);
    const records = result.records.map((record) => {
      if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(record.id)) throw new RemotePatchError('记录标识无效。', 502);
      if (!record.canRemove) return record;
      const token = randomUUID();
      removals.set(token, { id: record.id, image: result.image, expires: Date.now() + 300_000 });
      return { ...record, removeToken: token };
    });
    records.sort((a, b) => String(b.installedAt).localeCompare(String(a.installedAt)));
    return { ...result, records, target: current.target, deployment: current.deployment };
  }
  async function remove(token: unknown) {
    const current = getProfile();
    const plan = typeof token === 'string' ? removals.get(token) : undefined;
    if (!plan || Date.now() > plan.expires) throw new RemotePatchError('卸载确认已过期，请重新核验安装记录。', 409);
    removals.clear(); pending = null; discovery = null;
    const output = await transport(current, { mode: 'remove', deployment: current.deployment, target: current.target, patch: 'preset-switch', image: plan.image, files: { target: plan.id } });
    const line = output.split('\n').find((item) => item.startsWith('STATE\t'));
    if (!line || JSON.parse(line.slice(6)).removed !== true) throw new RemotePatchError('未确认恢复成功，请刷新记录核验。', 502);
    return { removed: true, output };
  }
  function disconnect() { if (busy) throw new RemotePatchError('操作进行中，不能更换目标。', 409); if (profile?.keyReference) keyStore?.release(profile.keyReference); profile = null; discovery = null; pending = null; removals.clear(); return status(); }
  function exclusive<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      if (busy) throw new RemotePatchError('另一个补丁操作正在进行。', 409);
      busy = true;
      try { return await fn(...args); } finally { busy = false; }
    };
  }
  return { status, probe: exclusive(probe), connect: exclusive(connect), disconnect, discover: exclusive(discover), preflight: exclusive(preflight), apply: exclusive(apply), history: exclusive(history), remove: exclusive(remove) };
}
