import { Button } from '@/shared/ui/button/Button';
import { Check, RefreshCw, X } from 'lucide-react';
import type { LuaManagementSegment } from '@/shared/types';

export interface NamespaceConfirmationDialogProps {
  segment: LuaManagementSegment;
  currentValue: string;
  draft: string;
  saving: boolean;
  onDraftChange: (value: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}

export function NamespaceConfirmationDialog({ segment, currentValue, draft, saving, onDraftChange, onClose, onConfirm }: NamespaceConfirmationDialogProps) {
  return (
    <div className="modal-backdrop namespace-confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <section className="namespace-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="namespace-confirmation-title">
        <header className="dialog-header">
          <div><h2 id="namespace-confirmation-title">人工核对模块命名空间</h2><span>不会自动判断用途或生成译名。请确认保留原文，或直接填写你要使用的名称。</span></div>
          <Button type="button" variant="outline" size="icon" title="关闭" aria-label="关闭" disabled={saving} onClick={onClose}><X size={16} /></Button>
        </header>
        <div className="namespace-confirmation-body">
          <label><span>原始 namespace</span><code>{segment.sourceText}</code></label>
          <label><span>当前已保存值</span><code>{currentValue || segment.sourceText}</code></label>
          <label className="namespace-confirmation-input"><span>确认后使用的名称</span><input value={draft} onChange={(event) => onDraftChange(event.target.value)} placeholder="保留原文或手动填写名称" autoFocus /></label>
          <p>{draft.trim() === segment.sourceText ? '确认原文后，会保留现有资源引用。' : '确认修改后，会同步已识别的 module_assetlist / module_enabled 内部引用。'}</p>
        </div>
        <footer className="dialog-actions">
          <Button type="button" variant="outline" disabled={saving} onClick={onClose}><X size={16} />取消</Button>
          <Button type="button" variant="default" disabled={saving || !draft.trim()} onClick={onConfirm}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}人工确认并同步</Button>
        </footer>
      </section>
    </div>
  );
}
