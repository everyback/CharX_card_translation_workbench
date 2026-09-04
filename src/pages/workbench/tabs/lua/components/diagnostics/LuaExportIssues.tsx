import { AlertTriangle, CircleAlert, Code2 } from 'lucide-react';
import type { LuaManagementReport } from '@/shared/types';
import { LUA_ISSUE_LABELS } from '../../model/constants';

export interface LuaExportIssuesProps {
  report: LuaManagementReport;
  onOpenRegex: (reference: LuaManagementReport['controlReferences'][number]) => void;
}

export function LuaExportIssues({ report, onOpenRegex }: LuaExportIssuesProps) {
  return (
    <section className="lua-panel lua-export-issues-panel">
      <div className="lua-panel-header"><div><h2>导出校验问题</h2><span>按检测类型归类；阻断项必须在导出前处理</span></div><AlertTriangle size={17} /></div>
      <div className="lua-issue-list">
        {report.issues.filter((issue) => issue.kind !== 'syntax').map((issue, index) => {
          const reference = issue.kind === 'control'
            ? report.controlReferences.find((item) => item.pathLabel === issue.pathLabel)
            : null;
          return <div className={`lua-issue ${issue.blocking ? 'blocking' : ''}`} key={`${issue.kind}:${issue.pathLabel}:${index}`}>
            <CircleAlert size={14} />
            <div className="lua-issue-content">
              <strong>{LUA_ISSUE_LABELS[issue.kind]} · {issue.pathLabel}</strong>
              <span>{issue.message}</span>
              {reference?.kind === 'regex' && <button type="button" className="secondary-button lua-issue-open-rule" onClick={() => onOpenRegex(reference)}><Code2 size={14} />打开规则</button>}
            </div>
          </div>;
        })}
        {!report.issues.some((issue) => issue.kind !== 'syntax') && <p className="lua-empty-copy">当前没有其他导出校验问题。</p>}
      </div>
    </section>
  );
}
