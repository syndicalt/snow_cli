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

function levelColor(level: string): string {
  const l = level.toLowerCase();
  if (l === 'err' || l === 'error') return chalk.red(level);
  if (l === 'warn' || l === 'warning') return chalk.yellow(level);
  if (l === 'info') return chalk.cyan(level);
  if (l === 'debug') return chalk.dim(level);
  return level;
}

function formatTimestamp(ts: string): string {
  return chalk.dim(ts.slice(0, 19).replace('T', ' '));
}

export function logCommand(): Command {
  const cmd = new Command('log')
    .description('View system and application logs from the active instance');

  // snow log (system log)
  cmd
    .command('system', { isDefault: true })
    .description('View system log entries (syslog)')
    .option('--level <level>', 'Filter by log level (err, warn, info, debug)')
    .option('--source <source>', 'Filter by log source (e.g. Evaluator)')
    .option('--scope <prefix>', 'Filter by application scope prefix')
    .option('-q, --query <encoded>', 'Additional encoded query filter')
    .option('-l, --limit <n>', 'Max records to return', '50')
    .option('--follow', 'Poll for new entries every few seconds')
    .option('--interval <ms>', 'Polling interval in ms (with --follow)', '5000')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      level?: string; source?: string; scope?: string; query?: string;
      limit: string; follow?: boolean; interval: string; json?: boolean;
    }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const parts: string[] = [];
      if (opts.level)  parts.push(`level=${opts.level}`);
      if (opts.source) parts.push(`source=${opts.source}`);
      if (opts.scope)  parts.push(`sys_scope.scope=${opts.scope}`);
      if (opts.query)  parts.push(opts.query);
      parts.push('ORDERBYDESCsys_created_on');

      const limit = parseInt(opts.limit, 10);

      async function fetchLogs(afterTimestamp?: string): Promise<Record<string, unknown>[]> {
        const queryParts = [...parts];
        if (afterTimestamp) {
          queryParts.unshift(`sys_created_on>${afterTimestamp}`);
          // For follow mode, order ascending so new entries print in order
          const idx = queryParts.findIndex(p => p.startsWith('ORDERBY'));
          if (idx !== -1) queryParts[idx] = 'ORDERBYsys_created_on';
        }
        return client.queryTable('syslog', {
          sysparmQuery: queryParts.join('^') || undefined,
          sysparmFields: 'sys_id,level,source,message,sys_created_on',
          sysparmLimit: afterTimestamp ? 200 : limit,
          sysparmDisplayValue: true,
        }) as Promise<Record<string, unknown>[]>;
      }

      function printLogs(logs: Record<string, unknown>[], asJson: boolean): void {
        if (asJson) { console.log(JSON.stringify(logs, null, 2)); return; }
        for (const entry of logs) {
          const ts      = formatTimestamp(str(entry['sys_created_on']));
          const level   = levelColor(str(entry['level']).padEnd(5));
          const source  = chalk.dim((str(entry['source']) || '—').padEnd(20));
          const message = str(entry['message']);
          console.log(`${ts}  ${level}  ${source}  ${message}`);
        }
      }

      if (!opts.follow) {
        const spinner = ora('Fetching system log...').start();
        try {
          const logs = await fetchLogs();
          spinner.stop();
          if (opts.json) { console.log(JSON.stringify(logs, null, 2)); return; }
          if (logs.length === 0) { console.log(chalk.dim('No log entries found.')); return; }
          console.log();
          console.log(chalk.bold(`System Log  (${instance.alias}  ·  ${logs.length} entries)`));
          console.log(chalk.dim('─'.repeat(80)));
          printLogs([...logs].reverse(), false);
          console.log();
        } catch (err) {
          spinner.fail(chalk.red('Failed to fetch system log'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        return;
      }

      // Follow mode
      console.log(chalk.dim(`Following system log on ${instance.alias} (Ctrl+C to stop)...`));
      let lastTimestamp: string | undefined;

      async function poll(): Promise<void> {
        try {
          const logs = await fetchLogs(lastTimestamp);
          if (logs.length > 0) {
            if (!lastTimestamp) {
              // First fetch: just show most recent entries in correct order
              printLogs([...logs].reverse(), false);
            } else {
              printLogs(logs, false);
            }
            lastTimestamp = str(logs[logs.length - 1]['sys_created_on']);
          }
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      }

      await poll();
      const intervalMs = parseInt(opts.interval, 10);
      setInterval(() => { void poll(); }, intervalMs);
    });

  // snow log app (application log)
  cmd
    .command('app')
    .description('View application log entries (syslog_app_scope)')
    .option('--scope <prefix>', 'Filter by application scope prefix')
    .option('--source <source>', 'Filter by log source')
    .option('-l, --limit <n>', 'Max records to return', '50')
    .option('--follow', 'Poll for new entries every few seconds')
    .option('--interval <ms>', 'Polling interval in ms (with --follow)', '5000')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      scope?: string; source?: string; limit: string;
      follow?: boolean; interval: string; json?: boolean;
    }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const parts: string[] = [];
      if (opts.scope)  parts.push(`sys_scope.scope=${opts.scope}`);
      if (opts.source) parts.push(`source=${opts.source}`);
      parts.push('ORDERBYDESCsys_created_on');

      const limit = parseInt(opts.limit, 10);

      async function fetchAppLogs(afterTimestamp?: string): Promise<Record<string, unknown>[]> {
        const queryParts = [...parts];
        if (afterTimestamp) {
          queryParts.unshift(`sys_created_on>${afterTimestamp}`);
          const idx = queryParts.findIndex(p => p.startsWith('ORDERBY'));
          if (idx !== -1) queryParts[idx] = 'ORDERBYsys_created_on';
        }
        return client.queryTable('syslog_app_scope', {
          sysparmQuery: queryParts.join('^') || undefined,
          sysparmFields: 'sys_id,level,source,message,sys_scope,sys_created_on',
          sysparmLimit: afterTimestamp ? 200 : limit,
          sysparmDisplayValue: true,
        }) as Promise<Record<string, unknown>[]>;
      }

      function printAppLogs(logs: Record<string, unknown>[]): void {
        for (const entry of logs) {
          const ts     = formatTimestamp(str(entry['sys_created_on']));
          const level  = levelColor(str(entry['level']).padEnd(5));
          const scope  = chalk.dim((str(entry['sys_scope']) || '—').padEnd(18));
          const source = chalk.dim((str(entry['source']) || '—').padEnd(16));
          const msg    = str(entry['message']);
          console.log(`${ts}  ${level}  ${scope}  ${source}  ${msg}`);
        }
      }

      if (!opts.follow) {
        const spinner = ora('Fetching application log...').start();
        try {
          const logs = await fetchAppLogs();
          spinner.stop();
          if (opts.json) { console.log(JSON.stringify(logs, null, 2)); return; }
          if (logs.length === 0) { console.log(chalk.dim('No application log entries found.')); return; }
          console.log();
          console.log(chalk.bold(`Application Log  (${instance.alias}  ·  ${logs.length} entries)`));
          console.log(chalk.dim('─'.repeat(80)));
          printAppLogs([...logs].reverse());
          console.log();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          spinner.stop();
          if (errMsg.includes('403')) {
            console.error(chalk.yellow('  Access denied to syslog_app_scope — requires the admin role.'));
            console.error(chalk.dim('  Ask your instance admin to grant you the admin or itil_admin role,'));
            console.error(chalk.dim('  or view app logs in ServiceNow: System Logs → Application Logs.'));
          } else {
            console.error(chalk.red('Failed to fetch application log'));
            console.error(chalk.red(errMsg));
          }
          process.exit(1);
        }
        return;
      }

      console.log(chalk.dim(`Following application log on ${instance.alias} (Ctrl+C to stop)...`));
      let lastTimestamp: string | undefined;

      let permDenied = false;
      async function pollApp(): Promise<void> {
        try {
          const logs = await fetchAppLogs(lastTimestamp);
          if (logs.length > 0) {
            printAppLogs(lastTimestamp ? logs : [...logs].reverse());
            lastTimestamp = str(logs[logs.length - 1]['sys_created_on']);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          if (errMsg.includes('403')) {
            permDenied = true;
            console.error(chalk.yellow('  Access denied to syslog_app_scope — requires the admin role.'));
            console.error(chalk.dim('  Ask your instance admin to grant you the admin or itil_admin role,'));
            console.error(chalk.dim('  or view app logs in ServiceNow: System Logs → Application Logs.'));
            process.exit(1);
          }
          if (!permDenied) console.error(chalk.red(errMsg));
        }
      }

      await pollApp();
      setInterval(() => { void pollApp(); }, parseInt(opts.interval, 10));
    });

  // snow log tx (transaction log)
  cmd
    .command('tx')
    .description('View transaction log entries (syslog_transaction)')
    .option('-l, --limit <n>', 'Max records to return', '25')
    .option('--slow <ms>', 'Only show transactions slower than this many milliseconds')
    .option('--json', 'Output as JSON')
    .action(async (opts: { limit: string; slow?: string; json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching transaction log...').start();

      const parts: string[] = [];
      if (opts.slow) parts.push(`response_time>${opts.slow}`);
      parts.push('ORDERBYDESCsys_created_on');

      try {
        const txs = await client.queryTable('syslog_transaction', {
          sysparmQuery: parts.join('^') || undefined,
          sysparmFields: 'sys_id,url,response_time,status,user_name,sys_created_on',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(txs, null, 2)); return; }
        if (txs.length === 0) { console.log(chalk.dim('No transaction log entries found.')); return; }

        console.log();
        console.log(chalk.bold(`Transaction Log  (${instance.alias}  ·  ${txs.length} entries)`));
        console.log(chalk.dim('─'.repeat(90)));

        for (const tx of ([...txs].reverse() as Record<string, unknown>[])) {
          const ts     = formatTimestamp(str(tx['sys_created_on']));
          const status = str(tx['status']);
          const statusCol = status === '200' ? chalk.green(status) : chalk.yellow(status);
          const ms     = str(tx['response_time']);
          const msCol  = parseInt(ms, 10) > 2000 ? chalk.red(`${ms}ms`) : chalk.dim(`${ms}ms`);
          const user   = chalk.dim((str(tx['user_name']) || '—').padEnd(14));
          const url    = str(tx['url']).slice(0, 60);
          console.log(`${ts}  ${statusCol.padEnd(5)}  ${msCol.padEnd(12)}  ${user}  ${url}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch transaction log'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}
