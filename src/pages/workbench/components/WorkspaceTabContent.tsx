import { memo, useEffect, useState, type ComponentProps } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { Tab } from '@/shared/types';
import { ProjectOverviewPage } from '../tabs/overview/ProjectOverviewPage';
import { GlossaryPage } from '../tabs/glossary/GlossaryPage';
import { JobsPage } from '../tabs/jobs/JobsPage';
import { LuaPage } from '../tabs/lua/LuaPage';
import { ProtocolsPage } from '../tabs/protocols/ProtocolsPage';
import { ReferencesPage } from '../tabs/references/ReferencesPage';
import { ResourcesPage } from '../tabs/resources/ResourcesPage';
import { ReviewPage } from '../tabs/review/ReviewPage';
import { SegmentsPage } from '../tabs/segments/SegmentsPage';

export interface WorkspaceTabContentProps {
  tab: Exclude<Tab, 'about'>;
  overview: ComponentProps<typeof ProjectOverviewPage>;
  segments: ComponentProps<typeof SegmentsPage>;
  jobs: ComponentProps<typeof JobsPage>;
  review: ComponentProps<typeof ReviewPage>;
  glossary: ComponentProps<typeof GlossaryPage>;
  references: ComponentProps<typeof ReferencesPage>;
  protocols: ComponentProps<typeof ProtocolsPage>;
  lua: ComponentProps<typeof LuaPage>;
  resources: ComponentProps<typeof ResourcesPage>;
}

type WorkspaceTab = Exclude<Tab, 'about'>;
const TAB_ORDER: WorkspaceTab[] = ['overview', 'segments', 'jobs', 'review', 'glossary', 'references', 'protocols', 'lua', 'resources'];

function renderTabContent(tab: WorkspaceTab, content: Omit<WorkspaceTabContentProps, 'tab'>) {
  switch (tab) {
    case 'overview':
      return <ProjectOverviewPage {...content.overview} />;
    case 'segments':
      return <SegmentsPage {...content.segments} />;
    case 'jobs':
      return <JobsPage {...content.jobs} />;
    case 'review':
      return <ReviewPage {...content.review} />;
    case 'glossary':
      return <GlossaryPage {...content.glossary} />;
    case 'references':
      return <ReferencesPage {...content.references} />;
    case 'protocols':
      return <ProtocolsPage {...content.protocols} />;
    case 'lua':
      return <LuaPage {...content.lua} />;
    case 'resources':
      return <ResourcesPage {...content.resources} />;
    default:
      return null;
  }
}

const RetainedPane = memo(function RetainedPane({ active, tab, content }: { active: boolean; tab: WorkspaceTab; content: Omit<WorkspaceTabContentProps, 'tab'> }) {
  return <div className="workspace-tab-pane" aria-label={tab} hidden={!active}>{renderTabContent(tab, content)}</div>;
}, (previous, next) => !previous.active && !next.active);

export function WorkspaceTabContent({
  tab,
  overview,
  segments,
  jobs,
  review,
  glossary,
  references,
  protocols,
  lua,
  resources,
}: WorkspaceTabContentProps) {
  const [readyTab, setReadyTab] = useState<WorkspaceTab | null>(null);
  const pending = (tab === 'segments' || tab === 'jobs') && readyTab !== tab;
  useEffect(() => {
    // Give the browser a paint before mounting a potentially expensive page.
    const first = requestAnimationFrame(() => { second = requestAnimationFrame(() => setReadyTab(tab)); });
    let second = 0;
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [tab]);
  const [mountedTabs, setMountedTabs] = useState<Set<WorkspaceTab>>(() => new Set(tab === 'segments' || tab === 'jobs' ? [] : [tab]));

  useEffect(() => {
    if (!pending) setMountedTabs((current) => current.has(tab) ? current : new Set([...current, tab]));
  }, [tab, pending]);

  const content = { overview, segments, jobs, review, glossary, references, protocols, lua, resources };
  const tabsToRender = TAB_ORDER.filter((candidate) => candidate === tab || mountedTabs.has(candidate));
  return <>
    {pending && <div className="tab-loading-status" role="status" aria-live="polite"><LoaderCircle className="spin" size={20} /><div><strong>{tab === 'segments' ? '正在准备翻译内容…' : '正在准备翻译任务…'}</strong><p>{tab === 'segments' ? `正在整理 ${segments.segments.length} 条段落，完成后分页面显示。` : '正在整理任务进度与运行日志，请稍候。'}</p></div></div>}
    {tabsToRender.filter(candidate => !(pending && candidate === tab && !mountedTabs.has(candidate))).map((candidate) => (
      <RetainedPane key={candidate} active={candidate === tab && !pending} tab={candidate} content={content} />
    ))}
  </>;
}
