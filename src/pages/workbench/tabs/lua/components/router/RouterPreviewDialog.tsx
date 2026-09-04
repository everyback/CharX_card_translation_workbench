import { Check, RefreshCw, X } from 'lucide-react';
import type { PortraitRouterRepairChange, PortraitRouterRepairPreview } from '@/shared/types';
import { RouterCodePanel, compactCode } from './RouterCodePanel';

function changeKey(change: PortraitRouterRepairChange, index: number): string {
  return `${change.id}:${change.pathLabel}:${index}`;
}

export interface RouterPreviewDialogProps {
  preview: PortraitRouterRepairPreview;
  drafts: Record<string, string>;
  applying: boolean;
  editingIndex: number | null;
  editValue: string;
  onClose: () => void;
  onBeginEdit: (index: number, value: string, peer: string) => void;
  onCancelEdit: () => void;
  onEditValueChange: (value: string) => void;
  onSaveEdit: (change: PortraitRouterRepairChange, index: number) => void;
  onApply: () => void;
}

export function RouterPreviewDialog({
  preview,
  drafts,
  applying,
  editingIndex,
  editValue,
  onClose,
  onBeginEdit,
  onCancelEdit,
  onEditValueChange,
  onSaveEdit,
  onApply,
}: RouterPreviewDialogProps) {
  return (
    <div className="modal-backdrop router-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !applying) onClose(); }}>
      <section className="router-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="router-preview-title">
        <header className="dialog-header">
          <div><h2 id="router-preview-title">路由修复修改对比</h2><span>仅显示检测到的局部修改，确认后才会写入卡片。</span></div>
          <button className="icon-button" title="关闭" aria-label="关闭修改对比" disabled={applying} onClick={onClose}><X size={16} /></button>
        </header>
        <div className="router-preview-body">
          {preview.changes.map((change, index) => {
            const key = changeKey(change, index);
            const draft = drafts[key] ?? change.after;
            return (
              <article className="router-change" key={key}>
                <div className="router-change-heading"><div><strong>{change.title}</strong><span className="router-change-index">{index + 1} / {preview.changes.length}</span></div><code>{change.pathLabel}</code></div>
                <p className="router-change-message">{preview.report.findings.find((finding) => finding.id === change.id && finding.pathLabel === change.pathLabel)?.message ?? '仅替换已识别的路由代码，其他脚本结构保持不变。'}</p>
                <div className="router-change-summary">
                  <span>修改点：{compactCode(change.before, draft).changedCount} 行 → {compactCode(draft, change.before).changedCount} 行</span>
                  <span>{editingIndex === index ? '正在编辑本项' : '建议代码可双击编辑'}</span>
                </div>
                {editingIndex === index ? (
                  <div className="router-edit-box">
                    <span className="router-edit-label">修改点代码</span>
                    <textarea aria-label={`编辑${change.title}修改点`} value={editValue} onChange={(event) => onEditValueChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') onCancelEdit(); }} spellCheck={false} autoFocus />
                    <div className="router-edit-actions">
                      <button className="secondary-button" onClick={onCancelEdit}><X size={14} />取消本项</button>
                      <button className="primary-button" onClick={() => onSaveEdit(change, index)}><Check size={14} />保存本项</button>
                    </div>
                  </div>
                ) : (
                  <div className="router-diff-columns">
                    <div className="router-diff-column"><span>原代码 · 局部</span><RouterCodePanel source={change.before} peer={draft} tone="before" /></div>
                    <div className="router-diff-column"><span>建议修改 · 局部</span><RouterCodePanel source={draft} peer={change.before} tone="after" editable onDoubleClick={() => onBeginEdit(index, draft, change.before)} /></div>
                  </div>
                )}
              </article>
            );
          })}
          {!preview.changes.length && <div className="table-empty">预览时未发现仍可修改的路由代码，可能已被其他操作处理。</div>}
        </div>
        <footer className="dialog-actions router-preview-actions">
          <button className="secondary-button" disabled={applying} onClick={onClose}><X size={16} />取消</button>
          <button className="primary-button" disabled={applying || editingIndex !== null || !preview.changes.length} onClick={onApply}>{applying ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}人工检查通过，应用修改</button>
        </footer>
      </section>
    </div>
  );
}
