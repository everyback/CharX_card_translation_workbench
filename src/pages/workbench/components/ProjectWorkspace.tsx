import type { ComponentProps } from 'react';
import { GuidedWorkflow } from './workflow/GuidedWorkflow';
import type { ProjectDetail, ScopePreset, Settings, Tab } from '@/shared/types';
import { ProjectStats } from '../tabs/overview/ProjectStats';
import { ProjectWarningStrip } from './ProjectWarningStrip';
import { TranslationCommandBar } from '@/features/translation/ui/TranslationCommandBar';
import { WorkbenchTabs } from '@/layouts/workbench/components/WorkbenchTabs';
import { WorkspaceTabContent, type WorkspaceTabContentProps } from './WorkspaceTabContent';
import { PresetWorkspace, type PresetWorkspaceProps } from './preset/PresetWorkspace';

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
  /** Present for SillyTavern preset projects, which get a conversion-only surface. */
  preset?: Omit<PresetWorkspaceProps, 'projectId' | 'projectName'>;
}

export function ProjectWorkspace({
  project,
  tab,
  workflow,
  commandBar,
  content,
  onTabChange,
  preset,
}: ProjectWorkspaceProps) {
  // A SillyTavern preset is converted, not translated: no scan, review, glossary,
  // protocol or script surface applies to it.
  if (project.sourceFormat === 'st-preset' && preset) {
    return (
      <PresetWorkspace
        projectId={project.id}
        projectName={project.translatedName || project.originalName || project.name}
        {...preset}
      />
    );
  }

  return (
    <>
      <GuidedWorkflow {...workflow} />
      <ProjectStats project={project} />
      <ProjectWarningStrip project={project} />
      {tab !== 'review' && <TranslationCommandBar {...commandBar} />}
      <WorkbenchTabs tab={tab} onChange={onTabChange} />
      <WorkspaceTabContent key={project.id} tab={tab} {...content} />
    </>
  );
}
