import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectProjectOverview, inspectTavernCard } from '../server/domain/card/tavern-card.js';

test('Tavern card inspection summarizes V3 fields without returning the full payload', () => {
  const card = {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name: 'Solaris',
      creator: 'Author',
      character_version: '1.2',
      description: 'A long character description.',
      first_mes: 'Hello {{user}}',
      alternate_greetings: ['One', 'Two'],
      group_only_greetings: ['Group'],
      tags: ['game', 'world'],
      character_book: { entries: [{ name: 'City' }, { name: 'Port' }] },
      extensions: { regex_scripts: [{ script_name: 'Status' }], tavern_helper: { enabled: true } },
    },
  };

  const inspection = inspectTavernCard(card, ['chara', 'ccv3']);

  assert.equal(inspection.cardName, 'Solaris');
  assert.equal(inspection.spec, 'chara_card_v3');
  assert.equal(inspection.alternateGreetings, 2);
  assert.equal(inspection.groupOnlyGreetings, 1);
  assert.equal(inspection.lorebookEntries, 2);
  assert.equal(inspection.regexScripts, 1);
  assert.deepEqual(inspection.metadataKeys, ['chara', 'ccv3']);
  assert.ok(inspection.fields.some((field) => field.path === 'data.description' && field.type === 'text'));
  assert.ok(inspection.fields.some((field) => field.path === 'data.character_book.entries' && field.size === 2));
});

test('legacy Tavern cards are recognized without a spec declaration', () => {
  const inspection = inspectTavernCard({ name: 'Legacy', first_mes: 'Hi' });

  assert.equal(inspection.spec, 'legacy_tavern_card');
  assert.match(inspection.warnings.join('\n'), /没有声明 Character Card 规范/u);
});

test('project overview combines a CHARX card with its embedded Risu module', () => {
  const overview = inspectProjectOverview({
    spec: 'chara_card_v3',
    data: {
      name: 'Card',
      first_mes: 'Hello',
      character_book: { entries: [{ name: 'Card lore' }] },
    },
  }, {
    name: 'Companion module',
    lorebook: [{ name: 'Module lore' }, { name: 'Module lore 2' }],
    regex: [{ in: '<status>' }],
    trigger: [{ effect: [] }, { effect: [] }],
    assets: [['map', '', 'image/png']],
  }, 'charx');

  assert.equal(overview.cardName, 'Card');
  assert.equal(overview.lorebookEntries, 1);
  assert.equal(overview.modulePresent, true);
  assert.equal(overview.moduleName, 'Companion module');
  assert.equal(overview.moduleLorebookEntries, 2);
  assert.equal(overview.moduleRegexScripts, 1);
  assert.equal(overview.moduleTriggers, 2);
  assert.equal(overview.moduleAssets, 1);
});

test('RISUM project overview uses module identity instead of the placeholder card', () => {
  const overview = inspectProjectOverview({ name: 'Placeholder' }, {
    name: 'Standalone module',
    version: '1.4',
    lorebook: [{ name: 'Lore' }],
  }, 'risum');

  assert.equal(overview.cardName, 'Standalone module');
  assert.equal(overview.spec, 'risu_module');
  assert.equal(overview.specVersion, '1.4');
  assert.equal(overview.moduleLorebookEntries, 1);
  assert.deepEqual(overview.warnings, []);
});
