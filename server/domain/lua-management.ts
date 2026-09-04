import {
  risuControlReferences,
  scanRisuModule,
  validateRisuControlReferences,
  regexMatchSnippetsInStrings,
  countRegexMatchesInStrings,
  risuRegexControlReferences,
  extractRegexAlternatives,
  isRegexValidationOverrideActive,
  type RisuRegexValidationOverrides,
  type ScannedSegment,
} from './card.js';
import {
  collectRuntimeAliasCandidates,
  collectRuntimeAliasTranslationCandidates,
  detectRisuPortraitRouting,
  inspectRuntimeAliasCoverage,
  validateRisuLuaChanges,
  runtimeAliasesForOwner,
  staleRisuModuleNamespaceProtocolPaths,
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
  id: string;
  pathLabel: string;
  kind: string;
  sourceText: string;
  start: number | null;
  end: number | null;
  risk: ScannedSegment['risk'];
  reviewStatus: string;
  finalText: string | null;
  translatedText: string | null;
  /** Exact original Lua source line, supplied only when the stored range maps to one line. */
  sourceCodeLine?: string;
  sourceCodeLineNumber?: number;
}

export interface LuaManagementIssue {
  kind: 'syntax' | 'template' | 'runtime' | 'control' | 'portrait' | 'router' | 'namespace';
  pathLabel: string;
  message: string;
  blocking: boolean;
  segmentIds: string[];
  line?: number;
  column?: number;
  sourceLine?: string;
  draftLine?: string;
  contextLines?: Array<{ line: number; sourceLine: string; draftLine: string; errorLine: boolean }>;
}

export interface LuaPortraitCandidate {
  ownerId: string;
  names: string[];
  missingAliases: string[];
  pathLabels: string[];
  status: 'covered' | 'needs-alias';
  segmentIds: string[];
  targetAliases: string[];
}

export interface LuaManagementReport {
  generatedAt: string;
  hasModule: boolean;
  sourceCount: number;
  visibleCount: number;
  controlReferenceCount: number;
  regexCount: number;
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
  namespaceHandling: 'unconfirmed' | 'preserved' | 'review' | 'translated';
  segments: LuaManagementSegment[];
  controlReferences: Array<{ literal: string; kind: 'regex' | 'lua'; pathLabel: string; pattern: string; out?: string; fullPattern?: string; originalPattern?: string; addedAlternatives?: string[]; originalMatches?: number; draftMatches?: number; originalSamples?: string[]; draftSamples?: string[]; forcePassed?: boolean; dynamicDisplay?: boolean; runtimePostprocess?: boolean }>;
  regexRules: Array<{ literal: string; kind: 'regex'; pathLabel: string; pattern: string; out?: string; fullPattern?: string; originalPattern?: string; addedAlternatives?: string[]; originalMatches?: number; draftMatches?: number; originalSamples?: string[]; draftSamples?: string[]; forcePassed?: boolean; dynamicDisplay?: boolean; runtimePostprocess?: boolean }>;
  issues: LuaManagementIssue[];
  steps: LuaManagementStep[];
}

interface StoredSegment {
  id: string;
  pathJson: string;
  pathLabel: string;
  kind: string;
  sourceText: string;
  reviewStatus: string;
  finalText: string | null;
  translatedText: string | null;
  start?: number | null;
  end?: number | null;
}

interface ReportInput {
  originalCard: Record<string, unknown>;
  draftCard?: Record<string, unknown> | null;
  originalModule?: Record<string, unknown> | null;
  draftModule?: Record<string, unknown> | null;
  storedSegments?: StoredSegment[];
  projectStatus?: string;
  targetLanguage?: string;
  regexValidationOverrides?: RisuRegexValidationOverrides;
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

function originalLuaSourceLine(
  module: Record<string, unknown>,
  pathJson: string,
  start: number | null | undefined,
  end: number | null | undefined,
): { line: number; code: string } | null {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start == null || end == null || start < 0 || end <= start) return null;
  try {
    const rawPath = JSON.parse(pathJson) as unknown;
    if (!Array.isArray(rawPath)) return null;
    const path = rawPath[0] === '$module' ? rawPath.slice(1) : rawPath;
    let current: unknown = module;
    for (const part of path) {
      if (Array.isArray(current) && typeof part === 'number') current = current[part];
      else if (current && typeof current === 'object' && !Array.isArray(current) && typeof part === 'string') current = (current as Record<string, unknown>)[part];
      else return null;
    }
    if (typeof current !== 'string' || end > current.length) return null;
    const lineNumberAt = (offset: number) => current.slice(0, offset).split('\n').length;
    const line = lineNumberAt(start);
    if (lineNumberAt(end - 1) !== line) return null;
    const lineStart = current.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = current.indexOf('\n', end);
    const code = current.slice(lineStart, lineEnd === -1 ? current.length : lineEnd);
    return code.trim() ? { line, code } : null;
  } catch {
    return null;
  }
}

function namespaceTarget(segment: StoredSegment | undefined): string {
  return (segment?.finalText || segment?.translatedText || '').trim();
}

export function buildLuaManagementReport(input: ReportInput): LuaManagementReport {
  const module = input.originalModule ?? {};
  const draftModule = input.draftModule ?? null;
  const sourceNamespace = typeof module.namespace === 'string' ? module.namespace.trim() : '';
  const storedSegments = input.storedSegments ?? [];
  const portraitFeature = input.originalModule ? detectRisuPortraitRouting(module) : { detected: false, signals: [], codePaths: [] };
  // Router repair is a draft-only edit. Report the effective current module so
  // a repair is not shown as pending again after the page is refreshed.
  const routerRepair = input.originalModule
    ? inspectPortraitRouterRepairs(draftModule ?? module)
    : { detected: false, canApply: false, findings: [] };
  const scanned = input.originalModule ? scanRisuModule(module, 'lua-only') : [];
  const luaSegments = storedSegments.filter((segment) => segment.kind.startsWith('lua-') || segment.kind === 'runtime-message');
  const storedNamespaceSegment = storedSegments.find((segment) => (
    (segment.pathJson === JSON.stringify(['$module', 'namespace']) || segment.pathJson === JSON.stringify(['namespace']))
    && segment.sourceText === module.namespace
  ));
  const namespaceTargetText = namespaceTarget(storedNamespaceSegment);
  const namespaceHandling = !sourceNamespace
    ? 'unconfirmed' as const
    : storedNamespaceSegment?.reviewStatus === 'approved' && namespaceTargetText === sourceNamespace
      ? 'preserved' as const
      : storedNamespaceSegment?.reviewStatus === 'approved' && namespaceTargetText
        ? 'translated' as const
        : storedNamespaceSegment?.reviewStatus === 'pending'
          ? 'review' as const
          : 'unconfirmed' as const;
  const namespaceSegment = input.originalModule && typeof module.namespace === 'string'
    ? {
      id: storedNamespaceSegment?.id ?? 'module-namespace',
      pathJson: JSON.stringify(['namespace']),
      pathLabel: '$module.namespace',
      kind: 'field',
      sourceText: module.namespace,
      reviewStatus: storedNamespaceSegment?.reviewStatus ?? 'untranslated',
      finalText: storedNamespaceSegment?.finalText ?? null,
      translatedText: storedNamespaceSegment?.translatedText ?? null,
      start: null,
      end: null,
      risk: 'high' as const,
    }
    : null;
  const sourceSegments: Array<LuaManagementSegment & { pathJson: string }> = (luaSegments.length
    ? luaSegments.map((segment) => ({ ...segment, risk: 'medium' as const }))
    : scanned.map((segment, index) => ({
      id: `scan-${index}`,
      pathJson: JSON.stringify(segment.path),
      pathLabel: segment.pathLabel,
      kind: segment.kind,
      sourceText: preview(segment.sourceText),
      reviewStatus: 'untranslated',
      finalText: null,
      translatedText: null,
      start: segment.start,
      end: segment.end,
      risk: segment.risk,
    })))
    .map((segment) => ({
      id: segment.id,
      pathJson: segment.pathJson,
      pathLabel: segment.pathLabel,
      kind: segment.kind,
      sourceText: segment.sourceText,
      start: typeof segment.start === 'number' || segment.start === null ? segment.start : null,
      end: typeof segment.end === 'number' || segment.end === null ? segment.end : null,
      risk: segment.risk === 'low' || segment.risk === 'medium' || segment.risk === 'high' ? segment.risk : 'medium',
      reviewStatus: segment.reviewStatus,
      finalText: segment.finalText,
      translatedText: segment.translatedText,
    }));
  if (namespaceSegment) sourceSegments.unshift(namespaceSegment);
  // Do not surface a translated text slice as though it were Lua source. Only
  // ranges that map exactly to one original-code line are eligible for this page.
  const segments: LuaManagementSegment[] = sourceSegments.flatMap(({ pathJson, ...segment }) => {
    if (pathJson === JSON.stringify(['namespace'])) return [segment];
    const sourceLocation = originalLuaSourceLine(module, pathJson, segment.start, segment.end);
    return sourceLocation
      ? [{ ...segment, sourceCodeLine: sourceLocation.code, sourceCodeLineNumber: sourceLocation.line }]
      : [];
  });

  const uniqueReferences = <T extends { kind: string; pathLabel: string; pattern: string }>(references: T[]): T[] => (
    [...new Map(references.map((reference) => [`${reference.kind}:${reference.pathLabel}:${reference.pattern}`, reference])).values()]
  );
  const draftReferences = draftModule
    ? uniqueReferences([...risuControlReferences(draftModule), ...risuRegexControlReferences(draftModule)])
    : [];
  const originalReferences = input.originalModule
    ? uniqueReferences([...risuControlReferences(module), ...risuRegexControlReferences(module)])
    : [];
  const activeCard = input.draftCard ?? input.originalCard;
  // Keep every original rule visible, including a rule that was accidentally
  // deleted from an older draft; when a path exists in both modules, show the
  // current draft value so the editor can repair it in place.
  const displayedReferences = input.originalModule
    ? [...new Map([...originalReferences, ...draftReferences].map((reference) => [reference.pathLabel, reference])).values()]
    : [];
  const controlReferences = displayedReferences.map((reference) => {
    const originalPattern = originalReferences.find((item) => item.pathLabel === reference.pathLabel)?.pattern || reference.pattern;
    const originalMatches = reference.kind === 'regex' ? countRegexMatchesInStrings(input.originalCard, originalPattern) : 0;
    const draftMatches = reference.kind === 'regex' ? countRegexMatchesInStrings(activeCard, reference.pattern) : 0;
    return {
      literal: reference.literal,
      kind: reference.kind,
      pathLabel: reference.pathLabel,
      pattern: preview(reference.pattern),
      fullPattern: reference.pattern,
      out: reference.kind === 'regex' ? reference.out : undefined,
      originalPattern,
      addedAlternatives: reference.kind === 'regex'
        ? extractRegexAlternatives(reference.pattern).filter((item) => !extractRegexAlternatives(originalPattern).includes(item))
        : [],
      originalMatches,
      draftMatches,
      originalSamples: reference.kind === 'regex' ? regexMatchSnippetsInStrings(input.originalCard, originalPattern) : [],
      draftSamples: reference.kind === 'regex' ? regexMatchSnippetsInStrings(activeCard, reference.pattern) : [],
      dynamicDisplay: reference.kind === 'regex' && reference.dynamicDisplay === true,
      runtimePostprocess: reference.kind === 'regex' && reference.runtimePostprocess === true,
      forcePassed: reference.kind === 'regex'
        && isRegexValidationOverrideActive(input.regexValidationOverrides, reference.pathLabel, reference.pattern, originalMatches, draftMatches),
    };
  });
  const regexRules = controlReferences.filter((reference): reference is typeof reference & { kind: 'regex' } => reference.kind === 'regex');
  const runtimeCandidates = portraitFeature.detected && input.targetLanguage
    ? collectRuntimeAliasCandidates(module, input.targetLanguage, input.draftCard ?? undefined)
    : [];
  const runtimeCoverageIssues = portraitFeature.detected && input.targetLanguage
    // Inspect the editable module so aliases already merged in Lua management
    // are treated as covered instead of being reported again on every reload.
    ? inspectRuntimeAliasCoverage(draftModule ?? module, input.targetLanguage, input.draftCard ?? undefined)
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
      segmentIds: [],
      status: 'covered' as const,
      targetAliases: [],
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
      segmentIds: [],
      status: 'needs-alias' as const,
      targetAliases: [],
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
      segmentIds: [],
      status: 'needs-alias' as const,
      targetAliases: [],
    };
    if (!current.names.length) current.names.push(...candidate.aliases);
    if (!current.missingAliases.includes('目标语言名称')) current.missingAliases.push('目标语言名称');
    current.status = 'needs-alias';
    portraitByOwner.set(ownerId, current);
  }
  const portraitCandidates = [...portraitByOwner.values()].sort((left, right) => left.ownerId.localeCompare(right.ownerId));
  for (const candidate of portraitCandidates) {
    candidate.targetAliases = runtimeAliasesForOwner(draftModule ?? module, input.targetLanguage || '', candidate.ownerId);
    const serialized = JSON.stringify(draftModule ?? module);
    const ownerMarker = '\\"id\\":\\"' + candidate.ownerId.toLocaleLowerCase() + '\\"';
    const ownerIndex = serialized.toLocaleLowerCase().indexOf(ownerMarker);
    const window = ownerIndex >= 0 ? serialized.slice(ownerIndex, ownerIndex + 1800) : '';
    const aliasMarker = '\\"aliases\\":[';
    const aliasStart = window.indexOf(aliasMarker);
    const aliasEnd = aliasStart >= 0 ? window.indexOf(']', aliasStart) : -1;
    const aliasBlock = aliasStart >= 0 && aliasEnd > aliasStart ? window.slice(aliasStart + aliasMarker.length, aliasEnd) : '';
    const explicitTargetAliases = aliasBlock.split('\\"').map((value) => value.trim())
      .filter((value) => /[\u4e00-\u9fff]/u.test(value) && !/[\u3040-\u30ff]/u.test(value));
    candidate.targetAliases = [...new Set([...candidate.targetAliases, ...explicitTargetAliases])];
    if (candidate.targetAliases.length) {
      candidate.status = 'covered';
      candidate.missingAliases = [];
    }
    const names = candidate.names.map((name) => name.trim().toLocaleLowerCase()).filter((name) => name.length >= 2);
    const pathMatches = segments.filter((segment) => candidate.pathLabels.some((path) => segment.pathLabel.startsWith(path)));
    const textMatches = segments.filter((segment) => names.some((name) => segment.sourceText.toLocaleLowerCase().includes(name)));
    candidate.segmentIds = [...new Map([...textMatches, ...pathMatches].map((segment) => [segment.id, segment])).values()]
      .slice(0, 8).map((segment) => segment.id);
  }
  const issues: LuaManagementIssue[] = [];
  const issueSegments = (pathLabel: string, message = ''): string[] => {
    const base = pathLabel.replace(/\s*\[\d+:\d+\].*$/u, '').trim();
    const candidates = segments.filter((segment) => segment.pathLabel.startsWith(base));
    const line = Number(message.match(/\[(\d+):\d+\]/u)?.[1] || 0);
    if (line && candidates.length) {
      const nearest = candidates.map((segment) => ({ segment, distance: Math.abs(Number(segment.pathLabel.match(/行\s*(\d+)/u)?.[1] || 0) - line) }))
        .sort((a, b) => a.distance - b.distance)[0];
      return nearest ? [nearest.segment.id] : [];
    }
    return candidates.map((segment) => segment.id);
  };
  if (namespaceSegment) {
    const target = namespaceTargetText;
    if (namespaceSegment.reviewStatus !== 'approved' || !target) {
      issues.push({
        kind: 'namespace',
        pathLabel: namespaceSegment.pathLabel,
        message: namespaceHandling === 'review'
          ? '该名称处于旧的待审核状态。请在本页人工核对并确认最终名称；确认后会同步已识别的模块内部引用。'
          : '请在本页人工核对命名空间。保留原文或手动填写最终名称后再确认，系统不会推断用途。',
        blocking: true,
        segmentIds: [namespaceSegment.id],
      });
    } else if (!draftModule) {
      issues.push({
        kind: 'namespace',
        pathLabel: namespaceSegment.pathLabel,
        message: target === sourceNamespace
          ? '已人工确认保留原文；生成 Lua 草稿后会再次检查该内部标识符。'
          : `已确认目标名称「${target}」，但尚未生成 Lua 草稿，无法验证替换和内部引用同步。`,
        blocking: false,
        segmentIds: [namespaceSegment.id],
      });
    } else if (typeof draftModule.namespace !== 'string' || draftModule.namespace.trim() !== target) {
      issues.push({
        kind: 'namespace',
        pathLabel: namespaceSegment.pathLabel,
        message: `已确认目标名称「${target}」，但当前 Lua 草稿仍为「${typeof draftModule.namespace === 'string' ? draftModule.namespace : '未设置'}」。请重新应用审核结果。`,
        blocking: true,
        segmentIds: [namespaceSegment.id],
      });
    } else if (target !== sourceNamespace) {
      const stalePaths = staleRisuModuleNamespaceProtocolPaths(draftModule, sourceNamespace);
      if (stalePaths.length) {
        issues.push({
          kind: 'namespace',
          pathLabel: namespaceSegment.pathLabel,
          message: `发现 ${stalePaths.length} 处模块内部协议仍引用旧名称：${stalePaths.slice(0, 2).join('、')}${stalePaths.length > 2 ? ' 等' : ''}。请重新应用审核结果以同步替换。`,
          blocking: true,
          segmentIds: [namespaceSegment.id],
        });
      }
    }
  }
  if (draftModule) {
    // A parser position addresses the raw Lua code block, not a translated text
    // segment near the same line. Linking it to a nearby segment misdirects the
    // user to unrelated prose, so syntax errors are handled by their own line editor.
    validateRisuLuaChanges(module, draftModule).forEach((issue) => issues.push({ ...issue, kind: 'syntax', blocking: true, segmentIds: [] }));
    validateRisuTemplateChanges(module, draftModule).forEach((issue) => issues.push({ ...issue, kind: 'template', blocking: true, segmentIds: issueSegments(issue.pathLabel, issue.message) }));
    if (input.draftCard) {
      validateRisuControlReferences(input.originalCard, input.draftCard, module, draftModule, input.regexValidationOverrides)
        .forEach((issue) => issues.push({ ...issue, kind: 'control', blocking: true, segmentIds: issueSegments(issue.pathLabel, issue.message) }));
    }
  }
  if (input.originalModule) {
    detectRisuRuntimeRisks(module).forEach((issue) => issues.push({ ...issue, kind: 'runtime', blocking: false, segmentIds: issueSegments(issue.pathLabel, issue.message) }));
  }
  for (const candidate of portraitCandidates.filter((item) => item.status === 'needs-alias')) {
    issues.push({
      kind: 'portrait',
      pathLabel: candidate.ownerId,
      message: `运行时名称目录还缺少 ${candidate.missingAliases.length} 个目标语言别名，翻译阶段 2 会自动补齐；导出阶段仅作兜底。`,
      blocking: false,
      segmentIds: candidate.pathLabels.flatMap((path) => issueSegments(path)),
    });
  }
  for (const finding of routerRepair.findings) {
    issues.push({
      kind: 'router',
      pathLabel: finding.pathLabel,
      message: `${finding.title}：${finding.message}`,
      blocking: false,
      segmentIds: issueSegments(finding.pathLabel),
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
      message: hasModule ? `已发现 ${sourceCount} 个 Lua 代码块、${regexRules.length} 条正则规则；均已提取到本页管理。` : '当前卡片没有 Risu 模块，跳过 Lua 扫描。',
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
    regexCount: regexRules.length,
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
    namespaceHandling,
    segments,
    controlReferences,
    regexRules,
    issues,
    steps,
  };
}
