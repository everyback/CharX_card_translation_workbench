import type { AsyncDatabase } from '../async-db.js';
import {
  controlReferencesInText,
  localTranslationControlFragments,
  missingLiteralFragments,
  missingProtectedFragments,
  protectText,
  unchangedCodeSpanFragments,
  unchangedFilePathFragments,
  type RisuControlReference,
} from '../domain/card.js';
import { isRisuModuleLorebookMirrorPath } from '../domain/charx.js';
import { languageBehaviorDirectiveIssue } from '../domain/language-directives.js';
import { protocolFieldReplacementIssue } from '../domain/protocol.js';
import { residualLanguageIssue } from '../domain/translation-errors.js';
import {
  hasLanguageBehaviorConfirmation,
  hasProtectionConfirmation,
  isReviewProblemQaFlag,
  LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG,
  parsePathJson,
  protectionConfirmationFlag,
  PROTECTION_CONFIRMATION_FLAG_PREFIX,
  reviewProblemQaFamily,
  safeArray,
} from './review-metadata.js';

export interface PublicLanguageSettings {
  sourceLanguage: string;
  fallbackLanguage: string;
  targetLanguage: string;
}

export interface ReviewServiceDependencies {
  database: AsyncDatabase;
  clock: () => string;
  publicSettings: () => PublicLanguageSettings;
  controlReferencesForProject(projectId: string): Promise<RisuControlReference[]>;
  resolveFailedJobItems(segmentId: string, pathLabel: string): Promise<void>;
}

export interface MissingProtectionDetail {
  value: string;
  count: number;
  kind: string;
  referencePaths: string[];
}

export interface BulkApprovalResult {
  approved: number;
  skipped: number;
  languageConfirmationRequired?: Array<{ id: string; pathLabel: string; issue: string }>;
  protectionConfirmationRequired?: Array<{
    id: string;
    pathLabel: string;
    missingCount: number;
    missingFragments: MissingProtectionDetail[];
  }>;
}

export interface ApprovedProtectionIssue {
  pathLabel: string;
  missingCount: number;
  reason?: string;
  details?: MissingProtectionDetail[];
}

export function protectedTranslationFragments(
  sourceText: string,
  references: readonly RisuControlReference[],
  path: readonly (string | number)[],
  kind: string,
): string[] {
  return [...new Set([
    ...controlReferencesInText(sourceText, references, path, kind).map((reference) => reference.literal),
    ...localTranslationControlFragments(sourceText),
  ])];
}

export function describeMissingProtectedFragments(
  fragments: readonly string[],
  references: readonly RisuControlReference[],
): MissingProtectionDetail[] {
  const counts = new Map<string, number>();
  for (const fragment of fragments) counts.set(fragment, (counts.get(fragment) ?? 0) + 1);
  return [...counts.entries()].map(([fragment, count]) => {
    const linked = references.filter((reference) => reference.literal === fragment);
    const kind = linked.length
      ? `脚本引用（${linked[0].kind === 'lua' ? 'Lua' : '正则'}）`
      : /^__CTW_KEEP_\d+__$/u.test(fragment)
        ? '结构占位符'
        : '受保护值';
    const value = fragment.length > 180
      ? `${fragment.slice(0, 180).replace(/\s+/gu, ' ')}…`
      : fragment.replace(/\r?\n/gu, '↵');
    return {
      value,
      count,
      kind,
      referencePaths: [...new Set(linked.map((reference) => reference.pathLabel))].slice(0, 3),
    };
  });
}

export function formatMissingProtectionDetails(details: readonly MissingProtectionDetail[]): string {
  const shown = details.slice(0, 8).map((item) => (
    `${item.kind}“${item.value}”${item.count > 1 ? ` ×${item.count}` : ''}${item.referencePaths.length ? `（引用：${item.referencePaths.join('、')}）` : ''}`
  ));
  const omitted = details.length - shown.length;
  return `${shown.join('；')}${omitted > 0 ? `；另有 ${omitted} 项未展开` : ''}`;
}

export function createReviewService({
  database,
  clock,
  publicSettings,
  controlReferencesForProject,
  resolveFailedJobItems,
}: ReviewServiceDependencies) {
  async function appendSegmentQaFlag(segmentId: string, qaFlag: string): Promise<void> {
    const row = await database.prepare('SELECT qa_flags AS qaFlags FROM segments WHERE id = ?')
      .get(segmentId) as { qaFlags?: unknown } | undefined;
    if (!row) return;
    const family = reviewProblemQaFamily(qaFlag);
    const flags = safeArray(row.qaFlags).map(String)
      .filter((flag) => !family || reviewProblemQaFamily(flag) !== family);
    flags.push(qaFlag);
    await database.prepare('UPDATE segments SET qa_flags = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify([...new Set(flags)]), clock(), segmentId);
  }

  async function approveValidatedSegments(
    projectId: string,
    safeOnly: boolean,
    confirmLanguageIssues = false,
    confirmProtectionIssues = false,
  ): Promise<BulkApprovalResult> {
    const safeClause = safeOnly ? "AND risk_level = 'low'" : '';
    const project = await database.prepare(`
      SELECT target_language AS targetLanguage, language_behavior_mode AS mode
      FROM projects WHERE id = ?
    `).get(projectId) as { targetLanguage?: string; mode?: string } | undefined;
    const rows = await database.prepare(`
      SELECT id, path_label AS pathLabel, path_json AS pathJson, kind, protocol_delimiter AS protocolDelimiter, source_text AS sourceText,
        qa_flags AS qaFlags,
        COALESCE(NULLIF(TRIM(final_text), ''), TRIM(translated_text)) AS effectiveText
      FROM segments
      WHERE project_id = ? AND review_status = 'pending' ${safeClause}
        AND (TRIM(COALESCE(final_text, '')) != '' OR TRIM(COALESCE(translated_text, '')) != '')
    `).all(projectId) as Array<Record<string, unknown>>;
    const references = await controlReferencesForProject(projectId);
    const settings = publicSettings();
    const approvedIds: string[] = [];
    const qaById = new Map<string, string[]>();
    const languageConfirmationRequired: Array<{ id: string; pathLabel: string; issue: string }> = [];
    const protectionConfirmationRequired: NonNullable<BulkApprovalResult['protectionConfirmationRequired']> = [];
    let skipped = 0;
    for (const row of rows) {
      const path = parsePathJson(String(row.pathJson));
      const sourceText = String(row.sourceText);
      const effectiveText = String(row.effectiveText);
      const protectedLiterals = protectedTranslationFragments(sourceText, references, path, String(row.kind));
      const missing = missingProtectedFragments(sourceText, effectiveText, protectedLiterals);
      const protocolIssue = String(row.kind) === 'protocol-field'
        ? protocolFieldReplacementIssue(effectiveText, String(row.protocolDelimiter || ''), sourceText)
        : null;
      const sourceIssue = residualLanguageIssue(
        effectiveText,
        [
          ...protectText(sourceText, protectedLiterals).tokens,
          ...unchangedCodeSpanFragments(sourceText, effectiveText),
          ...unchangedFilePathFragments(sourceText, effectiveText),
        ],
        settings.sourceLanguage,
        settings.fallbackLanguage,
        settings.targetLanguage,
      );
      const languageIssue = project?.mode !== 'preserve'
        ? languageBehaviorDirectiveIssue(effectiveText, String(project?.targetLanguage || 'zh-CN'))
        : null;
      const protectionConfirmed = missing.length > 0
        && (confirmProtectionIssues || hasProtectionConfirmation(row.qaFlags, effectiveText));
      if (languageIssue && !confirmLanguageIssues) {
        languageConfirmationRequired.push({
          id: String(row.id),
          pathLabel: String(row.pathLabel || row.id),
          issue: languageIssue,
        });
      }
      if (missing.length && !protectionConfirmed) {
        protectionConfirmationRequired.push({
          id: String(row.id),
          pathLabel: String(row.pathLabel || row.id),
          missingCount: missing.length,
          missingFragments: describeMissingProtectedFragments(missing, references),
        });
      }
      const qaFlags = safeArray(row.qaFlags).map(String)
        .filter((flag) => flag !== LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG)
        .filter((flag) => !flag.startsWith(PROTECTION_CONFIRMATION_FLAG_PREFIX))
        .filter((flag) => !isReviewProblemQaFlag(flag));
      if (sourceIssue) qaFlags.push(sourceIssue);
      if (languageIssue && confirmLanguageIssues) qaFlags.push(LANGUAGE_BEHAVIOR_CONFIRMATION_FLAG);
      if (protectionConfirmed) qaFlags.push(protectionConfirmationFlag(effectiveText));
      qaById.set(String(row.id), qaFlags);
      if ((missing.length && !protectionConfirmed) || protocolIssue || sourceIssue || (languageIssue && !confirmLanguageIssues)) skipped += 1;
      else approvedIds.push(String(row.id));
    }

    if (languageConfirmationRequired.length && !confirmLanguageIssues) {
      for (const item of languageConfirmationRequired) {
        await appendSegmentQaFlag(item.id, `卡片语言设定待确认：${item.issue}`);
      }
      return { approved: 0, skipped: 0, languageConfirmationRequired };
    }
    if (protectionConfirmationRequired.length && !confirmProtectionIssues) {
      for (const item of protectionConfirmationRequired) {
        await appendSegmentQaFlag(
          item.id,
          `保护结构缺失（${item.missingCount} 项）：${item.missingFragments.slice(0, 3).map((fragment) => fragment.value).join('、')}`,
        );
      }
      return { approved: 0, skipped: 0, protectionConfirmationRequired };
    }

    const update = database.prepare("UPDATE segments SET review_status = 'approved', updated_at = ? WHERE id = ?");
    const updateQa = database.prepare('UPDATE segments SET qa_flags = ?, updated_at = ? WHERE id = ?');
    const timestamp = clock();
    await database.transaction(async () => {
      for (const [segmentId, qaFlags] of qaById) await updateQa.run(JSON.stringify(qaFlags), timestamp, segmentId);
      for (const segmentId of approvedIds) await update.run(timestamp, segmentId);
    });
    return { approved: approvedIds.length, skipped };
  }

  async function projectLanguageBehaviorIssue(projectId: string): Promise<string | null> {
    const project = await database.prepare(`
      SELECT target_language AS targetLanguage, language_behavior_mode AS languageBehaviorMode
      FROM projects WHERE id = ?
    `).get(projectId) as { targetLanguage?: string; languageBehaviorMode?: string } | undefined;
    if (!project || project.languageBehaviorMode === 'preserve') return null;
    const rows = await database.prepare(`
      SELECT path_label AS pathLabel, qa_flags AS qaFlags,
        COALESCE(NULLIF(TRIM(final_text), ''), NULLIF(TRIM(translated_text), '')) AS effectiveText
      FROM segments
      WHERE project_id = ? AND review_status = 'approved'
        AND COALESCE(NULLIF(TRIM(final_text), ''), NULLIF(TRIM(translated_text), '')) IS NOT NULL
    `).all(projectId) as Array<{ pathLabel: string; qaFlags?: unknown; effectiveText: string | null }>;
    for (const row of rows) {
      if (hasLanguageBehaviorConfirmation(row.qaFlags)) continue;
      const issue = languageBehaviorDirectiveIssue(String(row.effectiveText || ''), String(project.targetLanguage || 'zh-CN'));
      if (issue) return `导出前复核失败：${row.pathLabel} ${issue}。请在审核中修正，或将项目卡片语言设定切换为“保留卡片原设定”。`;
    }
    return null;
  }

  async function approvedSegmentProtectionIssue(projectId: string): Promise<ApprovedProtectionIssue | null> {
    const project = await database.prepare(`
      SELECT source_format AS sourceFormat, original_json AS originalJson
      FROM projects WHERE id = ?
    `).get(projectId) as { sourceFormat?: string; originalJson?: string } | undefined;
    const originalCard = project?.originalJson
      ? JSON.parse(project.originalJson) as Record<string, unknown>
      : {};
    const rows = await database.prepare(`
      SELECT path_json AS pathJson, path_label AS pathLabel, kind,
        protocol_delimiter AS protocolDelimiter, source_text AS sourceText,
        qa_flags AS qaFlags,
        COALESCE(NULLIF(TRIM(final_text), ''), TRIM(translated_text)) AS effectiveText
      FROM segments
      WHERE project_id = ? AND review_status = 'approved'
        AND (TRIM(COALESCE(final_text, '')) != '' OR TRIM(COALESCE(translated_text, '')) != '')
      ORDER BY sort_order
    `).all(projectId) as Array<Record<string, unknown>>;
    const references = await controlReferencesForProject(projectId);
    const settings = publicSettings();
    for (const row of rows) {
      const path = parsePathJson(String(row.pathJson));
      if (project?.sourceFormat === 'charx' && isRisuModuleLorebookMirrorPath(originalCard, path)) continue;
      const protocolIssue = String(row.kind) === 'protocol-field'
        ? protocolFieldReplacementIssue(String(row.effectiveText), String(row.protocolDelimiter || ''), String(row.sourceText))
        : null;
      if (protocolIssue) return { pathLabel: String(row.pathLabel), missingCount: 1, reason: protocolIssue };
      const sourceText = String(row.sourceText);
      const effectiveText = String(row.effectiveText);
      const protectedLiterals = protectedTranslationFragments(sourceText, references, path, String(row.kind));
      if (!hasProtectionConfirmation(row.qaFlags, effectiveText)) {
        const missing = missingLiteralFragments(sourceText, effectiveText, protectedLiterals);
        if (missing.length) {
          return {
            pathLabel: String(row.pathLabel),
            missingCount: missing.length,
            details: describeMissingProtectedFragments(missing, references),
          };
        }
      }
      const sourceIssue = residualLanguageIssue(
        effectiveText,
        [
          ...protectText(sourceText, protectedLiterals).tokens,
          ...unchangedCodeSpanFragments(sourceText, effectiveText),
          ...unchangedFilePathFragments(sourceText, effectiveText),
        ],
        settings.sourceLanguage,
        settings.fallbackLanguage,
        settings.targetLanguage,
      );
      if (sourceIssue) return { pathLabel: String(row.pathLabel), missingCount: 1, reason: sourceIssue };
    }
    return null;
  }

  async function resolveMirroredModuleLorebookFailures(projectId: string, card: Record<string, unknown>): Promise<void> {
    const failed = await database.prepare(`
      SELECT DISTINCT s.id, s.path_json AS pathJson
      FROM segments s
      JOIN job_items ji ON ji.segment_id = s.id
      WHERE s.project_id = ? AND ji.status = 'failed'
    `).all(projectId) as Array<{ id: string; pathJson: string }>;
    for (const segment of failed) {
      if (!isRisuModuleLorebookMirrorPath(card, parsePathJson(segment.pathJson))) continue;
      await resolveFailedJobItems(segment.id, 'CHARX 内嵌模块世界书镜像');
    }
  }

  return {
    appendSegmentQaFlag,
    approveValidatedSegments,
    projectLanguageBehaviorIssue,
    approvedSegmentProtectionIssue,
    resolveMirroredModuleLorebookFailures,
  };
}
