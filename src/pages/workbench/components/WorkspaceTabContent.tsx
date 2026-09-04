import type { ComponentProps } from 'react';
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
  switch (tab) {
    case 'overview':
      return <ProjectOverviewPage {...overview} />;
    case 'segments':
      return <SegmentsPage {...segments} />;
    case 'jobs':
      return <JobsPage {...jobs} />;
    case 'review':
      return <ReviewPage {...review} />;
    case 'glossary':
      return <GlossaryPage {...glossary} />;
    case 'references':
      return <ReferencesPage {...references} />;
    case 'protocols':
      return <ProtocolsPage {...protocols} />;
    case 'lua':
      return <LuaPage {...lua} />;
    case 'resources':
      return <ResourcesPage {...resources} />;
    default:
      return null;
  }
}
