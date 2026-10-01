import { Button } from '@/shared/ui/button/Button';
import { useState } from 'react';
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
  onSaveSyntaxLine: (issue: LuaIssue, issueKey: string, replacement?: string) => Promise<boolean>;
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
      <div className="lua-panel-header"><div><h2>Lua 语法问题</h2><span>每个错误显示真实 Lua 片段；原文与当前稿分别显示行号及上下文，当前稿每一行均可点击编辑、单独保存。</span></div><Code2 size={17} /></div>
      {syntaxSaveMessage && <p className="lua-inline-save-message" role="status">{syntaxSaveMessage}</p>}
      {syntaxIssues.length > 0 ? <div className="lua-snippet-list">
        {syntaxIssues.map((issue, index) => {
          const issueKey = `${issue.kind}:${issue.pathLabel}:${issue.line ?? 0}`;
          const expandedContext = syntaxContextExpanded[issueKey] === true;
          const contextLines = issue.contextLines ?? [];
          const visibleContextLines = expandedContext || !issue.line
            ? contextLines
            : contextLines.filter((contextLine) => Math.abs(contextLine.line - issue.line!) <= 5);
          const sourceContext = issue.sourceContextLines ?? [];
          const sourceLine = issue.sourceLineNumber ?? issue.sourceReferenceLine;
          const visibleSourceContext = expandedContext || !sourceLine ? sourceContext : sourceContext.filter(row => Math.abs(row.line - sourceLine) <= 5);
          const canExpandContext = visibleContextLines.length < contextLines.length || visibleSourceContext.length < sourceContext.length;
          return <details open={index === 0 || undefined} className="lua-snippet-card" id={`lua-syntax-snippet-${index}`} data-lua-issue-key={issueKey} key={issueKey}>
            <summary className="lua-editor-meta"><strong>{issue.pathLabel}</strong><span>{issue.line ? `第 ${issue.line} 行，第 ${issue.column ?? '?'} 列` : 'Lua 语法错误'}</span></summary>
            <div className="lua-snippet-help">{issue.message}</div>
            <div className="lua-syntax-columns"><div>
            <div className="lua-snippet-help">原文参考上下文{issue.sourceLineNumber ? ` · 原文第 ${issue.sourceLineNumber} 行` : ` · 参考位置 ${issue.sourceReferenceLine ?? '?'} 行（未精确对齐）`}</div>
            {issue.sourceContextLines?.length ? <div className="lua-code-editor">
              {visibleSourceContext.map((row) => <div className={`lua-code-line${row.line === issue.sourceLineNumber ? ' error-line' : ''}`} key={row.line}>
                <span className="lua-code-line-number">{row.line}</span><code className="lua-code-line-text">{row.text || ' '}</code>
              </div>)}
            </div> : <div className="lua-snippet-help">增删行或代码变动导致原文无法可靠定位；请以当前稿解析器行号为准。</div>}
            </div><div>
            <div className="lua-snippet-help">当前稿上下文 · 红色行为解析器报错位置；点击任意行编辑，保存只修改这一行</div>
            {contextLines.length ? <div className="lua-code-editor lua-snippet-code-editor">
              {visibleContextLines.map((contextLine) => <EditableSyntaxLine
                key={`${issue.pathJson}:${contextLine.line}`}
                line={contextLine.line}
                text={contextLine.draftLine}
                errorLine={contextLine.errorLine}
                column={contextLine.errorLine ? issue.column : undefined}
                disabled={loading || savingSyntaxKey !== null}
                saving={savingSyntaxKey === `${issueKey}:line:${contextLine.line}`}
                onSave={(replacement, expectedLine) => onSaveSyntaxLine(
                  { ...issue, line: contextLine.line, draftLine: expectedLine },
                  `${issueKey}:line:${contextLine.line}`, replacement,
                )}
              />)}
            </div> : <textarea
              className="lua-snippet-single-editor"
              value={syntaxLineDrafts[issueKey] ?? issue.draftLine ?? ''}
              onChange={(event) => onSetDraft(issueKey, event.target.value)}
              rows={3}
              spellCheck={false}
              aria-label={`编辑 Lua 第 ${issue.line ?? '?'} 行`}
            />}
            {expandedContext ? <Button type="button" variant="outline" className="lua-context-expand" onClick={() => onToggleContext(issueKey, false)}><Minus size={14} />收起附近代码</Button> : canExpandContext ? <Button type="button" variant="outline" className="lua-context-expand" onClick={() => onToggleContext(issueKey, true)} title="查看错误行附近更多原始 Lua 代码"><Plus size={14} />展开附近更多行</Button> : null}
            {!contextLines.length && <div className="lua-syntax-actions">
              <Button type="button" variant="default" disabled={loading || !issue.pathJson || !issue.line || savingSyntaxKey !== null} onClick={() => onSaveSyntaxLine(issue, issueKey)}>
                {savingSyntaxKey === issueKey ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}
                保存错误行并重新校验
              </Button>
            </div>}
            </div></div>
          </details>;
        })}
      </div> : <div className="lua-simple-empty">当前没有待修复的 Lua 语法片段。</div>}
    </section>
  );
}


export function EditableSyntaxLine({ line, text, errorLine, column, disabled, saving, onSave, onEditingChange }: {
  line: number; text: string; errorLine: boolean; column?: number; disabled: boolean; saving: boolean;
  onSave: (replacement: string, expectedLine: string) => Promise<boolean>;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [baseline, setBaseline] = useState(text);
  const end = () => { setEditing(false); onEditingChange?.(false); };
  const begin = () => { setBaseline(text); setDraft(text); setEditing(true); onEditingChange?.(true); };
  const save = async () => { if (await onSave(draft, baseline)) end(); };
  return <div className={`lua-code-line${errorLine ? ' error-line' : ''}`}>
    <span className="lua-code-line-number">{line}</span>
    {editing ? <div className="lua-code-line-edit">
      <textarea autoFocus value={draft} disabled={disabled} rows={2} spellCheck={false}
        aria-label={`编辑 Lua 第 ${line} 行`} onChange={event => setDraft(event.target.value)} />
      <div className="lua-line-actions">
        <Button type="button" variant="default" disabled={disabled || draft === baseline}
          onClick={() => void save()}>{saving ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}保存第 {line} 行并校验</Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={end}>取消</Button>
      </div>
      {column && <small className="lua-code-column-marker">解析器错误列：{column}</small>}
    </div> : <button type="button" className="lua-line-edit-trigger" disabled={disabled}
      aria-label={`编辑 Lua 第 ${line} 行`} onClick={begin}><code>{text || '（空行）'}</code><span>编辑</span></button>}
  </div>;
}
