import { Command } from 'commander';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance, loadConfig } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import type { Instance } from '../types/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UpdateSet {
  sys_id: string;
  name: string;
  description: string;
  state: string;
  application: string | { display_value: string };
  is_default: string;
  sys_created_by: string;
  sys_created_on: string;
}

interface UpdateXml {
  sys_id: string;
  name: string;
  type: string;
  target_name: string;
  action: string;
  sys_created_on: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an update set by name (case-insensitive contains) or exact sys_id.
 */
async function resolveUpdateSet(client: ServiceNowClient, query: string): Promise<UpdateSet> {
  const isSysId = /^[0-9a-f]{32}$/i.test(query);
  const snQuery = isSysId ? `sys_id=${query}` : `nameCONTAINS${query}`;

  const res = await client.queryTable('sys_update_set', {
    sysparmQuery: snQuery,
    sysparmFields: 'sys_id,name,description,state,application,is_default,sys_created_by,sys_created_on',
    sysparmDisplayValue: 'true',
    sysparmLimit: isSysId ? 1 : 5,
  }) as UpdateSet[];

  if (res.length === 0) throw new Error(`Update set not found: "${query}"`);
  if (res.length > 1) {
    const names = res.map(s => `  ${chalk.cyan(s.name)}  (${s.sys_id})`).join('\n');
    throw new Error(`Ambiguous update set name "${query}" — matched ${res.length}:\n${names}\nUse sys_id or a more specific name.`);
  }
  return res[0];
}

/**
 * Get the name of the update set that is currently active for the REST user.
 * ServiceNow stores this in sys_user_preference (name=sys_update_set, value=<sys_id>).
 * Falls back to querying for the default in-progress update set.
 */
async function getCurrentUpdateSet(client: ServiceNowClient): Promise<UpdateSet | null> {
  // Try to read the user preference
  type PrefRow = { value: string };
  const prefs = await client.queryTable('sys_user_preference', {
    sysparmQuery: 'name=sys_update_set^userISEMPTY^ORuser.user_name=javascript:gs.getUserName()',
    sysparmFields: 'value',
    sysparmLimit: 1,
  }) as PrefRow[];

  const prefSysId = prefs[0]?.value;
  if (prefSysId) {
    const sets = await client.queryTable('sys_update_set', {
      sysparmQuery: `sys_id=${prefSysId}`,
      sysparmFields: 'sys_id,name,description,state,application,is_default,sys_created_by,sys_created_on',
      sysparmDisplayValue: 'true',
      sysparmLimit: 1,
    }) as UpdateSet[];
    if (sets.length > 0) return sets[0];
  }

  // Fallback: first in-progress update set flagged as default
  const defaults = await client.queryTable('sys_update_set', {
    sysparmQuery: 'state=in progress^is_default=true',
    sysparmFields: 'sys_id,name,description,state,application,is_default,sys_created_by,sys_created_on',
    sysparmDisplayValue: 'true',
    sysparmLimit: 1,
  }) as UpdateSet[];

  return defaults[0] ?? null;
}

/**
 * Set the active update set for the current REST user via sys_user_preference.
 */
async function setCurrentUpdateSet(client: ServiceNowClient, updateSetSysId: string): Promise<void> {
  type PrefRow = { sys_id: string };
  const existing = await client.queryTable('sys_user_preference', {
    sysparmQuery: 'name=sys_update_set^userISEMPTY',
    sysparmFields: 'sys_id',
    sysparmLimit: 1,
  }) as PrefRow[];

  if (existing.length > 0) {
    await client.updateRecord('sys_user_preference', existing[0].sys_id, { value: updateSetSysId });
  } else {
    await client.createRecord('sys_user_preference', { name: 'sys_update_set', value: updateSetSysId });
  }
}

function displaySet(set: UpdateSet): void {
  const app = typeof set.application === 'object' ? set.application.display_value : set.application;
  const isDefault = set.is_default === 'true' || set.is_default === '1';
  const stateColor = set.state === 'in progress' ? chalk.green : set.state === 'complete' ? chalk.blue : chalk.dim;

  console.log(`${chalk.bold(set.name)}${isDefault ? chalk.yellow('  ★ active') : ''}`);
  console.log(`  sys_id:   ${chalk.dim(set.sys_id)}`);
  console.log(`  state:    ${stateColor(set.state)}`);
  console.log(`  app:      ${app || chalk.dim('Global')}`);
  console.log(`  created:  ${set.sys_created_on} by ${set.sys_created_by}`);
  if (set.description) console.log(`  desc:     ${set.description}`);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function updatesetCommand(): Command {
  const cmd = new Command('updateset')
    .alias('us')
    .description('Manage ServiceNow update sets');

  // -------------------------------------------------------------------------
  // snow updateset list [--state <state>] [--limit <n>]
  // -------------------------------------------------------------------------
  cmd
    .command('list')
    .alias('ls')
    .description('List update sets on the instance')
    .option('-s, --state <state>', 'Filter by state: "in progress", "complete", "ignore" (default: all)')
    .option('-l, --limit <n>', 'Max results (default: 50)', '50')
    .action(async (opts: { state?: string; limit: string }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const limit = parseInt(opts.limit, 10) || 50;

      const query = opts.state ? `state=${opts.state}` : 'state!=ignore';
      const spinner = ora('Fetching update sets...').start();
      let sets: UpdateSet[];
      try {
        sets = await client.queryTable('sys_update_set', {
          sysparmQuery: `${query}^ORDERBYDESCsys_created_on`,
          sysparmFields: 'sys_id,name,state,application,is_default,sys_created_by,sys_created_on',
          sysparmDisplayValue: 'true',
          sysparmLimit: limit,
        }) as UpdateSet[];
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (sets.length === 0) {
        console.log(chalk.dim('No update sets found.'));
        return;
      }

      const appLabel = (s: UpdateSet) =>
        (typeof s.application === 'object' ? s.application.display_value : s.application) || 'Global';

      const nameWidth = Math.max(4, ...sets.map(s => s.name.length));
      const stateWidth = Math.max(5, ...sets.map(s => s.state.length));
      const appWidth = Math.max(11, ...sets.map(s => appLabel(s).length));
      console.log(chalk.bold(
        `${'Name'.padEnd(nameWidth)}  ${'State'.padEnd(stateWidth)}  ${'Application'.padEnd(appWidth)}  ${'Created by'.padEnd(16)}  Created on`
      ));
      console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(stateWidth)}  ${'-'.repeat(appWidth)}  ${'-'.repeat(16)}  ${'-'.repeat(19)}`);

      for (const s of sets) {
        const isDefault = s.is_default === 'true' || s.is_default === '1';
        const stateStr = s.state === 'in progress'
          ? chalk.green(s.state.padEnd(stateWidth))
          : chalk.dim(s.state.padEnd(stateWidth));
        const marker = isDefault ? chalk.yellow(' ★') : '  ';
        const app = appLabel(s);
        console.log(`${chalk.cyan(s.name.padEnd(nameWidth))}${marker}  ${stateStr}  ${app.padEnd(appWidth)}  ${s.sys_created_by.padEnd(16)}  ${s.sys_created_on}`);
      }
    });

  // -------------------------------------------------------------------------
  // snow updateset current
  // -------------------------------------------------------------------------
  cmd
    .command('current')
    .description('Show the currently active update set')
    .action(async () => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Fetching current update set...').start();
      let current: UpdateSet | null;
      try {
        current = await getCurrentUpdateSet(client);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (!current) {
        console.log(chalk.yellow('No active update set found. Use `snow updateset set <name>` to activate one.'));
        return;
      }

      displaySet(current);
    });

  // -------------------------------------------------------------------------
  // snow updateset set <name-or-sys_id>
  // -------------------------------------------------------------------------
  cmd
    .command('set <name>')
    .description('Set the active update set (stored in sys_user_preference)')
    .action(async (nameOrId: string) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Resolving update set...').start();
      let set: UpdateSet;
      try {
        set = await resolveUpdateSet(client, nameOrId);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const setSpinner = ora(`Activating "${set.name}"...`).start();
      try {
        await setCurrentUpdateSet(client, set.sys_id);
        setSpinner.succeed(chalk.green(`Active update set: ${set.name}`));
      } catch (err) {
        setSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // -------------------------------------------------------------------------
  // snow updateset show <name-or-sys_id>
  // -------------------------------------------------------------------------
  cmd
    .command('show <name>')
    .description('Show details and captured items for an update set')
    .option('-l, --limit <n>', 'Max captured items to show (default: 100)', '100')
    .action(async (nameOrId: string, opts: { limit: string }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const limit = parseInt(opts.limit, 10) || 100;

      const spinner = ora('Fetching update set...').start();
      let set: UpdateSet;
      try {
        set = await resolveUpdateSet(client, nameOrId);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      displaySet(set);

      const itemSpinner = ora('Fetching captured items...').start();
      let items: UpdateXml[];
      try {
        items = await client.queryTable('sys_update_xml', {
          sysparmQuery: `update_set=${set.sys_id}^ORDERBYtype`,
          sysparmFields: 'sys_id,name,type,target_name,action,sys_created_on',
          sysparmLimit: limit,
        }) as UpdateXml[];
        itemSpinner.stop();
      } catch (err) {
        itemSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (items.length === 0) {
        console.log(chalk.dim('\n  No captured items.'));
        return;
      }

      console.log(chalk.bold(`\n  ${items.length} captured item(s):\n`));
      const typeWidth = Math.max(4, ...items.map(i => i.type.length));
      const actionWidth = Math.max(6, ...items.map(i => i.action.length));
      console.log(chalk.bold(`  ${'Type'.padEnd(typeWidth)}  ${'Action'.padEnd(actionWidth)}  Target`));
      console.log(`  ${'-'.repeat(typeWidth)}  ${'-'.repeat(actionWidth)}  ${'-'.repeat(40)}`);

      for (const item of items) {
        const actionColor = item.action === 'INSERT_OR_UPDATE'
          ? chalk.green
          : item.action === 'DELETE'
          ? chalk.red
          : chalk.dim;
        console.log(`  ${item.type.padEnd(typeWidth)}  ${actionColor(item.action.padEnd(actionWidth))}  ${item.target_name}`);
      }

      if (items.length === limit) {
        console.log(chalk.dim(`\n  (showing first ${limit} items — use --limit to increase)`));
      }
    });

  // -------------------------------------------------------------------------
  // snow updateset capture <name-or-sys_id> --add <table> <record_sys_id>
  // -------------------------------------------------------------------------
  cmd
    .command('capture <name>')
    .description('Capture specific records into an update set by temporarily making it active')
    .requiredOption('-a, --add <table:sys_id>', 'Record to capture as table:sys_id (repeat for multiple)', (val, acc: string[]) => { acc.push(val); return acc; }, [] as string[])
    .option('--yes', 'Skip confirmation')
    .action(async (nameOrId: string, opts: { add: string[]; yes?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      // Parse table:sys_id pairs
      const records: { table: string; sysId: string }[] = [];
      for (const entry of opts.add) {
        const colon = entry.indexOf(':');
        if (colon === -1) {
          console.error(chalk.red(`Invalid format "${entry}" — expected table:sys_id`));
          process.exit(1);
        }
        records.push({ table: entry.slice(0, colon), sysId: entry.slice(colon + 1) });
      }

      const spinner = ora('Resolving update set...').start();
      let set: UpdateSet;
      let previousSet: UpdateSet | null;
      try {
        [set, previousSet] = await Promise.all([
          resolveUpdateSet(client, nameOrId),
          getCurrentUpdateSet(client),
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log(chalk.bold(`Capture into update set: ${set.name}`));
      for (const r of records) console.log(`  ${chalk.cyan(r.table)}  ${chalk.dim(r.sysId)}`);
      console.log(chalk.dim('\n  Method: temporarily activates the update set, patches each record (no-op), then restores.'));

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed?', default: true });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      // Activate the target update set
      const activateSpinner = ora(`Activating "${set.name}"...`).start();
      try {
        await setCurrentUpdateSet(client, set.sys_id);
        activateSpinner.succeed();
      } catch (err) {
        activateSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      let captureFailures = 0;
      for (const { table, sysId } of records) {
        const captureSpinner = ora(`Capturing ${table}/${sysId}...`).start();
        try {
          // Fetch the record then PATCH it back with the same values to trigger capture
          const record = await client.getRecord(table, sysId, { sysparmFields: 'sys_id' });
          await client.updateRecord(table, record.sys_id, { sys_mod_count: record['sys_mod_count'] });
          captureSpinner.succeed(chalk.green(`Captured: ${table}/${sysId}`));
        } catch (err) {
          captureSpinner.fail(chalk.red(`Failed ${table}/${sysId}: ${err instanceof Error ? err.message : String(err)}`));
          captureFailures++;
        }
      }

      // Restore the previous update set
      if (previousSet) {
        const restoreSpinner = ora(`Restoring active update set to "${previousSet.name}"...`).start();
        try {
          await setCurrentUpdateSet(client, previousSet.sys_id);
          restoreSpinner.succeed();
        } catch {
          restoreSpinner.fail(chalk.yellow('Could not restore previous update set — run `snow updateset set` manually.'));
        }
      }

      if (captureFailures === 0) {
        console.log(chalk.green(`\nCaptured ${records.length} record(s) into "${set.name}".`));
      } else {
        console.log(chalk.yellow(`\nCaptured ${records.length - captureFailures}/${records.length} record(s).`));
      }
    });

  // -------------------------------------------------------------------------
  // snow updateset export <name-or-sys_id> [--out <dir>]
  // -------------------------------------------------------------------------
  cmd
    .command('export <name>')
    .description('Export an update set as an XML file')
    .option('-o, --out <dir>', 'Output directory (default: current directory)', '.')
    .action(async (nameOrId: string, opts: { out: string }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const resolveSpinner = ora('Resolving update set...').start();
      let set: UpdateSet;
      try {
        set = await resolveUpdateSet(client, nameOrId);
        resolveSpinner.stop();
      } catch (err) {
        resolveSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const exportSpinner = ora(`Exporting "${set.name}"...`).start();
      let xmlContent: string;
      try {
        const res = await client.getAxiosInstance().get<string>(
          '/export_update_set.do',
          {
            params: { type: 'XML', sys_id: set.sys_id },
            responseType: 'text',
          }
        );
        xmlContent = res.data;
        exportSpinner.stop();
      } catch (err) {
        exportSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (!existsSync(opts.out)) mkdirSync(opts.out, { recursive: true });

      const safeName = set.name.replace(/[^a-z0-9_-]/gi, '_');
      const outPath = join(opts.out, `${safeName}.xml`);
      writeFileSync(outPath, xmlContent, 'utf-8');
      console.log(chalk.green(`Exported to: ${outPath}`));
    });

  // -------------------------------------------------------------------------
  // snow updateset apply <xml-file> [--target <alias>]
  // -------------------------------------------------------------------------
  cmd
    .command('apply <xml-file>')
    .description('Import an update set XML into an instance (creates a Retrieved Update Set record)')
    .option('-t, --target <alias>', 'Target instance alias (default: active instance)')
    .option('--yes', 'Skip confirmation')
    .action(async (xmlFile: string, opts: { target?: string; yes?: boolean }) => {
      if (!existsSync(xmlFile)) {
        console.error(chalk.red(`File not found: ${xmlFile}`));
        process.exit(1);
      }

      const xmlContent = readFileSync(xmlFile, 'utf-8');

      // Extract the update set name from the XML for display
      const nameMatch = xmlContent.match(/<update_set[^>]*>[\s\S]*?<name>([^<]+)<\/name>/);
      const xmlName = nameMatch ? nameMatch[1] : xmlFile;

      // Resolve target instance
      let instance;
      if (opts.target) {
        const config = loadConfig();
        instance = config.instances[opts.target];
        if (!instance) {
          console.error(chalk.red(`Instance alias not found: ${opts.target}`));
          process.exit(1);
        }
      } else {
        instance = requireActiveInstance();
      }

      console.log(`Import ${chalk.cyan(xmlName)} → ${chalk.bold(instance.alias)} (${instance.url})`);

      if (!opts.yes) {
        const ok = await confirm({ message: 'Proceed?', default: true });
        if (!ok) { console.log(chalk.dim('Aborted.')); return; }
      }

      const client = new ServiceNowClient(instance);
      const importSpinner = ora('Uploading update set XML...').start();

      let remoteSetSysId: string;
      try {
        // Create a sys_remote_update_set record with the XML payload
        const res = await client.createRecord('sys_remote_update_set', {
          name: xmlName,
          payload: xmlContent,
          state: 'loaded',
        });
        remoteSetSysId = res.sys_id;
        importSpinner.succeed(chalk.green(`Created retrieved update set: ${remoteSetSysId}`));
      } catch (err) {
        importSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('Next steps in ServiceNow:'));
      console.log(`  1. Navigate to ${chalk.cyan('System Update Sets → Retrieved Update Sets')}`);
      console.log(`  2. Open ${chalk.cyan(xmlName)}`);
      console.log(`  3. Click ${chalk.cyan('Preview Update Set')} → resolve any conflicts`);
      console.log(`  4. Click ${chalk.cyan('Commit Update Set')}`);
      console.log();
      console.log(chalk.dim(`  Direct link: ${instance.url}/sys_remote_update_set.do?sys_id=${remoteSetSysId}`));
    });

  // -------------------------------------------------------------------------
  // snow updateset diff <set1> <set2>
  // -------------------------------------------------------------------------
  cmd
    .command('diff <set1> <set2>')
    .description('Compare captured items between two update sets')
    .option('-l, --limit <n>', 'Max captured items per set (default: 500)', '500')
    .action(async (nameOrId1: string, nameOrId2: string, opts: { limit: string }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const limit = parseInt(opts.limit, 10) || 500;

      const spinner = ora('Fetching both update sets...').start();
      let set1: UpdateSet, set2: UpdateSet;
      let items1: UpdateXml[], items2: UpdateXml[];

      try {
        [set1, set2] = await Promise.all([
          resolveUpdateSet(client, nameOrId1),
          resolveUpdateSet(client, nameOrId2),
        ]);

        const fetchItems = (sysId: string) =>
          client.queryTable('sys_update_xml', {
            sysparmQuery: `update_set=${sysId}`,
            sysparmFields: 'sys_id,name,type,target_name,action,sys_created_on',
            sysparmLimit: limit,
          }) as Promise<UpdateXml[]>;

        [items1, items2] = await Promise.all([fetchItems(set1.sys_id), fetchItems(set2.sys_id)]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Index by target_name for comparison
      const map1 = new Map<string, UpdateXml>(items1.map(i => [i.target_name, i]));
      const map2 = new Map<string, UpdateXml>(items2.map(i => [i.target_name, i]));

      const onlyIn1: UpdateXml[] = [];
      const onlyIn2: UpdateXml[] = [];
      const inBoth: { item1: UpdateXml; item2: UpdateXml }[] = [];

      for (const [key, item] of map1) {
        if (map2.has(key)) inBoth.push({ item1: item, item2: map2.get(key)! });
        else onlyIn1.push(item);
      }
      for (const [key, item] of map2) {
        if (!map1.has(key)) onlyIn2.push(item);
      }

      console.log(chalk.bold(`\nDiff: ${chalk.cyan(set1.name)} ← → ${chalk.cyan(set2.name)}\n`));
      console.log(`  Items in ${chalk.cyan(set1.name)}: ${items1.length}`);
      console.log(`  Items in ${chalk.cyan(set2.name)}: ${items2.length}`);
      console.log();

      if (onlyIn1.length > 0) {
        console.log(chalk.red(`  Only in "${set1.name}" (${onlyIn1.length}):`));
        for (const i of onlyIn1) {
          console.log(`    ${chalk.red('−')} ${i.type.padEnd(30)} ${i.target_name}`);
        }
        console.log();
      }

      if (onlyIn2.length > 0) {
        console.log(chalk.green(`  Only in "${set2.name}" (${onlyIn2.length}):`));
        for (const i of onlyIn2) {
          console.log(`    ${chalk.green('+')} ${i.type.padEnd(30)} ${i.target_name}`);
        }
        console.log();
      }

      if (inBoth.length > 0) {
        console.log(chalk.dim(`  In both (${inBoth.length}):`));
        for (const { item1, item2 } of inBoth) {
          const actionChanged = item1.action !== item2.action;
          const marker = actionChanged ? chalk.yellow('~') : chalk.dim('=');
          const detail = actionChanged
            ? chalk.yellow(` [action: ${item1.action} → ${item2.action}]`)
            : '';
          console.log(`    ${marker} ${item1.type.padEnd(30)} ${item1.target_name}${detail}`);
        }
        console.log();
      }

      const summary = [
        onlyIn1.length > 0 ? chalk.red(`${onlyIn1.length} removed`) : '',
        onlyIn2.length > 0 ? chalk.green(`${onlyIn2.length} added`) : '',
        inBoth.filter(({ item1, item2 }) => item1.action !== item2.action).length > 0
          ? chalk.yellow(`${inBoth.filter(({ item1, item2 }) => item1.action !== item2.action).length} changed`)
          : '',
        chalk.dim(`${inBoth.filter(({ item1, item2 }) => item1.action === item2.action).length} unchanged`),
      ].filter(Boolean).join('  ');
      console.log(`  ${summary}`);
    });

  // -------------------------------------------------------------------------
  // snow updateset explain <name-or-sys_id>
  // -------------------------------------------------------------------------
  cmd
    .command('explain <name>')
    .description('Use AI to summarise what an update set changes, what is affected, and what to test before promoting')
    .option('--provider <name>', 'Override the active LLM provider')
    .option('--save <file>', 'Save the explanation to a markdown file')
    .addHelpText(
      'after',
      `
Examples:
  snow updateset explain "Sprint 42"
  snow updateset explain <sys_id>
  snow updateset explain "My Feature" --save ./pre-flight.md
`
    )
    .action(async (nameOrId: string, opts: { provider?: string; save?: string }) => {
      // Dynamic imports so we only load LLM deps when needed
      const { getActiveProvider, getAIConfig } = await import('../lib/config.js');
      const { buildProvider } = await import('../lib/llm.js');

      let active = getActiveProvider();
      if (opts.provider) {
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        active = { name: opts.provider, config: pc };
      }
      if (!active) {
        console.error(chalk.red('No LLM provider configured. Run `snow provider set <name>` first.'));
        process.exit(1);
      }
      const provider = buildProvider(active.name, active.config.model, active.config.apiKey, active.config.baseUrl);

      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      // Resolve update set
      const resolveSpinner = ora('Resolving update set…').start();
      let set: UpdateSet;
      try {
        set = await resolveUpdateSet(client, nameOrId);
        resolveSpinner.stop();
      } catch (err) {
        resolveSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Fetch captured items with payload
      const itemSpinner = ora('Fetching captured items…').start();
      type UpdateXmlWithPayload = UpdateXml & { payload: string };
      let items: UpdateXmlWithPayload[];
      try {
        items = await client.queryTable('sys_update_xml', {
          sysparmQuery: `update_set=${set.sys_id}^ORDERBYtype`,
          sysparmFields: 'sys_id,name,type,target_name,action,payload',
          sysparmLimit: 200,
        }) as unknown as UpdateXmlWithPayload[];
        itemSpinner.stop();
      } catch (err) {
        itemSpinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (items.length === 0) {
        console.log(chalk.yellow('This update set has no captured items.'));
        return;
      }

      // Helper: extract a field value from XML payload
      function extractField(payload: string, field: string): string {
        const cdataRe = new RegExp(`<${field}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${field}>`, 'i');
        const m = payload.match(cdataRe);
        if (m) return m[1].trim();
        const plainRe = new RegExp(`<${field}[^>]*>([^<]*)</${field}>`, 'i');
        const p = payload.match(plainRe);
        if (p) return p[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
        return '';
      }

      const FIELDS_BY_TYPE: Record<string, string[]> = {
        sys_script_include: ['api_name', 'active', 'script'],
        sys_business_rule: ['collection', 'when', 'order', 'filter_condition', 'condition', 'active', 'script'],
        sys_script_client: ['table', 'type', 'filter_condition', 'active', 'script'],
        sys_ui_action: ['table', 'action_name', 'active', 'script'],
        sys_ui_policy: ['table', 'conditions', 'active'],
        sys_scheduled_script_type: ['run_period', 'active', 'script'],
        sys_transform_script: ['active', 'script'],
        sys_transform_map: ['source_table', 'target_table', 'active'],
        sys_security_acl: ['operation', 'type', 'active', 'condition', 'script'],
      };
      const MAX_SCRIPT = 600;

      // Group items by type and extract relevant content
      type ParsedItem = { targetName: string; action: string; meta: Record<string, string>; script: string };
      const grouped = new Map<string, ParsedItem[]>();
      for (const item of items) {
        const fields = FIELDS_BY_TYPE[item.type] ?? [];
        const meta: Record<string, string> = {};
        let script = '';
        for (const f of fields) {
          const v = extractField(item.payload || '', f);
          if (!v) continue;
          if (f === 'script') {
            script = v.length > MAX_SCRIPT ? v.slice(0, MAX_SCRIPT) + '\n// [... truncated]' : v;
          } else {
            meta[f] = v;
          }
        }
        if (!grouped.has(item.type)) grouped.set(item.type, []);
        grouped.get(item.type)!.push({ targetName: item.target_name, action: item.action, meta, script });
      }

      // Build structured prompt
      const appLabel = typeof set.application === 'object' ? set.application.display_value : set.application;
      let promptBody = `## Update Set: ${set.name}\n`;
      promptBody += `**State:** ${set.state}\n`;
      promptBody += `**Application:** ${appLabel || 'Global'}\n`;
      promptBody += `**Created by:** ${set.sys_created_by}\n`;
      if (set.description) promptBody += `**Description:** ${set.description}\n`;
      promptBody += `**Total items:** ${items.length}\n\n`;

      for (const [type, typeItems] of grouped) {
        promptBody += `### ${type} (${typeItems.length})\n`;
        for (const item of typeItems) {
          promptBody += `\n**${item.targetName}** [${item.action}]\n`;
          for (const [k, v] of Object.entries(item.meta)) {
            promptBody += `- ${k}: ${v}\n`;
          }
          if (item.script) promptBody += `\`\`\`js\n${item.script}\n\`\`\`\n`;
        }
        promptBody += '\n';
      }

      const systemPrompt = `You are a senior ServiceNow developer performing a pre-promotion update set review.

Analyse the provided update set and produce a structured report:

1. **Summary** — what does this update set do in plain English? (2-4 sentences)
2. **Affected Areas** — which tables, workflows, and business processes are touched?
3. **Risk Assessment** — what could go wrong when promoting to production? Rate overall risk: Low / Medium / High
4. **Testing Checklist** — specific scenarios to test before committing (bullet list)
5. **Dependencies** — prerequisite records, roles, or other update sets this depends on
6. **Concerns** — anything unusual, potentially breaking, or that needs a second look

Flag any scripts with anti-patterns: queries inside loops, missing null checks, hardcoded values, non-ES5 syntax.`;

      displaySet(set);
      console.log(chalk.dim(`\n  ${items.length} captured items across ${grouped.size} type(s)`));

      const llmSpinner = ora(`Analyzing with ${provider.providerName}…`).start();
      let explanation: string;
      try {
        explanation = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Please review this update set:\n\n${promptBody}` },
        ]);
        llmSpinner.stop();
      } catch (err) {
        llmSpinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('AI Update Set Analysis'));
      console.log(chalk.dim('─'.repeat(64)));
      console.log();
      for (const line of explanation.trim().split('\n')) {
        console.log(line);
      }
      console.log();

      if (opts.save) {
        const md = `# Update Set Analysis: ${set.name}\n\n` +
          `**State:** ${set.state}  \n**Application:** ${appLabel || 'Global'}  \n` +
          `**Created by:** ${set.sys_created_by}  \n**Items:** ${items.length}  \n\n---\n\n` +
          explanation.trim() + '\n';
        writeFileSync(opts.save, md, 'utf-8');
        console.log(chalk.dim(`  Saved to ${opts.save}`));
        console.log();
      }
    });

  return cmd;
}
