import { workflowState } from '@/features/translation/model/workflow-state';
import {
  ArrowRight,
  CheckCheck,
  Check,
  CircleAlert,
  Code2,
  Download,
  FileSearch,
  Layers3,
  Play,
  ScanSearch,
  Settings2,
  SlidersHorizontal,
  ShieldCheck,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ProjectDetail, ProtocolSchema, ScopePreset, Settings } from '@/shared/types';
import { TranslationStageGuide } from './TranslationStageGuide';

type PresetId = 'quick' | 'risu' | 'audit';

interface GuidedWorkflowProps {
  project: ProjectDetail;
  settings: Settings | null;
  scope: ScopePreset;
  busy: string;
  onOpenSettings: () => void;
  onScopeChange: (scope: ScopePreset) => void;
  onScan: (scope?: ScopePreset) => void;
  onStartTranslation: () => void;
  onOpenJobs: () => void;
  onOpenReview: () => void;
  onOpenLuaManagement: () => void;
  protocols: ProtocolSchema[];
  onOpenProtocols: () => void;
  onApproveAll: () => void;
  onOpenSegments: () => void;
  onApplyDraft: () => void;
  onSaveAndExport: () => void;
}

const PRESETS: Array<{
  id: PresetId;
  title: string;
  scope: ScopePreset;
  description: string;
  hint: string;
}> = [
  {
    id: 'quick',
    title: '快速翻译',
    scope: 'core',
    description: '先翻译角色主体，最快看到效果。',
    hint: '适合第一次试用',
  },
  {
    id: 'risu',
    title: 'RisuAI 完整翻译',
    scope: 'all',
    description: '覆盖世界书、脚本可见文字、Lua 提示词和资源 JSON。',
    hint: 'CHARX / RISUM 推荐',
  },
  {
    id: 'audit',
    title: '扫描后检查',
    scope: 'all-visible',
    description: '扫描完整可见内容，先检查字段和结构，再手动启动翻译。',
    hint: '扫描不调用模型',
  },
];

const FLOW_STEPS = ['导入', '扫描', '翻译', '审核', '导出'];

function presetForScope(scope: ScopePreset): PresetId {
  if (scope === 'core') return 'quick';
  if (scope === 'all-visible' || scope === 'lua-only') return 'audit';
  return 'risu';
}

export function GuidedWorkflow({
  project,
  settings,
  scope,
  busy,
  onOpenSettings,
  onScopeChange,
  onScan,
  onStartTranslation,
  onOpenJobs,
  onOpenReview,
  onOpenLuaManagement,
  protocols,
  onOpenProtocols,
  onApproveAll,
  onOpenSegments,
  onApplyDraft,
  onSaveAndExport,
}: GuidedWorkflowProps) {
  const [selectedPreset, setSelectedPreset] = useState<PresetId>(() => presetForScope(scope));
  const workflow = workflowState(project);
  const scopeChanged = scope !== project.scope;
  const flowStep = scopeChanged && !workflow.active ? 1 : workflow.flowStep;
  const modelReady = Boolean(settings?.apiKeyConfigured && settings.model);
  const risuFormat = ['charx', 'risum'].includes(project.sourceFormat.toLowerCase())
    || Boolean(project.scanSummary?.luaSegments || project.scanSummary?.protocolSegments || project.controlReferences.length);
  const presets = PRESETS.map((preset) => preset.id === 'risu' && !risuFormat
    ? { ...preset, title: '完整可见内容', description: '覆盖普通卡片中的所有可见文字和世界书内容。', hint: '适合 JSON / PNG 卡片' }
    : preset);

  useEffect(() => {
    setSelectedPreset(presetForScope(scope));
  }, [scope]);

  const selectPreset = (preset: typeof PRESETS[number]) => {
    setSelectedPreset(preset.id);
    onScopeChange(preset.scope);
  };

  const renderNextStep = () => {
    if (workflow.active) return <>
      <div className="guided-next-copy">
        <h2>{workflow.status === 'paused' ? '翻译已暂停' : workflow.stage === 'adaptation' ? '正在执行阶段 2' : '翻译正在进行'}</h2>
        <p>{workflow.status === 'paused' ? '已完成的结果已保留，继续任务后才会处理剩余内容。' : '任务在后台处理，完成后再进入人工审核。'}{scopeChanged ? ' 所选范围已变化，当前任务仍按原范围执行；完成或取消后才能重新扫描。' : ''}</p>
        <TranslationStageGuide active={workflow.stage} />
      </div>
      <div className="guided-actions">
        {workflow.status === 'paused' && !scopeChanged && <button className="primary-button" disabled={Boolean(busy)} onClick={onStartTranslation}><Play size={16} />继续翻译</button>}
        <button className="secondary-button" onClick={onOpenJobs}><Layers3 size={16} />查看任务进度</button>
      </div>
    </>;
    if (scopeChanged || workflow.status === 'new') return <>
      <div className="guided-next-copy"><h2>{scopeChanged ? '范围已变化，需要重新扫描' : '先扫描这张卡片'}</h2>
        <p>按所选范围整理可翻译内容，保留已有译文和审核记录。扫描不会调用模型，也不会改写原文件。</p></div>
      <div className="guided-actions"><button className="primary-button" onClick={() => onScan(scope)} disabled={Boolean(busy)}><ScanSearch size={16} />{scopeChanged ? '重新扫描' : '扫描卡片'}</button></div>
    </>;
    if (workflow.hasFailures || workflow.resumable) return <>
      <div className="guided-next-copy">
        <h2>{workflow.postIncomplete || workflow.latest?.status === 'review_with_errors' && !workflow.latest.failedItems ? '阶段 2 尚未完成，需要处理' : workflow.status === 'cancelled' ? '翻译已取消，可以继续' : '翻译有未完成项，需要处理'}</h2>
        <p>已有译文和审核结果已保留。请先查看任务中的失败原因并重试；正文审核通过不代表脚本、正则和关键词适配已完成。</p>
      </div>
      <div className="guided-actions">
        {workflow.canStart && <button className="primary-button" disabled={Boolean(busy)} onClick={onStartTranslation}><Play size={16} />{workflow.retryAction ? workflow.latest?.failedItems ? '重试失败项与阶段 2' : '重试阶段 2' : '继续翻译'}</button>}
        <button className="secondary-button" onClick={onOpenJobs}>查看任务</button>
        <button className="secondary-button" onClick={onOpenReview}>审核已有译文</button>
      </div>
    </>;
    if (workflow.counts.untranslated > 0) return <>
      <div className="guided-next-copy"><h2>当前范围还有 {workflow.counts.untranslated} 条待翻译</h2><p>已完成的译文会保留。可以先检查字段和协议规则，再启动剩余内容的翻译。</p><TranslationStageGuide active="text" /></div>
      {!modelReady && <div className="guided-setup-note"><Settings2 size={16} /><span>开始翻译前需要配置模型和 API Key。</span><button className="link-button" onClick={onOpenSettings}>去配置</button></div>}
      <div className="guided-actions">
        <button className="primary-button" onClick={onStartTranslation} disabled={Boolean(busy) || !modelReady}><Play size={16} />开始翻译<ArrowRight size={15} /></button>
        <button className="secondary-button" onClick={onOpenSegments}><FileSearch size={16} />查看扫描结果</button>
        {workflow.counts.pending > 0 && <button className="secondary-button" onClick={onOpenReview}>审核已有译文</button>}
      </div>
    </>;
    if (workflow.counts.pending > 0) return <>
      <div className="guided-next-copy"><h2>当前还有 {workflow.counts.pending} 条待审核</h2><p>对照原文核对后再保存。之前保存过的草稿不会使新修改自动通过审核；导出只包含已通过的结果。</p></div>
      <div className="guided-actions">
        <button className="primary-button" onClick={onOpenReview}><ShieldCheck size={16} />进入审核<ArrowRight size={15} /></button>
        <button className="secondary-button" onClick={onApproveAll} disabled={Boolean(busy) || !workflow.counts.reviewable}><CheckCheck size={16} />一键通过已有译文（{workflow.counts.reviewable}）</button>
      </div>
    </>;
    if (workflow.counts.approved > 0) return <>
      <div className="guided-next-copy"><h2>当前范围审核已通过，保存后导出</h2><p>保存并导出会应用当前有效的审核结果，并检查 Lua、脚本引用和卡片结构。范围外已审核的成果继续保留；未审核内容保留原文。请在目标客户端打开复核。</p></div>
      <div className="guided-actions">
        <button className="secondary-button" onClick={onApplyDraft} disabled={Boolean(busy)}><ShieldCheck size={16} />保存</button>
        <button className="primary-button" onClick={onSaveAndExport} disabled={Boolean(busy)}><Download size={16} />保存并导出</button>
      </div>
    </>;
    return <>
      <div className="guided-next-copy"><h2>当前范围没有待处理的翻译项</h2><p>可以检查扫描结果、勾选需要翻译的字段，或调整范围后重新扫描。</p></div>
      <div className="guided-actions"><button className="primary-button" onClick={onOpenSegments}><FileSearch size={16} />查看扫描结果</button></div>
    </>;
  };

  const showPresets = workflow.status === 'new' || workflow.status === 'scanned';

  return (
    <section className="guided-workflow" aria-label="翻译流程引导">
      <div className="guided-progress" aria-label="当前流程">
        {FLOW_STEPS.map((label, index) => {
          const done = index < flowStep;
          const active = index === flowStep;
          return (
            <div className={`guided-step ${done ? 'done' : ''} ${active ? 'active' : ''}`} key={label}>
              <span className="guided-step-mark">{done ? <Check size={14} /> : index + 1}</span>
              <span>{label}</span>
              {index < FLOW_STEPS.length - 1 && <span className="guided-step-line" aria-hidden="true" />}
            </div>
          );
        })}
      </div>
      <div className="guided-next">
        <div className="guided-next-main">{renderNextStep()}</div>
        {showPresets && (
          <div className="guided-presets" aria-label="翻译预设">
            {presets.map((preset) => (
              <button
                type="button"
                className={`guided-preset ${selectedPreset === preset.id ? 'selected' : ''}`}
                key={preset.id}
                onClick={() => selectPreset(preset)}
              >
                <span className="guided-preset-topline">
                  <strong>{preset.title}</strong>
                  {selectedPreset === preset.id && <Check size={14} />}
                </span>
                <span>{preset.description}</span>
                <small>{preset.hint}</small>
              </button>
            ))}
          </div>
        )}
      </div>
      {project.scanSummary?.luaSegments ? (
        <div className="guided-lua-tip">
          <Code2 size={16} />
          <div><strong>检测到 Lua 脚本</strong><span>运行时名称别名在翻译阶段补全；保存和导出只应用已有结果并检查脚本。补全失败请在任务页重试阶段 2，或到脚本管理页检查。</span></div>
          <button className="secondary-button" onClick={onOpenLuaManagement}><SlidersHorizontal size={15} />打开 脚本管理</button>
        </div>
      ) : null}
      {protocols.length > 0 && <div className="guided-lua-tip">
        <ShieldCheck size={16} />
        <div><strong>协议槽位与保护规则 · {protocols.length} 种</strong><span>
          {protocols.some(protocol => protocol.status === 'pending' || protocol.status === 'analyzed')
            ? '有待确认的协议。建议翻译前核对哪些槽位可翻译、哪些需保护；后续采用规则会重新扫描，重叠的旧译文可能需要重译。'
            : '协议规则决定结构化文本的翻译范围。需要检查漏译或调整槽位时，可打开协议页。'}
        </span></div>
        <button className="secondary-button" onClick={onOpenProtocols}>检查协议规则</button>
      </div>}
      {workflow.status === 'new' && (
        <div className="guided-scan-note"><CircleAlert size={14} />扫描完成后，你还可以在这里切换翻译预设。</div>
      )}
    </section>
  );
}
