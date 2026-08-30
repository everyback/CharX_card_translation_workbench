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
import type { ProjectDetail, ScopePreset, Settings } from '../../types';

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
    description: '先翻译角色主体、名称和问候语，最快看到效果。',
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
    title: '仅扫描审核',
    scope: 'all-visible',
    description: '只扫描结构和风险，不调用模型，先摸清卡片内容。',
    hint: '不会消耗模型额度',
  },
];

const FLOW_STEPS = ['导入', '扫描', '翻译', '审核', '导出'];

function presetForScope(scope: ScopePreset): PresetId {
  if (scope === 'core') return 'quick';
  if (scope === 'all-visible' || scope === 'lua-only') return 'audit';
  return 'risu';
}

function currentFlowStep(project: ProjectDetail): number {
  if (project.status === 'new') return 1;
  if (project.status === 'scanned') return 2;
  if (project.status === 'translating') return 2;
  if (project.status === 'review' || project.status === 'review_with_errors') {
    const pendingWithText = project.segments.some((segment) => (
      segment.reviewStatus === 'pending'
      && Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
    ));
    const approvedWithText = project.segments.some((segment) => (
      segment.reviewStatus === 'approved'
      && Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
    ));
    return pendingWithText || !approvedWithText ? 3 : 4;
  }
  if (project.status === 'ready') return 4;
  return project.segments.some((segment) => segment.translatedText || segment.finalText) ? 3 : 2;
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
  onApproveAll,
  onOpenSegments,
  onApplyDraft,
  onSaveAndExport,
}: GuidedWorkflowProps) {
  const [selectedPreset, setSelectedPreset] = useState<PresetId>(() => presetForScope(scope));
  const flowStep = currentFlowStep(project);
  const modelReady = Boolean(settings?.apiKeyConfigured && settings.model);
  const selected = PRESETS.find((preset) => preset.id === selectedPreset) ?? PRESETS[1];
  const hasFailedJob = project.jobs.some((job) => job.status === 'failed' || job.status === 'review_with_errors');

  useEffect(() => {
    setSelectedPreset(presetForScope(scope));
  }, [scope]);

  const selectPreset = (preset: typeof PRESETS[number]) => {
    setSelectedPreset(preset.id);
    onScopeChange(preset.scope);
  };

  const renderNextStep = () => {
    if (project.status === 'new') {
      return (
        <>
          <div className="guided-next-copy">
            <span className="guided-eyebrow">下一步 · 01</span>
            <h2>先扫描这张卡片</h2>
            <p>扫描只读取卡片结构，整理主体、世界书、脚本和资源引用，不会调用模型，也不会改写原文件。</p>
          </div>
          <div className="guided-actions">
            <button className="primary-button" onClick={() => onScan(selected.scope)} disabled={Boolean(busy)}>
              {busy === 'scan' ? <ScanSearch className="spin" size={16} /> : <ScanSearch size={16} />}
              扫描卡片
              <ArrowRight size={15} />
            </button>
          </div>
        </>
      );
    }

    if (project.status === 'scanned') {
      return (
        <>
          <div className="guided-next-copy">
            <span className="guided-eyebrow">下一步 · 02</span>
            <h2>扫描完成，选择翻译方式</h2>
            <p>先选一个范围。你可以从快速翻译开始，也可以直接覆盖 RisuAI 卡片中的世界书和脚本内容。</p>
          </div>
          {!modelReady && selectedPreset !== 'audit' && (
            <div className="guided-setup-note">
              <Settings2 size={16} />
              <span>开始翻译前需要配置模型和 API Key。</span>
              <button className="link-button" onClick={onOpenSettings}>去配置</button>
            </div>
          )}
          <div className="guided-actions">
            {selectedPreset === 'audit' ? (
              <button className="primary-button" onClick={onOpenSegments}>
                <FileSearch size={16} />查看扫描结果<ArrowRight size={15} />
              </button>
            ) : (
              <button className="primary-button" onClick={onStartTranslation} disabled={Boolean(busy) || !modelReady}>
                {busy === 'start' ? <Play className="spin" size={16} /> : <Play size={16} />}
                开始翻译<ArrowRight size={15} />
              </button>
            )}
          </div>
        </>
      );
    }

    if (project.status === 'translating') {
      return (
        <>
          <div className="guided-next-copy">
            <span className="guided-eyebrow">正在处理 · 03</span>
            <h2>翻译正在进行</h2>
            <p>任务会在后台逐批处理。你可以打开任务页查看进度，完成后再进入人工审核。</p>
          </div>
          <div className="guided-actions">
            <button className="secondary-button" onClick={onOpenJobs}><Layers3 size={16} />查看任务进度</button>
          </div>
        </>
      );
    }

    if (project.status === 'review' || project.status === 'review_with_errors') {
      const pendingWithText = project.segments.filter((segment) => (
        segment.reviewStatus === 'pending'
        && Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
      ));
      const approvedWithText = project.segments.some((segment) => (
        segment.reviewStatus === 'approved'
        && Boolean(segment.finalText?.trim() || segment.translatedText?.trim())
      ));
      if (!pendingWithText.length && approvedWithText) {
        return (
          <>
            <div className="guided-next-copy">
              <span className="guided-eyebrow">下一步 · 05</span>
              <h2>审核已通过，可以保存并导出</h2>
              <p>已有译文已经全部通过审核。点击“保存并导出”会先检查 Lua、脚本引用和卡片结构，校验通过后下载文件。</p>
            </div>
            <div className="guided-actions">
              <button className="secondary-button" onClick={onApplyDraft} disabled={Boolean(busy)}><ShieldCheck size={16} />保存</button>
              <button className="primary-button" onClick={onSaveAndExport} disabled={Boolean(busy)}><Download size={16} />保存并导出</button>
            </div>
          </>
        );
      }
      return (
        <>
          <div className="guided-next-copy">
            <span className="guided-eyebrow">下一步 · 04</span>
            <h2>译文已生成，可以一键通过或进入人工审核</h2>
            <p>{hasFailedJob ? '任务中有失败项，先查看带疑点的字段，再决定是否重新翻译。' : '如果你已经确认无误，可以直接一键通过全部已有译文；也可以先进入人工审核逐条核对。'}</p>
            <div className="guided-review-tip">
              <ShieldCheck size={14} />
              <span>一键通过只会处理已有译文，不会碰未翻译项。</span>
            </div>
          </div>
          <div className="guided-actions">
            <button className="primary-button" onClick={onOpenReview}><ShieldCheck size={16} />进入审核<ArrowRight size={15} /></button>
            <button className="secondary-button" onClick={onApproveAll} disabled={Boolean(busy) || pendingWithText.length === 0} title={pendingWithText.length ? `一键通过全部 ${pendingWithText.length} 条已有译文` : '当前没有可一键通过的译文'}>
              <CheckCheck size={16} />一键通过全部
            </button>
          </div>
        </>
      );
    }

    if (project.status === 'ready') {
      return (
        <>
          <div className="guided-next-copy">
            <span className="guided-eyebrow">最后一步 · 05</span>
            <h2>审核稿已保存，可以继续导出</h2>
            <p>保存并导出会在下载前再次检查 Lua、脚本引用和卡片结构，之后请在目标客户端实际打开复核。</p>
          </div>
          <div className="guided-actions">
            <button className="secondary-button" onClick={onApplyDraft} disabled={Boolean(busy)}><ShieldCheck size={16} />保存</button>
            <button className="primary-button" onClick={onSaveAndExport} disabled={Boolean(busy)}><Download size={16} />保存并导出</button>
          </div>
        </>
      );
    }

    return (
      <>
        <div className="guided-next-copy">
          <span className="guided-eyebrow">审核准备</span>
          <h2>确认后保存审核稿</h2>
          <p>保存会校验 Lua 和受保护内容；保存并导出会在此基础上继续执行导出前检查。</p>
        </div>
        <div className="guided-actions">
          <button className="secondary-button" onClick={onApplyDraft} disabled={Boolean(busy)}><ShieldCheck size={16} />保存</button>
          <button className="primary-button" onClick={onSaveAndExport} disabled={Boolean(busy)}><Download size={16} />保存并导出</button>
        </div>
      </>
    );
  };

  const showPresets = project.status === 'new' || project.status === 'scanned';

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
            {PRESETS.map((preset) => (
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
          <div><strong>检测到 Lua 脚本</strong><span>先在 Lua 管理里确认是否存在立绘匹配功能；只有人名、地名等专有名词才会进入匹配流程。</span></div>
          <button className="secondary-button" onClick={onOpenLuaManagement}><SlidersHorizontal size={15} />打开 Lua 管理</button>
        </div>
      ) : null}
      {project.status === 'new' && (
        <div className="guided-scan-note"><CircleAlert size={14} />扫描完成后，你还可以在这里切换翻译预设。</div>
      )}
    </section>
  );
}
