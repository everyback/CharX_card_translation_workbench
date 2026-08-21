import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseCardPng, writeCardPng } from '../server/domain/png.js';

const transparentPixel = readFileSync(new URL('../node_modules/png-chunks-extract/test.png', import.meta.url));

test('character card metadata can be embedded and read from PNG', () => {
  const card = { spec: 'chara_card_v3', spec_version: '3.0', data: { name: 'Mina' } };
  const output = writeCardPng(transparentPixel, card, ['chara', 'ccv3']);
  const parsed = parseCardPng(output);

  assert.deepEqual(parsed.card, card);
  assert.deepEqual(parsed.metadataKeys.sort(), ['ccv3', 'chara']);
  assert.deepEqual(output.subarray(0, 8), transparentPixel.subarray(0, 8));
});
