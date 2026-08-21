import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { createRisuModule } from '../server/domain/risum.js';
import { applyApprovedResourceJson, inspectCharxResources, inspectRisuModuleResources, inspectRisuModuleResourcesStreaming, scanCharxResourceJson } from '../server/domain/resources.js';

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test('resource inspection identifies image metadata, language risk, and card/module references', () => {
  const assetPath = 'assets/地图 한국어.png';
  const card = {
    spec: 'chara_card_v3',
    data: { name: 'Mina', description: `<img src="${assetPath}">` },
  };
  const module = { name: 'Panel', trigger: [{ effect: [{ code: `show("${assetPath}")` }] }] };
  const source = zipSync({
    'card.json': strToU8(JSON.stringify(card)),
    'module.risum': createRisuModule(module),
    [assetPath]: png(269, 64),
    'assets/sound.mp3': new Uint8Array([1, 2, 3]),
  });

  const result = inspectCharxResources(source, card, module, 'sample.charx');
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.images, 1);
  assert.equal(result.summary.suspectedText, 1);
  assert.equal(result.summary.referenced, 1);
  const image = result.resources.find((resource) => resource.path === assetPath);
  assert.ok(image);
  assert.equal(image.width, 269);
  assert.equal(image.height, 64);
  assert.equal(image.languageHint, 'ko');
  assert.equal(image.textRisk, 'path');
  assert.equal(image.references.length, 2);
  assert.equal(image.references[0]?.pathLabel, '卡片 JSON');
  assert.equal(result.resources.find((resource) => resource.path.endsWith('sound.mp3'))?.kind, 'audio');
});

test('embedded RISUM assets get stable preview paths', () => {
  const card = { spec: 'chara_card_v3', data: { name: 'Mina' } };
  const module = { name: 'Panel', assets: [['icon', '', 'image/png']] };
  const source = zipSync({
    'card.json': strToU8(JSON.stringify(card)),
    'module.risum': createRisuModule(module, [png(32, 16)]),
  });
  const result = inspectCharxResources(source, card, module, 'sample.charx');
  const asset = result.resources.find((resource) => resource.path === 'module-assets/1.bin');
  assert.ok(asset);
  assert.equal(asset.kind, 'image');
  assert.equal(asset.displayName, 'icon');
  assert.equal(asset.detectedFormat, 'PNG');
  assert.equal(asset.mimeType, 'image/png');
  assert.equal(asset.width, 32);
  assert.equal(asset.height, 16);
});

test('RISUM binary assets use module filenames and file signatures for inspection', () => {
  const webp = new Uint8Array(30);
  webp.set(Buffer.from('RIFF'), 0);
  webp.set(Buffer.from('WEBP'), 8);
  webp.set(Buffer.from('VP8X'), 12);
  webp[24] = 0xff;
  webp[25] = 0x01;
  webp[27] = 0x63;
  const module = { assets: [['elena_curious.webp', '', 'webp']] };

  const result = inspectRisuModuleResources(module, 'elena.risum', [webp]);
  const asset = result.resources[0];
  assert.equal(asset.path, 'module-assets/1.bin');
  assert.equal(asset.displayName, 'elena_curious.webp');
  assert.equal(asset.declaredType, 'webp');
  assert.equal(asset.kind, 'image');
  assert.equal(asset.mimeType, 'image/webp');
  assert.equal(asset.detectedFormat, 'WebP');
  assert.equal(asset.width, 512);
  assert.equal(asset.height, 100);
  assert.equal(asset.previewable, true);
});

test('large RISUM inspection reads asset bytes in bounded chunks', async () => {
  const image = png(1920, 1080);
  const padding = new Uint8Array(10 * 1024 * 1024);
  padding.set(image);
  const module = { assets: [['large-map.png', '', 'image/png']] };
  const source = createRisuModule(module, [padding]);
  let largestRead = 0;

  const result = await inspectRisuModuleResourcesStreaming(module, 'large.risum', {
    length: source.length,
    async read(offset, length) {
      largestRead = Math.max(largestRead, length);
      return source.subarray(offset, offset + length);
    },
  });

  assert.equal(result.resources[0]?.size, padding.length);
  assert.equal(result.resources[0]?.width, 1920);
  assert.equal(result.resources[0]?.height, 1080);
  assert.ok(largestRead <= 4 * 1024 * 1024);
});

test('resource inspection supports JPEG+CHARX hybrid archives', () => {
  const assetPath = 'assets/map.png';
  const card = { spec: 'chara_card_v3', data: { name: 'Hybrid' } };
  const archive = zipSync({
    'card.json': strToU8(JSON.stringify(card)),
    [assetPath]: png(640, 360),
  });
  const jpegPrefix = new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  const source = new Uint8Array(jpegPrefix.length + archive.length);
  source.set(jpegPrefix, 0);
  source.set(archive, jpegPrefix.length);

  const result = inspectCharxResources(source, card, null, 'hybrid.charx');
  assert.equal(result.summary.total, 1);
  assert.equal(result.resources[0]?.path, assetPath);
  assert.equal(result.resources[0]?.width, 640);
  assert.equal(result.resources[0]?.height, 360);
});

test('all scope extracts visible JSON resource strings and preserves keys', () => {
  const source = zipSync({
    'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Hybrid' } })),
    'assets/ui.json': strToU8(JSON.stringify({
      id: 'start_button',
      label: '시작',
      description: '새로운 모험을 시작하세요',
      asset_path: 'assets/ui/main.png',
    })),
  });
  const segments = scanCharxResourceJson(source, true);
  assert.deepEqual(segments.map((segment) => segment.path), [
    ['$resource', 'assets/ui.json', 'label'],
    ['$resource', 'assets/ui.json', 'description'],
  ]);
  assert.equal(segments.every((segment) => segment.kind === 'resource-json'), true);

  const updated = applyApprovedResourceJson(source, segments.map((segment, index) => ({
    pathJson: JSON.stringify(segment.path),
    sourceText: segment.sourceText,
    start: null,
    end: null,
    translatedText: index === 0 ? '开始' : '请开始新的冒险',
    finalText: null,
    reviewStatus: 'approved',
    kind: segment.kind,
  })));
  const updatedArchive = unzipSync(updated);
  const updatedJson = JSON.parse(strFromU8(updatedArchive['assets/ui.json'])) as Record<string, unknown>;
  assert.deepEqual(updatedJson, {
    id: 'start_button',
    label: '开始',
    description: '请开始新的冒险',
    asset_path: 'assets/ui/main.png',
  });
});
