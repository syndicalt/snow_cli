import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

/** Resolve a user by user_name, email, or sys_id. Returns the sys_id. */
async function resolveUser(client: ServiceNowClient, query: string): Promise<{ sysId: string; name: string }> {
  // Try sys_id format first (32-char hex)
  const isSysId = /^[0-9a-f]{32}$/i.test(query);
  const snQuery = isSysId
    ? `sys_id=${query}`
    : `user_name=${query}^ORemail=${query}^ORname=${query}`;

  const res = await client.queryTable('sys_user', {
    sysparmQuery: snQuery,
    sysparmFields: 'sys_id,name,user_name,email',
    sysparmLimit: 2,
  }) as { sys_id: string; name: string; user_name: string; email: string }[];

  if (res.length === 0) throw new Error(`User not found: ${query}`);
  if (res.length > 1) throw new Error(`Ambiguous user query "${query}" — matched multiple users. Use sys_id or user_name.`);

  return { sysId: res[0].sys_id, name: `${res[0].name} (${res[0].user_name})` };
}

/** Resolve a group by name or sys_id. Returns the sys_id. */
async function resolveGroup(client: ServiceNowClient, query: string): Promise<{ sysId: string; name: string }> {
  const isSysId = /^[0-9a-f]{32}$/i.test(query);
  const snQuery = isSysId ? `sys_id=${query}` : `name=${query}`;

  const res = await client.queryTable('sys_user_group', {
    sysparmQuery: snQuery,
    sysparmFields: 'sys_id,name',
    sysparmLimit: 2,
  }) as { sys_id: string; name: string }[];

  if (res.length === 0) throw new Error(`Group not found: ${query}`);
  if (res.length > 1) throw new Error(`Ambiguous group query "${query}" — matched multiple groups. Use sys_id or exact name.`);

  return { sysId: res[0].sys_id, name: res[0].name };
}

/** Resolve a role by name or sys_id. Returns the sys_id. */
async function resolveRole(client: ServiceNowClient, query: string): Promise<{ sysId: string; name: string }> {
  const isSysId = /^[0-9a-f]{32}$/i.test(query);
  const snQuery = isSysId ? `sys_id=${query}` : `name=${query}`;

  const res = await client.queryTable('sys_user_role', {
    sysparmQuery: snQuery,
    sysparmFields: 'sys_id,name',
    sysparmLimit: 2,
  }) as { sys_id: string; name: string }[];

  if (res.length === 0) throw new Error(`Role not found: ${query}`);
  if (res.length > 1) throw new Error(`Ambiguous role "${query}" — use sys_id or exact name.`);

  return { sysId: res[0].sys_id, name: res[0].name };
}

export function userCommand(): Command {
  const cmd = new Command('user').description('Manage ServiceNow users, groups, and roles');

  // snow user add-to-group <user> <group>
  cmd
    .command('add-to-group <user> <group>')
    .description('Add a user to a group')
    .option('--yes', 'Skip confirmation')
    .action(async (userQuery: string, groupQuery: string, opts: { yes?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Resolving user and group...').start();
      let user: { sysId: string; name: string };
      let group: { sysId: string; name: string };
      try {
        [user, group] = await Promise.all([
          resolveUser(client, userQuery),
          resolveGroup(client, groupQuery),
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Check if already a member
      const existing = await client.queryTable('sys_user_grmember', {
        sysparmQuery: `user=${user.sysId}^group=${group.sysId}`,
        sysparmFields: 'sys_id',
        sysparmLimit: 1,
      });
      if (existing.length > 0) {
        console.log(chalk.yellow(`${user.name} is already a member of ${group.name}.`));
        return;
      }

      console.log(`Add ${chalk.cyan(user.name)} to group ${chalk.cyan(group.name)} on ${chalk.bold(instance.alias)}?`);

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed?', default: true });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      const addSpinner = ora('Adding to group...').start();
      try {
        await client.createRecord('sys_user_grmember', { user: user.sysId, group: group.sysId });
        addSpinner.succeed(chalk.green(`Added ${user.name} to ${group.name}.`));
      } catch (err) {
        addSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow user remove-from-group <user> <group>
  cmd
    .command('remove-from-group <user> <group>')
    .description('Remove a user from a group')
    .option('--yes', 'Skip confirmation')
    .action(async (userQuery: string, groupQuery: string, opts: { yes?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Resolving user and group...').start();
      let user: { sysId: string; name: string };
      let group: { sysId: string; name: string };
      try {
        [user, group] = await Promise.all([
          resolveUser(client, userQuery),
          resolveGroup(client, groupQuery),
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const members = await client.queryTable('sys_user_grmember', {
        sysparmQuery: `user=${user.sysId}^group=${group.sysId}`,
        sysparmFields: 'sys_id',
        sysparmLimit: 1,
      }) as { sys_id: string }[];

      if (members.length === 0) {
        console.log(chalk.yellow(`${user.name} is not a member of ${group.name}.`));
        return;
      }

      console.log(`Remove ${chalk.cyan(user.name)} from group ${chalk.cyan(group.name)} on ${chalk.bold(instance.alias)}?`);

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed?', default: false });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      const removeSpinner = ora('Removing from group...').start();
      try {
        await client.deleteRecord('sys_user_grmember', members[0].sys_id);
        removeSpinner.succeed(chalk.green(`Removed ${user.name} from ${group.name}.`));
      } catch (err) {
        removeSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow user assign-role <user> <role>
  cmd
    .command('assign-role <user> <role>')
    .description('Assign a role to a user')
    .option('--yes', 'Skip confirmation')
    .action(async (userQuery: string, roleQuery: string, opts: { yes?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Resolving user and role...').start();
      let user: { sysId: string; name: string };
      let role: { sysId: string; name: string };
      try {
        [user, role] = await Promise.all([
          resolveUser(client, userQuery),
          resolveRole(client, roleQuery),
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const existing = await client.queryTable('sys_user_has_role', {
        sysparmQuery: `user=${user.sysId}^role=${role.sysId}`,
        sysparmFields: 'sys_id',
        sysparmLimit: 1,
      });
      if (existing.length > 0) {
        console.log(chalk.yellow(`${user.name} already has role ${role.name}.`));
        return;
      }

      console.log(`Assign role ${chalk.cyan(role.name)} to ${chalk.cyan(user.name)} on ${chalk.bold(instance.alias)}?`);

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed?', default: true });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      const assignSpinner = ora('Assigning role...').start();
      try {
        await client.createRecord('sys_user_has_role', { user: user.sysId, role: role.sysId });
        assignSpinner.succeed(chalk.green(`Assigned role ${role.name} to ${user.name}.`));
      } catch (err) {
        assignSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow user remove-role <user> <role>
  cmd
    .command('remove-role <user> <role>')
    .description('Remove a role from a user')
    .option('--yes', 'Skip confirmation')
    .action(async (userQuery: string, roleQuery: string, opts: { yes?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Resolving user and role...').start();
      let user: { sysId: string; name: string };
      let role: { sysId: string; name: string };
      try {
        [user, role] = await Promise.all([
          resolveUser(client, userQuery),
          resolveRole(client, roleQuery),
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const existing = await client.queryTable('sys_user_has_role', {
        sysparmQuery: `user=${user.sysId}^role=${role.sysId}`,
        sysparmFields: 'sys_id',
        sysparmLimit: 1,
      }) as { sys_id: string }[];

      if (existing.length === 0) {
        console.log(chalk.yellow(`${user.name} does not have role ${role.name}.`));
        return;
      }

      console.log(`Remove role ${chalk.cyan(role.name)} from ${chalk.cyan(user.name)} on ${chalk.bold(instance.alias)}?`);

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed?', default: false });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      const removeSpinner = ora('Removing role...').start();
      try {
        await client.deleteRecord('sys_user_has_role', existing[0].sys_id);
        removeSpinner.succeed(chalk.green(`Removed role ${role.name} from ${user.name}.`));
      } catch (err) {
        removeSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}
