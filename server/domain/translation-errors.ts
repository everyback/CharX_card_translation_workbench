export function shouldSplitTranslationBatch(error: unknown): boolean {
  const message = (error instanceof Error ? `${error.name}: ${error.message}` : String(error)).toLowerCase();
  if (/timeout|timed out|aborted due to timeout/.test(message)) return true;
  if (/模型漏翻|缺少保护占位符|没有返回可读取的文本|世界书中文别名无效|翻译质量不合格/.test(message)) return true;
  return /模型接口 (?:400|413|422)/.test(message)
    && /context|token|length|large|size|limit|maximum|too long|请求体|上下文|长度|过大|限制/.test(message);
}

export function lorebookAliasIssue(
  source: string,
  translated: string,
  route: { sourceLanguage?: string; fallbackLanguage?: string; targetLanguage?: string } = {},
): string | null {
  const normalizedSource = source.trim().toLocaleLowerCase();
  const normalizedTranslation = translated.trim().toLocaleLowerCase();
  const legacyRoute = route.sourceLanguage == null && route.targetLanguage == null;
  const sourceLanguage = String(route.sourceLanguage || 'auto').trim().toLowerCase();
  const fallbackLanguage = String(route.fallbackLanguage || 'en').trim().toLowerCase();
  const targetLanguage = String(route.targetLanguage || 'zh-CN').trim().toLowerCase();
  if (!normalizedTranslation) return '译文为空';
  if (legacyRoute && normalizedTranslation === normalizedSource) return '译文与韩文原词相同';
  if (legacyRoute && /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(translated)) return '译文仍含韩文';
  if (legacyRoute && !/[\u3400-\u9fff]/u.test(translated)) return '译文不含中文汉字';
  if (normalizedTranslation === normalizedSource && !sameLanguageFamily(sourceLanguage, targetLanguage)) {
    return `译文与源语言原词相同（${sourceLanguage} → ${targetLanguage}）`;
  }
  const detectedSource = sourceLanguage === 'auto' ? fallbackLanguage : sourceLanguage;
  if (containsSourceScript(translated, detectedSource) && !sameLanguageFamily(detectedSource, targetLanguage)) {
    return '译文仍含未受保护的源语言文字';
  }
  const targetScript = targetScriptPattern(targetLanguage);
  if (targetScript && !targetScript.test(translated)) return `译文未出现目标语言文字（${targetLanguage}）`;
  if (/[\r\n]/u.test(translated)) return '译文包含换行';
  if ([...translated.trim()].length > 30) return '译文过长';
  return null;
}

export function residualHangulIssue(translated: string, protectedFragments: readonly string[] = []): string | null {
  let visibleText = translated;
  for (const fragment of [...new Set(protectedFragments.filter(Boolean))].sort((left, right) => right.length - left.length)) {
    visibleText = visibleText.replaceAll(fragment, '');
  }
  const syllables = visibleText.match(/[\uac00-\ud7af]+/gu) ?? [];
  const jamo = (visibleText.match(/[\u1100-\u11ff\u3130-\u318f]+/gu) ?? [])
    .filter((value) => !/^[\u314b\u314e\u315c\u3160\u3164]+$/u.test(value));
  const residual = [...new Set([...syllables, ...jamo])];
  if (!residual.length) return null;
  return `可能残留韩文：${residual.slice(0, 3).join('、')}`;
}

export function residualLanguageIssue(
  translated: string,
  protectedFragments: readonly string[] = [],
  sourceLanguage = 'auto',
  fallbackLanguage = 'en',
  targetLanguage = 'zh-CN',
): string | null {
  const explicitSource = normalizeLanguageTag(sourceLanguage);
  const target = normalizeLanguageTag(targetLanguage);
  if (explicitSource === 'auto') {
    const fallback = normalizeLanguageTag(fallbackLanguage);
    if (fallback && fallback !== 'en' && targetScriptPattern(fallback)) {
      if (sameLanguageFamily(fallback, target)) return null;
      return residualScriptIssue(translated, protectedFragments, fallback);
    }
    if (sameLanguageFamily('ko', target)) return null;
    return residualHangulIssue(translated, protectedFragments);
  }
  const source = explicitSource || normalizeLanguageTag(fallbackLanguage);
  if (!source || sameLanguageFamily(source, target)) return null;
  return residualScriptIssue(translated, protectedFragments, source);
}

function residualScriptIssue(
  translated: string,
  protectedFragments: readonly string[],
  source: string,
): string | null {
  const pattern = targetScriptPattern(source);
  if (!pattern) return null;
  let visibleText = translated;
  for (const fragment of [...new Set(protectedFragments.filter(Boolean))].sort((left, right) => right.length - left.length)) {
    visibleText = visibleText.replaceAll(fragment, '');
  }
  const residual = [...new Set(visibleText.match(pattern) ?? [])]
    .filter((value) => !/^[\u314b\u314e\u315c\u3160\u3164]+$/u.test(value));
  if (!residual.length) return null;
  return `可能残留源语言（${source}）：${residual.slice(0, 3).join('、')}`;
}

function normalizeLanguageTag(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, '-');
}

function sameLanguageFamily(left: string, right: string): boolean {
  const a = languageFamily(left);
  const b = languageFamily(right);
  if (!a || !b || a === 'auto' || b === 'auto') return false;
  return a === b;
}

function containsSourceScript(value: string, sourceLanguage: string): boolean {
  const pattern = targetScriptPattern(normalizeLanguageTag(sourceLanguage));
  return Boolean(pattern?.test(value));
}

function targetScriptPattern(language: string): RegExp | null {
  const tag = languageFamily(language);
  if (!tag || tag === 'auto') return null;
  if (tag.startsWith('zh') || /chinese|中文|简体|繁体/.test(tag)) return /[\u3400-\u9fff]/gu;
  if (tag.startsWith('ko') || /korean|韩/.test(tag)) return /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]+/gu;
  if (tag.startsWith('ja') || /japanese|日语|日本語/.test(tag)) return /[\u3040-\u30ff]/gu;
  if (/^(ru|uk|bg|sr|mk)(?:-|$)|cyrillic|俄|乌克兰/.test(tag)) return /[\u0400-\u052f]+/gu;
  if (tag.startsWith('ar') || /arabic|阿拉伯/.test(tag)) return /[\u0600-\u06ff]+/gu;
  if (tag.startsWith('he') || /hebrew|希伯来/.test(tag)) return /[\u0590-\u05ff]+/gu;
  if (tag.startsWith('th') || /thai|泰语/.test(tag)) return /[\u0e00-\u0e7f]+/gu;
  if (tag.startsWith('hi') || /hindi|devanagari|印地/.test(tag)) return /[\u0900-\u097f]+/gu;
  if (tag.startsWith('el') || /greek|希腊/.test(tag)) return /[\u0370-\u03ff]+/gu;
  return null;
}

function languageFamily(value: string): string {
  const tag = normalizeLanguageTag(value);
  const aliases: Record<string, string> = {
    english: 'en', '英语': 'en', '英文': 'en',
    french: 'fr', 'français': 'fr', '法语': 'fr', '法文': 'fr',
    german: 'de', 'deutsch': 'de', '德语': 'de', '德文': 'de',
    spanish: 'es', 'español': 'es', '西班牙语': 'es',
    portuguese: 'pt', 'português': 'pt', '葡萄牙语': 'pt',
    italian: 'it', 'italiano': 'it', '意大利语': 'it',
    russian: 'ru', 'русский': 'ru', '俄语': 'ru',
    ukrainian: 'uk', 'українська': 'uk', '乌克兰语': 'uk',
    chinese: 'zh', '中文': 'zh', '简体中文': 'zh', '繁體中文': 'zh', '简体': 'zh', '繁体': 'zh',
    japanese: 'ja', '日本語': 'ja', '日语': 'ja',
    korean: 'ko', '한국어': 'ko', '韩语': 'ko', '韩文': 'ko',
    arabic: 'ar', '阿拉伯语': 'ar',
    hebrew: 'he', '希伯来语': 'he',
    thai: 'th', '泰语': 'th',
    hindi: 'hi', '印地语': 'hi',
    greek: 'el', '希腊语': 'el',
  };
  return aliases[tag] || tag.split('-')[0];
}
