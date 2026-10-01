import { Button } from '@/shared/ui/button/Button';
import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, ArrowRight, CheckCheck, FileArchive, FileJson, FileUp, FolderOpen, Layers3, Search, Settings2, ShieldCheck } from 'lucide-react';
import type { ProjectSummary, Settings } from '@/shared/types';
import { STATUS_LABELS } from '@/entities/project/model/status-labels';
import { formatTime } from '@/shared/lib/format';
import { filterLibraryProjects, latestProjectVersions, matchesLibraryFilter, type LibraryFilter, type LibrarySort } from '../model/project-library';
import { QuickStartView } from './workflow/QuickStartView';

const FILTERS = [
  { id: 'all', label: '全部项目', icon: Layers3 },
  { id: 'active', label: '进行中', icon: ArrowRight },
  { id: 'review', label: '需要审核', icon: ShieldCheck },
  { id: 'ready', label: '审核完成', icon: CheckCheck },
] as const;

export function ProjectLibrary({ projects: allVersions, settings, busy, onOpenProject, onImport, onOpenSettings }: {
  projects: ProjectSummary[]; settings: Settings | null; busy: string;
  onOpenProject: (id: string) => void; onImport: () => void; onOpenSettings: () => void;
}) {
  const [query, setQuery] = useState('');
  const projects = useMemo(() => latestProjectVersions(allVersions), [allVersions]);
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const [format, setFormat] = useState('all');
  const [sort, setSort] = useState<LibrarySort>('updated');
  const formats = useMemo(() => [...new Set(projects.map(project => project.sourceFormat))].sort(), [projects]);
  const filtered = useMemo(() => filterLibraryProjects(projects, query, filter, format, sort), [projects, query, filter, format, sort]);

  if (!projects.length) return <QuickStartView settings={settings} onImport={onImport} onOpenSettings={onOpenSettings} />;

  return <section className="project-library" aria-label="项目库">
    <div className="library-intro">
      <div><span className="section-eyebrow">你的翻译空间</span><h2>让故事跨越语言</h2><p>从卡片到世界书，让每一处译文都经过你的确认。</p></div>
      <Button variant="default" disabled={busy === 'import'} onClick={onImport}><FileUp size={16} />导入新项目</Button>
    </div>
    <div className="library-summary" aria-label="按进度筛选">
      {FILTERS.map(({ id, label, icon: Icon }) => <button key={id} aria-pressed={filter === id} className={filter === id ? 'active' : ''} onClick={() => setFilter(id)}>
        <span><Icon size={17} />{label}</span><strong>{projects.filter(project => matchesLibraryFilter(project, id)).length}</strong>
      </button>)}
    </div>
    <div className="library-toolbar">
      <label className="library-search"><Search size={17} /><input aria-label="搜索项目" placeholder="搜索原名或译名…" type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="文件格式" value={format} onChange={event => setFormat(event.target.value)}><option value="all">所有格式</option>{formats.map(value => <option key={value} value={value}>{value === 'st-preset' ? 'ST 预设' : value.toUpperCase()}</option>)}</select>
      <label className="library-sort"><ArrowDownWideNarrow size={15} /><select aria-label="项目排序" value={sort} onChange={event => setSort(event.target.value as LibrarySort)}><option value="updated">最近更新</option><option value="name">项目名称</option></select></label>
    </div>
    <div className="library-results-heading"><strong>{FILTERS.find(item => item.id === filter)?.label}</strong><span role="status">{filtered.length} 个项目</span></div>
    <div className="library-grid">
      {filtered.map(project => {
        const progress = project.segmentCount ? Math.min(100, Math.round(project.approvedCount / project.segmentCount * 100)) : 0;
        const isPreset = project.sourceFormat === 'st-preset';
        const Icon = isPreset ? Settings2 : ['charx', 'risum'].includes(project.sourceFormat) ? FileArchive : FileJson;
        return <button className="library-card" key={project.id} onClick={() => onOpenProject(project.id)}>
          <div className="library-card-top"><span className={`library-file-icon format-${project.sourceFormat}`}><Icon size={21} /></span><span className={`status-badge status-${project.status}`}>{STATUS_LABELS[project.status] || project.status}</span></div>
          <h3 title={project.translatedName || project.originalName}>{project.translatedName || project.originalName || project.name}</h3>
          <p title={project.originalName}>{project.versionLabel || 'V1'} · {project.versionCount || 1} 个版本{project.translatedName ? ` · ${project.originalName}` : ''}</p>
          <div className="library-card-progress"><span>{isPreset ? '预设转换' : `已审核 ${project.approvedCount} / ${project.segmentCount}`}</span><b>{isPreset ? 'ST → RisuAI' : `${progress}%`}</b></div>
          {!isPreset && <div className="library-progress-track" aria-hidden="true"><span style={{ width: `${progress}%` }} /></div>}
          <div className="library-card-bottom"><span>{isPreset ? 'ST 预设' : project.sourceFormat.toUpperCase()}<i />{formatTime(project.updatedAt)}</span><ArrowRight size={15} /></div>
          {project.pendingReviewCount > 0 && <span className="library-pending">{project.pendingReviewCount} 条译文待审核</span>}
        </button>;
      })}
    </div>
    {!filtered.length && <div className="library-empty"><FolderOpen size={32} /><h3>没有符合条件的项目</h3><p>试试其他名称，或重置筛选条件。</p><Button variant="outline" onClick={() => { setQuery(''); setFilter('all'); setFormat('all'); }}>重置筛选</Button></div>}
    <div className="library-footnote"><ShieldCheck size={15} />原始卡片始终保留，译文审核通过后才会写入导出文件。</div>
  </section>;
}
