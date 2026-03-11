import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

// ---------------------------------------------------------------------------
// CSV parser (RFC 4180 compatible)
// ---------------------------------------------------------------------------

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (i === line.length) {
      // Trailing comma produced an empty field above; stop
      break;
    }
    if (line[i] === '"') {
      // Quoted field
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') {
          field += '"';
          i += 2;
        } else if (line[i] === '"') {
          i++;
          break;
        } else {
          field += line[i++];
        }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      // Unquoted field
      const end = line.indexOf(',', i);
      if (end === -1) {
        fields.push(line.slice(i));
        break;
      }
      fields.push(line.slice(i, end));
      i = end + 1;
    }
  }
  return fields;
}

function parseCsv(content: string): Record<string, string>[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  const records: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCsvRow(lines[i]);
    const record: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      record[headers[j]] = values[j] ?? '';
    }
    records.push(record);
  }
  return records;
}

function parseFile(file: string, content: string): Record<string, unknown>[] {
  const ext = file.split('.').pop()?.toLowerCase();
  if (ext === 'json') {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : [parsed as Record<string, unknown>];
  }
  if (ext === 'csv') {
    return parseCsv(content) as Record<string, unknown>[];
  }
  // Auto-detect: try JSON first, then CSV
  try {
    const parsed = JSON.parse(content) as unknown;
    return Array.isArray(parsed)
      ? (parsed as Record<string, unknown>[])
      : [parsed as Record<string, unknown>];
  } catch {
    return parseCsv(content) as Record<string, unknown>[];
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function importCommand(): Command {
  return new Command('import')
    .description('Import records into a ServiceNow table from a JSON or CSV file')
    .argument('<file>', 'Path to a .json or .csv file')
    .requiredOption('-t, --table <table>', 'Target ServiceNow table name')
    .option(
      '-u, --upsert <field>',
      'Field to use for upsert: if a record with this field value already exists it is updated rather than created'
    )
    .option('--dry-run', 'Preview what would be created or updated without making changes')
    .option('-l, --limit <n>', 'Max number of records to process from the file')
    .option('--yes', 'Skip the confirmation prompt')
    .addHelpText(
      'after',
      `
Examples:
  snow import ./users.json --table sys_user
  snow import ./incidents.csv --table incident --upsert number
  snow import ./data.json --table x_myco_request --dry-run
  snow import ./records.csv --table sys_user --upsert user_name --yes
`
    )
    .action(
      async (
        file: string,
        opts: {
          table: string;
          upsert?: string;
          dryRun?: boolean;
          limit?: string;
          yes?: boolean;
        }
      ) => {
        if (!existsSync(file)) {
          console.error(chalk.red(`File not found: ${file}`));
          process.exit(1);
        }

        let records: Record<string, unknown>[];
        try {
          records = parseFile(file, readFileSync(file, 'utf-8'));
        } catch (err) {
          console.error(
            chalk.red(`Failed to parse file: ${err instanceof Error ? err.message : String(err)}`)
          );
          process.exit(1);
          return;
        }

        if (opts.limit) {
          records = records.slice(0, parseInt(opts.limit, 10));
        }

        if (records.length === 0) {
          console.log(chalk.yellow('No records found in file.'));
          return;
        }

        // ── Preview ──────────────────────────────────────────────────────────
        const sample = records[0];
        const allFields = Object.keys(sample);

        console.log();
        console.log(`  ${chalk.bold('Import preview')}`);
        console.log(`  ${chalk.dim('File:')}    ${file}`);
        console.log(`  ${chalk.dim('Table:')}   ${opts.table}`);
        console.log(`  ${chalk.dim('Records:')} ${records.length}`);
        if (opts.upsert) {
          console.log(`  ${chalk.dim('Upsert:')}  match on ${chalk.bold(opts.upsert)}`);
        }
        if (opts.dryRun) {
          console.log(`  ${chalk.yellow('[dry run — no changes will be made]')}`);
        }
        console.log();
        console.log(`  ${chalk.dim('Fields:')} ${allFields.join(', ')}`);
        console.log();
        console.log(`  ${chalk.dim('Sample record (first row):')}`);
        for (const f of allFields.slice(0, 8)) {
          const val = String(sample[f] ?? '').replace(/\n/g, '\\n').slice(0, 70);
          console.log(`    ${chalk.dim(f.padEnd(24))} ${val}`);
        }
        if (allFields.length > 8) {
          console.log(chalk.dim(`    … and ${allFields.length - 8} more fields`));
        }
        console.log();

        if (!opts.yes && !opts.dryRun) {
          const ok = await confirm({
            message: `Import ${records.length} record${records.length === 1 ? '' : 's'} into ${opts.table}?`,
            default: false,
          });
          if (!ok) {
            console.log(chalk.dim('Cancelled.'));
            return;
          }
        }

        // ── Process records ───────────────────────────────────────────────────
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        let created = 0;
        let updated = 0;
        let failed  = 0;

        const spinner = ora(`Processing 1 / ${records.length}…`).start();

        for (let i = 0; i < records.length; i++) {
          const record = records[i];
          spinner.text = `Processing ${i + 1} / ${records.length}…`;

          if (opts.dryRun) {
            const action = opts.upsert && record[opts.upsert]
              ? `would upsert on ${opts.upsert}=${String(record[opts.upsert])}`
              : 'would create';
            spinner.stop();
            console.log(chalk.dim(`  [dry] ${action}`));
            spinner.start();
            created++;
            continue;
          }

          try {
            if (opts.upsert && record[opts.upsert]) {
              const existing = await client.queryTable(opts.table, {
                sysparmQuery: `${opts.upsert}=${String(record[opts.upsert])}`,
                sysparmFields: 'sys_id',
                sysparmLimit: 1,
              });
              if (existing.length > 0) {
                await client.updateRecord(opts.table, existing[0].sys_id, record);
                updated++;
              } else {
                await client.createRecord(opts.table, record);
                created++;
              }
            } else {
              await client.createRecord(opts.table, record);
              created++;
            }
          } catch (err) {
            failed++;
            spinner.stop();
            console.error(
              chalk.red(
                `  [${i + 1}] ${err instanceof Error ? err.message : String(err)}`
              )
            );
            spinner.start();
          }
        }

        spinner.stop();
        console.log();

        if (opts.dryRun) {
          console.log(
            chalk.dim(
              `  Dry run complete — ${records.length} records would be processed.`
            )
          );
        } else {
          const parts: string[] = [];
          if (created > 0) parts.push(chalk.green(`${created} created`));
          if (updated > 0) parts.push(chalk.cyan(`${updated} updated`));
          if (failed > 0)  parts.push(chalk.red(`${failed} failed`));
          console.log(`  ${parts.join('  ')}`);
        }

        console.log();
      }
    );
}
