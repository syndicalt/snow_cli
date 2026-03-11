import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance, getActiveProvider } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import { buildProvider } from '../lib/llm.js';

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

  // snow log analyze
  cmd
    .command('analyze')
    .description('Fetch recent log errors and use AI to identify patterns, root causes, and fixes')
    .option('--level <level>', 'Log level to fetch (default: err)', 'err')
    .option('-l, --limit <n>', 'Number of log entries to analyse', '50')
    .option('--source <source>', 'Filter by log source')
    .option('--scope <prefix>', 'Filter by application scope prefix')
    .option('--provider <name>', 'Override the active LLM provider')
    .option('--save <file>', 'Save the analysis to a file')
    .addHelpText(
      'after',
      `
Examples:
  snow log analyze
  snow log analyze --limit 100
  snow log analyze --source Evaluator
  snow log analyze --scope x_myco_myapp
  snow log analyze --level warn --limit 75
  snow log analyze --save ./error-report.md
`
    )
    .action(async (opts: {
      level: string; limit: string; source?: string;
      scope?: string; provider?: string; save?: string;
    }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      // ── Fetch log entries ─────────────────────────────────────────────────
      const spinner = ora(`Fetching ${opts.level} log entries…`).start();

      const parts: string[] = [];
      parts.push(`level=${opts.level}`);
      if (opts.source) parts.push(`source=${opts.source}`);
      if (opts.scope)  parts.push(`sys_scope.scope=${opts.scope}`);
      parts.push('ORDERBYDESCsys_created_on');

      let logs: Record<string, unknown>[];
      try {
        logs = await client.queryTable('syslog', {
          sysparmQuery: parts.join('^'),
          sysparmFields: 'sys_id,level,source,message,sys_created_on',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        }) as Record<string, unknown>[];
        spinner.succeed(`Fetched ${logs.length} log entries.`);
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch log entries'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
        return;
      }

      if (logs.length === 0) {
        console.log(chalk.dim(`  No ${opts.level} entries found.`));
        return;
      }

      // Print a brief preview
      const DIVIDER = chalk.dim('─'.repeat(72));
      console.log();
      console.log(DIVIDER);
      console.log(`  ${chalk.bold(`${logs.length} log entries`)}  ${chalk.dim(`(${opts.level}  ·  ${instance.alias})`)}`);
      console.log(DIVIDER);
      const preview = [...logs].reverse().slice(0, 10);
      for (const entry of preview) {
        const ts  = str(entry['sys_created_on']).slice(0, 19).replace('T', ' ');
        const src = (str(entry['source']) || '—').slice(0, 20).padEnd(20);
        const msg = str(entry['message']).slice(0, 80);
        console.log(`  ${chalk.dim(ts)}  ${chalk.dim(src)}  ${msg}`);
      }
      if (logs.length > 10) {
        console.log(chalk.dim(`  … and ${logs.length - 10} more entries`));
      }
      console.log();

      // ── LLM analysis ─────────────────────────────────────────────────────
      const llmProvider = getActiveProvider();
      if (!llmProvider) {
        console.log(
          chalk.yellow('  No LLM provider configured.') +
          chalk.dim(' Run `snow provider set <name>` to enable AI analysis.')
        );
        return;
      }

      let provider = buildProvider(
        llmProvider.name,
        llmProvider.config.model,
        llmProvider.config.apiKey,
        llmProvider.config.baseUrl
      );

      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
          return;
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      // Format logs for the prompt — reverse so oldest-first for readability
      const logText = [...logs].reverse()
        .map((e) => `[${str(e['sys_created_on']).slice(0, 19)}] [${str(e['source'])}] ${str(e['message'])}`)
        .join('\n');

      const systemPrompt = `You are a ServiceNow platform expert specialising in diagnosing runtime errors and log patterns.

Your task is to analyse a batch of ServiceNow system log entries and produce a structured diagnostic report. Focus on:
1. Identifying recurring error patterns and grouping related errors together
2. Diagnosing the root cause of each distinct error category
3. Recommending specific fixes (code changes, configuration, permissions, etc.)
4. Flagging any critical or high-severity issues that need immediate attention

Use markdown formatting. Be specific — reference the source, script names, and error messages directly. Prioritise by severity and frequency.`;

      const userPrompt = `Analyse these ${logs.length} ServiceNow ${opts.level} log entries from instance "${instance.alias}"` +
        (opts.scope ? ` (scope: ${opts.scope})` : '') + ':\n\n' + logText;

      const llmSpinner = ora(`Analyzing with ${provider.providerName}…`).start();
      let analysis: string;
      try {
        analysis = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ]);
        llmSpinner.succeed('Analysis complete.');
      } catch (err) {
        llmSpinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        return;
      }

      console.log();
      for (const line of analysis.trim().split('\n')) {
        console.log(line);
      }
      console.log();

      if (opts.save) {
        const { writeFileSync } = await import('fs');
        const header = `# Log Analysis — ${instance.alias}\n\nLevel: ${opts.level}  ·  Entries: ${logs.length}  ·  Generated: ${new Date().toISOString()}\n\n---\n\n`;
        writeFileSync(opts.save, header + analysis.trim() + '\n');
        console.log(chalk.dim(`  Analysis saved to ${opts.save}`));
        console.log();
      }
    });

  return cmd;
}
