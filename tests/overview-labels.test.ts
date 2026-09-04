import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cardSpecificationDetail,
  cardSpecificationLabel,
  containerFormatLabel,
  platformExtensionLabels,
} from '../src/pages/workbench/tabs/overview/model/overview-labels.js';

test('overview separates character specifications from file containers', () => {
  assert.equal(cardSpecificationLabel('legacy_tavern_card'), 'Tavern Card V1');
  assert.equal(cardSpecificationLabel('chara_card_v2'), 'Character Card V2 (CCv2)');
  assert.equal(cardSpecificationLabel('chara_card_v3'), 'Character Card V3 (CCv3)');
  assert.equal(cardSpecificationDetail('chara_card_v3', '3.0'), '规范版本 3.0');
  assert.equal(containerFormatLabel('png'), 'PNG 图像容器');
  assert.equal(containerFormatLabel('charx'), 'CHARX 资源容器');
});

test('overview identifies platform extensions without treating CHARX as a platform', () => {
  assert.deepEqual(platformExtensionLabels([], false), []);
  assert.deepEqual(platformExtensionLabels(['risuai', 'depth_prompt'], false), ['RisuAI', 'Depth Prompt']);
  assert.deepEqual(platformExtensionLabels(['tavern_helper', 'regex_scripts'], false), ['Tavern Helper', 'SillyTavern Regex']);
  assert.deepEqual(platformExtensionLabels([], true), ['RisuAI']);
});
