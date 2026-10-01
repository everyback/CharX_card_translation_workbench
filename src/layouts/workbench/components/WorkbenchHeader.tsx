import { Button } from '@/shared/ui/button/Button';
import { ChevronRight, Download, MoreHorizontal, Trash2 } from 'lucide-react';
import { STATUS_LABELS } from '@/entities/project/model/status-labels';
import type { ProjectDetail, Tab } from '@/shared/types';
import { PAGE_META } from '@/pages/workbench/model/navigation';
import { isIndependentTab } from '@/pages/workbench/model/routing';

interface WorkbenchHeaderProps {
  project: ProjectDetail | null;
  tab: Tab;
  busy: string;
  onOpenLibrary: () => void;
  onOpenExport: () => void;
  onDeleteProject: () => void;
}

export function WorkbenchHeader({ project, tab, busy, onOpenLibrary, onOpenExport, onDeleteProject }: WorkbenchHeaderProps) {
  const visibleProject = isIndependentTab(tab) ? null : project;
  const preset = visibleProject?.sourceFormat === 'st-preset';
  const title = preset && tab !== 'versions' ? '预设转换' : PAGE_META[tab].title;
  return <header className="workspace-header workbench-header">
    <div className="workspace-title-area">
      <nav className="workspace-breadcrumb" aria-label="当前位置"><button onClick={onOpenLibrary}>工作空间</button><ChevronRight size={13} />{visibleProject ? <><span title={visibleProject.originalName}>{visibleProject.translatedName || visibleProject.originalName || visibleProject.name}</span><ChevronRight size={13} /><span>{title}</span></> : <span>{title}</span>}</nav>
      <div className="workspace-heading-line"><h1>{title}</h1>{visibleProject && <span className={`status-badge status-${visibleProject.status}`}>{STATUS_LABELS[visibleProject.status] || visibleProject.status}</span>}</div>
      <p>{preset && tab !== 'versions' ? '编辑 SillyTavern 预设，并转换为 RisuAI 可用的格式。' : PAGE_META[tab].description}</p>
    </div>
    {visibleProject && <div className="header-actions">
      {!preset && <span className="header-language">{visibleProject.sourceLanguage}<span>→</span>{visibleProject.targetLanguage}</span>}
      {!preset && tab !== 'export' && <Button variant="outline" onClick={onOpenExport}><Download size={15} />导出</Button>}
      <details className="project-more-actions"><summary aria-label="项目操作" title="项目操作"><MoreHorizontal size={19} /></summary><div><button disabled={Boolean(busy)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onDeleteProject(); }}><Trash2 size={15} />删除当前版本</button></div></details>
    </div>}
  </header>;
}
