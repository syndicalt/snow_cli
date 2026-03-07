import { Command } from 'commander';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join, extname } from 'path';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

/** Tables that commonly hold server-side or client-side scripts, keyed by short label. */
const SCRIPT_TABLES: { table: string; field: string; label: string }[] = [
  { table: 'sys_script_include', field: 'script',  label: 'Script Include' },
  { table: 'sys_script',         field: 'script',  label: 'Business Rule' },
  { table: 'sys_script_client',  field: 'script',  label: 'Client Script' },
  { table: 'sys_ui_action',      field: 'script',  label: 'UI Action' },
  { table: 'sys_ui_page',        field: 'html',    label: 'UI Page (HTML)' },
  { table: 'sys_ui_page',        field: 'client_script', label: 'UI Page (Client)' },
  { table: 'sys_ui_page',        field: 'processing_script', label: 'UI Page (Server)' },
  { table: 'sysauto_script',     field: 'script',  label: 'Scheduled Job' },
];

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

  // snow script search <scope> --contains <pattern> [--tables t1,t2]
  cmd
    .command('search <scope>')
    .description('Search for a pattern across script fields in an app scope')
    .requiredOption('-c, --contains <pattern>', 'Text or regex pattern to search for')
    .option('-t, --tables <tables>', 'Comma-separated list of tables to search (default: all script tables)')
    .option('--regex', 'Treat --contains as a JavaScript regex')
    .option('-l, --limit <n>', 'Max records to fetch per table (default: 500)', '500')
    .action(async (
      scope: string,
      opts: { contains: string; tables?: string; regex?: boolean; limit: string }
    ) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const limit = parseInt(opts.limit, 10) || 500;
      const tables = opts.tables
        ? opts.tables.split(',').map(t => t.trim()).flatMap(t =>
            SCRIPT_TABLES.filter(st => st.table === t)
          )
        : SCRIPT_TABLES;

      // Build the match function
      let matcher: (content: string) => boolean;
      if (opts.regex) {
        const re = new RegExp(opts.contains, 'g');
        matcher = (s) => re.test(s);
      } else {
        matcher = (s) => s.includes(opts.contains);
      }

      let totalMatches = 0;

      for (const { table, field, label } of tables) {
        const spinner = ora(`Searching ${label} (${table}.${field})...`).start();
        let records: Record<string, string>[];
        try {
          records = (await client.queryTable(table, {
            sysparmQuery: `sys_scope.scope=${scope}^${field}ISNOTEMPTY`,
            sysparmFields: `sys_id,name,${field}`,
            sysparmLimit: limit,
          })) as Record<string, string>[];
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red(`${label}: ${err instanceof Error ? err.message : String(err)}`));
          continue;
        }

        const matches = records.filter(r => matcher(r[field] ?? ''));
        if (matches.length === 0) continue;

        console.log(chalk.bold(`\n${label} — ${matches.length} match(es):`));
        for (const r of matches) {
          const content = r[field] ?? '';
          const lines = content.split('\n');
          const matchingLines = lines
            .map((line, i) => ({ line, num: i + 1 }))
            .filter(({ line }) => matcher(line));

          console.log(`  ${chalk.cyan(r['name'] ?? r['sys_id'])}  ${chalk.dim(r['sys_id'])}`);
          for (const { line, num } of matchingLines.slice(0, 5)) {
            const trimmed = line.trim().slice(0, 120);
            console.log(`    ${chalk.dim(`L${num}:`)} ${trimmed}`);
          }
          if (matchingLines.length > 5) {
            console.log(chalk.dim(`    ... and ${matchingLines.length - 5} more line(s)`));
          }
          totalMatches++;
        }
      }

      console.log();
      if (totalMatches === 0) {
        console.log(chalk.yellow(`No matches found for "${opts.contains}" in scope "${scope}".`));
      } else {
        console.log(chalk.green(`Found matches in ${totalMatches} record(s).`));
      }
    });

  // snow script replace <scope> --find <pattern> --replace <text> [--dry-run] [--yes]
  cmd
    .command('replace <scope>')
    .description('Find and replace text across script fields in an app scope')
    .requiredOption('-f, --find <pattern>', 'Text to find')
    .requiredOption('-r, --replace <text>', 'Replacement text')
    .option('-t, --tables <tables>', 'Comma-separated list of tables to target (default: all script tables)')
    .option('--regex', 'Treat --find as a JavaScript regex')
    .option('-l, --limit <n>', 'Max records to fetch per table (default: 500)', '500')
    .option('--dry-run', 'Show what would change without writing to the instance')
    .option('--yes', 'Skip confirmation prompt')
    .action(async (
      scope: string,
      opts: { find: string; replace: string; tables?: string; regex?: boolean; limit: string; dryRun?: boolean; yes?: boolean }
    ) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const limit = parseInt(opts.limit, 10) || 500;
      const tables = opts.tables
        ? opts.tables.split(',').map(t => t.trim()).flatMap(t =>
            SCRIPT_TABLES.filter(st => st.table === t)
          )
        : SCRIPT_TABLES;

      const pattern = opts.regex ? new RegExp(opts.find, 'g') : opts.find;
      const doReplace = (s: string) =>
        typeof pattern === 'string'
          ? s.split(pattern).join(opts.replace)
          : s.replace(pattern, opts.replace);
      const hasMatch = (s: string) =>
        typeof pattern === 'string' ? s.includes(pattern) : pattern.test(s);

      // Collect all records that need updating
      type Candidate = { table: string; field: string; label: string; sysId: string; name: string; original: string; updated: string };
      const candidates: Candidate[] = [];

      for (const { table, field, label } of tables) {
        const spinner = ora(`Scanning ${label} (${table}.${field})...`).start();
        let records: Record<string, string>[];
        try {
          records = (await client.queryTable(table, {
            sysparmQuery: `sys_scope.scope=${scope}^${field}ISNOTEMPTY`,
            sysparmFields: `sys_id,name,${field}`,
            sysparmLimit: limit,
          })) as Record<string, string>[];
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red(`${label}: ${err instanceof Error ? err.message : String(err)}`));
          continue;
        }

        // Reset regex lastIndex between records
        for (const r of records) {
          if (pattern instanceof RegExp) pattern.lastIndex = 0;
          const original = r[field] ?? '';
          if (!hasMatch(original)) continue;
          if (pattern instanceof RegExp) pattern.lastIndex = 0;
          const updated = doReplace(original);
          candidates.push({
            table, field, label,
            sysId: r['sys_id'],
            name: r['name'] ?? r['sys_id'],
            original,
            updated,
          });
        }
      }

      if (candidates.length === 0) {
        console.log(chalk.yellow(`No matches found for "${opts.find}" in scope "${scope}".`));
        return;
      }

      console.log(chalk.bold(`\n${candidates.length} record(s) will be modified:\n`));
      for (const c of candidates) {
        console.log(`  ${chalk.cyan(c.name)}  ${chalk.dim(`${c.label} — ${c.table}/${c.sysId}`)}`);
      }
      console.log();

      if (opts.dryRun) {
        console.log(chalk.yellow('Dry run — no changes made.'));
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: `Replace "${opts.find}" → "${opts.replace}" in ${candidates.length} record(s) on ${instance.alias}?`,
          default: false,
        });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      let successCount = 0;
      let failCount = 0;

      for (const c of candidates) {
        const spinner = ora(`Updating ${c.name}...`).start();
        try {
          await client.updateRecord(c.table, c.sysId, { [c.field]: c.updated });
          spinner.succeed(chalk.green(`Updated: ${c.name}`));
          successCount++;
        } catch (err) {
          spinner.fail(chalk.red(`Failed ${c.name}: ${err instanceof Error ? err.message : String(err)}`));
          failCount++;
        }
      }

      console.log();
      if (failCount === 0) {
        console.log(chalk.green(`Replaced in ${successCount} record(s) successfully.`));
      } else {
        console.log(chalk.yellow(`Replaced in ${successCount} record(s). ${failCount} failed.`));
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
