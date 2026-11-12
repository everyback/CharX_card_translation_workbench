import { useState } from 'react';
import { Button } from '@/shared/ui/button/Button';

interface RepairPreview {
  planId: string;
  changes: Array<{ id: string; pathLabel: string; attribute: string; element: number; before: string; after: string; callbackVerified: boolean }>;
  unresolved: Array<{ pathLabel: string; message: string }>;
  diagnostics: Array<{ pathLabel: string; name: string; message: string }>;
  method: string;
}

export function IdentifierRepairPanel() {
  const [original, setOriginal] = useState<File | null>(null);
  const [translated, setTranslated] = useState<File | null>(null);
  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [approved, setApproved] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  function reset() { setPreview(null); setApproved([]); setMessage(''); }
  async function run(exporting: boolean) {
    if (!original || !translated) return;
    setBusy(true); setMessage('');
    try {
      const body = new FormData();
      body.append('original', original); body.append('translated', translated);
      if (exporting) body.append('approval', JSON.stringify({ planId: preview?.planId, approvedIds: approved }));
      const response = await fetch(`/api/identifier-repair/${exporting ? 'export' : 'preview'}`, { method: 'POST', body });
      if (!response.ok) throw new Error((await response.json()).error || '修复操作失败。');
      if (!exporting) { setPreview(await response.json()); setApproved([]); }
      else {
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.download = translated.name.replace(/\.charx$/iu, '.identifier-repaired.charx');
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        setMessage(`已导出 ${approved.length} 项审核后的修复。仍有 ${response.headers.get('X-Unresolved-Actions') ?? '未知'} 处动作需要核对（可能由运行时动态注册）。请在目标客户端复核。`);
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  return <details className="export-main">
    <summary>修复旧译卡中的程序标识符（CHARX）</summary>
    <p>分别选择正确原件和旧译卡，预览后逐项勾选。只从能唯一对齐的原件位置恢复控制属性，保留译文、模块和资源。不会修改当前项目或上传文件。</p>
    <p>Lua 代码、无法对齐的结构和动态回调需另行核对；没有正确原件时，请重新获取原件后回填已审核译文，不能猜测回调。</p>
    <label>正确原件 <input aria-label="修复使用的正确原件" type="file" accept=".charx" disabled={busy} onChange={e => { reset(); setOriginal(e.target.files?.[0] ?? null); }} /></label>
    <label>待修复译卡 <input aria-label="待修复译卡" type="file" accept=".charx" disabled={busy} onChange={e => { reset(); setTranslated(e.target.files?.[0] ?? null); }} /></label>
    <Button variant="outline" disabled={busy || !original || !translated} onClick={() => void run(false)}>{busy ? '正在检查…' : '生成修复清单'}</Button>
    {preview && <>
      <p>{preview.method}</p>
      <p>找到 {preview.changes.length} 项属性差异，{preview.unresolved.length} 处无法对齐；当前译卡有 {preview.diagnostics.length} 处动作未能静态确认回调。</p>
      <div style={{ overflowX: 'auto', maxHeight: 420 }}><table><thead><tr><th>审核</th><th>位置 / 属性</th><th>旧值</th><th>原件值</th><th>回调证据</th></tr></thead><tbody>
        {preview.changes.map(c => <tr key={c.id}><td><input type="checkbox" aria-label={`确认修复 ${c.before}`} disabled={busy} checked={approved.includes(c.id)} onChange={e => setApproved(ids => e.target.checked ? [...ids, c.id] : ids.filter(id => id !== c.id))} /></td>
          <td>{c.pathLabel} · 元素 {c.element + 1} @{c.attribute}</td><td><code>{c.before}</code></td><td><code>{c.after}</code></td><td>{c.callbackVerified ? '当前 Lua 中存在静态定义' : '原件位置映射；需人工核对'}</td></tr>)}
      </tbody></table></div>
      {preview.unresolved.length > 0 && <details><summary>无法自动对齐的位置</summary>{preview.unresolved.map((i, n) => <p key={n}>{i.pathLabel}：{i.message}</p>)}</details>}
      {preview.diagnostics.length > 0 && <details><summary>待核对的动作</summary>{preview.diagnostics.map((i, n) => <p key={n}><code>{i.name}</code> · {i.pathLabel}：{i.message}</p>)}</details>}
      <Button disabled={busy || !approved.length} onClick={() => void run(true)}>导出已确认的 {approved.length} 项修复</Button>
    </>}
    {message && <p role="status">{message}</p>}
  </details>;
}
