import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';
import { PROJECT_TITLE_COLUMNS } from '../repositories/project-queries.js';
import { publicSettings, updateSettings } from '../scheduler.js';

let dashboardCache: { expiresAt: number; value: {
  projects: number;
  pendingReview: number;
  activeJobs: number;
  settings: ReturnType<typeof publicSettings>;
} } | null = null;
let projectListCache: { expiresAt: number; value: unknown[] } | null = null;

export function registerSystemRoutes(app: FastifyInstance): void {
  app.get('/api/health', async () => ({
    ok: true,
    service: 'card-translation-workbench',
    databaseWorkers: db.workerCount,
  }));

  app.get('/api/dashboard', async () => {
    const currentTime = Date.now();
    if (dashboardCache && dashboardCache.expiresAt > currentTime) return dashboardCache.value;
    const projects = Number((await db.prepare('SELECT COUNT(*) AS count FROM projects').get() as { count: number }).count);
    const pendingReview = Number((await db.prepare("SELECT COUNT(*) AS count FROM segments WHERE review_status = 'pending'").get() as { count: number }).count);
    const activeJobs = Number((await db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running', 'paused')").get() as { count: number }).count);
    const value = { projects, pendingReview, activeJobs, settings: publicSettings() };
    dashboardCache = { expiresAt: currentTime + 5000, value };
    return value;
  });

  app.get('/api/settings', async () => publicSettings());

  app.put('/api/settings', async (request) => updateSettings(asRecord(request.body)));

  app.get('/api/projects', async () => {
    const currentTime = Date.now();
    if (projectListCache && projectListCache.expiresAt > currentTime) return projectListCache.value;
    const projects = await db.prepare(`
      SELECT
        p.id,
        p.name,
        ${PROJECT_TITLE_COLUMNS},
        p.source_format AS sourceFormat,
        p.source_language AS sourceLanguage,
        p.target_language AS targetLanguage,
        p.language_behavior_mode AS languageBehaviorMode,
        p.scope,
        p.status,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        COUNT(s.id) AS segmentCount,
        SUM(CASE WHEN s.review_status = 'approved' THEN 1 ELSE 0 END) AS approvedCount,
        SUM(CASE WHEN s.review_status = 'pending' THEN 1 ELSE 0 END) AS pendingReviewCount
      FROM projects p
      LEFT JOIN segments s ON s.project_id = p.id
      GROUP BY p.id
      ORDER BY p.updated_at DESC
    `).all();
    projectListCache = { expiresAt: currentTime + 5000, value: projects };
    return projects;
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
