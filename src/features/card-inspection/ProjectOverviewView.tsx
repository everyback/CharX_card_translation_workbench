import { BookOpenText, Braces, CircleAlert, FileArchive, FileImage, FileJson, Gauge, ListChecks, RefreshCw } from 'lucide-react';
import { LoadingMask, Stat } from '../../components/ui';
import type { ProjectOverview } from '../../types';
import { formatBytes } from '../../utils/format';
import {
  cardSpecificationDetail,
  cardSpecificationLabel,
  containerFormatLabel,
  platformExtensionLabels,
} from './overview-labels';

export function ProjectOverviewView({ info, loading, onRefresh, onViewResources }: {
  info: ProjectOverview | null;
  loading: boolean;
  onRefresh: () => void;
  onViewResources: () => void;
}) {
  if (!info) {
    return (
      <section className="unpack-empty project-overview-empty">
        <BookOpenText size={42} />
        <h2>项目概要</h2>
        <p>{loading ? '正在读取原始卡片结构…' : '暂时无法读取该项目的概要。'}</p>
        {!loading && <button className="secondary-button" onClick={onRefresh}><RefreshCw size={16} />重新读取</button>}
        {loading && <LoadingMask label="正在读取项目概要" />}
      </section>
    );
  }

  const totalLorebookEntries = info.lorebookEntries + info.moduleLorebookEntries;
  const totalRegexScripts = info.regexScripts + info.moduleRegexScripts;
  const totalAssets = info.assets + info.moduleAssets;
  const platformExtensions = platformExtensionLabels(info.extensionKeys, info.modulePresent);
  const cardMeta = [
    info.creator ? `作者 ${info.creator}` : '',
    info.characterVersion ? `卡片版本 ${info.characterVersion}` : '',
  ].filter(Boolean).join(' · ');

  return (
    <section className="tavern-card-workspace project-overview-workspace">
      {loading && <LoadingMask label="正在更新项目概要" />}
      <div className="tavern-card-overview">
        <div className="tavern-card-cover">
          {info.previewAvailable ? <img draggable={false} src={`/api/projects/${info.projectId}/cover`} alt={`${info.cardName} 头图`} /> : info.sourceFormat === 'risum' || info.sourceFormat === 'charx' ? <FileArchive size={48} /> : <FileJson size={48} />}
        </div>
        <div className="tavern-card-heading">
          <span>原始导入内容概要</span>
          <h2>{info.cardName}</h2>
          <p>{cardMeta || '未声明作者与卡片版本'}</p>
          {info.filename && <small className="project-overview-filename">{info.filename}</small>}
          <div className="tavern-card-overview-actions">
            <button className="secondary-button" onClick={onViewResources}><FileImage size={16} />查看资源</button>
            <button className="icon-button" title="重新读取概要" onClick={onRefresh} disabled={loading}><RefreshCw size={16} /></button>
          </div>
        </div>
      </div>

      <div className="project-format-band">
        <div>
          <span>角色卡规范</span>
          <strong>{cardSpecificationLabel(info.spec)}</strong>
          <small>{cardSpecificationDetail(info.spec, info.specVersion)}</small>
        </div>
        <div>
          <span>文件容器</span>
          <strong>{containerFormatLabel(info.sourceFormat)}</strong>
          <small>{info.metadataKeys.length ? `元数据标记：${info.metadataKeys.join('、')}` : '卡片数据保存在文件主体中'}</small>
        </div>
        <div>
          <span>检测到的平台扩展</span>
          <strong>{platformExtensions.length ? platformExtensions.join(' / ') : '无明确平台专属扩展'}</strong>
          <small>{info.extensionKeys.length ? `扩展键：${info.extensionKeys.join('、')}` : '没有 extensions 扩展键'}</small>
        </div>
      </div>

      <div className="tavern-card-stats">
        <Stat icon={<BookOpenText size={17} />} label="世界书" value={totalLorebookEntries} />
        <Stat icon={<ListChecks size={17} />} label="备选开场" value={info.alternateGreetings} />
        <Stat icon={<Braces size={17} />} label="正则脚本" value={totalRegexScripts} />
        <Stat icon={<Gauge size={17} />} label="脚本触发器" value={info.moduleTriggers} />
        <Stat icon={<FileArchive size={17} />} label="资源声明" value={totalAssets} />
        <Stat icon={<FileJson size={17} />} label="保存内容" value={formatBytes(info.fileBytes)} />
      </div>

      {info.warnings.length > 0 && <div className="tavern-card-warnings"><CircleAlert size={16} /><span>{info.warnings.join('；')}</span></div>}
      {info.modulePresent && <div className="tavern-card-meta-band project-module-band"><div><strong>内嵌模块</strong><span>{info.moduleName || '未命名模块'}</span></div><div><strong>模块世界书</strong><span>{info.moduleLorebookEntries.toLocaleString()} 条</span></div><div><strong>模块 JSON</strong><span>{formatBytes(info.moduleJsonBytes)}</span></div><div><strong>模块字段</strong><span>{info.moduleKeys.length ? info.moduleKeys.join('、') : '无'}</span></div></div>}
      <div className="tavern-card-meta-band"><div><strong>标签</strong><span>{info.tags.length ? info.tags.join('、') : '无'}</span></div><div><strong>顶层字段</strong><span>{info.topLevelKeys.join('、')}</span></div><div><strong>data 字段</strong><span>{info.dataKeys.join('、')}</span></div><div><strong>扩展字段</strong><span>{info.extensionKeys.length ? info.extensionKeys.join('、') : '无'}</span></div></div>
      <div className="tavern-field-section">
        <div className="tavern-field-title"><strong>关键字段</strong><span>{info.fields.length} 项，概要固定读取原始导入内容</span></div>
        <div className="tavern-field-table">
          <div className="tavern-field-head"><span>字段</span><span>路径</span><span>规模</span><span>内容预览</span></div>
          {info.fields.map((field) => <div className="tavern-field-row" key={field.path}><strong>{field.label}</strong><code>{field.path}</code><span>{field.summary}</span><p>{field.preview || '—'}</p></div>)}
          {!info.fields.length && <div className="table-empty">当前项目没有可展示的常用字段。</div>}
        </div>
      </div>
    </section>
  );
}
