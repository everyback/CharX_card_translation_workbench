import { Button } from '@/shared/ui/button/Button';
import { useEffect, useRef, useState, type DragEvent } from 'react';
import { AlertTriangle, FileKey2, FolderSearch, HardDrive, RefreshCw, Server, Unplug, X } from 'lucide-react';
import { PatchDependencies } from './PatchDependencies';
import { InstallationHistory } from './InstallationHistory';
import { PatchList } from './PatchList';
import { patchCatalog } from './patch-catalog';

type Role = 'target' | 'frontend' | 'server';
type Deployment = 'docker' | 'bare';
type RemoteStatus = { enabled: boolean; connected: boolean; host?: string; user?: string; deployment?: Deployment; target?: string; patches: string[] };
type Discovery = { image: string; identity?: { kind: string; version: string; health: string }; targets: Array<{ role: Role; file: string; hash: string }> };
type Inventory = { containers: string[]; roots: string[] };
const storageKey = 'cardloom:remote-patch-profile:v2';
function savedProfile(): { host: string; user: string; keyFile: string; deployment: Deployment; target: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
    return { host: typeof saved.host === 'string' ? saved.host : '', user: typeof saved.user === 'string' ? saved.user : 'ubuntu', keyFile: typeof saved.keyFile === 'string' && !saved.keyFile.startsWith('ssh-key:') ? saved.keyFile : '', deployment: saved.deployment === 'bare' ? 'bare' : 'docker', target: typeof saved.target === 'string' ? saved.target : '' };
  } catch { return { host: '', user: 'ubuntu', keyFile: '', deployment: 'docker', target: '' }; }
}
const names: Record<string, string> = {
  'plugin-v21-import': 'API 2.1 插件导入兼容', 'preset-switch': '预设切换保护',
  'api-profiles': '自定义 API 配置档与模型列表', 'image-router': '图像路由',
  'read-performance': '远程读取性能', 'read-cache': '远程资源本地缓存', 'list-cache': '资源清单缓存',
};
const roles: Record<string, Role[]> = {
  'plugin-v21-import': ['target'], 'preset-switch': ['frontend'], 'api-profiles': ['frontend'],
  'image-router': ['frontend'], 'read-performance': ['frontend', 'server'],
  'read-cache': ['frontend'], 'list-cache': ['frontend', 'server'],
};
async function post<T>(endpoint: string, payload: object): Promise<T> {
  const response = await fetch(`/api/remote-patch/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || '远程操作失败。');
  return result;
}
export function RemotePatchPanel({ directAgentConfigured = false }: { directAgentConfigured?: boolean }) {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [initial] = useState(savedProfile);
  const [host, setHost] = useState(initial.host);
  const [user, setUser] = useState(initial.user);
  const [keyFile, setKeyFile] = useState(initial.keyFile);
  const [keyLabel, setKeyLabel] = useState('');
  const [keyDragging, setKeyDragging] = useState(false);
  const keyPicker = useRef<HTMLInputElement>(null);
  const [deployment, setDeployment] = useState<Deployment>(initial.deployment);
  const [target, setTarget] = useState(initial.target);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [patch, setPatch] = useState('preset-switch');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [files, setFiles] = useState<Partial<Record<Role, string>>>({});
  const [output, setOutput] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'patches' | 'history'>('patches');
  const [phase, setPhase] = useState('idle');
  const activePatch = patchCatalog.find((item) => item.id === patch);
  const phaseLabels: Record<string, string> = { idle: '尚未预检', working: '正在执行', ready: '预检通过 · 可安装', current: '已具备此功能 · 无需安装', error: '操作失败', dependencies: '缺少前置补丁', installed: '已安装 · 待运行验证', expired: '预检已过期', selected: '已读取文件 · 待预检' };
  useEffect(() => { if (!token) return; const timer = window.setTimeout(() => { setToken(null); setPhase('expired'); }, 900_000); return () => window.clearTimeout(timer); }, [token]);
  useEffect(() => { let active = true; void fetch('/api/remote-patch').then((response) => { if (!response.ok) throw new Error('无法读取 SSH 通道状态，请刷新重试。'); return response.json(); }).then((result: RemoteStatus) => { if (active) setStatus(result); }).catch(() => { if (active) setLoadError('无法读取 SSH 通道状态，请刷新重试。'); }); return () => { active = false; }; }, []);
  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify({ host, user, keyFile: keyFile.startsWith('ssh-key:') ? '' : keyFile, deployment, target })); } catch { /* Private browsing may disable storage. */ } }, [host, user, keyFile, deployment, target]);
  if (!status) return <div className="patch-status" role="status">{loadError || '正在读取 SSH 通道状态…'}</div>;
  if (!status.enabled) return directAgentConfigured ? null : <div className="plugin-limited-access" role="note"><AlertTriangle size={18} /><div>当前工作台未启用本机 SSH 通道。请使用桌面版、Node 版或离线工具。</div></div>;
  async function act(task: () => Promise<void>) {
    setBusy(true); setOutput(''); setPhase('working');
    try { await task(); } catch (error) { setOutput(error instanceof Error ? error.message : '操作失败。'); setToken(null); setPhase(error instanceof Error && error.message.includes('前置补丁') ? 'dependencies' : 'error'); }
    finally { setBusy(false); }
  }
  function releaseKey(reference: string) {
    if (!reference.startsWith('ssh-key:')) return;
    void fetch('/api/remote-patch/key', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keyFile: reference }) }).catch(() => {});
  }
  async function importKey(files: FileList | null) {
    if (!files?.length) return;
    if (files.length !== 1 || files[0].size > 64 * 1024) { setOutput('请只选择一个不超过 64 KiB 的 SSH 私钥文件。'); return; }
    const file = files[0];
    await act(async () => {
      const form = new FormData();
      form.append('file', file);
      const response = await fetch('/api/remote-patch/key', { method: 'POST', body: form });
      const result = await response.json() as { keyFile?: string; error?: string };
      if (!response.ok || !result.keyFile) throw new Error(result.error || '导入 SSH 私钥失败。');
      releaseKey(keyFile);
      setKeyFile(result.keyFile);
      setKeyLabel(file.name);
      setPhase('idle');
      setInventory(null);
      setOutput('密钥已导入本机工作台，断开连接时删除。');
    });
  }
  function handleKeyDrag(event: DragEvent<HTMLElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setKeyDragging(true);
  }
  function handleKeyDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault(); event.stopPropagation();
    setKeyDragging(false);
    if (!busy) void importKey(event.dataTransfer.files);
  }
  async function connect() {
    await act(async () => {
      const connected = await post<RemoteStatus>('connect', { host, user, keyFile, deployment, target });
      setStatus(connected); setDiscovery(null); setToken(null);
      setPatch('preset-switch'); setPhase('idle'); setView('patches');
      setOutput('目标已连接。请选择补丁并读取目标文件。');
    });
  }
  async function probe() {
    await act(async () => {
      const found = await post<Inventory>('probe', { host, user, keyFile });
      setInventory(found); setPhase('idle');
      if (deployment === 'docker' && !found.containers.includes(target)) setTarget(found.containers.length === 1 ? found.containers[0] : '');
      if (deployment === 'bare' && !target && found.roots.length === 1) setTarget(found.roots[0]);
      setOutput(`发现 ${found.containers.length} 个运行容器、${found.roots.length} 个项目目录。`);
    });
  }
  async function discover(name = patch) {
    await act(async () => {
      const found = await post<Discovery>('discover', { patch: name });
      setDiscovery(found); setFiles(Object.fromEntries((roles[name] || []).map((role) => { const candidates = found.targets.filter((item) => item.role === role); return [role, candidates.length === 1 ? candidates[0].file : '']; })));
      setToken(null); setPhase('selected'); setOutput(`${status?.deployment === 'docker' ? '当前镜像' : '项目标识'} ${found.image}；请核对目标文件后预检。`);
    });
  }
  async function preflight() {
    await act(async () => {
      const result = await post<{ output: string; changed: boolean; token: string | null }>('preflight', { patch, files });
      setToken(result.token); setPhase(result.changed ? 'ready' : 'current'); setOutput(result.output + (result.changed ? '\n预检通过，可安装：预检结果 15 分钟内有效。' : '\n预检通过：目标已具备此补丁的修改，无需重复安装。安装按钮保持禁用。'));
    });
  }
  async function apply() {
    if (!window.confirm(status?.deployment === 'docker' ? `将对 ${status.host} 的 ${status.target} 构建镜像并切换 Compose 服务，失败时尝试回滚。确定安装“${names[patch]}”吗？` : `将备份并修改 ${status?.host}:${status?.target} 的项目文件。安装后需按该项目的方式重建或重启。确定安装“${names[patch]}”吗？`)) return;
    await act(async () => {
      const result = await post<{ output: string; installed: boolean }>('apply', { token });
      setToken(null); setDiscovery(null); setPhase(result.installed ? 'installed' : 'current');
      setOutput(result.output + (result.installed ? status?.deployment === 'bare' ? '\n文件已写入并备份。请重建或重启 RisuAI，再在网页验证。' : '\n请在 RisuAI 网页确认功能，再检查服务器日志。' : '\n未改动目标。'));
    });
  }
  return <div className="remote-patch-workspace plugin-prerequisite-agent" aria-label="通过 SSH 安装远程补丁">
    <div className="remote-patch-header"><div><h3>部署目标</h3><p>SSH 通道 · Docker Node 优先</p></div><span className={status.connected ? 'ready' : ''}>{status.connected ? '已连接' : '等待连接'}</span></div>
    {!status.connected ? <>
      <div className="remote-deployment" role="group" aria-label="部署方式">
        <button type="button" className={deployment === 'docker' ? 'active' : ''} aria-pressed={deployment === 'docker'} onClick={() => { setDeployment('docker'); setTarget(''); }}><Server size={17} /><span><strong>Docker</strong><small>从运行容器中选择</small></span></button>
        <button type="button" className={deployment === 'bare' ? 'active' : ''} aria-pressed={deployment === 'bare'} onClick={() => { setDeployment('bare'); setTarget(''); }}><HardDrive size={17} /><span><strong>裸部署</strong><small>搜索或填写项目目录</small></span></button>
      </div>
      <div className="patch-agent-form remote-patch-form">
        <label>服务器地址<input value={host} onChange={(event) => { setHost(event.target.value); setInventory(null); }} placeholder="IP 或主机名" autoComplete="off" /></label>
        <label>SSH 用户<input value={user} onChange={(event) => { setUser(event.target.value); setInventory(null); }} autoComplete="off" /></label>
        <div className="remote-patch-wide remote-key-field">
          <label htmlFor="remote-ssh-key">本机 SSH 私钥</label>
          <div className={`remote-key-drop${keyDragging ? ' dragging' : ''}`} data-ssh-key-drop onDragEnter={handleKeyDrag} onDragOver={handleKeyDrag} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setKeyDragging(false); }} onDrop={handleKeyDrop}>
            <FileKey2 size={17} aria-hidden="true" />
            <input id="remote-ssh-key" value={keyLabel ? `已导入：${keyLabel}` : keyFile} readOnly={Boolean(keyLabel)} onChange={(event) => { setKeyFile(event.target.value); setInventory(null); }} placeholder="拖入私钥文件，或填写本机绝对路径" autoComplete="off" />
            {keyLabel && <button type="button" className="remote-key-clear" title="清除已导入密钥" aria-label="清除已导入密钥" onClick={() => { releaseKey(keyFile); setKeyFile(''); setKeyLabel(''); setInventory(null); }}><X size={15} /></button>}
            <button type="button" className="remote-key-browse" disabled={busy} onClick={() => keyPicker.current?.click()}>选择文件</button>
          </div>
          <input ref={keyPicker} className="remote-key-picker" type="file" tabIndex={-1} aria-label="选择 SSH 私钥文件" onChange={(event) => { void importKey(event.target.files); event.target.value = ''; }} />
        </div>
      </div>
      <div className="remote-target-heading"><strong>部署目标</strong><Button type="button" variant="outline" disabled={busy || !host || !user || !keyFile} onClick={() => void probe()}><FolderSearch size={15} />扫描服务器</Button></div>
      {deployment === 'docker' ? <label className="remote-target-field">运行中的容器<select value={target} onChange={(event) => setTarget(event.target.value)} disabled={!inventory}><option value="">{inventory ? '选择容器' : '先扫描服务器'}</option>{inventory?.containers.map((item) => <option key={item} value={item}>{item}</option>)}</select></label> : <div className="remote-target-field"><label>检测到的项目目录<select value={inventory?.roots.includes(target) ? target : ''} onChange={(event) => setTarget(event.target.value)} disabled={!inventory}><option value="">{inventory ? '选择目录或在下方填写' : '先扫描服务器'}</option>{inventory?.roots.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>项目绝对目录<input value={target} onChange={(event) => setTarget(event.target.value)} placeholder="/opt/risuai" autoComplete="off" /></label></div>}
      <div className="remote-patch-footer"><span>连接信息保存在此浏览器。拖入的私钥暂存在本机工作台，断开连接或关闭工作台时删除；不会传到远程服务器。</span><Button type="button" variant="default" disabled={busy || !host || !user || !keyFile || !target || (deployment === 'docker' && !inventory?.containers.includes(target))} onClick={() => void connect()}>连接所选目标</Button></div>
    </> : <>
      <div className="remote-connected"><div><strong>{status.deployment === 'docker' ? 'Docker 容器' : '项目目录'}</strong><span>{status.user}@{status.host} · {status.target}</span></div><Button type="button" variant="outline" disabled={busy} onClick={() => void act(async () => { const next = await post<RemoteStatus>('disconnect', {}); setStatus(next); setDiscovery(null); setToken(null); if (keyFile.startsWith('ssh-key:')) { setKeyFile(''); setKeyLabel(''); setInventory(null); } })}><Unplug size={15} />更换目标</Button></div>
      <div className="patch-identity">{status.deployment === 'bare' ? '项目目录：仅核验文件，尚未关联运行实例；源码变更后需要重建。' : '运行容器：安装会构建新镜像并重建当前 Compose 服务。'}</div>
      {discovery && status.deployment === 'docker' && <div className="patch-identity"><span>RisuAI {discovery.identity?.version === 'unknown' || !discovery.identity ? '版本未识别' : discovery.identity.version}</span><span>容器状态：{discovery.identity?.health || '未核验'}</span><code>镜像 {discovery.image}</code></div>}
      <div className="patch-subtabs" role="tablist" aria-label="目标工作区">
        <button role="tab" aria-selected={view === 'patches'} disabled={busy} onClick={() => setView('patches')}>可用补丁</button>
        <button role="tab" aria-selected={view === 'history'} disabled={busy} onClick={() => setView('history')}>安装记录与恢复</button>
      </div>
      {view === 'history' ? <InstallationHistory endpoint="remote-patch" root={status.target || ''} onChanged={() => { setToken(null); setDiscovery(null); setPhase('idle'); }} onInspect={(name) => { if (!status.patches.includes(name)) return; setPatch(name); setView('patches'); setToken(null); setDiscovery(null); void discover(name); }} /> : <div className="patch-editor-layout">
      <PatchList value={patch} available={status.patches} disabled={busy} onChange={(value) => { setPatch(value); setDiscovery(null); setToken(null); setOutput(''); setPhase('idle'); }} />
      <section className="patch-editor" aria-label="补丁详情">
      <div className="patch-section-title"><h3>{names[patch]}</h3><span className="patch-badge">{activePatch?.kind === 'source' ? '源码 · 需要重建' : '构建文件'}</span></div>
      <p className="patch-description">{activePatch?.purpose}</p>
      <PatchDependencies patch={patch} />
      <div className={'patch-status ' + (phase === 'ready' || phase === 'current' ? 'success' : phase === 'error' || phase === 'dependencies' ? 'error' : '')} role="status">{phaseLabels[phase] || phaseLabels.idle}</div>
      <fieldset disabled={busy} className="patch-target-controls"><legend>目标文件</legend>
      <Button type="button" variant="outline" onClick={() => void discover()}><RefreshCw size={15} />读取 / 刷新文件</Button>
      <div className="patch-agent-form">
        {discovery && roles[patch].map((role) => <label key={role}>{role === 'frontend' ? '前端文件' : role === 'server' ? '服务端文件' : '源码文件'}<select value={files[role] || ''} onChange={(event) => { setFiles((current) => ({ ...current, [role]: event.target.value })); setToken(null); }}><option value="">选择目标</option>{discovery.targets.filter((item) => item.role === role).map((item) => <option key={item.file} value={item.file}>{item.file} · {item.hash.slice(0, 12)}</option>)}</select></label>)}
      </div>
      </fieldset>
      {discovery && roles[patch].some((role) => discovery.targets.filter((item) => item.role === role).length > 1) && <p className="patch-agent-help">找到多个同类文件，请核对 RisuAI 页面实际引用的资源后手动选择。</p>}
      {discovery && !roles[patch].every((role) => files[role]) && <div className="plugin-limited-access" role="note"><AlertTriangle size={18} /><div>当前目标缺少此补丁需要的文件，不能预检或安装。</div></div>}
      <div className="plugin-install-actions"><Button type="button" variant="outline" disabled={busy || !discovery || !roles[patch].every((role) => files[role])} onClick={() => void preflight()}>预检兼容性</Button><Button type="button" variant="default" disabled={busy || !token} onClick={() => void apply()}>{status.deployment === 'bare' ? '备份并安装文件' : '构建并安装到 RisuAI'}</Button></div>
      <details className="patch-verification"><summary>安装后核验</summary><p>{activePatch?.verify}</p></details>
      </section></div>}
    </>}
    {output && <details className="patch-log" open={phase === 'error' || phase === 'dependencies'}><summary>操作日志</summary><pre className="patch-agent-output">{output}</pre></details>}
  </div>;
}
