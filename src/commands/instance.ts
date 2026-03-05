import { Command } from 'commander';
import chalk from 'chalk';
import { input, password, select, confirm } from '@inquirer/prompts';
import {
  addInstance,
  removeInstance,
  setActiveInstance,
  listInstances,
  loadConfig,
} from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import type { Instance, BasicAuth, OAuthAuth } from '../types/index.js';

export function instanceCommand(): Command {
  const cmd = new Command('instance').description(
    'Manage ServiceNow instance connections'
  );

  cmd
    .command('add')
    .description('Add a new ServiceNow instance')
    .option('-a, --alias <alias>', 'Alias for the instance')
    .option('-u, --url <url>', 'Instance URL (e.g. https://dev12345.service-now.com)')
    .option('--auth <type>', 'Auth type: basic or oauth')
    .action(async (opts: { alias?: string; url?: string; auth?: string }) => {
      const alias =
        opts.alias ??
        (await input({
          message: 'Alias for this instance:',
          validate: (v) => (v.trim() ? true : 'Alias is required'),
        }));

      const config = loadConfig();
      if (config.instances[alias]) {
        const overwrite = await confirm({
          message: `Instance "${alias}" already exists. Overwrite?`,
          default: false,
        });
        if (!overwrite) {
          console.log('Aborted.');
          return;
        }
      }

      const url =
        opts.url ??
        (await input({
          message: 'Instance URL:',
          validate: (v) => {
            try {
              new URL(v);
              return true;
            } catch {
              return 'Enter a valid URL (e.g. https://dev12345.service-now.com)';
            }
          },
        }));

      const authType =
        (opts.auth as 'basic' | 'oauth' | undefined) ??
        (await select({
          message: 'Authentication type:',
          choices: [
            { name: 'Basic (username/password)', value: 'basic' },
            { name: 'OAuth (client credentials)', value: 'oauth' },
          ],
        }));

      let auth: BasicAuth | OAuthAuth;

      if (authType === 'basic') {
        const username = await input({
          message: 'Username:',
          validate: (v) => (v.trim() ? true : 'Username is required'),
        });
        const pwd = await password({
          message: 'Password:',
          mask: '*',
        });
        auth = { type: 'basic', username, password: pwd };
      } else {
        const clientId = await input({
          message: 'OAuth Client ID:',
          validate: (v) => (v.trim() ? true : 'Client ID is required'),
        });
        const clientSecret = await password({
          message: 'OAuth Client Secret:',
          mask: '*',
        });
        auth = { type: 'oauth', clientId, clientSecret };
      }

      const instance: Instance = { alias, url: url.replace(/\/$/, ''), auth };

      console.log(chalk.dim('Testing connection...'));
      try {
        const client = new ServiceNowClient(instance);
        await client.get('/api/now/table/sys_user?sysparm_limit=1');
        console.log(chalk.green('Connection successful.'));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(chalk.yellow(`Warning: Could not verify connection: ${msg}`));
        const proceed = await confirm({
          message: 'Save instance anyway?',
          default: false,
        });
        if (!proceed) return;
      }

      addInstance(instance);
      console.log(chalk.green(`Instance "${alias}" saved.`));

      const config2 = loadConfig();
      if (config2.activeInstance === alias) {
        console.log(chalk.dim(`"${alias}" is now the active instance.`));
      }
    });

  cmd
    .command('remove <alias>')
    .description('Remove a configured instance')
    .action(async (alias: string) => {
      const ok = await confirm({
        message: `Remove instance "${alias}"?`,
        default: false,
      });
      if (!ok) return;

      if (removeInstance(alias)) {
        console.log(chalk.green(`Instance "${alias}" removed.`));
      } else {
        console.error(chalk.red(`Instance "${alias}" not found.`));
        process.exit(1);
      }
    });

  cmd
    .command('list')
    .alias('ls')
    .description('List configured instances')
    .action(() => {
      const instances = listInstances();
      if (instances.length === 0) {
        console.log('No instances configured. Run `snow instance add` to add one.');
        return;
      }

      for (const { instance, active } of instances) {
        const marker = active ? chalk.green('*') : ' ';
        const authLabel =
          instance.auth.type === 'basic'
            ? chalk.dim(`basic (${instance.auth.username})`)
            : chalk.dim('oauth');
        console.log(`${marker} ${chalk.bold(instance.alias)}  ${instance.url}  ${authLabel}`);
      }
    });

  cmd
    .command('use <alias>')
    .description('Switch the active instance')
    .action((alias: string) => {
      if (setActiveInstance(alias)) {
        console.log(chalk.green(`Active instance set to "${alias}".`));
      } else {
        console.error(chalk.red(`Instance "${alias}" not found.`));
        process.exit(1);
      }
    });

  cmd
    .command('test')
    .description('Test connection to the active instance')
    .action(async () => {
      const { requireActiveInstance } = await import('../lib/config.js');
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      try {
        await client.get('/api/now/table/sys_user?sysparm_limit=1');
        console.log(
          chalk.green(`Connection to "${instance.alias}" (${instance.url}) is OK.`)
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(chalk.red(`Connection failed: ${msg}`));
        process.exit(1);
      }
    });

  return cmd;
}
