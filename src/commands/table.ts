import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import type { QueryOptions } from '../types/index.js';

/**
 * Flatten a ServiceNow field value to a display string.
 * Reference fields may come back as { value, display_value } objects.
 */
export function flattenValue(val: unknown): string {
  if (val === null || val === undefined) return '';
  if (typeof val === 'object' && !Array.isArray(val)) {
    const obj = val as Record<string, unknown>;
    if ('display_value' in obj && obj['display_value'] !== '') {
      return String(obj['display_value']);
    }
    if ('value' in obj) return String(obj['value']);
    return JSON.stringify(val);
  }
  return String(val);
}

function printRecords(records: unknown[], format: 'table' | 'json'): void {
  if (format === 'json') {
    console.log(JSON.stringify(records, null, 2));
    return;
  }

  if (records.length === 0) {
    console.log(chalk.dim('No records found.'));
    return;
  }

  const rows = records as Record<string, unknown>[];
  // Only keep fields that have at least one non-empty value
  const allKeys = Object.keys(rows[0]);
  const keys = allKeys.filter((k) => rows.some((r) => flattenValue(r[k]) !== ''));

  const termWidth = process.stdout.columns ?? 120;
  const COL_GAP = 2;
  const MIN_COL_WIDTH = 10;

  // Switch to vertical card layout when too many columns to display meaningfully
  const fitsHorizontally = keys.length * MIN_COL_WIDTH + COL_GAP * (keys.length - 1) <= termWidth;

  if (!fitsHorizontally) {
    const keyWidth = Math.max(...keys.map((k) => k.length));
    const valWidth = Math.max(20, termWidth - keyWidth - 3);
    const divider = chalk.dim('─'.repeat(Math.min(termWidth, 80)));

    for (let i = 0; i < rows.length; i++) {
      console.log(divider + chalk.dim(` Record ${i + 1}`));
      for (const k of keys) {
        const val = flattenValue(rows[i][k]);
        if (val === '') continue;
        const truncated = val.length > valWidth ? val.slice(0, valWidth - 1) + '…' : val;
        console.log(`${chalk.bold(k.padEnd(keyWidth))}  ${truncated}`);
      }
      console.log();
    }
    console.log(chalk.dim(`${rows.length} record(s) — use -f/--fields to select specific fields for tabular output`));
    return;
  }

  // Horizontal table layout
  const naturalWidths = keys.map((k) => {
    const maxVal = rows.reduce((max, row) => {
      return Math.max(max, flattenValue(row[k]).length);
    }, k.length);
    return Math.min(maxVal, 60);
  });

  const totalNatural = naturalWidths.reduce((s, w) => s + w, 0) + COL_GAP * (keys.length - 1);
  const colWidths = totalNatural > termWidth
    ? naturalWidths.map((w) => Math.max(4, Math.floor(w * termWidth / totalNatural)))
    : naturalWidths;

  const header = keys.map((k, i) => chalk.bold(k.padEnd(colWidths[i]))).join('  ');
  const divider = chalk.dim(colWidths.map((w) => '─'.repeat(w)).join('  '));

  console.log(header);
  console.log(divider);

  for (const row of rows) {
    const line = keys
      .map((k, i) => {
        const val = flattenValue(row[k]);
        return val.length > colWidths[i]
          ? val.slice(0, colWidths[i] - 1) + '…'
          : val.padEnd(colWidths[i]);
      })
      .join('  ');
    console.log(line);
  }

  console.log(chalk.dim(`\n${rows.length} record(s)`));
}

export function tableCommand(): Command {
  const cmd = new Command('table').description('Perform Table API operations');

  // snow table get <table>
  cmd
    .command('get <table>')
    .description('Query records from a table')
    .option('-q, --query <sysparm_query>', 'Encoded query string')
    .option('-f, --fields <fields>', 'Comma-separated list of fields to return')
    .option('-l, --limit <n>', 'Max number of records', '20')
    .option('-o, --offset <n>', 'Offset for pagination', '0')
    .option('--display-value', 'Return display values instead of raw values')
    .option('--format <fmt>', 'Output format: table or json', 'table')
    .option('--json', 'Shorthand for --format json')
    .action(
      async (
        table: string,
        opts: {
          query?: string;
          fields?: string;
          limit?: string;
          offset?: string;
          displayValue?: boolean;
          format: 'table' | 'json';
          json?: boolean;
        }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        const options: QueryOptions = {
          sysparmQuery: opts.query,
          sysparmFields: opts.fields,
          sysparmLimit: parseInt(opts.limit ?? '20', 10),
          sysparmOffset: parseInt(opts.offset ?? '0', 10),
          sysparmDisplayValue: opts.displayValue,
          sysparmExcludeReferenceLink: true,
        };

        const spinner = ora(`Querying ${table}...`).start();
        try {
          const records = await client.queryTable(table, options);
          spinner.stop();
          printRecords(records, opts.json ? 'json' : opts.format);
        } catch (err) {
          spinner.fail();
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }
    );

  // snow table fetch <table> <sys_id>
  cmd
    .command('fetch <table> <sys_id>')
    .description('Fetch a single record by sys_id')
    .option('-f, --fields <fields>', 'Comma-separated list of fields to return')
    .option('--display-value', 'Return display values')
    .option('--format <fmt>', 'Output format: table or json', 'table')
    .option('--json', 'Shorthand for --format json')
    .action(
      async (
        table: string,
        sysId: string,
        opts: { fields?: string; displayValue?: boolean; format: 'table' | 'json'; json?: boolean }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        const spinner = ora(`Fetching ${table}/${sysId}...`).start();
        try {
          const record = await client.getRecord(table, sysId, {
            sysparmFields: opts.fields,
            sysparmDisplayValue: opts.displayValue,
          });
          spinner.stop();
          printRecords([record], opts.json ? 'json' : opts.format);
        } catch (err) {
          spinner.fail();
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }
    );

  // snow table create <table>
  cmd
    .command('create <table>')
    .description('Create a new record')
    .requiredOption('-d, --data <json>', 'JSON object of field values')
    .option('--format <fmt>', 'Output format: table or json', 'json')
    .action(
      async (
        table: string,
        opts: { data: string; format: 'table' | 'json' }
      ) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(opts.data) as Record<string, unknown>;
        } catch {
          console.error(chalk.red('Invalid JSON provided to --data'));
          process.exit(1);
        }

        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        const spinner = ora(`Creating record in ${table}...`).start();
        try {
          const record = await client.createRecord(table, data);
          spinner.succeed(`Created sys_id: ${chalk.green(record.sys_id)}`);
          printRecords([record], opts.format);
        } catch (err) {
          spinner.fail();
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }
    );

  // snow table update <table> <sys_id>
  cmd
    .command('update <table> <sys_id>')
    .description('Update an existing record')
    .requiredOption('-d, --data <json>', 'JSON object of field values to update')
    .option('--format <fmt>', 'Output format: table or json', 'json')
    .action(
      async (
        table: string,
        sysId: string,
        opts: { data: string; format: 'table' | 'json' }
      ) => {
        let data: Record<string, unknown>;
        try {
          data = JSON.parse(opts.data) as Record<string, unknown>;
        } catch {
          console.error(chalk.red('Invalid JSON provided to --data'));
          process.exit(1);
        }

        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        const spinner = ora(`Updating ${table}/${sysId}...`).start();
        try {
          const record = await client.updateRecord(table, sysId, data);
          spinner.succeed('Record updated.');
          printRecords([record], opts.format);
        } catch (err) {
          spinner.fail();
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }
    );

  // snow table delete <table> <sys_id>
  cmd
    .command('delete <table> <sys_id>')
    .description('Delete a record')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (table: string, sysId: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({
          message: `Delete ${table}/${sysId}?`,
          default: false,
        });
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      }

      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora(`Deleting ${table}/${sysId}...`).start();
      try {
        await client.deleteRecord(table, sysId);
        spinner.succeed(chalk.green(`Deleted ${table}/${sysId}.`));
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}
