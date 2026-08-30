import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRuntimeAliasTranslations } from '../server/scheduler.js';
import { collectRuntimeAliasTranslationCandidates } from '../server/domain/risu-lua.js';

test('runtime alias translation accepts only target-language proper-name aliases', () => {
  const candidates = [{ ownerId: 'madoka', aliases: ['Madoka Kaname', '鹿目まどか'] }];
  const result = normalizeRuntimeAliasTranslations(JSON.stringify({
    aliases: [
      { ownerId: 'madoka', names: ['鹿目圆', '小圆', 'madoka_awakened_default', 'Mami'] },
      { ownerId: 'unknown', names: ['不应写入'] },
    ],
  }), candidates, 'zh-CN');
  assert.deepEqual(result, { madoka: ['鹿目圆', '小圆'] });
});

test('runtime catalogs without target-language aliases become translation candidates', () => {
  const module = {
    trigger: [{ effect: [{ code: "local roster = [==[[{\"id\":\"madoka\",\"aliases\":[\"Madoka\",\"鹿目まどか\"]}]]==]" }] }],
  };
  assert.deepEqual(collectRuntimeAliasTranslationCandidates(module, 'zh-CN'), [{
    ownerId: 'madoka', aliases: ['Madoka', '鹿目まどか'],
  }]);
});
