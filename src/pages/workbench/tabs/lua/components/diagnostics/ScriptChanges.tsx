import { useState } from 'react';
import type { LuaManagementReport } from '@/shared/types';
import { RouterCodePanel } from '../router/RouterCodePanel';

export function ScriptChanges({ changes }: { changes: LuaManagementReport['scriptChanges'] }) {
  const [query, setQuery] = useState('');
  const filtered = changes.filter(change => change.pathLabel.toLowerCase().includes(query.toLowerCase()));
  return <section className="lua-panel lua-script-changes" id="lua-script-changes">
    <div className="lua-panel-header"><div><h2>脚本修改前后对比</h2><span>原始文件与当前审核稿的 Lua、正则输入和输出；修复成功后仍保留对比。未通过审核的译文请到审核页查看。</span></div></div>
    <div className="lua-changes-toolbar"><input aria-label="搜索脚本修改路径" placeholder="搜索修改路径" value={query} onChange={event => setQuery(event.target.value)} /><span>{filtered.length} / {changes.length} 处修改</span></div>
    <div className="lua-changes-list">{filtered.map(change => <details className="lua-change" key={change.pathLabel}>
      <summary>{change.pathLabel}</summary>
      <ChangeComparison change={change} />
    </details>)}</div>
    {!filtered.length && <div className="lua-simple-empty">{changes.length ? '没有匹配的修改路径。' : '当前审核稿的脚本与原始文件一致。'}</div>}
  </section>;
}

function ChangeComparison({ change }: { change: LuaManagementReport['scriptChanges'][number] }) {
  const [full, setFull] = useState(false);
  return <div className="lua-change-body">
    <label><input type="checkbox" checked={full} onChange={event => setFull(event.target.checked)} />显示完整代码</label>
    <div className="lua-change-columns">
      <div><strong>修改前 · 原始文件</strong>{full ? <pre>{change.before || '（空）'}</pre> : <RouterCodePanel source={change.before} peer={change.after} tone="before" />}</div>
      <div><strong>修改后 · 当前审核稿</strong>{full ? <pre>{change.after || '（空）'}</pre> : <RouterCodePanel source={change.after} peer={change.before} tone="after" />}</div>
    </div>
  </div>;
}
