import { Check, CircleAlert, Download, FileImage, Languages, Link2, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, jsonBody } from '../../api';
import { LoadingMask, Stat } from '../../components/ui';
import type { ResourceImageCandidate, ResourceInspection, ResourceItem } from '../../types';
import { formatBytes } from '../../utils/format';

export function ResourcesView({
  inspection,
  loading,
  onRefresh,
  projectId,
}: {
  inspection: ResourceInspection | null;
  loading: boolean;
  onRefresh: () => void;
  projectId: string;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | ResourceItem['kind']>('all');
  const [risk, setRisk] = useState<'all' | ResourceItem['textRisk']>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageCandidate, setImageCandidate] = useState<ResourceImageCandidate | null>(null);
  const [imageError, setImageError] = useState('');
  const labels: Record<string, string> = { image: '图片', audio: '音频', video: '视频', font: '字体', data: '数据', other: '其他' };
  const riskLabels: Record<string, string> = { none: '无文字风险', path: '路径疑似含文字', unknown: '图片文字待确认' };
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (inspection?.resources ?? []).filter((resource) => (
      (kind === 'all' || resource.kind === kind)
      && (risk === 'all' || resource.textRisk === risk)
      && (!normalized || [resource.path, resource.displayName, resource.detectedFormat, resource.declaredType, resource.sha256, resource.languageHint, ...resource.references.map((reference) => `${reference.pathLabel} ${reference.sample}`)]
        .some((value) => String(value ?? '').toLowerCase().includes(normalized)))
    ));
  }, [inspection?.resources, kind, query, risk]);
  const current = filtered.find((resource) => resource.path === selected) ?? filtered[0] ?? null;
  useEffect(() => {
    if (!current || current.path !== selected) setSelected(current?.path ?? null);
  }, [current?.path, selected]);

  useEffect(() => {
    setImageCandidate(current?.imageCandidate ?? null);
    setImageError('');
  }, [current?.path, current?.imageCandidate?.updatedAt]);

  async function generateImageCandidate() {
    if (!current || current.kind !== 'image' || imageBusy) return;
    setImageBusy(true);
    setImageError('');
    try {
      const candidate = await api<ResourceImageCandidate & { path: string }>(`/api/projects/${projectId}/resources/image-edit`, {
        method: 'POST',
        ...jsonBody({ path: current.path }),
      });
      setImageCandidate(candidate);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  }

  async function setImageCandidateStatus(status: ResourceImageCandidate['status']) {
    if (!current || !imageCandidate || imageBusy) return;
    setImageBusy(true);
    setImageError('');
    try {
      const result = await api<{ status: ResourceImageCandidate['status']; updatedAt: string }>(`/api/projects/${projectId}/resources/image-edit`, {
        method: 'PATCH',
        ...jsonBody({ path: current.path, status }),
      });
      setImageCandidate({ ...imageCandidate, status: result.status, updatedAt: result.updatedAt });
      void onRefresh();
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  }

  if (!inspection) {
    return <section className="resource-workspace"><div className="resource-empty"><FileImage size={38} /><h2>资源工作台</h2><p>点击“刷新资源”扫描卡片图片、音频、视频、字体和数据文件。</p><button className="primary-button" onClick={onRefresh}><Search size={16} />扫描资源</button></div>{loading && <LoadingMask label="正在读取资源" />}</section>;
  }

  return (
    <section className="resource-workspace">
      {loading && <LoadingMask label="正在读取资源" />}
      <div className="resource-summary">
        <Stat icon={<FileImage size={17} />} label="资源总数" value={inspection.summary.total} />
        <Stat icon={<Languages size={17} />} label="图片" value={inspection.summary.images} />
        <Stat icon={<Link2 size={17} />} label="已有引用" value={inspection.summary.referenced} />
        <button className="secondary-button resource-refresh" onClick={onRefresh}><RefreshCw size={15} />重新扫描</button>
      </div>
      <div className="resource-toolbar">
        <div className="search-input"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资源名、哈希或引用" /></div>
        <select value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">全部类型</option>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}><option value="all">全部风险</option>{Object.entries(riskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <span>{filtered.length} / {inspection.resources.length} 个资源</span>
      </div>
      <div className="resource-layout">
        <div className="resource-list">
          {filtered.map((resource) => (
            <button key={resource.path} className={resource.path === current?.path ? 'active' : ''} onClick={() => setSelected(resource.path)}>
              <span className={`resource-kind resource-kind-${resource.kind}`}>{labels[resource.kind]}</span>
              <strong title={`${resource.displayName}\n内部路径：${resource.path}`}>{resource.displayName}</strong>
              <small>{resource.width && resource.height ? `${resource.width}×${resource.height} · ` : ''}{formatBytes(resource.size)}{resource.languageHint ? ` · ${resource.languageHint}` : ''}</small>
            </button>
          ))}
          {!filtered.length && <div className="table-empty">没有匹配的资源</div>}
        </div>
        <div className="resource-detail">
          {current ? <>
            <div className="resource-detail-heading"><div><span>{labels[current.kind]} · {riskLabels[current.textRisk]}</span><h2 title={current.displayName}>{current.displayName}</h2>{current.path !== current.displayName && <small>内部资源：{current.path}</small>}</div><a className="secondary-button" href={`/api/projects/${projectId}/resources/file?path=${encodeURIComponent(current.path)}&name=${encodeURIComponent(current.displayName)}`} download={current.displayName}><Download size={15} />下载</a></div>
            {current.kind === 'image' && current.size > 0 && <img className="resource-preview" src={`/api/projects/${projectId}/resources/file?path=${encodeURIComponent(current.path)}&name=${encodeURIComponent(current.displayName)}`} alt={current.displayName} />}
            <div className="resource-properties"><span>SHA-256 <code>{current.sha256 || '模块内资源暂未展开'}</code></span><span>识别格式 <code>{current.detectedFormat} · {current.mimeType}</code></span>{current.declaredType && <span>模块声明 <code>{current.declaredType}</code></span>}<span>尺寸 <code>{current.width && current.height ? `${current.width} × ${current.height}` : '未知'}</code></span></div>
            <div className="resource-review-card">
              <strong>翻译状态</strong>
              <p>{current.textRisk === 'unknown' ? '图片可能包含画面内文字，可按需生成 AI 图片替换稿并在导出前确认。' : current.textRisk === 'path' ? `文件名包含 ${current.languageHint} 文字，可在资源审核中确认是否需要保留原引用。` : '当前资源未从文件名检测到可疑文字。'}</p>
              {current.kind === 'image' ? <>
                <div className="resource-image-edit">
                  <div className="resource-mode-heading"><strong>AI 图片汉化</strong><span>直接替换画面文字</span></div>
                  <p>发送原图给独立图片编辑模型，只替换画面文字并保持构图。生成后先对比，确认后才写入导出包。</p>
                  <button className="secondary-button" onClick={() => void generateImageCandidate()} disabled={imageBusy}>
                    {imageBusy ? <LoaderCircle size={15} className="spin" /> : <FileImage size={15} />}
                    {imageBusy ? '正在生成替换稿…' : imageCandidate ? '重新生成 AI 替换稿' : '生成 AI 图片替换稿'}
                  </button>
                  {imageError && <div className="resource-ocr-error"><CircleAlert size={14} />{imageError}</div>}
                  {imageCandidate && <>
                    <div className="resource-image-comparison">
                      <figure><img src={`/api/projects/${projectId}/resources/file?path=${encodeURIComponent(current.path)}`} alt="原图" /><figcaption>原图</figcaption></figure>
                      <figure><img src={`/api/projects/${projectId}/resources/image-edit/file?path=${encodeURIComponent(current.path)}&v=${encodeURIComponent(imageCandidate.updatedAt)}`} alt="AI 图片替换稿" /><figcaption>AI 替换稿 · {imageCandidate.model}</figcaption></figure>
                    </div>
                    <div className="resource-ocr-actions">
                      <button className="secondary-button" onClick={() => void setImageCandidateStatus('draft')} disabled={imageBusy}>保留待审</button>
                      <button className="primary-button" onClick={() => void setImageCandidateStatus('confirmed')} disabled={imageBusy}><Check size={15} />确认用于导出</button>
                    </div>
                    <small>{imageCandidate.status === 'confirmed' ? '已确认：下次“保存”或“保存并导出”时会替换该资源。' : '当前为待审稿，不会进入导出文件。'}</small>
                  </>}
                </div>
              </> : <span className="resource-ocr-hint">当前资源类型无需图片汉化。</span>}
            </div>
            <div className="resource-references"><strong>引用位置（{current.references.length}）</strong>{current.references.length ? current.references.map((reference, index) => <div key={`${reference.pathLabel}:${index}`}><span>{reference.pathLabel}</span><code>{reference.sample}</code></div>) : <p>未发现卡片或模块中的直接引用。</p>}</div>
          </> : <div className="table-empty">选择一个资源查看详情</div>}
        </div>
      </div>
    </section>
  );
}
