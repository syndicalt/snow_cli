import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AclRecord {
  sys_id: string;
  name: string;
  operation: string;
  type: string;
  active: string | boolean;
  admin_overrides: string | boolean;
  condition: string;
  script: string;
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

function isTruthy(v: string | boolean): boolean {
  return v === true || v === 'true';
}

function opColor(op: string): string {
  switch (op) {
    case 'read':    return chalk.cyan(op.padEnd(7));
    case 'write':   return chalk.yellow(op.padEnd(7));
    case 'create':  return chalk.green(op.padEnd(7));
    case 'delete':  return chalk.red(op.padEnd(7));
    case 'execute': return chalk.magenta(op.padEnd(7));
    default:        return chalk.dim(op.padEnd(7));
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function aclCommand(): Command {
  const cmd = new Command('acl').description(
    'Inspect Access Control List (ACL) rules for a table'
  );

  // ─── snow acl list <table> ────────────────────────────────────────────────
  cmd
    .command('list <table>')
    .description('List ACL rules for a table')
    .option('--operation <op>', 'Filter by operation: read, write, create, delete, execute')
    .option('--role <role>', 'Filter to ACLs that require a specific role (substring match)')
    .option('--inactive', 'Include inactive ACLs (default: active only)')
    .option('--fields', 'Include field-level ACLs (default: table-level only)')
    .option('--json', 'Output as JSON')
    .addHelpText(
      'after',
      `
Examples:
  snow acl list incident
  snow acl list incident --operation read
  snow acl list incident --operation write --role itil
  snow acl list sys_user --role admin --fields
  snow acl list incident --inactive
`
    )
    .action(
      async (
        table: string,
        opts: {
          operation?: string;
          role?: string;
          inactive?: boolean;
          fields?: boolean;
          json?: boolean;
        }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        // Build sys_security_acl query
        const parts: string[] = [];

        if (opts.fields) {
          // Match table name exactly OR field-level ACLs (table.field)
          parts.push(`nameSTARTSWITH${table}`);
        } else {
          // Table-level only: name equals table, or name matches table.* for record ACLs
          // In SN, record ACLs have name = table name; field ACLs have name = table.fieldname
          parts.push(`name=${table}^ORname=${table}.*`);
          // Simpler: just starts with table and type=record
          parts.length = 0;
          parts.push(`nameSTARTSWITH${table}^type=record`);
        }

        if (!opts.inactive) parts.push('active=true');
        if (opts.operation) parts.push(`operation=${opts.operation}`);
        parts.push('ORDERBYname^ORDERBYoperation');

        const spinner = ora(`Fetching ACLs for ${table}…`).start();

        let acls: AclRecord[];
        let roleMap: Map<string, string[]>;

        try {
          acls = (await client.queryTable('sys_security_acl', {
            sysparmQuery: parts.join('^'),
            sysparmFields:
              'sys_id,name,operation,type,active,admin_overrides,condition,script',
            sysparmLimit: 500,
          })) as unknown as AclRecord[];

          // Fetch role requirements for all returned ACLs
          roleMap = new Map();
          if (acls.length > 0) {
            const aclIds = acls.map((a) => a.sys_id).join(',');
            const roleRecords = (await client.queryTable('sys_security_acl_role', {
              sysparmQuery: `sys_security_aclIN${aclIds}`,
              sysparmFields: 'sys_security_acl,sys_user_role',
              sysparmDisplayValue: true,
              sysparmLimit: 2000,
            })) as unknown as Array<{
              sys_security_acl: unknown;
              sys_user_role: unknown;
            }>;

            for (const r of roleRecords) {
              const aclId = str(r.sys_security_acl) ||
                (r.sys_security_acl as Record<string, string>)?.['value'];
              const roleName = str(r.sys_user_role);
              if (!aclId || !roleName) continue;
              if (!roleMap.has(aclId)) roleMap.set(aclId, []);
              roleMap.get(aclId)!.push(roleName);
            }
          }

          // Post-filter by role if requested
          if (opts.role) {
            const roleFilter = opts.role.toLowerCase();
            acls = acls.filter((a) => {
              const roles = roleMap.get(a.sys_id) ?? [];
              return roles.some((r) => r.toLowerCase().includes(roleFilter));
            });
          }

          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red('Request failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
          return;
        }

        if (opts.json) {
          const out = acls.map((a) => ({ ...a, roles: roleMap.get(a.sys_id) ?? [] }));
          console.log(JSON.stringify(out, null, 2));
          return;
        }

        if (acls.length === 0) {
          console.log(chalk.yellow(`No ACLs found for "${table}".`));
          return;
        }

        const DIVIDER = chalk.dim('─'.repeat(64));
        console.log();
        console.log(DIVIDER);
        console.log(
          `  ${chalk.bold('ACLs for')} ${chalk.cyan(table)}` +
            chalk.dim(`  (${acls.length} rule${acls.length === 1 ? '' : 's'})`)
        );
        console.log(DIVIDER);

        for (const acl of acls) {
          const roles       = roleMap.get(acl.sys_id) ?? [];
          const inactive    = !isTruthy(acl.active);
          const adminOver   = isTruthy(acl.admin_overrides);
          const hasScript   = Boolean(acl.script?.trim());
          const hasCondition = Boolean(acl.condition?.trim());

          const flags: string[] = [];
          if (inactive)     flags.push(chalk.dim('[inactive]'));
          if (adminOver)    flags.push(chalk.dim('[admin-overrides]'));
          if (hasCondition) flags.push(chalk.dim('[condition]'));
          if (hasScript)    flags.push(chalk.dim('[script]'));

          const nameStr = inactive ? chalk.dim(acl.name) : chalk.bold(acl.name);
          const typeStr = chalk.dim(acl.type || 'record');

          console.log();
          console.log(
            `  ${nameStr}  ${opColor(acl.operation)}  ${typeStr}  ${flags.join('  ')}`
          );

          if (roles.length === 0) {
            console.log(`    ${chalk.dim('Roles:')} ${chalk.yellow('(none required)')}`);
          } else {
            console.log(`    ${chalk.dim('Roles:')} ${roles.join(', ')}`);
          }
        }

        console.log();
        console.log(DIVIDER);
        console.log(
          chalk.dim(`  ${acls.length} rule${acls.length === 1 ? '' : 's'}`) +
            (opts.role ? chalk.dim(`  filtered to role: ${opts.role}`) : '')
        );
        console.log();
      }
    );

  return cmd;
}
