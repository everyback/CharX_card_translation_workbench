import { BookOpen, Images, Code, ListChecks, Link } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Tab } from '@/shared/types';
import { PAGE_META, PROJECT_NAVIGATION } from '@/pages/workbench/model/navigation';

export function WorkbenchTabs({ tab, preset, onChange }: { tab: Tab; preset?: boolean; onChange: (tab: Tab) => void }) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const revealActive = () => {
      const active = list.querySelector<HTMLButtonElement>('[aria-current="page"]');
      if (!active) return;
      const bounds = list.getBoundingClientRect();
      const target = active.getBoundingClientRect();
      if (target.left < bounds.left) list.scrollLeft += target.left - bounds.left;
      else if (target.right > bounds.right) list.scrollLeft += target.right - bounds.right;
    };
    revealActive();
    const observer = new ResizeObserver(revealActive);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tab, preset]);
  const toolItems = PROJECT_NAVIGATION.slice(1).flatMap(group => group.items);
  const isTool = toolItems.includes(tab as typeof toolItems[number]);
  const lastWorkflow = useRef<Tab>('overview');
  const lastTool = useRef<Tab>('glossary');
  useEffect(() => { if (isTool) lastTool.current = tab; else if (PROJECT_NAVIGATION[0].items.includes(tab as typeof toolItems[number])) lastWorkflow.current = tab; }, [tab, isTool]);
  const main = preset ? ['overview', 'versions'] as const : PROJECT_NAVIGATION[0].items;
  const icons = { glossary: BookOpen, resources: Images, lua: Code, protocols: ListChecks, references: Link };
  return <nav className="project-tabs" aria-label="项目工作视图">
    {!preset && <div className="project-workspace-switch" aria-label="工作区"><button aria-pressed={!isTool} onClick={() => onChange(lastWorkflow.current)}>翻译工作区</button><button aria-pressed={isTool} onClick={() => onChange(lastTool.current)}>项目工具</button></div>}
    {!isTool && <div className="project-tab-list" ref={listRef}>{main.map(item => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => onChange(item)}>{preset && item === 'overview' ? '预设转换' : PAGE_META[item].title}</button>)}</div>}
    {!preset && isTool && <div className="project-tools-bar" aria-label="项目工具">{PROJECT_NAVIGATION.slice(1).map(group => <section key={group.label} aria-label={group.label}><span>{group.label}</span>{group.items.map(item => {
      const Icon = icons[item as keyof typeof icons];
      return <button key={item} aria-current={tab === item ? 'page' : undefined} title={PAGE_META[item].description} onClick={() => onChange(item)}><Icon size={16} />{PAGE_META[item].title}</button>;
    })}</section>)}</div>}

  </nav>;
}
