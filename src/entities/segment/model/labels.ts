import type { Segment } from '@/shared/types';

export const CATEGORY_LABELS: Record<string, string> = {
  core: '主体', lorebook: '世界书', greeting: '问候语', name: '名称', 'script-ui': '脚本提示 / UI', 'background-ui': '背景 UI',
};

export const KIND_LABELS: Record<string, string> = {
  field: '普通字段', button: '按钮文字', attribute: '属性文字', 'text-node': '页面文字', 'runtime-message': '运行提示', 'lua-string': 'Lua 提示词', 'lua-formatted': 'Lua 格式文字', 'lua-long-string': 'Lua 长文本', 'lua-language': '语言设置', 'lua-button': 'Lua 按钮文字', 'lua-attribute': 'Lua 属性文字', 'lua-text-node': 'Lua 页面文字', 'lorebook-key-alias': '关键词中文别名', 'structured-text': '结构化文本片段', 'protocol-field': '协议文字槽位', 'resource-json': '资源 JSON 可见文字',
};

export function riskLabel(risk: Segment['riskLevel']): string {
  return ({ low: '低', medium: '中', high: '高' } as Record<Segment['riskLevel'], string>)[risk];
}
