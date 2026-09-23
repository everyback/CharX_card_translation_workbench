import type { AsyncDatabase } from '../../async-db.js';
import { applyApprovedSegments, isProtectedStoredPath, restoreProtectedModuleDraft, type ApplicableSegment } from '../../domain/card/card.js';
import { synchronizeRisuModuleLorebook } from '../../domain/card/charx.js';
import { applyRisuModuleSegments } from '../../domain/lua/risu-lua.js';
import { isProtectedResourceJsonSegment } from '../../domain/resources/resources.js';

function isModuleNamespaceSegment(
  segment: ApplicableSegment,
  path: Array<string | number>,
  originalModule: Record<string, unknown> | null,
): boolean {
  return path.length === 1
    && path[0] === 'namespace'
    && typeof originalModule?.namespace === 'string'
    && segment.sourceText === originalModule.namespace;
}

/** Build the exact reviewed text candidate used by apply, without persisting it. */
export function buildReviewedDraft(
  originalCard: Record<string, unknown>,
  originalModule: Record<string, unknown> | null,
  existingDraftModule: Record<string, unknown> | null,
  segments: ApplicableSegment[],
  sourceFormat: string,
) {
  const cardSegments: ApplicableSegment[] = [];
  const moduleSegments: ApplicableSegment[] = [];
  const resourceSegments: ApplicableSegment[] = [];
  const ignoredProtectedPaths: string[] = [];
  for (const segment of segments) {
    const path = JSON.parse(segment.pathJson) as Array<string | number>;
    // Approved review state is not proof that the path is still translatable:
    // protection lists grow over time, and a scan keeps its rows until the
    // project is scanned again. Writing those rows back is what turned a Risu
    // card's `viewScreen: "none"` into `无`.
    if (isProtectedStoredPath(segment.kind, path, path[0] === '$module' ? originalModule : undefined)
      || isProtectedResourceJsonSegment(segment.kind, path, segment.sourceText)) {
      ignoredProtectedPaths.push(segment.pathLabel || segment.pathJson);
      continue;
    }
    if (path[0] === '$resource') resourceSegments.push(segment);
    else if (path[0] === '$module' || isModuleNamespaceSegment(segment, path, originalModule)) {
      moduleSegments.push({ ...segment, pathJson: JSON.stringify(path[0] === '$module' ? path.slice(1) : path) });
    }
    else cardSegments.push(segment);
  }

  const draft = applyApprovedSegments(originalCard, cardSegments);
  const moduleBase = existingDraftModule
    ? (originalModule
      ? restoreProtectedModuleDraft(originalModule, existingDraftModule, segments)
      : existingDraftModule)
    : originalModule;
  const moduleResult = moduleBase ? applyRisuModuleSegments(
    moduleBase,
    moduleSegments,
    '',
    undefined,
    {},
  ) : null;
  const appliedModule = moduleResult?.draft ?? null;
  const draftModule = appliedModule && sourceFormat === 'charx'
    ? synchronizeRisuModuleLorebook(draft, appliedModule)
    : appliedModule;
  return { draftCard: draft, draftModule, moduleResult, cardSegments, moduleSegments, resourceSegments, ignoredProtectedPaths };
}

export async function loadReviewedDraft(database: AsyncDatabase, projectId: string) {
  const row = await database.prepare(`
    SELECT original_json AS originalJson, original_module_json AS originalModuleJson,
      draft_module_json AS draftModuleJson, source_format AS sourceFormat
    FROM projects WHERE id = ?
  `).get(projectId) as { originalJson: string; originalModuleJson: string | null; draftModuleJson: string | null; sourceFormat: string } | undefined;
  if (!row) throw new Error('项目不存在。');
  const segments = await database.prepare(`
    SELECT id, path_json AS pathJson, path_label AS pathLabel, kind, source_text AS sourceText,
      start_pos AS start, end_pos AS end, translated_text AS translatedText,
      final_text AS finalText, review_status AS reviewStatus
    FROM segments WHERE project_id = ?
  `).all(projectId) as unknown as ApplicableSegment[];
  return buildReviewedDraft(JSON.parse(row.originalJson), row.originalModuleJson ? JSON.parse(row.originalModuleJson) : null,
    row.draftModuleJson ? JSON.parse(row.draftModuleJson) : null, segments, row.sourceFormat);
}
