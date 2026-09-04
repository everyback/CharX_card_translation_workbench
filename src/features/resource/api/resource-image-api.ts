import { api, jsonBody } from '@/shared/api/http';
import type { ResourceImageCandidate } from '@/shared/types';

export function generateResourceImageCandidate(projectId: string, path: string) {
  return api<ResourceImageCandidate & { path: string }>(`/api/projects/${projectId}/resources/image-edit`, {
    method: 'POST',
    ...jsonBody({ path }),
  });
}

export function setResourceImageCandidateStatus(
  projectId: string,
  path: string,
  status: ResourceImageCandidate['status'],
) {
  return api<{ status: ResourceImageCandidate['status']; updatedAt: string }>(`/api/projects/${projectId}/resources/image-edit`, {
    method: 'PATCH',
    ...jsonBody({ path, status }),
  });
}

export function resourceFileUrl(projectId: string, path: string, displayName?: string) {
  const search = new URLSearchParams({ path });
  if (displayName) search.set('name', displayName);
  return `/api/projects/${projectId}/resources/file?${search.toString()}`;
}

export function resourceImageCandidateUrl(projectId: string, path: string, updatedAt: string) {
  const search = new URLSearchParams({ path, v: updatedAt });
  return `/api/projects/${projectId}/resources/image-edit/file?${search.toString()}`;
}
