import type { ResourceItem } from '@/shared/types';

export const RESOURCE_KIND_LABELS: Record<ResourceItem['kind'], string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
  font: '字体',
  data: '数据',
  other: '其他',
};

export const RESOURCE_RISK_LABELS: Record<ResourceItem['textRisk'], string> = {
  none: '无文字风险',
  path: '路径疑似含文字',
  unknown: '图片文字待确认',
};
