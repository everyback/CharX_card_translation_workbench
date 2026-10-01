export type ResourceKind = 'image' | 'audio' | 'video' | 'font' | 'data' | 'other';
export type ResourceTextRisk = 'none' | 'path' | 'unknown';
export type ResourceImageStatus = 'draft' | 'confirmed';

export interface ResourceImageCandidate {
  mimeType: string;
  model: string;
  prompt: string;
  status: ResourceImageStatus;
  updatedAt: string;
}

export interface ResourceReference {
  pathLabel: string;
  sample: string;
}

export interface ResourceItem {
  path: string;
  displayName: string;
  kind: ResourceKind;
  mimeType: string;
  detectedFormat: string;
  declaredType: string | null;
  embeddedIndex: number | null;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
  textRisk: ResourceTextRisk;
  languageHint: string | null;
  references: ResourceReference[];
  previewable: boolean;
  imageCandidate?: ResourceImageCandidate;
}

export interface ResourceInspection {
  sourceFormat: string;
  sourceFilename: string | null;
  resources: ResourceItem[];
  summary: {
    total: number;
    images: number;
    suspectedText: number;
    referenced: number;
  };
}
