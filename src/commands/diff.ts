import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
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

// Simple unified-diff-style line comparison
function lineDiff(
  label: string,
  srcScript: string,
  tgtScript: string,
  sourceAlias: string,
  targetAlias: string
): void {
  const srcLines = srcScript.split('\n');
  const tgtLines = tgtScript.split('\n');

  // Find first/last differing lines for context
  let firstDiff = -1;
  let lastDiff = -1;
  const maxLen = Math.max(srcLines.length, tgtLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (srcLines[i] !== tgtLines[i]) {
      if (firstDiff === -1) firstDiff = i;
      lastDiff = i;
    }
  }

  if (firstDiff === -1) return; // identical

  const CONTEXT = 2;
  const start = Math.max(0, firstDiff - CONTEXT);
  const end   = Math.min(maxLen - 1, lastDiff + CONTEXT);

  console.log(`\n  ${chalk.bold(label)}`);
  console.log(`  ${chalk.dim(`--- ${sourceAlias}`)}`);
  console.log(`  ${chalk.dim(`+++ ${targetAlias}`)}`);
  console.log(`  ${chalk.dim(`@@ lines ${start + 1}–${end + 1} @@`)}`);

  for (let i = start; i <= end; i++) {
    const src = srcLines[i] ?? '';
    const tgt = tgtLines[i] ?? '';
    if (src === tgt) {
      console.log(`  ${chalk.dim(' ' + src)}`);
    } else {
      if (i < srcLines.length) console.log(`  ${chalk.red('-' + src)}`);
      if (i < tgtLines.length) console.log(`  ${chalk.green('+' + tgt)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Field comparison output
// ---------------------------------------------------------------------------

function compareFields(
  table: string,
  src: Map<string, DictField>,
  tgt: Map<string, DictField>,
  sourceAlias: string,
  targetAlias: string,
  markdownMode: boolean
): void {
  const allFields = new Set([...src.keys(), ...tgt.keys()]);

  type Row = { element: string; status: string; detail: string };
  const rows: Row[] = [];

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
      console.log(`\n### Schema: \`${table}\``);
      console.log(`\nNo field differences found.`);
    } else {
      console.log();
      console.log(chalk.green(`  No field differences in ${table}`));
    }
    return;
  }

  if (markdownMode) {
    console.log(`\n### Schema: \`${table}\``);
    console.log(`\n| Field | Status | Detail |`);
    console.log(`|-------|--------|--------|`);
    for (const r of rows) {
      const icon = r.status === 'added' ? '➕' : r.status === 'removed' ? '➖' : '✏️';
      console.log(`| \`${r.element}\` | ${icon} ${r.status} | ${r.detail} |`);
    }
  } else {
    console.log();
    console.log(chalk.bold.cyan(`  Schema diff: ${table}`));
    console.log(chalk.dim(`  ${'─'.repeat(50)}`));

    const elW = Math.max(8, ...rows.map(r => r.element.length)) + 2;
    const stW = 10;

    console.log(
      `  ${'Field'.padEnd(elW)}${'Status'.padEnd(stW)}Detail`
    );
    console.log(chalk.dim(`  ${'─'.repeat(70)}`));

    for (const r of rows) {
      const statusStr =
        r.status === 'added'   ? chalk.green(r.status.padEnd(stW))  :
        r.status === 'removed' ? chalk.red(r.status.padEnd(stW))    :
                                  chalk.yellow(r.status.padEnd(stW));
      console.log(`  ${r.element.padEnd(elW)}${statusStr}${chalk.dim(r.detail)}`);
    }
  }
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
    .action(async (table: string, opts: {
      against: string;
      fields?: boolean;
      scripts?: boolean;
      scope?: string;
      markdown?: boolean;
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

      if (!opts.markdown) {
        console.log();
        console.log(chalk.dim('─'.repeat(52)));
        console.log(`  ${chalk.bold('snow diff')}  ·  ${chalk.cyan(sourceAlias)} ${chalk.dim('→')} ${chalk.cyan(targetAlias)}`);
        if (opts.scope) {
          console.log(`  ${chalk.dim('scope:')} ${opts.scope}`);
        }
        console.log(chalk.dim('─'.repeat(52)));
      } else {
        console.log(`# snow diff: \`${sourceAlias}\` → \`${targetAlias}\``);
        if (opts.scope) console.log(`\n**Scope:** \`${opts.scope}\``);
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

        compareFields(table, srcFields, tgtFields, sourceAlias, targetAlias, opts.markdown ?? false);
      }

      // -----------------------------------------------------------------------
      // Script diff
      // -----------------------------------------------------------------------
      if (opts.scripts) {
        const tables = table === 'all'
          ? SCRIPT_TABLES
          : SCRIPT_TABLES.filter(t => t.table === table);

        if (tables.length === 0) {
          console.log(chalk.yellow(`  Note: "${table}" is not a known script-bearing table. Script diff skipped.`));
          console.log(chalk.dim(`  Known script tables: ${SCRIPT_TABLES.map(t => t.table).join(', ')}`));
        }

        for (const { table: tblName, nameField, scriptField } of tables) {
          const spinner = ora(`Fetching scripts from ${tblName}...`).start();

          const [srcMap, tgtMap] = await Promise.all([
            fetchScripts(sourceClient, tblName, nameField, scriptField, opts.scope),
            fetchScripts(targetClient, tblName, nameField, scriptField, opts.scope),
          ]).catch((e: Error) => { spinner.stop(); throw e; });

          spinner.stop();

          const allNames = new Set([...srcMap.keys(), ...tgtMap.keys()]);

          if (allNames.size === 0) {
            if (!opts.markdown) {
              console.log(chalk.dim(`\n  No scripts found in ${tblName}`));
            }
            continue;
          }

          const added: string[]   = [];
          const removed: string[] = [];
          const changed: string[] = [];
          const same: number[]    = [0];

          for (const name of [...allNames].sort()) {
            const srcScript = srcMap.get(name);
            const tgtScript = tgtMap.get(name);

            if (!srcScript && tgtScript !== undefined) {
              added.push(name);
            } else if (srcScript !== undefined && !tgtScript) {
              removed.push(name);
            } else if (srcScript !== tgtScript) {
              changed.push(name);
            } else {
              same[0]++;
            }
          }

          if (opts.markdown) {
            console.log(`\n### Scripts: \`${tblName}\``);
            if (added.length === 0 && removed.length === 0 && changed.length === 0) {
              console.log(`\nAll ${same[0]} scripts are identical.`);
              continue;
            }
            if (added.length)   console.log(`\n**Added in ${targetAlias}:** ${added.map(n => `\`${n}\``).join(', ')}`);
            if (removed.length) console.log(`\n**Removed in ${targetAlias}:** ${removed.map(n => `\`${n}\``).join(', ')}`);
            if (changed.length) {
              console.log(`\n**Changed (${changed.length}):**`);
              for (const name of changed) {
                lineDiff(name, srcMap.get(name)!, tgtMap.get(name)!, sourceAlias, targetAlias);
              }
            }
          } else {
            console.log();
            console.log(chalk.bold.cyan(`  Script diff: ${tblName}`));
            console.log(chalk.dim(`  ${'─'.repeat(50)}`));

            if (added.length === 0 && removed.length === 0 && changed.length === 0) {
              console.log(chalk.green(`  All ${same[0]} scripts are identical.`));
              continue;
            }

            for (const name of added) {
              console.log(`  ${chalk.green('+')} ${name} ${chalk.dim(`(only in ${targetAlias})`)}`);
            }
            for (const name of removed) {
              console.log(`  ${chalk.red('-')} ${name} ${chalk.dim(`(only in ${sourceAlias})`)}`);
            }
            for (const name of changed) {
              console.log(`  ${chalk.yellow('~')} ${name}`);
              lineDiff(name, srcMap.get(name)!, tgtMap.get(name)!, sourceAlias, targetAlias);
            }
            if (same[0] > 0) {
              console.log(chalk.dim(`\n  (${same[0]} scripts identical, not shown)`));
            }
          }
        }
      }

      console.log();
      if (!opts.markdown) {
        console.log(chalk.dim('─'.repeat(52)));
        console.log();
      }
    });

  return cmd;
}
