import { Button } from '@/shared/ui/button/Button';
import { useEffect, useState } from 'react';
import { ArrowRight, GitBranch, RefreshCw } from 'lucide-react';
import type { ProjectDetail, Tab } from '@/shared/types';
import { api } from '@/shared/api/http';
import { formatTime } from '@/shared/lib/format';

type Change = 'unchanged' | 'changed' | 'added' | 'removed' | 'ambiguous';
interface VersionReport {
  versions: Array<{ id: string; versionNumber: number; versionLabel: string; baseVersionId: string | null; sourceFilename: string | null; createdAt: string }>;
  baseVersionId: string | null; baseVersionLabel: string | null; compatible: boolean; scanned: boolean; baseScanned: boolean;
  counts: Record<Change | 'reused', number>; total: number; offset: number; limit: number;
  reusableCount: number; activeJob: boolean;
  fields: Array<{ segmentId: string | null; pathLabel: string; status: Change; reused: boolean; sourceText: string | null; previousSourceText: string | null; previousTranslation: string | null }>;
}
const LABELS = { all: '全部字段', reused: '已复用', unchanged: '原文未变', changed: '原文改变', added: '新增', removed: '移除', ambiguous: '待确认匹配' };

export function VersionsPage({ project, busy, onReuse, onSelect, onTabChange, onReviewField }: { project: ProjectDetail; busy: string; onReuse(): Promise<void>; onSelect(id: string): void; onTabChange(tab: Tab): void; onReviewField(id: string): void }) {
  const [report, setReport] = useState<VersionReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const preset = project.sourceFormat === 'st-preset';
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<VersionReport>(`/api/projects/${project.id}/versions?offset=${offset}&filter=${filter}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setReport(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : String(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [project.id, project.updatedAt, project.segments.length, filter, offset, revision]);
  return <section className="version-history">
    <div className="version-section-title"><div><h2>每次更新，都有迹可循</h2><p>各版本独立保存原始内容、译文与审核结果。</p></div><Button variant="outline" disabled={loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={14} />刷新</Button></div>
    {error && <p role="alert">{error}</p>}
    {loading && <p role="status">正在比较版本字段…</p>}
    {report && <>
      <div className="version-timeline">{report.versions.map(version => <button key={version.id} className={version.id === project.id ? 'active' : ''} aria-current={version.id === project.id ? 'true' : undefined} onClick={() => onSelect(version.id)}><GitBranch size={17} /><strong>{version.versionLabel}</strong><small>{version.id === project.id ? '当前查看' : `版本 ${version.versionNumber}`}</small><span title={version.sourceFilename || ''}>{version.sourceFilename || 'JSON 导入'}</span><time>{formatTime(version.createdAt)}</time></button>)}</div>
      {!report.baseVersionId ? <div className="version-first"><h3>这是项目的初始版本</h3><p>下次卡片更新时，使用上方“导入新版本”。工作台将比较字段并复用已有译文。</p></div> : <>
        <div className="version-comparison-heading"><h3>{report.baseVersionLabel} <ArrowRight size={16} /> {project.versionLabel}</h3>{!preset && <><Button variant="outline" onClick={() => onTabChange('segments')}>翻译剩余内容</Button><Button variant="outline" onClick={() => onReviewField(project.segments.find(segment => segment.reviewStatus === 'pending')?.id || '')}>审核复用译文</Button></>}</div>
        {!report.scanned && <p className="version-note">当前版本尚未扫描。到“翻译内容”扫描后，即可比较与复用。</p>}
        {!report.baseScanned && <p className="version-note">基础版本尚无扫描记录，因此还没有可复用的字段译文。</p>}
        {!report.compatible && <p className="version-note">两个版本的语言设置不同，未自动复用旧译文。</p>}
        {!preset && <div className="version-reuse-panel"><div><strong>旧版译文可以继续补入</strong><p>旧版后来补完翻译时，刷新后可复用到本版的空白字段。已有译文、人工稿和退回项保持原样。</p></div><Button variant="default" disabled={loading || Boolean(busy) || report.activeJob || report.reusableCount === 0} title={report.activeJob ? '请先结束当前翻译任务' : undefined} onClick={() => { void onReuse().then(() => setRevision(value => value + 1)); }}>{busy === 'reuse-version' ? '正在复用…' : `补用旧版译文 · ${report.reusableCount}`}</Button></div>}
        <p className="version-note">复用译文需要在本版本审核后才能导出；原文改变时，旧译文仅供对照。无法确定身份的条目按新增 / 移除或待确认匹配处理。</p>
        <div className="version-filters">{Object.entries(LABELS).map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? 'active' : ''} onClick={() => { setFilter(key); setOffset(0); }}>{label}<b>{key === 'all' ? Object.entries(report.counts).filter(([key]) => key !== 'reused').reduce((sum, [, count]) => sum + count, 0) : report.counts[key as keyof typeof report.counts]}</b></button>)}</div>
        <div className="version-differences" aria-busy={loading}>{report.fields.map((field, index) => <article key={`${field.segmentId}-${index}`}><header><span className={`version-change change-${field.status}`}>{field.reused ? '已复用旧译文' : LABELS[field.status]}</span><code>{field.pathLabel}</code>{field.segmentId && <Button variant="outline" onClick={() => onReviewField(field.segmentId!)}>查看字段</Button>}</header><div className="version-field-columns"><div><span>上一版原文</span><pre>{field.previousSourceText ?? '—'}</pre></div><div><span>当前版原文</span><pre>{field.sourceText ?? '—'}</pre></div><div><span>上一版译文 · 供参考</span><pre>{field.previousTranslation ?? '暂无译文'}</pre></div></div></article>)}</div>
        {!loading && !report.fields.length && <p className="version-first">该分类下暂无字段。</p>}
        <div className="version-pagination"><span>{report.total ? offset + 1 : 0}–{Math.min(offset + report.limit, report.total)} / {report.total} 条</span><Button variant="outline" disabled={loading || offset === 0} onClick={() => setOffset(value => Math.max(0, value - report.limit))}>上一页</Button><Button variant="outline" disabled={loading || offset + report.limit >= report.total} onClick={() => setOffset(value => value + report.limit)}>下一页</Button></div>
      </>}
    </>}
  </section>;
}
