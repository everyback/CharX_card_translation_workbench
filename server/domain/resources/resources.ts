import { createHash } from 'node:crypto';
import path from 'node:path';
import { strToU8 } from 'fflate';
import { applyApprovedSegments, isLikelyTranslatableText, type ApplicableSegment, type ScannedSegment } from '../card/card.js';
import { readCharxEntries, readCharxEntry, writeCharxEntries } from '../card/charx.js';
import {
  readRisuModuleAsset,
  readRisuModuleAssets,
  replaceRisuModuleAssets,
  visitRisuModuleAssets,
  type RisuModuleSourceReader,
} from '../card/risum.js';

export type ResourceKind = 'image' | 'audio' | 'video' | 'font' | 'data' | 'other';
export type ResourceTextRisk = 'none' | 'path' | 'unknown';

export type ResourceOcrStatus = 'draft' | 'confirmed';

export interface ResourceOcrCandidate {
  text: string;
  confidence: number | null;
  engine: string;
  status: ResourceOcrStatus;
  updatedAt: string;
}

export interface ResourceImageCandidate {
  mimeType: string;
  model: string;
  prompt: string;
  status: ResourceOcrStatus;
  updatedAt: string;
}

export interface ResourceReference {
  pathLabel: string;
  sample: string;
}

export interface ResourceItem {
  path: string;
  displayName: string;
  kind: ResourceKind;
  mimeType: string;
  detectedFormat: string;
  declaredType: string | null;
  embeddedIndex: number | null;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  textRisk: ResourceTextRisk;
  languageHint: string | null;
  references: ResourceReference[];
  previewable: boolean;
  ocrCandidate?: ResourceOcrCandidate;
  imageCandidate?: ResourceImageCandidate;
}

export interface ResourceInspection {
  sourceFormat: string;
  sourceFilename: string | null;
  resources: ResourceItem[];
  summary: {
    total: number;
    images: number;
    suspectedText: number;
    referenced: number;
  };
}

export function scanCharxResourceJson(source: Uint8Array, enabled: boolean): ScannedSegment[] {
  if (!enabled) return [];
  const segments: ScannedSegment[] = [];
  const archive = readCharxEntries(source);
  for (const [entryPath, bytes] of Object.entries(archive)) {
    if (entryPath === 'card.json' || path.extname(entryPath).toLowerCase() !== '.json') continue;
    let document: unknown;
    try {
      document = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/u, ''));
    } catch {
      continue;
    }
    visitJson(document, ['$resource', entryPath], entryPath, segments);
  }
  return segments;
}

export function applyApprovedResourceJson(source: Uint8Array, segments: ApplicableSegment[]): Buffer {
  const archive = readCharxEntries(source);
  const updates: Record<string, Uint8Array> = {};
  const grouped = new Map<string, ApplicableSegment[]>();
  for (const segment of segments) {
    if (segment.reviewStatus !== 'approved') continue;
    const pathValue = JSON.parse(segment.pathJson) as Array<string | number>;
    if (pathValue[0] !== '$resource' || typeof pathValue[1] !== 'string') continue;
    const group = grouped.get(pathValue[1]) ?? [];
    group.push({ ...segment, pathJson: JSON.stringify(pathValue.slice(2)) });
    grouped.set(pathValue[1], group);
  }
  for (const [entryPath, group] of grouped) {
    const bytes = archive[entryPath];
    if (!bytes) continue;
    let document: unknown;
    try {
      document = JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/u, ''));
    } catch {
      continue;
    }
    if (!document || typeof document !== 'object') continue;
    const draft = applyApprovedSegments(document as Record<string, unknown>, group);
    updates[entryPath] = strToU8(JSON.stringify(draft, null, 2));
  }
  return writeCharxEntries(source, updates);
}

export function inspectCharxResources(
  source: Uint8Array,
  card: Record<string, unknown>,
  module: Record<string, unknown> | null,
  sourceFilename: string | null,
): ResourceInspection {
  const archive = readCharxEntries(source);
  const searchable = [
    { value: card, pathLabel: '卡片 JSON' },
    ...(module ? [{ value: module, pathLabel: 'Risu 模块' }] : []),
  ];
  const resources = Object.entries(archive)
    .filter(([entryPath]) => !entryPath.endsWith('/') && isResourcePath(entryPath))
    .filter(([entryPath]) => entryPath !== 'card.json' && entryPath !== 'module.risum')
    .map(([entryPath, bytes]) => createResource(entryPath, bytes, searchable));
  if (module && archive['module.risum'] && readRisuModuleAssets(archive['module.risum']).length > 0) {
    const moduleResources = inspectRisuModuleResources(module, sourceFilename, readRisuModuleAssets(archive['module.risum'])).resources;
    resources.push(...moduleResources);
  }
  return summarize('charx', sourceFilename, resources);
}

export function inspectRisuModuleResources(
  module: Record<string, unknown>,
  sourceFilename: string | null,
  assets: Uint8Array[] = [],
): ResourceInspection {
  const resources: ResourceItem[] = [];
  const descriptors = collectModuleAssetDescriptors(module);
  const moduleAssetCount = assets.length > 0 ? assets.length : descriptors.length;
  for (let index = 0; index < moduleAssetCount; index += 1) {
    const descriptor = descriptors[index];
    const assetPath = assets[index] ? `module-assets/${index + 1}.bin` : descriptor?.name || `模块资源 ${index + 1}`;
    resources.push(createResourceFromBytes(assetPath, assets[index] ?? new Uint8Array(), [{
      value: module,
      pathLabel: 'Risu 模块',
    }], assets[index] ? 'Risu 模块资源' : null, {
      displayName: descriptor?.name || inferredAssetName(index, assets[index]),
      declaredType: descriptor?.type || null,
      embeddedIndex: assets[index] ? index + 1 : null,
    }));
  }
  return summarize('risum', sourceFilename, resources);
}

export async function inspectRisuModuleResourcesStreaming(
  module: Record<string, unknown>,
  sourceFilename: string | null,
  source: RisuModuleSourceReader,
): Promise<ResourceInspection> {
  const resources: ResourceItem[] = [];
  const descriptors = collectModuleAssetDescriptors(module);
  const referenceIndex = createReferenceIndex([{ value: module, pathLabel: 'Risu 模块' }]);
  await visitRisuModuleAssets(source, async (asset) => {
    const descriptor = descriptors[asset.index];
    const assetPath = `module-assets/${asset.index + 1}.bin`;
    const hash = createHash('sha256');
    const prefixParts: Uint8Array[] = [];
    let prefixLength = 0;
    const prefixLimit = 64 * 1024;
    const chunkSize = 4 * 1024 * 1024;
    for (let offset = 0; offset < asset.length; offset += chunkSize) {
      const chunk = await asset.read(offset, Math.min(chunkSize, asset.length - offset));
      hash.update(chunk);
      if (prefixLength < prefixLimit) {
        const part = chunk.subarray(0, Math.min(chunk.length, prefixLimit - prefixLength));
        prefixParts.push(part);
        prefixLength += part.length;
      }
    }
    const prefix = Buffer.concat(prefixParts, prefixLength);
    resources.push(createResourceFromBytes(assetPath, prefix, [], 'Risu 模块资源', {
      displayName: descriptor?.name || inferredAssetName(asset.index, prefix),
      declaredType: descriptor?.type || null,
      embeddedIndex: asset.index + 1,
    }, {
      size: asset.length,
      sha256: hash.digest('hex'),
      referenceIndex,
    }));
  });
  return summarize('risum', sourceFilename, resources);
}

export function resourceContentType(entryPath: string, bytes?: Uint8Array): string {
  return mimeTypeFor(entryPath, bytes);
}

export function readResourceBytes(sourceFormat: string, source: Uint8Array, entryPath: string): Buffer {
  if (sourceFormat === 'risum') {
    const match = entryPath.match(/^module-assets\/(\d+)\.bin$/u);
    const asset = match ? readRisuModuleAsset(source, Number(match[1]) - 1) : undefined;
    if (!asset) throw new Error('RISUM 中不存在该模块资源。');
    return Buffer.from(asset);
  }
  if (sourceFormat === 'charx' && entryPath.startsWith('module-assets/')) {
    const moduleBytes = readCharxEntry(source, 'module.risum');
    const match = entryPath.match(/^module-assets\/(\d+)\.bin$/u);
    const asset = match ? readRisuModuleAsset(moduleBytes, Number(match[1]) - 1) : undefined;
    if (!asset) throw new Error('CHARX 内嵌模块中不存在该资源。');
    return Buffer.from(asset);
  }
  if (sourceFormat === 'charx') return readCharxEntry(source, entryPath);
  throw new Error('当前格式没有可直接读取的资源文件。');
}

export function replaceResourceBytes(sourceFormat: string, source: Uint8Array, entryPath: string, replacement: Uint8Array): Buffer {
  if (sourceFormat === 'risum') {
    const match = entryPath.match(/^module-assets\/(\d+)\.bin$/u);
    if (!match) throw new Error('RISUM 资源路径无效。');
    return replaceRisuModuleAssets(source, { [Number(match[1]) - 1]: replacement });
  }
  if (sourceFormat === 'charx' && entryPath.startsWith('module-assets/')) {
    const match = entryPath.match(/^module-assets\/(\d+)\.bin$/u);
    if (!match) throw new Error('CHARX 内嵌模块资源路径无效。');
    const moduleBytes = readCharxEntry(source, 'module.risum');
    return writeCharxEntries(source, { 'module.risum': replaceRisuModuleAssets(moduleBytes, { [Number(match[1]) - 1]: replacement }) });
  }
  if (sourceFormat === 'charx') return writeCharxEntries(source, { [entryPath]: replacement });
  throw new Error('当前格式无法替换资源文件。');
}

function createResource(
  entryPath: string,
  bytes: Uint8Array,
  searchable: Array<{ value: unknown; pathLabel: string }>,
): ResourceItem {
  return createResourceFromBytes(entryPath, bytes, searchable);
}

function createResourceFromBytes(
  entryPath: string,
  bytes: Uint8Array,
  searchable: Array<{ value: unknown; pathLabel: string }>,
  referencePathLabel?: string | null,
  identity: { displayName?: string; declaredType?: string | null; embeddedIndex?: number | null } = {},
  metadata: { size?: number; sha256?: string; referenceIndex?: ReferenceIndex } = {},
): ResourceItem {
  const displayName = identity.displayName || entryPath;
  const referenceIndex = metadata.referenceIndex ?? createReferenceIndex(searchable);
  const references = referenceIndex
    .flatMap(({ strings, pathLabel }) => findReferencesInStrings(strings, displayName, pathLabel))
    .filter((reference, index, all) => all.findIndex((candidate) => candidate.pathLabel === reference.pathLabel) === index)
    .slice(0, 20);
  if (referencePathLabel) references.push({ pathLabel: referencePathLabel, sample: entryPath });
  const detected = detectResourceType(entryPath, bytes);
  const kind = detected.kind;
  const hint = languageHint(displayName);
  const mimeType = detected.mimeType;
  return {
    path: entryPath,
    displayName,
    kind,
    mimeType,
    detectedFormat: detected.format,
    declaredType: identity.declaredType ?? null,
    embeddedIndex: identity.embeddedIndex ?? null,
    size: metadata.size ?? bytes.length,
    sha256: metadata.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
    ...imageDimensions(bytes, entryPath),
    textRisk: hint ? 'path' : kind === 'image' ? 'unknown' : 'none',
    languageHint: hint,
    references,
    previewable: kind === 'image' || kind === 'audio' || kind === 'video',
  };
}

function visitJson(
  value: unknown,
  pathValue: Array<string | number>,
  entryPath: string,
  output: ScannedSegment[],
): void {
  if (typeof value === 'string') {
    if (!resourceJsonTextNeedsTranslation(value, pathValue)) return;
    output.push({
      path: pathValue,
      pathLabel: `资源 JSON · ${entryPath} · ${pathValue.slice(2).join('.') || '根值'}`,
      category: 'resource-json',
      sourceText: value,
      start: null,
      end: null,
      risk: 'medium',
      kind: 'resource-json',
    });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => visitJson(child, [...pathValue, index], entryPath, output));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (isProtectedResourceJsonKey(key)) continue;
    visitJson(child, [...pathValue, key], entryPath, output);
  }
}

function resourceJsonTextNeedsTranslation(value: string, pathValue: Array<string | number>): boolean {
  const last = pathValue.at(-1);
  const key = String(typeof last === 'number' ? pathValue.at(-2) ?? '' : last ?? '').toLowerCase();
  if (isProtectedResourceJsonKey(key) || /(?:^|[./_-])(?:id|key|code|type|enum|state|mode|value|class|style|path|file|asset|url|src|href|regex|pattern)(?:$|[./_-])/iu.test(key)) return false;
  if (/^(?:https?:|data:|embeded?:\/\/|[\w./ -]+\.(?:png|jpe?g|webp|gif|svg|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf))$/iu.test(value.trim())) return false;
  if (/[{}<>]/u.test(value) && !/[\uac00-\ud7af\u3040-\u30ff]/u.test(value)) return false;
  return isLikelyTranslatableText(value);
}

function isProtectedResourceJsonKey(key: string): boolean {
  return /^(?:id|uuid|guid|key|code|type|enum|state|mode|class|className|style|path|file|filename|asset|url|src|href|regex|pattern|script|lua|css|html|version|hash|sha|mime|extension)$/iu.test(key);
}

function summarize(sourceFormat: string, sourceFilename: string | null, resources: ResourceItem[]): ResourceInspection {
  return {
    sourceFormat,
    sourceFilename,
    resources: resources.sort((left, right) => left.path.localeCompare(right.path, 'zh-CN')),
    summary: {
      total: resources.length,
      images: resources.filter((resource) => resource.kind === 'image').length,
      suspectedText: resources.filter((resource) => resource.textRisk !== 'none').length,
      referenced: resources.filter((resource) => resource.references.length > 0).length,
    },
  };
}

function isResourcePath(entryPath: string): boolean {
  const extension = path.extname(entryPath).toLowerCase();
  return new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg', '.avif',
    '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.webm', '.mov',
    '.woff', '.woff2', '.ttf', '.otf', '.json', '.yaml', '.yml', '.txt', '.lua',
  ]).has(extension);
}

function resourceKind(entryPath: string, bytes?: Uint8Array): ResourceKind {
  return detectResourceType(entryPath, bytes).kind;
}

function detectResourceType(entryPath: string, bytes?: Uint8Array): { kind: ResourceKind; mimeType: string; format: string } {
  const extension = path.extname(entryPath).toLowerCase();
  const signature = detectSignature(bytes);
  if (signature) return signature;
  const mimeType = mimeTypeForExtension(extension);
  if (mimeType.startsWith('image/')) return { kind: 'image', mimeType, format: extension.slice(1).toUpperCase() || 'IMAGE' };
  if (mimeType.startsWith('audio/')) return { kind: 'audio', mimeType, format: extension.slice(1).toUpperCase() || 'AUDIO' };
  if (mimeType.startsWith('video/')) return { kind: 'video', mimeType, format: extension.slice(1).toUpperCase() || 'VIDEO' };
  if (mimeType.startsWith('font/')) return { kind: 'font', mimeType, format: extension.slice(1).toUpperCase() || 'FONT' };
  if (mimeType !== 'application/octet-stream') return { kind: 'data', mimeType, format: extension.slice(1).toUpperCase() || 'DATA' };
  return { kind: 'other', mimeType, format: '未知二进制' };
}

function mimeTypeFor(entryPath: string, bytes?: Uint8Array): string {
  return detectResourceType(entryPath, bytes).mimeType;
}

function mimeTypeForExtension(extension: string): string {
  const types: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.json': 'application/json',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.txt': 'text/plain', '.lua': 'text/plain',
  };
  return types[extension] ?? 'application/octet-stream';
}

function detectSignature(bytes?: Uint8Array): { kind: ResourceKind; mimeType: string; format: string } | null {
  if (!bytes?.length) return null;
  const ascii = (start: number, length: number) => Buffer.from(bytes.subarray(start, start + length)).toString('ascii');
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return { kind: 'image', mimeType: 'image/png', format: 'PNG' };
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: 'image', mimeType: 'image/jpeg', format: 'JPEG' };
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return { kind: 'image', mimeType: 'image/webp', format: 'WebP' };
  if (bytes.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return { kind: 'image', mimeType: 'image/gif', format: 'GIF' };
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp' && /avif|avis/u.test(ascii(8, 8))) return { kind: 'image', mimeType: 'image/avif', format: 'AVIF' };
  if (bytes.length >= 2 && ascii(0, 2) === 'BM') return { kind: 'image', mimeType: 'image/bmp', format: 'BMP' };
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { kind: 'audio', mimeType: 'audio/wav', format: 'WAV' };
  if (bytes.length >= 4 && ascii(0, 4) === 'OggS') return { kind: 'audio', mimeType: 'audio/ogg', format: 'Ogg' };
  if (bytes.length >= 3 && ascii(0, 3) === 'ID3') return { kind: 'audio', mimeType: 'audio/mpeg', format: 'MP3' };
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: 'video', mimeType: 'video/webm', format: 'WebM' };
  if (bytes.length >= 12 && ascii(4, 4) === 'ftyp') return { kind: 'video', mimeType: 'video/mp4', format: 'MP4/M4A' };
  if (bytes.length >= 4 && ascii(0, 4) === 'wOFF') return { kind: 'font', mimeType: 'font/woff', format: 'WOFF' };
  if (bytes.length >= 4 && ascii(0, 4) === 'wOF2') return { kind: 'font', mimeType: 'font/woff2', format: 'WOFF2' };
  if (bytes.length >= 4 && bytes[0] === 0x00 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return { kind: 'font', mimeType: 'font/ttf', format: 'TTF' };
  if (bytes.length >= 4 && ascii(0, 4) === 'OTTO') return { kind: 'font', mimeType: 'font/otf', format: 'OTF' };
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2])) return { kind: 'data', mimeType: 'application/zip', format: 'ZIP' };
  const prefix = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 512))).toString('utf8').replace(/^\uFEFF/u, '').trimStart();
  if (prefix.startsWith('{') || prefix.startsWith('[')) return { kind: 'data', mimeType: 'application/json', format: 'JSON' };
  if (/^(?:<!doctype\s+html|<html|<svg)/iu.test(prefix)) return { kind: prefix.startsWith('<svg') ? 'image' : 'data', mimeType: prefix.startsWith('<svg') ? 'image/svg+xml' : 'text/html', format: prefix.startsWith('<svg') ? 'SVG' : 'HTML' };
  return null;
}

function collectModuleAssetDescriptors(value: unknown): Array<{ name: string; type: string | null }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const assets = (value as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return collectAssetNames(value).map((name) => ({ name, type: null }));
  return assets.map((entry, index) => {
    if (Array.isArray(entry)) {
      const name = typeof entry[0] === 'string' && entry[0].trim() ? entry[0].trim() : `模块资源 ${index + 1}`;
      const type = typeof entry[2] === 'string' && entry[2].trim() ? entry[2].trim() : null;
      return { name, type };
    }
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const name = [record.name, record.filename, record.path].find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
      const type = [record.type, record.mime, record.extension].find((candidate) => typeof candidate === 'string' && candidate.trim()) as string | undefined;
      return { name: name?.trim() || `模块资源 ${index + 1}`, type: type?.trim() || null };
    }
    return { name: `模块资源 ${index + 1}`, type: null };
  });
}

function inferredAssetName(index: number, bytes?: Uint8Array): string {
  const detected = detectSignature(bytes);
  const extensions: Record<string, string> = {
    PNG: 'png', JPEG: 'jpg', WebP: 'webp', GIF: 'gif', AVIF: 'avif', BMP: 'bmp', SVG: 'svg',
    WAV: 'wav', Ogg: 'ogg', MP3: 'mp3', WebM: 'webm', WOFF: 'woff', WOFF2: 'woff2', TTF: 'ttf', OTF: 'otf', ZIP: 'zip', JSON: 'json', HTML: 'html',
  };
  const extension = detected ? extensions[detected.format] : null;
  return `模块资源 ${index + 1}${extension ? `.${extension}` : ''}`;
}

function languageHint(value: string): string | null {
  if (/[가-힯ᄀ-ᇿ㄰-㆏]/u.test(value)) return 'ko';
  if (/[぀-ヿ]/u.test(value)) return 'ja';
  if (/[一-鿿]/u.test(value)) return 'zh';
  return null;
}

interface ReferenceIndexEntry {
  strings: string[];
  pathLabel: string;
}

type ReferenceIndex = ReferenceIndexEntry[];

function createReferenceIndex(searchable: Array<{ value: unknown; pathLabel: string }>): ReferenceIndex {
  return searchable.map(({ value, pathLabel }) => ({ strings: flattenStrings(value), pathLabel }));
}

function findReferencesInStrings(strings: string[], entryPath: string, pathLabel: string): ResourceReference[] {
  const candidates = [entryPath, path.basename(entryPath), path.basename(entryPath, path.extname(entryPath))]
    .filter((candidate, index, all) => candidate && all.indexOf(candidate) === index);
  const references: ResourceReference[] = [];
  for (const candidate of candidates) {
    const text = strings.find((value) => value.includes(candidate));
    if (!text) continue;
    const index = text.indexOf(candidate);
    references.push({ pathLabel, sample: text.slice(Math.max(0, index - 40), index + candidate.length + 80) });
  }
  return references;
}

function flattenStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => flattenStrings(entry, output));
  else if (value && typeof value === 'object') Object.values(value).forEach((entry) => flattenStrings(entry, output));
  return output;
}

function collectAssetNames(value: unknown): string[] {
  return [...new Set(flattenStrings(value).flatMap((text) => text.match(/[\p{L}\p{N}_./ -]+\.(?:png|jpe?g|webp|gif|svg|mp3|wav|ogg|mp4|webm|woff2?|ttf|otf)/giu) ?? []))];
}

function imageDimensions(bytes: Uint8Array, entryPath: string): { width: number | null; height: number | null } {
  const detected = detectSignature(bytes);
  const extension = detected?.format === 'JPEG' ? '.jpg'
    : detected?.format === 'GIF' ? '.gif'
      : detected?.format === 'WebP' ? '.webp'
        : path.extname(entryPath).toLowerCase();
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (['.jpg', '.jpeg'].includes(extension)) return jpegDimensions(bytes);
  if (extension === '.gif' && bytes.length >= 10) {
    return { width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  if (extension === '.webp' && bytes.length >= 30) return webpDimensions(bytes);
  return { width: null, height: null };
}

function webpDimensions(bytes: Uint8Array): { width: number | null; height: number | null } {
  const chunk = Buffer.from(bytes.subarray(12, 16)).toString('ascii');
  if (chunk === 'VP8X' && bytes.length >= 30) {
    const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
    const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
    return { width, height };
  }
  if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ' && bytes.length >= 30) {
    for (let index = 20; index + 9 < Math.min(bytes.length, 64); index += 1) {
      if (bytes[index] === 0x9d && bytes[index + 1] === 0x01 && bytes[index + 2] === 0x2a) {
        return {
          width: (bytes[index + 3] | (bytes[index + 4] << 8)) & 0x3fff,
          height: (bytes[index + 5] | (bytes[index + 6] << 8)) & 0x3fff,
        };
      }
    }
  }
  return { width: null, height: null };
}

function jpegDimensions(bytes: Uint8Array): { width: number | null; height: number | null } {
  for (let index = 2; index + 9 < bytes.length;) {
    if (bytes[index] !== 0xff) { index += 1; continue; }
    const marker = bytes[index + 1];
    const length = (bytes[index + 2] << 8) | bytes[index + 3];
    if (length < 2 || index + 2 + length > bytes.length) break;
    if (marker >= 0xc0 && marker <= 0xc3) {
      return { height: (bytes[index + 5] << 8) | bytes[index + 6], width: (bytes[index + 7] << 8) | bytes[index + 8] };
    }
    index += 2 + length;
  }
  return { width: null, height: null };
}
