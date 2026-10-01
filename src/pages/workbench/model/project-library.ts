import type { ProjectSummary } from '@/shared/types';

export type LibraryFilter = 'all' | 'active' | 'review' | 'ready';
export type LibrarySort = 'updated' | 'name';

export function latestProjectVersions(projects: ProjectSummary[]): ProjectSummary[] {
  const families = new Map<string, ProjectSummary>();
  for (const project of projects) {
    const key = project.familyId || project.id;
    const current = families.get(key);
    if (!current || (project.versionNumber ?? 1) > (current.versionNumber ?? 1)) families.set(key, project);
  }
  return [...families.values()];
}

export function matchesLibraryFilter(project: ProjectSummary, filter: LibraryFilter): boolean {
  if (filter === 'active') return ['translating', 'paused'].includes(project.status);
  if (filter === 'review') return project.pendingReviewCount > 0 || project.status === 'review_with_errors';
  if (filter === 'ready') return ['ready', 'reviewed'].includes(project.status);
  return true;
}

export function filterLibraryProjects(projects: ProjectSummary[], query: string, filter: LibraryFilter, format: string, sort: LibrarySort) {
  const normalized = query.trim().toLocaleLowerCase();
  return projects.filter(project => matchesLibraryFilter(project, filter)
    && (format === 'all' || project.sourceFormat === format)
    && (!normalized || [project.name, project.originalName, project.translatedName].some(value => value?.toLocaleLowerCase().includes(normalized))))
    .sort((a, b) => sort === 'name'
      ? (a.translatedName || a.originalName || a.name).localeCompare(b.translatedName || b.originalName || b.name, 'zh-CN')
      : b.updatedAt.localeCompare(a.updatedAt));
}
