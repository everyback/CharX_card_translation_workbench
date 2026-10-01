import { MoreHorizontal, Trash2, ChevronDown, FileUp, FolderOpen, Info, Languages, Library, LoaderCircle, Plug, Settings } from 'lucide-react';
import { useEffect, useState, type RefObject } from 'react';
import type { ProjectSummary, Settings as WorkbenchSettings, Tab } from '@/shared/types';
import { latestProjectVersions } from '@/pages/workbench/model/project-library';

interface WorkbenchSidebarProps {
  projects: ProjectSummary[];
  selectedProjectId: string;
  tab: Tab;
  busy: string;
  settings: WorkbenchSettings | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onDeleteProjectFamily?: (project: ProjectSummary) => void;
  onSelectProject: (id: string) => void;
  onTabChange: (tab: Tab) => void;
  onImportFiles: (files: File[]) => void;
  onOpenSettings: () => void;
}

export function WorkbenchSidebar({ projects, selectedProjectId, tab, busy, settings, fileInputRef, onSelectProject, onTabChange, onImportFiles, onOpenSettings, onDeleteProjectFamily }: WorkbenchSidebarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);
  useEffect(() => { setMobileOpen(false); }, [tab, selectedProjectId]);
  const selected = projects.find(item => item.id === selectedProjectId);
  const modelReady = Boolean(settings?.apiKeyConfigured && settings.model);
  const latest = latestProjectVersions(projects);

  return <aside className={`sidebar workbench-sidebar ${mobileOpen ? 'mobile-open' : ''}`}>
    <button className="brand-row" onClick={() => onTabChange('library')} aria-label="CardLoom 项目库">
      <span className="brand-mark"><Languages size={21} /></span><span className="brand-copy"><strong>CardLoom<span>Translate</span></strong><small>卡片翻译工作台</small></span>
    </button>
    <button className="mobile-nav-toggle" aria-expanded={mobileOpen} aria-controls="workbench-navigation" onClick={() => setMobileOpen(value => !value)}>导航<ChevronDown size={15} /></button>
    <div className="sidebar-primary">
      <button className={`workbench-nav-item ${tab === 'library' ? 'active' : ''}`} aria-current={tab === 'library' ? 'page' : undefined} onClick={() => onTabChange('library')}><Library size={17} /><span>项目库</span><small>{latest.length}</small></button>
      <button className="import-button" onClick={() => fileInputRef.current?.click()} disabled={busy === 'import'}>{busy === 'import' ? <LoaderCircle className="spin" size={16} /> : <FileUp size={16} />}导入卡片 / 模块</button>
    </div>
    <input ref={fileInputRef} className="hidden-input" type="file" multiple accept=".json,.png,.charx,.risum,application/json,image/png,application/x-charx,application/octet-stream" onChange={event => { const files = Array.from(event.target.files ?? []); if (files.length) onImportFiles(files); event.target.value = ''; }} />
    <div className="sidebar-scroll" id="workbench-navigation">
      <nav className="workbench-nav-group recent-projects" aria-label="项目导航"><span>我的项目</span>{[...latest].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => {
        const active = Boolean(selected && (selected.familyId || selected.id) === (project.familyId || project.id));
        return <div className="sidebar-project-row" key={project.id}><button className={`workbench-nav-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} key={project.id} onClick={() => onSelectProject(active ? selectedProjectId : project.id)} title={project.translatedName || project.originalName}><FolderOpen size={16} /><span>{project.translatedName || project.originalName || project.name}</span>{(project.versionCount || 1) > 1 && <small>{project.versionCount} 版</small>}</button>{onDeleteProjectFamily && <details className="sidebar-project-menu" onKeyDown={event => { if (event.key === 'Escape') event.currentTarget.open = false; }}><summary aria-label={`${project.translatedName || project.originalName || project.name} 项目操作`}><MoreHorizontal size={17} /></summary><button disabled={Boolean(busy)} onClick={event => { event.currentTarget.closest('details')?.removeAttribute('open'); onDeleteProjectFamily(project); }}><Trash2 size={14} />删除整个项目<small>全部 {project.versionCount || 1} 个版本</small></button></details>}</div>;
      })}{!projects.length && <p>导入后，项目会显示在这里。</p>}</nav>
    </div>
    <nav className="sidebar-footer" aria-label="全局工具">
      <button className={`workbench-nav-item ${tab === 'plugins' ? 'active' : ''}`} aria-current={tab === 'plugins' ? 'page' : undefined} onClick={() => onTabChange('plugins')}><Plug size={17} /><span>插件与补丁</span></button>
      <button className={`workbench-nav-item ${tab === 'about' ? 'active' : ''}`} aria-current={tab === 'about' ? 'page' : undefined} onClick={() => onTabChange('about')}><Info size={17} /><span>关于工作台</span></button>
      <button className="sidebar-model" onClick={onOpenSettings}><Settings size={17} /><span><strong>模型设置</strong><small title={settings?.model || ''}>{modelReady ? settings?.model : '配置模型以开始翻译'}</small></span><i className={`provider-dot ${modelReady ? 'ready' : ''}`} aria-label={modelReady ? '模型已配置' : '模型未配置'} /></button>
    </nav>
  </aside>;
}
