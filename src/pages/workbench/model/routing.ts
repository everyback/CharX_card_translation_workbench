import type { Tab } from '@/shared/types';

export const HISTORY_TABS: Tab[] = [
  'overview', 'segments', 'jobs', 'review', 'glossary', 'references', 'protocols', 'lua', 'resources', 'about',
];

export interface WorkbenchRoute {
  tab: Tab;
  projectId: string;
  segmentId: string;
}

export function readWorkbenchRoute(): WorkbenchRoute {
  if (typeof window === 'undefined') return { tab: 'overview', projectId: '', segmentId: '' };
  const params = new URLSearchParams(window.location.search);
  const requestedTab = params.get('tab') as Tab | null;
  return {
    tab: requestedTab && HISTORY_TABS.includes(requestedTab) ? requestedTab : 'overview',
    projectId: params.get('project') || '',
    segmentId: params.get('segment') || '',
  };
}

export function writeWorkbenchRoute(route: WorkbenchRoute, replace = false): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('tab', route.tab);
  if (route.projectId) url.searchParams.set('project', route.projectId); else url.searchParams.delete('project');
  if (route.segmentId) url.searchParams.set('segment', route.segmentId); else url.searchParams.delete('segment');
  const state = { workbench: true, ...route };
  if (replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}
