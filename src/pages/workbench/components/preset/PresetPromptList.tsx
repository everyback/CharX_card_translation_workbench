import { Button } from '@/shared/ui/button/Button';
import { useState } from 'react';
import { Check, Pencil, RotateCcw, ToggleLeft, X } from 'lucide-react';
import type { PresetPromptView } from '@/features/preset/model/types';

interface PresetPromptListProps {
  prompts: PresetPromptView[];
  busy: boolean;
  onSave: (path: Array<string | number>, text: string) => Promise<boolean>;
  onReset: (path: Array<string | number>) => Promise<boolean>;
}

const STATE_LABEL: Record<PresetPromptView['state'], string> = {
  always: '常驻',
  gated: '开关',
  dropped: '未映射',
  covered: '原生承载',
  archived: '存档',
};

function StateBadge({ prompt }: { prompt: PresetPromptView }) {
  if (prompt.state === 'gated') {
    return <span className="preset-badge gated" title="首次使用默认关闭；重新导入沿用该预设已保存的状态，可在 RisuAI 开关面板修改"><ToggleLeft size={12} />开关</span>;
  }
  if (prompt.state === 'always') {
    return <span className="preset-badge always" title="每次请求都会发送"><Check size={12} />常驻</span>;
  }
  return <span className="preset-badge dropped" title={prompt.dropReason}><X size={12} />{STATE_LABEL[prompt.state]}</span>;
}

/**
 * The prompt library, in conversion order: block entries first, then the
 * unreferenced library prompts. Editing is inline rather than modal — with over a
 * hundred rows a dialog would break the surrounding context on every change.
 */
export function PresetPromptList({ prompts, busy, onSave, onReset }: PresetPromptListProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [onlyEdited, setOnlyEdited] = useState(false);

  const editedCount = prompts.filter((prompt) => prompt.edited).length;
  const visible = onlyEdited ? prompts.filter((prompt) => prompt.edited) : prompts;

  const begin = (prompt: PresetPromptView) => {
    setEditing(prompt.identifier);
    setDraftText(prompt.content);
  };

  const commit = async (prompt: PresetPromptView) => {
    if (draftText === prompt.content) {
      setEditing(null);
      return;
    }
    const saved = await onSave(prompt.path, draftText);
    if (saved) setEditing(null);
  };

  return (
    <section className="preset-panel" aria-label="提示词清单">
      <div className="preset-panel-head">
        <div>
          <h2>提示词清单</h2>
          <span>{prompts.length} 条 · 按转换后的顺序排列</span>
        </div>
        <div className="preset-list-actions">
          <label className="preset-checkbox">
            <input type="checkbox" checked={onlyEdited} onChange={(event) => setOnlyEdited(event.target.checked)} />
            仅看已改动{editedCount ? `（${editedCount}）` : ''}
          </label>
        </div>
      </div>

      <div className="preset-prompt-list">
        {visible.map((prompt) => {
          const key = prompt.identifier;
          const isEditing = editing === key;
          return (
            <article className={`preset-prompt ${prompt.edited ? 'edited' : ''}`} key={key}>
              <header>
                <StateBadge prompt={prompt} />
                <span className="preset-prompt-name" title={prompt.name}>{prompt.name}</span>
                <span className="preset-prompt-id" title={prompt.identifier}>{prompt.identifier}</span>
                {prompt.source === 'orphan' && <span className="preset-badge orphan" title="当前所选 prompt_order 块未引用">可选库</span>}
                {prompt.dropReason && <span className="preset-prompt-reason" title={prompt.dropReason}>{prompt.dropReason}</span>}
                <span className="preset-prompt-spacer" />
                {isEditing ? (
                  <>
                    <Button variant="outline" className="compact-button" type="button" disabled={busy} onClick={() => void commit(prompt)}><Check size={13} />完成</Button>
                    <button className="link-button" type="button" onClick={() => setEditing(null)}>取消</button>
                  </>
                ) : (
                  <>
                    <Button variant="outline" className="compact-button" type="button" disabled={busy} onClick={() => begin(prompt)}><Pencil size={13} />编辑</Button>
                    {prompt.edited && (
                      <button className="link-button" type="button" disabled={busy} onClick={() => void onReset(prompt.path)}><RotateCcw size={13} />恢复</button>
                    )}
                  </>
                )}
              </header>
              {isEditing ? (
                <textarea
                  className="preset-prompt-editor"
                  value={draftText}
                  spellCheck={false}
                  rows={Math.min(24, Math.max(6, draftText.split('\n').length + 1))}
                  onChange={(event) => setDraftText(event.target.value)}
                />
              ) : (
                <pre className="preset-prompt-body">{prompt.content || '（空）'}</pre>
              )}
            </article>
          );
        })}
        {!visible.length && <p className="preset-empty">{onlyEdited ? '还没有改动过的提示词。' : '没有提示词。'}</p>}
      </div>
    </section>
  );
}
