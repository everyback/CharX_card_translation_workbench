import type { AsyncDatabase } from '../async-db.js';
import type { ScannedSegment } from '../domain/card.js';

type PreviousSegment = Record<string, unknown>;

export interface ScanServiceDependencies {
  database: AsyncDatabase;
  createId: () => string;
  clock: () => string;
  refreshHistoricalJobsAfterScan(projectId: string, timestamp: string): Promise<void>;
}

export interface ReconciledSegment {
  segment: ScannedSegment;
  sortOrder: number;
  previousId?: string;
}

export interface SegmentReconciliationPlan {
  retained: ReconciledSegment[];
  obsoleteIds: string[];
  preservedCount: number;
}

function isNamespaceDecisionSegment(segment: PreviousSegment): boolean {
  const pathJson = String(segment.path_json);
  return (pathJson === JSON.stringify(['$module', 'namespace']) || pathJson === JSON.stringify(['namespace']))
    && String(segment.kind) === 'field';
}

export function segmentIdentity(
  pathJson: string,
  kind: string,
  sourceText: string,
  start: number | null,
  end: number | null,
): string {
  return JSON.stringify([pathJson, kind, sourceText, start, end]);
}

export function segmentSemanticIdentity(pathJson: string, kind: string, sourceText: string): string {
  return JSON.stringify([pathJson, kind, sourceText]);
}

export function segmentPositionDistance(
  previous: PreviousSegment,
  start: number | null,
  end: number | null,
): number {
  const previousStart = previous.start_pos == null ? 0 : Number(previous.start_pos);
  const previousEnd = previous.end_pos == null ? previousStart : Number(previous.end_pos);
  return Math.abs(previousStart - (start ?? 0)) + Math.abs(previousEnd - (end ?? start ?? 0));
}

export function reconcileScannedSegments(
  scannedSegments: readonly ScannedSegment[],
  previousSegments: readonly PreviousSegment[],
): SegmentReconciliationPlan {
  const previousByKey = new Map(previousSegments.map((segment) => [segmentIdentity(
    String(segment.path_json),
    String(segment.kind),
    String(segment.source_text),
    segment.start_pos == null ? null : Number(segment.start_pos),
    segment.end_pos == null ? null : Number(segment.end_pos),
  ), segment]));
  const previousBySemanticKey = new Map<string, PreviousSegment[]>();
  for (const segment of previousSegments) {
    const key = segmentSemanticIdentity(
      String(segment.path_json), String(segment.kind), String(segment.source_text),
    );
    const matches = previousBySemanticKey.get(key) ?? [];
    matches.push(segment);
    previousBySemanticKey.set(key, matches);
  }

  const retainedIds = new Set<string>();
  const retained = scannedSegments.map((segment, sortOrder) => {
    const pathJson = JSON.stringify(segment.path);
    let previous = previousByKey.get(segmentIdentity(
      pathJson, segment.kind, segment.sourceText, segment.start, segment.end,
    ));
    if (previous && retainedIds.has(String(previous.id))) previous = undefined;
    if (!previous) {
      previous = (previousBySemanticKey.get(segmentSemanticIdentity(
        pathJson, segment.kind, segment.sourceText,
      )) ?? [])
        .filter((candidate) => !retainedIds.has(String(candidate.id)))
        .sort((a, b) => segmentPositionDistance(a, segment.start, segment.end)
          - segmentPositionDistance(b, segment.start, segment.end))[0];
    }
    const previousId = previous ? String(previous.id) : undefined;
    if (previousId) retainedIds.add(previousId);
    return { segment, sortOrder, previousId };
  });

    return {
      retained,
      obsoleteIds: previousSegments
        // Namespace decisions are made in Lua management, not inferred from
        // a regular scan. Keep the decision row so re-scanning cannot turn a
        // confirmed internal key back into an invisible pending review item.
        .filter((segment) => !retainedIds.has(String(segment.id)) && !isNamespaceDecisionSegment(segment))
        .map((segment) => String(segment.id)),
    preservedCount: retained.filter((item) => item.previousId).length,
  };
}

export function createScanService({
  database,
  createId,
  clock,
  refreshHistoricalJobsAfterScan,
}: ScanServiceDependencies) {
  async function replaceScannedSegments(
    projectId: string,
    scope: string,
    scannedSegments: readonly ScannedSegment[],
  ): Promise<{ segmentCount: number; preservedCount: number; newCount: number }> {
    const timestamp = clock();
    const previousSegments = await database.prepare(`
      SELECT id, path_json, kind, source_text, start_pos, end_pos,
        translated_text, final_text, review_status, included, qa_flags
      FROM segments WHERE project_id = ?
    `).all(projectId) as PreviousSegment[];
    const plan = reconcileScannedSegments(scannedSegments, previousSegments);
    const insert = database.prepare(`
      INSERT INTO segments(
        id, project_id, path_json, path_label, category, kind, protocol_delimiter, source_text,
        translated_text, final_text, start_pos, end_pos, risk_level,
        review_status, included, qa_flags, sort_order, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updatePreserved = database.prepare(`
      UPDATE segments SET
        path_json = ?, path_label = ?, category = ?, kind = ?, source_text = ?,
        protocol_delimiter = ?, start_pos = ?, end_pos = ?, risk_level = ?, sort_order = ?, updated_at = ?
      WHERE id = ?
    `);
    const deleteObsolete = database.prepare('DELETE FROM segments WHERE project_id = ? AND id = ?');

    await database.transaction(async () => {
      for (const item of plan.retained) {
        const { segment, sortOrder, previousId } = item;
        const pathJson = JSON.stringify(segment.path);
        if (previousId) {
          await updatePreserved.run(
            pathJson, segment.pathLabel, segment.category, segment.kind, segment.sourceText,
            segment.protocolDelimiter ?? null, segment.start, segment.end, segment.risk, sortOrder, timestamp, previousId,
          );
          continue;
        }
        await insert.run(
          createId(), projectId, pathJson, segment.pathLabel,
          segment.category, segment.kind, segment.protocolDelimiter ?? null, segment.sourceText,
          null, null,
          segment.start, segment.end, segment.risk,
          'untranslated', 1, '[]', sortOrder, timestamp,
        );
      }
      for (const previousId of plan.obsoleteIds) await deleteObsolete.run(projectId, previousId);
      await refreshHistoricalJobsAfterScan(projectId, timestamp);
      await database.prepare("UPDATE projects SET scope = ?, status = 'scanned', updated_at = ? WHERE id = ?")
        .run(scope, timestamp, projectId);
    });
    return {
      segmentCount: scannedSegments.length,
      preservedCount: plan.preservedCount,
      newCount: scannedSegments.length - plan.preservedCount,
    };
  }

  return { replaceScannedSegments };
}
