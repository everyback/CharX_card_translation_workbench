import { ArrowRight, Check, Code2, Play, RotateCcw, RefreshCw, Search, ShieldCheck, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LuaManagementReport, PortraitRouterRepairChange, PortraitRouterRepairPreview, RegexCoveragePreview, RegexCoverageRule, RegexCoverageRuleResult, RegexCoverageRuleStatus, RegexRuleSaveResult, RegexRuleTestResult, ReviewFocus } from '@/shared/types';
import { LuaDetectionGrid } from './components/diagnostics/LuaDetectionGrid';
import { LuaExportIssues } from './components/diagnostics/LuaExportIssues';
import { LuaPortraitCandidates } from './components/portrait/LuaPortraitCandidates';
import { LuaRuntimeRegexList } from './components/regex/LuaRuntimeRegexList';
import { LuaSyntaxDetails } from './components/diagnostics/LuaSyntaxDetails';
import { RegexCoverageDialog } from './components/regex/RegexCoverageDialog';
import { RegexEditorDialog, type RegexEditorState } from './components/regex/RegexEditorDialog';
import { NamespaceConfirmationDialog } from './components/namespace/NamespaceConfirmationDialog';
import { RouterPreviewDialog } from './components/router/RouterPreviewDialog';
import { changedSection, replaceChangedSection } from './components/router/RouterCodePanel';

function routerChangeKey(change: PortraitRouterRepairChange, index: number): string {
  return `${change.id}:${change.pathLabel}:${index}`;
}

export function LuaPage({
  report,
  loading,
  onRefresh,
  onScan,
  onPreviewRouterRepair,
  onApplyRouterRepair,
  onResetLuaDraft,
  onPreviewError,
  onSaveLuaSyntaxLine,
  onOpenExport,
  onConfirmNamespace,
  onSaveAliases,
  onPreviewRegexCoverage,
  onAnalyzeRegexRule,
  onTestRegexRule,
  onSaveRegexRule,
  regexConcurrency,
  reviewFocus,
  onClearReviewFocus,
}: {
  report: LuaManagementReport | null;
  loading: boolean;
  onRefresh: () => void;
  onScan: () => void;
  onPreviewRouterRepair: () => Promise<PortraitRouterRepairPreview>;
  onApplyRouterRepair: (changes?: PortraitRouterRepairChange[]) => Promise<void> | void;
  onResetLuaDraft: () => Promise<void> | void;
  onPreviewError: (error: unknown) => void;
  onSaveLuaSyntaxLine: (pathJson: string, line: number, replacement: string, expectedLine?: string) => Promise<{ syntaxOk: boolean; remainingSyntaxIssues?: unknown[] }>;
  onOpenExport: () => void;
  onConfirmNamespace: (targetNamespace: string) => Promise<void>;
  onSaveAliases: (ownerId: string, aliases: string[]) => Promise<void>;
  onPreviewRegexCoverage: () => Promise<RegexCoveragePreview>;
  onAnalyzeRegexRule: (pathLabel: string, signal?: AbortSignal, pattern?: string) => Promise<RegexCoverageRuleResult>;
  onTestRegexRule: (pathLabel: string, pattern: string) => Promise<RegexRuleTestResult>;
  onSaveRegexRule: (pathLabel: string, pattern: string, expectedPattern: string, forcePass: boolean, output?: string, expectedOutput?: string) => Promise<RegexRuleSaveResult>;
  regexConcurrency: number;
  reviewFocus: ReviewFocus | null;
  onClearReviewFocus: () => void;
}) {
  const [query, setQuery] = useState('');
  const [selectedOwnerId, setSelectedOwnerId] = useState<string | null>(null);
  const [routerPreview, setRouterPreview] = useState<PortraitRouterRepairPreview | null>(null);
  const [routerPreviewLoading, setRouterPreviewLoading] = useState(false);
  const [routerApplying, setRouterApplying] = useState(false);
  const [routerDrafts, setRouterDrafts] = useState<Record<string, string>>({});
  const [editingRouterChange, setEditingRouterChange] = useState<number | null>(null);
  const [routerEditValue, setRouterEditValue] = useState('');
  const [regexPreview, setRegexPreview] = useState<RegexCoveragePreview | null>(null);
  const [regexPreviewLoading, setRegexPreviewLoading] = useState(false);
  const [regexCurrentPaths, setRegexCurrentPaths] = useState<string[]>([]);
  const [regexQueuedPaths, setRegexQueuedPaths] = useState<string[]>([]);
  const [regexCoverageDrafts, setRegexCoverageDrafts] = useState<Record<string, string>>({});
  const [regexCoverageTests, setRegexCoverageTests] = useState<Record<string, RegexRuleTestResult>>({});
  const [regexCoverageTestingPath, setRegexCoverageTestingPath] = useState<string | null>(null);
  const [regexCoverageSavingPath, setRegexCoverageSavingPath] = useState<string | null>(null);
  const regexCoverageQueueRef = useRef<Array<{ pathLabel: string; pattern: string }>>([]);
  const regexCoverageControllersRef = useRef(new Map<string, AbortController>());
  const regexCoverageInFlightRef = useRef(0);
  const [syntaxLineDrafts, setSyntaxLineDrafts] = useState<Record<string, string>>({});
  const [savingSyntaxKey, setSavingSyntaxKey] = useState<string | null>(null);
  const [syntaxSaveMessage, setSyntaxSaveMessage] = useState<string | null>(null);
  const [syntaxContextExpanded, setSyntaxContextExpanded] = useState<Record<string, boolean>>({});
  const [namespaceDialogOpen, setNamespaceDialogOpen] = useState(false);
  const [namespaceDraft, setNamespaceDraft] = useState('');
  const [namespaceSaving, setNamespaceSaving] = useState(false);
  const [regexEditor, setRegexEditor] = useState<RegexEditorState | null>(null);
  const [regexEditorPattern, setRegexEditorPattern] = useState('');
  const [regexEditorOutput, setRegexEditorOutput] = useState('');
  const [regexEditorForcePass, setRegexEditorForcePass] = useState(false);
  const [regexEditorTest, setRegexEditorTest] = useState<RegexRuleTestResult | null>(null);
  const [regexEditorCandidateNotice, setRegexEditorCandidateNotice] = useState<string | null>(null);
  const [regexEditorTesting, setRegexEditorTesting] = useState(false);
  const [regexEditorSaving, setRegexEditorSaving] = useState(false);
  const [regexEditorAnalyzing, setRegexEditorAnalyzing] = useState(false);
  const regexEditorAbortRef = useRef<AbortController | null>(null);
  const regexConcurrencyLimit = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(Number(regexConcurrency) || 1)));
  const regexRunning = regexCurrentPaths.length > 0 || regexQueuedPaths.length > 0;
  const regexReferenceCount = report?.regexCount ?? 0;

  const namespaceSegment = useMemo(
    () => report?.segments.find((segment) => segment.pathLabel === '$module.namespace') ?? null,
    [report],
  );
  const postprocessReferences = useMemo(
    () => report?.regexRules.filter((reference) => reference.runtimePostprocess === true) ?? [],
    [report],
  );
  const runtimeDisplayReferences = useMemo(
    () => report?.regexRules.filter((reference) => reference.dynamicDisplay === true && reference.runtimePostprocess !== true) ?? [],
    [report],
  );
  const staticRegexReferences = useMemo(
    () => report?.regexRules.filter((reference) => !reference.dynamicDisplay && reference.runtimePostprocess !== true) ?? [],
    [report],
  );
  const staticRegexProblemCount = useMemo(() => staticRegexReferences.filter((reference) => (
    !reference.dynamicDisplay && reference.originalMatches !== reference.draftMatches && reference.forcePassed !== true
  )).length, [staticRegexReferences]);

  const filteredCandidates = useMemo(() => {
    if (!report) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return report.portraitCandidates.filter((candidate) => (
      !normalized || [candidate.ownerId, ...candidate.names, ...candidate.missingAliases]
        .some((value) => value.toLocaleLowerCase().includes(normalized))
    ));
  }, [query, report]);

  const syntaxIssues = useMemo(() => report?.issues.filter((issue) => issue.kind === 'syntax') ?? [], [report]);
  const namespaceIssues = useMemo(() => report?.issues.filter((issue) => issue.kind === 'namespace') ?? [], [report]);
  const namespaceBlocked = namespaceIssues.some((issue) => issue.blocking);
  const namespaceTarget = (namespaceSegment?.finalText || namespaceSegment?.translatedText || '').trim();
  const namespaceConfirmed = namespaceSegment?.reviewStatus === 'approved' && Boolean(namespaceTarget);

  function openNamespaceConfirmation(): void {
    setNamespaceDraft(namespaceTarget || namespaceSegment?.sourceText || '');
    setNamespaceDialogOpen(true);
  }

  async function confirmNamespace(): Promise<void> {
    const target = namespaceDraft.trim();
    if (!target) {
      onPreviewError(new Error('请填写确认后的模块命名空间。'));
      return;
    }
    setNamespaceSaving(true);
    try {
      await onConfirmNamespace(target);
      setNamespaceDialogOpen(false);
    } catch (error) {
      onPreviewError(error);
    } finally {
      setNamespaceSaving(false);
    }
  }
  const luaControlReferences = useMemo(
    () => report?.controlReferences.filter((reference) => reference.kind === 'lua') ?? [],
    [report],
  );
  useEffect(() => {
    if (!report) return;
    const drafts: Record<string, string> = {};
    report.issues.forEach((issue, index) => {
      if (issue.kind === 'syntax') drafts[`${issue.kind}:${issue.pathLabel}:${index}`] = issue.draftLine ?? '';
    });
    setSyntaxLineDrafts(drafts);
    setSyntaxSaveMessage(null);
    setSyntaxContextExpanded({});
  }, [report?.generatedAt]);
  function focusSyntaxEditor(): void {
    if (!report) return;
    const focusPath = reviewFocus?.pathLabel;
    const focusLine = reviewFocus?.line;
    if (!focusPath) return;
    const syntaxIndex = syntaxIssues.findIndex((issue) => issue.kind === 'syntax'
      && issue.pathLabel === focusPath
      && (!focusLine || issue.line === focusLine));
    if (syntaxIndex < 0) {
      return;
    }
    window.setTimeout(() => {
      const element = document.getElementById(`lua-syntax-snippet-${syntaxIndex}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.querySelector('textarea')?.focus();
    }, 0);
  }

  useEffect(() => {
    if (!reviewFocus || !report) return;
    const syntaxIndex = syntaxIssues.findIndex((issue) => issue.kind === 'syntax'
      && issue.pathLabel === reviewFocus.pathLabel
      && (!reviewFocus.line || issue.line === reviewFocus.line));
    if (syntaxIndex < 0) return;
    window.setTimeout(() => document.getElementById(`lua-syntax-snippet-${syntaxIndex}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 0);
  }, [reviewFocus, report?.generatedAt, syntaxIssues]);

  async function saveSyntaxLine(issue: LuaManagementReport['issues'][number], issueKey: string) {
    const line = issue.line;
    const pathJson = issue.pathJson;
    if (!pathJson || !line) {
      onPreviewError(new Error('该语法错误缺少可定位的 Lua 路径或行号，请刷新诊断。'));
      return;
    }
    const replacement = syntaxLineDrafts[issueKey] ?? issue.draftLine ?? '';
    setSavingSyntaxKey(issueKey);
    setSyntaxSaveMessage(null);
    try {
      const result = await onSaveLuaSyntaxLine(pathJson, line, replacement, issue.draftLine);
      setSyntaxSaveMessage(result.syntaxOk
        ? '已保存人工修改，当前 脚本 语法校验通过。'
        : `已保存人工修改，但仍有 ${result.remainingSyntaxIssues?.length ?? 1} 条 脚本 语法错误，请继续检查。`);
    } catch (error) {
      onPreviewError(error);
    } finally {
      setSavingSyntaxKey(null);
    }
  }

  async function openRouterPreview() {
    setRouterPreviewLoading(true);
    try {
      const preview = await onPreviewRouterRepair();
      setRouterPreview(preview);
      setRouterDrafts(Object.fromEntries(preview.changes.map((change, index) => [routerChangeKey(change, index), change.after])));
      setEditingRouterChange(null);
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRouterPreviewLoading(false);
    }
  }

  async function applyRouterPreview() {
    if (!routerPreview || editingRouterChange !== null) return;
    setRouterApplying(true);
    try {
      const changes = routerPreview.changes.map((change, index) => ({
        ...change,
        after: routerDrafts[routerChangeKey(change, index)] ?? change.after,
      }));
      await onApplyRouterRepair(changes);
      setRouterPreview(null);
      setRouterDrafts({});
    } finally {
      setRouterApplying(false);
    }
  }

  function beginRouterEdit(index: number, value: string, peer: string) {
    setEditingRouterChange(index);
    setRouterEditValue(changedSection(value, peer));
  }

  function cancelRouterEdit() {
    setEditingRouterChange(null);
    setRouterEditValue('');
  }

  function saveRouterEdit(change: PortraitRouterRepairChange, index: number) {
    const current = routerDrafts[routerChangeKey(change, index)] ?? change.after;
    setRouterDrafts((drafts) => ({ ...drafts, [routerChangeKey(change, index)]: replaceChangedSection(current, change.before, routerEditValue) }));
    cancelRouterEdit();
  }

  function updateRegexRule(pathLabel: string, patch: Partial<RegexCoverageRule>) {
    setRegexPreview((current) => current ? {
      ...current,
      rules: current.rules.map((rule) => rule.pathLabel === pathLabel ? { ...rule, ...patch } : rule),
    } : current);
  }

  async function openRegexPreview() {
    setRegexPreviewLoading(true);
    try {
      const preview = await onPreviewRegexCoverage();
      setRegexPreview({
        ...preview,
        rules: preview.rules.map((rule) => ({ ...rule, status: 'pending' as RegexCoverageRuleStatus })),
      });
      setRegexCurrentPaths([]);
      setRegexQueuedPaths([]);
      regexCoverageQueueRef.current = [];
      regexCoverageControllersRef.current.clear();
      regexCoverageInFlightRef.current = 0;
      setRegexCoverageDrafts(Object.fromEntries(preview.rules.map((rule) => [rule.pathLabel, rule.pattern])));
      setRegexCoverageTests({});
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRegexPreviewLoading(false);
    }
  }

  function syncRegexCoverageActivity() {
    setRegexCurrentPaths([...regexCoverageControllersRef.current.keys()]);
    setRegexQueuedPaths(regexCoverageQueueRef.current.map((entry) => entry.pathLabel));
  }

  function drainRegexCoverageQueue() {
    while (regexCoverageInFlightRef.current < regexConcurrencyLimit && regexCoverageQueueRef.current.length) {
      const next = regexCoverageQueueRef.current.shift();
      if (!next) break;
      const controller = new AbortController();
      regexCoverageInFlightRef.current += 1;
      regexCoverageControllersRef.current.set(next.pathLabel, controller);
      updateRegexRule(next.pathLabel, { status: 'processing', error: undefined });
      syncRegexCoverageActivity();
      void (async () => {
        try {
          const result = await onAnalyzeRegexRule(next.pathLabel, controller.signal, next.pattern);
          if (controller.signal.aborted) {
            updateRegexRule(next.pathLabel, { status: 'cancelled' });
            return;
          }
          updateRegexRule(next.pathLabel, {
            status: result.status,
            proposals: result.proposals,
            changes: result.changes,
            validation: result.validation,
            candidatePattern: result.candidatePattern,
            modelContext: result.modelContext,
            error: result.message,
          });
          if (result.candidatePattern) {
            setRegexCoverageDrafts((drafts) => ({ ...drafts, [next.pathLabel]: result.candidatePattern! }));
          }
        } catch (error) {
          updateRegexRule(next.pathLabel, {
            status: controller.signal.aborted ? 'cancelled' : 'failed',
            error: controller.signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
          });
        } finally {
          regexCoverageControllersRef.current.delete(next.pathLabel);
          regexCoverageInFlightRef.current = Math.max(0, regexCoverageInFlightRef.current - 1);
          syncRegexCoverageActivity();
          drainRegexCoverageQueue();
        }
      })();
    }
    syncRegexCoverageActivity();
  }

  function queueRegexCoverageAnalysis(rule: RegexCoverageRule) {
    const pattern = (regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim();
    if (!pattern || regexCoverageControllersRef.current.has(rule.pathLabel) || regexCoverageQueueRef.current.some((entry) => entry.pathLabel === rule.pathLabel)) return;
    regexCoverageQueueRef.current.push({ pathLabel: rule.pathLabel, pattern });
    updateRegexRule(rule.pathLabel, { status: 'queued', error: undefined, validation: undefined });
    syncRegexCoverageActivity();
    drainRegexCoverageQueue();
  }

  function cancelRegexCoverageAnalysis(rule: RegexCoverageRule) {
    const queued = regexCoverageQueueRef.current.some((entry) => entry.pathLabel === rule.pathLabel);
    if (queued) {
      regexCoverageQueueRef.current = regexCoverageQueueRef.current.filter((entry) => entry.pathLabel !== rule.pathLabel);
      updateRegexRule(rule.pathLabel, { status: 'cancelled', error: undefined });
      syncRegexCoverageActivity();
      return;
    }
    regexCoverageControllersRef.current.get(rule.pathLabel)?.abort();
  }

  function cancelAllRegexCoverageAnalysis() {
    regexCoverageControllersRef.current.forEach((controller) => controller.abort());
    const queuedPaths = new Set(regexCoverageQueueRef.current.map((entry) => entry.pathLabel));
    regexCoverageQueueRef.current = [];
    setRegexPreview((current) => current ? {
      ...current,
      rules: current.rules.map((rule) => (
        rule.status === 'processing' || rule.status === 'queued' || queuedPaths.has(rule.pathLabel)
          ? { ...rule, status: 'cancelled', error: undefined }
          : rule
      )),
    } : current);
    syncRegexCoverageActivity();
  }

  function openRegexEditor(reference: {
    pathLabel: string;
    fullPattern?: string;
    originalPattern?: string;
    originalMatches?: number;
    draftMatches?: number;
    originalSamples?: string[];
    draftSamples?: string[];
    forcePassed?: boolean;
    runtimePostprocess?: boolean;
    out?: string;
  }) {
    const currentPattern = reference.fullPattern || '';
    if (!currentPattern) {
      onPreviewError(new Error('该规则缺少完整正则内容，请刷新诊断后重试。'));
      return;
    }
    setRegexEditor({
      pathLabel: reference.pathLabel,
      originalPattern: reference.originalPattern || currentPattern,
      currentPattern,
      sourceMatchCount: reference.originalMatches ?? 0,
      draftMatchCount: reference.draftMatches ?? 0,
      sourceSamples: reference.originalSamples ?? [],
      draftSamples: reference.draftSamples ?? [],
      forcePassed: reference.forcePassed === true,
      runtimePostprocess: reference.runtimePostprocess === true,
      currentOutput: reference.out ?? '',
    });
    setRegexEditorPattern(currentPattern);
    setRegexEditorOutput(reference.out ?? '');
    setRegexEditorForcePass(reference.forcePassed === true);
    setRegexEditorTest(null);
    setRegexEditorCandidateNotice(null);
  }

  async function testManualRegex() {
    if (!regexEditor || regexEditorTesting || regexEditorSaving || regexEditorAnalyzing) return;
    setRegexEditorTesting(true);
    try {
      setRegexEditorTest(await onTestRegexRule(regexEditor.pathLabel, regexEditorPattern));
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRegexEditorTesting(false);
    }
  }

  async function saveManualRegex() {
    if (!regexEditor || regexEditorSaving || regexEditorTesting || regexEditorAnalyzing) return;
    setRegexEditorSaving(true);
    try {
      const output = regexEditor.runtimePostprocess ? regexEditorOutput : undefined;
      const result = await onSaveRegexRule(
        regexEditor.pathLabel,
        regexEditorPattern,
        regexEditor.currentPattern,
        regexEditor.runtimePostprocess ? false : regexEditorForcePass,
        output,
        regexEditor.runtimePostprocess ? regexEditor.currentOutput : undefined,
      );
      setRegexEditor((current) => current ? {
        ...current,
        currentPattern: result.pattern,
        sourceMatchCount: result.validationSourceMatchCount ?? result.sourceMatchCount,
        draftMatchCount: result.validationDraftMatchCount ?? result.draftMatchCount,
        sourceSamples: result.sourceSamples,
        draftSamples: result.draftSamples,
        forcePassed: result.forcePassed,
        currentOutput: result.out ?? current.currentOutput,
      } : current);
      setRegexEditorPattern(result.pattern);
      if (result.out !== undefined) setRegexEditorOutput(result.out);
      setRegexEditorForcePass(result.forcePassed);
      setRegexEditorTest(result);
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRegexEditorSaving(false);
    }
  }

  async function analyzeManualRegex() {
    if (!regexEditor || regexEditorAnalyzing || regexEditorSaving || regexEditorTesting) return;
    const controller = new AbortController();
    regexEditorAbortRef.current = controller;
    setRegexEditorAnalyzing(true);
    try {
      const result = await onAnalyzeRegexRule(regexEditor.pathLabel, controller.signal, regexEditorPattern);
      if (controller.signal.aborted) return;
      const candidatePattern = result.candidatePattern;
      if (!candidatePattern) {
        setRegexEditorTest(null);
        return;
      }
      setRegexEditorPattern(candidatePattern);
      setRegexEditorForcePass(false);
      setRegexEditorTest(null);
      setRegexEditorCandidateNotice('模型已返回候选规则并填入输入框；请人工修改后测试匹配，再保存到草稿。');
    } catch (error) {
      if (!controller.signal.aborted) onPreviewError(error);
    } finally {
      if (regexEditorAbortRef.current === controller) regexEditorAbortRef.current = null;
      setRegexEditorAnalyzing(false);
    }
  }

  function cancelManualRegexAnalysis() {
    regexEditorAbortRef.current?.abort();
  }

  async function testRegexCoverageRule(rule: RegexCoverageRule) {
    const pattern = regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern;
    if (!pattern || rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel) return;
    setRegexCoverageTestingPath(rule.pathLabel);
    try {
      const result = await onTestRegexRule(rule.pathLabel, pattern);
      setRegexCoverageTests((tests) => ({ ...tests, [rule.pathLabel]: result }));
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRegexCoverageTestingPath(null);
    }
  }

  async function saveRegexCoverageRule(rule: RegexCoverageRule) {
    const pattern = regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern;
    if (!pattern || rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel) return;
    setRegexCoverageSavingPath(rule.pathLabel);
    try {
      const result = await onSaveRegexRule(rule.pathLabel, pattern, rule.pattern, false);
      const passed = result.compiled && (result.dynamicDisplay || result.runtimePostprocess || result.sourceMatchCount === result.draftMatchCount);
      updateRegexRule(rule.pathLabel, {
        pattern: result.pattern,
        candidatePattern: result.pattern,
        sourceMatchCount: result.sourceMatchCount,
        draftMatchCount: result.draftMatchCount,
        sourceSamples: result.sourceSamples,
        draftSamples: result.draftSamples,
        status: passed ? 'validated' : 'rejected',
        validation: {
          passed,
          sourceMatchCount: result.sourceMatchCount,
          draftMatchCount: result.draftMatchCount,
          dynamicDisplay: result.dynamicDisplay,
          runtimePostprocess: result.runtimePostprocess,
          message: passed && result.dynamicDisplay
            ? '动态展示规则已通过编译；静态卡片命中仅作样本参考。'
            : passed && result.runtimePostprocess
            ? '聊天后处理规则已通过编译；静态卡片命中仅作样本参考。'
            : passed ? undefined : `已保存，但命中 ${result.draftMatchCount} 与原文 ${result.sourceMatchCount} 仍不一致。`,
        },
      });
      setRegexCoverageDrafts((drafts) => ({ ...drafts, [rule.pathLabel]: result.pattern }));
      setRegexCoverageTests((tests) => ({ ...tests, [rule.pathLabel]: result }));
    } catch (error) {
      onPreviewError(error);
    } finally {
      setRegexCoverageSavingPath(null);
    }
  }

  if (!report && loading) {
    return <section className="lua-management-section"><div className="table-empty">正在读取脚本诊断信息…</div></section>;
  }
  if (!report) {
    return <section className="lua-management-section"><div className="table-empty">暂时无法读取脚本诊断信息，请重试。</div></section>;
  }

  return (
    <section className="lua-management-section">
      <header className="lua-management-header">
        <div>
          <span className="section-kicker">RisuAI / Lua</span>
          <h1>脚本与聊天后处理</h1>
          <p>命名空间、聊天输出后处理和静态正则分开管理。</p>
        </div>
        <div className="lua-management-actions">
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : ''} size={16} />刷新诊断
          </button>
          <button className="secondary-button" onClick={onScan}><Search size={16} />重新扫描 脚本</button>
        </div>
      </header>

      <div className="lua-work-summary" aria-label="脚本处理概览">
        <div className={report.blockerCount ? 'blocking' : ''}><span>导出阻断</span><strong>{report.blockerCount}</strong><small>{report.warningCount} 条提醒</small></div>
        <div className={namespaceBlocked ? 'blocking' : namespaceIssues.length ? 'attention' : namespaceSegment ? 'ready' : ''}><span>命名空间</span><strong>{namespaceSegment ? 1 : 0}</strong><small>{namespaceConfirmed ? (report?.namespaceHandling === 'preserved' ? '已确认保留原文' : '已人工修改并同步') : namespaceBlocked ? '待人工检查' : namespaceIssues.length ? '待回验' : namespaceSegment ? '已同步' : '未检测到'}</small></div>
        <div className={postprocessReferences.length ? 'attention' : ''}><span>聊天后处理</span><strong>{postprocessReferences.length}</strong><small>生成回复后执行</small></div>
        <div className={staticRegexProblemCount ? 'blocking' : ''}><span>静态正则</span><strong>{staticRegexReferences.length}</strong><small>{staticRegexProblemCount ? `${staticRegexProblemCount} 条待处理` : '命中已校验'}</small></div>
      </div>

      {reviewFocus && <div className="lua-focus-alert" role="status">
        <div><strong>已过滤保存校验错误行</strong><span>{reviewFocus.pathLabel}{reviewFocus.originalMatches != null && reviewFocus.draftMatches != null ? ` · 匹配数 ${reviewFocus.originalMatches} → ${reviewFocus.draftMatches}` : ''}{reviewFocus.line ? ` · 第 ${reviewFocus.line} 行，第 ${reviewFocus.column ?? '?'} 列` : ''}</span><p>{reviewFocus.problem}</p>{reviewFocus.sourceLine && <code className="lua-focus-code-line">原始代码：{reviewFocus.sourceLine}</code>}{reviewFocus.draftLine && <code className="lua-focus-code-line current">当前稿：{reviewFocus.draftLine}</code>}<p><b>修正方案：</b>{reviewFocus.fixSuggestion}</p>{reviewFocus.line && <button type="button" className="secondary-button lua-locate-button" onClick={() => focusSyntaxEditor()}><Code2 size={14} />定位到 Lua 编辑器</button>}</div>
        <button className="icon-button" title="关闭错误提示" aria-label="关闭错误提示" onClick={onClearReviewFocus}><X size={15} /></button>
      </div>}

      {regexEditor && <RegexEditorDialog
        editor={regexEditor}
        pattern={regexEditorPattern}
        output={regexEditorOutput}
        forcePass={regexEditorForcePass}
        test={regexEditorTest}
        candidateNotice={regexEditorCandidateNotice}
        analyzing={regexEditorAnalyzing}
        testing={regexEditorTesting}
        saving={regexEditorSaving}
        onClose={() => setRegexEditor(null)}
        onCancelAnalysis={cancelManualRegexAnalysis}
        onPatternChange={(value) => { setRegexEditorPattern(value); setRegexEditorTest(null); setRegexEditorCandidateNotice(null); }}
        onOutputChange={(value) => { setRegexEditorOutput(value); setRegexEditorTest(null); }}
        onForcePassChange={setRegexEditorForcePass}
        onAnalyze={() => void analyzeManualRegex()}
        onTest={() => void testManualRegex()}
        onSave={() => void saveManualRegex()}
      />}

      {regexPreview && <RegexCoverageDialog
        preview={regexPreview}
        currentPaths={regexCurrentPaths}
        queuedPaths={regexQueuedPaths}
        concurrencyLimit={regexConcurrencyLimit}
        running={regexRunning}
        drafts={regexCoverageDrafts}
        tests={regexCoverageTests}
        testingPath={regexCoverageTestingPath}
        savingPath={regexCoverageSavingPath}
        onClose={() => setRegexPreview(null)}
        onCancelAll={cancelAllRegexCoverageAnalysis}
        onDraftChange={(rule, value) => {
          setRegexCoverageDrafts((drafts) => ({ ...drafts, [rule.pathLabel]: value }));
          setRegexCoverageTests((tests) => { const next = { ...tests }; delete next[rule.pathLabel]; return next; });
          updateRegexRule(rule.pathLabel, { candidatePattern: value, status: rule.status === 'pending' ? 'pending' : 'returned', validation: undefined, error: undefined });
        }}
        onQueueAnalysis={queueRegexCoverageAnalysis}
        onCancelAnalysis={cancelRegexCoverageAnalysis}
        onTestRule={(rule) => void testRegexCoverageRule(rule)}
        onSaveRule={(rule) => void saveRegexCoverageRule(rule)}
      />}

      {namespaceDialogOpen && namespaceSegment && <NamespaceConfirmationDialog
        segment={namespaceSegment}
        currentValue={namespaceTarget}
        draft={namespaceDraft}
        saving={namespaceSaving}
        onDraftChange={setNamespaceDraft}
        onClose={() => setNamespaceDialogOpen(false)}
        onConfirm={() => void confirmNamespace()}
      />}

      {routerPreview && <RouterPreviewDialog
        preview={routerPreview}
        drafts={routerDrafts}
        applying={routerApplying}
        editingIndex={editingRouterChange}
        editValue={routerEditValue}
        onClose={() => setRouterPreview(null)}
        onBeginEdit={beginRouterEdit}
        onCancelEdit={cancelRouterEdit}
        onEditValueChange={setRouterEditValue}
        onSaveEdit={saveRouterEdit}
        onApply={() => void applyRouterPreview()}
      />}

      <div className="lua-primary-grid">
        <section className="lua-panel lua-namespace-panel" id="lua-namespace-detection-detail">
          <div className="lua-panel-header">
            <div><h2>模块命名空间检查</h2><span>由你直接核对和修改；系统不会推断用途或自动生成译名</span></div>
            <ShieldCheck size={17} />
          </div>
          {namespaceSegment ? (
            <div className="lua-namespace-body">
              <div><span>原始名称</span><code>{namespaceSegment.sourceText}</code></div>
              <div><span>处理方式</span><strong>{namespaceConfirmed ? '人工确认' : '尚未人工检查'}</strong></div>
              <div><span>当前值</span><strong>{namespaceTarget || namespaceSegment.sourceText}</strong></div>
              <div><span>确认状态</span><em className={`lua-namespace-status ${namespaceSegment.reviewStatus}`}>{namespaceConfirmed ? (report?.namespaceHandling === 'preserved' ? '已确认保留' : '已确认修改') : '待检查'}</em></div>
              <div><span>检测结果</span><strong className={namespaceBlocked ? 'lua-namespace-problem' : namespaceIssues.length ? 'lua-namespace-warning' : 'lua-namespace-ok'}>{namespaceIssues[0]?.message || '当前名称与已识别的模块内部引用均已同步。'}</strong></div>
              <div className="lua-namespace-actions">
                <span>{namespaceConfirmed
                  ? '已由人工确认。需要改回原文或改成其他名称时，重新打开核对窗口即可。'
                  : '打开人工核对窗口后，保留原文或手动修改确认值。系统不判断这个字段是否可见，也不会跳转审核页。'}</span>
                <div className="lua-namespace-decision-buttons">
                  <button type="button" className="primary-button" disabled={loading || namespaceSaving} onClick={openNamespaceConfirmation}><Check size={14} />{namespaceConfirmed ? '重新人工核对' : '人工核对并确认'}</button>
                </div>
              </div>
            </div>
          ) : <div className="lua-simple-empty">当前模块未定义命名空间。</div>}
        </section>

        <section className="lua-panel lua-postprocess-panel">
          <div className="lua-panel-header">
            <div><h2>聊天后处理</h2><span>{postprocessReferences.length} 条 editoutput 规则</span></div>
            <Code2 size={17} />
          </div>
          <div className="lua-postprocess-list">
            {postprocessReferences.map((reference) => (
              <button type="button" className="lua-postprocess-row" key={reference.pathLabel} onClick={() => openRegexEditor(reference)}>
                <div className="lua-postprocess-rule"><code>{reference.pathLabel}</code><span>in</span><strong>{reference.fullPattern || reference.pattern}</strong></div>
                <div className="lua-postprocess-output"><span>out</span><code>{reference.out === '' ? '（空字符串：删除匹配内容）' : reference.out || '（未设置）'}</code></div>
                <Code2 size={15} />
              </button>
            ))}
            {!postprocessReferences.length && <div className="lua-simple-empty">没有聊天后处理规则。</div>}
          </div>
        </section>
      </div>

      <section className="lua-panel lua-static-regex-panel">
        <div className="lua-panel-header">
          <div><h2>静态正则校验</h2><span>仅显示可以在卡片文本中验证命中数的规则</span></div>
          <div className="lua-panel-header-actions">
            <button className="secondary-button" onClick={() => void openRegexPreview()} disabled={loading || regexPreviewLoading || regexRunning || !regexReferenceCount}>
              {regexPreviewLoading ? <RefreshCw className="spin" size={14} /> : <ShieldCheck size={14} />}逐条分析
            </button>
          </div>
        </div>
        <div className="lua-static-regex-list">
          {staticRegexReferences.map((reference) => {
            const mismatch = !reference.dynamicDisplay && reference.originalMatches !== reference.draftMatches && reference.forcePassed !== true;
            return <button type="button" className={`lua-static-regex-row${mismatch ? ' problem' : ''}`} key={reference.pathLabel} onClick={() => openRegexEditor(reference)}>
              <code>{reference.pathLabel}</code><span>{reference.fullPattern || reference.pattern}</span><em>{mismatch ? `命中异常：${reference.originalMatches} → ${reference.draftMatches}` : reference.dynamicDisplay ? '动态展示规则' : '命中已保持'}</em><ArrowRight size={14} />
            </button>;
          })}
          {!staticRegexReferences.length && <div className="lua-simple-empty">本模块的正则均在回复生成后执行，因此不显示静态命中校验。</div>}
        </div>
      </section>

      <LuaDetectionGrid
        report={report}
        syntaxIssues={syntaxIssues}
        luaControlReferences={luaControlReferences}
        runtimeDisplayReferences={runtimeDisplayReferences}
        loading={loading}
        routerPreviewLoading={routerPreviewLoading}
        onScan={onScan}
        onOpenRouterPreview={() => void openRouterPreview()}
        onOpenExport={onOpenExport}
      />

      <div className="lua-detail-grid">
        <LuaPortraitCandidates
          report={report}
          filteredCandidates={filteredCandidates}
          query={query}
          selectedOwnerId={selectedOwnerId}
          onQueryChange={setQuery}
          onSelectOwner={setSelectedOwnerId}
          onSaveAliases={onSaveAliases}
        />
        <LuaRuntimeRegexList references={runtimeDisplayReferences} onOpen={openRegexEditor} />
        <LuaExportIssues report={report} onOpenRegex={openRegexEditor} />
      </div>

      <LuaSyntaxDetails
        report={report}
        syntaxIssues={syntaxIssues}
        syntaxContextExpanded={syntaxContextExpanded}
        syntaxLineDrafts={syntaxLineDrafts}
        loading={loading}
        savingSyntaxKey={savingSyntaxKey}
        syntaxSaveMessage={syntaxSaveMessage}
        onSetDraft={(issueKey, value) => setSyntaxLineDrafts((drafts) => ({ ...drafts, [issueKey]: value }))}
        onToggleContext={(issueKey, expanded) => setSyntaxContextExpanded((current) => ({ ...current, [issueKey]: expanded }))}
        onSaveSyntaxLine={(issue, issueKey) => void saveSyntaxLine(issue, issueKey)}
      />

      <div className="lua-maintenance-row">
        <button className="danger-button" onClick={() => void onResetLuaDraft()} disabled={loading || !report.hasModule} title="仅恢复 Lua 模块草稿，不影响卡片正文和翻译结果"><RotateCcw size={16} />恢复原始 Lua 草稿</button>
      </div>

      <div className="lua-footnote"><Code2 size={15} /><span>脚本管理页只处理脚本、正则和别名；可翻译文本统一在审核页修改，语法错误只在上方按真实代码行修复。</span></div>
    </section>
  );
}
