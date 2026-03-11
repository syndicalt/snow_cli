import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

interface SysProperty {
  sys_id: string;
  name: string;
  value: string;
  description: string;
  type: string;
}

const COL_NAME = 40;
const COL_VAL  = 50;

function truncate(str: string, len: number): string {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function printPropertyTable(props: SysProperty[]): void {
  const header =
    chalk.bold('Name'.padEnd(COL_NAME)) +
    '  ' +
    chalk.bold('Value'.padEnd(COL_VAL));
  const divider = chalk.dim('─'.repeat(COL_NAME + COL_VAL + 4));

  console.log();
  console.log(divider);
  console.log(header);
  console.log(divider);

  for (const p of props) {
    const nameStr = truncate(p.name, COL_NAME).padEnd(COL_NAME);
    const valStr  = truncate(String(p.value ?? ''), COL_VAL);
    console.log(`${nameStr}  ${valStr}`);
  }

  console.log(divider);
  console.log(chalk.dim(`  ${props.length} propert${props.length === 1 ? 'y' : 'ies'}`));
  console.log();
}

export function sysCommand(): Command {
  const cmd = new Command('sys').description(
    'Read and write system properties (sys_properties)'
  );

  // ─── snow sys get <name> ──────────────────────────────────────────────────
  cmd
    .command('get <name>')
    .description('Get the value of a system property')
    .option('--json', 'Output raw JSON')
    .action(async (name: string, opts: { json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora(`Looking up ${name}…`).start();
      let props: SysProperty[];
      try {
        props = (await client.queryTable('sys_properties', {
          sysparmQuery: `name=${name}`,
          sysparmFields: 'sys_id,name,value,description,type',
          sysparmLimit: 1,
        })) as SysProperty[];
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('Request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (props.length === 0) {
        console.log(chalk.yellow(`Property "${name}" not found.`));
        process.exit(1);
      }

      const prop = props[0];

      if (opts.json) {
        console.log(JSON.stringify(prop, null, 2));
        return;
      }

      console.log();
      console.log(`${chalk.bold(prop.name)}`);
      if (prop.description) {
        console.log(chalk.dim(`  ${prop.description}`));
      }
      console.log();
      console.log(`  ${chalk.dim('Value:')}  ${prop.value ?? chalk.dim('(empty)')}`);
      if (prop.type) {
        console.log(`  ${chalk.dim('Type: ')}  ${prop.type}`);
      }
      console.log();
    });

  // ─── snow sys set <name> <value> ─────────────────────────────────────────
  cmd
    .command('set <name> <value>')
    .description('Set the value of a system property (creates it if it does not exist)')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (name: string, value: string, opts: { yes?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora(`Looking up ${name}…`).start();
      let props: SysProperty[];
      try {
        props = (await client.queryTable('sys_properties', {
          sysparmQuery: `name=${name}`,
          sysparmFields: 'sys_id,name,value',
          sysparmLimit: 1,
        })) as SysProperty[];
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('Request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const existing = props[0];

      if (existing) {
        const oldVal = String(existing.value ?? '');
        console.log();
        console.log(`  ${chalk.bold(name)}`);
        console.log(`  ${chalk.dim('Old:')} ${oldVal || chalk.dim('(empty)')}`);
        console.log(`  ${chalk.dim('New:')} ${chalk.cyan(value)}`);
        console.log();
      } else {
        console.log();
        console.log(`  Property ${chalk.bold(name)} does not exist — it will be created.`);
        console.log(`  ${chalk.dim('Value:')} ${chalk.cyan(value)}`);
        console.log();
      }

      if (!opts.yes) {
        const { confirm } = await import('@inquirer/prompts');
        const ok = await confirm({
          message: existing ? `Update property "${name}"?` : `Create property "${name}"?`,
          default: false,
        });
        if (!ok) {
          console.log(chalk.dim('Cancelled.'));
          return;
        }
      }

      const spinner2 = ora(existing ? 'Updating…' : 'Creating…').start();
      try {
        if (existing) {
          await client.updateRecord('sys_properties', existing.sys_id, { value });
        } else {
          await client.createRecord('sys_properties', { name, value });
        }
        spinner2.succeed(
          chalk.green(
            existing
              ? `Updated ${chalk.bold(name)}`
              : `Created ${chalk.bold(name)}`
          )
        );
      } catch (err) {
        spinner2.fail(chalk.red('Failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // ─── snow sys list ────────────────────────────────────────────────────────
  cmd
    .command('list')
    .description('List system properties')
    .option('-f, --filter <pattern>', 'Filter by property name prefix or substring')
    .option('-l, --limit <n>', 'Max results (default: 50)', '50')
    .option('--json', 'Output as JSON array')
    .action(async (opts: { filter?: string; limit: string; json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const limit = parseInt(opts.limit, 10) || 50;
      let query = 'nameSTARTSWITHglide';

      if (opts.filter) {
        // Support both prefix and substring matching
        query = opts.filter.includes('%')
          ? `nameLIKE${opts.filter}`
          : `nameSTARTSWITH${opts.filter}`;
      }

      const spinner = ora('Fetching properties…').start();
      let props: SysProperty[];
      try {
        props = (await client.queryTable('sys_properties', {
          sysparmQuery: query + '^ORDERBYname',
          sysparmFields: 'sys_id,name,value,description,type',
          sysparmLimit: limit,
        })) as SysProperty[];
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('Request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(props, null, 2));
        return;
      }

      if (props.length === 0) {
        console.log(chalk.yellow('No properties found.'));
        return;
      }

      printPropertyTable(props);

      if (props.length === limit) {
        console.log(chalk.dim(`  Showing first ${limit} results. Use -l to increase the limit.`));
        console.log();
      }
    });

  return cmd;
}
