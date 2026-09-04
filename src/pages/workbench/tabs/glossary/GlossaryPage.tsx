import { BookOpenText, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { GlossaryTerm } from '@/shared/types';

export function GlossaryPage({
  terms,
  busy,
  onAdd,
  onDelete,
}: {
  terms: GlossaryTerm[];
  busy: boolean;
  onAdd: (input: Omit<GlossaryTerm, 'id' | 'createdAt' | 'updatedAt'>) => Promise<void> | undefined;
  onDelete: (termId: string) => void;
}) {
  const [sourceText, setSourceText] = useState('');
  const [targetText, setTargetText] = useState('');
  const [notes, setNotes] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);

  async function submit() {
    if (!sourceText.trim() || !targetText.trim()) return;
    await onAdd({ sourceText: sourceText.trim(), targetText: targetText.trim(), notes: notes.trim(), caseSensitive });
    setSourceText('');
    setTargetText('');
    setNotes('');
    setCaseSensitive(false);
  }

  return (
    <section className="glossary-section">
      <div className="glossary-entry-row">
        <label><span>原词</span><input value={sourceText} onChange={(event) => setSourceText(event.target.value)} placeholder="源语言术语" /></label>
        <label><span>固定译法</span><input value={targetText} onChange={(event) => setTargetText(event.target.value)} placeholder="目标语言译法" /></label>
        <label className="notes-field"><span>备注</span><input value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="人物、地点或使用条件" /></label>
        <label className="case-field"><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.target.checked)} />区分大小写</label>
        <button className="primary-button" onClick={() => void submit()} disabled={busy || !sourceText.trim() || !targetText.trim()}><Plus size={16} />添加</button>
      </div>
      <div className="glossary-table">
        <div className="glossary-head"><span>原词</span><span>固定译法</span><span>备注</span><span>匹配</span><span /></div>
        {terms.map((term) => (
          <div className="glossary-row" key={term.id}>
            <strong>{term.sourceText}</strong>
            <span>{term.targetText}</span>
            <span className="muted-text">{term.notes || '—'}</span>
            <span>{term.caseSensitive ? '区分大小写' : '忽略大小写'}</span>
            <button className="icon-button danger-ghost" title="删除术语" onClick={() => onDelete(term.id)}><Trash2 size={15} /></button>
          </div>
        ))}
        {!terms.length && <div className="glossary-empty"><BookOpenText size={22} />暂无术语</div>}
      </div>
    </section>
  );
}
