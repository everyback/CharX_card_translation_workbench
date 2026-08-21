import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ControlReference } from '../../types';

export function ReferencesView({ references }: { references: ControlReference[] }) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<'all' | 'regex' | 'lua'>('all');
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return references.filter((reference) => (
      (kind === 'all' || reference.kind === kind)
      && (!normalized || [reference.literal, reference.pathLabel, reference.pattern]
        .some((value) => value.toLowerCase().includes(normalized)))
    ));
  }, [references, query, kind]);

  return (
    <section className="reference-section">
      <div className="table-toolbar">
        <div className="search-input"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索触发词或关联路径" /></div>
        <select aria-label="引用类型" value={kind} onChange={(event) => setKind(event.target.value as 'all' | 'regex' | 'lua')}>
          <option value="all">全部引用</option>
          <option value="regex">正则触发</option>
          <option value="lua">Lua 控制</option>
        </select>
        <span className="result-count">{filtered.length} 条</span>
      </div>
      <div className="reference-table">
        <div className="reference-head"><span>受保护值</span><span>类型</span><span>关联路径</span><span>模式 / 上下文</span></div>
        {filtered.map((reference, index) => (
          <div className="reference-row" key={`${reference.kind}:${reference.pathLabel}:${reference.literal}:${index}`}>
            <code>{reference.literal}</code>
            <span>{reference.kind === 'regex' ? '正则触发' : 'Lua 控制'}</span>
            <span>{reference.pathLabel}</span>
            <code>{reference.pattern}</code>
          </div>
        ))}
        {!filtered.length && <div className="table-empty">没有符合条件的脚本引用</div>}
      </div>
    </section>
  );
}
