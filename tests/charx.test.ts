import assert from 'node:assert/strict';
import test from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  findCharxCover,
  inspectCharx,
  isRisuModuleLorebookMirrorPath,
  packCharxEntries,
  parseCharx,
  readCharxEntry,
  synchronizeRisuModuleLorebook,
  writeCardCharx,
} from '../server/domain/charx.js';
import { createRisuModule, parseRisuModule } from '../server/domain/risum.js';

const originalCard = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: { name: 'Mina', description: 'Old description' },
};
const avatar = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);

function createArchive(): Uint8Array {
  return zipSync({
    'card.json': strToU8(JSON.stringify(originalCard)),
    'assets/icon/images/avatar.png': avatar,
    'risu.json': strToU8('{"theme":"dark"}'),
  });
}

test('CHARX card.json can be updated while preserving assets', () => {
  const source = createArchive();
  const parsed = parseCharx(source);
  assert.deepEqual(parsed, { card: originalCard, module: null, assetCount: 2, hybrid: false });

  const translated = { ...originalCard, data: { ...originalCard.data, description: '新描述' } };
  const output = writeCardCharx(source, translated);
  const files = unzipSync(output);

  assert.deepEqual(JSON.parse(strFromU8(files['card.json'])), translated);
  assert.deepEqual(files['assets/icon/images/avatar.png'], avatar);
  assert.equal(strFromU8(files['risu.json']), '{"theme":"dark"}');
});

test('CHARX overview selects the declared avatar asset before other images', () => {
  const source = zipSync({
    'card.json': strToU8(JSON.stringify({ ...originalCard, data: { ...originalCard.data, avatar: 'assets/icon/images/avatar.png' } })),
    'assets/background.png': new Uint8Array([137, 80, 78, 71, 9]),
    'assets/icon/images/avatar.png': avatar,
  });
  const cover = findCharxCover(source);
  assert.equal(cover?.path, 'assets/icon/images/avatar.png');
  assert.equal(cover?.mimeType, 'image/png');
  assert.deepEqual(cover?.bytes, Buffer.from(avatar));
});

test('CHARX overview falls back to a named avatar image when card.json has no avatar', () => {
  const source = zipSync({
    'card.json': strToU8(JSON.stringify(originalCard)),
    'assets/scene.png': new Uint8Array([137, 80, 78, 71, 9]),
    'assets/avatar.png': avatar,
  });
  assert.equal(findCharxCover(source)?.path, 'assets/avatar.png');
});

test('CHARX embedded Risu module can be translated while preserving other files', () => {
  const module = { name: 'Panel', trigger: [{ effect: [{ code: 'alertError(triggerId, "패널 리롤 대상 없음")' }] }] };
  const source = zipSync({
    'card.json': strToU8(JSON.stringify(originalCard)),
    'module.risum': createRisuModule(module, [new Uint8Array([9, 8, 7])]),
    'assets/icon/images/avatar.png': avatar,
  });
  const parsed = parseCharx(source);
  assert.deepEqual(parsed.module, module);
  assert.equal(parsed.assetCount, 2);

  const untouchedFiles = unzipSync(writeCardCharx(source, originalCard));
  assert.deepEqual(untouchedFiles['module.risum'], unzipSync(source)['module.risum']);

  const translatedModule = structuredClone(module);
  translatedModule.trigger[0].effect[0].code = 'alertError(triggerId, "没有可重新生成的面板内容")';
  const output = writeCardCharx(source, originalCard, translatedModule);
  const files = unzipSync(output);

  assert.deepEqual(parseRisuModule(files['module.risum']).module, translatedModule);
  assert.equal(parseRisuModule(files['module.risum']).assetCount, 1);
  assert.deepEqual(files['assets/icon/images/avatar.png'], avatar);
});

test('CHARX inspection exposes card, lorebook, module and archive entries without creating a project', () => {
  const card = {
    ...originalCard,
    data: {
      ...originalCard.data,
      character_book: { entries: [{ name: 'Library', content: 'Archive' }] },
    },
  };
  const module = {
    name: 'Panel',
    lorebook: [{ key: 'school', comment: 'School', content: 'Campus' }],
  };
  const source = zipSync({
    'card.json': strToU8(JSON.stringify(card)),
    'module.risum': createRisuModule(module, [new Uint8Array([9, 8, 7])]),
    'risu.json': strToU8('{"theme":"dark"}'),
    'assets/icon/avatar.png': avatar,
  });

  const inspection = inspectCharx(source);
  assert.equal(inspection.cardName, 'Mina');
  assert.equal(inspection.cardLorebookEntries, 1);
  assert.equal(inspection.moduleName, 'Panel');
  assert.equal(inspection.moduleLorebookEntries, 1);
  assert.equal(inspection.moduleAssetCount, 1);
  assert.equal(inspection.fileCount, 4);
  assert.deepEqual(inspection.entries.map((entry) => entry.category), ['card', 'module', 'metadata', 'asset']);
  assert.deepEqual(readCharxEntry(source, 'assets/icon/avatar.png'), Buffer.from(avatar));
  assert.deepEqual(Object.keys(unzipSync(packCharxEntries(source))).sort(), Object.keys(unzipSync(source)).sort());
  assert.throws(() => readCharxEntry(source, '../card.json'), /不存在文件/);
});

test('CHARX export synchronizes translated card lorebook into the Risu module', () => {
  const card = {
    ...originalCard,
    data: {
      ...originalCard.data,
      character_book: {
        entries: [
          {
            keys: ['원본', '原文'],
            secondary_keys: ['보조', '辅助'],
            content: '翻译后的世界书正文',
            insertion_order: 7,
            name: '翻译后的条目名',
            constant: false,
            selective: true,
            case_sensitive: false,
            extensions: { risu_activationPercent: 75 },
          },
          {
            keys: ['新增条目'],
            content: '第二条正文',
            insertion_order: 8,
            extensions: {},
          },
        ],
      },
    },
  };
  const staleModule = {
    name: 'Panel',
    regex: [{ comment: 'translated regex' }],
    trigger: [{ comment: 'translated trigger' }],
    lorebook: [{ key: '원본', content: '旧正文', comment: '旧条目名', bookVersion: 2 }],
  };

  const synchronized = synchronizeRisuModuleLorebook(card, staleModule);
  assert.deepEqual(synchronized.regex, staleModule.regex);
  assert.deepEqual(synchronized.trigger, staleModule.trigger);
  assert.equal((synchronized.lorebook as Record<string, unknown>[]).length, 2);
  assert.deepEqual((synchronized.lorebook as Record<string, unknown>[])[0], {
    key: '원본, 原文',
    secondkey: '보조, 辅助',
    insertorder: 7,
    comment: '翻译后的条目名',
    content: '翻译后的世界书正文',
    mode: 'normal',
    alwaysActive: false,
    selective: true,
    extentions: { risu_activationPercent: 75, risu_case_sensitive: false },
    activationPercent: 75,
    loreCache: null,
    useRegex: false,
    bookVersion: 2,
  });
  assert.equal((synchronized.lorebook as Record<string, unknown>[])[1].key, '新增条目');

  const source = zipSync({
    'card.json': strToU8(JSON.stringify(originalCard)),
    'module.risum': createRisuModule(staleModule),
  });
  const output = parseCharx(writeCardCharx(source, card, synchronized));
  assert.deepEqual(output.card, card);
  assert.deepEqual(output.module, synchronized);
});

test('CHARX module lorebook paths are recognized as card worldbook mirrors', () => {
  const card = {
    data: {
      character_book: {
        entries: [{ name: 'Entry', content: 'Canonical text' }],
      },
    },
  };

  assert.equal(isRisuModuleLorebookMirrorPath(card, ['$module', 'lorebook', 0, 'content']), true);
  assert.equal(isRisuModuleLorebookMirrorPath(card, ['$module', 'lorebook', 1, 'content']), false);
  assert.equal(isRisuModuleLorebookMirrorPath(card, ['$module', 'trigger', 0, 'code']), false);
});

test('JPEG+CHARX hybrid prefix survives a round trip', () => {
  const jpegPrefix = new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]);
  const archive = createArchive();
  const source = new Uint8Array(jpegPrefix.length + archive.length);
  source.set(jpegPrefix);
  source.set(archive, jpegPrefix.length);

  assert.equal(parseCharx(source).hybrid, true);
  const output = writeCardCharx(source, originalCard);
  assert.deepEqual([...output.subarray(0, jpegPrefix.length)], [...jpegPrefix]);
  assert.deepEqual(parseCharx(output).card, originalCard);
});

test('CHARX rejects missing card.json and unsafe paths', () => {
  assert.throws(() => parseCharx(zipSync({ 'assets/avatar.png': avatar })), /缺少 card\.json/);
  assert.throws(() => parseCharx(zipSync({ 'card.json': strToU8('{}'), '../escape.txt': strToU8('x') })), /不安全路径/);
});

test('CHARX accepts archives with more than 512 entries', () => {
  const files: Record<string, Uint8Array> = {
    'card.json': strToU8(JSON.stringify(originalCard)),
  };
  for (let index = 0; index < 600; index += 1) {
    files[`assets/items/${index}.txt`] = strToU8(String(index));
  }

  const parsed = parseCharx(zipSync(files));
  assert.equal(parsed.assetCount, 600);
  assert.deepEqual(parsed.card, originalCard);
});

test('CHARX accepts card.json larger than the former 8 MiB limit', () => {
  const description = 'A'.repeat(8 * 1024 * 1024 + 1024);
  const largeCard = { ...originalCard, data: { ...originalCard.data, description } };
  const source = zipSync({ 'card.json': strToU8(JSON.stringify(largeCard)) });

  assert.equal(parseCharx(source).card.data.description.length, description.length);
  assert.equal(parseCharx(writeCardCharx(createArchive(), largeCard)).card.data.description.length, description.length);
});
