import { Command } from 'commander';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, extname } from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

/**
 * Determine the file extension for a given ServiceNow field type.
 * Script fields are JavaScript; HTML fields get .html; CSS gets .css, etc.
 */
function extensionForField(fieldName: string, fieldType?: string): string {
  if (fieldType === 'html' || fieldName.endsWith('_html')) return '.html';
  if (fieldType === 'css' || fieldName === 'css') return '.css';
  if (fieldType === 'xml') return '.xml';
  if (fieldType === 'json') return '.json';
  return '.js';
}

/**
 * Resolve which editor to launch.
 * Priority: --editor flag > $VISUAL > $EDITOR > common defaults.
 */
function resolveEditor(flag?: string): string {
  if (flag) return flag;
  if (process.env['VISUAL']) return process.env['VISUAL'];
  if (process.env['EDITOR']) return process.env['EDITOR'];

  const isWindows = process.platform === 'win32';
  const lookup = isWindows ? 'where' : 'which';
  const candidates = isWindows
    ? ['code', 'notepad++', 'notepad']
    : ['code', 'nvim', 'vim', 'nano', 'vi'];

  for (const editor of candidates) {
    const result = spawnSync(lookup, [editor], { encoding: 'utf-8', shell: isWindows });
    if (result.status === 0) return editor;
  }

  return isWindows ? 'notepad' : 'vi';
}

export function scriptCommand(): Command {
  const cmd = new Command('script').description(
    'Download, edit, and push script fields to/from a ServiceNow instance'
  );

  // snow script pull <table> <sys_id> <field>
  cmd
    .command('pull <table> <sys_id> <field>')
    .description('Download a script field to a local file and open it in an editor')
    .option('-e, --editor <editor>', 'Editor to open (default: $VISUAL / $EDITOR)')
    .option('-o, --out <file>', 'Save to a specific file path instead of a temp file')
    .option('--no-open', 'Download without opening the editor')
    .action(
      async (
        table: string,
        sysId: string,
        field: string,
        opts: { editor?: string; out?: string; open: boolean }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        const spinner = ora(`Fetching ${table}/${sysId} field "${field}"...`).start();

        let record: Record<string, unknown>;
        try {
          record = await client.getRecord(table, sysId, {
            sysparmFields: `${field},sys_id,name,sys_name`,
          });
          spinner.stop();
        } catch (err) {
          spinner.fail();
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        const content = String(record[field] ?? '');

        // Determine file path
        let filePath: string;
        if (opts.out) {
          filePath = opts.out;
        } else {
          const dir = join(homedir(), '.snow', 'scripts');
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          const safeName = `${table}_${sysId}_${field}`.replace(/[^a-z0-9_-]/gi, '_');
          filePath = join(dir, `${safeName}${extensionForField(field)}`);
        }

        writeFileSync(filePath, content, 'utf-8');
        console.log(chalk.green(`Saved to: ${filePath}`));

        if (opts.open === false) return;

        const editor = resolveEditor(opts.editor);
        console.log(chalk.dim(`Opening with: ${editor}`));

        const result = spawnSync(editor, [filePath], {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        });

        if (result.status !== 0) {
          console.error(chalk.red(`Editor exited with code ${result.status ?? '?'}`));
          process.exit(result.status ?? 1);
        }

        // After editor closes, prompt to push
        const { confirm } = await import('@inquirer/prompts');
        const shouldPush = await confirm({
          message: `Push changes to ${instance.alias}?`,
          default: true,
        });

        if (!shouldPush) {
          console.log(chalk.dim(`File kept at: ${filePath}`));
          return;
        }

        await pushScript(client, table, sysId, field, filePath);
      }
    );

  // snow script push <table> <sys_id> <field> [file]
  cmd
    .command('push <table> <sys_id> <field> [file]')
    .description('Push a local file to a script field on the instance')
    .action(async (table: string, sysId: string, field: string, file?: string) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      // Resolve file path
      let filePath: string;
      if (file) {
        filePath = file;
      } else {
        const dir = join(homedir(), '.snow', 'scripts');
        const safeName = `${table}_${sysId}_${field}`.replace(/[^a-z0-9_-]/gi, '_');
        filePath = join(dir, `${safeName}${extensionForField(field)}`);
      }

      if (!existsSync(filePath)) {
        console.error(chalk.red(`File not found: ${filePath}`));
        console.error(chalk.dim('Run `snow script pull` first, or provide a file path.'));
        process.exit(1);
      }

      await pushScript(client, table, sysId, field, filePath);
    });

  // snow script list
  cmd
    .command('list')
    .alias('ls')
    .description('List locally cached script files')
    .action(() => {
      const dir = join(homedir(), '.snow', 'scripts');
      if (!existsSync(dir)) {
        console.log(chalk.dim('No scripts cached yet. Run `snow script pull` first.'));
        return;
      }

      const files = readdirSync(dir);
      if (files.length === 0) {
        console.log(chalk.dim('No scripts cached.'));
        return;
      }

      for (const f of files) {
        const stat = statSync(join(dir, f));
        const modified = stat.mtime.toLocaleString();
        console.log(`${chalk.cyan(f)}  ${chalk.dim(modified)}`);
      }
    });

  return cmd;
}

async function pushScript(
  client: ServiceNowClient,
  table: string,
  sysId: string,
  field: string,
  filePath: string
): Promise<void> {
  const content = readFileSync(filePath, 'utf-8');
  const spinner = ora(`Pushing to ${table}/${sysId} field "${field}"...`).start();

  try {
    await client.updateRecord(table, sysId, { [field]: content });
    spinner.succeed(chalk.green(`Pushed successfully to ${table}/${sysId}.`));
  } catch (err) {
    spinner.fail();
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }
}
