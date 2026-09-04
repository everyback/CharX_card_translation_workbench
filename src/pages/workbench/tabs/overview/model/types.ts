export type CharxEntryCategory = 'card' | 'module' | 'asset' | 'metadata' | 'other';

export interface CharxEntryInfo {
  path: string;
  size: number;
  category: CharxEntryCategory;
}

export interface UnpackInspection {
  sessionId: string;
  filename: string;
  cardName: string;
  spec: string;
  hybrid: boolean;
  fileCount: number;
  totalBytes: number;
  cardLorebookEntries: number;
  modulePresent: boolean;
  moduleName: string | null;
  moduleLorebookEntries: number;
  moduleAssetCount: number;
  entries: CharxEntryInfo[];
}

export interface TavernCardFieldSummary {
  path: string;
  label: string;
  type: 'text' | 'list' | 'object' | 'value';
  size: number;
  summary: string;
  preview: string;
}

export interface TavernCardInspection {
  sessionId: string;
  filename: string;
  sourceFormat: 'png' | 'json';
  fileBytes: number;
  previewAvailable: boolean;
  cardName: string;
  spec: string;
  specVersion: string;
  creator: string;
  characterVersion: string;
  metadataKeys: string[];
  jsonBytes: number;
  alternateGreetings: number;
  groupOnlyGreetings: number;
  lorebookEntries: number;
  regexScripts: number;
  assets: number;
  tags: string[];
  extensionKeys: string[];
  topLevelKeys: string[];
  dataKeys: string[];
  fields: TavernCardFieldSummary[];
  warnings: string[];
}

export interface ProjectOverview extends Omit<TavernCardInspection, 'sessionId' | 'filename' | 'sourceFormat'> {
  projectId: string;
  filename: string | null;
  sourceFormat: string;
  modulePresent: boolean;
  moduleName: string;
  moduleLorebookEntries: number;
  moduleRegexScripts: number;
  moduleTriggers: number;
  moduleAssets: number;
  moduleJsonBytes: number;
  moduleKeys: string[];
}
