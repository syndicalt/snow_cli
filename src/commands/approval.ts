import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ApprovalRecord {
  sys_id: string;
  document_id: unknown;
  approver: unknown;
  state: string;
  comments: string;
  sys_created_on: string;
  due_date: string;
  source_table: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const obj = v as Record<string, string>;
    return obj['display_value'] ?? obj['value'] ?? '';
  }
  return String(v).trim();
}

function stateColor(state: string): string {
  switch (state) {
    case 'requested':    return chalk.yellow(state);
    case 'approved':     return chalk.green(state);
    case 'rejected':     return chalk.red(state);
    case 'not_required': return chalk.dim(state);
    case 'cancelled':    return chalk.dim(state);
    default:             return chalk.dim(state);
  }
}

async function fetchAndPrintApproval(
  client: ServiceNowClient,
  sysId: string
): Promise<ApprovalRecord> {
  const record = await client.getRecord('sysapproval_approver', sysId, {
    sysparmFields: 'sys_id,document_id,approver,state,comments,sys_created_on,due_date,source_table',
    sysparmDisplayValue: true,
  }) as unknown as ApprovalRecord;

  console.log();
  console.log(`  ${chalk.bold('sys_id:')}    ${record.sys_id}`);
  console.log(`  ${chalk.dim('For:')}       ${str(record.document_id) || chalk.dim('(unknown)')}`);
  console.log(`  ${chalk.dim('Approver:')}  ${str(record.approver)}`);
  console.log(`  ${chalk.dim('State:')}     ${stateColor(record.state)}`);
  if (record.due_date) console.log(`  ${chalk.dim('Due:')}       ${str(record.due_date)}`);
  if (str(record.comments)) console.log(`  ${chalk.dim('Comment:')}  ${str(record.comments)}`);
  console.log();

  return record;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function approvalCommand(): Command {
  const cmd = new Command('approval').description(
    'List and action ServiceNow approval requests'
  );

  // ─── snow approval list ───────────────────────────────────────────────────
  cmd
    .command('list')
    .description('List approval requests')
    .option(
      '--state <state>',
      'Filter by state: requested, approved, rejected, cancelled (default: requested)'
    )
    .option('--all', 'Show all approvers\' approvals (default: current user only for basic auth)')
    .option('-l, --limit <n>', 'Max results (default: 25)', '25')
    .option('--json', 'Output as JSON')
    .action(
      async (opts: { state?: string; all?: boolean; limit: string; json?: boolean }) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);
        const limit = parseInt(opts.limit, 10) || 25;
        const state = opts.state ?? 'requested';

        const parts = [`state=${state}`];
        if (!opts.all && instance.auth.type === 'basic') {
          parts.push(`approver.user_name=${instance.auth.username}`);
        }
        parts.push('ORDERBYDESCsys_created_on');

        const spinner = ora('Fetching approvals…').start();
        let records: ApprovalRecord[];
        try {
          records = (await client.queryTable('sysapproval_approver', {
            sysparmQuery: parts.join('^'),
            sysparmFields:
              'sys_id,document_id,approver,state,comments,sys_created_on,due_date,source_table',
            sysparmDisplayValue: true,
            sysparmLimit: limit,
          })) as unknown as ApprovalRecord[];
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red('Request failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(records, null, 2));
          return;
        }

        if (records.length === 0) {
          console.log(chalk.dim(`No ${state} approvals found.`));
          return;
        }

        const DIVIDER = chalk.dim('─'.repeat(60));
        console.log();
        console.log(DIVIDER);
        console.log(
          `  ${chalk.bold('Approvals')}  ${chalk.dim(state)}  ` +
            chalk.dim(`(${records.length} result${records.length === 1 ? '' : 's'})`)
        );
        console.log(DIVIDER);

        for (const r of records) {
          const doc      = str(r.document_id) || chalk.dim('(unknown)');
          const approver = str(r.approver);
          const created  = String(r.sys_created_on).slice(0, 10);
          const due      = r.due_date ? chalk.dim(`  due ${str(r.due_date).slice(0, 10)}`) : '';

          console.log();
          console.log(`  ${chalk.bold(r.sys_id)}  ${stateColor(r.state)}${due}`);
          console.log(`  ${chalk.dim('For:')}      ${doc}`);
          console.log(`  ${chalk.dim('Approver:')} ${approver}`);
          console.log(`  ${chalk.dim('Created:')}  ${created}`);
          if (str(r.comments)) {
            console.log(
              `  ${chalk.dim('Comment:')}  ${str(r.comments).replace(/\s+/g, ' ').slice(0, 80)}`
            );
          }
        }

        console.log();
        console.log(DIVIDER);
        console.log(chalk.dim(`  ${records.length} approval${records.length === 1 ? '' : 's'}`));
        console.log();
      }
    );

  // ─── snow approval approve <sys_id> ──────────────────────────────────────
  cmd
    .command('approve <sys_id>')
    .description('Approve an approval request')
    .option('-c, --comment <text>', 'Comment to include with the approval')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (sysId: string, opts: { comment?: string; yes?: boolean }) => {
      await setApprovalState(sysId, 'approved', opts.comment, opts.yes);
    });

  // ─── snow approval reject <sys_id> ───────────────────────────────────────
  cmd
    .command('reject <sys_id>')
    .description('Reject an approval request')
    .option('-c, --comment <text>', 'Comment explaining the rejection (recommended)')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (sysId: string, opts: { comment?: string; yes?: boolean }) => {
      await setApprovalState(sysId, 'rejected', opts.comment, opts.yes);
    });

  return cmd;
}

async function setApprovalState(
  sysId: string,
  state: 'approved' | 'rejected',
  comment?: string,
  skipConfirm?: boolean
): Promise<void> {
  const instance = requireActiveInstance();
  const client = new ServiceNowClient(instance);

  const spinner = ora('Fetching approval…').start();
  let record: ApprovalRecord;
  try {
    record = await fetchAndPrintApproval(client, sysId).then((r) => {
      spinner.stop();
      return r;
    });
  } catch (err) {
    spinner.fail(chalk.red('Not found'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
    return;
  }

  if (record.state !== 'requested') {
    console.log(
      chalk.yellow(
        `Warning: approval is currently "${record.state}", not "requested". Proceeding anyway.`
      )
    );
    console.log();
  }

  const actionLabel = state === 'approved' ? chalk.green('approve') : chalk.red('reject');
  console.log(`  Action:   ${actionLabel}`);
  if (comment) console.log(`  Comment:  ${comment}`);
  console.log();

  if (!skipConfirm) {
    const ok = await confirm({
      message: `${state === 'approved' ? 'Approve' : 'Reject'} this request?`,
      default: false,
    });
    if (!ok) {
      console.log(chalk.dim('Cancelled.'));
      return;
    }
  }

  const spinner2 = ora(`Setting state to ${state}…`).start();
  try {
    const data: Record<string, string> = { state };
    if (comment) data['comments'] = comment;
    await client.updateRecord('sysapproval_approver', sysId, data);
    spinner2.succeed(chalk.green(`Approval ${state}`));
  } catch (err) {
    spinner2.fail(chalk.red('Failed'));
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
