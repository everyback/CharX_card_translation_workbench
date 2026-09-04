import type { ScopePreset } from '@/shared/types';

export const DEFAULT_SCOPE: ScopePreset = 'all';

export const SCOPE_OPTIONS: Array<{ value: ScopePreset; label: string }> = [
  { value: 'all', label: '全部翻译（覆盖所有可翻译项）' },
  { value: 'core', label: '只翻角色主体' },
  { value: 'standard', label: '主体 + 世界书 + 问候语' },
  { value: 'visible-scripts', label: '包含脚本按钮 / 弹窗' },
  { value: 'all-visible', label: '完整可见内容 + Lua 提示词' },
  { value: 'lua-only', label: '仅 Lua 解析提取' },
];
