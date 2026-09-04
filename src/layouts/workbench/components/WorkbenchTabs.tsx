import type { Tab } from '@/shared/types';

const TABS: Array<{ id: Exclude<Tab, 'about'>; label: string }> = [
  { id: 'overview', label: '概要' },
  { id: 'segments', label: '字段' },
  { id: 'jobs', label: '任务' },
  { id: 'review', label: '审核' },
  { id: 'glossary', label: '术语库' },
  { id: 'references', label: '引用' },
  { id: 'protocols', label: '协议' },
  { id: 'lua', label: '脚本管理' },
  { id: 'resources', label: '资源' },
];

export function WorkbenchTabs({ tab, onChange }: { tab: Tab; onChange: (tab: Exclude<Tab, 'about'>) => void }) {
  return (
    <div className="tab-row" role="tablist">
      {TABS.map((item) => (
        <button key={item.id} className={tab === item.id ? 'active' : ''} onClick={() => onChange(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}
