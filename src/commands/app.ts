import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const obj = v as Record<string, string>;
    return obj['display_value'] ?? obj['value'] ?? '';
  }
  return String(v).trim();
}

export function appCommand(): Command {
  const cmd = new Command('app')
    .description('List and inspect ServiceNow scoped applications');

  // snow app list
  cmd
    .command('list')
    .description('List scoped applications on the active instance')
    .option('--all', 'Include all system scopes, not just custom applications')
    .option('-q, --query <encoded>', 'Encoded query filter')
    .option('-l, --limit <n>', 'Max records to return', '50')
    .option('--json', 'Output as JSON')
    .action(async (opts: { all?: boolean; query?: string; limit: string; json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching scoped applications...').start();

      // sys_app = custom scoped applications only; sys_scope = all scopes including system
      const table = opts.all ? 'sys_scope' : 'sys_app';
      const parts: string[] = [];
      if (opts.all) parts.push('active=true');
      if (opts.query) parts.push(opts.query);
      parts.push('ORDERBYname');

      try {
        const apps = await client.queryTable(table, {
          sysparmQuery: parts.join('^') || undefined,
          sysparmFields: 'sys_id,name,scope,short_description,version,vendor,active',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(apps, null, 2)); return; }
        if (apps.length === 0) { console.log(chalk.dim('No scoped applications found.')); return; }

        const rows = apps as Record<string, unknown>[];
        const nameW = Math.min(40, Math.max(12, ...rows.map(a => str(a['name']).length))) + 2;
        const scopeW = Math.min(30, Math.max(10, ...rows.map(a => str(a['scope']).length))) + 2;

        console.log();
        console.log(chalk.bold(`Scoped Applications  (${instance.alias}  ·  ${apps.length} found)`));
        console.log(chalk.dim('─'.repeat(nameW + scopeW + 12)));
        console.log(chalk.dim(`  ${'Name'.padEnd(nameW)}${'Scope'.padEnd(scopeW)}Version`));
        console.log(chalk.dim(`  ${'─'.repeat(nameW + scopeW + 10)}`));

        for (const app of rows) {
          const active = str(app['active']);
          const isActive = active === 'true' || active === 'Yes';
          const namePart = str(app['name']).padEnd(nameW);
          const scopePart = chalk.cyan(str(app['scope']).padEnd(scopeW));
          const ver = chalk.dim(str(app['version']) || '—');
          const inactiveSuffix = isActive ? '' : chalk.red(' (inactive)');
          console.log(`  ${namePart}${scopePart}${ver}${inactiveSuffix}`);
        }
        console.log();
        console.log(chalk.dim(`  snow app get <scope>  —  view details`));
        console.log(chalk.dim(`  snow factory "<prompt>" --scope <scope>  —  build artifacts in that scope`));
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch applications'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow app get <prefix-or-name>
  cmd
    .command('get <prefixOrName>')
    .description('Get details of a scoped application by scope prefix or name')
    .option('--json', 'Output as JSON')
    .action(async (prefixOrName: string, opts: { json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching application...').start();

      try {
        const isSysId = /^[a-f0-9]{32}$/i.test(prefixOrName);
        const query = isSysId
          ? `sys_id=${prefixOrName}`
          : `scope=${prefixOrName}^ORname=${prefixOrName}`;

        // Try sys_app first, then sys_scope as fallback
        let found = await client.queryTable('sys_app', {
          sysparmQuery: query,
          sysparmFields: 'sys_id,name,scope,short_description,description,version,vendor,active,sys_created_on,sys_updated_on',
          sysparmLimit: 1,
          sysparmDisplayValue: true,
        });

        if (found.length === 0) {
          found = await client.queryTable('sys_scope', {
            sysparmQuery: query,
            sysparmFields: 'sys_id,name,scope,short_description,version,vendor,active,sys_created_on',
            sysparmLimit: 1,
            sysparmDisplayValue: true,
          });
        }
        spinner.stop();

        if (found.length === 0) {
          console.error(chalk.red(`Application not found: ${prefixOrName}`));
          process.exit(1);
        }

        const app = found[0] as Record<string, unknown>;

        if (opts.json) { console.log(JSON.stringify(app, null, 2)); return; }

        const scopePrefix = str(app['scope']);
        const active = str(app['active']);
        const isActive = active === 'true' || active === 'Yes';

        console.log();
        console.log(chalk.bold(str(app['name'])) + (isActive ? '' : chalk.red('  (inactive)')));
        const shortDesc = str(app['short_description']);
        if (shortDesc) console.log(chalk.dim(shortDesc));
        console.log();

        const fields: [string, string][] = [
          ['scope',   scopePrefix],
          ['sys_id',  str(app['sys_id'])],
          ['version', str(app['version'])],
          ['vendor',  str(app['vendor'])],
          ['created', str(app['sys_created_on'])],
          ['updated', str(app['sys_updated_on'])],
        ];
        for (const [label, value] of fields) {
          if (value) console.log(`  ${chalk.dim(label.padEnd(12))} ${value}`);
        }

        // Count update records in this scope
        try {
          const updateCount = await client.queryTable('sys_update_xml', {
            sysparmQuery: `sys_scope.scope=${scopePrefix}`,
            sysparmFields: 'sys_id',
            sysparmLimit: 1,
          });
          if (updateCount.length > 0) {
            console.log(`  ${chalk.dim('has updates')}  yes — use snow diff or snow updateset to inspect`);
          }
        } catch { /* ignore */ }

        console.log();
        console.log(chalk.dim('  Next steps:'));
        console.log(chalk.dim(`    snow factory "<prompt>" --scope ${scopePrefix}`));
        console.log(chalk.dim(`    snow diff all --against <alias> --scripts --scope ${scopePrefix}`));
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}
