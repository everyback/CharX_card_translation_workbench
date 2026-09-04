const RISUM_MAGIC = 111;
const RISUM_VERSION = 0;

// RPack byte-substitution table from RisuAI. See THIRD_PARTY_NOTICES.md.
const RPACK_MAP = Buffer.from(
  'xA0eC70rP1X8RW71ZlNPGuC7MJSGumu/QVBvm+/etxBhFyDfMomonW2ryZAADF2v0sFW5RZkkYJldJfKI9ZS0f+0oOgvilg4WmAZlknb18g7PkNLpWNHqmopkvQVz2I0eNMdPOIFjipXDhvNTC3yQCwleUgPsnq1p2w35px7VH7+h9yaAuQzouuxLgPdmaaw59WIGIN89r7hXJ/DIUYfCE7QdhJf7v2PROqjXosoCTWeacwKx4UHrUrzd+ln1NqEgJO2TXP6JyZ/BMb78XI5UcI2qWis+O3FucvOdaQ9gdlCcByVEbzYjJj5WaET9xR9s+xxwOON8AGuWzEGJCI6uCz3hIvJZfu2n66zAy0BaXQf5KPs7lw0IZNKD2riYgKeIpz9PPxxx8atWWcFcG2KRBL6JIZfr9F6R87+UGPdUQZvGOBSqAmdVnNMuFNsw6AOGc8+DX4HMmhG6kj5mS6rpEkgXlU1OAy807FYFnkoChrh8s3EOduiumBydn2V73/IwN43lL+1FIGSJUWs5/Vmpys2WsET40s66I2DG3wnsJpC64eq3FSOeCbSVynUt/gvj4l18EF3wh7/2BUR5QSXF/Mx0JsA18q0Tyo72bJr2l2hPzBhvZE9Tubfvk2CjB0jEJhk9IUze5BDu6mI8dalHPbMbrlbC5bt1enFywimgEA=',
  'base64',
);

if (RPACK_MAP.length !== 512) throw new Error('内置 RPack 映射无效。');
const ENCODE_MAP = RPACK_MAP.subarray(0, 256);
const DECODE_MAP = RPACK_MAP.subarray(256);

export interface ParsedRisuModule {
  module: Record<string, unknown>;
  assetCount: number;
}

export interface RisuModuleSourceReader {
  length: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface RisuModuleAssetReader {
  index: number;
  length: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

interface RisuModuleEnvelope {
  type: 'risuModule';
  module: Record<string, unknown>;
}

interface ParsedContainer extends ParsedRisuModule {
  suffixOffset: number;
}

export function parseRisuModule(source: Uint8Array): ParsedRisuModule {
  const parsed = parseContainer(source);
  return { module: parsed.module, assetCount: parsed.assetCount };
}

export function readRisuModuleAssets(source: Uint8Array): Uint8Array[] {
  const parsed = parseContainer(source);
  return readAssetSuffix(source, parsed.suffixOffset);
}

export function readRisuModuleAsset(source: Uint8Array, assetIndex: number): Uint8Array {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error('RISUM 资源序号无效。');
  const parsed = parseContainer(source);
  let selected: Uint8Array | null = null;
  visitAssetSuffix(source, parsed.suffixOffset, (index, offset, length) => {
    if (index === assetIndex) selected = transform(source.subarray(offset, offset + length), DECODE_MAP);
  });
  if (!selected) throw new Error('RISUM 中不存在该模块资源。');
  return selected;
}

export async function visitRisuModuleAssets(
  source: RisuModuleSourceReader,
  visitor: (asset: RisuModuleAssetReader) => Promise<void> | void,
): Promise<void> {
  const header = await readExact(source, 0, 6);
  if (source.length < 7) throw new Error('RISUM 文件过短。');
  if (header[0] !== RISUM_MAGIC) throw new Error('RISUM 魔数无效。');
  if (header[1] !== RISUM_VERSION) throw new Error(`暂不支持 RISUM 版本 ${header[1]}。`);
  const suffixOffset = Buffer.from(header.buffer, header.byteOffset, header.byteLength).readUInt32LE(2) + 6;
  if (suffixOffset >= source.length) throw new Error('RISUM 模块数据不完整。');

  let offset = suffixOffset;
  let index = 0;
  while (offset < source.length) {
    const marker = (await readExact(source, offset, 1))[0];
    offset += 1;
    if (marker === 0) {
      if (offset !== source.length) throw new Error('RISUM 结束标记后包含多余数据。');
      return;
    }
    if (marker !== 1) throw new Error(`RISUM 资源标记无效：${marker}。`);
    const lengthBytes = await readExact(source, offset, 4);
    const length = Buffer.from(lengthBytes.buffer, lengthBytes.byteOffset, lengthBytes.byteLength).readUInt32LE(0);
    offset += 4;
    if (offset + length > source.length) throw new Error('RISUM 资源数据不完整。');
    const assetOffset = offset;
    await visitor({
      index,
      length,
      read: async (assetReadOffset, assetReadLength) => {
        if (!Number.isInteger(assetReadOffset) || !Number.isInteger(assetReadLength)
          || assetReadOffset < 0 || assetReadLength < 0 || assetReadOffset + assetReadLength > length) {
          throw new Error('RISUM 资源读取范围无效。');
        }
        return transform(await readExact(source, assetOffset + assetReadOffset, assetReadLength), DECODE_MAP);
      },
    });
    offset += length;
    index += 1;
  }
  throw new Error('RISUM 缺少结束标记。');
}

export async function readRisuModuleAssetFromReader(
  source: RisuModuleSourceReader,
  assetIndex: number,
  chunkSize = 4 * 1024 * 1024,
): Promise<Buffer> {
  if (!Number.isInteger(assetIndex) || assetIndex < 0) throw new Error('RISUM 资源序号无效。');
  let output: Buffer | null = null;
  await visitRisuModuleAssets(source, async (asset) => {
    if (asset.index !== assetIndex) return;
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < asset.length; offset += chunkSize) {
      chunks.push(await asset.read(offset, Math.min(chunkSize, asset.length - offset)));
    }
    output = Buffer.concat(chunks, asset.length);
  });
  if (!output) throw new Error('RISUM 中不存在该模块资源。');
  return output;
}

export function writeRisuModule(source: Uint8Array, module: Record<string, unknown>): Buffer {
  const parsed = parseContainer(source);
  const main = encodeEnvelope(module);
  const output = Buffer.allocUnsafe(6 + main.length + source.length - parsed.suffixOffset);
  output[0] = RISUM_MAGIC;
  output[1] = RISUM_VERSION;
  output.writeUInt32LE(main.length, 2);
  output.set(main, 6);
  output.set(source.subarray(parsed.suffixOffset), 6 + main.length);
  return output;
}

export function replaceRisuModuleAssets(source: Uint8Array, replacements: Record<number, Uint8Array>): Buffer {
  const parsed = parseContainer(source);
  const assets = readAssetSuffix(source, parsed.suffixOffset).map((asset, index) => replacements[index] ?? asset);
  return createRisuModule(parsed.module, assets);
}

export function createRisuModule(module: Record<string, unknown>, assets: Uint8Array[] = []): Buffer {
  const main = encodeEnvelope(module);
  const encodedAssets = assets.map((asset) => transform(asset, ENCODE_MAP));
  const size = 6 + main.length + encodedAssets.reduce((total, asset) => total + 5 + asset.length, 0) + 1;
  const output = Buffer.allocUnsafe(size);
  output[0] = RISUM_MAGIC;
  output[1] = RISUM_VERSION;
  output.writeUInt32LE(main.length, 2);
  output.set(main, 6);
  let offset = 6 + main.length;
  for (const asset of encodedAssets) {
    output[offset] = 1;
    output.writeUInt32LE(asset.length, offset + 1);
    output.set(asset, offset + 5);
    offset += asset.length + 5;
  }
  output[offset] = 0;
  return output;
}

function parseContainer(source: Uint8Array): ParsedContainer {
  if (source.length < 7) throw new Error('RISUM 文件过短。');
  if (source[0] !== RISUM_MAGIC) throw new Error('RISUM 魔数无效。');
  if (source[1] !== RISUM_VERSION) throw new Error(`暂不支持 RISUM 版本 ${source[1]}。`);

  const view = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  const mainLength = view.readUInt32LE(2);
  const suffixOffset = 6 + mainLength;
  if (suffixOffset >= source.length) throw new Error('RISUM 模块数据不完整。');

  let envelope: unknown;
  try {
    const decoded = transform(source.subarray(6, suffixOffset), DECODE_MAP);
    envelope = JSON.parse(Buffer.from(decoded).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`RISUM 模块 JSON 无法解析：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(envelope) || envelope.type !== 'risuModule' || !isRecord(envelope.module)) {
    throw new Error('RISUM 主数据不是有效的 risuModule。');
  }

  const assetCount = visitAssetSuffix(source, suffixOffset);
  return { module: envelope.module, assetCount, suffixOffset };
}

function readAssetSuffix(source: Uint8Array, start: number): Uint8Array[] {
  const assets: Uint8Array[] = [];
  visitAssetSuffix(source, start, (_index, offset, length) => {
    assets.push(transform(source.subarray(offset, offset + length), DECODE_MAP));
  });
  return assets;
}

function visitAssetSuffix(
  source: Uint8Array,
  start: number,
  visitor?: (index: number, offset: number, length: number) => void,
): number {
  const view = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  let offset = start;
  let index = 0;
  while (offset < source.length) {
    const marker = source[offset];
    offset += 1;
    if (marker === 0) {
      if (offset !== source.length) throw new Error('RISUM 结束标记后包含多余数据。');
      return index;
    }
    if (marker !== 1) throw new Error(`RISUM 资源标记无效：${marker}。`);
    if (offset + 4 > source.length) throw new Error('RISUM 资源长度字段不完整。');
    const length = view.readUInt32LE(offset);
    offset += 4;
    if (offset + length > source.length) throw new Error('RISUM 资源数据不完整。');
    visitor?.(index, offset, length);
    offset += length;
    index += 1;
  }
  throw new Error('RISUM 缺少结束标记。');
}

async function readExact(source: RisuModuleSourceReader, offset: number, length: number): Promise<Uint8Array> {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > source.length) {
    throw new Error('RISUM 读取范围无效。');
  }
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) throw new Error('RISUM 资源数据不完整。');
  return bytes;
}

function encodeEnvelope(module: Record<string, unknown>): Buffer {
  const envelope: RisuModuleEnvelope = { module, type: 'risuModule' };
  const json = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
  return transform(json, ENCODE_MAP);
}

function transform(source: Uint8Array, map: Uint8Array): Buffer {
  const output = Buffer.allocUnsafe(source.length);
  for (let index = 0; index < source.length; index += 1) output[index] = map[source[index]];
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
