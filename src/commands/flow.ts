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

function activeIcon(active: string): string {
  return active === 'true' || active === 'Yes' ? chalk.green('●') : chalk.red('○');
}

export function flowCommand(): Command {
  const cmd = new Command('flow')
    .description('List and inspect Flow Designer flows, subflows, and actions');

  // snow flow list
  cmd
    .command('list')
    .description('List Flow Designer flows (use --subflows for subflows)')
    .option('--subflows', 'Show subflows instead of flows')
    .option('--scope <prefix>', 'Filter by application scope prefix (e.g. x_myco_app)')
    .option('-q, --query <encoded>', 'Additional encoded query filter')
    .option('-l, --limit <n>', 'Max records to return', '25')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      subflows?: boolean; scope?: string; query?: string; limit: string; json?: boolean;
    }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const kind = opts.subflows ? 'subflow' : 'flow';
      const spinner = ora(`Fetching ${kind}s...`).start();

      // ServiceNow sys_hub_flow uses a "type" field: 'flow' | 'subflow'
      const parts = [`type=${kind}`];
      if (opts.scope) parts.push(`sys_scope.scope=${opts.scope}`);
      if (opts.query) parts.push(opts.query);
      parts.push('ORDERBYname');

      try {
        const flows = await client.queryTable('sys_hub_flow', {
          sysparmQuery: parts.join('^'),
          sysparmFields: 'sys_id,name,description,active,sys_scope,trigger_type,type,sys_created_on',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(flows, null, 2)); return; }
        if (flows.length === 0) { console.log(chalk.dim(`No ${kind}s found.`)); return; }

        console.log();
        console.log(chalk.bold(`Flow Designer ${kind === 'flow' ? 'Flows' : 'Subflows'}  (${instance.alias}  ·  ${flows.length} found)`));
        console.log(chalk.dim('─'.repeat(72)));

        const nameW = Math.min(42, Math.max(16, ...((flows as Record<string, unknown>[]).map(f => str(f['name']).length)))) + 2;

        for (const flow of flows as Record<string, unknown>[]) {
          const name = str(flow['name']);
          const scope = str(flow['sys_scope']);
          const trigger = str(flow['trigger_type']);
          const icon = activeIcon(str(flow['active']));

          process.stdout.write(`  ${icon}  ${name.padEnd(nameW)}`);
          if (scope) process.stdout.write(chalk.dim(`[${scope}]`));
          if (kind === 'flow' && trigger) process.stdout.write(chalk.dim(`  trigger: ${trigger}`));
          process.stdout.write('\n');

          const desc = str(flow['description']);
          if (desc) console.log(`       ${chalk.dim(desc.slice(0, 80))}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch flows'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow flow get <name-or-id>
  cmd
    .command('get <nameOrId>')
    .description('Get details and inputs/outputs of a flow or subflow')
    .option('--json', 'Output as JSON')
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching flow...').start();

      try {
        const isSysId = /^[a-f0-9]{32}$/i.test(nameOrId);
        const query = isSysId ? `sys_id=${nameOrId}` : `name=${nameOrId}`;

        const flows = await client.queryTable('sys_hub_flow', {
          sysparmQuery: query,
          sysparmFields: 'sys_id,name,description,active,sys_scope,trigger_type,type,run_as,sys_created_on,sys_updated_on',
          sysparmLimit: 1,
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (flows.length === 0) {
          console.error(chalk.red(`Flow not found: ${nameOrId}`));
          process.exit(1);
        }

        const flow = flows[0] as Record<string, unknown>;

        if (opts.json) { console.log(JSON.stringify(flow, null, 2)); return; }

        const flowSysId = str(flow['sys_id']);
        console.log();
        console.log(`${activeIcon(str(flow['active']))}  ${chalk.bold(str(flow['name']))}  ${chalk.dim(str(flow['type']))}`);
        const desc = str(flow['description']);
        if (desc) console.log(`   ${chalk.dim(desc)}`);
        console.log();

        const fields: [string, string][] = [
          ['sys_id',   flowSysId],
          ['scope',    str(flow['sys_scope'])],
          ['trigger',  str(flow['trigger_type'])],
          ['run as',   str(flow['run_as'])],
          ['updated',  str(flow['sys_updated_on'])],
        ];
        for (const [label, value] of fields) {
          if (value) console.log(`  ${chalk.dim(label.padEnd(12))} ${value}`);
        }

        // Fetch flow inputs (sys_hub_flow_input)
        try {
          const inputs = await client.queryTable('sys_hub_flow_input', {
            sysparmQuery: `flow=${flowSysId}^ORDERBYorder`,
            sysparmFields: 'name,label,type,mandatory',
            sysparmLimit: 50,
            sysparmDisplayValue: true,
          });
          if (inputs.length > 0) {
            console.log();
            console.log(chalk.dim('  Inputs:'));
            for (const inp of inputs as Record<string, unknown>[]) {
              const req = str(inp['mandatory']) === 'true' || str(inp['mandatory']) === 'Yes' ? chalk.yellow('*') : ' ';
              console.log(`    ${req} ${chalk.white(str(inp['label']) || str(inp['name']))}  ${chalk.dim(str(inp['type']))}`);
            }
          }
        } catch {
          // sys_hub_flow_input may not be accessible on all instances
        }

        console.log();
        console.log(chalk.dim(`  Open in Flow Designer:`));
        console.log(chalk.dim(`    ${instance.url}/flow-designer.do?sysparm_nostack=true&sys_id=${flowSysId}`));
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow flow actions
  cmd
    .command('actions')
    .description('List custom Flow Designer actions')
    .option('--scope <prefix>', 'Filter by application scope prefix')
    .option('-q, --query <encoded>', 'Additional encoded query filter')
    .option('-l, --limit <n>', 'Max records to return', '25')
    .option('--json', 'Output as JSON')
    .action(async (opts: { scope?: string; query?: string; limit: string; json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching flow actions...').start();

      const parts = ['active=true'];
      if (opts.scope) parts.push(`sys_scope.scope=${opts.scope}`);
      if (opts.query) parts.push(opts.query);
      parts.push('ORDERBYlabel');

      try {
        const actions = await client.queryTable('sys_hub_action_type_definition', {
          sysparmQuery: parts.join('^'),
          sysparmFields: 'sys_id,name,label,description,category,active,sys_scope',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(actions, null, 2)); return; }
        if (actions.length === 0) { console.log(chalk.dim('No custom flow actions found.')); return; }

        console.log();
        console.log(chalk.bold(`Custom Flow Actions  (${instance.alias}  ·  ${actions.length} found)`));
        console.log(chalk.dim('─'.repeat(70)));

        const nameW = Math.min(36, Math.max(16, ...((actions as Record<string, unknown>[]).map(a => (str(a['label']) || str(a['name'])).length)))) + 2;

        for (const action of actions as Record<string, unknown>[]) {
          const label = str(action['label']) || str(action['name']);
          const cat = str(action['category']);
          const scope = str(action['sys_scope']);
          const desc = str(action['description']);

          process.stdout.write(`  ${label.padEnd(nameW)}`);
          if (cat) process.stdout.write(chalk.dim(`[${cat}]  `));
          if (scope) process.stdout.write(chalk.dim(scope));
          process.stdout.write('\n');
          if (desc) console.log(`  ${' '.repeat(nameW)}${chalk.dim(desc.slice(0, 70))}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch flow actions'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}
