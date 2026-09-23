import {
  applyRisuModuleSegments,
  collectRuntimeAliasCandidates,
  collectRuntimeAliasTranslationCandidates,
} from '../../domain/lua/risu-lua.js';

export async function buildRuntimeAliasDraft(
  module: Record<string, unknown>,
  source: Record<string, unknown>,
  targetLanguage: string,
  translate: (input: Array<{ ownerId: string; aliases: string[] }>, language: string) => Promise<Record<string, string[]>>,
  segment: (input: Array<{ ownerId: string; name: string }>) => Promise<Record<string, string[]>>,
) {
  const missing = collectRuntimeAliasTranslationCandidates(module, targetLanguage);
  const translated = missing.length ? await translate(missing, targetLanguage) : {};
  if (missing.length && !Object.keys(translated).length) throw new Error('运行时名称本地化没有返回可验证的目标语言别名。');
  const names = [...collectRuntimeAliasCandidates(module, targetLanguage, source),
    ...Object.entries(translated).flatMap(([ownerId, aliases]) => aliases.map((name) => ({ ownerId, name })))];
  const unique = names.filter((candidate, index) => names.findIndex((item) => item.ownerId === candidate.ownerId && item.name === candidate.name) === index);
  const segmented = unique.length ? await segment(unique) : {};
  for (const [ownerId, aliases] of Object.entries(segmented)) {
    translated[ownerId] = [...new Set([...(translated[ownerId] ?? []), ...aliases])];
  }
  return applyRisuModuleSegments(module, [], targetLanguage, source, translated);
}
