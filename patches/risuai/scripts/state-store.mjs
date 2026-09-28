import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (value) => createHash('sha256').update(value).digest('hex');
export function within(root, file) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function readState(file) {
  if (!fs.existsSync(file)) return { version: 2, patches: [] };
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Manifest must not be a symlink');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(state.patches)) throw new Error('Invalid patch manifest');
  return state;
}
export function writeState(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function withStateLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch { throw new Error('Another patch operation is active, or a previous operation was interrupted. Inspect the manifest lock before retrying.'); }
  try { return fn(); } finally { fs.rmdirSync(lock); }
}
export function revisionFor(patch, directory) {
  const names = {
    'plugin-v21-import': ['patch-plugin-v21-import.mjs'], 'preset-switch': ['patch-preset-switch.mjs'],
    'api-profiles': ['patch-custom-model-profiles.mjs'], 'image-router': ['patch-image-router.mjs'],
    'read-performance': ['patch-read-batch.mjs', 'patch-read-batch-server.mjs'],
    'read-cache': ['patch-read-cache.mjs', 'patch-read-cache-evict.mjs'],
    'list-cache': ['patch-list-local-cache.mjs', 'patch-list-etag-server.mjs'],
  }[patch];
  if (!names) return '';
  return hash(Buffer.concat(names.map((name) => fs.readFileSync(path.join(directory, name)))));
}
export function entryId(entry) { return entry.id || hash(JSON.stringify(entry)).slice(0, 32); }
function checkedFile(file, root) {
  if (!path.isAbsolute(file) || !within(root, file) || fs.realpathSync(file) !== path.resolve(file) || !fs.lstatSync(file).isFile()) throw new Error('File outside target root or not a regular file');
  return fs.readFileSync(file);
}
export function inspectState(manifestFile, root, scriptDir) {
  root = fs.realpathSync(root);
  const state = readState(manifestFile);
  const entries = state.patches.filter((entry) => Array.isArray(entry.targets) && entry.targets.length && entry.targets.every((target) => typeof target.file === 'string' && within(root, target.file)));
  const dependencies = JSON.parse(fs.readFileSync(path.join(scriptDir, 'dependencies.json'), 'utf8'));
  const records = entries.map((entry, index) => {
    let reason = '';
    if (entry.removedAt) reason = '已卸载';
    else if (entries.slice(index + 1).some((later) => !later.removedAt && later.targets.some((target) => entry.targets.some((own) => own.file === target.file)))) reason = '请先卸载修改同一文件的后续补丁';
    else if (entries.some((other) => !other.removedAt && other !== entry && dependencies[other.patch]?.some((dependency) => dependency.patch === entry.patch))) reason = '仍有已安装补丁依赖此补丁';
    try {
      for (const target of entry.targets) {
        if (hash(checkedFile(target.file, root)) !== target.after && !reason) reason = '目标文件已变化，禁止覆盖';
        if (hash(checkedFile(target.backup, path.dirname(fs.realpathSync(manifestFile)))) !== target.before && !reason) reason = '备份校验失败';
      }
    } catch { if (!reason) reason = '文件或备份缺失、路径不安全'; }
    const availableRevision = revisionFor(entry.patch, scriptDir);
    return { id: entryId(entry), patch: entry.patch, installedAt: entry.installedAt, removedAt: entry.removedAt,
      revision: entry.revision || '', availableRevision, updateAvailable: Boolean(entry.revision && availableRevision !== entry.revision),
      state: entry.removedAt ? 'removed' : reason ? 'blocked' : 'verified', reason, canRemove: !reason,
      targets: entry.targets.map(({ file, before, after, backup }) => ({ file, before, after, backup })) };
  });
  return { target: root, deployment: 'bare', records: records.reverse(), runtimeVerified: false };
}
export function removeEntry(manifestFile, root, id, scriptDir) {
  return withStateLock(manifestFile, () => {
    const record = inspectState(manifestFile, root, scriptDir).records.find((entry) => entry.id === id);
    if (!record?.canRemove) throw new Error(record?.reason || 'Installation record not found for this target');
    const state = readState(manifestFile);
    const entry = state.patches.find((item) => entryId(item) === id);
    const originals = entry.targets.map((target) => ({ target, bytes: fs.readFileSync(target.file) }));
    const restored = [];
    try {
      for (const item of originals) {
        // Check again immediately before writing; never undo an unrecorded edit.
        if (hash(fs.readFileSync(item.target.file)) !== item.target.after) throw new Error('Target changed during restore');
        restored.push(item);
        fs.writeFileSync(item.target.file, fs.readFileSync(item.target.backup));
        if (hash(fs.readFileSync(item.target.file)) !== item.target.before) throw new Error('Restore verification failed');
      }
      entry.removedAt = new Date().toISOString();
      writeState(manifestFile, state);
    } catch (error) {
      for (const item of restored.reverse()) fs.writeFileSync(item.target.file, item.bytes);
      throw error;
    }
    return { removed: true, id, patch: entry.patch };
  });
}
