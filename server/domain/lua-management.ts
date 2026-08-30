import {
  risuControlReferences,
  scanRisuModule,
  validateRisuControlReferences,
  type ScannedSegment,
} from './card.js';
import {
  collectRuntimeAliasCandidates,
  collectRuntimeAliasTranslationCandidates,
  detectRisuPortraitRouting,
  inspectRuntimeAliasCoverage,
  validateRisuLuaChanges,
} from './risu-lua.js';
import { detectRisuRuntimeRisks, validateRisuTemplateChanges } from './risu-qa.js';
import { inspectPortraitRouterRepairs, type PortraitRouterRepairReport } from './portrait-router-repair.js';

export type LuaManagementStepStatus = 'complete' | 'needs-review' | 'blocked' | 'not-applicable';

export interface LuaManagementStep {
  id: 'scan' | 'classify' | 'repair' | 'review' | 'validate' | 'export';
  title: string;
  status: LuaManagementStepStatus;
  message: string;
}

export interface LuaManagementSegment {
  pathLabel: string;
  kind: string;
  sourceText: string;
  start: number | null;
  end: number | null;
  risk: ScannedSegment['risk'];
  reviewStatus: string;
  finalText: string | null;
  translatedText: string | null;
}

export interface LuaManagementIssue {
  kind: 'syntax' | 'template' | 'runtime' | 'control' | 'portrait' | 'router';
  pathLabel: string;
  message: string;
  blocking: boolean;
}

export interface LuaPortraitCandidate {
  ownerId: string;
  names: string[];
  missingAliases: string[];
  pathLabels: string[];
  status: 'covered' | 'needs-alias';
}

export interface LuaManagementReport {
  generatedAt: string;
  hasModule: boolean;
  sourceCount: number;
  visibleCount: number;
  controlReferenceCount: number;
  pendingCount: number;
  approvedCount: number;
  blockerCount: number;
  warningCount: number;
  portraitCandidateCount: number;
  portraitCoveredCount: number;
  portraitMissingCount: number;
  portraitCandidates: LuaPortraitCandidate[];
  portraitFeatureDetected: boolean;
  portraitFeatureSignals: string[];
  routerRepair: PortraitRouterRepairReport;
  segments: LuaManagementSegment[];
  controlReferences: Array<{ literal: string; kind: 'regex' | 'lua'; pathLabel: string; pattern: string }>;
  issues: LuaManagementIssue[];
  steps: LuaManagementStep[];
}

interface StoredSegment {
  pathLabel: string;
  kind: string;
  sourceText: string;
  reviewStatus: string;
  finalText: string | null;
  translatedText: string | null;
}

interface ReportInput {
  originalCard: Record<string, unknown>;
  draftCard?: Record<string, unknown> | null;
  originalModule?: Record<string, unknown> | null;
  draftModule?: Record<string, unknown> | null;
  storedSegments?: StoredSegment[];
  projectStatus?: string;
  targetLanguage?: string;
  generatedAt?: string;
}

function preview(value: string): string {
  const normalized = value.replace(/\s+/gu, ' ').trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function sourcePaths(value: unknown, path: Array<string | number> = ['$module']): string[] {
  if (typeof value === 'string') {
    const tail = path.at(-1);
    if (tail === 'code' && path.some((part) => part === 'effect' || part === 'trigger')) {
      return [path.join('.')];
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((entry, index) => sourcePaths(entry, [...path, index]));
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => sourcePaths(child, [...path, key]));
}

function statusForReview(storedSegments: StoredSegment[], visibleCount: number): LuaManagementStepStatus {
  if (!visibleCount) return 'not-applicable';
  const pending = storedSegments.filter((segment) => segment.reviewStatus !== 'approved').length;
  return pending ? 'needs-review' : 'complete';
}

export function buildLuaManagementReport(input: ReportInput): LuaManagementReport {
  const module = input.originalModule ?? {};
  const draftModule = input.draftModule ?? null;
  const storedSegments = input.storedSegments ?? [];
  const portraitFeature = input.originalModule ? detectRisuPortraitRouting(module) : { detected: false, signals: [], codePaths: [] };
  const routerRepair = input.originalModule ? inspectPortraitRouterRepairs(module) : { detected: false, canApply: false, findings: [] };
  const scanned = input.originalModule ? scanRisuModule(module, 'lua-only') : [];
  const luaSegments = storedSegments.filter((segment) => segment.kind.startsWith('lua-') || segment.kind === 'runtime-message');
  const segments: LuaManagementSegment[] = (luaSegments.length ? luaSegments : scanned.map((segment) => ({
    pathLabel: segment.pathLabel,
    kind: segment.kind,
    sourceText: preview(segment.sourceText),
    reviewStatus: 'untranslated',
    finalText: null,
    translatedText: null,
    start: segment.start,
    end: segment.end,
    risk: segment.risk,
  }))).map((segment) => ({
    pathLabel: segment.pathLabel,
    kind: segment.kind,
    sourceText: preview(segment.sourceText),
    start: 'start' in segment && (typeof segment.start === 'number' || segment.start === null) ? segment.start : null,
    end: 'end' in segment && (typeof segment.end === 'number' || segment.end === null) ? segment.end : null,
    risk: 'risk' in segment && (segment.risk === 'low' || segment.risk === 'medium' || segment.risk === 'high') ? segment.risk : 'medium',
    reviewStatus: segment.reviewStatus,
    finalText: segment.finalText,
    translatedText: segment.translatedText,
  }));

  const controlReferences = input.originalModule
    ? risuControlReferences(module).map((reference) => ({
      literal: reference.literal,
      kind: reference.kind,
      pathLabel: reference.pathLabel,
      pattern: preview(reference.pattern),
    }))
    : [];
  const runtimeCandidates = portraitFeature.detected && input.targetLanguage
    ? collectRuntimeAliasCandidates(module, input.targetLanguage, input.draftCard ?? undefined)
    : [];
  const runtimeCoverageIssues = portraitFeature.detected && input.targetLanguage
    ? inspectRuntimeAliasCoverage(module, input.targetLanguage, input.draftCard ?? undefined)
    : [];
  const runtimeTranslationCandidates = portraitFeature.detected && input.targetLanguage
    ? collectRuntimeAliasTranslationCandidates(module, input.targetLanguage)
    : [];
  const portraitByOwner = new Map<string, LuaPortraitCandidate>();
  for (const candidate of runtimeCandidates) {
    const ownerId = candidate.ownerId.toLocaleLowerCase();
    const current = portraitByOwner.get(ownerId) ?? {
      ownerId: candidate.ownerId,
      names: [],
      missingAliases: [],
      pathLabels: [],
      status: 'covered' as const,
    };
    if (!current.names.includes(candidate.name)) current.names.push(candidate.name);
    portraitByOwner.set(ownerId, current);
  }
  for (const issue of runtimeCoverageIssues) {
    const ownerId = issue.ownerId.toLocaleLowerCase();
    const current = portraitByOwner.get(ownerId) ?? {
      ownerId: issue.ownerId,
      names: [],
      missingAliases: [],
      pathLabels: [],
      status: 'needs-alias' as const,
    };
    if (!current.missingAliases.includes(issue.alias)) current.missingAliases.push(issue.alias);
    if (!current.pathLabels.includes(issue.pathLabel)) current.pathLabels.push(issue.pathLabel);
    current.status = 'needs-alias';
    portraitByOwner.set(ownerId, current);
  }
  for (const candidate of runtimeTranslationCandidates) {
    const ownerId = candidate.ownerId.toLocaleLowerCase();
    const current = portraitByOwner.get(ownerId) ?? {
      ownerId: candidate.ownerId,
      names: candidate.aliases,
      missingAliases: [],
      pathLabels: [],
      status: 'needs-alias' as const,
    };
    if (!current.names.length) current.names.push(...candidate.aliases);
    if (!current.missingAliases.includes('目标语言名称')) current.missingAliases.push('目标语言名称');
    current.status = 'needs-alias';
    portraitByOwner.set(ownerId, current);
  }
  const portraitCandidates = [...portraitByOwner.values()].sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  const issues: LuaManagementIssue[] = [];
  if (draftModule) {
    validateRisuLuaChanges(module, draftModule).forEach((issue) => issues.push({ ...issue, kind: 'syntax', blocking: true }));
    validateRisuTemplateChanges(module, draftModule).forEach((issue) => issues.push({ ...issue, kind: 'template', blocking: true }));
    if (input.draftCard) {
      validateRisuControlReferences(input.originalCard, input.draftCard, module, draftModule)
        .forEach((issue) => issues.push({ ...issue, kind: 'control', blocking: true }));
    }
  }
  if (input.originalModule) {
    detectRisuRuntimeRisks(module).forEach((issue) => issues.push({ ...issue, kind: 'runtime', blocking: false }));
  }
  for (const candidate of portraitCandidates.filter((item) => item.status === 'needs-alias')) {
    issues.push({
      kind: 'portrait',
      pathLabel: candidate.ownerId,
      message: `运行时名称目录还缺少 ${candidate.missingAliases.length} 个目标语言别名，翻译任务完成时会自动补齐；导出阶段仅作兜底。`,
      blocking: false,
    });
  }
  for (const finding of routerRepair.findings) {
    issues.push({
      kind: 'router',
      pathLabel: finding.pathLabel,
      message: `${finding.title}：${finding.message}`,
      blocking: false,
    });
  }

  const blockerCount = issues.filter((issue) => issue.blocking).length;
  const warningCount = issues.length - blockerCount;
  const pendingCount = segments.filter((segment) => segment.reviewStatus !== 'approved').length;
  const approvedCount = segments.filter((segment) => segment.reviewStatus === 'approved').length;
  const hasModule = Boolean(input.originalModule);
  const sourceCount = hasModule ? new Set(sourcePaths(module)).size : 0;
  const visibleCount = segments.length;
  const steps: LuaManagementStep[] = [
    {
      id: 'scan',
      title: '扫描脚本',
      status: hasModule ? 'complete' : 'not-applicable',
      message: hasModule ? `已发现 ${sourceCount} 个 Lua 代码块。` : '当前卡片没有 Risu 模块，跳过 Lua 扫描。',
    },
    {
      id: 'classify',
      title: '提取专有名词',
      status: hasModule && portraitFeature.detected ? 'complete' : 'not-applicable',
      message: !hasModule
        ? '当前卡片没有 Risu 模块，跳过检测。'
        : portraitFeature.detected
          ? `已找到 ${portraitCandidates.length} 个可用于立绘匹配的名称候选。`
          : '未检测到图片路由功能，本页不处理普通 Lua 文本。',
    },
    {
      id: 'repair',
      title: '修复路由',
      status: !hasModule ? 'not-applicable' : routerRepair.canApply ? 'needs-review' : 'complete',
      message: !hasModule
        ? '当前卡片没有 Risu 模块，跳过路由修复。'
        : routerRepair.canApply
          ? `发现 ${routerRepair.findings.length} 个可安全修复的路由问题。`
          : '未发现需要处理的已知路由阻断模式。',
    },
    {
      id: 'review',
      title: '确认目标别名',
      status: !portraitFeature.detected ? 'not-applicable' : portraitCandidates.some((item) => item.status === 'needs-alias') ? 'needs-review' : portraitCandidates.length ? 'complete' : 'not-applicable',
      message: portraitCandidates.length
        ? `${portraitCandidates.filter((item) => item.status === 'covered').length} 个候选已有别名，${portraitCandidates.filter((item) => item.status === 'needs-alias').length} 个会在翻译完成时补齐。`
        : portraitFeature.detected ? '未发现可安全判定的专有名词候选。' : '没有立绘匹配功能，不需要管理名称。',
    },
    {
      id: 'validate',
      title: '校验完整性',
      status: blockerCount ? 'blocked' : draftModule ? 'complete' : 'needs-review',
      message: blockerCount ? `发现 ${blockerCount} 个阻断问题，不能直接导出。` : draftModule ? 'Lua 语法、模板和控制引用校验通过。' : '生成审核稿后才会执行最终校验。',
    },
    {
      id: 'export',
      title: '导出回验',
      status: blockerCount || !draftModule ? 'needs-review' : input.projectStatus === 'ready' ? 'complete' : 'needs-review',
      message: blockerCount ? '先修复阻断问题，再保存并导出。' : '导出前会再次执行同一组保护校验。',
    },
  ];

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    hasModule,
    sourceCount,
    visibleCount,
    controlReferenceCount: controlReferences.length,
    pendingCount,
    approvedCount,
    blockerCount,
    warningCount,
    portraitCandidateCount: portraitCandidates.length,
    portraitCoveredCount: portraitCandidates.filter((item) => item.status === 'covered').length,
    portraitMissingCount: portraitCandidates.filter((item) => item.status === 'needs-alias').length,
    portraitCandidates,
    portraitFeatureDetected: portraitFeature.detected,
    portraitFeatureSignals: portraitFeature.signals,
    routerRepair,
    segments,
    controlReferences,
    issues,
    steps,
  };
}
