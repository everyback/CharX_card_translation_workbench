import { ArrowRight, FileUp, ScanSearch, Settings2, ShieldCheck } from 'lucide-react';
import type { Settings } from '@/shared/types';

interface QuickStartViewProps {
  settings: Settings | null;
  onImport: () => void;
  onOpenSettings: () => void;
}

export function QuickStartView({ settings, onImport, onOpenSettings }: QuickStartViewProps) {
  const modelReady = Boolean(settings?.apiKeyConfigured && settings.model);

  return (
    <section className="empty-workspace quick-start-workspace">
      <div className="quick-start-shell">
        <div className="quick-start-intro">
          <span className="quick-start-kicker">CARD TRANSLATION WORKBENCH</span>
          <h2>从一张卡片开始</h2>
          <p>上传 CHARX、RISUM、PNG 或 JSON。工作台会先扫描结构，再让你选择翻译范围，最后逐条审核后导出。</p>
          <div className="quick-start-actions">
            <button className="primary-button" onClick={onImport}><FileUp size={17} />选择卡片文件<ArrowRight size={15} /></button>
            {!modelReady && <button className="secondary-button" onClick={onOpenSettings}><Settings2 size={16} />先配置模型</button>}
          </div>
          <span className="quick-start-hint">也可以直接把文件拖到窗口里</span>
        </div>
        <div className="quick-start-steps">
          <div className="quick-start-step">
            <span><FileUp size={16} /></span>
            <div><strong>导入卡片</strong><small>支持角色卡和模块文件</small></div>
          </div>
          <div className="quick-start-step">
            <span><ScanSearch size={16} /></span>
            <div><strong>扫描并选择预设</strong><small>先看结构，再决定翻译范围</small></div>
          </div>
          <div className="quick-start-step">
            <span><ShieldCheck size={16} /></span>
            <div><strong>审核后导出</strong><small>保留脚本和世界书结构</small></div>
          </div>
        </div>
      </div>
    </section>
  );
}
