import { useEffect, useState, type ComponentProps } from 'react';
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
  const [mountedTabs, setMountedTabs] = useState<Set<WorkspaceTab>>(() => new Set([tab]));

  useEffect(() => {
    setMountedTabs((current) => current.has(tab) ? current : new Set([...current, tab]));
  }, [tab]);

  const content = { overview, segments, jobs, review, glossary, references, protocols, lua, resources };
  const tabsToRender = TAB_ORDER.filter((candidate) => candidate === tab || mountedTabs.has(candidate));
  return <>
    {tabsToRender.map((candidate) => (
      <div key={candidate} className="workspace-tab-pane" hidden={candidate !== tab}>
        {renderTabContent(candidate, content)}
      </div>
    ))}
  </>;
}
