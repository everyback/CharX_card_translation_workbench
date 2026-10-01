import { Button } from '@/shared/ui/button/Button';
import { Check, CircleAlert, Download, FileImage, Languages, Link2, LoaderCircle, RefreshCw, Search, Upload } from 'lucide-react';
import { useEffect, useMemo, useState, useRef } from 'react';
import { LoadingMask, Stat } from '@/shared/ui';
import type { ResourceImageCandidate, ResourceInspection, ResourceItem } from '@/shared/types';
import { formatBytes } from '@/shared/lib/format';
import {
  generateResourceImageCandidate,
  uploadResourceImageCandidate,
  resourceFileUrl,
  resourceImageCandidateUrl,
  setResourceImageCandidateStatus,
} from '@/features/resource/api/resource-image-api';
import { RESOURCE_KIND_LABELS, RESOURCE_RISK_LABELS } from './model/resource-labels';

export function ResourcesPage({
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
  const uploadInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | ResourceItem['kind']>('all');
  const [risk, setRisk] = useState<'all' | ResourceItem['textRisk']>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageCandidate, setImageCandidate] = useState<ResourceImageCandidate | null>(null);
  const [imageError, setImageError] = useState('');
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

  async function uploadImage(file: File) {
    if (!current || current.kind !== 'image' || imageBusy) return;
    setImageBusy(true);
    setImageError('');
    try {
      setImageCandidate(await uploadResourceImageCandidate(projectId, current.path, file));
      void onRefresh();
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  }

  async function generateImageCandidate() {
    if (!current || current.kind !== 'image' || imageBusy) return;
    setImageBusy(true);
    setImageError('');
    try {
      const candidate = await generateResourceImageCandidate(projectId, current.path);
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
      const result = await setResourceImageCandidateStatus(projectId, current.path, status);
      setImageCandidate({ ...imageCandidate, status: result.status, updatedAt: result.updatedAt });
      void onRefresh();
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setImageBusy(false);
    }
  }

  if (!inspection) {
    return <section className="resource-workspace"><div className="resource-empty"><FileImage size={38} /><h2>资源工作台</h2><p>点击“刷新资源”扫描卡片图片、音频、视频、字体和数据文件。</p><Button variant="default" onClick={onRefresh}><Search size={16} />扫描资源</Button></div>{loading && <LoadingMask label="正在读取资源" />}</section>;
  }

  return (
    <section className="resource-workspace">
      {loading && <LoadingMask label="正在读取资源" />}
      <div className="resource-summary">
        <Stat icon={<FileImage size={17} />} label="资源总数" value={inspection.summary.total} />
        <Stat icon={<Languages size={17} />} label="图片" value={inspection.summary.images} />
        <Stat icon={<Link2 size={17} />} label="已有引用" value={inspection.summary.referenced} />
        <Button variant="outline" className="resource-refresh" onClick={onRefresh}><RefreshCw size={15} />重新扫描</Button>
      </div>
      <div className="resource-toolbar">
        <div className="search-input"><Search size={15} /><input disabled={imageBusy} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资源名、哈希或引用" /></div>
        <select disabled={imageBusy} value={kind} onChange={(event) => setKind(event.target.value as typeof kind)}><option value="all">全部类型</option>{Object.entries(RESOURCE_KIND_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <select disabled={imageBusy} value={risk} onChange={(event) => setRisk(event.target.value as typeof risk)}><option value="all">全部风险</option>{Object.entries(RESOURCE_RISK_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
        <span>{filtered.length} / {inspection.resources.length} 个资源</span>
      </div>
      <div className="resource-layout">
        <div className="resource-list">
          {filtered.map((resource) => (
            <button disabled={imageBusy} key={resource.path} className={resource.path === current?.path ? 'active' : ''} onClick={() => setSelected(resource.path)}>
              <span className={`resource-kind resource-kind-${resource.kind}`}>{RESOURCE_KIND_LABELS[resource.kind]}</span>
              <strong title={`${resource.displayName}\n内部路径：${resource.path}`}>{resource.displayName}</strong>
              <small>{resource.width && resource.height ? `${resource.width}×${resource.height} · ` : ''}{formatBytes(resource.size)}{resource.languageHint ? ` · ${resource.languageHint}` : ''}</small>
            </button>
          ))}
          {!filtered.length && <div className="table-empty">没有匹配的资源</div>}
        </div>
        <div className="resource-detail">
          {current ? <>
            <header className="resource-detail-heading">
              <div><span>{RESOURCE_KIND_LABELS[current.kind]} · {RESOURCE_RISK_LABELS[current.textRisk]}</span><h2 title={current.displayName}>{current.displayName}</h2>{current.path !== current.displayName && <small>内部资源：{current.path}</small>}</div>
              <a className="secondary-button" href={resourceFileUrl(projectId, current.path, current.displayName)} download={current.displayName}><Download size={15} />下载原资源</a>
            </header>
            <div className="resource-detail-body">
              <section className="resource-preview-panel" aria-label="资源预览">
                <div className="resource-preview-heading"><strong>{imageCandidate ? '替换前后对比' : '资源预览'}</strong><span>{formatBytes(current.size)}{current.width && current.height ? ` · ${current.width} × ${current.height}` : ''}</span></div>
                {current.kind === 'image' && current.size > 0 ? <div className={`resource-image-comparison${imageCandidate ? '' : ' resource-image-single'}`}>
                  <figure><figcaption>原图</figcaption><div className="resource-image-stage"><img draggable={false} src={resourceFileUrl(projectId, current.path, current.displayName)} alt={current.displayName} /></div></figure>
                  {imageCandidate && <figure><figcaption>{imageCandidate.model === 'manual-upload' ? '手动上传替换稿' : `AI 替换稿 · ${imageCandidate.model}`}</figcaption><div className="resource-image-stage"><img draggable={false} src={resourceImageCandidateUrl(projectId, current.path, imageCandidate.updatedAt)} alt="图片替换稿" /></div></figure>}
                </div> : <div className="resource-preview-unavailable"><FileImage size={36} /><p>{current.kind === 'image' ? '模块内资源尚未展开，暂无法预览。' : '此类型暂不支持预览，可下载原资源查看。'}</p></div>}
              </section>
              <aside className="resource-inspector" aria-label="资源信息与审核">
                <section className="resource-review-card">
                  <div className="resource-review-heading"><strong>{current.kind === 'image' ? '图片替换' : '资源状态'}</strong>{current.kind === 'image' && <span className={`resource-status ${imageCandidate?.status === 'confirmed' ? 'is-confirmed' : ''}`}>{imageCandidate ? imageCandidate.status === 'confirmed' ? '已确认' : '待审核' : '使用原图'}</span>}</div>
                  <p>{current.kind === 'image' ? '上传替换图片或用 AI 翻译画面文字，对比确认后用于导出。原路径和引用保持不变。' : current.textRisk === 'path' ? `文件名包含 ${current.languageHint} 文字，请确认是否需要保留原引用。` : '当前资源无需图片翻译。'}</p>
                  {current.kind === 'image' && <>
                    <input ref={uploadInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      if (file) void uploadImage(file);
                    }} />
                    <div className="resource-replacement-actions">
                      <Button variant="outline" disabled={imageBusy} onClick={() => uploadInput.current?.click()}><Upload size={15} />上传替换图片</Button>
                      <Button variant="outline" onClick={() => void generateImageCandidate()} disabled={imageBusy}>
                        {imageBusy ? <LoaderCircle size={15} className="spin" /> : <Languages size={15} />}
                        {imageBusy ? '正在处理替换稿…' : imageCandidate ? '重新生成 AI 替换稿' : '生成 AI 图片替换稿'}
                      </Button>
                    </div>
                    {imageError && <div className="resource-image-error" role="alert"><CircleAlert size={14} />{imageError}</div>}
                    {imageCandidate && <div className="resource-approval">
                      <div className="resource-image-actions">
                        <Button variant="outline" onClick={() => void setImageCandidateStatus('draft')} disabled={imageBusy}>保留待审</Button>
                        <Button variant="default" onClick={() => void setImageCandidateStatus('confirmed')} disabled={imageBusy}><Check size={15} />确认用于导出</Button>
                      </div>
                      <p role="status">{imageCandidate.status === 'confirmed' ? '已确认：下次“保存”或“保存并导出”时会替换该资源。' : '当前为待审稿，不会进入导出文件。'}</p>
                    </div>}
                  </>}
                </section>
                <section className="resource-metadata"><strong>资源信息</strong>
                  <dl><div><dt>格式</dt><dd>{current.detectedFormat} · {current.mimeType}</dd></div><div><dt>文件大小</dt><dd>{formatBytes(current.size)}</dd></div><div><dt>尺寸</dt><dd>{current.width && current.height ? `${current.width} × ${current.height}` : '未知'}</dd></div>{current.declaredType && <div><dt>模块声明</dt><dd>{current.declaredType}</dd></div>}</dl>
                  <details><summary>SHA-256 校验值</summary><code>{current.sha256 || '模块内资源暂未展开'}</code></details>
                </section>
                <section className="resource-references"><strong>引用位置（{current.references.length}）</strong>{current.references.length ? current.references.map((reference, index) => <div key={`${reference.pathLabel}:${index}`}><span>{reference.pathLabel}</span><code>{reference.sample}</code></div>) : <p>未发现卡片或模块中的直接引用。</p>}</section>
              </aside>
            </div>
          </> : <div className="table-empty">选择一个资源查看详情</div>}
        </div>
      </div>
    </section>
  );
}
