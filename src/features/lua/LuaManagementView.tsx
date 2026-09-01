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
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LuaManagementReport, LuaManagementStepStatus, PortraitRouterRepairChange, PortraitRouterRepairPreview, RegexCoveragePreview, RegexCoverageRule, RegexCoverageRuleResult, RegexCoverageRuleStatus, RegexRuleSaveResult, RegexRuleTestResult, ReviewFocus } from '../../types';

const STATUS_LABELS: Record<LuaManagementStepStatus, string> = {
  complete: '已完成',
  'needs-review': '待处理',
  blocked: '已阻断',
  'not-applicable': '不适用',
};

const ISSUE_LABELS = {
  syntax: 'Lua 语法',
  template: '模板结构',
  runtime: '运行时提醒',
  control: '控制引用',
  portrait: '立绘别名',
  router: '路由修复',
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
  onPreviewError,
  onSaveLuaSyntaxLine,
  onOpenExport,
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
  onPreviewError: (error: unknown) => void;
  onSaveLuaSyntaxLine: (pathJson: string, line: number, replacement: string, expectedLine?: string) => Promise<{ syntaxOk: boolean; remainingSyntaxIssues?: unknown[] }>;
  onOpenExport: () => void;
  onSaveAliases: (ownerId: string, aliases: string[]) => Promise<void>;
  onPreviewRegexCoverage: () => Promise<RegexCoveragePreview>;
  onAnalyzeRegexRule: (pathLabel: string, signal?: AbortSignal, pattern?: string) => Promise<RegexCoverageRuleResult>;
  onTestRegexRule: (pathLabel: string, pattern: string) => Promise<RegexRuleTestResult>;
  onSaveRegexRule: (pathLabel: string, pattern: string, expectedPattern: string, forcePass: boolean) => Promise<RegexRuleSaveResult>;
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
  const [selectedReferenceKey, setSelectedReferenceKey] = useState<string | null>(null);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [onlyProblemReferences, setOnlyProblemReferences] = useState(true);
  const [referencePage, setReferencePage] = useState(1);
  const [expandedIssueKey, setExpandedIssueKey] = useState<string | null>(null);
  const [syntaxContextExpanded, setSyntaxContextExpanded] = useState<Record<string, boolean>>({});
  const [luaEditorOpen, setLuaEditorOpen] = useState(true);
  const [regexEditor, setRegexEditor] = useState<{
    pathLabel: string;
    originalPattern: string;
    currentPattern: string;
    sourceMatchCount: number;
    draftMatchCount: number;
    sourceSamples: string[];
    draftSamples: string[];
    forcePassed: boolean;
  } | null>(null);
  const [regexEditorPattern, setRegexEditorPattern] = useState('');
  const [regexEditorForcePass, setRegexEditorForcePass] = useState(false);
  const [regexEditorTest, setRegexEditorTest] = useState<RegexRuleTestResult | null>(null);
  const [regexEditorCandidateNotice, setRegexEditorCandidateNotice] = useState<string | null>(null);
  const [regexEditorTesting, setRegexEditorTesting] = useState(false);
  const [regexEditorSaving, setRegexEditorSaving] = useState(false);
  const [regexEditorAnalyzing, setRegexEditorAnalyzing] = useState(false);
  const regexEditorAbortRef = useRef<AbortController | null>(null);
  const regexConcurrencyLimit = Math.min(8, Math.max(1, Math.floor(Number(regexConcurrency) || 1)));
  const regexRunning = regexCurrentPaths.length > 0 || regexQueuedPaths.length > 0;
  const regexReferenceCount = useMemo(() => report?.controlReferences.filter((reference) => reference.kind === 'regex').length ?? 0, [report]);

  const filteredCandidates = useMemo(() => {
    if (!report) return [];
    const normalized = query.trim().toLocaleLowerCase();
    return report.portraitCandidates.filter((candidate) => (
      !normalized || [candidate.ownerId, ...candidate.names, ...candidate.missingAliases]
        .some((value) => value.toLocaleLowerCase().includes(normalized))
    ));
  }, [query, report]);

  const syntaxIssues = useMemo(() => report?.issues.filter((issue) => issue.kind === 'syntax') ?? [], [report]);
  const allMatchingReferences = useMemo(() => {
    const query = referenceQuery.trim().toLocaleLowerCase();
    const filtered = report?.controlReferences.filter((reference) => !query || `${reference.pathLabel}\n${reference.literal}\n${reference.fullPattern || ''}`.toLocaleLowerCase().includes(query)) ?? [];
    const prioritized = [...filtered].sort((left, right) => {
      const leftMismatch = left.kind === 'regex' && !left.dynamicDisplay && left.originalMatches !== left.draftMatches ? 1 : 0;
      const rightMismatch = right.kind === 'regex' && !right.dynamicDisplay && right.originalMatches !== right.draftMatches ? 1 : 0;
      if (leftMismatch !== rightMismatch) return rightMismatch - leftMismatch;
      const leftRegex = left.kind === 'regex' ? 1 : 0;
      const rightRegex = right.kind === 'regex' ? 1 : 0;
      return rightRegex - leftRegex || left.pathLabel.localeCompare(right.pathLabel);
    });
    return prioritized;
  }, [referenceQuery, report]);
  const blockingReferencePaths = useMemo(() => new Set(
    report?.issues.filter((issue) => issue.blocking && issue.kind === 'control').map((issue) => issue.pathLabel) ?? [],
  ), [report]);
  const matchingReferences = useMemo(() => (
    onlyProblemReferences
      ? allMatchingReferences.filter((reference) => blockingReferencePaths.has(reference.pathLabel))
      : allMatchingReferences
  ), [allMatchingReferences, blockingReferencePaths, onlyProblemReferences]);
  const referencePageSize = 30;
  const referencePageCount = Math.max(1, Math.ceil(matchingReferences.length / referencePageSize));
  const visibleReferences = useMemo(
    () => matchingReferences.slice((referencePage - 1) * referencePageSize, referencePage * referencePageSize),
    [matchingReferences, referencePage],
  );
  useEffect(() => { setReferencePage(1); }, [referenceQuery, onlyProblemReferences, report?.generatedAt]);
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
  useEffect(() => { if (referencePage > referencePageCount) setReferencePage(referencePageCount); }, [referencePage, referencePageCount]);
  useEffect(() => { setLuaEditorOpen(syntaxIssues.length > 0); }, [report?.generatedAt, syntaxIssues.length]);
  useEffect(() => {
    const firstBlocking = report?.issues.find((issue) => issue.kind === 'syntax' && issue.blocking)
      ?? report?.issues.find((issue) => issue.blocking);
    if (!firstBlocking || !report) { setExpandedIssueKey(null); return; }
    const index = report.issues.indexOf(firstBlocking);
    setExpandedIssueKey(`${firstBlocking.kind}:${firstBlocking.pathLabel}:${index}`);
  }, [report?.generatedAt]);

  function focusSyntaxEditor(targetIssue?: LuaManagementReport['issues'][number], targetIssueIndex?: number): void {
    if (!report) return;
    const focusPath = targetIssue?.pathLabel ?? reviewFocus?.pathLabel;
    const focusLine = targetIssue?.line ?? reviewFocus?.line;
    if (!focusPath) return;
    const issueIndex = targetIssueIndex ?? report.issues.findIndex((issue) => issue.kind === 'syntax'
      && issue.pathLabel === focusPath
      && (!focusLine || issue.line === focusLine));
    const syntaxIndex = syntaxIssues.findIndex((issue) => issue.kind === 'syntax'
      && issue.pathLabel === focusPath
      && (!focusLine || issue.line === focusLine));
    if (issueIndex < 0 || syntaxIndex < 0) {
      setLuaEditorOpen(true);
      return;
    }
    const issueKey = `syntax:${focusPath}:${issueIndex}`;
    setLuaEditorOpen(true);
    setExpandedIssueKey(issueKey);
    window.setTimeout(() => {
      const element = document.getElementById(`lua-syntax-snippet-${syntaxIndex}`);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      element?.querySelector('textarea')?.focus();
    }, 0);
  }

  useEffect(() => {
    if (!reviewFocus || !report) return;
    const index = report.issues.findIndex((issue) => issue.kind === 'syntax'
      && issue.pathLabel === reviewFocus.pathLabel
      && (!reviewFocus.line || issue.line === reviewFocus.line));
    const syntaxIndex = syntaxIssues.findIndex((issue) => issue.kind === 'syntax'
      && issue.pathLabel === reviewFocus.pathLabel
      && (!reviewFocus.line || issue.line === reviewFocus.line));
    if (index < 0 || syntaxIndex < 0) return;
    setLuaEditorOpen(true);
    setExpandedIssueKey(`syntax:${reviewFocus.pathLabel}:${index}`);
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
        ? '已保存人工修改，当前 Lua 语法校验通过。'
        : `已保存人工修改，但仍有 ${result.remainingSyntaxIssues?.length ?? 1} 条 Lua 语法错误，请继续检查。`);
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
    });
    setRegexEditorPattern(currentPattern);
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
      const result = await onSaveRegexRule(regexEditor.pathLabel, regexEditorPattern, regexEditor.currentPattern, regexEditorForcePass);
      setRegexEditor((current) => current ? {
        ...current,
        currentPattern: result.pattern,
        sourceMatchCount: result.sourceMatchCount,
        draftMatchCount: result.draftMatchCount,
        sourceSamples: result.sourceSamples,
        draftSamples: result.draftSamples,
        forcePassed: result.forcePassed,
      } : current);
      setRegexEditorPattern(result.pattern);
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
      const passed = result.compiled && (result.dynamicDisplay || result.sourceMatchCount === result.draftMatchCount);
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
          message: passed && result.dynamicDisplay
            ? '动态展示规则已通过编译；静态卡片命中仅作样本参考。'
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
    return <section className="lua-management-section"><div className="table-empty">正在读取立绘匹配诊断…</div></section>;
  }
  if (!report) {
    return <section className="lua-management-section"><div className="table-empty">暂时无法读取立绘匹配诊断，请重试。</div></section>;
  }

  return (
    <section className="lua-management-section">
      <header className="lua-management-header">
        <div>
          <span className="section-kicker">RisuAI / Lua</span>
          <h1>Lua 脚本管理</h1>
          <p>在这里检查 Lua 语法、模板结构、控制引用和名称别名，并直接修正可见文本。审核页只接收本页保存后的结果。</p>
        </div>
        <div className="lua-management-actions">
          <button className="primary-button" onClick={() => void openRegexPreview()} disabled={loading || regexPreviewLoading || regexRunning}>
            {regexPreviewLoading ? <RefreshCw className="spin" size={16} /> : <ShieldCheck size={16} />}全量分析正则
          </button>
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw className={loading ? 'spin' : ''} size={16} />刷新诊断
          </button>
          <button className="secondary-button" onClick={onScan}><Search size={16} />重新扫描 Lua</button>
        </div>
      </header>

      <div className={`lua-feature-check ${report.portraitFeatureDetected ? 'detected' : 'not-detected'}`}>
        <div className="lua-onboarding-title"><SlidersHorizontal size={17} /><strong>{report.portraitFeatureDetected ? '已检测到立绘匹配功能' : '未检测到立绘匹配功能'}</strong></div>
        <p>{report.portraitFeatureDetected
          ? '已检测到立绘匹配功能。名称别名、正则并列项和脚本可见文本都在本页处理，保存后由公共写入层同步到审核文本。'
          : '当前模块没有同时出现图片输出和角色名称目录信号，因此不会自动翻译或匹配普通 Lua 文本。'}
        </p>
        {report.portraitFeatureSignals.length > 0 && <div className="lua-feature-signals">{report.portraitFeatureSignals.map((signal) => <span key={signal}>{signal}</span>)}</div>}
        <div className="lua-onboarding-actions">
          <button className="link-button" onClick={onScan}>重新检测 <ArrowRight size={13} /></button>
        </div>
      </div>

      {reviewFocus && <div className="lua-focus-alert" role="status">
        <div><strong>已过滤保存校验错误行</strong><span>{reviewFocus.pathLabel}{reviewFocus.originalMatches != null && reviewFocus.draftMatches != null ? ` · 匹配数 ${reviewFocus.originalMatches} → ${reviewFocus.draftMatches}` : ''}{reviewFocus.line ? ` · 第 ${reviewFocus.line} 行，第 ${reviewFocus.column ?? '?'} 列` : ''}</span><p>{reviewFocus.problem}</p>{reviewFocus.sourceLine && <code className="lua-focus-code-line">原始代码：{reviewFocus.sourceLine}</code>}{reviewFocus.draftLine && <code className="lua-focus-code-line current">当前稿：{reviewFocus.draftLine}</code>}<p><b>修正方案：</b>{reviewFocus.fixSuggestion}</p>{reviewFocus.line && <button type="button" className="secondary-button lua-locate-button" onClick={() => focusSyntaxEditor()}><Code2 size={14} />定位到 Lua 编辑器</button>}</div>
        <button className="icon-button" title="关闭错误提示" aria-label="关闭错误提示" onClick={onClearReviewFocus}><X size={15} /></button>
      </div>}

      {regexEditor && (
        <div className="modal-backdrop regex-editor-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !regexEditorSaving && !regexEditorAnalyzing) setRegexEditor(null); }}>
          <section className="regex-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="regex-editor-title">
            <header className="dialog-header">
              <div><h2 id="regex-editor-title">人工编辑正则</h2><span>{regexEditor.pathLabel} · 仅保存到 Lua 草稿，导出前仍会执行完整校验。</span></div>
              <button className="icon-button" title="关闭" aria-label="关闭正则编辑" disabled={regexEditorSaving || regexEditorAnalyzing} onClick={() => setRegexEditor(null)}><X size={16} /></button>
            </header>
            <div className="regex-editor-body">
              <div className="regex-editor-baseline">
                <div><span>原始规则</span><code>{regexEditor.originalPattern}</code></div>
                <div><span>已保存草稿</span><code>{regexEditor.currentPattern}</code></div>
                <div><span>基线命中</span><strong>原文 {regexEditor.sourceMatchCount} · 当前稿 {regexEditor.draftMatchCount}</strong></div>
              </div>
              <div className="regex-coverage-rule-samples regex-editor-examples">
                <div><span>原文命中示例</span><MatchExampleList samples={regexEditor.sourceSamples} /></div>
                <div><span>当前稿命中示例</span><MatchExampleList samples={regexEditor.draftSamples} /></div>
              </div>
              <label className="regex-editor-input">
                <span>待测试规则</span>
                <textarea value={regexEditorPattern} disabled={regexEditorAnalyzing} onChange={(event) => { setRegexEditorPattern(event.target.value); setRegexEditorTest(null); setRegexEditorCandidateNotice(null); }} rows={6} spellCheck={false} aria-label={`编辑 ${regexEditor.pathLabel} 正则`} />
              </label>
              {regexEditorCandidateNotice && <div className="regex-editor-candidate-notice" role="status"><Check size={14} />{regexEditorCandidateNotice}</div>}
              <label className="regex-editor-force-pass">
                <input type="checkbox" checked={regexEditorForcePass} disabled={regexEditorAnalyzing} onChange={(event) => setRegexEditorForcePass(event.target.checked)} />
                <span><strong>强制通过本条命中校验</strong><small>放弃这条规则的原文/当前稿命中数一致性检测；只对当前规则文本和当前命中数生效，其他结构校验仍保留。</small></span>
              </label>
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
              <button className="secondary-button" disabled={regexEditorAnalyzing || regexEditorTesting || regexEditorSaving || !regexEditorPattern.trim()} onClick={() => void analyzeManualRegex()}>{regexEditorAnalyzing ? <RefreshCw className="spin" size={16} /> : <Search size={16} />}大模型修正</button>
              <button className="secondary-button" disabled={regexEditorAnalyzing || regexEditorTesting || regexEditorSaving || !regexEditorPattern.trim()} onClick={() => void testManualRegex()}>{regexEditorTesting ? <RefreshCw className="spin" size={16} /> : <Play size={16} />}测试匹配</button>
              <button className={`primary-button${regexEditorForcePass ? ' danger-button' : ''}`} disabled={regexEditorAnalyzing || regexEditorTesting || regexEditorSaving || !regexEditorPattern.trim()} onClick={() => void saveManualRegex()}>{regexEditorSaving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{regexEditorForcePass ? '强制通过并保存' : '保存规则'}</button>
            </footer>
          </section>
        </div>
      )}

      {report.routerRepair.detected && (
        <div className="lua-router-repair">
          <div>
            <div className="lua-onboarding-title"><Wrench size={17} /><strong>路由修复已就绪</strong></div>
            <p>只会处理已精确识别的阻断模式，不会改动资源索引、按钮、世界书或普通 Lua。</p>
            <ul>
              {report.routerRepair.findings.map((finding) => <li key={`${finding.id}:${finding.pathLabel}`}><strong>{finding.title}</strong><span>{finding.message}</span></li>)}
            </ul>
          </div>
          <button className="primary-button" onClick={() => void openRouterPreview()} disabled={!report.routerRepair.canApply || loading || routerPreviewLoading}>
            {routerPreviewLoading ? <RefreshCw className="spin" size={16} /> : <Wrench size={16} />}查看修改对比
          </button>
        </div>
      )}
      {!report.routerRepair.detected && report.hasModule && (
        <div className="lua-router-status">
          <div className="lua-onboarding-title"><ShieldCheck size={17} /><strong>路由修复检查完成</strong></div>
          <p>已检查模块中的 Lua 输出处理器、完成标记门控和 Main 路由提交逻辑，当前没有匹配到已知阻断模式。</p>
        </div>
      )}

      {regexPreview && (
        <div className="modal-backdrop regex-coverage-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !regexRunning) setRegexPreview(null); }}>
          <section className="regex-coverage-dialog" role="dialog" aria-modal="true" aria-labelledby="regex-coverage-title">
            <header className="dialog-header">
            <div><h2 id="regex-coverage-title">正则全量修复确认</h2><span>{regexRunning ? `正在修正 ${regexCurrentPaths.length} 行，排队 ${regexQueuedPaths.length} 行（并发上限 ${regexConcurrencyLimit}）；其他行仍可编辑。` : '每行都可以先人工编辑，再单独点击“大模型修正”；模型处理期间只锁定当前行。'}</span></div>
              <button className="icon-button" title="关闭" aria-label="关闭正则全量修复" disabled={regexRunning} onClick={() => setRegexPreview(null)}><X size={16} /></button>
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
                    <div className="regex-coverage-rule-head"><div><strong>{index + 1}. {rule.pathLabel}</strong><span className={`regex-coverage-rule-status status-${rule.status ?? 'pending'}`}>{regexStatusLabel(rule.status)}</span></div><span>{rule.dynamicDisplay ? '运行时回复规则' : `命中 ${rule.sourceMatchCount} → ${rule.draftMatchCount}`}</span></div>
                    <div className="regex-coverage-rule-compare"><div><span>原始规则</span><code>{rule.originalPattern || rule.pattern}</code></div><div><span>{rule.candidatePattern ? '模型候选（可人工修改）' : '当前规则（可人工修改）'}</span><textarea value={regexCoverageDrafts[rule.pathLabel] ?? rule.pattern} disabled={rule.status === 'queued' || rule.status === 'processing'} onChange={(event) => { const value = event.target.value; setRegexCoverageDrafts((drafts) => ({ ...drafts, [rule.pathLabel]: value })); setRegexCoverageTests((tests) => { const next = { ...tests }; delete next[rule.pathLabel]; return next; }); updateRegexRule(rule.pathLabel, { candidatePattern: value, status: rule.status === 'pending' ? 'pending' : 'returned', validation: undefined, error: undefined }); }} rows={3} spellCheck={false} aria-label={`编辑 ${rule.pathLabel} 候选正则`} /></div></div>
                    {rule.dynamicDisplay ? <div className="regex-coverage-context">此规则用于运行时模型回复展示，不读取或发送卡片素材命中片段。大模型仅依据当前正则、替换模板和目标语言处理中文无空格、引号与标点边界。</div> : <div className="regex-coverage-rule-samples"><div><span>原文命中片段</span><p>{summarizeMatchSamples(rule.sourceSamples?.length ? rule.sourceSamples : rule.sourceMatches)}</p></div><div><span>当前稿命中片段</span><p>{summarizeMatchSamples(rule.draftSamples?.length ? rule.draftSamples : rule.draftMatches)}</p></div></div>}
                    {rule.modelContext && !rule.dynamicDisplay && <div className="regex-coverage-context">发送上下文：扫描记录 {rule.modelContext.totalRecords}（去重 {rule.modelContext.totalUniqueRecords}）→ 采样 {rule.modelContext.selectedRecords} 条；分组命中差异 {rule.modelContext.strata.coverageDifference}、文本变化 {rule.modelContext.strata.textDifference}、稳定 {rule.modelContext.strata.stable}。命中样本 {rule.modelContext.selectedSourceMatches} / {rule.modelContext.selectedDraftMatches}，载荷 {rule.modelContext.contextChars} / {rule.modelContext.budgetChars} 字符{rule.modelContext.truncated ? '，已按预算裁剪' : ''}{rule.modelContext.formatProbe ? `；空白探针 ${rule.modelContext.formatProbe.sourceMatchCount} → ${rule.modelContext.formatProbe.draftMatchCount}（严格基线 ${rule.modelContext.formatProbe.baselineSourceMatchCount} → ${rule.modelContext.formatProbe.baselineDraftMatchCount}），采样 ${rule.modelContext.formatProbe.selectedRecords} / ${rule.modelContext.formatProbe.totalRecords} 条` : ''}。</div>}
                    {rule.status && !['pending', 'queued', 'processing'].includes(rule.status) && <div className="regex-coverage-model-result">模型返回：{regexProposalSummary(rule.proposals)}</div>}
                    {rule.validation && <div className={`regex-coverage-validation ${rule.validation.passed ? 'passed' : 'failed'}`}>{rule.validation.message || (rule.validation.passed ? `校验通过：候选命中 ${rule.validation.draftMatchCount}，满足原文 ${rule.validation.sourceMatchCount}` : '本地校验未通过，未写入。')}</div>}
                    {rule.error && <div className="regex-coverage-validation failed">{rule.error}</div>}
                    <div className="regex-coverage-rule-actions"><button type="button" className="secondary-button" disabled={rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel || !(regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim()} onClick={() => queueRegexCoverageAnalysis(rule)}>{rule.status === 'queued' ? <RefreshCw className="spin" size={14} /> : <Search size={14} />}大模型修正</button>{(rule.status === 'queued' || rule.status === 'processing') && <button type="button" className="secondary-button" onClick={() => cancelRegexCoverageAnalysis(rule)}><X size={14} />取消本行</button>}<button type="button" className="secondary-button" disabled={rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel || !(regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim()} onClick={() => void testRegexCoverageRule(rule)}>{regexCoverageTestingPath === rule.pathLabel ? <RefreshCw className="spin" size={14} /> : <Play size={14} />}测试匹配</button><button type="button" className="primary-button" disabled={rule.status === 'queued' || rule.status === 'processing' || regexCoverageTestingPath === rule.pathLabel || regexCoverageSavingPath === rule.pathLabel || !(regexCoverageDrafts[rule.pathLabel] ?? rule.candidatePattern ?? rule.pattern).trim()} onClick={() => void saveRegexCoverageRule(rule)}>{regexCoverageSavingPath === rule.pathLabel ? <RefreshCw className="spin" size={14} /> : <Check size={14} />}保存这条规则</button></div>
                    {regexCoverageTests[rule.pathLabel] && <div className={`regex-coverage-validation ${regexCoverageTests[rule.pathLabel].compiled ? 'passed' : 'failed'}`}>当前输入测试：命中 {regexCoverageTests[rule.pathLabel].sourceMatchCount} → {regexCoverageTests[rule.pathLabel].draftMatchCount}；{regexCoverageTests[rule.pathLabel].message || '规则可编译。'}</div>}
                  </article>
                ))}
                {!regexPreview.rules.length && <div className="table-empty">当前没有命中数变化的规则，无需全量修复。</div>}
              </div>
            </div>
            <footer className="dialog-actions regex-coverage-actions">
              {regexRunning ? <button className="secondary-button" onClick={cancelAllRegexCoverageAnalysis}><X size={16} />取消全部分析</button> : <button className="secondary-button" onClick={() => setRegexPreview(null)}><X size={16} />关闭</button>}
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

      <div className="lua-kpi-grid">
        <div><span>匹配候选</span><strong>{report.portraitCandidateCount}</strong><small>人名 / 地名 / 称号</small></div>
        <div><span>已有别名</span><strong>{report.portraitCoveredCount}</strong><small>可直接参与匹配</small></div>
        <div className={report.portraitMissingCount ? 'warning' : ''}><span>待补别名</span><strong>{report.portraitMissingCount}</strong><small>导出时自动尝试补齐</small></div>
        <div className={report.blockerCount ? 'danger' : ''}><span>导出阻断</span><strong>{report.blockerCount}</strong><small>{report.warningCount} 条提醒</small></div>
      </div>

      <div className="lua-stepper" aria-label="立绘匹配处理流程">
        {report.steps.map((step, index) => (
          <div className={`lua-step lua-step-${step.status}`} key={step.id}>
            <div className="lua-step-mark">{step.status === 'complete' ? <Check size={14} /> : index + 1}</div>
            <div><strong>{step.title}</strong><span>{STATUS_LABELS[step.status]}</span><p>{step.message}</p></div>
            {index < report.steps.length - 1 && <div className="lua-step-line" aria-hidden="true" />}
          </div>
        ))}
      </div>

      <div className="lua-management-grid">
        <div className="lua-panel lua-segment-panel">
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
        </div>

        <aside className="lua-side-column">
          <div className="lua-panel">
            <div className="lua-panel-header"><div><h2>控制规则校验</h2><span>与导出使用同一份已保存草稿；只列出当前导出阻断引用</span></div><div className="lua-panel-header-actions"><button type="button" className="secondary-button" disabled={!regexReferenceCount} onClick={() => { setOnlyProblemReferences(false); const first = report.controlReferences.find((reference) => reference.kind === 'regex' && reference.originalMatches !== reference.draftMatches && reference.forcePassed !== true) ?? report.controlReferences.find((reference) => reference.kind === 'regex'); if (first) openRegexEditor(first); }}><Code2 size={14} />人工编辑正则</button><ShieldCheck size={17} /></div></div>
            <div className="lua-reference-list">
              <div className="lua-reference-search search-input"><Search size={14} /><input aria-label="搜索控制引用" value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} placeholder="搜索规则或路径，例如 regex.41" /></div>
              <label className="lua-reference-filter"><input type="checkbox" checked={onlyProblemReferences} onChange={(event) => setOnlyProblemReferences(event.target.checked)} />仅看导出阻断 <span>{matchingReferences.length} / {allMatchingReferences.length}</span></label>
              {visibleReferences.map((reference) => {
                const key = `${reference.pathLabel}:${reference.literal}`;
                const selected = selectedReferenceKey === key;
                const forcePassed = reference.kind === 'regex' && reference.forcePassed === true;
                const mismatch = reference.kind === 'regex' && !reference.dynamicDisplay && reference.originalMatches !== reference.draftMatches && !forcePassed;
                return <div className={`lua-reference-wrap${selected ? ' selected' : ''}`} key={key}>
                  <button type="button" className="lua-reference" onClick={() => setSelectedReferenceKey(selected ? null : key)}><code>{reference.literal}</code><span>{reference.kind === 'regex' ? '正则' : 'Lua'} · {reference.pathLabel}</span>{forcePassed ? <span className="lua-reference-status forced">已人工强制通过：{reference.originalMatches} → {reference.draftMatches}</span> : mismatch ? <span className="lua-reference-status problem">命中异常：{reference.originalMatches} → {reference.draftMatches}</span> : reference.dynamicDisplay ? <span className="lua-reference-status ok">动态展示：样本参考</span> : reference.kind === 'regex' ? <span className="lua-reference-status ok">命中已保持</span> : null}{reference.kind === 'regex' && reference.addedAlternatives?.length ? <span className="lua-reference-target">阶段 2 已合并：{reference.addedAlternatives.join('、')}</span> : null}<ArrowRight size={13} /></button>
                  {selected && reference.kind === 'regex' && <div className="lua-reference-detail"><div><strong>目标语言并列项</strong><span>{reference.addedAlternatives?.length ? reference.addedAlternatives.join('、') : '暂无新增'}</span></div><div><strong>当前规则</strong><code>{reference.fullPattern || reference.pattern}</code></div><div><strong>命中数量</strong><span>原文 {reference.originalMatches ?? 0} · 当前稿 {reference.draftMatches ?? 0}{reference.dynamicDisplay ? '（动态展示规则，样本参考）' : ''}</span></div>{reference.dynamicDisplay && <div className="lua-reference-force-note"><strong>运行时校验</strong><span>此规则在消息展示时执行，已改为检查正则编译、捕获组和换行替换模板，不再要求静态卡片命中数量一致。</span></div>}{forcePassed && <div className="lua-reference-force-note"><strong>人工确认</strong><span>已放弃本条规则的命中数量一致性检测；规则文本或当前命中数变化后会重新阻断。</span></div>}<div><strong>原文命中</strong><span>{summarizeMatchSamples(reference.originalSamples)}</span></div><div><strong>当前稿命中</strong><span>{summarizeMatchSamples(reference.draftSamples)}</span></div><div className="lua-reference-editor-action"><span>可先测试未保存规则；保存后会写入 Lua 草稿并立即重新校验。</span><button type="button" className="secondary-button" onClick={() => openRegexEditor(reference)}><Code2 size={14} />人工编辑并测试</button></div></div>}
                </div>;
              })}
              {!report.controlReferences.length && <p className="lua-empty-copy">未发现登记的控制引用。</p>}
              {!!report.controlReferences.length && !matchingReferences.length && <p className="lua-empty-copy">当前没有导出阻断引用；取消“仅看导出阻断”可查看全部引用。</p>}
              {matchingReferences.length > 0 && <div className="lua-pagination"><button className="secondary-button" disabled={referencePage <= 1} onClick={() => setReferencePage((page) => Math.max(1, page - 1))}>上一页</button><span>第 {referencePage} / {referencePageCount} 页 · 共 {matchingReferences.length} 条</span><button className="secondary-button" disabled={referencePage >= referencePageCount} onClick={() => setReferencePage((page) => Math.min(referencePageCount, page + 1))}>下一页</button></div>}
            </div>
          </div>

          <div className="lua-panel">
            <div className="lua-panel-header"><div><h2>问题与提醒</h2><span>阻断项必须在导出前处理</span></div><AlertTriangle size={17} /></div>
            <div className="lua-issue-list">
               {report.issues.map((issue, index) => {
                 const issueKey = `${issue.kind}:${issue.pathLabel}:${index}`;
                 const reference = issue.kind === 'control'
                   ? report.controlReferences.find((item) => item.pathLabel === issue.pathLabel)
                   : null;
                 const expanded = expandedIssueKey === issueKey;
                 return (
                   <div className={`lua-issue ${issue.blocking ? 'blocking' : ''}`} key={issueKey}>
                     <CircleAlert size={14} />
                     <div className="lua-issue-content">
                       <button type="button" className="lua-issue-toggle" onClick={() => setExpandedIssueKey(expanded ? null : issueKey)}>
                         <strong>{ISSUE_LABELS[issue.kind]} · {issue.pathLabel}</strong>
                         <span>{issue.message}</span>
                         <em>{expanded ? '收起详情' : reference ? '查看规则与命中文本' : '展开说明'}</em>
                       </button>
                       <small>{issue.kind === 'syntax'
                         ? '已按解析器位置定位到原始 Lua 代码与当前稿错误行。'
                         : issue.segmentIds.length
                           ? `已关联 ${issue.segmentIds.length} 条原始 Lua 代码定位。`
                           : '无法精确定位原始 Lua 代码行。'}</small>
                       {expanded && (
                         <div className="lua-issue-detail">
                           {issue.kind === 'syntax' && <>
                             <div><strong>错误位置</strong><span>{issue.line ? `第 ${issue.line} 行，第 ${issue.column ?? '?'} 列` : '解析器未返回行列'}</span></div>
                             <div className="lua-issue-compare">
                               <div><strong>原始代码</strong><code>{issue.sourceLine || '（未提供）'}</code></div>
                               <div><strong>当前代码</strong><code>{issue.draftLine || '（未提供）'}</code></div>
                             </div>
                             <div className="lua-issue-actions">
                               <button type="button" className="secondary-button" onClick={() => focusSyntaxEditor(issue, index)}><Code2 size={14} />在片段编辑器中查看</button>
                             </div>
                           </>}
                           {reference?.kind === 'regex' && <>
                             <div><strong>目标语言并列项</strong><span>{reference.addedAlternatives?.length ? reference.addedAlternatives.join('、') : '暂无新增'}</span></div>
                             <div><strong>当前规则</strong><code>{reference.fullPattern || reference.pattern}</code></div>
                             <div><strong>命中数量</strong><span>原文 {reference.originalMatches ?? 0} · 当前稿 {reference.draftMatches ?? 0}</span></div>
                             <div><strong>原文命中片段</strong><span>{summarizeMatchSamples(reference.originalSamples)}</span></div>
                             <div><strong>当前稿命中片段</strong><span>{summarizeMatchSamples(reference.draftSamples)}</span></div>
                           </>}
                         </div>
                       )}
                     </div>
                   </div>
                 );
               })}
              {!report.issues.length && <p className="lua-empty-copy">当前没有发现问题，可以继续导出。</p>}
            </div>
            <button className="primary-button lua-export-button" onClick={onOpenExport}><FileCheck2 size={16} />{report.blockerCount ? '保存并重新校验' : '保存并导出'}</button>
          </div>
        </aside>
      </div>

      <details className="lua-editor-panel lua-fallback-editor" open={luaEditorOpen} onToggle={(event) => setLuaEditorOpen(event.currentTarget.open)}>
        <summary>Lua 片段编辑器</summary>
        <div className="lua-panel-header"><div><h2>Lua 片段编辑器</h2><span>每个语法错误都显示真实 Lua 片段；前后 2 行用于判断上下文，红色行是可编辑的错误行。</span></div><Code2 size={17} /></div>
        <div className="lua-snippet-list">
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
          {!syntaxIssues.length && <div className="table-empty">当前没有待修复的 Lua 语法片段。</div>}
        </div>
      </details>

      <div className="lua-footnote"><Code2 size={15} /><span>Lua 管理页只处理脚本、正则和别名；可翻译文本统一在审核页修改，语法错误只在上方按真实代码行修复。</span></div>
    </section>
  );
}
