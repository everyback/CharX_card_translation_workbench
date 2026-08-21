import { ArrowRight, Download, Save, Trash2 } from 'lucide-react';
import { STATUS_LABELS } from '../../constants';
import type { ProjectDetail } from '../../types';
import { formatTime } from '../../utils/format';

interface WorkbenchHeaderProps {
  project: ProjectDetail | null;
  busy: string;
  aboutActive?: boolean;
  onDeleteProject: () => void;
  onApplyDraft: () => void;
}

export function WorkbenchHeader({
  project,
  busy,
  aboutActive = false,
  onDeleteProject,
  onApplyDraft,
}: WorkbenchHeaderProps) {
  const visibleProject = aboutActive ? null : project;

  return (
    <header className="workspace-header">
      <div className="workspace-title-area">
        {visibleProject ? (
          <div className="project-title-comparison">
            <div className="project-title-block">
              <span>原文标题</span>
              <h1 title={visibleProject.originalName}>{visibleProject.originalName}</h1>
            </div>
            <ArrowRight className="title-direction" size={17} aria-hidden="true" />
            <div className="project-title-block translated">
              <span>翻译后标题</span>
              <h1 className={visibleProject.translatedName ? '' : 'title-pending'} title={visibleProject.translatedName || '尚未翻译'}>
                {visibleProject.translatedName || '尚未翻译'}
              </h1>
            </div>
          </div>
        ) : <h1>{aboutActive ? '关于卡片翻译工作台' : '卡片项目'}</h1>}
        <div className="header-meta">
          {visibleProject ? <>
            <span className={`status-badge status-${visibleProject.status}`}>{STATUS_LABELS[visibleProject.status] || visibleProject.status}</span>
            <span>{visibleProject.sourceLanguage} → {visibleProject.targetLanguage}</span>
            <span>更新于 {formatTime(visibleProject.updatedAt)}</span>
          </> : <span>{aboutActive ? '项目介绍、作者说明与本地使用边界' : '导入一张卡片开始工作'}</span>}
        </div>
      </div>
      <div className="header-actions">
        {visibleProject && <>
          <button className="icon-button danger-ghost" title="删除项目" onClick={onDeleteProject}><Trash2 size={17} /></button>
          <button className="secondary-button" onClick={onApplyDraft} disabled={busy === 'apply'}>
            <Save size={16} />生成审核稿
          </button>
          <a className={`primary-button ${visibleProject.status !== 'ready' ? 'disabled' : ''}`} href={`/api/projects/${visibleProject.id}/export`}>
            <Download size={16} />导出文件
          </a>
        </>}
      </div>
    </header>
  );
}
