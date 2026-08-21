import { db, id, now } from './db.js';
import { risuControlReferences } from './domain/card.js';
import {
  discoverProtocols,
  type ProtocolFieldRule,
  type ProtocolPolicy,
  type ProtocolSchemaRule,
  type ProtocolStatus,
} from './domain/protocol.js';
import { discoverRisuRegexProtocols, mergeRegexProtocolEvidence } from './domain/risu-regex-protocol.js';
import { discoverRisuLuaProtocols, mergeLuaProtocolEvidence } from './domain/risu-lua-protocol.js';

export interface StoredProtocolSchema extends ProtocolSchemaRule {
  id: string;
  projectId: string;
  source: 'local' | 'regex-lua' | 'model' | 'manual';
  confidence: number;
  declaration: string;
  examples: string[];
  occurrenceCount: number;
  referenceCount: number;
  lastError: string | null;
  occurrences: Array<{
    pathLabel: string;
    start: number;
    end: number;
    rawPreview: string;
    fields: Array<{ index: number; value: string }>;
    isDeclaration: boolean;
  }>;
  updatedAt: string;
}

export interface ProtocolAnalysisResult {
  confidence: number;
  fields: ProtocolFieldRule[];
}

export async function discoverAndStoreProtocols(
  projectId: string,
  card: Record<string, unknown>,
  module: Record<string, unknown> | null,
): Promise<{ schemaCount: number; occurrenceCount: number; pendingCount: number }> {
  const references = module ? risuControlReferences(module).map((reference) => ({
    literal: reference.literal,
    kind: reference.kind,
    pathLabel: reference.pathLabel,
    pattern: reference.pattern,
  })) : [];
  const localClusters = discoverProtocols(card, module, references);
  const luaClusters = discoverRisuLuaProtocols(references);
  const regexClusters = module ? discoverRisuRegexProtocols(module, references) : [];
  const clusters = mergeRegexProtocolEvidence(
    mergeLuaProtocolEvidence(localClusters, luaClusters),
    regexClusters,
  );
  const existingRows = await db.prepare(`
    SELECT id, signature, status, source, field_rules_json AS fieldRulesJson
    FROM protocol_schemas WHERE project_id = ?
  `).all(projectId) as Array<Record<string, unknown>>;
  const existingBySignature = new Map(existingRows.map((row) => [String(row.signature), row]));
  const timestamp = now();
  const insertSchema = db.prepare(`
    INSERT INTO protocol_schemas(
      id, project_id, signature, name, form, opener, closer, delimiter, field_count,
      status, source, confidence, field_rules_json, declaration, examples_json,
      occurrence_count, reference_count, last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `);
  const updateSchema = db.prepare(`
    UPDATE protocol_schemas SET
      name = ?, form = ?, opener = ?, closer = ?, delimiter = ?, field_count = ?,
      source = ?, confidence = ?, field_rules_json = ?, declaration = ?, examples_json = ?,
      occurrence_count = ?, reference_count = ?, last_error = NULL, updated_at = ?
    WHERE id = ?
  `);
  const insertOccurrence = db.prepare(`
    INSERT INTO protocol_occurrences(
      id, project_id, schema_id, path_json, path_label, start_pos, end_pos,
      raw_preview, fields_json, is_declaration, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  await db.transaction(async () => {
    await db.prepare('DELETE FROM protocol_occurrences WHERE project_id = ?').run(projectId);
    await db.prepare(`
      UPDATE protocol_schemas SET occurrence_count = 0, reference_count = 0, updated_at = ?
      WHERE project_id = ?
    `).run(timestamp, projectId);

    for (const cluster of clusters) {
      const existing = existingBySignature.get(cluster.signature);
      const schemaId = existing ? String(existing.id) : id();
      const previousRules = existing ? parseFieldRules(existing.fieldRulesJson) : [];
      const refreshAutomaticRules = !existing
        || !['manual', 'model'].includes(String(existing.source)) && String(existing.status) !== 'approved';
      const fieldRules = mergeFieldRules(previousRules, cluster.fieldRules, refreshAutomaticRules);
      const confidence = fieldRules.length
        ? fieldRules.reduce((total, rule) => total + rule.confidence, 0) / fieldRules.length
        : cluster.confidence;
      const referenceCount = Math.max(
        cluster.referenceCount,
        fieldRules.filter((rule) => rule.hardProtected).length,
      );
      if (existing) {
        const previousSource = String(existing.source);
        const discoverySource = previousSource === 'manual' || previousSource === 'model'
          ? previousSource
          : cluster.source;
        await updateSchema.run(
          cluster.name, cluster.form, cluster.opener, cluster.closer, cluster.delimiter, cluster.fieldCount,
          discoverySource, confidence, JSON.stringify(fieldRules), cluster.declaration, JSON.stringify(cluster.examples),
          cluster.occurrenceCount, referenceCount, timestamp, schemaId,
        );
      } else {
        await insertSchema.run(
          schemaId, projectId, cluster.signature, cluster.name, cluster.form, cluster.opener, cluster.closer,
          cluster.delimiter, cluster.fieldCount, 'pending', cluster.source, confidence, JSON.stringify(fieldRules),
          cluster.declaration, JSON.stringify(cluster.examples), cluster.occurrenceCount, referenceCount,
          timestamp, timestamp,
        );
      }

      for (const occurrence of cluster.occurrences) {
        await insertOccurrence.run(
          id(), projectId, schemaId, JSON.stringify(occurrence.path), occurrence.pathLabel,
          occurrence.start, occurrence.end, occurrence.rawText.slice(0, 1_000),
          JSON.stringify(occurrence.fields.map((field) => ({ index: field.index, value: field.value.slice(0, 500) }))),
          occurrence.isDeclaration ? 1 : 0, timestamp,
        );
      }
    }
  });

  const pendingCount = clusters.filter((cluster) => {
    const existing = existingBySignature.get(cluster.signature);
    const automaticallyProtected = cluster.source === 'regex-lua'
      && cluster.confidence >= 0.9
      && cluster.fieldRules.every((field) => field.policy !== 'manual');
    return !automaticallyProtected
      && (!existing || String(existing.status) === 'pending' || String(existing.status) === 'analyzed');
  }).length;
  return {
    schemaCount: clusters.length,
    occurrenceCount: clusters.reduce((total, cluster) => total + cluster.occurrenceCount, 0),
    pendingCount,
  };
}

export async function listProtocolSchemas(projectId: string): Promise<StoredProtocolSchema[]> {
  const rows = await db.prepare(`
    SELECT
      id, project_id AS projectId, signature, name, form, opener, closer, delimiter,
      field_count AS fieldCount, status, source, confidence, field_rules_json AS fieldRulesJson,
      declaration, examples_json AS examplesJson, occurrence_count AS occurrenceCount,
      reference_count AS referenceCount, last_error AS lastError, updated_at AS updatedAt
    FROM protocol_schemas
    WHERE project_id = ? AND (occurrence_count > 0 OR source = 'regex-lua' OR status = 'approved')
    ORDER BY CASE WHEN source = 'regex-lua' THEN 0 ELSE 1 END, occurrence_count DESC, name COLLATE NOCASE
  `).all(projectId) as Array<Record<string, unknown>>;
  const occurrences = await db.prepare(`
    SELECT schema_id AS schemaId, path_label AS pathLabel, start_pos AS start, end_pos AS end,
      raw_preview AS rawPreview, fields_json AS fieldsJson, is_declaration AS isDeclaration
    FROM protocol_occurrences
    WHERE project_id = ?
    ORDER BY is_declaration DESC, path_label, start_pos
  `).all(projectId) as Array<Record<string, unknown>>;
  const grouped = new Map<string, StoredProtocolSchema['occurrences']>();
  for (const row of occurrences) {
    const schemaId = String(row.schemaId);
    const group = grouped.get(schemaId) ?? [];
    if (group.length < 12) {
      group.push({
        pathLabel: String(row.pathLabel),
        start: Number(row.start),
        end: Number(row.end),
        rawPreview: String(row.rawPreview),
        fields: safeArray(row.fieldsJson).map((field) => {
          const value = asRecord(field);
          return { index: Number(value.index), value: String(value.value ?? '') };
        }),
        isDeclaration: Boolean(row.isDeclaration),
      });
    }
    grouped.set(schemaId, group);
  }
  return rows.map((row) => normalizeStoredSchema(row, grouped.get(String(row.id)) ?? []));
}

export async function approvedProtocolRules(projectId: string): Promise<ProtocolSchemaRule[]> {
  const rows = await db.prepare(`
    SELECT signature, name, form, opener, closer, delimiter, field_count AS fieldCount,
      status, source, confidence, field_rules_json AS fieldRulesJson
    FROM protocol_schemas
    WHERE project_id = ? AND status <> 'ignored'
  `).all(projectId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    signature: String(row.signature),
    name: String(row.name),
    form: (row.form === 'square' || row.form === 'at-line' ? row.form : 'angle') as ProtocolSchemaRule['form'],
    opener: String(row.opener),
    closer: String(row.closer),
    delimiter: String(row.delimiter),
    fieldCount: Number(row.fieldCount),
    status: 'approved' as const,
    fieldRules: parseFieldRules(row.fieldRulesJson),
    source: String(row.source || ''),
    confidence: Number(row.confidence) || 0,
    originalStatus: String(row.status || 'pending'),
  }))
    .filter((rule) => rule.originalStatus === 'approved' || (
      rule.source === 'regex-lua'
      && rule.confidence >= 0.9
      && rule.fieldRules.every((field) => field.policy !== 'manual')
    ))
    .map(({ source: _source, confidence: _confidence, originalStatus: _status, ...rule }) => rule);
}

export async function protocolSchemasForAnalysis(projectId: string, schemaIds: readonly string[] = []): Promise<StoredProtocolSchema[]> {
  const selected = new Set(schemaIds);
  return (await listProtocolSchemas(projectId)).filter((schema) => (
    schema.status !== 'ignored'
    && (selected.size === 0 || selected.has(schema.id))
  ));
}

export async function updateProtocolAnalysis(schemaId: string, analysis: ProtocolAnalysisResult): Promise<void> {
  const current = await protocolSchemaById(schemaId);
  if (!current) throw new Error('协议不存在。');
  const rules = mergeAnalyzedRules(current.fieldRules, analysis.fields);
  await db.prepare(`
    UPDATE protocol_schemas SET
      status = 'analyzed', source = 'model', confidence = ?, field_rules_json = ?,
      last_error = NULL, updated_at = ?
    WHERE id = ?
  `).run(analysis.confidence, JSON.stringify(rules), now(), schemaId);
}

export async function setProtocolAnalysisError(schemaId: string, message: string): Promise<void> {
  await db.prepare('UPDATE protocol_schemas SET last_error = ?, updated_at = ? WHERE id = ?')
    .run(message.slice(0, 2_000), now(), schemaId);
}

export async function updateProtocolSchema(
  projectId: string,
  schemaId: string,
  input: { status?: unknown; fields?: unknown },
): Promise<StoredProtocolSchema> {
  const current = await protocolSchemaById(schemaId);
  if (!current || current.projectId !== projectId) throw new Error('协议不存在。');
  const status = normalizeStatus(input.status, current.status);
  const requestedFields = Array.isArray(input.fields) ? input.fields : [];
  const fields = current.fieldRules.map((field) => {
    const requested = requestedFields.map(asRecord).find((candidate) => Number(candidate.index) === field.index);
    if (!requested || field.hardProtected) return field;
    const policy = normalizePolicy(requested.policy, field.policy);
    const role = typeof requested.role === 'string' && requested.role.trim()
      ? requested.role.trim().slice(0, 80)
      : field.role;
    return {
      ...field,
      role,
      policy,
      confidence: status === 'approved' ? 1 : field.confidence,
      reason: status === 'approved' ? '人工确认的项目规则' : field.reason,
    };
  });
  await db.prepare(`
    UPDATE protocol_schemas SET
      status = ?, source = 'manual', confidence = ?, field_rules_json = ?,
      last_error = NULL, updated_at = ?
    WHERE id = ? AND project_id = ?
  `).run(
    status,
    status === 'approved' ? 1 : averageConfidence(fields),
    JSON.stringify(fields),
    now(), schemaId, projectId,
  );
  return await protocolSchemaById(schemaId) as StoredProtocolSchema;
}

async function protocolSchemaById(schemaId: string): Promise<StoredProtocolSchema | undefined> {
  const row = await db.prepare(`
    SELECT
      id, project_id AS projectId, signature, name, form, opener, closer, delimiter,
      field_count AS fieldCount, status, source, confidence, field_rules_json AS fieldRulesJson,
      declaration, examples_json AS examplesJson, occurrence_count AS occurrenceCount,
      reference_count AS referenceCount, last_error AS lastError, updated_at AS updatedAt
    FROM protocol_schemas WHERE id = ?
  `).get(schemaId) as Record<string, unknown> | undefined;
  return row ? normalizeStoredSchema(row, []) : undefined;
}

function normalizeStoredSchema(
  row: Record<string, unknown>,
  occurrences: StoredProtocolSchema['occurrences'],
): StoredProtocolSchema {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    signature: String(row.signature),
    name: String(row.name),
    form: row.form === 'square' || row.form === 'at-line' ? row.form : 'angle',
    opener: String(row.opener),
    closer: String(row.closer),
    delimiter: String(row.delimiter),
    fieldCount: Number(row.fieldCount),
    status: normalizeStatus(row.status, 'pending'),
    source: row.source === 'regex-lua' || row.source === 'model' || row.source === 'manual' ? row.source : 'local',
    confidence: Number(row.confidence) || 0,
    fieldRules: parseFieldRules(row.fieldRulesJson),
    declaration: String(row.declaration ?? ''),
    examples: safeArray(row.examplesJson).map(String),
    occurrenceCount: Number(row.occurrenceCount) || 0,
    referenceCount: Number(row.referenceCount) || 0,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
    occurrences,
    updatedAt: String(row.updatedAt),
  };
}

function mergeFieldRules(
  previous: ProtocolFieldRule[],
  discovered: ProtocolFieldRule[],
  refreshAutomaticRules: boolean,
): ProtocolFieldRule[] {
  return discovered.map((rule) => {
    if (refreshAutomaticRules) return rule;
    if (rule.hardProtected) return rule;
    const existing = previous.find((candidate) => candidate.index === rule.index);
    return existing ? {
      ...existing,
      hardProtected: false,
      reason: [...new Set([rule.reason, existing.reason].filter(Boolean))].join('；'),
    } : rule;
  });
}

function mergeAnalyzedRules(current: ProtocolFieldRule[], analyzed: ProtocolFieldRule[]): ProtocolFieldRule[] {
  return current.map((field) => {
    if (field.hardProtected) return field;
    const candidate = analyzed.find((rule) => rule.index === field.index);
    return candidate ? { ...candidate, index: field.index, hardProtected: false } : field;
  });
}

function parseFieldRules(value: unknown): ProtocolFieldRule[] {
  return safeArray(value).map((entry, arrayIndex) => {
    const field = asRecord(entry);
    return {
      index: Number(field.index) || arrayIndex + 1,
      role: String(field.role || `field_${arrayIndex + 1}`),
      policy: normalizePolicy(field.policy, 'manual'),
      confidence: Math.max(0, Math.min(1, Number(field.confidence) || 0)),
      reason: String(field.reason || ''),
      hardProtected: Boolean(field.hardProtected),
    };
  });
}

function normalizePolicy(value: unknown, fallback: ProtocolPolicy): ProtocolPolicy {
  return value === 'translate' || value === 'protect' || value === 'manual' ? value : fallback;
}

function normalizeStatus(value: unknown, fallback: ProtocolStatus): ProtocolStatus {
  return value === 'pending' || value === 'analyzed' || value === 'approved' || value === 'ignored'
    ? value
    : fallback;
}

function averageConfidence(fields: ProtocolFieldRule[]): number {
  return fields.length ? fields.reduce((total, field) => total + field.confidence, 0) / fields.length : 0;
}

function safeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
