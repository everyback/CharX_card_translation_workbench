import { ArrowRight, Check, Search } from 'lucide-react';
import type { LuaManagementReport } from '@/shared/types';

export interface LuaPortraitCandidatesProps {
  report: LuaManagementReport;
  filteredCandidates: LuaManagementReport['portraitCandidates'];
  query: string;
  selectedOwnerId: string | null;
  onQueryChange: (query: string) => void;
  onSelectOwner: (ownerId: string | null) => void;
  onSaveAliases: (ownerId: string, aliases: string[]) => Promise<void>;
}

export function LuaPortraitCandidates({
  report,
  filteredCandidates,
  query,
  selectedOwnerId,
  onQueryChange,
  onSelectOwner,
  onSaveAliases,
}: LuaPortraitCandidatesProps) {
  return (
    <section className="lua-panel lua-segment-panel" id="lua-portrait-detection-detail">
      <div className="lua-panel-header">
        <div><h2>专有名词匹配候选</h2><span>点击候选只展开详情，不会离开本页</span></div>
      </div>
      <div className="lua-filter-bar">
        <div className="search-input"><Search size={14} /><input aria-label="搜索专有名词候选" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="人名、地名或 ownerId" /></div>
        <span className="result-count">{filteredCandidates.length} 个</span>
      </div>
      <div className="lua-segment-table">
        <div className="lua-segment-head lua-candidate-head"><span>ownerId</span><span>名称 / 别名</span><span>状态</span><span /></div>
        {filteredCandidates.map((candidate) => {
          const selected = selectedOwnerId === candidate.ownerId;
          return (
            <div className={`lua-candidate-wrap ${selected ? 'selected' : ''}`} key={candidate.ownerId}>
              <button className="lua-segment-row lua-candidate-row" onClick={() => onSelectOwner(selected ? null : candidate.ownerId)} aria-expanded={selected}>
                <span title={candidate.ownerId}>{candidate.ownerId}</span>
                <span title={(candidate.targetAliases?.length ? candidate.targetAliases : candidate.names).join('、')}>{(candidate.targetAliases?.length ? candidate.targetAliases : candidate.names).join('、') || '待从卡片译文生成'}</span>
                <span className={`lua-review-status ${candidate.status === 'covered' ? 'approved' : ''}`}>{candidate.status === 'covered' ? '已覆盖' : '待补别名'}</span>
                <ArrowRight size={14} />
              </button>
              {selected && (
                <div className="lua-segment-detail">
                  <div><strong>原有名称</strong><span>{candidate.names.join('、') || '无'}</span></div>
                  <div><strong>目标语言别名</strong><span>{candidate.targetAliases?.join('、') || '尚未生成'}</span></div>
                  <div className="lua-alias-merge"><strong>合并到匹配目录</strong><button className="primary-button" disabled={!candidate.targetAliases?.length || candidate.status === 'covered'} onClick={() => void onSaveAliases(candidate.ownerId, candidate.targetAliases ?? [])}><Check size={14} />{candidate.status === 'covered' ? '已合并' : '一次合并保存'}</button></div>
                  <div><strong>缺少的匹配别名</strong><span>{candidate.missingAliases.join('、') || '无'}</span></div>
                  {candidate.pathLabels.length > 0 && <div><strong>运行时位置</strong><code>{candidate.pathLabels.join('、')}</code></div>}
                  <div className="lua-segment-detail-actions">
                    <span>{candidate.status === 'covered' ? '名称目录已覆盖，可参与立绘匹配。' : '目标语言别名会作为一个集合一次写入目录，供后续匹配使用。'}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {!filteredCandidates.length && <div className="table-empty">{report.portraitFeatureDetected ? '未发现可安全判定的专有名词候选' : '未检测到立绘匹配功能，不处理普通 Lua 文本'}</div>}
      </div>
    </section>
  );
}
