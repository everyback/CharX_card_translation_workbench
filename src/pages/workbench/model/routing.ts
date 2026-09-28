import type { Tab } from '@/shared/types';

export const HISTORY_TABS: Tab[] = [
  'overview', 'segments', 'jobs', 'review', 'glossary', 'references', 'protocols', 'lua', 'resources', 'plugins', 'about',
];

export function isIndependentTab(tab: Tab): boolean {
  return tab === 'plugins' || tab === 'about';
}

export interface WorkbenchRoute {
  tab: Tab;
  projectId: string;
  segmentId: string;
}

export function readWorkbenchRoute(): WorkbenchRoute {
  if (typeof window === 'undefined') return { tab: 'overview', projectId: '', segmentId: '' };
  const params = new URLSearchParams(window.location.search);
  const requestedTab = params.get('tab') as Tab | null;
  const tab = requestedTab && HISTORY_TABS.includes(requestedTab) ? requestedTab : 'overview';
  return {
    tab,
    projectId: isIndependentTab(tab) ? '' : params.get('project') || '',
    segmentId: isIndependentTab(tab) ? '' : params.get('segment') || '',
  };
}

export function writeWorkbenchRoute(route: WorkbenchRoute, replace = false): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('tab', route.tab);
  const projectId = isIndependentTab(route.tab) ? '' : route.projectId;
  const segmentId = isIndependentTab(route.tab) ? '' : route.segmentId;
  if (projectId) url.searchParams.set('project', projectId); else url.searchParams.delete('project');
  if (segmentId) url.searchParams.set('segment', segmentId); else url.searchParams.delete('segment');
  const state = { workbench: true, tab: route.tab, projectId, segmentId };
  if (replace) window.history.replaceState(state, '', url);
  else window.history.pushState(state, '', url);
}
