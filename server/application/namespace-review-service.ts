import type { AsyncDatabase } from '../async-db.js';
import { replaceRisuModuleNamespaceReferences } from '../domain/risu-lua.js';

export interface NamespaceReviewServiceDependencies {
  database: AsyncDatabase;
  createId: () => string;
  clock: () => string;
}

interface NamespaceSegmentRow {
  id: string;
}

function isNamespacePath(pathJson: string): boolean {
  return pathJson === JSON.stringify(['$module', 'namespace'])
    || pathJson === JSON.stringify(['namespace']);
}

export function createNamespaceReviewService({ database, createId, clock }: NamespaceReviewServiceDependencies) {
  async function confirm(projectId: string, targetNamespaceInput: string): Promise<{
    ok: true;
    sourceNamespace: string;
    targetNamespace: string;
    segmentId: string;
  }> {
    const active = await database.prepare(`
      SELECT COUNT(*) AS count FROM jobs
      WHERE project_id = ? AND status IN ('queued', 'running', 'paused')
    `).get(projectId) as { count: number };
    if (Number(active.count) > 0) throw new Error('请先结束当前翻译任务，再确认模块命名空间。');

    const project = await database.prepare(`
      SELECT original_module_json AS originalModuleJson, draft_module_json AS draftModuleJson
      FROM projects WHERE id = ?
    `).get(projectId) as { originalModuleJson?: string | null; draftModuleJson?: string | null } | undefined;
    if (!project?.originalModuleJson) throw new Error('当前卡片没有可检查的 Risu 模块命名空间。');

    const originalModule = JSON.parse(project.originalModuleJson) as Record<string, unknown>;
    const sourceNamespace = typeof originalModule.namespace === 'string' ? originalModule.namespace.trim() : '';
    if (!sourceNamespace) throw new Error('当前 Risu 模块没有可检查的命名空间。');
    const targetNamespace = targetNamespaceInput.trim();
    if (!targetNamespace) throw new Error('请填写确认后的模块命名空间。');
    const draftModule = project.draftModuleJson
      ? JSON.parse(project.draftModuleJson) as Record<string, unknown>
      : structuredClone(originalModule);
    const currentNamespace = typeof draftModule.namespace === 'string' ? draftModule.namespace.trim() : '';
    if (currentNamespace && currentNamespace !== sourceNamespace) {
      replaceRisuModuleNamespaceReferences(draftModule, currentNamespace, sourceNamespace);
    }
    draftModule.namespace = sourceNamespace;
    if (targetNamespace !== sourceNamespace) {
      replaceRisuModuleNamespaceReferences(draftModule, sourceNamespace, targetNamespace);
      draftModule.namespace = targetNamespace;
    }

    const existing = (await database.prepare<NamespaceSegmentRow & { pathJson: string }>(`
      SELECT id, path_json AS pathJson FROM segments
      WHERE project_id = ?
        AND path_json IN (?, ?)
        AND source_text = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).all(
      projectId,
      JSON.stringify(['$module', 'namespace']),
      JSON.stringify(['namespace']),
      sourceNamespace,
    ))[0];
    const timestamp = clock();
    const segmentId = existing?.id ?? createId();
    const qaFlags = targetNamespace === sourceNamespace
      ? JSON.stringify(['命名空间人工检查：内部标识符，保留原文'])
      : JSON.stringify(['命名空间人工检查：已人工修改并确认，已同步模块内部引用']);

    await database.transaction(async () => {
      if (existing) {
        await database.prepare(`
          UPDATE segments
          SET path_json = ?, path_label = ?, category = ?, kind = ?, source_text = ?,
            translated_text = ?, final_text = ?, start_pos = NULL, end_pos = NULL,
            risk_level = ?, review_status = ?, included = 1, qa_flags = ?, updated_at = ?
          WHERE id = ?
        `).run(
          JSON.stringify(['$module', 'namespace']), '$module.namespace', 'name', 'field', sourceNamespace,
          targetNamespace, targetNamespace, 'high', 'approved', qaFlags, timestamp, segmentId,
        );
      } else {
        const order = await database.prepare<{ nextOrder: number }>(`
          SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM segments WHERE project_id = ?
        `).get(projectId);
        await database.prepare(`
          INSERT INTO segments(
            id, project_id, path_json, path_label, category, kind, protocol_delimiter, source_text,
            translated_text, final_text, start_pos, end_pos, risk_level,
            review_status, included, qa_flags, sort_order, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, ?, ?)
        `).run(
          segmentId, projectId, JSON.stringify(['$module', 'namespace']), '$module.namespace', 'name', 'field',
          sourceNamespace, targetNamespace, targetNamespace, 'high', 'approved', qaFlags,
          Number(order?.nextOrder ?? 0), timestamp,
        );
      }
      await database.prepare(`
        UPDATE projects SET draft_module_json = ?, updated_at = ? WHERE id = ?
      `).run(JSON.stringify(draftModule), timestamp, projectId);
    });

    return { ok: true, sourceNamespace, targetNamespace, segmentId };
  }

  return { confirm };
}
