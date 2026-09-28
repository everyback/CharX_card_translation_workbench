import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RemotePatchError } from './remote-ssh-service.js';

const lifetimeMs = 30 * 60_000;
const keyPattern = /^-----BEGIN (?:OPENSSH PRIVATE KEY|(?:RSA |EC |DSA )?PRIVATE KEY)-----/;

function protectWindowsDirectory(directory: string) {
  const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = identity.match(/"(S-\d+(?:-\d+)+)"/)?.[1];
  if (!sid) throw new Error('Cannot determine the current Windows user SID');
  const options = { windowsHide: true, stdio: 'pipe' as const };
  execFileSync('icacls.exe', [directory, '/grant:r', `*${sid}:(OI)(CI)F`], options);
  execFileSync('icacls.exe', [directory, '/inheritance:r'], options);
}

export function createTemporarySshKeyStore() {
  const keys = new Map<string, { directory: string; file: string; timer: NodeJS.Timeout | null }>();
  function release(reference: string) {
    const entry = keys.get(reference);
    if (!entry) return;
    keys.delete(reference);
    if (entry.timer) clearTimeout(entry.timer);
    rmSync(entry.directory, { recursive: true, force: true });
  }
  function stage(contents: Buffer): string {
    if (!contents.length || contents.length > 64 * 1024 || !keyPattern.test(contents.toString('utf8', 0, 80))) {
      throw new RemotePatchError('请选择不超过 64 KiB 的 OpenSSH 或 PEM 私钥文件。');
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'cardloom-ssh-key-'));
    const file = path.join(directory, 'identity');
    try {
      if (process.platform === 'win32') protectWindowsDirectory(directory);
      writeFileSync(file, contents, { mode: 0o600, flag: 'wx' });
    } catch {
      rmSync(directory, { recursive: true, force: true });
      throw new RemotePatchError('无法安全暂存 SSH 私钥，请检查本机临时目录权限。');
    }
    const reference = `ssh-key:${randomUUID()}`;
    const timer = setTimeout(() => release(reference), lifetimeMs);
    timer.unref();
    keys.set(reference, { directory, file, timer });
    return reference;
  }
  function resolve(reference: string): string | undefined { return keys.get(reference)?.file; }
  function retain(reference: string) {
    const entry = keys.get(reference);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }
  function clear() { for (const reference of keys.keys()) release(reference); }
  process.once('exit', clear);
  return { stage, resolve, retain, release, clear };
}
