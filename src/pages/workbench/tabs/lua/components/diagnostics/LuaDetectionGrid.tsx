import {
  ArrowRight,
  Code2,
  FileCheck2,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
} from 'lucide-react';
import type { LuaManagementReport } from '@/shared/types';

export interface LuaDetectionGridProps {
  report: LuaManagementReport;
  syntaxIssues: LuaManagementReport['issues'];
  luaControlReferences: LuaManagementReport['controlReferences'];
  runtimeDisplayReferences: LuaManagementReport['controlReferences'];
  loading: boolean;
  routerPreviewLoading: boolean;
  onScan: () => void;
  onOpenRouterPreview: () => void;
  onOpenExport: () => void;
}

function scrollToDetail(id: string): void {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function LuaDetectionGrid({
  report,
  syntaxIssues,
  luaControlReferences,
  runtimeDisplayReferences,
  loading,
  routerPreviewLoading,
  onScan,
  onOpenRouterPreview,
  onOpenExport,
}: LuaDetectionGridProps) {
  return (
    <div className="lua-detection-grid">
      <section className="lua-panel lua-detection-card lua-script-detection">
        <div className="lua-panel-header"><div><h2>脚本结构检测</h2><span>Lua 代码块、控制引用和语法状态</span></div><Code2 size={17} /></div>
        <div className="lua-detection-result"><strong>{report.hasModule ? '已完成扫描' : '不适用'}</strong><span>{report.hasModule ? `发现 ${report.sourceCount} 个 Lua 代码块、${report.controlReferenceCount} 个控制引用。` : '当前卡片没有 Risu 模块。'}</span></div>
        {syntaxIssues.length > 0 && <div className="lua-detection-alert">发现 {syntaxIssues.length} 条 Lua 语法问题，见下方语法检测。</div>}
        <button type="button" className="secondary-button lua-detection-action" onClick={onScan}><Search size={14} />重新扫描脚本</button>
      </section>

      <section className="lua-panel lua-detection-card lua-syntax-detection">
        <div className="lua-panel-header"><div><h2>Lua 语法检测</h2><span>逐条定位到真实错误代码行</span></div><ShieldCheck size={17} /></div>
        <div className={`lua-detection-result ${syntaxIssues.length ? 'problem' : 'success'}`}><strong>{syntaxIssues.length ? `发现 ${syntaxIssues.length} 条问题` : '语法通过'}</strong><span>{syntaxIssues.length ? '可在下方直接编辑错误行并重新校验。' : '当前没有待修复的 Lua 语法片段。'}</span></div>
        {syntaxIssues.length > 0 && <button type="button" className="secondary-button lua-detection-action" onClick={() => scrollToDetail('lua-syntax-detection-detail')}><ArrowRight size={14} />查看语法问题</button>}
      </section>

      <section className="lua-panel lua-detection-card lua-control-detection">
        <div className="lua-panel-header"><div><h2>Lua 控制引用检测</h2><span>控制标记、模板和运行时引用</span></div><SlidersHorizontal size={17} /></div>
        <div className={`lua-detection-result ${report.blockerCount ? 'problem' : 'success'}`}><strong>{luaControlReferences.length} 个控制引用</strong><span>{report.blockerCount ? `${report.blockerCount} 个阻断项需要处理。` : '当前没有控制引用阻断。'}</span></div>
        {luaControlReferences.length > 0 && <div className="lua-detection-list">{luaControlReferences.slice(0, 4).map((reference) => <code key={reference.pathLabel}>{reference.pathLabel}</code>)}{luaControlReferences.length > 4 && <span>另有 {luaControlReferences.length - 4} 个</span>}</div>}
      </section>

      <section className="lua-panel lua-detection-card lua-runtime-regex-detection">
        <div className="lua-panel-header"><div><h2>运行时展示正则</h2><span>消息展示阶段执行，独立于静态命中校验</span></div><Code2 size={17} /></div>
        <div className="lua-detection-result success"><strong>{runtimeDisplayReferences.length} 条运行时规则</strong><span>{runtimeDisplayReferences.length ? '只验证规则编译、捕获组和替换模板。' : '当前没有消息展示阶段的正则规则。'}</span></div>
        {runtimeDisplayReferences.length > 0 && <button type="button" className="secondary-button lua-detection-action" onClick={() => scrollToDetail('lua-runtime-regex-detection-detail')}><ArrowRight size={14} />查看运行时规则</button>}
      </section>

      <section className="lua-panel lua-detection-card lua-portrait-detection">
        <div className="lua-panel-header"><div><h2>专有名词检测</h2><span>立绘匹配名称与目标语言别名</span></div><Search size={17} /></div>
        <div className={`lua-detection-result ${report.portraitMissingCount ? 'problem' : 'success'}`}><strong>{report.portraitCandidateCount} 个候选</strong><span>{report.portraitFeatureDetected ? `${report.portraitCoveredCount} 个已有别名，${report.portraitMissingCount} 个待补。` : '未检测到立绘匹配功能。'}</span></div>
        {report.portraitFeatureDetected && <button type="button" className="secondary-button lua-detection-action" onClick={() => scrollToDetail('lua-portrait-detection-detail')}><ArrowRight size={14} />查看名称候选</button>}
      </section>

      <section className="lua-panel lua-detection-card lua-router-detection">
        <div className="lua-panel-header"><div><h2>图片路由检测</h2><span>只检查已识别的路由阻断模式</span></div><Wrench size={17} /></div>
        <div className={`lua-detection-result ${report.routerRepair.canApply ? 'problem' : 'success'}`}><strong>{report.routerRepair.canApply ? `发现 ${report.routerRepair.findings.length} 个问题` : '路由检查通过'}</strong><span>{report.routerRepair.canApply ? '仅显示可精确预览的局部修改。' : '当前没有匹配到已知路由阻断模式。'}</span></div>
        {report.routerRepair.canApply && <button type="button" className="secondary-button lua-detection-action" onClick={onOpenRouterPreview} disabled={loading || routerPreviewLoading}><Wrench size={14} />查看修改对比</button>}
      </section>

      <section className="lua-panel lua-detection-card lua-export-detection">
        <div className="lua-panel-header"><div><h2>导出完整性检测</h2><span>导出前执行最终保护校验</span></div><FileCheck2 size={17} /></div>
        <div className={`lua-detection-result ${report.blockerCount ? 'problem' : 'success'}`}><strong>{report.blockerCount ? `${report.blockerCount} 个阻断` : '可以导出'}</strong><span>{report.warningCount ? `${report.warningCount} 条提醒会随导出回验。` : '没有待处理提醒。'}</span></div>
        <button type="button" className="primary-button lua-detection-action" onClick={onOpenExport}><FileCheck2 size={14} />{report.blockerCount ? '保存并重新校验' : '保存并导出'}</button>
      </section>
    </div>
  );
}
