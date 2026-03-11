import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import type { TableRecord } from '../types/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const obj = v as Record<string, string>;
    return obj['display_value'] ?? obj['value'] ?? JSON.stringify(v);
  }
  return String(v).trim();
}

interface FieldChange {
  field: string;
  from: unknown;
  to: unknown;
}

function detectChanges(
  prev: TableRecord,
  curr: TableRecord,
  watchFields: string[]
): FieldChange[] {
  const fields =
    watchFields.length > 0
      ? watchFields
      : Object.keys(curr).filter((k) => k !== 'sys_id');

  const changes: FieldChange[] = [];
  for (const field of fields) {
    const prevStr = JSON.stringify(prev[field] ?? null);
    const currStr = JSON.stringify(curr[field] ?? null);
    if (prevStr !== currStr) {
      changes.push({ field, from: prev[field], to: curr[field] });
    }
  }
  return changes;
}

function formatValue(v: unknown): string {
  const s = str(v);
  if (!s) return chalk.dim('(empty)');
  if (s.includes('\n')) {
    // Multi-line (e.g. script fields) — show line count instead of raw content
    const lines = s.split('\n').length;
    return chalk.dim(`<${lines} lines>`);
  }
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function watchCommand(): Command {
  return new Command('watch')
    .description('Poll a record and print field changes as they happen (Ctrl+C to stop)')
    .argument('<table>', 'Table name')
    .argument('<sys_id>', 'Record sys_id to watch')
    .option(
      '-f, --fields <fields>',
      'Comma-separated list of fields to watch (default: all fields)'
    )
    .option('-i, --interval <ms>', 'Polling interval in milliseconds (min: 1000)', '5000')
    .option('--no-display-value', 'Use raw values instead of display values')
    .addHelpText(
      'after',
      `
Examples:
  snow watch incident <sys_id>
  snow watch incident <sys_id> --fields state,assigned_to,priority
  snow watch sys_update_set <sys_id> --fields state --interval 3000
  snow watch sysapproval_approver <sys_id> --fields state,comments
`
    )
    .action(
      async (
        table: string,
        sysId: string,
        opts: { fields?: string; interval: string; displayValue: boolean }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);
        const interval = Math.max(parseInt(opts.interval, 10) || 5000, 1000);
        const watchFields = opts.fields ? opts.fields.split(',').map((f) => f.trim()) : [];

        const queryOpts = {
          sysparmFields: watchFields.length > 0 ? watchFields.join(',') : undefined,
          sysparmDisplayValue: opts.displayValue,
        };

        // Initial fetch
        const spinner = ora(`Fetching ${table}/${sysId}…`).start();
        let previous: TableRecord;
        try {
          previous = await client.getRecord(table, sysId, queryOpts);
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red('Record not found'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
          return;
        }

        const DIVIDER = chalk.dim('─'.repeat(56));
        console.log();
        console.log(DIVIDER);
        console.log(
          `  ${chalk.bold('snow watch')}  ${chalk.cyan(table)}  ${chalk.dim(sysId)}`
        );
        console.log(
          `  ${chalk.dim('interval:')} ${interval}ms  ${chalk.dim('Ctrl+C to stop')}`
        );
        if (watchFields.length > 0) {
          console.log(`  ${chalk.dim('watching:')} ${watchFields.join(', ')}`);
        } else {
          const fieldCount = Object.keys(previous).filter((k) => k !== 'sys_id').length;
          console.log(`  ${chalk.dim('watching:')} all fields (${fieldCount})`);
        }
        console.log(DIVIDER);
        console.log(chalk.dim(`\n  Waiting for changes…\n`));

        process.on('SIGINT', () => {
          console.log(chalk.dim('\nStopped.'));
          process.exit(0);
        });

        // Poll loop
        while (true) {
          await sleep(interval);

          let current: TableRecord;
          try {
            current = await client.getRecord(table, sysId, queryOpts);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(chalk.red(`  [poll error] ${msg}`));
            continue;
          }

          const changes = detectChanges(previous, current, watchFields);
          if (changes.length === 0) continue;

          const ts = new Date().toLocaleTimeString();
          console.log(
            `  ${chalk.dim(ts)}  ` +
              chalk.yellow(`${changes.length} field${changes.length === 1 ? '' : 's'} changed`)
          );
          console.log();

          for (const change of changes) {
            console.log(`  ${chalk.bold(change.field)}`);
            console.log(`    ${chalk.dim('from:')} ${formatValue(change.from)}`);
            console.log(`    ${chalk.dim('  to:')} ${chalk.cyan(formatValue(change.to))}`);
          }

          console.log();
          previous = current;
        }
      }
    );
}
