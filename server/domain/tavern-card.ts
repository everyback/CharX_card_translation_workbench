export interface TavernCardFieldSummary {
  path: string;
  label: string;
  type: 'text' | 'list' | 'object' | 'value';
  size: number;
  summary: string;
  preview: string;
}

export interface TavernCardInspectionSummary {
  cardName: string;
  spec: string;
  specVersion: string;
  creator: string;
  characterVersion: string;
  metadataKeys: string[];
  jsonBytes: number;
  alternateGreetings: number;
  groupOnlyGreetings: number;
  lorebookEntries: number;
  regexScripts: number;
  assets: number;
  tags: string[];
  extensionKeys: string[];
  topLevelKeys: string[];
  dataKeys: string[];
  fields: TavernCardFieldSummary[];
  warnings: string[];
}

export interface ProjectOverviewSummary extends TavernCardInspectionSummary {
  modulePresent: boolean;
  moduleName: string;
  moduleLorebookEntries: number;
  moduleRegexScripts: number;
  moduleTriggers: number;
  moduleAssets: number;
  moduleJsonBytes: number;
  moduleKeys: string[];
}

const IMPORTANT_FIELDS: Array<{ path: string[]; label: string }> = [
  { path: ['name'], label: '角色名称' },
  { path: ['description'], label: '角色描述' },
  { path: ['personality'], label: '性格' },
  { path: ['scenario'], label: '场景' },
  { path: ['first_mes'], label: '首条消息' },
  { path: ['mes_example'], label: '对话示例' },
  { path: ['creator_notes'], label: '作者说明' },
  { path: ['creatorcomment'], label: '作者说明（旧字段）' },
  { path: ['system_prompt'], label: '系统提示词' },
  { path: ['system_prompts'], label: '系统提示词列表' },
  { path: ['post_history_instructions'], label: '历史后指令' },
  { path: ['alternate_greetings'], label: '备选开场白' },
  { path: ['group_only_greetings'], label: '群聊开场白' },
  { path: ['character_book', 'entries'], label: '世界书条目' },
  { path: ['extensions', 'regex_scripts'], label: '正则脚本' },
  { path: ['extensions', 'tavern_helper'], label: 'Tavern Helper 数据' },
  { path: ['assets'], label: '卡片资源' },
  { path: ['tags'], label: '标签' },
];

export function inspectTavernCard(
  card: Record<string, unknown>,
  metadataKeys: readonly string[] = [],
): TavernCardInspectionSummary {
  const data = record(card.data) ?? card;
  const extensions = record(data.extensions) ?? {};
  const characterBook = record(data.character_book) ?? record(card.character_book) ?? {};
  const alternateGreetings = array(data.alternate_greetings).length;
  const groupOnlyGreetings = array(data.group_only_greetings).length;
  const lorebookEntries = array(characterBook.entries).length;
  const regexScripts = array(extensions.regex_scripts).length;
  const assets = array(data.assets).length;
  const fields = importantFieldSummaries(card, data);
  const spec = string(card.spec) || inferSpec(card, data);
  const warnings: string[] = [];
  if (!string(data.name) && !string(card.name)) warnings.push('卡片没有角色名称。');
  if (!string(card.spec)) warnings.push('没有声明 Character Card 规范，将按旧版酒馆卡处理。');
  if (!fields.some((field) => field.path.endsWith('first_mes'))) warnings.push('没有首条消息。');
  if (!lorebookEntries) warnings.push('没有内嵌世界书条目。');

  return {
    cardName: string(data.name) || string(card.name) || '未命名酒馆卡',
    spec,
    specVersion: string(card.spec_version),
    creator: string(data.creator) || string(card.creator),
    characterVersion: string(data.character_version) || string(card.character_version),
    metadataKeys: [...new Set(metadataKeys.map(String).filter(Boolean))],
    jsonBytes: Buffer.byteLength(JSON.stringify(card), 'utf8'),
    alternateGreetings,
    groupOnlyGreetings,
    lorebookEntries,
    regexScripts,
    assets,
    tags: array(data.tags).map(String).filter(Boolean).slice(0, 30),
    extensionKeys: Object.keys(extensions),
    topLevelKeys: Object.keys(card),
    dataKeys: Object.keys(data),
    fields,
    warnings,
  };
}

export function inspectProjectOverview(
  card: Record<string, unknown>,
  module: Record<string, unknown> | null,
  sourceFormat: string,
  metadataKeys: readonly string[] = [],
): ProjectOverviewSummary {
  const isModuleProject = sourceFormat === 'risum' && module != null;
  const inspection = inspectTavernCard(isModuleProject ? module : card, metadataKeys);
  const moduleLorebookEntries = array(module?.lorebook).length;
  const moduleRegexScripts = array(module?.regex).length;
  const moduleTriggers = array(module?.trigger).length;
  const moduleAssets = array(module?.assets).length;

  return {
    ...inspection,
    cardName: isModuleProject ? string(module.name) || inspection.cardName : inspection.cardName,
    spec: isModuleProject ? 'risu_module' : inspection.spec,
    specVersion: isModuleProject ? string(module.version) : inspection.specVersion,
    lorebookEntries: isModuleProject ? 0 : inspection.lorebookEntries,
    regexScripts: isModuleProject ? 0 : inspection.regexScripts,
    assets: isModuleProject ? 0 : inspection.assets,
    warnings: isModuleProject ? [] : inspection.warnings,
    modulePresent: module != null,
    moduleName: module ? string(module.name) : '',
    moduleLorebookEntries,
    moduleRegexScripts,
    moduleTriggers,
    moduleAssets,
    moduleJsonBytes: module ? Buffer.byteLength(JSON.stringify(module), 'utf8') : 0,
    moduleKeys: module ? Object.keys(module) : [],
  };
}

function importantFieldSummaries(
  card: Record<string, unknown>,
  data: Record<string, unknown>,
): TavernCardFieldSummary[] {
  const summaries: TavernCardFieldSummary[] = [];
  const seen = new Set<string>();
  for (const field of IMPORTANT_FIELDS) {
    const fromData = valueAtPath(data, field.path);
    const fromRoot = valueAtPath(card, field.path);
    const value = fromData ?? fromRoot;
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
    const prefix = fromData != null && data !== card ? 'data.' : '';
    const path = `${prefix}${field.path.join('.')}`;
    if (seen.has(path)) continue;
    seen.add(path);
    summaries.push(summarizeField(path, field.label, value));
  }
  return summaries;
}

function summarizeField(path: string, label: string, value: unknown): TavernCardFieldSummary {
  if (typeof value === 'string') {
    return { path, label, type: 'text', size: value.length, summary: `${value.length.toLocaleString()} 字符`, preview: previewText(value) };
  }
  if (Array.isArray(value)) {
    const firstText = value.find((item) => typeof item === 'string' && item.trim());
    return { path, label, type: 'list', size: value.length, summary: `${value.length.toLocaleString()} 项`, preview: typeof firstText === 'string' ? previewText(firstText) : '' };
  }
  if (value && typeof value === 'object') {
    const size = Object.keys(value as Record<string, unknown>).length;
    return { path, label, type: 'object', size, summary: `${size.toLocaleString()} 个子项`, preview: Object.keys(value as Record<string, unknown>).slice(0, 8).join('、') };
  }
  return { path, label, type: 'value', size: 1, summary: String(value), preview: '' };
}

function previewText(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized;
}

function valueAtPath(root: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function inferSpec(card: Record<string, unknown>, data: Record<string, unknown>): string {
  if (record(card.data)) return 'chara_card_v2_or_v3';
  if (string(data.name) || string(card.name)) return 'legacy_tavern_card';
  return 'unknown';
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
