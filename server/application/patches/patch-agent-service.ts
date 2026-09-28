import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const patchRoles = {
  'plugin-v21-import': ['target'],
  'preset-switch': ['frontend'],
  'api-profiles': ['frontend'],
  'image-router': ['frontend'],
  'read-performance': ['frontend', 'server'],
  'read-cache': ['frontend'],
  'list-cache': ['frontend', 'server'],
} as const;

export type PatchName = keyof typeof patchRoles;
export type PatchRole = 'target' | 'frontend' | 'server';
export type PatchAgentConfig = {
  enabled: boolean;
  roots: readonly string[];
  backupDirectory: string;
  installerPath?: string;
  allowRuntimeRoots?: boolean;
  testMode?: boolean;
};

const ignoredDirectories = new Set(['node_modules', '.git', 'data', 'save', 'backups', 'storage']);

function matchesTarget(patch: PatchName, role: PatchRole, name: string): boolean {
  if (role === 'target') return name === 'plugins.svelte.ts';
  if (role === 'server') return name === 'server.cjs';
  if (patch === 'api-profiles') return /^index(?:[.-][\w-]+)?\.js$/.test(name);
  return /^database(?:\.svelte)?(?:[.-][\w-]+)?\.js$/.test(name);
}

export class PatchAgentError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'PatchAgentError';
  }
}

function isWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function createPatchAgent(config: PatchAgentConfig) {
  let roots = config.roots.map((root) => path.resolve(root));
  const installerPath = config.installerPath ?? path.resolve(process.cwd(), 'patches/risuai/install.mjs');
  let busy = false;
  let preview: { fingerprint: string; expires: number } | null = null;
  const removals = new Map<string, { root: string; id: string; expires: number }>();

  function accessibleRoots(): string[] {
    return roots.flatMap((root) => {
      try {
        const actual = realpathSync(root);
        return lstatSync(actual).isDirectory() ? [actual] : [];
      } catch { return []; }
    });
  }

  function status() {
    const available = accessibleRoots();
    return {
      enabled: config.enabled,
      configured: config.enabled && available.length > 0 && existsSync(installerPath),
      allowedRootCount: available.length,
      patches: Object.keys(patchRoles),
      canChooseRoot: Boolean(config.allowRuntimeRoots),
      testMode: Boolean(config.testMode),
    };
  }

  function setRoots(values: unknown) {
    if (busy) throw new PatchAgentError('操作进行中，不能更换目录。', 409);
    preview = null; removals.clear();
    if (!config.allowRuntimeRoots) throw new PatchAgentError('当前工作台不允许从网页选择本机目录。', 403);
    if (!Array.isArray(values) || values.length < 1 || values.length > 4 || values.some((value) => typeof value !== 'string' || !value.trim())) {
      throw new PatchAgentError('请选择一个有效的 RisuAI 安装目录。');
    }
    roots = values.map((value) => path.resolve(String(value).trim()));
    return status();
  }

  function discover(patchValue: unknown) {
    if (!status().configured) throw new PatchAgentError('网页安装代理尚未配置或缺少补丁脚本。', 503);
    if (typeof patchValue !== 'string' || !Object.hasOwn(patchRoles, patchValue)) throw new PatchAgentError('请选择支持的补丁。');
    const patch = patchValue as PatchName;
    const roles = patchRoles[patch] as readonly PatchRole[];
    const installations: Array<{ root: string; targets: Record<PatchRole, string[]> }> = [];
    for (const root of accessibleRoots()) {
      const targets: Record<PatchRole, string[]> = { target: [], frontend: [], server: [] };
      const queue = [{ dir: root, depth: 0 }];
      let inspected = 0;
      while (queue.length && inspected < 10_000) {
        const current = queue.shift()!;
        let entries;
        try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
        for (const entry of entries) {
          inspected += 1;
          if (inspected > 10_000) break;
          const file = path.join(current.dir, entry.name);
          if (entry.isDirectory() && current.depth < 7 && !ignoredDirectories.has(entry.name)) {
            queue.push({ dir: file, depth: current.depth + 1 });
          } else if (entry.isFile()) {
            for (const role of roles) {
              if (matchesTarget(patch, role, entry.name) && targets[role].length < 20) targets[role].push(file);
            }
          }
        }
      }
      if (roles.some((role) => targets[role].length)) installations.push({ root, targets });
    }
    return { patch, roles, installations };
  }

  function resolveTarget(value: unknown, role: PatchRole): string {
    if (typeof value !== 'string' || !value.trim()) throw new PatchAgentError(`请先选择${role}目标文件。`);
    const candidate = path.resolve(value.trim());
    let stat;
    try {
      stat = lstatSync(candidate);
    } catch {
      throw new PatchAgentError(`${role}目标文件不存在或无法访问。`);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new PatchAgentError(`${role}目标必须是普通文件。`);
    let actual: string;
    try {
      actual = realpathSync(candidate);
    } catch {
      throw new PatchAgentError(`${role}目标文件无法解析。`);
    }
    if (!accessibleRoots().some((root) => isWithin(root, actual))) {
      throw new PatchAgentError(`${role}目标文件不在工作台允许访问的 RisuAI 目录中。`, 403);
    }
    return actual;
  }

  async function run(input: { patch: unknown; apply: boolean; confirm?: unknown; target?: unknown; frontend?: unknown; server?: unknown }) {
    if (!status().configured) throw new PatchAgentError('网页安装代理尚未配置或缺少补丁脚本。', 503);
    if (typeof input.patch !== 'string' || !Object.hasOwn(patchRoles, input.patch)) throw new PatchAgentError('请选择支持的补丁。');
    const patch = input.patch as PatchName;
    const roles = patchRoles[patch] as readonly PatchRole[];
    const args = ['--patch', patch];
    for (const role of ['target', 'frontend', 'server'] as const) {
      const supplied = input[role];
      if (roles.includes(role)) args.push(`--${role}`, resolveTarget(supplied, role));
      else if (supplied != null && supplied !== '') throw new PatchAgentError(`此补丁不需要${role}目标文件。`);
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(args)).update(Buffer.concat(roles.map((role) => readFileSync(resolveTarget(input[role], role))))).digest('hex');
    if (input.apply && (!preview || preview.expires < Date.now() || preview.fingerprint !== fingerprint)) throw new PatchAgentError('目标已变化或预检已过期，请重新预检。', 409);
    preview = null;

    if (input.apply) {
      if (input.confirm !== 'INSTALL') throw new PatchAgentError('请先确认安装操作。', 409);
      const backupDirectory = path.resolve(config.backupDirectory);
      if (accessibleRoots().some((root) => isWithin(root, backupDirectory))) {
        throw new PatchAgentError('备份目录必须位于 RisuAI 目标目录之外。', 500);
      }
      mkdirSync(backupDirectory, { recursive: true });
      if (!existsSync(backupDirectory) || !lstatSync(backupDirectory).isDirectory()) {
        throw new PatchAgentError('无法创建私有备份目录。', 500);
      }
      const actualBackup = realpathSync(backupDirectory);
      if (accessibleRoots().some((root) => isWithin(root, actualBackup))) {
        throw new PatchAgentError('备份目录必须位于 RisuAI 目标目录之外。', 500);
      }
      args.push('--apply', '--backup-dir', actualBackup);
      args.push('--manifest', path.join(actualBackup, '..', 'manifest.json'));
    }

    try {
      const result = await execFileAsync(process.execPath, [installerPath, ...args], {
        cwd: path.dirname(installerPath),
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          Path: process.env.Path,
          SystemRoot: process.env.SystemRoot,
          TEMP: process.env.TEMP,
          TMP: process.env.TMP,
          ELECTRON_RUN_AS_NODE: process.env.WORKBENCH_EMBEDDED === '1' ? '1' : undefined,
        },
      });
      const changed = /:\sready\s/.test(result.stdout);
      if (!input.apply && changed) preview = { fingerprint, expires: Date.now() + 900_000 };
      removals.clear();
      return { ok: true, patch, changed, action: input.apply ? 'installed' : 'preflight', output: result.stdout.trim() };
    } catch (error) {
      const commandError = error as Error & { stdout?: string; stderr?: string };
      throw new PatchAgentError((commandError.stderr || commandError.stdout || commandError.message).trim().slice(0, 4000), 422);
    }
  }

  async function stateCommand(root: string, command: string, id?: string) {
    const args = [path.join(path.dirname(installerPath), 'patch-state.mjs'), command,
      '--manifest', path.resolve(config.backupDirectory, '..', 'manifest.json'), '--root', root];
    if (id) args.push('--id', id);
    try {
      const result = await execFileAsync(process.execPath, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
        env: { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP, ELECTRON_RUN_AS_NODE: process.env.WORKBENCH_EMBEDDED === '1' ? '1' : undefined } });
      const line = result.stdout.split('\n').find((item) => item.startsWith('STATE\t'));
      if (!line) throw new Error('Invalid state response');
      return JSON.parse(line.slice(6));
    } catch (error) { throw new PatchAgentError(((error as { stderr?: string }).stderr || (error as Error).message).slice(0, 2000), 409); }
  }
  async function history(value: unknown) {
    if (!status().configured || typeof value !== 'string' || !accessibleRoots().includes(path.resolve(value))) throw new PatchAgentError('请选择已接入的项目目录。', 403);
    removals.clear();
    const result = await stateCommand(value, 'status');
    result.records = result.records.map((record: { id: string; canRemove: boolean }) => {
      if (!record.canRemove) return record;
      const token = randomUUID(); removals.set(token, { root: value, id: record.id, expires: Date.now() + 300_000 });
      return { ...record, removeToken: token };
    });
    return result;
  }
  async function remove(token: unknown) {
    const plan = typeof token === 'string' ? removals.get(token) : undefined;
    if (!plan || plan.expires < Date.now()) throw new PatchAgentError('卸载确认已过期，请重新核验记录。', 409);
    removals.clear(); preview = null;
    return stateCommand(plan.root, 'remove', plan.id);
  }
  function exclusive<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      if (busy) throw new PatchAgentError('另一个补丁操作正在进行。', 409);
      busy = true; try { return await fn(...args); } finally { busy = false; }
    };
  }
  return { status, setRoots, discover, run: exclusive(run), history: exclusive(history), remove: exclusive(remove) };
}
