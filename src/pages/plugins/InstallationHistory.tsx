import { useEffect, useState } from 'react';
import { History, RefreshCw, Undo2 } from 'lucide-react';
import { patchCatalog } from './patch-catalog';

type RecordEntry = { id: string; patch: string; installedAt: string; state: string; revision?: string; availableRevision?: string; updateAvailable?: boolean; reason?: string; canRemove: boolean; removeToken?: string; backup?: string; targets: Array<{ file: string; backup: string; before: string; after: string }> };
type HistoryResult = { deployment: string; target: string; image?: string; records: RecordEntry[] };
const labels: Record<string, string> = { verified: '文件已核验', blocked: '恢复受限', removed: '已恢复', deployed: '镜像安装记录', prepared: '部署未完成', failed: '部署失败', 'recovery-required': '需要人工恢复' };

export function InstallationHistory({ endpoint, root, onChanged, onInspect }: { endpoint: 'remote-patch' | 'patch-agent'; root: string; onChanged: () => void; onInspect?: (patch: string) => void }) {
  const [result, setResult] = useState<HistoryResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function request(action: string, payload: object) {
    const response = await fetch(`/api/${endpoint}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    return data;
  }
  async function refresh() {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await request('history', { root })); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void refresh(); }, [endpoint, root]);
  async function remove(record: RecordEntry) {
    if (!window.confirm(`确定恢复“${patchCatalog.find((item) => item.id === record.patch)?.name || record.patch}”安装前的${result?.deployment === 'docker' ? '镜像？服务将重启' : '文件？恢复后仍需按部署方式重建或重启'}？`)) return;
    setBusy(true); setError('');
    try {
      await request('remove', { token: record.removeToken });
      onChanged();
      setResult(await request('history', { root }));
    } catch (error) { setError((error as Error).message); setResult(null); }
    finally { setBusy(false); }
  }
  return <section className="patch-history" aria-label="安装记录">
    <div className="patch-section-title"><h3><History size={17} />安装记录</h3><button className="secondary-button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} />重新核验</button></div>
    {error && <div className="patch-status error" role="alert">{error}</div>}
    {busy && <p role="status">正在处理目标与备份，请勿关闭工作台…</p>}
    {result?.image && <p className="patch-identity">运行镜像 <code>{result.image}</code></p>}
    {result && !result.records.length && <div className="patch-empty"><History size={28} /><strong>没有此目标的安装记录</strong><p>不代表未安装补丁。原生功能、手动安装和旧版 Docker 安装需要重新预检，不能凭空生成卸载备份。</p></div>}
    {result?.records.map((record) => <article className="patch-history-row" key={record.id}>
      <div className="patch-section-title"><div><h4>{patchCatalog.find((item) => item.id === record.patch)?.name || record.patch}</h4><time>{record.installedAt}</time></div><span className={`patch-badge ${record.canRemove ? 'success' : ''}`}>{labels[record.state] || record.state}</span></div>
      <dl className="patch-facts"><div><dt>脚本修订</dt><dd><code>{record.revision?.slice(0, 12) || '旧记录，未记录修订'}</code>{record.updateAvailable && <strong> · 工作台脚本已更新，需重新预检</strong>}</dd></div><div><dt>恢复条件</dt><dd>{record.canRemove ? '当前目标与备份匹配，可恢复' : record.reason || '不能自动恢复'}</dd></div></dl>
      <details><summary>文件与备份</summary>{record.backup && <code>{record.backup}</code>}{record.targets?.map((target) => <div className="patch-record-file" key={target.file}><code>{target.file}</code><small>备份：{target.backup}</small><small>{target.before.slice(0, 12)} → {target.after.slice(0, 12)}</small></div>)}</details>
      <button className="secondary-button" disabled={busy || !record.canRemove || !record.removeToken} onClick={() => void remove(record)}><Undo2 size={15} />{result?.deployment === 'docker' ? '回滚此镜像安装' : '卸载并恢复备份'}</button>
      {record.updateAvailable && onInspect && <button className="secondary-button" disabled={busy} onClick={() => onInspect(record.patch)}><RefreshCw size={15} />核对更新</button>}
    </article>)}
  </section>;
}
