import { useEffect, useState } from 'react';
import './patch-console.css';
import { AlertTriangle, ChevronDown, Copy, Download, FileCode2, FolderOpen, Monitor, Plug, Server } from 'lucide-react';
import { strToU8, zipSync } from 'fflate';
import bridgeSource from '../../../bridge-plugin/risu-bridge.plugin.js?raw';
import bridgeInstallerSource from '../../../bridge-plugin/install-risu-v2-plugin.cjs?raw';
import presetInstallerSource from '../../../bridge-plugin/install-risu-preset.cjs?raw';
import bridgeToolkitReadmeSource from '../../../bridge-plugin/README-install.txt?raw';
import installerSource from '../../../patches/risuai/install.mjs?raw';
import dependencySource from '../../../patches/risuai/scripts/dependencies.json?raw';
import { PatchDependencies } from './PatchDependencies';
import patchToolkitReadmeSource from '../../../patches/risuai/README.txt?raw';
import pluginImportSource from '../../../patches/risuai/scripts/patch-plugin-v21-import.mjs?raw';
import presetSwitchSource from '../../../patches/risuai/scripts/patch-preset-switch.mjs?raw';
import apiProfilesSource from '../../../patches/risuai/scripts/patch-custom-model-profiles.mjs?raw';
import imageRouterSource from '../../../patches/risuai/scripts/patch-image-router.mjs?raw';
import readBatchSource from '../../../patches/risuai/scripts/patch-read-batch.mjs?raw';
import readBatchServerSource from '../../../patches/risuai/scripts/patch-read-batch-server.mjs?raw';
import readCacheSource from '../../../patches/risuai/scripts/patch-read-cache.mjs?raw';
import readCacheEvictSource from '../../../patches/risuai/scripts/patch-read-cache-evict.mjs?raw';
import readAccountingSource from '../../../patches/risuai/scripts/patch-read-accounting-server.mjs?raw';
import listCacheSource from '../../../patches/risuai/scripts/patch-list-local-cache.mjs?raw';
import listEtagSource from '../../../patches/risuai/scripts/patch-list-etag-server.mjs?raw';
import remoteInstallerSource from '../../../patches/risuai/remote/install-remote.mjs?raw';
import cachedAssetActivatorSource from '../../../patches/risuai/remote/activate-cached-asset.mjs?raw';
import remoteShellSource from '../../../patches/risuai/remote/install-remote.sh?raw';
import linuxInstallerSource from '../../../patches/risuai/remote/install-linux.sh?raw';
import remotePowerShellSource from '../../../patches/risuai/remote/install-remote.ps1?raw';
import windowsCommandSource from '../../../patches/risuai/remote/install-windows.cmd?raw';
import windowsInstallerSource from '../../../patches/risuai/remote/install-windows.ps1?raw';
import remoteReadmeSource from '../../../patches/risuai/remote/README.txt?raw';
import { encodeWindowsPowerShell } from './package-encoding.js';
import { RemotePatchPanel } from './RemotePatchPanel.js';

import { patchCatalog as components, type ComponentKind } from './patch-catalog';
import { InstallationHistory } from './InstallationHistory';
import { PatchList } from './PatchList';
import patchStateSource from '../../../patches/risuai/patch-state.mjs?raw';
import stateStoreSource from '../../../patches/risuai/scripts/state-store.mjs?raw';
type InstallMode = 'local' | 'remote' | 'browser';
type PatchRole = 'target' | 'frontend' | 'server';
type PatchDiscovery = { patch: string; roles: PatchRole[]; installations: Array<{ root: string; targets: Record<PatchRole, string[]> }> };
type PatchAgentStatus = { enabled: boolean; configured: boolean; allowedRootCount: number; patches: string[]; canChooseRoot?: boolean; testMode?: boolean };
type ComponentRecord = {
  id: string; name: string; kind: ComponentKind; target: string; purpose: string;
  artifact: string; prerequisite: string; verify: string; command?: string;
};

type BridgeRecord = {
  id: string;
  name: string;
  purpose: string;
  artifact: string;
  install: string;
  action: 'plugin' | 'toolkit';
};

const bridgeComponents: BridgeRecord[] = [
  { id: 'bridge-plugin', name: '桥接插件', purpose: '让转换后的预设按钮在 RisuAI 中运行。', artifact: 'risu-bridge.plugin.js', install: '在 RisuAI 插件管理中导入并启用；如果提示 API 2.1 不兼容，先处理上方前置补丁。', action: 'plugin' },
  { id: 'preset-installer', name: '预设写入工具', purpose: '供无法通过 RisuAI 网页导入预设的服务器管理员使用。', artifact: 'bridge-plugin/install-risu-preset.cjs', install: '需要单个 RisuAI 预设 JSON 与 RISUSAVE 目录；不能直接传入 .risup。脚本运行时立即备份并写入，无预检。', action: 'toolkit' },
];

const kindLabels: Record<ComponentKind, string> = { source: '源码补丁', bundle: '构建补丁', server: '服务补丁' };
const patchRootStorageKey = 'cardloom:patch-agent-root:v1';
const patchSources: Record<string, string> = {
  'install.mjs': installerSource,
  'patch-state.mjs': patchStateSource,
  'scripts/state-store.mjs': stateStoreSource,
  'scripts/patch-plugin-v21-import.mjs': pluginImportSource,
  'scripts/dependencies.json': dependencySource,
  'scripts/patch-preset-switch.mjs': presetSwitchSource,
  'scripts/patch-custom-model-profiles.mjs': apiProfilesSource,
  'scripts/patch-image-router.mjs': imageRouterSource,
  'scripts/patch-read-batch.mjs': readBatchSource,
  'scripts/patch-read-batch-server.mjs': readBatchServerSource,
  'scripts/patch-read-cache.mjs': readCacheSource,
  'scripts/patch-read-cache-evict.mjs': readCacheEvictSource,
  'scripts/patch-read-accounting-server.mjs': readAccountingSource,
  'scripts/patch-list-local-cache.mjs': listCacheSource,
  'scripts/patch-list-etag-server.mjs': listEtagSource,
};

function downloadFile(name: string, body: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([body], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PluginManagerPage() {
  const [pageTab, setPageTab] = useState('manage');
  const [localView, setLocalView] = useState<'patches' | 'history'>('patches');
  const [agentPhase, setAgentPhase] = useState('尚未预检');
  const [filter, setFilter] = useState<'all' | ComponentKind>('all');
  const [installMode, setInstallMode] = useState<InstallMode>('remote');
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<PatchAgentStatus | null>(null);
  const [agentPatch, setAgentPatch] = useState('plugin-v21-import');
  const [discovery, setDiscovery] = useState<PatchDiscovery | null>(null);
  const [selectedRoot, setSelectedRoot] = useState('');
  const [selectedTargets, setSelectedTargets] = useState<Record<PatchRole, string>>({ target: '', frontend: '', server: '' });
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentMessage, setAgentMessage] = useState('');
  const [preflightKey, setPreflightKey] = useState('');
  const visible = components.filter((item) => filter === 'all' || item.kind === filter);
  const selectedInstallation = discovery?.installations.find((item) => item.root === selectedRoot);
  const currentKey = JSON.stringify([agentPatch, ...(['target', 'frontend', 'server'] as const).map((role) => selectedTargets[role])]);
  const targetsReady = Boolean(discovery?.roles.every((role) => selectedTargets[role]));

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const statusResponse = await fetch('/api/patch-agent');
        const status = await statusResponse.json() as PatchAgentStatus;
        if (!active) return;
        setAgentStatus(status);
        if (!status.configured && status.canChooseRoot) {
          const savedRoot = localStorage.getItem(patchRootStorageKey);
          if (savedRoot) {
            const connectResponse = await fetch('/api/patch-agent/roots', {
              method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root: savedRoot }),
            });
            if (connectResponse.ok) {
              const connected = await connectResponse.json() as PatchAgentStatus;
              setAgentStatus(connected);
              status.configured = connected.configured;
            }
          }
        }
        if (!status.configured || installMode === 'browser') { setDiscovery(null); return; }
        const response = await fetch(`/api/patch-agent/targets?patch=${encodeURIComponent(agentPatch)}`);
        const result = await response.json() as PatchDiscovery & { error?: string };
        if (!response.ok) throw new Error(result.error || '无法查找 RisuAI 目标文件。');
        if (!active) return;
        setDiscovery(result);
        const installation = result.installations.find((item) => result.roles.every((role) => item.targets[role].length === 1)) ?? result.installations[0];
        setSelectedRoot(installation?.root ?? '');
        setSelectedTargets({ target: installation?.targets.target[0] ?? '', frontend: installation?.targets.frontend[0] ?? '', server: installation?.targets.server[0] ?? '' });
        setAgentMessage('');
        setPreflightKey('');
      } catch (error) {
        if (active) setAgentMessage(error instanceof Error ? error.message : '无法连接网页安装代理。');
      }
    })();
    return () => { active = false; };
  }, [installMode, agentPatch]);

  function downloadBridge() { downloadFile('risu-bridge.plugin.js', bridgeSource, 'text/javascript;charset=utf-8'); }
  function downloadBridgeToolkit() {
    const files = { 'bridge-plugin/risu-bridge.plugin.js': strToU8(bridgeSource), 'bridge-plugin/install-risu-v2-plugin.cjs': strToU8(bridgeInstallerSource), 'bridge-plugin/install-risu-preset.cjs': strToU8(presetInstallerSource), 'README.txt': strToU8(bridgeToolkitReadmeSource) };
    downloadFile('risuai-bridge-toolkit.zip', zipSync(files), 'application/zip');
  }
  function downloadPatchToolkit() {
    const files = Object.fromEntries(Object.entries(patchSources).map(([name, body]) => [`patches/risuai/${name}`, strToU8(body)]));
    files['README.txt'] = strToU8(patchToolkitReadmeSource);
    files['patches/risuai/remote/activate-cached-asset.mjs'] = strToU8(cachedAssetActivatorSource);
    downloadFile('risuai-patch-toolkit.zip', zipSync(files), 'application/zip');
  }
  function downloadRemoteToolkit() {
    downloadInstallerToolkit('risuai-cardloom-remote.zip');
  }
  function downloadWindowsToolkit() {
    downloadInstallerToolkit('risuai-cardloom-windows-installer.zip');
  }
  function downloadInstallerToolkit(fileName: string) {
    const files: Record<string, Uint8Array> = {
      'risuai-cardloom-remote/install-remote.mjs': strToU8(remoteInstallerSource),
      'risuai-cardloom-remote/activate-cached-asset.mjs': strToU8(cachedAssetActivatorSource),
      'risuai-cardloom-remote/install-remote.sh': strToU8(remoteShellSource),
      'risuai-cardloom-remote/install-linux.sh': strToU8(linuxInstallerSource),
      'risuai-cardloom-remote/install-remote.ps1': strToU8(remotePowerShellSource),
      'risuai-cardloom-remote/install-windows.cmd': strToU8(windowsCommandSource),
      'risuai-cardloom-remote/install-windows.ps1': encodeWindowsPowerShell(windowsInstallerSource),
      'risuai-cardloom-remote/README.txt': strToU8(remoteReadmeSource),
      'risuai-cardloom-remote/bridge-plugin/risu-bridge.plugin.js': strToU8(bridgeSource),
      'risuai-cardloom-remote/bridge-plugin/install-risu-v2-plugin.cjs': strToU8(bridgeInstallerSource),
      'risuai-cardloom-remote/bridge-plugin/install-risu-preset.cjs': strToU8(presetInstallerSource),
      'risuai-cardloom-remote/bridge-plugin/README-install.txt': strToU8(bridgeToolkitReadmeSource),
      'risuai-cardloom-remote/patches/risuai/install.mjs': strToU8(installerSource),
      'risuai-cardloom-remote/patches/risuai/README.txt': strToU8(patchToolkitReadmeSource),
    };
    for (const [name, body] of Object.entries(patchSources)) files[`risuai-cardloom-remote/patches/risuai/${name}`] = strToU8(body);
    downloadFile(fileName, zipSync(files), 'application/zip');
  }
  async function copyCommand(id: string, command: string) {
    await navigator.clipboard.writeText(command); setCopiedCommand(id);
    window.setTimeout(() => setCopiedCommand((current) => current === id ? null : current), 1800);
  }
  async function runAgent(apply: boolean) {
    if (apply && !window.confirm(`将安装“${components.find((item) => item.id === agentPatch)?.name ?? agentPatch}”并备份目标文件。继续吗？`)) return;
    setAgentBusy(true); setAgentPhase('正在执行');
    setAgentMessage('');
    try {
      const response = await fetch(`/api/patch-agent/${apply ? 'apply' : 'preflight'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: agentPatch, ...selectedTargets, confirm: apply ? 'INSTALL' : undefined }),
      });
      const result = await response.json() as { output?: string; error?: string; changed?: boolean };
      if (!response.ok) throw new Error(result.error || '操作失败。');
      const nextStep = apply ? components.find((item) => item.id === agentPatch)?.verify : undefined;
      setAgentMessage(`${result.output || '操作完成。'}${nextStep ? `\n\n安装后：${nextStep}` : ''}`);
      setPreflightKey(apply || !result.changed ? '' : currentKey);
      setAgentPhase(apply ? '文件已安装 · 待重建 / 重启核验' : result.changed ? '预检通过 · 可安装' : '已具备此功能 · 无需安装');
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : '操作失败。'); setAgentPhase('操作失败');
      setPreflightKey('');
    } finally { setAgentBusy(false); }
  }
  async function chooseLocalRoot() {
    const root = await window.cardloomDesktop?.selectPatchRoot();
    if (!root) return;
    setAgentBusy(true);
    setAgentMessage('正在接入本机 RisuAI 目录…');
    try {
      const response = await fetch('/api/patch-agent/roots', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }),
      });
      const result = await response.json() as PatchAgentStatus & { error?: string };
      if (!response.ok) throw new Error(result.error || '无法接入本机目录。');
      localStorage.setItem(patchRootStorageKey, root);
      setAgentStatus(result);
      setAgentMessage('本机目录已接入，正在查找补丁目标…');
      const targetsResponse = await fetch(`/api/patch-agent/targets?patch=${encodeURIComponent(agentPatch)}`);
      const targets = await targetsResponse.json() as PatchDiscovery & { error?: string };
      if (!targetsResponse.ok) throw new Error(targets.error || '无法查找补丁目标。');
      setDiscovery(targets);
      const installation = targets.installations.find((item) => item.root === root) ?? targets.installations[0];
      setSelectedRoot(installation?.root ?? '');
      setSelectedTargets({ target: installation?.targets.target[0] ?? '', frontend: installation?.targets.frontend[0] ?? '', server: installation?.targets.server[0] ?? '' });
      setAgentMessage('本机目录已接入。请先预检，再安装补丁。');
    } catch (error) {
      setAgentMessage(error instanceof Error ? error.message : '无法接入本机目录。');
    } finally { setAgentBusy(false); }
  }

  return <section className="plugin-manager patch-console" aria-label="插件与补丁管理">
    <div className="plugin-manager-intro"><div><h2>RisuAI 补丁管理</h2><p>部署目标与补丁状态</p></div><span className="patch-badge">{components.filter((item) => item.command).length} 项可用补丁</span></div>
    <nav className="patch-page-tabs" aria-label="组件管理导航">{[['manage', '补丁管理'], ['bridge', '桥接与预设'], ['offline', '离线工具'], ['reference', '补丁说明']].map(([id, label]) => <button key={id} aria-current={pageTab === id ? 'page' : undefined} onClick={() => setPageTab(id)}>{label}</button>)}</nav>
    <div hidden={pageTab !== 'manage'}>
      <div className="patch-location" role="group" aria-label="连接方式"><button aria-pressed={installMode === 'remote'} onClick={() => setInstallMode('remote')}><Server size={16} />SSH 服务器</button><button aria-pressed={installMode === 'local'} onClick={() => setInstallMode('local')}><Monitor size={16} />工作台可访问目录</button></div>
      <div hidden={installMode !== 'remote'}><RemotePatchPanel /></div>
      {installMode === 'local' && <div className="patch-agent-panel plugin-prerequisite-agent">
        <div className="patch-agent-heading"><div><h3>项目目录</h3><p>只修改选定目录；运行版本尚未核验。</p></div><span className={agentStatus?.configured ? 'ready' : ''}>{agentStatus?.configured ? '目录已接入' : '等待选择目录'}</span></div>
        {agentStatus?.testMode && <div className="plugin-limited-access" role="note"><AlertTriangle size={18} /><div><strong>当前接入的是测试副本</strong><p>预检和安装只会操作服务器上的测试文件，不会修改运行中的 RisuAI 容器。确认兼容性后，再安排正式部署。</p></div></div>}
        {agentStatus?.configured ? <>
          {selectedRoot && <p className="patch-agent-help">目标目录：<code>{selectedRoot}</code></p>}
          <div className="patch-subtabs" role="tablist" aria-label="本机工作区"><button role="tab" aria-selected={localView === 'patches'} disabled={agentBusy} onClick={() => setLocalView('patches')}>可用补丁</button><button role="tab" aria-selected={localView === 'history'} disabled={agentBusy} onClick={() => setLocalView('history')}>安装记录与恢复</button></div>
          {localView === 'history' ? <InstallationHistory endpoint="patch-agent" root={selectedRoot} onInspect={(name) => { setAgentPatch(name); setLocalView('patches'); setPreflightKey(''); setAgentPhase('尚未预检'); }} onChanged={() => { setPreflightKey(''); setAgentPhase('尚未预检'); }} /> : <div className="patch-editor-layout"><PatchList value={agentPatch} available={components.filter((item) => item.command).map((item) => item.id)} disabled={agentBusy} onChange={(value) => { setAgentPatch(value); setDiscovery(null); setPreflightKey(''); setAgentPhase('尚未预检'); }} /><section className="patch-editor"><h3>{components.find((item) => item.id === agentPatch)?.name}</h3><p className="patch-description">{components.find((item) => item.id === agentPatch)?.purpose}</p><PatchDependencies patch={agentPatch} /><div className="patch-status" role="status">{agentPhase}</div>
          <div className="patch-agent-form">{discovery && discovery.installations.length > 1 && <label>RisuAI 安装目录<select value={selectedRoot} onChange={(event) => { const installation = discovery.installations.find((item) => item.root === event.target.value); setSelectedRoot(event.target.value); setSelectedTargets({ target: installation?.targets.target[0] ?? '', frontend: installation?.targets.frontend[0] ?? '', server: installation?.targets.server[0] ?? '' }); setPreflightKey(''); }}><option value="">选择安装目录</option>{discovery.installations.map((item) => <option key={item.root} value={item.root}>{item.root}</option>)}</select></label>}{discovery?.roles.map((role) => <label key={role}>{role === 'target' ? '源码文件' : role === 'frontend' ? '前端文件' : '服务端文件'}<select value={selectedTargets[role]} onChange={(event) => { setSelectedTargets((current) => ({ ...current, [role]: event.target.value })); setPreflightKey(''); }}><option value="">未找到匹配文件</option>{selectedInstallation?.targets[role].map((file) => <option key={file} value={file}>{file}</option>)}</select></label>)}</div>
          {!targetsReady && <p className="patch-agent-help">没有找到此补丁所需的文件。请确认工作台后端能访问 RisuAI 的源码或构建目录。</p>}<div className="plugin-install-actions"><button className="secondary-button" type="button" disabled={!targetsReady || agentBusy} onClick={() => void runAgent(false)}>预检兼容性</button><button className="primary-button" type="button" disabled={!targetsReady || agentBusy || preflightKey !== currentKey} onClick={() => void runAgent(true)}>安装补丁</button></div>{agentMessage && <pre className="patch-agent-output" role="status">{agentMessage}</pre>}
        </section></div>}
        </> : <div className="patch-agent-unconfigured">{agentStatus?.canChooseRoot && window.cardloomDesktop ? <button className="secondary-button" type="button" disabled={agentBusy} onClick={() => void chooseLocalRoot()}><FolderOpen size={15} />选择本机 RisuAI 文件夹</button> : <div className="patch-empty"><FolderOpen size={28} /><strong>尚未接入工作台可访问目录</strong><p>当前实例没有可用的目录选择权限。可使用 SSH 服务器连接，或使用离线安装包。</p><button className="secondary-button" onClick={() => setPageTab('offline')}><Download size={15} />离线工具</button></div>}</div>}
      </div>}

    </div>
    <div hidden={pageTab !== 'bridge'}>    <section className="plugin-components-section" aria-labelledby="bridge-components-title">
      <div className="plugin-section-heading"><div><span className="plugin-install-kicker">RisuAI 网页组件</span><h3 id="bridge-components-title">桥接与预设</h3><p>插件在 RisuAI 网页内导入；预设写入工具只在网页导入不可用时由管理员使用。</p></div></div>
      <div className="plugin-component-list">{bridgeComponents.map((item) => <article className="plugin-component-row" key={item.id}>
        <div className="plugin-component-main"><div className="plugin-manager-name"><Plug size={18} /><h3>{item.name}</h3><span className="plugin-manager-kind">{item.action === 'plugin' ? '网页导入' : '管理员工具'}</span></div><p>{item.purpose}</p><small><code>{item.artifact}</code> · {item.install}</small></div>
        <button className={item.action === 'plugin' ? 'primary-button' : 'secondary-button'} type="button" onClick={item.action === 'plugin' ? downloadBridge : downloadBridgeToolkit}><Download size={15} />{item.action === 'plugin' ? '下载插件文件' : '下载工具包'}</button>
      </article>)}</div>
      <p className="plugin-component-footnote">预设写入工具包内的 <code>README.txt</code> 附有运行方法。解压后，管理员可用下方命令写入单个 RisuAI 预设 JSON；运行前需确认 RisuAI 没有同时写入存档。</p>
      <div className="plugin-manager-command"><code>node bridge-plugin/install-risu-preset.cjs --preset preset.json --save-dir /app/save</code><button type="button" className="icon-button" title="复制预设写入命令" aria-label="复制预设写入命令" onClick={() => void copyCommand('preset-install', 'node bridge-plugin/install-risu-preset.cjs --preset preset.json --save-dir /app/save')}><Copy size={14} /></button></div>
      {copiedCommand === 'preset-install' && <small className="plugin-command-copied">已复制</small>}
      <p className="plugin-component-footnote">工作台导出的 .risup 应在 RisuAI 网页导入；管理员脚本只接收单个 RisuAI 预设 JSON。安装工具包不包含用户预设。</p>
    </section>

</div>
    <section hidden={pageTab !== 'offline'} className="patch-downloads" aria-label="离线工具">
      <h3>离线安装与维护</h3>
      <div className="plugin-component-row"><div><h4>Windows 安装包</h4><p>Node.js 18+ · install-windows.cmd</p></div><button className="secondary-button" onClick={downloadWindowsToolkit}><Download size={16} />下载安装包</button></div>
      <div className="plugin-component-row"><div><h4>Linux 安装包</h4><p>Bash / Node.js 18+ · install-linux.sh</p></div><button className="secondary-button" onClick={downloadRemoteToolkit}><Download size={16} />下载安装包</button></div>
      <div className="plugin-component-row"><div><h4>补丁脚本与状态工具</h4><p>安装器、依赖清单、核验与卸载脚本</p></div><button className="secondary-button" onClick={downloadPatchToolkit}><Download size={16} />下载脚本包</button></div>
    </section>
    <section hidden={pageTab !== 'reference'} aria-label="补丁说明">      <div className="plugin-patches-body">
        <p className="plugin-component-footnote">“下载补丁脚本”会把全部脚本和安装器放进一个 ZIP，供 RisuAI 所在电脑或服务器执行；此页不接收 ZIP 上传。工作台网页安装使用内置的固定脚本，每次只安装选中的一项：先预检目标文件，再备份并写入匹配的修改。它不会自动合并任意版本代码，也不会自动构建或重启。</p>
        <div className="plugin-patches-tools"><div className="plugin-manager-toolbar" role="group" aria-label="补丁类型">{(['all', 'source', 'bundle', 'server'] as const).map((kind) => <button key={kind} type="button" className={filter === kind ? 'active' : ''} onClick={() => setFilter(kind)}>{kind === 'all' ? '全部' : kindLabels[kind]}</button>)}<span>{visible.length} 项</span></div><button className="secondary-button" type="button" onClick={downloadPatchToolkit}><Download size={15} />下载补丁脚本</button></div>
        <div className="plugin-manager-list">{visible.map((item) => <article className="plugin-manager-row" key={item.id}><div className="plugin-manager-row-head"><div className="plugin-manager-name"><FileCode2 size={18} /><h3>{item.name}</h3><span className="plugin-manager-kind">{kindLabels[item.kind]}</span></div></div><p>{item.purpose}</p><dl><div><dt>适用</dt><dd>{item.target}</dd></div><div><dt>材料</dt><dd><code>{item.artifact}</code></dd></div><div><dt>安装前</dt><dd>{item.prerequisite}</dd></div><div><dt>安装后</dt><dd>{item.verify}</dd></div></dl>{item.command && <div className="plugin-manager-command"><code>{item.command}</code><button type="button" className="icon-button" title="复制预检命令" aria-label={`复制${item.name}预检命令`} onClick={() => void copyCommand(item.id, item.command!)}><Copy size={14} /></button></div>}{copiedCommand === item.id && <small className="plugin-command-copied">已复制</small>}</article>)}</div>
      </div>
</section>
  </section>;
}
