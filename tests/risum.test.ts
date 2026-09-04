import assert from 'node:assert/strict';
import test from 'node:test';
import { createRisuModule, parseRisuModule, readRisuModuleAsset, readRisuModuleAssetFromReader, readRisuModuleAssets, replaceRisuModuleAssets, writeRisuModule } from '../server/domain/card/risum.js';

const originalModule = {
  name: 'Test module',
  trigger: [{ effect: [{ code: 'alertError(triggerId, "No target")' }] }],
  assets: [['icon', '', 'image/png']],
};

test('RISUM module JSON round-trips through RPack encoding', () => {
  const source = createRisuModule(originalModule);
  assert.deepEqual(parseRisuModule(source), { module: originalModule, assetCount: 0 });
});

test('RISUM rewrite preserves the original encoded asset suffix', () => {
  const source = createRisuModule(originalModule, [new Uint8Array([0, 1, 2, 128, 255])]);
  const sourceSuffix = suffix(source);
  const translated = structuredClone(originalModule);
  translated.trigger[0].effect[0].code = 'alertError(triggerId, "没有目标")';

  const output = writeRisuModule(source, translated);
  assert.deepEqual(parseRisuModule(output), { module: translated, assetCount: 1 });
  assert.deepEqual(suffix(output), sourceSuffix);
});

test('RISUM resource replacement changes only selected asset bytes', () => {
  const source = createRisuModule(originalModule, [new Uint8Array([1, 2]), new Uint8Array([3, 4])]);
  const output = replaceRisuModuleAssets(source, { 1: new Uint8Array([9, 8, 7]) });
  assert.deepEqual(parseRisuModule(output).module, originalModule);
  assert.deepEqual(readRisuModuleAssets(output).map((asset) => [...asset]), [[1, 2], [9, 8, 7]]);
  assert.deepEqual([...readRisuModuleAsset(output, 1)], [9, 8, 7]);
});

test('RISUM reader returns one asset without reading the full container at once', async () => {
  const source = createRisuModule(originalModule, [new Uint8Array(5 * 1024 * 1024).fill(7), new Uint8Array([3, 4])]);
  let largestRead = 0;
  const asset = await readRisuModuleAssetFromReader({
    length: source.length,
    async read(offset, length) {
      largestRead = Math.max(largestRead, length);
      return source.subarray(offset, offset + length);
    },
  }, 1);
  assert.deepEqual([...asset], [3, 4]);
  assert.ok(largestRead <= 4 * 1024 * 1024);
});

test('RISUM rejects malformed containers', () => {
  assert.throws(() => parseRisuModule(new Uint8Array([111, 0, 0, 0, 0, 0])), /过短/);
  const invalid = createRisuModule(originalModule);
  invalid[0] = 0;
  assert.throws(() => parseRisuModule(invalid), /魔数/);
});

test('RISUM accepts more than 512 asset blocks', () => {
  const assets = Array.from({ length: 600 }, (_, index) => new Uint8Array([index % 256]));
  const source = createRisuModule({ name: 'Many assets' }, assets);
  assert.equal(parseRisuModule(source).assetCount, 600);
});

test('RISUM accepts module JSON larger than the former 32 MiB limit', () => {
  const text = 'A'.repeat(32 * 1024 * 1024 + 1024);
  const source = createRisuModule({ name: 'Large module', text });
  assert.equal(parseRisuModule(source).module.text.length, text.length);
});

function suffix(source: Uint8Array): Uint8Array {
  const view = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  return source.subarray(6 + view.readUInt32LE(2));
}
