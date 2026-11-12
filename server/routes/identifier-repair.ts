import type { FastifyInstance } from 'fastify';
import { previewIdentifierRepair, exportIdentifierRepair } from '../application/export/identifier-repair-service.js';

/** Isolated file tool: no project writes, external paths, or model calls. */
export function registerIdentifierRepairRoutes(app: FastifyInstance, uploadBytes: number) {
  app.post<{ Params: { action: string } }>('/api/identifier-repair/:action', async (request, reply) => {
    if (!['preview', 'export'].includes(request.params.action)) return reply.code(404).send({ error: '未知修复操作。' });
    try {
      const files = new Map<string, Buffer>();
      let approval: unknown;
      for await (const part of request.parts({ limits: { files: 2, fileSize: uploadBytes, fields: 1 } })) {
        if (part.type === 'file') {
          if (!['original', 'translated'].includes(part.fieldname) || files.has(part.fieldname)
            || !part.filename.toLowerCase().endsWith('.charx')) throw new Error('请选择正确原件和待修复译卡各一份 CHARX。');
          files.set(part.fieldname, await part.toBuffer());
        } else if (part.fieldname === 'approval') {
          approval = JSON.parse(String(part.value));
        }
      }
      const original = files.get('original'), translated = files.get('translated');
      if (!original || !translated) throw new Error('需要正确原件和待修复译卡，无法只凭译卡猜测标识符。');
      if (request.params.action === 'preview') return previewIdentifierRepair(original, translated);
      const a = approval as { planId?: unknown; approvedIds?: unknown } | undefined;
      if (!a || typeof a.planId !== 'string' || !Array.isArray(a.approvedIds)
        || a.approvedIds.some(id => typeof id !== 'string')) throw new Error('请先审核修复清单。');
      const result = exportIdentifierRepair(original, translated, { planId: a.planId, approvedIds: a.approvedIds as string[] });
      return reply.type('application/zip')
        .header('Content-Disposition', 'attachment; filename="reviewed-identifier-repair.charx"')
        .header('X-Repair-Count', result.repairedCount)
        .header('X-Unresolved-Actions', result.diagnostics.length)
        .send(result.output);
    } catch (error) {
      const e = error as Error & { statusCode?: number };
      return reply.code(e.statusCode === 413 ? 413 : 400).send({ error: e.message });
    }
  });
}
