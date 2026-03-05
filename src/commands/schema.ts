import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

interface DictionaryEntry {
  element: { value: string; display_value: string };
  column_label: { value: string; display_value: string };
  internal_type: { value: string; display_value: string };
  max_length: { value: string };
  mandatory: { value: string };
  read_only: { value: string };
  reference: { value: string; display_value: string };
  default_value: { value: string };
  comments: { value: string };
}

export function schemaCommand(): Command {
  return new Command('schema')
    .description('Retrieve the field schema for a ServiceNow table')
    .argument('<table>', 'Table name (e.g. incident, sys_user)')
    .option('--format <fmt>', 'Output format: table or json', 'table')
    .option('-f, --filter <text>', 'Filter fields by name or label (case-insensitive)')
    .action(
      async (
        table: string,
        opts: { format: 'table' | 'json'; filter?: string }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        const spinner = ora(`Loading schema for ${table}...`).start();

        try {
          // Query sys_dictionary for the table's fields
          const res = await client.get<{ result: DictionaryEntry[] }>(
            '/api/now/table/sys_dictionary',
            {
              params: {
                sysparm_query: `name=${table}^elementISNOTEMPTY`,
                sysparm_fields:
                  'element,column_label,internal_type,max_length,mandatory,read_only,reference,default_value,comments',
                sysparm_display_value: 'all',
                sysparm_limit: 500,
                sysparm_exclude_reference_link: true,
              },
            }
          );

          spinner.stop();

          let entries = res.result ?? [];

          if (opts.filter) {
            const filterLower = opts.filter.toLowerCase();
            entries = entries.filter(
              (e) =>
                e.element?.value?.toLowerCase().includes(filterLower) ||
                e.column_label?.display_value?.toLowerCase().includes(filterLower)
            );
          }

          if (entries.length === 0) {
            console.log(chalk.dim(`No fields found for table "${table}".`));
            return;
          }

          if (opts.format === 'json') {
            const mapped = entries.map((e) => ({
              name: e.element?.value,
              label: e.column_label?.display_value,
              type: e.internal_type?.value,
              maxLength: e.max_length?.value ? parseInt(e.max_length.value, 10) : undefined,
              mandatory: e.mandatory?.value === 'true',
              readOnly: e.read_only?.value === 'true',
              reference: e.reference?.value || undefined,
              defaultValue: e.default_value?.value || undefined,
              comments: e.comments?.value || undefined,
            }));
            console.log(JSON.stringify(mapped, null, 2));
            return;
          }

          // Tabular output
          console.log(chalk.bold(`\nSchema for ${chalk.cyan(table)} (${entries.length} fields)\n`));

          const colWidths = { name: 30, label: 30, type: 20, extra: 20 };

          const header = [
            'Field Name'.padEnd(colWidths.name),
            'Label'.padEnd(colWidths.label),
            'Type'.padEnd(colWidths.type),
            'Flags',
          ].join('  ');

          console.log(chalk.bold(header));
          console.log(chalk.dim('-'.repeat(header.length)));

          for (const e of entries) {
            const name = (e.element?.value ?? '').slice(0, colWidths.name).padEnd(colWidths.name);
            const label = (e.column_label?.display_value ?? '').slice(0, colWidths.label).padEnd(colWidths.label);
            const type = (e.internal_type?.value ?? '').slice(0, colWidths.type).padEnd(colWidths.type);

            const flags: string[] = [];
            if (e.mandatory?.value === 'true') flags.push(chalk.red('M'));
            if (e.read_only?.value === 'true') flags.push(chalk.yellow('R'));
            if (e.reference?.value) flags.push(chalk.blue(`ref:${e.reference.value}`));

            console.log(`${name}  ${label}  ${type}  ${flags.join(' ')}`);
          }

          console.log(chalk.dim('\nFlags: M=mandatory  R=read-only  ref=reference table'));
        } catch (err) {
          spinner.fail();
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
      }
    );
}
