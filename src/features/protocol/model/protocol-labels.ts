import type { ProtocolSchema, ProtocolStatus } from '@/shared/types';

export const PROTOCOL_STATUS_LABELS: Record<ProtocolStatus, string> = {
  pending: '待判断',
  analyzed: '模型已判断',
  approved: '已采用',
  ignored: '已忽略',
};

export const PROTOCOL_SOURCE_LABELS: Record<ProtocolSchema['source'], string> = {
  local: '卡片样本',
  'regex-lua': 'Risu 正则 + Lua',
  model: '模型判断',
  manual: '人工规则',
};
