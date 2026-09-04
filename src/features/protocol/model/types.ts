export type ProtocolPolicy = 'translate' | 'protect' | 'manual';
export type ProtocolStatus = 'pending' | 'analyzed' | 'approved' | 'ignored';

export interface ProtocolFieldRule {
  index: number;
  role: string;
  policy: ProtocolPolicy;
  confidence: number;
  reason: string;
  hardProtected: boolean;
}

export interface ProtocolOccurrence {
  pathLabel: string;
  start: number;
  end: number;
  rawPreview: string;
  fields: Array<{ index: number; value: string }>;
  isDeclaration: boolean;
}

export interface ProtocolSchema {
  id: string;
  projectId: string;
  signature: string;
  name: string;
  form: 'angle' | 'square' | 'at-line';
  opener: string;
  closer: string;
  delimiter: string;
  fieldCount: number;
  status: ProtocolStatus;
  source: 'local' | 'regex-lua' | 'model' | 'manual';
  confidence: number;
  fieldRules: ProtocolFieldRule[];
  declaration: string;
  examples: string[];
  occurrenceCount: number;
  referenceCount: number;
  lastError: string | null;
  occurrences: ProtocolOccurrence[];
  updatedAt: string;
}
