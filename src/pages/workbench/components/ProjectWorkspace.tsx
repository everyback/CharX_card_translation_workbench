import type { ComponentProps } from 'react';
import { GuidedWorkflow } from './workflow/GuidedWorkflow';
import type { ProjectDetail, ScopePreset, Settings, Tab } from '@/shared/types';
import { ProjectStats } from '../tabs/overview/ProjectStats';
import { ProjectWarningStrip } from './ProjectWarningStrip';
import { TranslationCommandBar } from '@/features/translation/ui/TranslationCommandBar';
import { WorkbenchTabs } from '@/layouts/workbench/components/WorkbenchTabs';
import { WorkspaceTabContent, type WorkspaceTabContentProps } from './WorkspaceTabContent';

export interface ProjectWorkspaceProps {
  project: ProjectDetail;
  settings: Settings | null;
  scope: ScopePreset;
  busy: string;
  activeTranslationJob: boolean;
  tab: Exclude<Tab, 'about'>;
  workflow: ComponentProps<typeof GuidedWorkflow>;
  commandBar: ComponentProps<typeof TranslationCommandBar>;
  content: Omit<WorkspaceTabContentProps, 'tab'>;
  onTabChange: (tab: Exclude<Tab, 'about'>) => void;
}

export function ProjectWorkspace({
  project,
  tab,
  workflow,
  commandBar,
  content,
  onTabChange,
}: ProjectWorkspaceProps) {
  return (
    <>
      <GuidedWorkflow {...workflow} />
      <ProjectStats project={project} />
      <ProjectWarningStrip project={project} />
      <TranslationCommandBar {...commandBar} />
      <WorkbenchTabs tab={tab} onChange={onTabChange} />
      <WorkspaceTabContent tab={tab} {...content} />
    </>
  );
}
