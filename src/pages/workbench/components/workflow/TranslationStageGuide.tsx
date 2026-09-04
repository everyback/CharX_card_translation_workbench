export function TranslationStageGuide({ active }: { active: 'text' | 'adaptation' }) {
  return (
    <div className="guided-translation-stages" aria-label="翻译阶段">
      <strong>翻译分两阶段</strong>
      <span className={active === 'text' ? 'active' : ''}>1. 文本翻译</span>
      <span className={active === 'adaptation' ? 'active' : ''}>2. Lua 正则与关键词适配</span>
      <small>阶段 2 失败时可在任务页单独重试，不会重翻已完成文本。</small>
    </div>
  );
}
