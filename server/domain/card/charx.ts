import { strFromU8, strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from 'fflate';
import { parseRisuModule, writeRisuModule } from './risum.js';

export interface ParsedCharx {
  card: Record<string, unknown>;
  module: Record<string, unknown> | null;
  assetCount: number;
  hybrid: boolean;
}

export type CharxEntryCategory = 'card' | 'module' | 'asset' | 'metadata' | 'other';

export interface CharxEntryInfo {
  path: string;
  size: number;
  category: CharxEntryCategory;
}

export interface CharxInspection {
  cardName: string;
  spec: string;
  hybrid: boolean;
  fileCount: number;
  totalBytes: number;
  cardLorebookEntries: number;
  modulePresent: boolean;
  moduleName: string | null;
  moduleLorebookEntries: number;
  moduleAssetCount: number;
  entries: CharxEntryInfo[];
}

export interface CharxCover {
  path: string;
  bytes: Buffer;
  mimeType: string;
}

interface CharxArchive {
  files: Unzipped;
  prefix: Uint8Array;
}

export function parseCharx(source: Uint8Array): ParsedCharx {
  const archive = readCharxArchive(source);
  const cardBytes = archive.files['card.json'];
  return {
    card: parseCardJson(cardBytes),
    module: archive.files['module.risum'] ? parseRisuModule(archive.files['module.risum']).module : null,
    assetCount: Object.keys(archive.files).filter((name) => name !== 'card.json' && !name.endsWith('/')).length,
    hybrid: archive.prefix.length > 0,
  };
}

export function inspectCharx(source: Uint8Array): CharxInspection {
  const archive = readCharxArchive(source);
  const card = parseCardJson(archive.files['card.json']);
  const parsedModule = archive.files['module.risum'] ? parseRisuModule(archive.files['module.risum']) : null;
  const entries = Object.entries(archive.files)
    .filter(([name]) => !name.endsWith('/'))
    .map(([entryPath, data]) => ({
      path: entryPath,
      size: data.length,
      category: entryCategory(entryPath),
    }))
    .sort((left, right) => categoryOrder(left.category) - categoryOrder(right.category)
      || left.path.localeCompare(right.path, 'zh-CN'));
  const cardData = isRecord(card.data) ? card.data : null;
  const module = parsedModule?.module ?? null;
  return {
    cardName: stringValue(cardData?.name) ?? stringValue(card.name) ?? '未命名角色卡',
    spec: stringValue(card.spec) ?? stringValue(card.spec_version) ?? '未知',
    hybrid: archive.prefix.length > 0,
    fileCount: entries.length,
    totalBytes: entries.reduce((total, entry) => total + entry.size, 0),
    cardLorebookEntries: characterBookEntries(card)?.length ?? 0,
    modulePresent: Boolean(module),
    moduleName: module ? stringValue(module.name) : null,
    moduleLorebookEntries: module && Array.isArray(module.lorebook) ? module.lorebook.filter(isRecord).length : 0,
    moduleAssetCount: parsedModule?.assetCount ?? 0,
    entries,
  };
}

export function readCharxEntry(source: Uint8Array, entryPath: string): Buffer {
  const archive = readCharxArchive(source);
  const data = archive.files[entryPath];
  if (!data || entryPath.endsWith('/')) throw new Error(`CHARX 中不存在文件：${entryPath}`);
  return Buffer.from(data);
}

/**
 * Read every logical file from a CHARX archive, including JPEG+CHARX hybrids.
 * Resource inspection and other read-only consumers should use this instead
 * of calling fflate directly so carrier handling stays consistent.
 */
export function readCharxEntries(source: Uint8Array): Record<string, Uint8Array> {
  return readCharxArchive(source).files;
}

export function findCharxCover(source: Uint8Array): CharxCover | null {
  const archive = readCharxArchive(source);
  const card = parseCardJson(archive.files['card.json']);
  const imagePaths = Object.keys(archive.files)
    .filter((entryPath) => !entryPath.endsWith('/') && Boolean(imageMimeType(entryPath, archive.files[entryPath])))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  if (!imagePaths.length) return null;

  const declared = [valueAtPath(card, ['data', 'avatar']), valueAtPath(card, ['avatar'])]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const declaredPath = declared
    .map((value) => resolveArchivePath(value, imagePaths))
    .find((entryPath): entryPath is string => Boolean(entryPath));
  const preferredPath = imagePaths
    .map((entryPath) => ({ entryPath, score: coverNameScore(entryPath) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.entryPath.localeCompare(right.entryPath, 'zh-CN'))[0]?.entryPath;
  const path = declaredPath || preferredPath;
  if (!path) return null;
  const bytes = Buffer.from(archive.files[path]);
  return { path, bytes, mimeType: imageMimeType(path, bytes) };
}

export function writeCharxEntries(source: Uint8Array, updates: Record<string, Uint8Array>): Buffer {
  const archive = readCharxArchive(source);
  const files: Zippable = {};
  for (const [name, data] of Object.entries(archive.files)) {
    files[name] = [updates[name] ?? data, { level: name === 'card.json' ? 6 : 0 }];
  }
  const zipped = zipSync(files);
  if (!archive.prefix.length) return Buffer.from(zipped);
  const output = Buffer.allocUnsafe(archive.prefix.length + zipped.length);
  output.set(archive.prefix, 0);
  output.set(zipped, archive.prefix.length);
  return output;
}

export function packCharxEntries(source: Uint8Array): Buffer {
  const archive = readCharxArchive(source);
  const files: Zippable = {};
  for (const [name, data] of Object.entries(archive.files)) files[name] = [data, { level: 0 }];
  return Buffer.from(zipSync(files));
}

export function writeCardCharx(
  source: Uint8Array,
  card: Record<string, unknown>,
  module?: Record<string, unknown> | null,
): Buffer {
  const archive = readCharxArchive(source);
  const cardJson = strToU8(JSON.stringify(card, null, 2));
  if (module && !archive.files['module.risum']) throw new Error('CHARX 根目录缺少 module.risum，无法写入模块译文。');
  const files: Zippable = {};
  for (const [name, data] of Object.entries(archive.files)) {
    if (name === 'card.json') files[name] = [cardJson, { level: 6 }];
    else if (name === 'module.risum' && module) files[name] = [writeRisuModule(data, module), { level: 0 }];
    else files[name] = [data, { level: 0 }];
  }
  const zipped = zipSync(files);
  if (!archive.prefix.length) return Buffer.from(zipped);

  const output = Buffer.allocUnsafe(archive.prefix.length + zipped.length);
  output.set(archive.prefix, 0);
  output.set(zipped, archive.prefix.length);
  return output;
}

export function synchronizeRisuModuleLorebook(
  card: Record<string, unknown>,
  module: Record<string, unknown>,
): Record<string, unknown> {
  const entries = characterBookEntries(card);
  if (!entries) return structuredClone(module);

  const synchronized = structuredClone(module);
  const existingLorebook = Array.isArray(module.lorebook) ? module.lorebook : [];
  synchronized.lorebook = entries.map((entry, index) => convertLoreEntry(entry, existingLorebook[index]));
  return synchronized;
}

export function isRisuModuleLorebookMirrorPath(
  card: Record<string, unknown>,
  path: readonly (string | number)[],
): boolean {
  if (path[0] !== '$module' || path[1] !== 'lorebook') return false;
  const entryIndex = path[2];
  const entries = characterBookEntries(card);
  return typeof entryIndex === 'number'
    && Boolean(entries)
    && entryIndex >= 0
    && entryIndex < entries!.length;
}

function readCharxArchive(source: Uint8Array): CharxArchive {
  const { prefix, zipData } = splitCarrier(source);
  const names = new Set<string>();
  let files: Unzipped;
  try {
    files = unzipSync(zipData, {
      filter(entry) {
        if (!isSafeEntryName(entry.name)) throw new Error(`CHARX 包含不安全路径：${entry.name}`);
        if (names.has(entry.name)) throw new Error(`CHARX 包含重复路径：${entry.name}`);
        names.add(entry.name);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('CHARX ')) throw error;
    throw new Error(`CHARX 压缩包无法读取：${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Object.hasOwn(files, 'card.json')) throw new Error('CHARX 根目录缺少 card.json。');
  return { files, prefix };
}

function splitCarrier(source: Uint8Array): { prefix: Uint8Array; zipData: Uint8Array } {
  if (hasZipHeader(source, 0)) return { prefix: source.subarray(0, 0), zipData: source };
  if (source[0] === 0xff && source[1] === 0xd8) {
    for (let index = 2; index < source.length - 5; index += 1) {
      if (source[index] !== 0xff || source[index + 1] !== 0xd9) continue;
      const zipStart = findZipHeader(source, index + 2);
      if (zipStart >= 0) {
        return { prefix: source.subarray(0, zipStart), zipData: source.subarray(zipStart) };
      }
    }
  }
  throw new Error('文件不是标准 CHARX，也不是可识别的 JPEG+CHARX 混合文件。');
}

function parseCardJson(data: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(strFromU8(data).replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`CHARX 的 card.json 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('CHARX 的 card.json 必须是 JSON 对象。');
  }
  return parsed as Record<string, unknown>;
}

function characterBookEntries(card: Record<string, unknown>): Record<string, unknown>[] | null {
  const data = isRecord(card.data) ? card.data : null;
  const characterBook = data && isRecord(data.character_book) ? data.character_book : null;
  if (!characterBook || !Array.isArray(characterBook.entries)) return null;
  return characterBook.entries.filter(isRecord);
}

function convertLoreEntry(entry: Record<string, unknown>, template: unknown): Record<string, unknown> {
  const keys = stringArray(entry.keys);
  const secondaryKeys = stringArray(entry.secondary_keys);
  const sourceExtensions = isRecord(entry.extensions) ? entry.extensions : {};
  const extensions = structuredClone(sourceExtensions);
  let content = typeof entry.content === 'string' ? entry.content : '';
  let selective = entry.selective === true;

  if (extensions.useProbability && typeof extensions.probability === 'number' && extensions.probability !== 100) {
    content = `@@probability ${extensions.probability}\n${content}`;
    delete extensions.useProbability;
    delete extensions.probability;
  }
  if (extensions.position === 4 && typeof extensions.depth === 'number' && typeof extensions.role === 'number') {
    const role = ['system', 'user', 'assistant'][extensions.role];
    if (role) content = `@@depth ${extensions.depth}\n@@role ${role}\n${content}`;
    delete extensions.position;
    delete extensions.depth;
    delete extensions.role;
  }
  if (typeof extensions.selectiveLogic === 'number' && secondaryKeys.length > 0) {
    switch (extensions.selectiveLogic) {
      case 0:
        if (!secondaryKeys.length) selective = false;
        break;
      case 1:
        selective = false;
        content = `@@exclude_keys_all ${secondaryKeys.join(',')}\n${content}`;
        break;
      case 2:
        selective = false;
        for (const key of secondaryKeys) content = `@@exclude_keys ${key}\n${content}`;
        break;
      case 3:
        selective = false;
        for (const key of secondaryKeys) content = `@@additional_keys ${key}\n${content}`;
        break;
    }
  }
  if (typeof extensions.delay === 'number' && extensions.delay > 0) {
    content = `@@activate_only_after ${extensions.delay}\n${content}`;
    delete extensions.delay;
  }
  if (extensions.match_whole_words === true) {
    content = `@@match_full_word\n${content}`;
    delete extensions.match_whole_words;
  } else if (extensions.match_whole_words === false) {
    content = `@@match_partial_word\n${content}`;
    delete extensions.match_whole_words;
  }

  const existing = isRecord(template) ? template : {};
  const requestedRegex = entry.use_regex === true;
  const converted: Record<string, unknown> = {
    ...existing,
    key: keys.join(', '),
    secondkey: secondaryKeys.join(', '),
    insertorder: entry.insertion_order,
    comment: stringValue(entry.name) ?? stringValue(entry.comment) ?? '',
    content,
    mode: stringValue(entry.mode) ?? 'normal',
    alwaysActive: entry.constant === true,
    selective,
    extentions: { ...extensions },
    loreCache: sourceExtensions.risu_loreCache ?? null,
    useRegex: requestedRegex && Boolean(keys[0]?.startsWith('/')),
  };
  if (entry.case_sensitive !== undefined) {
    (converted.extentions as Record<string, unknown>).risu_case_sensitive = entry.case_sensitive;
  }
  if (sourceExtensions.risu_activationPercent !== undefined) {
    converted.activationPercent = sourceExtensions.risu_activationPercent;
  }
  if (entry.folder !== undefined) converted.folder = entry.folder;
  return converted;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function resolveArchivePath(value: string, imagePaths: string[]): string | null {
  const normalized = value.trim().replace(/^\.\//u, '').replace(/^\/+/, '');
  if (!normalized || normalized.startsWith('data:')) return null;
  const exact = imagePaths.find((entryPath) => entryPath === normalized);
  if (exact) return exact;
  const basename = normalized.split('/').at(-1);
  return basename ? imagePaths.find((entryPath) => entryPath.split('/').at(-1) === basename) ?? null : null;
}

function coverNameScore(entryPath: string): number {
  const name = entryPath.split('/').at(-1)?.toLowerCase() ?? '';
  if (/^(?:avatar|profile|portrait|character|char|icon|cover|thumbnail)(?:[-_.].*)?\.(?:png|jpe?g|webp|gif|bmp|avif)$/u.test(name)) return 100;
  if (/(?:avatar|profile|portrait|character|icon|cover|thumbnail)/u.test(name)) return 50;
  return 0;
}

function imageMimeType(entryPath: string, bytes: Uint8Array): string {
  const ascii = (start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString('ascii');
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp' && /avif|avis/u.test(ascii(8, 8))) return 'image/avif';
  const extension = entryPath.toLowerCase().match(/\.(png|jpe?g|webp|gif|bmp|avif)$/u)?.[1];
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  return extension ? `image/${extension}` : '';
}

function isSafeEntryName(name: string): boolean {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return false;
  return !name.split('/').some((part) => part === '..');
}

function entryCategory(entryPath: string): CharxEntryCategory {
  if (entryPath === 'card.json') return 'card';
  if (entryPath === 'module.risum') return 'module';
  if (entryPath.startsWith('assets/')) return 'asset';
  if (entryPath.endsWith('.json') || entryPath.endsWith('.yaml') || entryPath.endsWith('.yml')) return 'metadata';
  return 'other';
}

function categoryOrder(category: CharxEntryCategory): number {
  return ['card', 'module', 'metadata', 'asset', 'other'].indexOf(category);
}

function findZipHeader(source: Uint8Array, start: number): number {
  for (let index = start; index < source.length - 3; index += 1) {
    if (hasZipHeader(source, index)) return index;
  }
  return -1;
}

function hasZipHeader(source: Uint8Array, offset: number): boolean {
  return source[offset] === 0x50 && source[offset + 1] === 0x4b
    && source[offset + 2] === 0x03 && source[offset + 3] === 0x04;
}
