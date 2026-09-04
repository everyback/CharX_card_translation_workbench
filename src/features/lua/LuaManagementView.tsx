import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleAlert,
  Code2,
  FileCheck2,
  Minus,
  Play,
  Plus,
  RotateCcw,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LuaManagementReport, PortraitRouterRepairChange, PortraitRouterRepairPreview, RegexCoveragePreview, RegexCoverageRule, RegexCoverageRuleResult, RegexCoverageRuleStatus, RegexRuleSaveResult, RegexRuleTestResult, ReviewFocus } from '../../types';

const ISSUE_LABELS = {
  syntax: 'Lua 语法',
  template: '模板结构',
  runtime: '运行时提醒',
  control: '控制引用',
  portrait: '立绘别名',
  router: '路由修复',
  namespace: '命名空间',
} as const;

function summarizeMatchSamples(samples?: string[]): string {
  const values = (samples ?? []).map((sample) => sample.replace(/\s+/gu, ' ').trim()).filter(Boolean);
  if (!values.length) return '无';
  // The evidence panel is for locating a hit, not re-reading a card. Keep it
  // short while preserving the count and the full rule above it.
  const shown = values.slice(0, 2).map((sample) => sample.length > 72 ? `${sample.slice(0, 72)}…` : sample);
  return `${shown.join(' / ')}${values.length > shown.length ? `（共 ${values.length} 条）` : ''}`;
}

function MatchExampleList({ samples }: { samples?: string[] }) {
  const values = (samples ?? []).filter(Boolean).slice(0, 8);
  if (!values.length) return <span className="regex-editor-no-examples">无命中示例</span>;
  return <ul className="regex-editor-example-list">{values.map((sample, index) => <li key={`${index}:${sample}`}><code>{sample}</code></li>)}</ul>;
}

interface CompactCodeLine {
  number: number;
  text: string;
  changed: boolean;
}

interface CompactCode {
  lines: CompactCodeLine[];
  hiddenBefore: boolean;
  hiddenAfter: boolean;
  changedCount: number;
}

function codeLines(source: string): string[] {
  return source.replace(/\r\n/gu, '\n').split('\n');
}

function diffBounds(source: string, peer: string): { lines: string[]; prefix: number; suffix: number } {
  const lines = codeLines(source);
  const peerLines = codeLines(peer);
  let prefix = 0;
  while (prefix < lines.length && prefix < peerLines.length && lines[prefix] === peerLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < lines.length - prefix
    && suffix < peerLines.length - prefix
    && lines[lines.length - suffix - 1] === peerLines[peerLines.length - suffix - 1]
  ) suffix += 1;
  return { lines, prefix, suffix };
}

function changedSection(source: string, peer: string): string {
  const { lines, prefix, suffix } = diffBounds(source, peer);
  return lines.slice(prefix, Math.max(prefix, lines.length - suffix)).join('\n');
}

function replaceChangedSection(source: string, peer: string, replacement: string): string {
  const { lines, prefix, suffix } = diffBounds(source, peer);
  const replacementLines = replacement === '' ? [] : replacement.replace(/\r\n/gu, '\n').split('\n');
  return [...lines.slice(0, prefix), ...replacementLines, ...lines.slice(Math.max(prefix, lines.length - suffix))].join('\n');
}

function compactCode(source: string, peer: string): CompactCode {
  const { lines, prefix, suffix } = diffBounds(source, peer);
  const changedEnd = Math.max(prefix, lines.length - suffix);
  const start = Math.max(0, prefix - 3);
  const end = Math.min(lines.length, changedEnd + 3);
  return {
    lines: lines.slice(start, end).map((text, index) => ({ number: start + index + 1, text, changed: start + index >= prefix && start + index < changedEnd })),
    hiddenBefore: start > 0,
    hiddenAfter: end < lines.length,
    changedCount: Math.max(0, changedEnd - prefix),
  };
}

function routerChangeKey(change: PortraitRouterRepairChange, index: number): string {
  return `${change.id}:${change.pathLabel}:${index}`;
}

function RouterCodePanel({
  source,
  peer,
  tone,
  editable,
  onDoubleClick,
}: {
  source: string;
  peer: string;
  tone: 'before' | 'after';
  editable?: boolean;
  onDoubleClick?: () => void;
}) {
  const compact = compactCode(source, peer);
  return (
    <div
      className={`router-code-panel router-code-panel-${tone}${editable ? ' editable' : ''}`}
      title={editable ? '双击修改建议代码' : undefined}
      onDoubleClick={editable ? onDoubleClick : undefined}
      role={editable ? 'button' : undefined}
      tabIndex={editable ? 0 : undefined}
    >
      {compact.hiddenBefore && <div className="router-code-ellipsis">…</div>}
      {compact.lines.map((line) => (
        <div className={`router-code-line${line.changed ? ' changed' : ''}`} key={`${line.number}:${line.text}`}>
          <span>{line.number}</span><code>{line.text || ' '}</code>
        </div>
      ))}
      {compact.hiddenAfter && <div className="router-code-ellipsis">…</div>}
    </div>
  );
}

export function LuaManagementView({
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
  const [regexEditor, setRegexEditor] = useState<{
    pathLabel: string;
    originalPattern: string;
    currentPattern: string;
    sourceMatchCount: number;
    draftMatchCount: number;
    sourceSamples: string[];
    draftSamples: string[];
    forcePassed: boolean;
    runtimePostprocess: boolean;
    currentOutput: string;
  } | null>(null);
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

  function regexStatusLabel(status?: RegexCoverageRuleStatus): string {
    switch (status) {
      case 'queued': return '排队中';
      case 'processing': return '分析中';
      case 'returned': return '已返回';
      case 'validated': return '候选通过（未保存）';
      case 'no-change': return '无可安全修改';
      case 'rejected': return '校验未通过';
      case 'failed': return '请求失败';
      case 'cancelled': return '已取消';
      default: return '可编辑';
    }
  }

  function regexProposalSummary(proposals?: Array<Record<string, unknown>>): string {
    const proposal = proposals?.[0];
    if (!proposal) return '模型未提出可安全应用的修改。';
    const pattern = typeof proposal.pattern === 'string' ? proposal.pattern : '';
    if (pattern) return `候选规则：${pattern}`;
    const additions = Array.isArray(proposal.additions)
      ? proposal.additions.filter((value): value is string => typeof value === 'string')
      : [];
    return additions.length ? `新增并列项：${additions.join('、')}` : '模型未提出可安全应用的修改。';
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

      {regexEditor && (
        <div className="modal-backdrop regex-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !regexEditorSaving && !regexEditorAnalyzing) setRegexEditor(null); }}>
          <section className="regex-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="regex-editor-title">
            <header className="dialog-header">
              <div><h2 id="regex-editor-title">{regexEditor.runtimePostprocess ? '人工编辑 Lua 聊天后处理' : '人工编辑正则'}</h2><span>{regexEditor.pathLabel} · 仅保存到 Lua 草稿，导出前仍会执行完整校验。</span></div>
              <button className="icon-button" title="关闭" aria-label="关闭正则编辑" disabled={regexEditorSaving || regexEditorAnalyzing} onClick={() => setRegexEditor(null)}><X size={16} /></button>
            </header>
            <div className="regex-editor-body">
              <div className="regex-editor-baseline">
                <div><span>原始规则</span><code>{regexEditor.originalPattern}</code></div>
                <div><span>已保存草稿</span><code>{regexEditor.currentPattern}</code></div>
                {regexEditor.runtimePostprocess && <div><span>已保存替换输出</span><code>{regexEditor.currentOutput || '（空字符串：删除全部匹配内容）'}</code></div>}
                <div><span>基线命中</span><strong>原文 {regexEditor.sourceMatchCount} · 当前稿 {regexEditor.draftMatchCount}</strong></div>
              </div>
              <div className="regex-coverage-rule-samples regex-editor-examples">
                <div><span>原文命中示例</span><MatchExampleList samples={regexEditor.sourceSamples} /></div>
                <div><span>当前稿命中示例</span><MatchExampleList samples={regexEditor.draftSamples} /></div>
              </div>
              <label className="regex-editor-input">
                <span>{regexEditor.runtimePostprocess ? '匹配式（in）' : '待测试规则'}</span>
                <textarea value={regexEditorPattern} disabled={regexEditorAnalyzing} onChange={(event) => { setRegexEditorPattern(event.target.value); setRegexEditorTest(null); setRegexEditorCandidateNotice(null); }} rows={6} spellCheck={false} aria-label={`编辑 ${regexEditor.pathLabel} 正则`} />
              </label>
              {regexEditor.runtimePostprocess && <>
                <label className="regex-editor-input">
                  <span>聊天后处理输出（out）</span>
                  <textarea value={regexEditorOutput} disabled={regexEditorAnalyzing} onChange={(event) => { setRegexEditorOutput(event.target.value); setRegexEditorTest(null); }} rows={6} spellCheck={false} aria-label={`编辑 ${regexEditor.pathLabel} 后处理输出`} />
                </label>
                <div className="regex-editor-postprocess-note">此模板决定匹配后的内容是否保留。空字符串会删除全部匹配内容；保存时会保留 editoutput 类型并检查匹配式可编译。</div>
              </>}
              {regexEditorCandidateNotice && <div className="regex-editor-candidate-notice" role="status"><Check size={14} />{regexEditorCandidateNotice}</div>}
              {!regexEditor.runtimePostprocess && <label className="regex-editor-force-pass">
                <input type="checkbox" checked={regexEditorForcePass} disabled={regexEditorAnalyzing} onChange={(event) => setRegexEditorForcePass(event.target.checked)} />
                <span><strong>强制通过本条命中校验</strong><small>放弃这条规则的原文/当前稿命中数一致性检测；只对当前规则文本和当前命中数生效，其他结构校验仍保留。</small></span>
              </label>}
              {regexEditorAnalyzing && <div className="regex-editor-analysis-lock" role="status"><RefreshCw className="spin" size={14} />大模型正在修正当前规则，输入框和保存操作已锁定。</div>}
              {regexEditorTest && <div className={`regex-editor-test-result ${regexEditorTest.compiled ? 'compiled' : 'invalid'}`}>
                <div><strong>{regexEditorTest.compiled ? '测试完成' : '编译失败'}</strong><span>{regexEditorTest.message}</span></div>
                {regexEditorTest.compiled && <div className="regex-editor-test-count">候选命中：原文 {regexEditorTest.sourceMatchCount} · 当前稿 {regexEditorTest.draftMatchCount}</div>}
                {regexEditorTest.compiled && <div className="regex-coverage-rule-samples regex-editor-examples">
                  <div><span>候选原文命中</span><MatchExampleList samples={regexEditorTest.sourceSamples} /></div>
                  <div><span>候选当前稿命中</span><MatchExampleList samples={regexEditorTest.draftSamples} /></div>
                </div>}
              </div>}
            </div>
            <footer className="dialog-actions regex-editor-actions">
              {regexEditorAnalyzing ? <button className="secondary-button" onClick={cancelManualRegexAnalysis}><X size={16} />取消分析</button> : <button className="secondary-button" disabled={regexEditorSaving} onClick={() => setRegexEditor(null)}><X size={16} />关闭</button>}
              <button className="secondary-button" disabled={regexEditorAnalyzing || regexEditorTesting || regexEditorSaving || !regexEditorPattern.trim()} onClick={() => void analyzeManualRegex()}>{regexEditorAnalyzing ? <RefreshCw className="spin" size={16} /> : <Search size={16} />}{regexEditor.runtimePostprocess ? '大模型修正匹配式' : '大模型修正'}</button>
              <button className="secondary-button" disabled={regexEditorAnalyzing || regexEditorTesting || regexEditorSaving || !regexEditorPattern.trim()} onClick={() => void testManualRegex()}>{regexEditorTesting ? <RefreshCw className="spin" size={16} /> : <Play size={16} />}测试匹配</button>
              <button className={`primary-button${regexEditorForcePass ? ' danger-button' : ''}`} disabled={regexEditorAnalyzing || regexEditorTesting || regexEditorSaving || !regexEditorPattern.trim()} onClick={() => void saveManualRegex()}>{regexEditorSaving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{regexEditorForcePass ? '强制通过并保存' : regexEditor.runtimePostprocess ? '保存后处理' : '保存规则'}</button>
            </footer>
          </section>
        </div>
      )}

      {regexPreview && (
        <div className="modal-backdrop regex-coverage-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !regexRunning) setRegexPreview(null); }}>
          <section className="regex-coverage-dialog" role="dialog" aria-modal="true" aria-labelledby="regex-coverage-title">
            <header className="dialog-header">
            <div><h2 id="regex-coverage-title">正则规则逐条分析</h2><span>{regexRunning ? `正在修正 ${regexCurrentPaths.length} 行，排队 ${regexQueuedPaths.length} 行（共享模型通道 ${regexConcurrencyLimit} 路）；其他行仍可编辑。` : '每行都可以先人工编辑，再单独点击“大模型修正”；模型处理期间只锁定当前行。'}</span></div>
              <button className="icon-button" title="关闭" aria-label="关闭正则规则逐条分析" disabled={regexRunning} onClick={() => setRegexPreview(null)}><X size={16} /></button>
            </header>
            <div className="regex-coverage-body">
              <div className="regex-coverage-summary">
                <strong>发现 {regexPreview.checked} 条需要处理的规则</strong>
                {(regexCurrentPaths.length > 0 || regexQueuedPaths.length > 0) && <span>分析中：{regexCurrentPaths.join('、') || '无'}{regexQueuedPaths.length ? ` · 排队中：${regexQueuedPaths.join('、')}` : ''}</span>}
              </div>
              <div className="regex-coverage-progress" aria-label="正则修复进度"><span style={{ width: `${regexPreview.rules.length ? (regexPreview.rules.filter((rule) => rule.status && !['pending', 'queued', 'processing'].includes(rule.status)).length / regexPreview.rules.length) * 100 : 100}%` }} /></div>
              <div className="regex-coverage-list">
                {regexPreview.rules.map((rule, index) => (
                  <article className={`regex-coverage-rule status-${rule.status ?? 'pending'}`} key={rule.pathLabel}>
                    <div className="regex-coverage-rule-head"><div><strong>{index + 1}. {rule.pathLabel}</strong><span className={`regex-coverage-rule-status status-${rule.status ?? 'pending'}`}>{regexStatusLabel(rule.status)}</span></div><span>{rule.runtimePostprocess ? 'Lua 聊天后处理规则' : rule.dynamicDisplay ? '运行时回复规则' : `命中 ${rule.sourceMatchCount} → ${rule.draftMatchCount}`}</span></div>
                    <div className="regex-coverage-rule-compare"><div><span>原始规则</span><code>{rule.originalPattern || rule.pattern}</code></div><div><span>{rule.candidatePattern ? '模型候选（可人工修改）' : '当前规则（可人工修改）'}</span><textarea value={regexCoverageDrafts[rule.pathLabel] ?? rule.pattern} disabled={rule.status === 'queued' || rule.status === 'processing'} onChange={(event) => { const value = event.target.value; setRegexCoverageDrafts((drafts) => ({ ...drafts, [rule.pathLabel]: value })); setRegexCoverageTests((tests) => { const next = { ...tests }; delete next[rule.pathLabel]; return next; }); updateRegexRule(rule.pathLabel, { candidatePattern: value, status: rule.status === 'pending' ? 'pending' : 'returned', validation: undefined, error: undefined }); }} rows={3} spellCheck={false} aria-label={`编辑 ${rule.pathLabel} 候选正则`} /></div></div>
                    {rule.dynamicDisplay || rule.runtimePostprocess ? <div className="regex-coverage-context">{rule.runtimePostprocess ? '此规则会在生成回复后执行（editoutput），不读取或发送卡片素材命中片段。此处可修正匹配式；完整的 in / out 人工编辑在上方“聊天后处理”检测项中完成，保存会校验正则编译、规则类型和替换输出。' : '此规则用于运行时模型回复展示，不读取或发送卡片素材命中片段。大模型仅依据当前正则、替换模板和目标语言处理中文无空格、引号与标点边界。'}</div> : <div className="regex-coverage-rule-samples"><div><span>原文命中片段</span><p>{summarizeMatchSamples(rule.sourceSamples?.length ? rule.sourceSamples : rule.sourceMatches)}</p></div><div><span>当前稿命中片段</span><p>{summarizeMatchSamples(rule.draftSamples?.length ? rule.draftSamples : rule.draftMatches)}</p></div></div>}
                    {rule.modelContext && !rule.dynamicDisplay && !rule.runtimePostprocess && <div className="regex-coverage-context">发送上下文：扫描记录 {rule.modelContext.totalRecords}（去重 {rule.modelContext.totalUniqueRecords}）→ 采样 {rule.modelContext.selectedRecords} 条；分组命中差异 {rule.modelContext.strata.coverageDifference}、文本变化 {rule.modelContext.strata.textDifference}、稳定 {rule.modelContext.strata.stable}。命中样本 {rule.modelContext.selectedSourceMatches} / {rule.modelContext.selectedDraftMatches}，载荷 {rule.modelContext.contextChars} / {rule.modelContext.budgetChars} 字符{rule.modelContext.truncated ? '，已按预算裁剪' : ''}{rule.modelContext.formatProbe ? `；空白探针 ${rule.modelContext.formatProbe.sourceMatchCount} → ${rule.modelContext.formatProbe.draftMatchCount}（严格基线 ${rule.modelContext.formatProbe.baselineSourceMatchCount} → ${rule.modelContext.formatProbe.baselineDraftMatchCount}），采样 ${rule.modelContext.formatProbe.selectedRecords} / ${rule.modelContext.formatProbe.totalRecords} 条` : ''}。</div>}
                    {rule.status && !['pending', 'queued', 'processing'].includes(rule.status) && <div className="regex-coverage-model-result">模型返回：{regexProposalSummary(rule.proposals)}</div>}
                    {rule.validation && <div className={`regex-coverage-validation ${rule.validation.passed ? 'passed' : 'failed'}`}>{rule.validation.message || (rule.validation.passed ? `校验通过：候选命中 ${rule.validation.draftMatchCount}，满足原文 ${rule.validation.sourceMatchCount}` : '本地校验未通过，未写入。')}</div>}
                    {rule.error && <div className="regex-coverage-validation failed">{rule.error}</div>}
                    <div className="regex-coverage-rule-actions"><button type="button" className="secondary-button" disabled={rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel || !(regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim()} onClick={() => queueRegexCoverageAnalysis(rule)}>{rule.status === 'queued' ? <RefreshCw className="spin" size={14} /> : <Search size={14} />}大模型修正</button>{(rule.status === 'queued' || rule.status === 'processing') && <button type="button" className="secondary-button" onClick={() => cancelRegexCoverageAnalysis(rule)}><X size={14} />取消本行</button>}<button type="button" className="secondary-button" disabled={rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel || !(regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim()} onClick={() => void testRegexCoverageRule(rule)}>{regexCoverageTestingPath === rule.pathLabel ? <RefreshCw className="spin" size={14} /> : <Play size={14} />}测试匹配</button><button type="button" className="primary-button" disabled={rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel || !(regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim()} onClick={() => void saveRegexCoverageRule(rule)}>{regexCoverageSavingPath === rule.pathLabel ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}保存这条规则</button></div>
                    {regexCoverageTests[rule.pathLabel] && <div className={`regex-coverage-validation ${regexCoverageTests[rule.pathLabel].compiled ? 'passed' : 'failed'}`}>当前输入测试：命中 {regexCoverageTests[rule.pathLabel].sourceMatchCount} → {regexCoverageTests[rule.pathLabel].draftMatchCount}；{regexCoverageTests[rule.pathLabel].message || '规则可编译。'}</div>}
                  </article>
                ))}
                {!regexPreview.rules.length && <div className="table-empty">当前没有静态命中变化或聊天后处理规则，无需全量修复。</div>}
              </div>
            </div>
            <footer className="dialog-actions regex-coverage-actions">
              {regexRunning ? <button className="secondary-button" onClick={cancelAllRegexCoverageAnalysis}><X size={16} />取消全部分析</button> : <button className="secondary-button" onClick={() => setRegexPreview(null)}><X size={16} />关闭</button>}
            </footer>
          </section>
        </div>
      )}

      {namespaceDialogOpen && namespaceSegment && (
        <div className="modal-backdrop namespace-confirmation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !namespaceSaving) setNamespaceDialogOpen(false); }}>
          <section className="namespace-confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="namespace-confirmation-title">
            <header className="dialog-header">
              <div><h2 id="namespace-confirmation-title">人工核对模块命名空间</h2><span>不会自动判断用途或生成译名。请确认保留原文，或直接填写你要使用的名称。</span></div>
              <button type="button" className="icon-button" title="关闭" aria-label="关闭" disabled={namespaceSaving} onClick={() => setNamespaceDialogOpen(false)}><X size={16} /></button>
            </header>
            <div className="namespace-confirmation-body">
              <label><span>原始 namespace</span><code>{namespaceSegment.sourceText}</code></label>
              <label><span>当前已保存值</span><code>{namespaceTarget || namespaceSegment.sourceText}</code></label>
              <label className="namespace-confirmation-input"><span>确认后使用的名称</span><input value={namespaceDraft} onChange={(event) => setNamespaceDraft(event.target.value)} placeholder="保留原文或手动填写名称" autoFocus /></label>
              <p>{namespaceDraft.trim() === namespaceSegment.sourceText ? '确认原文后，会保留现有资源引用。' : '确认修改后，会同步已识别的 module_assetlist / module_enabled 内部引用。'}</p>
            </div>
            <footer className="dialog-actions">
              <button type="button" className="secondary-button" disabled={namespaceSaving} onClick={() => setNamespaceDialogOpen(false)}><X size={16} />取消</button>
              <button type="button" className="primary-button" disabled={namespaceSaving || !namespaceDraft.trim()} onClick={() => void confirmNamespace()}>{namespaceSaving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}人工确认并同步</button>
            </footer>
          </section>
        </div>
      )}

      {routerPreview && (
        <div className="modal-backdrop router-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !routerApplying) setRouterPreview(null); }}>
          <section className="router-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="router-preview-title">
            <header className="dialog-header">
              <div><h2 id="router-preview-title">路由修复修改对比</h2><span>仅显示检测到的局部修改，确认后才会写入卡片。</span></div>
              <button className="icon-button" title="关闭" aria-label="关闭修改对比" disabled={routerApplying} onClick={() => setRouterPreview(null)}><X size={16} /></button>
            </header>
            <div className="router-preview-body">
              {routerPreview.changes.map((change, index) => (
                <article className="router-change" key={`${change.id}:${change.pathLabel}:${index}`}>
                  <div className="router-change-heading"><div><strong>{change.title}</strong><span className="router-change-index">{index + 1} / {routerPreview.changes.length}</span></div><code>{change.pathLabel}</code></div>
                  <p className="router-change-message">{routerPreview.report.findings.find((finding) => finding.id === change.id && finding.pathLabel === change.pathLabel)?.message ?? '仅替换已识别的路由代码，其他脚本结构保持不变。'}</p>
                  <div className="router-change-summary">
                    <span>修改点：{compactCode(change.before, routerDrafts[routerChangeKey(change, index)] ?? change.after).changedCount} 行 → {compactCode(routerDrafts[routerChangeKey(change, index)] ?? change.after, change.before).changedCount} 行</span>
                    <span>{editingRouterChange === index ? '正在编辑本项' : '建议代码可双击编辑'}</span>
                  </div>
                  {editingRouterChange === index ? (
                    <div className="router-edit-box">
                      <span className="router-edit-label">修改点代码</span>
                      <textarea aria-label={`编辑${change.title}修改点`} value={routerEditValue} onChange={(event) => setRouterEditValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') cancelRouterEdit(); }} spellCheck={false} autoFocus />
                      <div className="router-edit-actions">
                        <button className="secondary-button" onClick={cancelRouterEdit}><X size={14} />取消本项</button>
                        <button className="primary-button" onClick={() => saveRouterEdit(change, index)}><Check size={14} />保存本项</button>
                      </div>
                    </div>
                  ) : (
                    <div className="router-diff-columns">
                      <div className="router-diff-column"><span>原代码 · 局部</span><RouterCodePanel source={change.before} peer={routerDrafts[routerChangeKey(change, index)] ?? change.after} tone="before" /></div>
                      <div className="router-diff-column"><span>建议修改 · 局部</span><RouterCodePanel source={routerDrafts[routerChangeKey(change, index)] ?? change.after} peer={change.before} tone="after" editable onDoubleClick={() => beginRouterEdit(index, routerDrafts[routerChangeKey(change, index)] ?? change.after, change.before)} /></div>
                    </div>
                  )}
                </article>
              ))}
              {!routerPreview.changes.length && <div className="table-empty">预览时未发现仍可修改的路由代码，可能已被其他操作处理。</div>}
            </div>
            <footer className="dialog-actions router-preview-actions">
              <button className="secondary-button" disabled={routerApplying} onClick={() => setRouterPreview(null)}><X size={16} />取消</button>
              <button className="primary-button" disabled={routerApplying || editingRouterChange !== null || !routerPreview.changes.length} onClick={() => void applyRouterPreview()}>{routerApplying ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}人工检查通过，应用修改</button>
            </footer>
          </section>
        </div>
      )}

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

      <div className="lua-detection-grid">
        <section className="lua-panel lua-detection-card lua-script-detection">
          <div className="lua-panel-header"><div><h2>脚本结构检测</h2><span>Lua 代码块、控制引用和语法状态</span></div><Code2 size={17} /></div>
          <div className="lua-detection-result"><strong>{report.hasModule ? '已完成扫描' : '不适用'}</strong><span>{report.hasModule ? `发现 ${report.sourceCount} 个 Lua 代码块、${report.controlReferenceCount} 个控制引用。` : '当前卡片没有 Risu 模块。'}</span></div>
          {syntaxIssues.length > 0 && <div className="lua-detection-alert">发现 {syntaxIssues.length} 条 Lua 语法问题，见下方语法检测。</div>}
          <button type="button" className="secondary-button lua-detection-action" onClick={onScan}><Search size={14} />重新扫描脚本</button>
        </section>

        <section className="lua-panel lua-detection-card lua-syntax-detection">
          <div className="lua-panel-header"><div><h2>Lua 语法检测</h2><span>逐条定位到真实错误代码行</span></div><ShieldCheck size={17} /></div>
          <div className={`lua-detection-result ${syntaxIssues.length ? 'problem' : 'success'}`}><strong>{syntaxIssues.length ? `发现 ${syntaxIssues.length} 条问题` : '语法通过'}</strong><span>{syntaxIssues.length ? '可在下方直接编辑错误行并重新校验。' : '当前没有待修复的 Lua 语法片段。'}</span></div>
          {syntaxIssues.length > 0 && <button type="button" className="secondary-button lua-detection-action" onClick={() => document.getElementById('lua-syntax-detection-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ArrowRight size={14} />查看语法问题</button>}
        </section>

        <section className="lua-panel lua-detection-card lua-control-detection">
          <div className="lua-panel-header"><div><h2>Lua 控制引用检测</h2><span>控制标记、模板和运行时引用</span></div><SlidersHorizontal size={17} /></div>
          <div className={`lua-detection-result ${report.blockerCount ? 'problem' : 'success'}`}><strong>{luaControlReferences.length} 个控制引用</strong><span>{report.blockerCount ? `${report.blockerCount} 个阻断项需要处理。` : '当前没有控制引用阻断。'}</span></div>
          {luaControlReferences.length > 0 && <div className="lua-detection-list">{luaControlReferences.slice(0, 4).map((reference) => <code key={reference.pathLabel}>{reference.pathLabel}</code>)}{luaControlReferences.length > 4 && <span>另有 {luaControlReferences.length - 4} 个</span>}</div>}
        </section>

        <section className="lua-panel lua-detection-card lua-runtime-regex-detection">
          <div className="lua-panel-header"><div><h2>运行时展示正则</h2><span>消息展示阶段执行，独立于静态命中校验</span></div><Code2 size={17} /></div>
          <div className="lua-detection-result success"><strong>{runtimeDisplayReferences.length} 条运行时规则</strong><span>{runtimeDisplayReferences.length ? '只验证规则编译、捕获组和替换模板。' : '当前没有消息展示阶段的正则规则。'}</span></div>
          {runtimeDisplayReferences.length > 0 && <button type="button" className="secondary-button lua-detection-action" onClick={() => document.getElementById('lua-runtime-regex-detection-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ArrowRight size={14} />查看运行时规则</button>}
        </section>

        <section className="lua-panel lua-detection-card lua-portrait-detection">
          <div className="lua-panel-header"><div><h2>专有名词检测</h2><span>立绘匹配名称与目标语言别名</span></div><Search size={17} /></div>
          <div className={`lua-detection-result ${report.portraitMissingCount ? 'problem' : 'success'}`}><strong>{report.portraitCandidateCount} 个候选</strong><span>{report.portraitFeatureDetected ? `${report.portraitCoveredCount} 个已有别名，${report.portraitMissingCount} 个待补。` : '未检测到立绘匹配功能。'}</span></div>
          {report.portraitFeatureDetected && <button type="button" className="secondary-button lua-detection-action" onClick={() => document.getElementById('lua-portrait-detection-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}><ArrowRight size={14} />查看名称候选</button>}
        </section>

        <section className="lua-panel lua-detection-card lua-router-detection">
          <div className="lua-panel-header"><div><h2>图片路由检测</h2><span>只检查已识别的路由阻断模式</span></div><Wrench size={17} /></div>
          <div className={`lua-detection-result ${report.routerRepair.canApply ? 'problem' : 'success'}`}><strong>{report.routerRepair.canApply ? `发现 ${report.routerRepair.findings.length} 个问题` : '路由检查通过'}</strong><span>{report.routerRepair.canApply ? '仅显示可精确预览的局部修改。' : '当前没有匹配到已知路由阻断模式。'}</span></div>
          {report.routerRepair.canApply && <button type="button" className="secondary-button lua-detection-action" onClick={() => void openRouterPreview()} disabled={loading || routerPreviewLoading}><Wrench size={14} />查看修改对比</button>}
        </section>

        <section className="lua-panel lua-detection-card lua-export-detection">
          <div className="lua-panel-header"><div><h2>导出完整性检测</h2><span>导出前执行最终保护校验</span></div><FileCheck2 size={17} /></div>
          <div className={`lua-detection-result ${report.blockerCount ? 'problem' : 'success'}`}><strong>{report.blockerCount ? `${report.blockerCount} 个阻断` : '可以导出'}</strong><span>{report.warningCount ? `${report.warningCount} 条提醒会随导出回验。` : '没有待处理提醒。'}</span></div>
          <button type="button" className="primary-button lua-detection-action" onClick={onOpenExport}><FileCheck2 size={14} />{report.blockerCount ? '保存并重新校验' : '保存并导出'}</button>
        </section>
      </div>

      <div className="lua-detail-grid">
        <section className="lua-panel lua-segment-panel" id="lua-portrait-detection-detail">
          <div className="lua-panel-header">
            <div><h2>专有名词匹配候选</h2><span>点击候选只展开详情，不会离开本页</span></div>
          </div>
          <div className="lua-filter-bar">
            <div className="search-input"><Search size={14} /><input aria-label="搜索专有名词候选" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="人名、地名或 ownerId" /></div>
            <span className="result-count">{filteredCandidates.length} 个</span>
          </div>
          <div className="lua-segment-table">
            <div className="lua-segment-head lua-candidate-head"><span>ownerId</span><span>名称 / 别名</span><span>状态</span><span /></div>
            {filteredCandidates.map((candidate) => {
              const selected = selectedOwnerId === candidate.ownerId;
              return (
                <div className={`lua-candidate-wrap ${selected ? 'selected' : ''}`} key={candidate.ownerId}>
                  <button className="lua-segment-row lua-candidate-row" onClick={() => setSelectedOwnerId(selected ? null : candidate.ownerId)} aria-expanded={selected}>
                    <span title={candidate.ownerId}>{candidate.ownerId}</span>
                     <span title={(candidate.targetAliases?.length ? candidate.targetAliases : candidate.names).join('、')}>{(candidate.targetAliases?.length ? candidate.targetAliases : candidate.names).join('、') || '待从卡片译文生成'}</span>
                    <span className={`lua-review-status ${candidate.status === 'covered' ? 'approved' : ''}`}>{candidate.status === 'covered' ? '已覆盖' : '待补别名'}</span>
                    <ArrowRight size={14} />
                  </button>
                  {selected && (
                    <div className="lua-segment-detail">
                       <div><strong>原有名称</strong><span>{candidate.names.join('、') || '无'}</span></div>
                       <div><strong>目标语言别名</strong><span>{candidate.targetAliases?.join('、') || '尚未生成'}</span></div>
                      <div className="lua-alias-merge"><strong>合并到匹配目录</strong><button className="primary-button" disabled={!candidate.targetAliases?.length || candidate.status === 'covered'} onClick={() => void onSaveAliases(candidate.ownerId, candidate.targetAliases ?? [])}><Check size={14} />{candidate.status === 'covered' ? '已合并' : '一次合并保存'}</button></div>
                       <div><strong>缺少的匹配别名</strong><span>{candidate.missingAliases.join('、') || '无'}</span></div>
                      {candidate.pathLabels.length > 0 && <div><strong>运行时位置</strong><code>{candidate.pathLabels.join('、')}</code></div>}
                       <div className="lua-segment-detail-actions">
                         <span>{candidate.status === 'covered' ? '名称目录已覆盖，可参与立绘匹配。' : '目标语言别名会作为一个集合一次写入目录，供后续匹配使用。'}</span>
                       </div>
                    </div>
                  )}
                </div>
              );
            })}
            {!filteredCandidates.length && <div className="table-empty">{report.portraitFeatureDetected ? '未发现可安全判定的专有名词候选' : '未检测到立绘匹配功能，不处理普通 Lua 文本'}</div>}
          </div>
        </section>

        <section className="lua-panel lua-runtime-regex-panel" id="lua-runtime-regex-detection-detail">
          <div className="lua-panel-header"><div><h2>运行时展示正则详情</h2><span>消息展示时执行；不以静态卡片命中数作为通过条件</span></div><Code2 size={17} /></div>
          <div className="lua-runtime-regex-list">
            {runtimeDisplayReferences.map((reference) => (
              <button type="button" className="lua-runtime-regex-row" key={reference.pathLabel} onClick={() => openRegexEditor(reference)}>
                <code>{reference.pathLabel}</code><span>{reference.fullPattern || reference.pattern}</span><em>运行时编译校验</em><ArrowRight size={14} />
              </button>
            ))}
            {!runtimeDisplayReferences.length && <div className="lua-simple-empty">没有消息展示阶段的正则规则。</div>}
          </div>
        </section>

        <section className="lua-panel lua-export-issues-panel">
          <div className="lua-panel-header"><div><h2>导出校验问题</h2><span>按检测类型归类；阻断项必须在导出前处理</span></div><AlertTriangle size={17} /></div>
          <div className="lua-issue-list">
            {report.issues.filter((issue) => issue.kind !== 'syntax').map((issue, index) => {
              const reference = issue.kind === 'control'
                ? report.controlReferences.find((item) => item.pathLabel === issue.pathLabel)
                : null;
              return <div className={`lua-issue ${issue.blocking ? 'blocking' : ''}`} key={`${issue.kind}:${issue.pathLabel}:${index}`}>
                <CircleAlert size={14} />
                <div className="lua-issue-content">
                  <strong>{ISSUE_LABELS[issue.kind]} · {issue.pathLabel}</strong>
                  <span>{issue.message}</span>
                  {reference?.kind === 'regex' && <button type="button" className="secondary-button lua-issue-open-rule" onClick={() => openRegexEditor(reference)}><Code2 size={14} />打开规则</button>}
                </div>
              </div>;
            })}
            {!report.issues.some((issue) => issue.kind !== 'syntax') && <p className="lua-empty-copy">当前没有其他导出校验问题。</p>}
          </div>
        </section>
      </div>

      <section className="lua-panel lua-syntax-detail" id="lua-syntax-detection-detail">
        <div className="lua-panel-header"><div><h2>Lua 语法问题</h2><span>每个错误显示真实 Lua 片段；前后 2 行用于判断上下文，红色行可直接编辑。</span></div><Code2 size={17} /></div>
        {syntaxIssues.length > 0 ? <div className="lua-snippet-list">
          {syntaxIssues.map((issue, index) => {
            const reportIssueIndex = report.issues.findIndex((item) => item.kind === 'syntax' && item.pathLabel === issue.pathLabel && item.line === issue.line);
            const issueKey = `${issue.kind}:${issue.pathLabel}:${reportIssueIndex >= 0 ? reportIssueIndex : index}`;
            const expandedContext = syntaxContextExpanded[issueKey] === true;
            const contextLines = issue.contextLines ?? [];
            const visibleContextLines = expandedContext || !issue.line
              ? contextLines
              : contextLines.filter((contextLine) => Math.abs(contextLine.line - issue.line!) <= 2);
            const canExpandContext = visibleContextLines.length < contextLines.length;
            const errorContextLine = contextLines.find((contextLine) => contextLine.errorLine);
            const currentErrorLine = syntaxLineDrafts[issueKey] ?? errorContextLine?.draftLine ?? issue.draftLine ?? '';
            return <article className="lua-snippet-card" id={`lua-syntax-snippet-${index}`} data-lua-issue-key={issueKey} key={issueKey}>
              <div className="lua-editor-meta"><strong>{issue.pathLabel}</strong><span>{issue.line ? `第 ${issue.line} 行，第 ${issue.column ?? '?'} 列` : 'Lua 语法错误'}</span></div>
              <div className="lua-snippet-help">当前 Lua 代码片段</div>
              {errorContextLine && <div className="lua-snippet-comparison">
                <div><span>原始文本</span><code>{errorContextLine.sourceLine || '（空行）'}</code></div>
                <div><span>当前文本</span><code>{currentErrorLine || '（空行）'}</code></div>
              </div>}
              {contextLines.length ? <div className="lua-code-editor lua-snippet-code-editor">
                {visibleContextLines.map((contextLine) => <div className={`lua-code-line${contextLine.errorLine ? ' error-line' : ''}`} key={contextLine.line}>
                  <span className="lua-code-line-number">{contextLine.line}</span>
                  {contextLine.errorLine
                    ? <div className="lua-code-line-edit"><textarea
                      value={syntaxLineDrafts[issueKey] ?? contextLine.draftLine ?? ''}
                      onChange={(event) => setSyntaxLineDrafts((drafts) => ({ ...drafts, [issueKey]: event.target.value }))}
                      rows={2}
                      spellCheck={false}
                      aria-label={`编辑 Lua 第 ${contextLine.line} 行`}
                    />{issue.column ? <small className="lua-code-column-marker">解析器错误列：{issue.column}</small> : null}{contextLine.sourceLine !== contextLine.draftLine ? <small className="lua-code-baseline">原始代码：<code>{contextLine.sourceLine || '（空行）'}</code></small> : null}</div>
                    : <code className="lua-code-line-text">{contextLine.draftLine || ' '}</code>}
                </div>)}
              </div> : <textarea
                className="lua-snippet-single-editor"
                value={syntaxLineDrafts[issueKey] ?? issue.draftLine ?? ''}
                onChange={(event) => setSyntaxLineDrafts((drafts) => ({ ...drafts, [issueKey]: event.target.value }))}
                rows={3}
                spellCheck={false}
                aria-label={`编辑 Lua 第 ${issue.line ?? '?'} 行`}
              />}
              {expandedContext ? <button type="button" className="secondary-button lua-context-expand" onClick={() => setSyntaxContextExpanded((current) => ({ ...current, [issueKey]: false }))}><Minus size={14} />收起附近代码</button> : canExpandContext ? <button type="button" className="secondary-button lua-context-expand" onClick={() => setSyntaxContextExpanded((current) => ({ ...current, [issueKey]: true }))} title="查看错误行附近更多原始 Lua 代码"><Plus size={14} />展开附近更多行</button> : null}
              <div className="lua-syntax-actions">
                <button type="button" className="primary-button" disabled={loading || !issue.pathJson || !issue.line || savingSyntaxKey === issueKey} onClick={() => void saveSyntaxLine(issue, issueKey)}>
                  {savingSyntaxKey === issueKey ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}
                  保存错误行并重新校验
                </button>
                {syntaxSaveMessage && savingSyntaxKey !== issueKey && <span className="lua-inline-save-message">{syntaxSaveMessage}</span>}
              </div>
            </article>;
          })}
        </div> : <div className="lua-simple-empty">当前没有待修复的 Lua 语法片段。</div>}
      </section>

      <div className="lua-maintenance-row">
        <button className="danger-button" onClick={() => void onResetLuaDraft()} disabled={loading || !report.hasModule} title="仅恢复 Lua 模块草稿，不影响卡片正文和翻译结果"><RotateCcw size={16} />恢复原始 Lua 草稿</button>
      </div>

      <div className="lua-footnote"><Code2 size={15} /><span>脚本管理页只处理脚本、正则和别名；可翻译文本统一在审核页修改，语法错误只在上方按真实代码行修复。</span></div>
    </section>
  );
}
