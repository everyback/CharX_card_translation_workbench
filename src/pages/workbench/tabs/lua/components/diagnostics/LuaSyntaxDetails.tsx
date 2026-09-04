import { Check, Code2, Minus, Plus, RefreshCw } from 'lucide-react';
import type { LuaManagementReport } from '@/shared/types';

type LuaIssue = LuaManagementReport['issues'][number];

export interface LuaSyntaxDetailsProps {
  report: LuaManagementReport;
  syntaxIssues: LuaIssue[];
  syntaxContextExpanded: Record<string, boolean>;
  syntaxLineDrafts: Record<string, string>;
  loading: boolean;
  savingSyntaxKey: string | null;
  syntaxSaveMessage: string | null;
  onSetDraft: (issueKey: string, value: string) => void;
  onToggleContext: (issueKey: string, expanded: boolean) => void;
  onSaveSyntaxLine: (issue: LuaIssue, issueKey: string) => void;
}

export function LuaSyntaxDetails({
  report,
  syntaxIssues,
  syntaxContextExpanded,
  syntaxLineDrafts,
  loading,
  savingSyntaxKey,
  syntaxSaveMessage,
  onSetDraft,
  onToggleContext,
  onSaveSyntaxLine,
}: LuaSyntaxDetailsProps) {
  return (
    <section className="lua-panel lua-syntax-detail" id="lua-syntax-detection-detail">
      <div className="lua-panel-header"><div><h2>Lua 语法问题</h2><span>每个错误显示真实 Lua 片段；前后 2 行用于判断上下文，红色行可直接编辑。</span></div><Code2 size={17} /></div>
      {syntaxIssues.length > 0 ? <div className="lua-snippet-list">
        {syntaxIssues.map((issue, index) => {
          const reportIssueIndex = report.issues.findIndex((item) => item.kind === 'syntax' && item.pathLabel === issue.pathLabel && item.line === issue.line);
          const issueKey = `${issue.kind}:${issue.pathLabel}:${reportIssueIndex >= 0 ? reportIssueIndex : index}`;
          const expandedContext = syntaxContextExpanded[issueKey] === true;
          const contextLines = issue.contextLines ?? [];
          const visibleContextLines = expandedContext || !issue.line
            ? contextLines
            : contextLines.filter((contextLine) => Math.abs(contextLine.line - issue.line!) <= 2);
          const canExpandContext = visibleContextLines.length < contextLines.length;
          const errorContextLine = contextLines.find((contextLine) => contextLine.errorLine);
          const currentErrorLine = syntaxLineDrafts[issueKey] ?? errorContextLine?.draftLine ?? issue.draftLine ?? '';
          return <article className="lua-snippet-card" id={`lua-syntax-snippet-${index}`} data-lua-issue-key={issueKey} key={issueKey}>
            <div className="lua-editor-meta"><strong>{issue.pathLabel}</strong><span>{issue.line ? `第 ${issue.line} 行，第 ${issue.column ?? '?'} 列` : 'Lua 语法错误'}</span></div>
            <div className="lua-snippet-help">当前 Lua 代码片段</div>
            {errorContextLine && <div className="lua-snippet-comparison">
              <div><span>原始文本</span><code>{errorContextLine.sourceLine || '（空行）'}</code></div>
              <div><span>当前文本</span><code>{currentErrorLine || '（空行）'}</code></div>
            </div>}
            {contextLines.length ? <div className="lua-code-editor lua-snippet-code-editor">
              {visibleContextLines.map((contextLine) => <div className={`lua-code-line${contextLine.errorLine ? ' error-line' : ''}`} key={contextLine.line}>
                <span className="lua-code-line-number">{contextLine.line}</span>
                {contextLine.errorLine
                  ? <div className="lua-code-line-edit"><textarea
                    value={syntaxLineDrafts[issueKey] ?? contextLine.draftLine ?? ''}
                    onChange={(event) => onSetDraft(issueKey, event.target.value)}
                    rows={2}
                    spellCheck={false}
                    aria-label={`编辑 Lua 第 ${contextLine.line} 行`}
                  />{issue.column ? <small className="lua-code-column-marker">解析器错误列：{issue.column}</small> : null}{contextLine.sourceLine !== contextLine.draftLine ? <small className="lua-code-baseline">原始代码：<code>{contextLine.sourceLine || '（空行）'}</code></small> : null}</div>
                  : <code className="lua-code-line-text">{contextLine.draftLine || ' '}</code>}
              </div>)}
            </div> : <textarea
              className="lua-snippet-single-editor"
              value={syntaxLineDrafts[issueKey] ?? issue.draftLine ?? ''}
              onChange={(event) => onSetDraft(issueKey, event.target.value)}
              rows={3}
              spellCheck={false}
              aria-label={`编辑 Lua 第 ${issue.line ?? '?'} 行`}
            />}
            {expandedContext ? <button type="button" className="secondary-button lua-context-expand" onClick={() => onToggleContext(issueKey, false)}><Minus size={14} />收起附近代码</button> : canExpandContext ? <button type="button" className="secondary-button lua-context-expand" onClick={() => onToggleContext(issueKey, true)} title="查看错误行附近更多原始 Lua 代码"><Plus size={14} />展开附近更多行</button> : null}
            <div className="lua-syntax-actions">
              <button type="button" className="primary-button" disabled={loading || !issue.pathJson || !issue.line || savingSyntaxKey === issueKey} onClick={() => onSaveSyntaxLine(issue, issueKey)}>
                {savingSyntaxKey === issueKey ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}
                保存错误行并重新校验
              </button>
              {syntaxSaveMessage && savingSyntaxKey !== issueKey && <span className="lua-inline-save-message">{syntaxSaveMessage}</span>}
            </div>
          </article>;
        })}
      </div> : <div className="lua-simple-empty">当前没有待修复的 Lua 语法片段。</div>}
    </section>
  );
}
