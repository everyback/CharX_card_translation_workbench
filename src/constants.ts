import type { ScopePreset, Segment } from './types';

export const SCOPE_OPTIONS: Array<{ value: ScopePreset; label: string }> = [
  { value: 'core', label: '只翻角色主体' },
  { value: 'standard', label: '主体 + 世界书 + 问候语' },
  { value: 'visible-scripts', label: '包含脚本按钮 / 弹窗' },
  { value: 'all-visible', label: '完整可见内容 + Lua 提示词' },
  { value: 'all', label: '全部翻译（含资源 JSON 可见文本）' },
  { value: 'lua-only', label: '仅 Lua 解析提取' },
];

export const CATEGORY_LABELS: Record<string, string> = {
  core: '主体', lorebook: '世界书', greeting: '问候语', name: '名称', 'script-ui': '脚本提示 / UI', 'background-ui': '背景 UI',
};

export const KIND_LABELS: Record<string, string> = {
  field: '普通字段', button: '按钮文字', attribute: '属性文字', 'text-node': '页面文字', 'runtime-message': '运行提示', 'lua-string': 'Lua 提示词', 'lua-formatted': 'Lua 格式文字', 'lua-long-string': 'Lua 长文本', 'lua-language': '语言设置', 'lua-button': 'Lua 按钮文字', 'lua-attribute': 'Lua 属性文字', 'lua-text-node': 'Lua 页面文字', 'lorebook-key-alias': '关键词中文别名', 'structured-text': '结构化文本片段', 'protocol-field': '协议文字槽位', 'resource-json': '资源 JSON 可见文字',
};

export const STATUS_LABELS: Record<string, string> = {
  new: '待扫描', scanned: '待翻译', translating: '翻译中', review: '待审核', ready: '可导出', queued: '排队中', running: '进行中', paused: '已暂停', failed: '失败', review_with_errors: '完成但有失败项', cancelled: '已取消', untranslated: '未翻译', pending: '待审核', approved: '已通过', rejected: '已退回',
};

export function riskLabel(risk: Segment['riskLevel']): string {
  return ({ low: '低', medium: '中', high: '高' } as Record<Segment['riskLevel'], string>)[risk];
}
