import { Button } from '@/shared/ui/button/Button';
import { useRef, useState } from 'react';
import { FileUp, GitBranch, X } from 'lucide-react';
import type { ProjectDetail, ProjectSummary } from '@/shared/types';

export function ProjectVersionBar({ project, projects, busy, onSelect, onImport }: {
  project: ProjectDetail; projects: ProjectSummary[]; busy: string;
  onSelect(id: string): void; onImport(file: File, label: string): Promise<void>;
}) {
  const [importing, setImporting] = useState(false);
  const versions = projects.filter(item => (item.familyId || item.id) === (project.familyId || project.id)).sort((a, b) => (b.versionNumber || 1) - (a.versionNumber || 1));
  const options = versions.some(item => item.id === project.id) ? versions : [project, ...versions];
  return <div className="project-version-area">
    <div className="project-version-bar"><div><GitBranch size={16} /><label htmlFor="project-version">当前版本</label><select id="project-version" value={project.id} disabled={Boolean(busy)} onChange={event => onSelect(event.target.value)}>{options.map(item => <option key={item.id} value={item.id}>{item.versionLabel || 'V1'}{item.id === options[0]?.id ? ' · 最新' : ''}</option>)}</select><span>{options.length} 个版本</span>{project.id !== options[0]?.id && <b>历史版本</b>}</div><Button variant="outline" onClick={() => setImporting(value => !value)} disabled={Boolean(busy)} aria-expanded={importing}><FileUp size={15} />导入新版本</Button></div>
    {importing && <VersionImportForm key={project.id} project={project} busy={busy} onImport={onImport} onCancel={() => setImporting(false)} />}
  </div>;
}

export function VersionImportForm({ project, busy, onImport, onCancel }: {
  project: ProjectDetail; busy: string; onImport(file: File, label: string): Promise<void>; onCancel(): void;
}) {
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const disabled = Boolean(busy) || submitting;
  function selectFiles(files: File[]) {
    if (disabled || !files.length) return;
    if (files.length !== 1 || !/\.(json|png|charx|risum)$/i.test(files[0].name)) {
      setFile(null);
      setError(files.length !== 1 ? '每次请选择一个新版本文件。' : '请选择 JSON、PNG、CHARX 或 RISUM 文件。');
      return;
    }
    setFile(files[0]); setError('');
  }
  return <form className="version-import-form" aria-busy={disabled} onSubmit={async event => {
    event.preventDefault();
    if (!file || disabled || inFlight.current) return;
    inFlight.current = true; setSubmitting(true); setError('');
    try { await onImport(file, label); }
    catch (reason) { setError(reason instanceof Error ? reason.message : '导入失败，请重试。'); }
    finally { inFlight.current = false; setSubmitting(false); }
  }}>
      <div><strong>更新这张卡片</strong><p>以 {project.versionLabel || 'V1'} 为基础比较字段，沿用语言与术语设置。相同原文的旧译文会进入待审核。</p></div>
      <label>版本名称<input autoFocus disabled={disabled} maxLength={80} placeholder="例如 2.1 · 世界书更新（留空自动编号）" value={label} onChange={event => setLabel(event.target.value)} /></label>
      <div className="version-file-field"><span id="version-file-label">新版本文件</span>
        <div className={`version-file-dropzone${dragging ? ' is-dragging' : ''}`} role="group" aria-labelledby="version-file-label" aria-disabled={disabled}
          onDragEnter={event => { event.preventDefault(); event.stopPropagation(); if (!disabled) setDragging(true); }}
          onDragOver={event => { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = disabled ? 'none' : 'copy'; }}
          onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
          onDrop={event => { event.preventDefault(); event.stopPropagation(); setDragging(false); selectFiles(Array.from(event.dataTransfer.files)); }}>
          <FileUp size={24} aria-hidden="true" />
          <div className="version-file-copy" aria-live="polite"><strong>{file ? file.name : '拖动文件到这里'}</strong><span>{file ? `${(file.size / 1024 / 1024).toFixed(2)} MB · 已选择，点击下方导入并比较` : '支持 JSON、PNG、CHARX、RISUM · 每次一个文件'}</span></div>
          <input ref={input} hidden type="file" accept=".json,.png,.charx,.risum" disabled={disabled} aria-label="新版本文件" onChange={event => { selectFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
          <Button type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}><FileUp size={15} />{file ? '重新选择' : '选择文件'}</Button>
        </div>
        {error && <p className="version-file-error" role="alert">{error}</p>}
      </div>
      <div className="version-import-actions"><Button type="button" variant="outline" disabled={disabled} onClick={onCancel}><X size={14} />取消</Button><Button type="submit" variant="default" disabled={!file || disabled}>{disabled ? '正在处理…' : '导入并比较'}</Button></div>
    </form>;
}
