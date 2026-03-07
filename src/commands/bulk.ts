import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

function parseSetArgs(setArgs: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const arg of setArgs) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      console.error(chalk.red(`Invalid --set value "${arg}": expected field=value`));
      process.exit(1);
    }
    fields[arg.slice(0, eq)] = arg.slice(eq + 1);
  }
  return fields;
}

function renderPreviewTable(records: Record<string, unknown>[], fields: Record<string, string>): void {
  const fieldNames = Object.keys(fields);
  const headers = ['sys_id', 'display_name', ...fieldNames.map(f => `${f} (new)`)];

  const rows = records.map(r => {
    const sysId = String(r['sys_id'] ?? '');
    const displayName = String(r['name'] ?? r['short_description'] ?? r['number'] ?? r['sys_name'] ?? '');
    return [sysId, displayName, ...fieldNames.map(f => fields[f])];
  });

  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map(r => r[i]?.length ?? 0))
  );

  const divider = colWidths.map(w => '-'.repeat(w + 2)).join('+');
  const fmt = (row: string[]) => row.map((cell, i) => ` ${cell.padEnd(colWidths[i])} `).join('|');

  console.log(chalk.bold(fmt(headers)));
  console.log(divider);
  for (const row of rows) {
    console.log(fmt(row));
  }
}

export function bulkCommand(): Command {
  const cmd = new Command('bulk').description('Bulk operations on ServiceNow records');

  cmd
    .command('update <table>')
    .description('Update multiple records matching a query')
    .requiredOption('-q, --query <query>', 'ServiceNow encoded query to select records')
    .option('-s, --set <field=value>', 'Field to set (repeat for multiple fields)', (val, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    .option('-l, --limit <n>', 'Max records to update (default: 200)', '200')
    .option('--dry-run', 'Preview which records would be updated without making changes')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (
      table: string,
      opts: { query: string; set: string[]; limit: string; dryRun?: boolean; yes?: boolean }
    ) => {
      if (opts.set.length === 0) {
        console.error(chalk.red('At least one --set field=value is required.'));
        process.exit(1);
      }

      const fields = parseSetArgs(opts.set);
      const limit = parseInt(opts.limit, 10);
      if (isNaN(limit) || limit < 1) {
        console.error(chalk.red('--limit must be a positive integer'));
        process.exit(1);
      }

      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const fetchSpinner = ora(`Fetching records from ${table}...`).start();
      let records: Record<string, unknown>[];
      try {
        records = (await client.queryTable(table, {
          sysparmQuery: opts.query,
          sysparmFields: `sys_id,name,short_description,number,sys_name`,
          sysparmLimit: limit,
        })) as Record<string, unknown>[];
        fetchSpinner.stop();
      } catch (err) {
        fetchSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (records.length === 0) {
        console.log(chalk.yellow('No records matched the query.'));
        return;
      }

      console.log(chalk.bold(`\n${records.length} record(s) will be updated on ${chalk.cyan(instance.alias)}:`));
      renderPreviewTable(records, fields);
      console.log();

      if (opts.dryRun) {
        console.log(chalk.yellow('Dry run — no changes made.'));
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: `Update ${records.length} record(s) in ${table}?`,
          default: false,
        });
        if (!ok) {
          console.log(chalk.dim('Aborted.'));
          return;
        }
      }

      let successCount = 0;
      let failCount = 0;
      const updateSpinner = ora(`Updating 0/${records.length}...`).start();

      for (let i = 0; i < records.length; i++) {
        const sysId = String(records[i]['sys_id']);
        updateSpinner.text = `Updating ${i + 1}/${records.length}...`;
        try {
          await client.updateRecord(table, sysId, fields);
          successCount++;
        } catch (err) {
          failCount++;
          updateSpinner.stop();
          console.error(chalk.red(`  Failed ${sysId}: ${err instanceof Error ? err.message : String(err)}`));
          updateSpinner.start(`Updating ${i + 1}/${records.length}...`);
        }
      }

      updateSpinner.stop();

      if (failCount === 0) {
        console.log(chalk.green(`\nUpdated ${successCount} record(s) successfully.`));
      } else {
        console.log(chalk.yellow(`\nUpdated ${successCount} record(s). ${failCount} failed.`));
      }
    });

  return cmd;
}
