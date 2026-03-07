import { randomUUID } from 'crypto';
import type { SNBuildResponse, SNArtifact, SNScope } from '../types/index.js';
import { ARTIFACT_TABLE, ARTIFACT_LABEL, ARTIFACT_REQUIRED_FIELDS } from './sn-context.js';
import type { ServiceNowClient } from './client.js';

// ─── Validation ─────────────────────────────────────────────────────────────

export interface ValidationError {
  artifactIndex: number;
  type: string;
  name: string;
  missing: string[];
}

export function validateBuild(build: SNBuildResponse): ValidationError[] {
  const errors: ValidationError[] = [];
  for (let i = 0; i < build.artifacts.length; i++) {
    const artifact = build.artifacts[i];
    const required = ARTIFACT_REQUIRED_FIELDS[artifact.type] ?? [];
    const missing = required.filter(
      (f) => artifact.fields[f] === undefined || artifact.fields[f] === '' || artifact.fields[f] === null
    );
    if (missing.length > 0) {
      errors.push({
        artifactIndex: i,
        type: artifact.type,
        name: String(artifact.fields['name'] ?? '(unnamed)'),
        missing,
      });
    }
  }
  return errors;
}

// ─── Expanded record model ───────────────────────────────────────────────────

/**
 * A single ServiceNow database record to be written into the update set XML
 * or pushed via the Table API. Complex artifact types (table, decision_table,
 * flow_action) expand to multiple ExpandedRecords.
 */
interface ExpandedRecord {
  table: string;
  sysId: string;
  label: string;
  fields: Record<string, unknown>;
}

// ─── Artifact expanders ──────────────────────────────────────────────────────

/** Simple 1:1 artifact → record expansion (script_include, business_rule, etc.) */
function expandSimple(artifact: SNArtifact, scopeSysId?: string): ExpandedRecord[] {
  const table = ARTIFACT_TABLE[artifact.type];
  if (!table) return [];
  const sysId = randomUUID().replace(/-/g, '');
  const fields: Record<string, unknown> = {
    ...artifact.fields,
    active: artifact.fields['active'] !== false ? 'true' : 'false',
  };
  if (scopeSysId) {
    fields['sys_scope'] = scopeSysId;
    fields['sys_package'] = scopeSysId;
  }
  return [{ table, sysId, label: ARTIFACT_LABEL[artifact.type] ?? artifact.type, fields }];
}

/** Expands a `table` artifact into sys_db_object + sys_dictionary + sys_choice records. */
function expandTable(artifact: SNArtifact, scopeSysId?: string): ExpandedRecord[] {
  const records: ExpandedRecord[] = [];
  const tableSysId = randomUUID().replace(/-/g, '');
  const tableName = String(artifact.fields['name'] ?? '');

  const dbObjFields: Record<string, unknown> = {
    name:           tableName,
    label:          String(artifact.fields['label'] ?? tableName),
    plural:         String(artifact.fields['plural'] ?? (String(artifact.fields['label'] ?? tableName) + 's')),
    is_extendable:  artifact.fields['is_extendable'] ? 'true' : 'false',
    create_access:  'true',
    read_access:    'true',
    write_access:   'true',
    delete_access:  'true',
  };
  if (artifact.fields['extends']) dbObjFields['super_class'] = String(artifact.fields['extends']);
  if (scopeSysId) { dbObjFields['sys_scope'] = scopeSysId; dbObjFields['sys_package'] = scopeSysId; }

  records.push({ table: 'sys_db_object', sysId: tableSysId, label: 'Table', fields: dbObjFields });

  // sys_dictionary entries — one per column
  const columns = Array.isArray(artifact.fields['columns'])
    ? (artifact.fields['columns'] as Record<string, unknown>[])
    : [];

  for (const col of columns) {
    const dictSysId = randomUUID().replace(/-/g, '');
    const isChoice = String(col['internal_type'] ?? '') === 'choice';

    const dictFields: Record<string, unknown> = {
      name:          tableName,
      element:       String(col['element'] ?? ''),
      column_label:  String(col['label'] ?? col['element'] ?? ''),
      internal_type: isChoice ? 'string' : String(col['internal_type'] ?? 'string'),
      max_length:    col['max_length'] ?? (isChoice || String(col['internal_type']) === 'string' ? 255 : ''),
      mandatory:     col['mandatory'] ? 'true' : 'false',
      active:        'true',
    };
    if (col['default_value'] !== undefined) dictFields['default_value'] = String(col['default_value']);
    if (col['reference'])  dictFields['reference']  = String(col['reference']);
    if (isChoice)          dictFields['choice']      = '1';
    if (scopeSysId) { dictFields['sys_scope'] = scopeSysId; dictFields['sys_package'] = scopeSysId; }

    records.push({ table: 'sys_dictionary', sysId: dictSysId, label: 'Field', fields: dictFields });

    // sys_choice entries for choice fields
    if (isChoice && Array.isArray(col['choices'])) {
      const choices = col['choices'] as (string | Record<string, unknown>)[];
      for (let ci = 0; ci < choices.length; ci++) {
        const ch = choices[ci];
        const choiceVal   = typeof ch === 'object' ? String(ch['value'] ?? '') : String(ch).toLowerCase().replace(/\s+/g, '_');
        const choiceLabel = typeof ch === 'object' ? String(ch['label'] ?? ch['value'] ?? '') : String(ch);
        const choiceSysId = randomUUID().replace(/-/g, '');
        const choiceFields: Record<string, unknown> = {
          name:     tableName,
          element:  String(col['element'] ?? ''),
          value:    choiceVal,
          label:    choiceLabel,
          sequence: ci * 100,
          inactive: 'false',
        };
        if (scopeSysId) { choiceFields['sys_scope'] = scopeSysId; choiceFields['sys_package'] = scopeSysId; }
        records.push({ table: 'sys_choice', sysId: choiceSysId, label: 'Choice', fields: choiceFields });
      }
    }
  }

  return records;
}

/**
 * Expands a `decision_table` artifact into:
 *   sys_decision + sys_decision_question + sys_decision_case + sys_decision_case_question
 */
function expandDecisionTable(artifact: SNArtifact, scopeSysId?: string): ExpandedRecord[] {
  const records: ExpandedRecord[] = [];
  const decisionSysId = randomUUID().replace(/-/g, '');

  const baseFields: Record<string, unknown> = {
    name:        String(artifact.fields['name'] ?? ''),
    label:       String(artifact.fields['label'] ?? artifact.fields['name'] ?? ''),
    description: String(artifact.fields['description'] ?? ''),
    active:      'true',
  };
  if (scopeSysId) { baseFields['sys_scope'] = scopeSysId; baseFields['sys_package'] = scopeSysId; }
  records.push({ table: 'sys_decision', sysId: decisionSysId, label: 'Decision Table', fields: baseFields });

  // Input columns (sys_decision_question)
  const inputs = Array.isArray(artifact.fields['inputs'])
    ? (artifact.fields['inputs'] as Record<string, unknown>[])
    : [];
  const inputSysIds: Record<string, string> = {};

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const inpSysId = randomUUID().replace(/-/g, '');
    const inpName = String(inp['name'] ?? inp['field'] ?? `input_${i}`);
    inputSysIds[inpName] = inpSysId;

    const qFields: Record<string, unknown> = {
      decision:      decisionSysId,
      label:         String(inp['label'] ?? inpName),
      order:         i * 100,
      question_type: String(inp['type'] ?? 'string'),
    };
    if (inp['reference']) qFields['reference_table'] = String(inp['reference']);
    if (scopeSysId) { qFields['sys_scope'] = scopeSysId; qFields['sys_package'] = scopeSysId; }
    records.push({ table: 'sys_decision_question', sysId: inpSysId, label: 'Decision Input', fields: qFields });
  }

  // Rules (sys_decision_case + sys_decision_case_question per condition)
  const rules = Array.isArray(artifact.fields['rules'])
    ? (artifact.fields['rules'] as Record<string, unknown>[])
    : [];

  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const caseSysId = randomUUID().replace(/-/g, '');

    const caseFields: Record<string, unknown> = {
      decision: decisionSysId,
      label:    String(rule['label'] ?? `Rule ${ri + 1}`),
      order:    ri * 100,
      result:   String(rule['result'] ?? ''),
    };
    if (scopeSysId) { caseFields['sys_scope'] = scopeSysId; caseFields['sys_package'] = scopeSysId; }
    records.push({ table: 'sys_decision_case', sysId: caseSysId, label: 'Decision Rule', fields: caseFields });

    const conditions = Array.isArray(rule['conditions'])
      ? (rule['conditions'] as Record<string, unknown>[])
      : [];

    for (const cond of conditions) {
      const condSysId = randomUUID().replace(/-/g, '');
      const inputName = String(cond['input'] ?? '');
      const cqFields: Record<string, unknown> = {
        case:     caseSysId,
        question: inputSysIds[inputName] ?? '',
        operator: String(cond['operator'] ?? '='),
        value:    String(cond['value'] ?? ''),
      };
      if (scopeSysId) { cqFields['sys_scope'] = scopeSysId; cqFields['sys_package'] = scopeSysId; }
      records.push({ table: 'sys_decision_case_question', sysId: condSysId, label: 'Decision Condition', fields: cqFields });
    }
  }

  return records;
}

/**
 * Expands a `flow_action` artifact into:
 *   sys_hub_action_type_definition + sys_hub_action_input + sys_hub_action_output
 */
function expandFlowAction(artifact: SNArtifact, scopeSysId?: string): ExpandedRecord[] {
  const records: ExpandedRecord[] = [];
  const actionSysId = randomUUID().replace(/-/g, '');

  const actionFields: Record<string, unknown> = {
    name:        String(artifact.fields['name'] ?? ''),
    label:       String(artifact.fields['label'] ?? artifact.fields['name'] ?? ''),
    description: String(artifact.fields['description'] ?? ''),
    category:    String(artifact.fields['category'] ?? 'Custom'),
    script:      String(artifact.fields['script'] ?? ''),
    active:      artifact.fields['active'] !== false ? 'true' : 'false',
  };
  if (scopeSysId) { actionFields['sys_scope'] = scopeSysId; actionFields['sys_package'] = scopeSysId; }
  records.push({ table: 'sys_hub_action_type_definition', sysId: actionSysId, label: 'Flow Action', fields: actionFields });

  // Input variables (sys_hub_action_input)
  const inputs = Array.isArray(artifact.fields['inputs'])
    ? (artifact.fields['inputs'] as Record<string, unknown>[])
    : [];

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const inpSysId = randomUUID().replace(/-/g, '');
    const inpFields: Record<string, unknown> = {
      action_type: actionSysId,
      name:        String(inp['name'] ?? `input_${i}`),
      label:       String(inp['label'] ?? inp['name'] ?? `Input ${i + 1}`),
      type:        String(inp['type'] ?? 'string'),
      mandatory:   inp['mandatory'] ? 'true' : 'false',
      order:       i * 100,
    };
    if (scopeSysId) { inpFields['sys_scope'] = scopeSysId; inpFields['sys_package'] = scopeSysId; }
    records.push({ table: 'sys_hub_action_input', sysId: inpSysId, label: 'Action Input', fields: inpFields });
  }

  // Output variables (sys_hub_action_output)
  const outputs = Array.isArray(artifact.fields['outputs'])
    ? (artifact.fields['outputs'] as Record<string, unknown>[])
    : [];

  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const outSysId = randomUUID().replace(/-/g, '');
    const outFields: Record<string, unknown> = {
      action_type: actionSysId,
      name:        String(out['name'] ?? `output_${i}`),
      label:       String(out['label'] ?? out['name'] ?? `Output ${i + 1}`),
      type:        String(out['type'] ?? 'string'),
      order:       i * 100,
    };
    if (scopeSysId) { outFields['sys_scope'] = scopeSysId; outFields['sys_package'] = scopeSysId; }
    records.push({ table: 'sys_hub_action_output', sysId: outSysId, label: 'Action Output', fields: outFields });
  }

  return records;
}

/** Expand any artifact into one or more ExpandedRecords. */
function expandArtifact(artifact: SNArtifact, scopeSysId?: string): ExpandedRecord[] {
  switch (artifact.type) {
    case 'table':          return expandTable(artifact, scopeSysId);
    case 'decision_table': return expandDecisionTable(artifact, scopeSysId);
    case 'flow_action':    return expandFlowAction(artifact, scopeSysId);
    default:               return expandSimple(artifact, scopeSysId);
  }
}

// ─── Scope / sys_app record ──────────────────────────────────────────────────

function buildScopeRecord(scope: SNScope, scopeSysId: string): ExpandedRecord {
  return {
    table:  'sys_app',
    sysId:  scopeSysId,
    label:  'Application',
    fields: {
      name:              scope.name,
      scope:             scope.prefix,
      short_description: scope.name,
      version:           scope.version,
      vendor:            scope.vendor ?? '',
      active:            'true',
      licensable:        'false',
      sys_class_name:    'sys_app',
    },
  };
}

// ─── XML helpers ─────────────────────────────────────────────────────────────

function escapeXML(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Wrap a string in a CDATA section, safely escaping any embedded ]]> sequences
 * by splitting them across adjacent CDATA blocks.
 */
function wrapCDATA(str: string): string {
  return `<![CDATA[${str.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * Render a single ExpandedRecord as a flat <table action="INSERT_OR_UPDATE"> element.
 *
 * This matches the format produced by ServiceNow's own "Export XML" — records
 * are direct children of <unload> rather than being wrapped in sys_update_xml/payload
 * CDATA blocks. This avoids nested-CDATA issues entirely and is accepted by the
 * "System Update Sets → Retrieved Update Sets → Import XML" path.
 *
 * Fields containing <, &, or newlines are wrapped in CDATA; all others are XML-escaped.
 * sys_id, sys_scope, sys_package, sys_class_name, and sys_update_name are always
 * emitted last and override any values carried on the expanded record.
 */
function buildFlatRecord(rec: ExpandedRecord, packageRef: string, scopeRef: string): string {
  // These are controlled entirely by the generator — skip if present in expanded fields.
  const skip = new Set(['sys_id', 'sys_scope', 'sys_package', 'sys_class_name', 'sys_update_name']);

  const lines: string[] = [];
  for (const [k, v] of Object.entries(rec.fields)) {
    if (skip.has(k) || v === undefined || v === null || Array.isArray(v) || typeof v === 'object') continue;
    const strVal = String(v);
    const content = (strVal.includes('<') || strVal.includes('&') || strVal.includes('\n'))
      ? wrapCDATA(strVal)
      : escapeXML(strVal);
    lines.push(`  <${k}>${content}</${k}>`);
  }

  // Append standard system fields
  lines.push(`  <sys_class_name>${rec.table}</sys_class_name>`);
  lines.push(`  <sys_id>${rec.sysId}</sys_id>`);
  lines.push(`  <sys_package>${packageRef}</sys_package>`);
  lines.push(`  <sys_scope>${scopeRef}</sys_scope>`);
  lines.push(`  <sys_update_name>${rec.table}_${rec.sysId}</sys_update_name>`);

  return `<${rec.table} action="INSERT_OR_UPDATE">\n${lines.join('\n')}\n</${rec.table}>`;
}

// ─── Public: XML generation ──────────────────────────────────────────────────

/**
 * Generate an importable ServiceNow update set XML file.
 *
 * Uses the flat "direct unload" format — records are direct children of <unload>
 * rather than being wrapped in sys_update_xml/payload elements. This matches the
 * format produced by ServiceNow's own Export XML feature and is accepted by the
 * "System Update Sets → Retrieved Update Sets → Import XML" import path.
 */
export function generateUpdateSetXML(build: SNBuildResponse): string {
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
  const updateSetId = randomUUID().replace(/-/g, '');
  const scopeSysId  = build.scope ? randomUUID().replace(/-/g, '') : undefined;

  const packageRef = scopeSysId ?? 'global';
  const scopeRef   = scopeSysId ?? 'global';
  const appLabel   = build.scope?.name ?? 'Global';

  const blocks: string[] = [];

  // Update set header record
  blocks.push(
    `<sys_update_set action="INSERT_OR_UPDATE">\n` +
    `  <application display_value="${escapeXML(appLabel)}">${packageRef}</application>\n` +
    `  <description>${escapeXML(build.description)}</description>\n` +
    `  <is_default>false</is_default>\n` +
    `  <name>${escapeXML(build.name)}</name>\n` +
    `  <state>complete</state>\n` +
    `  <sys_id>${updateSetId}</sys_id>\n` +
    `</sys_update_set>`
  );

  // Scoped application record (if applicable)
  if (build.scope && scopeSysId) {
    blocks.push(buildFlatRecord(buildScopeRecord(build.scope, scopeSysId), packageRef, scopeRef));
  }

  // Artifact records
  for (const artifact of build.artifacts) {
    for (const rec of expandArtifact(artifact, scopeSysId)) {
      blocks.push(buildFlatRecord(rec, packageRef, scopeRef));
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<unload unload_date="${now}">\n${blocks.join('\n')}\n</unload>`;
}

// ─── Public: Table API push ──────────────────────────────────────────────────

/** Returns a query fragment that restricts results to the target scope. */
function scopeFilter(scopeSysId: string | undefined): string {
  return `^sys_scope=${scopeSysId ?? 'global'}`;
}

/**
 * Warn if any artifact name already exists in a *different* scope on the instance.
 * Emits a warning per conflict via onWarning but does not abort the push.
 */
async function checkCrossScope(
  client: ServiceNowClient,
  artifacts: SNArtifact[],
  targetScopeSysId: string | undefined,
  onWarning: (msg: string) => void
): Promise<void> {
  const targetScope = targetScopeSysId ?? 'global';
  for (const artifact of artifacts) {
    const table = ARTIFACT_TABLE[artifact.type];
    if (!table) continue;
    const name = String(artifact.fields['name'] ?? '');
    if (!name) continue;
    try {
      const conflicts = await client.queryTable(table, {
        sysparmQuery: `name=${name}^sys_scope!=${targetScope}`,
        sysparmLimit: 1,
        sysparmFields: 'sys_id,sys_scope',
      });
      if (conflicts.length > 0) {
        const conflictScope = String((conflicts[0] as Record<string, unknown>)['sys_scope'] ?? 'unknown');
        onWarning(`  Warning: "${name}" (${artifact.type}) exists in scope "${conflictScope}" — your push targets "${targetScope}" so that record will not be touched`);
      }
    } catch {
      // Ignore check failures — don't block the push
    }
  }
}

export interface PushResult {
  type: string;
  name: string;
  sysId: string;
  action: 'created' | 'updated';
}

export interface PushError {
  type: string;
  name: string;
  error: string;
  /** True when the failure was a 403 permission error (not a data/logic error) */
  permissionDenied?: boolean;
}

export interface PushSummary {
  results: PushResult[];
  errors: PushError[];
}

/**
 * Resolve or create a scoped application on the target instance.
 * Returns the sys_id of the sys_app record, or null if creation
 * failed due to insufficient permissions (403).
 */
async function resolveOrCreateScope(client: ServiceNowClient, scope: SNScope): Promise<string | null> {
  const existing = await client.queryTable('sys_scope', {
    sysparmQuery: `scope=${scope.prefix}`,
    sysparmLimit: 1,
    sysparmFields: 'sys_id',
  });
  if (existing.length > 0) return String(existing[0].sys_id);

  try {
    const created = await client.createRecord('sys_app', {
      name:              scope.name,
      scope:             scope.prefix,
      short_description: scope.name,
      version:           scope.version,
      vendor:            scope.vendor ?? '',
      active:            true,
      licensable:        false,
      sys_class_name:    'sys_app',
    });
    return String(created.sys_id);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg.includes('403')) {
      // Scope creation requires admin/delegated_developer role.
      // Degrade gracefully — artifacts will be stamped to global scope but
      // the XML import will carry the full scoped application record.
      return null;
    }
    throw err;
  }
}

/**
 * Upsert a single ExpandedRecord via the Table API.
 * Looks up by name field where possible; falls back to unconditional create.
 */
async function pushRecord(
  client: ServiceNowClient,
  record: ExpandedRecord,
  parentSysId?: string
): Promise<PushResult> {
  const name = String(record.fields['name'] ?? '');

  // Build lookup query — child records (sys_dictionary, sys_choice, etc.) need parent context
  let lookupQuery = name ? `name=${name}` : '';

  if (record.table === 'sys_dictionary') {
    const element = String(record.fields['element'] ?? '');
    lookupQuery = `name=${name}^element=${element}`;
  } else if (record.table === 'sys_choice') {
    const element = String(record.fields['element'] ?? '');
    const value   = String(record.fields['value']   ?? '');
    lookupQuery = `name=${name}^element=${element}^value=${value}`;
  } else if (parentSysId && (
    record.table === 'sys_decision_question' ||
    record.table === 'sys_decision_case' ||
    record.table === 'sys_hub_action_input' ||
    record.table === 'sys_hub_action_output'
  )) {
    // Child records are always deleted+recreated in the multi-record push path;
    // this branch should not normally be reached.
    lookupQuery = '';
  }

  // Flatten fields: strip arrays/objects (child records handled separately)
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record.fields)) {
    if (v !== undefined && v !== null && !Array.isArray(v) && typeof v !== 'object') {
      payload[k] = v;
    }
  }

  if (lookupQuery) {
    const existing = await client.queryTable(record.table, {
      sysparmQuery: lookupQuery,
      sysparmLimit: 1,
      sysparmFields: 'sys_id',
    });
    if (existing.length > 0) {
      const sysId = String(existing[0].sys_id);
      await client.updateRecord(record.table, sysId, payload);
      return { type: record.label, name: name || record.table, sysId, action: 'updated' };
    }
  }

  const created = await client.createRecord(record.table, payload);
  return { type: record.label, name: name || record.table, sysId: String(created.sys_id), action: 'created' };
}

/**
 * Push all artifacts directly to a ServiceNow instance via the Table API.
 *
 * For multi-record artifacts (table, decision_table, flow_action):
 *   - Upserts the parent record, obtains its sys_id
 *   - Deletes existing child records for that parent, then recreates them
 *
 * If the build has a scope, resolves or creates the scoped application first
 * and stamps sys_scope/sys_package on every record.
 */
export async function pushArtifacts(
  client: ServiceNowClient,
  build: SNBuildResponse,
  onProgress?: (msg: string) => void
): Promise<PushSummary> {
  const results: PushResult[] = [];
  const errors: PushError[] = [];

  // Resolve scope if present
  let scopeSysId: string | undefined;
  if (build.scope) {
    try {
      onProgress?.(`  Resolving scope: ${build.scope.prefix}`);
      const resolved = await resolveOrCreateScope(client, build.scope);
      if (resolved) {
        scopeSysId = resolved;
        onProgress?.(`  Scope sys_id: ${scopeSysId}`);
      } else {
        onProgress?.(`  Warning: Could not create scope "${build.scope.prefix}" — admin role required. Artifacts pushed to global scope; use the XML to import the full scoped application.`);
      }
    } catch (err) {
      errors.push({
        type: 'scope',
        name: build.scope.prefix,
        error: err instanceof Error ? err.message : String(err),
        permissionDenied: false,
      });
    }
  }

  // Warn about cross-scope name collisions before touching anything
  await checkCrossScope(client, build.artifacts, scopeSysId, (msg: string) => onProgress?.(msg));

  for (const artifact of build.artifacts) {
    const artifactName = String(artifact.fields['name'] ?? artifact.type);
    onProgress?.(`  Pushing ${artifact.type}: ${artifactName}`);

    try {
      if (artifact.type === 'table') {
        await pushTableArtifact(client, artifact, scopeSysId, results, errors, onProgress);
      } else if (artifact.type === 'decision_table') {
        await pushDecisionTableArtifact(client, artifact, scopeSysId, results, errors, onProgress);
      } else if (artifact.type === 'flow_action') {
        await pushFlowActionArtifact(client, artifact, scopeSysId, results, errors, onProgress);
      } else {
        // Simple single-record artifact
        const table = ARTIFACT_TABLE[artifact.type];
        if (!table) {
          errors.push({ type: artifact.type, name: artifactName, error: `Unknown artifact type: ${artifact.type}` });
          continue;
        }
        const payload: Record<string, unknown> = { ...artifact.fields };
        if (payload['active'] === undefined) payload['active'] = true;
        if (scopeSysId) { payload['sys_scope'] = scopeSysId; payload['sys_package'] = scopeSysId; }

        const existing = await client.queryTable(table, {
          sysparmQuery: `name=${artifactName}${scopeFilter(scopeSysId)}`,
          sysparmLimit: 1,
          sysparmFields: 'sys_id',
        });

        if (existing.length > 0) {
          const sysId = String(existing[0].sys_id);
          await client.updateRecord(table, sysId, payload);
          results.push({ type: artifact.type, name: artifactName, sysId, action: 'updated' });
        } else {
          const created = await client.createRecord(table, payload);
          results.push({ type: artifact.type, name: artifactName, sysId: String(created.sys_id), action: 'created' });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isPermission = errMsg.includes('403');
      errors.push({
        type: artifact.type,
        name: artifactName,
        error: errMsg,
        permissionDenied: isPermission,
      });
    }
  }

  return { results, errors };
}

async function pushTableArtifact(
  client: ServiceNowClient,
  artifact: SNArtifact,
  scopeSysId: string | undefined,
  results: PushResult[],
  errors: PushError[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const tableName = String(artifact.fields['name'] ?? '');

  // Upsert sys_db_object
  const dbObjPayload: Record<string, unknown> = {
    name:          tableName,
    label:         String(artifact.fields['label'] ?? tableName),
    plural:        String(artifact.fields['plural'] ?? (String(artifact.fields['label'] ?? tableName) + 's')),
    is_extendable: artifact.fields['is_extendable'] ? true : false,
  };
  if (artifact.fields['extends']) dbObjPayload['super_class'] = String(artifact.fields['extends']);
  if (scopeSysId) { dbObjPayload['sys_scope'] = scopeSysId; dbObjPayload['sys_package'] = scopeSysId; }

  const existingTable = await client.queryTable('sys_db_object', {
    sysparmQuery: `name=${tableName}${scopeFilter(scopeSysId)}`,
    sysparmLimit: 1,
    sysparmFields: 'sys_id',
  });

  let tableSysId: string;
  try {
    if (existingTable.length > 0) {
      tableSysId = String(existingTable[0].sys_id);
      await client.updateRecord('sys_db_object', tableSysId, dbObjPayload);
      results.push({ type: 'Table', name: tableName, sysId: tableSysId, action: 'updated' });
    } else {
      const created = await client.createRecord('sys_db_object', dbObjPayload);
      tableSysId = String(created.sys_id);
      results.push({ type: 'Table', name: tableName, sysId: tableSysId, action: 'created' });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const hint = errMsg.includes('403')
      ? ' (requires admin or delegated_developer role — use the update-set XML to import instead)'
      : '';
    throw new Error(errMsg + hint);
  }

  // Upsert columns
  const columns = Array.isArray(artifact.fields['columns'])
    ? (artifact.fields['columns'] as Record<string, unknown>[])
    : [];

  for (const col of columns) {
    const element = String(col['element'] ?? '');
    const isChoice = String(col['internal_type'] ?? '') === 'choice';
    onProgress?.(`    column: ${tableName}.${element}`);

    const dictPayload: Record<string, unknown> = {
      name:          tableName,
      element:       element,
      column_label:  String(col['label'] ?? element),
      internal_type: isChoice ? 'string' : String(col['internal_type'] ?? 'string'),
      max_length:    col['max_length'] ?? (isChoice || String(col['internal_type']) === 'string' ? 255 : ''),
      mandatory:     col['mandatory'] ? true : false,
      active:        true,
    };
    if (col['default_value'] !== undefined) dictPayload['default_value'] = String(col['default_value']);
    if (col['reference'])  dictPayload['reference']  = String(col['reference']);
    if (isChoice)          dictPayload['choice']      = 1;
    if (scopeSysId) { dictPayload['sys_scope'] = scopeSysId; dictPayload['sys_package'] = scopeSysId; }

    const existingDict = await client.queryTable('sys_dictionary', {
      sysparmQuery: `name=${tableName}^element=${element}${scopeFilter(scopeSysId)}`,
      sysparmLimit: 1,
      sysparmFields: 'sys_id',
    });

    if (existingDict.length > 0) {
      await client.updateRecord('sys_dictionary', String(existingDict[0].sys_id), dictPayload);
    } else {
      await client.createRecord('sys_dictionary', dictPayload);
    }

    // Choice list values
    if (isChoice && Array.isArray(col['choices'])) {
      const choices = col['choices'] as (string | Record<string, unknown>)[];
      for (let ci = 0; ci < choices.length; ci++) {
        const ch = choices[ci];
        const choiceVal   = typeof ch === 'object' ? String(ch['value'] ?? '') : String(ch).toLowerCase().replace(/\s+/g, '_');
        const choiceLabel = typeof ch === 'object' ? String(ch['label'] ?? ch['value'] ?? '') : String(ch);

        const choicePayload: Record<string, unknown> = {
          name: tableName, element, value: choiceVal, label: choiceLabel,
          sequence: ci * 100, inactive: false,
        };
        if (scopeSysId) { choicePayload['sys_scope'] = scopeSysId; choicePayload['sys_package'] = scopeSysId; }

        const existingChoice = await client.queryTable('sys_choice', {
          sysparmQuery: `name=${tableName}^element=${element}^value=${choiceVal}${scopeFilter(scopeSysId)}`,
          sysparmLimit: 1,
          sysparmFields: 'sys_id',
        });
        if (existingChoice.length > 0) {
          await client.updateRecord('sys_choice', String(existingChoice[0].sys_id), choicePayload);
        } else {
          await client.createRecord('sys_choice', choicePayload);
        }
      }
    }
  }
}

async function pushDecisionTableArtifact(
  client: ServiceNowClient,
  artifact: SNArtifact,
  scopeSysId: string | undefined,
  results: PushResult[],
  errors: PushError[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const dtName = String(artifact.fields['name'] ?? '');

  const dtPayload: Record<string, unknown> = {
    name:        dtName,
    label:       String(artifact.fields['label'] ?? dtName),
    description: String(artifact.fields['description'] ?? ''),
    active:      true,
  };
  if (scopeSysId) { dtPayload['sys_scope'] = scopeSysId; dtPayload['sys_package'] = scopeSysId; }

  const existing = await client.queryTable('sys_decision', {
    sysparmQuery: `name=${dtName}${scopeFilter(scopeSysId)}`,
    sysparmLimit: 1,
    sysparmFields: 'sys_id',
  });

  // Determine action and create/update the parent record.
  // results.push is deferred to the end so a child-record failure
  // doesn't produce both a "created" result AND an error entry.
  let decisionSysId: string;
  let action: 'created' | 'updated';

  try {
    if (existing.length > 0) {
      decisionSysId = String(existing[0].sys_id);
      await client.updateRecord('sys_decision', decisionSysId, dtPayload);
      action = 'updated';

      // Attempt to clean up child records before recreating — failures are non-fatal
      onProgress?.(`    Removing existing rules for: ${dtName}`);
      for (const childTable of ['sys_decision_question', 'sys_decision_case']) {
        try {
          const children = await client.queryTable(childTable, {
            sysparmQuery: `decision=${decisionSysId}`,
            sysparmFields: 'sys_id',
            sysparmLimit: 500,
          });
          for (const child of children) {
            await client.deleteRecord(childTable, String(child.sys_id)).catch(() => undefined);
          }
        } catch {
          // Table may not be accessible via Table API — skip silently
        }
      }
    } else {
      const created = await client.createRecord('sys_decision', dtPayload);
      decisionSysId = String(created.sys_id);
      action = 'created';
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const hint = errMsg.includes('403')
      ? ' (requires admin or developer role — use the update-set XML to import instead)'
      : '';
    throw new Error(errMsg + hint);
  }

  // Create input columns — each wrapped individually so one failure doesn't abort the rest
  const inputs = Array.isArray(artifact.fields['inputs'])
    ? (artifact.fields['inputs'] as Record<string, unknown>[])
    : [];
  const inputSysIds: Record<string, string> = {};
  let childWarnings = 0;

  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const inpName = String(inp['name'] ?? inp['field'] ?? `input_${i}`);
    const qPayload: Record<string, unknown> = {
      decision: decisionSysId, label: String(inp['label'] ?? inpName),
      order: i * 100, question_type: String(inp['type'] ?? 'string'),
    };
    if (inp['reference']) qPayload['reference_table'] = String(inp['reference']);
    if (scopeSysId) { qPayload['sys_scope'] = scopeSysId; qPayload['sys_package'] = scopeSysId; }
    try {
      const created = await client.createRecord('sys_decision_question', qPayload);
      inputSysIds[inpName] = String(created.sys_id);
    } catch (err) {
      childWarnings++;
      onProgress?.(`    Warning: could not create decision column "${inpName}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Create rules — each case and its conditions are individually guarded
  const rules = Array.isArray(artifact.fields['rules'])
    ? (artifact.fields['rules'] as Record<string, unknown>[])
    : [];

  for (let ri = 0; ri < rules.length; ri++) {
    const rule = rules[ri];
    const casePayload: Record<string, unknown> = {
      decision: decisionSysId, label: String(rule['label'] ?? `Rule ${ri + 1}`),
      order: ri * 100, result: String(rule['result'] ?? ''),
    };
    if (scopeSysId) { casePayload['sys_scope'] = scopeSysId; casePayload['sys_package'] = scopeSysId; }

    let caseSysId: string | null = null;
    try {
      const createdCase = await client.createRecord('sys_decision_case', casePayload);
      caseSysId = String(createdCase.sys_id);
    } catch (err) {
      childWarnings++;
      const errMsg = err instanceof Error ? err.message : String(err);
      // 400 "Invalid table" means the Decision Builder child tables aren't accessible via Table API —
      // the parent record is still usable. Suggest using the update-set XML path instead.
      if (errMsg.includes('Invalid table') || errMsg.includes('400')) {
        onProgress?.(`    Warning: sys_decision_case is not accessible via Table API on this instance.`);
        onProgress?.(`    Tip: use the exported update-set XML to import decision table rules via System Update Sets.`);
      } else {
        onProgress?.(`    Warning: could not create rule "${rule['label'] ?? ri + 1}" — ${errMsg}`);
      }
      continue;
    }

    const conditions = Array.isArray(rule['conditions'])
      ? (rule['conditions'] as Record<string, unknown>[])
      : [];
    for (const cond of conditions) {
      const inputName = String(cond['input'] ?? '');
      const cqPayload: Record<string, unknown> = {
        case: caseSysId, question: inputSysIds[inputName] ?? '',
        operator: String(cond['operator'] ?? '='), value: String(cond['value'] ?? ''),
      };
      if (scopeSysId) { cqPayload['sys_scope'] = scopeSysId; cqPayload['sys_package'] = scopeSysId; }
      try {
        await client.createRecord('sys_decision_case_question', cqPayload);
      } catch {
        childWarnings++;
      }
    }
  }

  // Register the parent record result — deferred here so failures above don't create duplicates
  const label = childWarnings > 0
    ? `Decision Table (${childWarnings} child record(s) skipped — use XML import for full fidelity)`
    : 'Decision Table';
  results.push({ type: label, name: dtName, sysId: decisionSysId, action });
}

async function pushFlowActionArtifact(
  client: ServiceNowClient,
  artifact: SNArtifact,
  scopeSysId: string | undefined,
  results: PushResult[],
  errors: PushError[],
  onProgress?: (msg: string) => void
): Promise<void> {
  const actionName = String(artifact.fields['name'] ?? '');

  const actionPayload: Record<string, unknown> = {
    name:        actionName,
    label:       String(artifact.fields['label'] ?? actionName),
    description: String(artifact.fields['description'] ?? ''),
    category:    String(artifact.fields['category'] ?? 'Custom'),
    script:      String(artifact.fields['script'] ?? ''),
    active:      true,
  };
  if (scopeSysId) { actionPayload['sys_scope'] = scopeSysId; actionPayload['sys_package'] = scopeSysId; }

  const existing = await client.queryTable('sys_hub_action_type_definition', {
    sysparmQuery: `name=${actionName}${scopeFilter(scopeSysId)}`,
    sysparmLimit: 1,
    sysparmFields: 'sys_id',
  });

  // results.push is deferred to the end to avoid duplicate result + error entries
  // when child-record creation fails after the parent succeeds.
  let actionSysId: string;
  let action: 'created' | 'updated';

  try {
    if (existing.length > 0) {
      actionSysId = String(existing[0].sys_id);
      await client.updateRecord('sys_hub_action_type_definition', actionSysId, actionPayload);
      action = 'updated';

      // Remove existing I/O variables before recreating
      onProgress?.(`    Removing existing variables for: ${actionName}`);
      for (const childTable of ['sys_hub_action_input', 'sys_hub_action_output']) {
        try {
          const children = await client.queryTable(childTable, {
            sysparmQuery: `action_type=${actionSysId}`,
            sysparmFields: 'sys_id',
            sysparmLimit: 100,
          });
          for (const child of children) {
            await client.deleteRecord(childTable, String(child.sys_id)).catch(() => undefined);
          }
        } catch {
          // Non-fatal — child cleanup failure shouldn't block the push
        }
      }
    } else {
      const created = await client.createRecord('sys_hub_action_type_definition', actionPayload);
      actionSysId = String(created.sys_id);
      action = 'created';
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // 403 on sys_hub_action_type_definition is a common permissions issue on PDIs and restricted instances.
    // The Flow Designer / IntegrationHub Installer role is required.
    const hint = errMsg.includes('403')
      ? ' (requires Flow Designer / IntegrationHub roles — use the update-set XML to import instead)'
      : '';
    throw new Error(errMsg + hint);
  }

  const inputs = Array.isArray(artifact.fields['inputs'])
    ? (artifact.fields['inputs'] as Record<string, unknown>[])
    : [];
  for (let i = 0; i < inputs.length; i++) {
    const inp = inputs[i];
    const inpPayload: Record<string, unknown> = {
      action_type: actionSysId, name: String(inp['name'] ?? `input_${i}`),
      label: String(inp['label'] ?? inp['name'] ?? `Input ${i + 1}`),
      type: String(inp['type'] ?? 'string'), mandatory: inp['mandatory'] ? true : false, order: i * 100,
    };
    if (scopeSysId) { inpPayload['sys_scope'] = scopeSysId; inpPayload['sys_package'] = scopeSysId; }
    try {
      await client.createRecord('sys_hub_action_input', inpPayload);
    } catch (err) {
      onProgress?.(`    Warning: could not create input "${inp['name'] ?? i}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const outputs = Array.isArray(artifact.fields['outputs'])
    ? (artifact.fields['outputs'] as Record<string, unknown>[])
    : [];
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    const outPayload: Record<string, unknown> = {
      action_type: actionSysId, name: String(out['name'] ?? `output_${i}`),
      label: String(out['label'] ?? out['name'] ?? `Output ${i + 1}`),
      type: String(out['type'] ?? 'string'), order: i * 100,
    };
    if (scopeSysId) { outPayload['sys_scope'] = scopeSysId; outPayload['sys_package'] = scopeSysId; }
    try {
      await client.createRecord('sys_hub_action_output', outPayload);
    } catch (err) {
      onProgress?.(`    Warning: could not create output "${out['name'] ?? i}" — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Register result only after all operations complete (deferred to avoid duplicate result+error)
  results.push({ type: 'Flow Action', name: actionName, sysId: actionSysId, action });
}
