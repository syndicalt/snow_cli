import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

// ---------------------------------------------------------------------------
// Aggregate count helper  (/api/now/stats/<table>?sysparm_count=true&...)
// ---------------------------------------------------------------------------
async function countRecords(
  client: ServiceNowClient,
  table: string,
  query: string
): Promise<number> {
  const res = await client.get<{ result: { stats: { count: string } } }>(
    `/api/now/stats/${table}`,
    { params: { sysparm_count: true, sysparm_query: query } }
  );
  return parseInt(res.result?.stats?.count ?? '0', 10);
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------
const DIVIDER = chalk.dim('─'.repeat(52));
const NA = chalk.dim('N/A');

function section(title: string): void {
  console.log();
  console.log(chalk.bold.cyan(`  ${title}`));
  console.log(chalk.dim(`  ${'─'.repeat(title.length)}`));
}

function row(label: string, value: string, width = 22): void {
  console.log(`  ${label.padEnd(width)}${value}`);
}

// ---------------------------------------------------------------------------
// Individual stat fetchers — each returns a value or throws
// ---------------------------------------------------------------------------

async function fetchVersion(
  client: ServiceNowClient,
  debug = false
): Promise<{ version: string; date: string }> {
  const props = await client.queryTable('sys_properties', {
    sysparmQuery: 'nameSTARTSWITHglide.build',
    sysparmFields: 'name,value',
    sysparmLimit: 50,
  }) as { name: string; value: string }[];

  if (debug) {
    console.log(chalk.dim(`  [debug] glide.build.* properties returned (${props.length}):`));
    for (const p of props) {
      console.log(chalk.dim(`    ${p.name} = ${JSON.stringify(p.value)}`));
    }
  }

  if (props.length === 0) throw new Error('No glide.build.* properties accessible');

  const val = (key: string) => {
    const p = props.find(r => r.name === key);
    const raw = p?.value;
    if (!raw) return '';
    if (typeof raw === 'object' && raw !== null) {
      return (raw as Record<string, string>)['value'] ?? (raw as Record<string, string>)['display_value'] ?? '';
    }
    return String(raw).trim();
  };

  // Primary source: glide.buildtag.last  e.g. "glide-utah-07-01-2023__patch7-07-06-2023"
  const buildtag = val('glide.buildtag.last');
  const date     = val('glide.build.date');

  if (!buildtag) throw new Error('glide.buildtag.last is empty or not accessible');

  // Reformat date "07-06-2023_1200" → "2023-07-06"
  const dateShort = date.match(/^(\d{2})-(\d{2})-(\d{4})/)
    ? `${date.slice(6, 10)}-${date.slice(0, 2)}-${date.slice(3, 5)}`
    : date.replace(/_\d+$/, '');

  return { version: buildtag, date: dateShort };
}

async function fetchNodes(
  client: ServiceNowClient
): Promise<{ active: number; total: number }> {
  const nodes = await client.queryTable('sys_cluster_state', {
    sysparmFields: 'node_name,status',
    sysparmLimit: 50,
  }) as { node_name: string; status: string }[];
  const active = nodes.filter(n => n.status === 'Online' || n.status === 'online').length;
  return { active: active || nodes.length, total: nodes.length };
}

async function fetchActiveUsers(client: ServiceNowClient): Promise<number> {
  return countRecords(client, 'sys_user', 'active=true');
}

async function fetchCustomApps(client: ServiceNowClient): Promise<number> {
  return countRecords(client, 'sys_app', 'active=true^scopeSTARTSWITHx_');
}

async function fetchCustomTables(client: ServiceNowClient): Promise<number> {
  return countRecords(client, 'sys_db_object', 'nameSTARTSWITHx_');
}

async function fetchInProgressUpdateSets(
  client: ServiceNowClient
): Promise<{ name: string; sys_created_by: string }[]> {
  return client.queryTable('sys_update_set', {
    sysparmQuery: 'state=in progress^ORDERBYDESCsys_created_on',
    sysparmFields: 'name,sys_created_by',
    sysparmLimit: 5,
  }) as Promise<{ name: string; sys_created_by: string }[]>;
}

async function fetchSyslogErrors(
  client: ServiceNowClient
): Promise<{ count: number; recent: { sys_created_on: string; message: string }[] }> {
  const [count, recent] = await Promise.all([
    countRecords(client, 'syslog', 'level=error^sys_created_on>javascript:gs.hoursAgo(1)'),
    client.queryTable('syslog', {
      sysparmQuery: 'level=error^sys_created_on>javascript:gs.hoursAgo(1)^ORDERBYDESCsys_created_on',
      sysparmFields: 'sys_created_on,message',
      sysparmLimit: 3,
    }) as Promise<{ sys_created_on: string; message: string }[]>,
  ]);
  return { count, recent };
}

async function fetchSchedulerErrors(client: ServiceNowClient): Promise<{ count: number; recent: { message: string }[] }> {
  const [count, recent] = await Promise.all([
    countRecords(client, 'syslog', 'level=error^sys_created_on>javascript:gs.hoursAgo(24)^source=SCHEDULER'),
    client.queryTable('syslog', {
      sysparmQuery: 'level=error^sys_created_on>javascript:gs.hoursAgo(24)^source=SCHEDULER^ORDERBYDESCsys_created_on',
      sysparmFields: 'message',
      sysparmLimit: 3,
    }) as Promise<{ message: string }[]>,
  ]);
  return { count, recent };
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function statusCommand(): Command {
  const cmd = new Command('status')
    .description('Show a health and stats overview of the active instance')
    .option('--no-errors', 'Skip the syslog error sections (faster for restricted users)')
    .option('--debug', 'Print raw property values to help diagnose N/A sections')
    .action(async (opts: { errors: boolean; debug?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Fetching instance stats...').start();

      // Run all fetchers in parallel; failures become null
      const [
        versionResult,
        nodesResult,
        activeUsersResult,
        customAppsResult,
        customTablesResult,
        updateSetsResult,
        syslogResult,
        schedulerResult,
      ] = await Promise.allSettled([
        fetchVersion(client, opts.debug),
        fetchNodes(client),
        fetchActiveUsers(client),
        fetchCustomApps(client),
        fetchCustomTables(client),
        fetchInProgressUpdateSets(client),
        opts.errors ? fetchSyslogErrors(client) : Promise.reject(new Error('skipped')),
        opts.errors ? fetchSchedulerErrors(client) : Promise.reject(new Error('skipped')),
      ]);

      spinner.stop();

      // ---------------------------------------------------------------------------
      // Header
      // ---------------------------------------------------------------------------
      console.log();
      console.log(DIVIDER);
      console.log(`  ${chalk.bold('snow-cli')}  ·  ${chalk.cyan(instance.alias)}  ${chalk.dim(instance.url)}`);
      console.log(DIVIDER);

      // ---------------------------------------------------------------------------
      // Section: Instance
      // ---------------------------------------------------------------------------
      section('Instance');

      if (versionResult.status === 'fulfilled') {
        row('Version', chalk.white(versionResult.value.version));
        if (versionResult.value.date) {
          row('Last updated', chalk.dim(versionResult.value.date));
        }
      } else {
        const reason = opts.debug
          ? NA + chalk.dim(`  (${(versionResult.reason as Error)?.message ?? 'unknown error'})`)
          : NA;
        row('Version', reason);
      }

      if (nodesResult.status === 'fulfilled') {
        const { active, total } = nodesResult.value;
        const nodeStr = total === 0
          ? NA
          : total === 1
          ? chalk.white('1 (single-node)')
          : `${chalk.white(String(active))} active / ${total} total`;
        row('Cluster nodes', nodeStr);
      } else {
        row('Cluster nodes', NA);
      }

      // ---------------------------------------------------------------------------
      // Section: Users
      // ---------------------------------------------------------------------------
      section('Users');

      if (activeUsersResult.status === 'fulfilled') {
        row('Active users', chalk.white(activeUsersResult.value.toLocaleString()));
      } else {
        row('Active users', NA);
      }

      // ---------------------------------------------------------------------------
      // Section: Development
      // ---------------------------------------------------------------------------
      section('Development');

      if (customAppsResult.status === 'fulfilled') {
        row('Custom apps', chalk.white(String(customAppsResult.value)));
      } else {
        row('Custom apps', NA);
      }

      if (customTablesResult.status === 'fulfilled') {
        row('Custom tables', chalk.white(String(customTablesResult.value)));
      } else {
        row('Custom tables', NA);
      }

      if (updateSetsResult.status === 'fulfilled') {
        const sets = updateSetsResult.value;
        const countStr = sets.length === 0
          ? chalk.dim('none')
          : sets.length === 5
          ? chalk.yellow(`${sets.length}+ in progress`)
          : chalk.white(`${sets.length} in progress`);
        row('Update sets', countStr);
        for (const s of sets) {
          const truncName = s.name.length > 32 ? s.name.slice(0, 31) + '…' : s.name;
          console.log(`  ${''.padEnd(22)}${chalk.dim('• ')}${truncName}  ${chalk.dim(s.sys_created_by)}`);
        }
      } else {
        row('Update sets', NA);
      }

      // ---------------------------------------------------------------------------
      // Section: Errors (last hour)
      // ---------------------------------------------------------------------------
      if (!opts.errors) {
        console.log();
        console.log(chalk.dim('  (error sections skipped — pass --errors to include)'));
      } else {
        section('Syslog errors  (last hour)');

        if (syslogResult.status === 'fulfilled') {
          const { count, recent } = syslogResult.value;
          const countColor = count === 0 ? chalk.green : count < 10 ? chalk.yellow : chalk.red;
          row('Error count', countColor(String(count)));
          for (const e of recent) {
            const time = e.sys_created_on.slice(11, 19); // HH:MM:SS
            const msg = e.message.replace(/\s+/g, ' ').trim().slice(0, 60);
            console.log(`  ${''.padEnd(22)}${chalk.dim(`[${time}]`)} ${msg}`);
          }
        } else {
          row('Error count', NA + chalk.dim('  (no access to syslog)'));
        }

        // ---------------------------------------------------------------------------
        // Section: Scheduler errors (last 24h)
        // ---------------------------------------------------------------------------
        section('Scheduler errors  (last 24h)');

        if (schedulerResult.status === 'fulfilled') {
          const { count, recent } = schedulerResult.value;
          const countColor = count === 0 ? chalk.green : count < 5 ? chalk.yellow : chalk.red;
          row('Failed jobs', countColor(String(count)));
          for (const e of recent) {
            const msg = e.message.replace(/\s+/g, ' ').trim().slice(0, 60);
            console.log(`  ${''.padEnd(22)}${chalk.dim('• ')}${msg}`);
          }
        } else {
          row('Failed jobs', NA + chalk.dim('  (no access to syslog)'));
        }
      }

      console.log();
      console.log(DIVIDER);
      console.log();
    });

  return cmd;
}
