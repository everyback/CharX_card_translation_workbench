export interface LanguageDirectiveMatch {
  sourceLanguage: string;
  targetLanguage: string;
  languageText: string;
  index: number;
  length: number;
}

export interface LanguageDirectiveNormalization {
  text: string;
  changed: boolean;
  replacements: LanguageDirectiveMatch[];
  remaining: LanguageDirectiveMatch[];
}

export interface LanguageDirectiveReview {
  mode: 'target' | 'preserve';
  targetLanguage: string;
  targetLabel: string;
  replacements: LanguageDirectiveMatch[];
  remaining: LanguageDirectiveMatch[];
}

type LanguageAlias = {
  family: string;
  aliases: string[];
};

const LANGUAGE_ALIASES: LanguageAlias[] = [
  { family: 'zh', aliases: ['简体中文', '繁体中文', '中文', '汉语', '汉文', 'Chinese', 'Mandarin'] },
  { family: 'ko', aliases: ['韩国语', '한국어', '韩语', '韩文', 'Korean', 'ko'] },
  { family: 'ja', aliases: ['日本語', '日语', '日文', 'Japanese', 'ja'] },
  { family: 'en', aliases: ['英语', '英文', 'English', '英語', 'en'] },
  { family: 'fr', aliases: ['法语', '法文', 'French', 'français', 'fr'] },
  { family: 'de', aliases: ['德语', '德文', 'German', 'Deutsch', 'de'] },
  { family: 'es', aliases: ['西班牙语', '西班牙文', 'Spanish', 'Español', 'es'] },
  { family: 'ru', aliases: ['俄语', '俄文', 'Russian', 'русский', 'ru'] },
  { family: 'ar', aliases: ['阿拉伯语', '阿拉伯文', 'Arabic', 'العربية', 'ar'] },
  { family: 'th', aliases: ['泰语', '泰文', 'Thai', 'ไทย', 'th'] },
];

const BEHAVIOR_VERBS = [
  '思考', '内心', '想法', '交流', '沟通', '对话', '对白', '说话', '发言', '表达',
  '书写', '写作', '写字', '叙述', '旁白', '朗读', '阅读', '回复', '输出', '回答',
  '생각', '대화', '소통', '말하', '작성', '쓰', '읽', '응답', '출력',
  'think', 'thought', 'thinking', 'inner monologue', 'speak', 'speaking', 'speech',
  'talk', 'talking', 'communicat', 'dialogue', 'write', 'writing', 'written',
  'narrat', 'read', 'reply', 'respond', 'output', 'answer',
  '考え', '思考', '会話', '話し', '書き', '記述', 'ナレーション', '返答', '出力',
];

const aliasEntries = LANGUAGE_ALIASES
  .flatMap(({ family, aliases }) => aliases.map((alias) => ({ family, alias })))
  .sort((left, right) => right.alias.length - left.alias.length);

const aliasPattern = aliasEntries
  .map(({ alias }) => /[A-Za-z]/u.test(alias) ? `\\b${escapeRegExp(alias)}\\b` : escapeRegExp(alias))
  .join('|');
const aliasRegex = new RegExp(`(?:${aliasPattern})`, 'giu');
const behaviorRegex = new RegExp(BEHAVIOR_VERBS.map(escapeRegExp).join('|'), 'iu');

/**
 * Rewrites language names only when they participate in a language-behavior
 * instruction (thinking, speaking, writing, narration, etc.). Ordinary story
 * facts and code/protocol literals therefore remain untouched.
 */
export function normalizeLanguageBehaviorDirectives(text: string, targetLanguage: string): LanguageDirectiveNormalization {
  const targetFamily = languageFamily(targetLanguage);
  const targetLabel = languageDisplayName(targetLanguage);
  const replacements: LanguageDirectiveMatch[] = [];
  const remaining: LanguageDirectiveMatch[] = [];
  let output = '';
  let offset = 0;

  for (const chunk of splitPreservingDelimiters(text)) {
    const chunkStart = offset;
    offset += chunk.length;
    const aliases = [...chunk.matchAll(aliasRegex)];
    if (!aliases.length || !behaviorRegex.test(chunk)) {
      output += chunk;
      continue;
    }
    const shouldTranslate = isLanguageBehaviorClause(chunk);
    if (!shouldTranslate) {
      output += chunk;
      continue;
    }
    // Do not splice a target-language label into a wholly untranslated
    // Korean/Japanese sentence. The model must translate that sentence as a
    // whole; replacing just its language word would leave broken grammar.
    if (!isSafeForLocalReplacement(chunk, aliases.map((match) => match[0]))) {
      output += chunk;
      continue;
    }
    let cursor = 0;
    for (const match of aliases) {
      const languageText = match[0];
      const index = chunkStart + (match.index ?? 0);
      const family = languageFamily(languageText);
      if (!family || family === targetFamily) continue;
      output += chunk.slice(cursor, match.index ?? 0);
      output += targetLabel;
      cursor = (match.index ?? 0) + languageText.length;
      replacements.push({ sourceLanguage: family, targetLanguage: targetFamily, languageText, index, length: languageText.length });
    }
    output += chunk.slice(cursor);
  }

  // A second scan reports directives that still name a non-target language.
  // This is useful for review diagnostics if a model returns a reordered clause
  // that the conservative normalization intentionally did not touch.
  for (const match of findLanguageBehaviorMatches(output)) {
    if (match.sourceLanguage !== targetFamily) remaining.push(match);
  }
  return { text: output, changed: output !== text, replacements, remaining };
}

export function languageBehaviorDirectiveIssue(text: string, targetLanguage: string): string | null {
  const target = languageFamily(targetLanguage);
  const residual = findLanguageBehaviorMatches(text).filter((match) => match.sourceLanguage !== target);
  if (!residual.length) return null;
  const labels = [...new Set(residual.map((match) => match.languageText))].slice(0, 3);
  return `卡片语言设定仍含非目标语言：${labels.join('、')}`;
}

export function reviewLanguageBehaviorDirectives(
  source: string,
  translated: string,
  targetLanguage: string,
  mode: 'target' | 'preserve' = 'target',
): LanguageDirectiveReview {
  const normalized = mode === 'target'
    ? normalizeLanguageBehaviorDirectives(translated, targetLanguage)
    : { replacements: [], remaining: findLanguageBehaviorMatches(translated) };
  return {
    mode,
    targetLanguage,
    targetLabel: languageDisplayName(targetLanguage),
    replacements: normalized.replacements,
    remaining: normalized.remaining,
  };
}

export function languageDisplayName(language: string): string {
  const family = languageFamily(language);
  const normalized = normalizeLanguage(language);
  if (family === 'zh') return /tw|hk|hant|繁体|繁體/u.test(normalized) ? '繁体中文' : '简体中文';
  if (family === 'ko') return '韩语';
  if (family === 'ja') return '日语';
  if (family === 'en') return '英语';
  if (family === 'fr') return '法语';
  if (family === 'de') return '德语';
  if (family === 'es') return '西班牙语';
  if (family === 'ru') return '俄语';
  if (family === 'ar') return '阿拉伯语';
  if (family === 'th') return '泰语';
  return language.trim() || '目标语言';
}

export function languageFamily(value: string): string {
  const normalized = normalizeLanguage(value);
  const found = aliasEntries.find(({ alias }) => alias.toLocaleLowerCase() === normalized);
  if (found) return found.family;
  return normalized.split('-')[0];
}

function findLanguageBehaviorMatches(text: string): LanguageDirectiveMatch[] {
  const matches: LanguageDirectiveMatch[] = [];
  let offset = 0;
  for (const chunk of splitPreservingDelimiters(text)) {
    if (isLanguageBehaviorClause(chunk)) {
      for (const match of chunk.matchAll(aliasRegex)) {
        const languageText = match[0];
        matches.push({
          sourceLanguage: languageFamily(languageText),
          targetLanguage: '',
          languageText,
          index: offset + (match.index ?? 0),
          length: languageText.length,
        });
      }
    }
    offset += chunk.length;
  }
  return matches;
}

function isLanguageBehaviorClause(chunk: string): boolean {
  if (!behaviorRegex.test(chunk)) return false;
  const aliases = [...chunk.matchAll(aliasRegex)];
  if (!aliases.length) return false;
  // Require a directive relation, or a direct speech/writing/thinking verb
  // immediately adjacent to the language name. This avoids changing facts
  // such as “她学习过韩语” merely because “思考” occurs in another clause.
  return aliases.some((alias) => {
    const start = alias.index ?? 0;
    const before = chunk.slice(Math.max(0, start - 18), start);
    const after = chunk.slice(start + alias[0].length, start + alias[0].length + 18);
    return /(?:使用|用|以|采用|改用|切换为|书写|写作|思考|交流|沟通|对话|对白|说话|发言|表达|叙述|旁白|回复|输出|回答|사용|생각|대화|소통|말하|작성|쓰|읽|응답|출력|use|using|written in|speak in|think in|think|thought|thinking|speak|speaking|talk|talking|communicat|dialogue|write|writing|narrat|read|reply|respond|output|answer|で|に|考え|思考|会話|話し|書き|記述|ナレーション|返答|出力)/iu.test(before)
      || /(?:思考|交流|沟通|对话|对白|说话|发言|表达|书写|写作|写字|叙述|旁白|朗读|阅读|回复|输出|回答|사용|생각|대화|소통|말하|작성|쓰|읽|응답|출력|think|thought|thinking|inner monologue|speak|speaking|speech|talk|talking|communicat|dialogue|write|writing|written|narrat|read|reply|respond|output|answer|考え|思考|会話|話し|書き|記述|ナレーション|返答|出力)/iu.test(after);
  });
}

function isSafeForLocalReplacement(chunk: string, languageTexts: readonly string[]): boolean {
  let remainder = chunk;
  for (const languageText of languageTexts) remainder = remainder.replace(languageText, '');
  const hangul = (remainder.match(/[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/gu) ?? []).length;
  const japanese = (remainder.match(/[\u3040-\u30ff]/gu) ?? []).length;
  const latin = (remainder.match(/[A-Za-z]/gu) ?? []).length;
  const cjk = (remainder.match(/[\u3400-\u9fff]/gu) ?? []).length;
  if (hangul + japanese > 8 && cjk + latin < 4) return false;
  return true;
}

function splitPreservingDelimiters(text: string): string[] {
  return text.split(/(?<=[。！？!?；;：:\n，,.])/u);
}

function normalizeLanguage(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/_/g, '-');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
