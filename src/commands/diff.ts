import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { requireActiveInstance, loadConfig } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DictField {
  element: string;            // field name
  internal_type: string;      // field type (e.g. string, boolean, reference)
  column_label: string;       // display label
  max_length: string;
  mandatory: string;          // 'true' | 'false'
  read_only: string;
  reference: string;          // referenced table (if type=reference)
  active: string;
}

interface ScriptRecord {
  name: string;
  sys_id: string;
  [field: string]: string;
}

// Script-bearing tables: { table, nameField, scriptField }
const SCRIPT_TABLES = [
  { table: 'sys_script_include', nameField: 'name', scriptField: 'script' },
  { table: 'sys_script',         nameField: 'name', scriptField: 'script' },
  { table: 'sys_script_client',  nameField: 'name', scriptField: 'script' },
  { table: 'sys_ui_action',      nameField: 'name', scriptField: 'script' },
  { table: 'sysauto_script',     nameField: 'name', scriptField: 'script' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const obj = v as Record<string, string>;
    return obj['value'] ?? obj['display_value'] ?? '';
  }
  return String(v).trim();
}

async function fetchFields(
  client: ServiceNowClient,
  table: string
): Promise<Map<string, DictField>> {
  const records = await client.queryTable('sys_dictionary', {
    sysparmQuery: `name=${table}^elementISNOTEMPTY`,
    sysparmFields: 'element,internal_type,column_label,max_length,mandatory,read_only,reference,active',
    sysparmLimit: 500,
  }) as unknown as DictField[];

  const map = new Map<string, DictField>();
  for (const r of records) {
    const el = str(r.element);
    if (el) map.set(el, r);
  }
  return map;
}

async function fetchScripts(
  client: ServiceNowClient,
  table: string,
  nameField: string,
  scriptField: string,
  scope?: string
): Promise<Map<string, string>> {
  const query = scope
    ? `sys_scope.scope=${scope}`
    : `sys_scope.scopeISNOTEMPTY`;

  const records = await client.queryTable(table, {
    sysparmQuery: query,
    sysparmFields: `sys_id,${nameField},${scriptField}`,
    sysparmLimit: 500,
  }) as unknown as ScriptRecord[];

  const map = new Map<string, string>();
  for (const r of records) {
    const name = str(r[nameField]);
    const script = str(r[scriptField]);
    if (name) map.set(name, script);
  }
  return map;
}

// ---------------------------------------------------------------------------
// JSON diff result types
// ---------------------------------------------------------------------------

interface FieldDiffRow {
  element: string;
  status: 'added' | 'removed' | 'changed';
  detail: string;
}

interface ScriptDiffEntry {
  name: string;
  status: 'added' | 'removed' | 'changed';
  /** Present when status is 'changed' — array of changed line hunks */
  hunks?: Array<{ lineStart: number; lineEnd: number; source: string[]; target: string[] }>;
}

interface DiffResult {
  source: string;
  target: string;
  scope?: string;
  generatedAt: string;
  fields?: { table: string; rows: FieldDiffRow[] };
  scripts?: Array<{ table: string; entries: ScriptDiffEntry[] }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute line diff hunks between two scripts. Returns null if identical. */
function computeLineDiff(
  srcScript: string,
  tgtScript: string
): Array<{ lineStart: number; lineEnd: number; source: string[]; target: string[] }> | null {
  const srcLines = srcScript.split('\n');
  const tgtLines = tgtScript.split('\n');
  const maxLen = Math.max(srcLines.length, tgtLines.length);

  let firstDiff = -1, lastDiff = -1;
  for (let i = 0; i < maxLen; i++) {
    if (srcLines[i] !== tgtLines[i]) {
      if (firstDiff === -1) firstDiff = i;
      lastDiff = i;
    }
  }
  if (firstDiff === -1) return null;

  const CONTEXT = 2;
  const start = Math.max(0, firstDiff - CONTEXT);
  const end   = Math.min(maxLen - 1, lastDiff + CONTEXT);

  return [{
    lineStart: start + 1,
    lineEnd:   end + 1,
    source:    srcLines.slice(start, end + 1),
    target:    tgtLines.slice(start, end + 1),
  }];
}

// Simple unified-diff-style line comparison (terminal output)
function lineDiff(
  label: string,
  srcScript: string,
  tgtScript: string,
  sourceAlias: string,
  targetAlias: string,
  out: (line: string) => void
): void {
  const hunks = computeLineDiff(srcScript, tgtScript);
  if (!hunks) return;

  const { lineStart, lineEnd, source, target } = hunks[0];

  out(`\n  ${chalk.bold(label)}`);
  out(`  ${chalk.dim(`--- ${sourceAlias}`)}`);
  out(`  ${chalk.dim(`+++ ${targetAlias}`)}`);
  out(`  ${chalk.dim(`@@ lines ${lineStart}–${lineEnd} @@`)}`);

  const maxLen = Math.max(source.length, target.length);
  for (let i = 0; i < maxLen; i++) {
    const src = source[i] ?? '';
    const tgt = target[i] ?? '';
    if (src === tgt) {
      out(`  ${chalk.dim(' ' + src)}`);
    } else {
      if (i < source.length) out(`  ${chalk.red('-' + src)}`);
      if (i < target.length) out(`  ${chalk.green('+' + tgt)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Field comparison — returns data rows and optionally prints
// ---------------------------------------------------------------------------

function compareFields(
  table: string,
  src: Map<string, DictField>,
  tgt: Map<string, DictField>,
  sourceAlias: string,
  targetAlias: string,
  markdownMode: boolean,
  out: (line: string) => void
): FieldDiffRow[] {
  const allFields = new Set([...src.keys(), ...tgt.keys()]);
  const rows: FieldDiffRow[] = [];

  for (const el of [...allFields].sort()) {
    const srcF = src.get(el);
    const tgtF = tgt.get(el);

    if (!srcF) {
      rows.push({ element: el, status: 'added', detail: `type=${str(tgtF!.internal_type)}` });
    } else if (!tgtF) {
      rows.push({ element: el, status: 'removed', detail: `type=${str(srcF.internal_type)}` });
    } else {
      const changes: string[] = [];
      const check = (key: keyof DictField, label: string) => {
        const a = str(srcF[key]);
        const b = str(tgtF[key]);
        if (a !== b) changes.push(`${label}: ${a} → ${b}`);
      };
      check('internal_type', 'type');
      check('max_length', 'max_length');
      check('mandatory', 'mandatory');
      check('read_only', 'read_only');
      check('reference', 'reference');
      check('active', 'active');
      if (changes.length > 0) {
        rows.push({ element: el, status: 'changed', detail: changes.join(', ') });
      }
    }
  }

  if (rows.length === 0) {
    if (markdownMode) {
      out(`\n### Schema: \`${table}\``);
      out(`\nNo field differences found.`);
    } else {
      out('');
      out(chalk.green(`  No field differences in ${table}`));
    }
    return rows;
  }

  if (markdownMode) {
    out(`\n### Schema: \`${table}\``);
    out(`\n| Field | Status | Detail |`);
    out(`|-------|--------|--------|`);
    for (const r of rows) {
      const icon = r.status === 'added' ? '➕' : r.status === 'removed' ? '➖' : '✏️';
      out(`| \`${r.element}\` | ${icon} ${r.status} | ${r.detail} |`);
    }
  } else {
    out('');
    out(chalk.bold.cyan(`  Schema diff: ${table}`));
    out(chalk.dim(`  ${'─'.repeat(50)}`));

    const elW = Math.max(8, ...rows.map(r => r.element.length)) + 2;
    const stW = 10;

    out(`  ${'Field'.padEnd(elW)}${'Status'.padEnd(stW)}Detail`);
    out(chalk.dim(`  ${'─'.repeat(70)}`));

    for (const r of rows) {
      const statusStr =
        r.status === 'added'   ? chalk.green(r.status.padEnd(stW))  :
        r.status === 'removed' ? chalk.red(r.status.padEnd(stW))    :
                                  chalk.yellow(r.status.padEnd(stW));
      out(`  ${r.element.padEnd(elW)}${statusStr}${chalk.dim(r.detail)}`);
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function diffCommand(): Command {
  const cmd = new Command('diff')
    .description('Compare schema and scripts between two instances')
    .argument('<table>', 'Table to compare (for --fields). Use "all" with --scripts to compare all script tables.')
    .requiredOption('--against <alias>', 'Alias of the target instance to compare against')
    .option('--fields', 'Compare sys_dictionary field definitions')
    .option('--scripts', 'Compare script field content across script-bearing tables')
    .option('--scope <scope>', 'Filter scripts by application scope prefix (e.g. x_myco_myapp)')
    .option('--markdown', 'Output results as Markdown (for pasting into docs/tickets)')
    .option('--json', 'Output results as JSON (overrides --markdown)')
    .option('--output <file>', 'Write output to a file instead of stdout')
    .action(async (table: string, opts: {
      against: string;
      fields?: boolean;
      scripts?: boolean;
      scope?: string;
      markdown?: boolean;
      json?: boolean;
      output?: string;
    }) => {
      if (!opts.fields && !opts.scripts) {
        console.error(chalk.red('Specify at least one of --fields or --scripts'));
        process.exit(1);
      }

      const config = loadConfig();
      const sourceInstance = requireActiveInstance();
      const targetInstance = config.instances[opts.against];

      if (!targetInstance) {
        console.error(chalk.red(`Instance "${opts.against}" not found. Run \`snow instance list\` to see available instances.`));
        process.exit(1);
      }

      const sourceAlias = sourceInstance.alias;
      const targetAlias = targetInstance.alias;

      const sourceClient = new ServiceNowClient(sourceInstance);
      const targetClient = new ServiceNowClient(targetInstance);

      // When writing to a file, capture all output; otherwise write to stdout
      const outputLines: string[] = [];
      const isFileOutput = !!opts.output;
      const out = (line: string): void => {
        if (isFileOutput) {
          outputLines.push(line);
        } else {
          console.log(line);
        }
      };

      // JSON mode — collect structured data and output at the end
      const jsonResult: DiffResult = {
        source: sourceAlias,
        target: targetAlias,
        scope: opts.scope,
        generatedAt: new Date().toISOString(),
      };

      const markdownMode = opts.markdown && !opts.json;

      if (!opts.json) {
        if (!markdownMode) {
          out('');
          out(chalk.dim('─'.repeat(52)));
          out(`  ${chalk.bold('snow diff')}  ·  ${chalk.cyan(sourceAlias)} ${chalk.dim('→')} ${chalk.cyan(targetAlias)}`);
          if (opts.scope) out(`  ${chalk.dim('scope:')} ${opts.scope}`);
          out(chalk.dim('─'.repeat(52)));
        } else {
          out(`# snow diff: \`${sourceAlias}\` → \`${targetAlias}\``);
          if (opts.scope) out(`\n**Scope:** \`${opts.scope}\``);
        }
      }

      // -----------------------------------------------------------------------
      // Field diff
      // -----------------------------------------------------------------------
      if (opts.fields && table !== 'all') {
        const spinner = ora(`Fetching schema for ${table}...`).start();

        const [srcFields, tgtFields] = await Promise.all([
          fetchFields(sourceClient, table).catch((e: Error) => { spinner.stop(); throw e; }),
          fetchFields(targetClient, table).catch((e: Error) => { spinner.stop(); throw e; }),
        ]);

        spinner.stop();

        if (opts.json) {
          // Collect into JSON result — compareFields with a no-op out
          const rows = compareFields(table, srcFields, tgtFields, sourceAlias, targetAlias, false, () => undefined);
          jsonResult.fields = { table, rows };
        } else {
          compareFields(table, srcFields, tgtFields, sourceAlias, targetAlias, markdownMode ?? false, out);
        }
      }

      // -----------------------------------------------------------------------
      // Script diff
      // -----------------------------------------------------------------------
      if (opts.scripts) {
        const tables = table === 'all'
          ? SCRIPT_TABLES
          : SCRIPT_TABLES.filter(t => t.table === table);

        if (tables.length === 0 && !opts.json) {
          out(chalk.yellow(`  Note: "${table}" is not a known script-bearing table. Script diff skipped.`));
          out(chalk.dim(`  Known script tables: ${SCRIPT_TABLES.map(t => t.table).join(', ')}`));
        }

        if (opts.json) jsonResult.scripts = [];

        for (const { table: tblName, nameField, scriptField } of tables) {
          const spinner = ora(`Fetching scripts from ${tblName}...`).start();

          const [srcMap, tgtMap] = await Promise.all([
            fetchScripts(sourceClient, tblName, nameField, scriptField, opts.scope),
            fetchScripts(targetClient, tblName, nameField, scriptField, opts.scope),
          ]).catch((e: Error) => { spinner.stop(); throw e; });

          spinner.stop();

          const allNames = new Set([...srcMap.keys(), ...tgtMap.keys()]);

          if (allNames.size === 0) {
            if (!opts.json && !markdownMode) out(chalk.dim(`\n  No scripts found in ${tblName}`));
            continue;
          }

          const added: string[]   = [];
          const removed: string[] = [];
          const changed: string[] = [];
          let sameCount = 0;

          for (const name of [...allNames].sort()) {
            const srcScript = srcMap.get(name);
            const tgtScript = tgtMap.get(name);

            if (!srcScript && tgtScript !== undefined)    added.push(name);
            else if (srcScript !== undefined && !tgtScript) removed.push(name);
            else if (srcScript !== tgtScript)             changed.push(name);
            else                                          sameCount++;
          }

          if (opts.json) {
            const entries: ScriptDiffEntry[] = [
              ...added.map(n => ({ name: n, status: 'added' as const })),
              ...removed.map(n => ({ name: n, status: 'removed' as const })),
              ...changed.map(n => {
                const hunks = computeLineDiff(srcMap.get(n)!, tgtMap.get(n)!) ?? [];
                return { name: n, status: 'changed' as const, hunks };
              }),
            ];
            jsonResult.scripts!.push({ table: tblName, entries });
            continue;
          }

          if (markdownMode) {
            out(`\n### Scripts: \`${tblName}\``);
            if (added.length === 0 && removed.length === 0 && changed.length === 0) {
              out(`\nAll ${sameCount} scripts are identical.`);
              continue;
            }
            if (added.length)   out(`\n**Added in ${targetAlias}:** ${added.map(n => `\`${n}\``).join(', ')}`);
            if (removed.length) out(`\n**Removed in ${targetAlias}:** ${removed.map(n => `\`${n}\``).join(', ')}`);
            if (changed.length) {
              out(`\n**Changed (${changed.length}):**`);
              for (const name of changed) {
                lineDiff(name, srcMap.get(name)!, tgtMap.get(name)!, sourceAlias, targetAlias, out);
              }
            }
          } else {
            out('');
            out(chalk.bold.cyan(`  Script diff: ${tblName}`));
            out(chalk.dim(`  ${'─'.repeat(50)}`));

            if (added.length === 0 && removed.length === 0 && changed.length === 0) {
              out(chalk.green(`  All ${sameCount} scripts are identical.`));
              continue;
            }

            for (const name of added)   out(`  ${chalk.green('+')} ${name} ${chalk.dim(`(only in ${targetAlias})`)}`);
            for (const name of removed) out(`  ${chalk.red('-')} ${name} ${chalk.dim(`(only in ${sourceAlias})`)}`);
            for (const name of changed) {
              out(`  ${chalk.yellow('~')} ${name}`);
              lineDiff(name, srcMap.get(name)!, tgtMap.get(name)!, sourceAlias, targetAlias, out);
            }
            if (sameCount > 0) out(chalk.dim(`\n  (${sameCount} scripts identical, not shown)`));
          }
        }
      }

      // -----------------------------------------------------------------------
      // Emit output
      // -----------------------------------------------------------------------
      if (opts.json) {
        const jsonStr = JSON.stringify(jsonResult, null, 2);
        if (opts.output) {
          writeFileSync(opts.output, jsonStr, 'utf-8');
          console.log(chalk.green(`✔ JSON diff written to ${opts.output}`));
        } else {
          console.log(jsonStr);
        }
        return;
      }

      if (!opts.json && !markdownMode) {
        out('');
        out(chalk.dim('─'.repeat(52)));
        out('');
      }

      if (isFileOutput) {
        // Strip ANSI codes from file output for markdown/plain text
        const plain = outputLines.map(l => l.replace(/\x1B\[[0-9;]*m/g, '')).join('\n');
        writeFileSync(opts.output!, plain, 'utf-8');
        console.log(chalk.green(`✔ Diff written to ${opts.output}`));
      }
    });

  return cmd;
}
