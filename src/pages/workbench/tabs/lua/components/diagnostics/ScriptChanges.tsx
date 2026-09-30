import { useState } from 'react';
import type { LuaManagementReport } from '@/shared/types';
import { compactCode, RouterCodePanel } from '../router/RouterCodePanel';
import { EditableSyntaxLine } from './LuaSyntaxDetails';

type Change = LuaManagementReport['scriptChanges'][number];
type Props = {
  changes: Change[];
  mode?: 'lua' | 'regex';
  loading?: boolean;
  savingKey?: string | null;
  message?: string | null;
  messagePath?: string | null;
  regexRules?: LuaManagementReport['regexRules'];
  onSaveLine?: (change: Change, line: number, replacement: string, expectedLine: string) => Promise<boolean>;
  onOpenRegex?: (rule: LuaManagementReport['regexRules'][number]) => void;
  onEditingChange?: (editing: boolean) => void;
};

export function ScriptChanges(props: Props) {
  const { mode = 'lua', changes, loading, savingKey, message, regexRules = [], onOpenRegex, onSaveLine } = props;
  const [query, setQuery] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [full, setFull] = useState(false);
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const filtered = changes.filter(change => change.pathLabel.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
  const visible = filtered.slice(currentPage * 30, (currentPage + 1) * 30);
  const selected = filtered.find(change => change.pathLabel === selectedPath) ?? visible[0];
  const locked = editingLine !== null || Boolean(savingKey);
  const rule = selected && regexRules.find(rule => rule.pathLabel === selected.pathLabel.replace(/^\$module\./, '模块.').replace(/\.out$/, '.in'));
  const showFull = full || selected?.before === selected?.after;
  const lines = selected && (showFull
    ? selected.after.replace(/\r\n/g, '\n').split('\n').map((text, index) => ({ number: index + 1, text }))
    : compactCode(selected.after, selected.before).lines);
  return <section className="lua-panel lua-script-changes" id={mode === 'lua' ? 'lua-script-changes' : 'lua-regex-changes'}>
    <div className="lua-panel-header"><div><h2>{mode === 'lua' ? '脚本编辑' : '正则修改前后对比'}</h2><span>{mode === 'lua' ? '全部 Lua 脚本均可编辑，包括未修改和语法已通过的脚本。点击当前稿代码行修改并保存。' : '选择正则路径查看原文与当前稿，点击编辑按钮修改匹配式和替换输出。'}</span></div></div>
    <div className="lua-changes-toolbar"><input aria-label={mode === 'lua' ? '搜索脚本路径' : '搜索正则修改路径'} placeholder="搜索路径" value={query} disabled={locked} onChange={event => { setQuery(event.target.value); setPage(0); }} /><span>{filtered.length} / {changes.length} {mode === 'lua' ? '个脚本' : '处修改'}</span></div>
    {message && selected?.pathLabel === props.messagePath && <p className="lua-inline-save-message" role="status">{message}</p>}
    <div className="lua-change-workspace">
      <nav className="lua-change-navigation" aria-label="修改路径">
        <div className="lua-change-paths">{visible.map(change => <button type="button" key={change.pathLabel} className={selected === change ? 'selected' : ''}
          aria-current={selected === change ? 'true' : undefined} disabled={locked} title={change.pathLabel}
          onClick={() => { setSelectedPath(change.pathLabel); setFull(false); }}><span>{change.luaPathJson ? 'Lua' : /\.(in|out)$/.test(change.pathLabel) ? '正则' : '代码'}</span><code>{change.pathLabel}</code></button>)}</div>
        {filtered.length > 30 && <div className="lua-change-pagination"><button type="button" disabled={locked || currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedPath(''); }}>上一页</button><span>{currentPage + 1} / {Math.ceil(filtered.length / 30)}</span><button type="button" disabled={locked || (currentPage + 1) * 30 >= filtered.length} onClick={() => { setPage(currentPage + 1); setSelectedPath(''); }}>下一页</button></div>}
      </nav>
      {selected ? <div className="lua-change-body" key={selected.pathLabel}>
        <div className="lua-change-editor-toolbar"><code>{selected.pathLabel}</code><label><input type="checkbox" checked={full} disabled={locked} onChange={event => setFull(event.target.checked)} />显示完整代码</label>
          {mode === 'regex' && rule && onOpenRegex && <button type="button" className="secondary-button" disabled={loading || locked} onClick={() => onOpenRegex(rule)}>编辑正则输入 / 输出</button>}</div>
        <div className="lua-change-columns">
          <div><strong>修改前 · 原始文件（只读）</strong>{showFull ? <pre>{selected.before || '（空）'}</pre> : <RouterCodePanel source={selected.before} peer={selected.after} tone="before" />}</div>
          <div><strong>修改后 · 当前审核稿{selected.luaPathJson && onSaveLine ? '（点击代码行编辑）' : ''}</strong>
            {selected.luaPathJson && onSaveLine ? <div className="lua-change-current-code lua-code-editor">{lines?.map(row => <EditableSyntaxLine key={row.number} line={row.number} text={row.text} errorLine={false}
              disabled={Boolean(loading || savingKey || (editingLine !== null && editingLine !== row.number))} saving={savingKey === `${selected.pathLabel}:line:${row.number}`}
              onEditingChange={editing => { setEditingLine(editing ? row.number : null); props.onEditingChange?.(editing); }}
              onSave={(replacement, expectedLine) => onSaveLine(selected, row.number, replacement, expectedLine)} />)}</div>
              : showFull ? <pre>{selected.after || '（空）'}</pre> : <RouterCodePanel source={selected.after} peer={selected.before} tone="after" />}
            {!selected.luaPathJson && !rule && <small>此路径没有可用的脚本编辑接口，当前仅显示对比。</small>}
          </div>
        </div>
      </div> : <div className="lua-simple-empty">{changes.length ? '没有匹配的修改路径。' : mode === 'lua' ? '当前没有可编辑的 Lua 脚本。' : '当前正则与原始文件一致。'}</div>}
    </div>
  </section>;
}
