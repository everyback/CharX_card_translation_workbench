import type { ComponentProps } from 'react';
import { GuidedWorkflow } from './workflow/GuidedWorkflow';
import type { ProjectDetail, ScopePreset, Settings, Tab } from '@/shared/types';
import { ProjectStats } from '../tabs/overview/ProjectStats';
import { ProjectWarningStrip } from './ProjectWarningStrip';
import { TranslationCommandBar } from '@/features/translation/ui/TranslationCommandBar';
import { ExportPage } from '../tabs/export/ExportPage';
import { SlidersHorizontal } from 'lucide-react';
import { WorkspaceTabContent, type WorkspaceTabContentProps } from './WorkspaceTabContent';
import { PresetWorkspace, type PresetWorkspaceProps } from './preset/PresetWorkspace';
import { WorkbenchTabs } from '@/layouts/workbench/components/WorkbenchTabs';
import { ProjectVersionBar } from './ProjectVersionBar';
import { VersionsPage } from '../tabs/versions/VersionsPage';

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
  versions: Omit<ComponentProps<typeof ProjectVersionBar>, 'project'>;
  onTabChange: (tab: Tab) => void;
  onReviewField: (id: string) => void;
  onReuseVersionTranslations: () => Promise<void>;
  /** Present for SillyTavern preset projects, which get a conversion-only surface. */
  preset?: Omit<PresetWorkspaceProps, 'projectId' | 'projectName'>;
}

export function ProjectWorkspace({
  project,
  tab,
  workflow,
  commandBar,
  content,
  preset,
  versions,
  onTabChange,
  onReviewField,
  onReuseVersionTranslations,
}: ProjectWorkspaceProps) {
  // A SillyTavern preset is converted, not translated: no scan, review, glossary,
  // protocol or script surface applies to it.
  const navigation = <><ProjectVersionBar key={project.id} project={project} {...versions} /><WorkbenchTabs tab={tab} preset={project.sourceFormat === 'st-preset'} onChange={onTabChange} /></>;
  const versionPage = tab === 'versions' && <VersionsPage key={`versions-${project.id}`} project={project} busy={versions.busy} onReuse={onReuseVersionTranslations} onSelect={versions.onSelect} onTabChange={onTabChange} onReviewField={onReviewField} />;
  if (project.sourceFormat === 'st-preset' && preset) {
    return (
      <>{navigation}{versionPage}<div hidden={tab === 'versions'}><PresetWorkspace
        projectId={project.id}
        projectName={project.translatedName || project.originalName || project.name}
        {...preset}
      /></div></>
    );
  }

  return (
    <>
      {navigation}
      {versionPage}
      {tab === 'overview' && <div className="project-overview-dashboard">
        <GuidedWorkflow {...workflow} />
        <ProjectStats project={project} />
        <ProjectWarningStrip project={project} />
        <details className="overview-translation-settings"><summary><SlidersHorizontal size={16} />翻译范围与语言设置<span>按需调整</span></summary><TranslationCommandBar {...commandBar} /></details>
      </div>}
      {tab === 'segments' && <TranslationCommandBar {...commandBar} />}
      {tab === 'export' && <ExportPage project={project} busy={workflow.busy} onReview={workflow.onOpenReview} onJobs={workflow.onOpenJobs} onScripts={workflow.onOpenLuaManagement} onApplyDraft={workflow.onApplyDraft} onSaveAndExport={workflow.onSaveAndExport} />}
      <WorkspaceTabContent key={project.id} tab={tab} {...content} />
    </>
  );
}
