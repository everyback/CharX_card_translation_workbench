import {
  FileArchive,
  FileImage,
  FileJson,
  FileUp,
  FolderOpen,
  Info,
  Languages,
  LoaderCircle,
  Search,
  Settings as SettingsIcon,
} from 'lucide-react';
import { useMemo, useState, type RefObject } from 'react';
import { STATUS_LABELS } from '../../constants';
import type { ProjectSummary, Settings } from '../../types';

interface WorkbenchSidebarProps {
  projects: ProjectSummary[];
  selectedProjectId: string;
  busy: string;
  settings: Settings | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onSelectProject: (projectId: string) => void;
  onImportFiles: (files: File[]) => void;
  onOpenSettings: () => void;
  onOpenAbout: () => void;
  aboutActive: boolean;
}

export function WorkbenchSidebar({
  projects,
  selectedProjectId,
  busy,
  settings,
  fileInputRef,
  onSelectProject,
  onImportFiles,
  onOpenSettings,
  onOpenAbout,
  aboutActive,
}: WorkbenchSidebarProps) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = useMemo(() => projects.filter((item) => {
    if (!normalizedQuery) return true;
    return [item.name, item.originalName, item.translatedName]
      .filter((value): value is string => Boolean(value))
      .some((value) => value.toLowerCase().includes(normalizedQuery));
  }), [normalizedQuery, projects]);

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <div className="brand-mark"><Languages size={19} /></div>
        <div>
          <strong>卡片翻译工作台</strong>
          <span>本机任务与审核</span>
        </div>
      </div>

      <button className="import-button" onClick={() => fileInputRef.current?.click()} disabled={busy === 'import'}>
        {busy === 'import' ? <LoaderCircle className="spin" size={17} /> : <FileUp size={17} />}
        导入卡片 / 模块
      </button>
      <div className="project-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          aria-label="搜索卡片名称"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索卡片名称"
        />
      </div>
      <input
        ref={fileInputRef}
        className="hidden-input"
        type="file"
        multiple
        accept=".json,.png,.charx,.risum,application/json,image/png,application/x-charx,application/octet-stream"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length) onImportFiles(files);
          event.target.value = '';
        }}
      />
      <div className="sidebar-heading">
        <span>项目</span>
        <span>{normalizedQuery ? `${filteredProjects.length} / ${projects.length}` : projects.length}</span>
      </div>
      <nav className="project-list">
        {filteredProjects.map((item) => (
          <button
            key={item.id}
            className={`project-item ${item.id === selectedProjectId ? 'active' : ''}`}
            onClick={() => onSelectProject(item.id)}
          >
            <span className="project-icon">
              {item.sourceFormat === 'charx' || item.sourceFormat === 'risum'
                ? <FileArchive size={16} />
                : item.sourceFormat === 'png' ? <FileImage size={16} /> : <FileJson size={16} />}
            </span>
            <span className="project-copy">
              <span className="project-title-line translated" title={item.translatedName || '尚未翻译'}>
                <b>译</b><strong>{item.translatedName || '尚未翻译'}</strong>
              </span>
              <span className="project-title-line original" title={item.originalName}>
                <b>原</b><span>{item.originalName}</span>
              </span>
              <small>{item.segmentCount || 0} 段 · {STATUS_LABELS[item.status] || item.status}</small>
            </span>
            {item.pendingReviewCount > 0 && <span className="count-pill">{item.pendingReviewCount}</span>}
          </button>
        ))}
        {!filteredProjects.length && (
          <div className="empty-sidebar">
            <FolderOpen size={20} />
            {projects.length ? '没有匹配的卡片' : '尚无项目'}
          </div>
        )}
      </nav>

      <div className="sidebar-footer">
        <button className={`icon-text-button ${aboutActive ? 'active' : ''}`} onClick={onOpenAbout}>
          <Info size={16} />关于项目
        </button>
        <button className="icon-text-button" onClick={onOpenSettings}>
          <SettingsIcon size={16} />模型设置
        </button>
        <span className={`provider-dot ${settings?.apiKeyConfigured && settings.model ? 'ready' : ''}`} />
      </div>
    </aside>
  );
}
