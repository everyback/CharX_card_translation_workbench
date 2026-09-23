import { Check, FileText, LoaderCircle, ScanSearch, X } from 'lucide-react';
import type { CardImportResult } from '../model/useCardImport';

interface ImportSummaryProps {
  results: CardImportResult[];
  busy: string;
  onSelectProject: (projectId: string) => void;
  onScanProject: (projectId: string) => void;
  onScanAll: () => void | Promise<void>;
  onClose: () => void;
  /** Formats that are converted rather than translated get a different action. */
  conversionFormats?: readonly string[];
}

export function ImportSummary({ results, busy, onSelectProject, onScanProject, onScanAll, onClose, conversionFormats }: ImportSummaryProps) {
  const imported = results.filter((item) => item.status === 'imported' && item.projectId);
  const canScan = imported.length > 0 && !busy;
  const isConversion = (item: CardImportResult) => Boolean(item.sourceFormat && conversionFormats?.includes(item.sourceFormat));
  return (
    <section className="import-summary" role="status" aria-label="导入结果">
      <div className="import-summary-header">
        <div><strong>导入结果</strong><span>{imported.length} 个项目已创建</span></div>
        <button className="icon-button" type="button" onClick={onClose} aria-label="关闭导入结果" title="关闭"><X size={16} /></button>
      </div>
      <div className="import-summary-list">
        {results.map((item) => (
          <div className={`import-summary-row ${item.status}`} key={`${item.fileName}-${item.projectId ?? 'failed'}`}>
            {item.status === 'imported' ? <Check size={15} /> : <X size={15} />}
            <span className="import-summary-name" title={item.fileName}><FileText size={14} />{item.fileName}</span>
            {item.status === 'imported' ? (
              <div className="import-summary-actions">
                <button className="link-button" type="button" onClick={() => item.projectId && onSelectProject(item.projectId)}>打开</button>
                {!isConversion(item) && (
                  <button className="secondary-button compact-button" type="button" disabled={!canScan} onClick={() => item.projectId && onScanProject(item.projectId)}>
                    {busy === `scan-${item.projectId}` ? <LoaderCircle className="spin" size={14} /> : <ScanSearch size={14} />}扫描
                  </button>
                )}
              </div>
            ) : <span className="import-summary-error">{item.error}</span>}
          </div>
        ))}
      </div>
      {imported.length > 1 && <button className="primary-button compact-button" type="button" disabled={!canScan} onClick={onScanAll}><ScanSearch size={15} />扫描全部项目</button>}
    </section>
  );
}
