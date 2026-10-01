import { Button } from '@/shared/ui/button/Button';
import { ArrowRight, Check, CircleAlert, Code2, Download, FileArchive, Save, ShieldCheck } from 'lucide-react';
import type { ProjectDetail } from '@/shared/types';
import { workflowState } from '@/features/translation/model/workflow-state';

export function ExportPage({ project, busy, onReview, onJobs, onScripts, onApplyDraft, onSaveAndExport }: {
  project: ProjectDetail; busy: string; onReview: () => void; onJobs: () => void;
  onScripts: () => void; onApplyDraft: () => void; onSaveAndExport: () => void;
}) {
  const state = workflowState(project);
  const disabled = Boolean(busy) || Boolean(state.active);
  return <section className="export-page" aria-label="导出成品">
    <div className="export-main">
      <div className="export-intro"><span className="export-icon"><FileArchive size={27} /></span><div><span className="section-eyebrow">最后一步</span><h2>把审核成果带回你的故事</h2><p>保存当前审核稿，并下载可导入的卡片文件。</p></div></div>
      <div className="export-checklist">
        <div><ShieldCheck size={19} /><span><strong>已审核的译文</strong><small>{state.counts.approved} 条译文已通过审核，将用于生成当前审核稿。</small></span><b>{state.counts.approved}</b></div>
        <div><CircleAlert size={19} /><span><strong>{state.counts.pending ? '还有译文等待确认' : '当前没有待审核译文'}</strong><small>{state.counts.pending ? `${state.counts.pending} 条尚未审核；未通过的内容保留原文。` : '你仍然可以返回审核页修改最终稿。'}</small></span><button className="text-action" onClick={onReview}>前往审核<ArrowRight size={14} /></button></div>
        {(state.active || state.hasFailures || state.counts.untranslated > 0) && <div><CircleAlert size={19} /><span><strong>{state.active ? '翻译任务尚未结束' : state.hasFailures ? '有未完成或失败的任务' : '部分内容尚未翻译'}</strong><small>{state.active ? '完成或取消当前任务后再保存导出。' : state.hasFailures ? '请在任务页检查失败项与阶段 2 的处理结果。' : `${state.counts.untranslated} 条内容仍待翻译，导出时保留原文。`}</small></span><button className="text-action" onClick={onJobs}>查看任务<ArrowRight size={14} /></button></div>}
        <div><Code2 size={19} /><span><strong>导出前结构检查</strong><small>保存时检查脚本语法、受保护引用和卡片结构。发现阻断问题时会引导你处理。</small></span><button className="text-action" onClick={onScripts}>脚本管理<ArrowRight size={14} /></button></div>
      </div>
      <div className="export-actions"><Button variant="outline" disabled={disabled} onClick={onApplyDraft}><Save size={16} />仅保存审核稿</Button><Button variant="default" disabled={disabled} onClick={onSaveAndExport}><Download size={16} />保存并导出</Button></div>
    </div>
    <aside className="export-summary"><span className="section-eyebrow">本次导出</span><h3>{project.translatedName || project.originalName || project.name}</h3><dl><div><dt>原始名称</dt><dd>{project.originalName}</dd></div><div><dt>文件格式</dt><dd>{project.sourceFormat.toUpperCase()}</dd></div><div><dt>语言方向</dt><dd>{project.sourceLanguage} → {project.targetLanguage}</dd></div></dl><p><Check size={15} />保留世界书原始触发词</p><p><Check size={15} />保留变量、脚本与资源引用</p><p><Check size={15} />未审核内容保留原文</p><small>导出完成后，请在目标客户端打开卡片，复核显示和交互。</small></aside>
  </section>;
}
