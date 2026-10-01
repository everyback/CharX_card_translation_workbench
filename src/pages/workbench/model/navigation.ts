import type { Tab } from '@/shared/types';

export type ProjectTab = Exclude<Tab, 'library' | 'plugins' | 'about'>;
export const PROJECT_NAVIGATION: Array<{ label: string; items: ProjectTab[] }> = [
  { label: '翻译流程', items: ['overview', 'segments', 'jobs', 'review', 'export', 'versions'] },
  { label: '内容管理', items: ['glossary', 'resources'] },
  { label: '高级工具', items: ['lua', 'protocols', 'references'] },
];

export const PAGE_META: Record<Tab, { title: string; description: string }> = {
  library: { title: '项目库', description: '管理你的卡片、模块与预设，继续未完成的翻译。' },
  overview: { title: '项目概览', description: '了解卡片结构，并从当前进度继续。' },
  segments: { title: '翻译内容', description: '选择翻译范围，检查字段与世界书，启动翻译。' },
  jobs: { title: '翻译任务', description: '跟踪翻译进度，处理重试与后台任务。' },
  review: { title: '对照审核', description: '对照原文、机器译文与最终稿，确认每一处修改。' },
  export: { title: '导出成品', description: '核对审核状态，保存并导出当前成果。' },
  versions: { title: '版本记录', description: '查看版本差异与译文来源，只翻译需要更新的内容。' },
  glossary: { title: '术语库', description: '统一角色名、专有名词与常用表达。' },
  resources: { title: '资源管理', description: '查看卡片中的图片、文件与本地化候选。' },
  lua: { title: '脚本管理', description: '检查 Lua、正则和运行时别名，处理兼容性问题。' },
  protocols: { title: '协议规则', description: '确认结构化文本的可翻译槽位与保护规则。' },
  references: { title: '引用检查', description: '核对变量、按钮触发器与资源引用。' },
  plugins: { title: '插件与补丁', description: '管理 RisuAI 兼容组件与安装核对。' },
  about: { title: '关于工作台', description: '项目介绍、作者说明与本地使用边界。' },
};
