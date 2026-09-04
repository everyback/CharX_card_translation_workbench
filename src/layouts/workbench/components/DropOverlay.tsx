import { FileUp } from 'lucide-react';

export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="drop-overlay" role="status" aria-live="polite">
      <div className="drop-target">
        <FileUp size={30} />
        <strong>松开以导入卡片或模块</strong>
        <span>支持 JSON、PNG、CHARX 和 RISUM，可同时拖入多张</span>
      </div>
    </div>
  );
}
