import type { ScopePreset } from '@/shared/model/workbench-types';

export interface Job {
  languageConfig?: {
    sourceLanguage: string;
    fallbackLanguage: string;
    targetLanguage: string;
    languageBehaviorMode: 'target' | 'preserve';
  } | null;
  id: string;
  projectId: string;
  status: string;
  scope: ScopePreset;
  model: string;
  totalItems: number;
  completedItems: number;
  failedItems: number;
  postTotalItems: number;
  postCompletedItems: number;
  postFailedItems: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  logs?: JobLog[];
}

export interface JobLog {
  id: number;
  level: string;
  message: string;
  createdAt: string;
}
