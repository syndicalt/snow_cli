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

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

export function catalogCommand(): Command {
  const cmd = new Command('catalog')
    .description('Browse and search the ServiceNow Service Catalog');

  // snow catalog list
  cmd
    .command('list')
    .description('List catalog items')
    .option('-q, --query <encoded>', 'Encoded query filter')
    .option('--category <name>', 'Filter by category name')
    .option('--catalog <name>', 'Filter by catalog title')
    .option('-l, --limit <n>', 'Max records to return', '25')
    .option('--json', 'Output as JSON')
    .action(async (opts: {
      query?: string; category?: string; catalog?: string; limit: string; json?: boolean;
    }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching catalog items...').start();

      const parts = ['active=true'];
      if (opts.query)    parts.push(opts.query);
      if (opts.category) parts.push(`category.name=${opts.category}`);
      if (opts.catalog)  parts.push(`sc_catalogs.title=${opts.catalog}`);
      parts.push('ORDERBYname');

      try {
        const items = await client.queryTable('sc_cat_item', {
          sysparmQuery: parts.join('^'),
          sysparmFields: 'sys_id,name,short_description,category,price,sys_class_name',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(items, null, 2)); return; }
        if (items.length === 0) { console.log(chalk.dim('No catalog items found.')); return; }

        console.log();
        console.log(chalk.bold(`Service Catalog  (${instance.alias}  ·  ${items.length} items)`));
        console.log(chalk.dim('─'.repeat(70)));

        for (const item of items as Record<string, unknown>[]) {
          const typeRaw = str(item['sys_class_name']).replace(/^sc_cat_item/, '').replace(/_/g, ' ').trim();
          const type = typeRaw || 'item';
          const price = str(item['price']);
          const cat = str(item['category']);

          console.log(`  ${chalk.white(str(item['name']))}  ${chalk.dim(`[${type}]`)}`);
          const desc = str(item['short_description']);
          if (desc) console.log(`    ${chalk.dim(desc)}`);
          const meta: string[] = [];
          if (cat) meta.push(`category: ${cat}`);
          if (price && price !== '0' && price !== '0.00') meta.push(`price: ${price}`);
          if (meta.length > 0) console.log(`    ${chalk.dim(meta.join('  ·  '))}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch catalog items'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow catalog search <query>
  cmd
    .command('search <query>')
    .description('Search catalog items by name or description')
    .option('-l, --limit <n>', 'Max records to return', '20')
    .option('--json', 'Output as JSON')
    .action(async (query: string, opts: { limit: string; json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora(`Searching for "${query}"...`).start();

      try {
        const items = await client.queryTable('sc_cat_item', {
          sysparmQuery: `active=true^nameLIKE${query}^ORshort_descriptionLIKE${query}^ORDERBYname`,
          sysparmFields: 'sys_id,name,short_description,category,price,sys_class_name',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(items, null, 2)); return; }
        if (items.length === 0) {
          console.log(chalk.dim(`No catalog items found matching "${query}".`));
          return;
        }

        console.log();
        console.log(chalk.bold(`Search results for "${query}"  (${items.length} found)`));
        console.log(chalk.dim('─'.repeat(70)));

        for (const item of items as Record<string, unknown>[]) {
          const cat = str(item['category']);
          console.log(`  ${chalk.white(str(item['name']))}  ${cat ? chalk.dim(`[${cat}]`) : ''}`);
          const desc = str(item['short_description']);
          if (desc) console.log(`    ${chalk.dim(desc)}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Search failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow catalog get <name-or-id>
  cmd
    .command('get <nameOrId>')
    .description('Get details of a specific catalog item')
    .option('--json', 'Output as JSON')
    .action(async (nameOrId: string, opts: { json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching catalog item...').start();

      try {
        const isSysId = /^[a-f0-9]{32}$/i.test(nameOrId);
        const query = isSysId ? `sys_id=${nameOrId}` : `name=${nameOrId}`;

        const items = await client.queryTable('sc_cat_item', {
          sysparmQuery: query,
          sysparmFields: 'sys_id,name,short_description,description,category,price,active,sys_class_name,delivery_time,sc_catalogs,order',
          sysparmLimit: 1,
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (items.length === 0) {
          console.error(chalk.red(`Catalog item not found: ${nameOrId}`));
          process.exit(1);
        }

        const item = items[0] as Record<string, unknown>;

        if (opts.json) { console.log(JSON.stringify(item, null, 2)); return; }

        console.log();
        console.log(chalk.bold(str(item['name'])));
        const shortDesc = str(item['short_description']);
        if (shortDesc) console.log(chalk.dim(shortDesc));
        console.log();

        const fields: [string, string][] = [
          ['sys_id',   str(item['sys_id'])],
          ['category', str(item['category'])],
          ['catalog',  str(item['sc_catalogs'])],
          ['price',    str(item['price'])],
          ['active',   str(item['active'])],
          ['type',     str(item['sys_class_name'])],
        ];
        for (const [label, value] of fields) {
          if (value) console.log(`  ${chalk.dim(label.padEnd(12))} ${value}`);
        }

        const longDesc = str(item['description']);
        if (longDesc) {
          console.log();
          console.log(chalk.dim('  Description:'));
          const plain = stripHtml(longDesc);
          plain.split('\n').slice(0, 10).forEach(l => console.log(`    ${chalk.dim(l)}`));
        }
        console.log();
        console.log(chalk.dim(`  View in ServiceNow: ${instance.url}/sc_cat_item.do?sys_id=${str(item['sys_id'])}`));
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  // snow catalog categories
  cmd
    .command('categories')
    .description('List Service Catalog categories')
    .option('--catalog <name>', 'Filter by catalog title')
    .option('-l, --limit <n>', 'Max records to return', '100')
    .option('--json', 'Output as JSON')
    .action(async (opts: { catalog?: string; limit: string; json?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora('Fetching categories...').start();

      try {
        const parts = ['active=true'];
        if (opts.catalog) parts.push(`sc_catalog.title=${opts.catalog}`);
        parts.push('ORDERBYfull_name');

        const cats = await client.queryTable('sc_category', {
          sysparmQuery: parts.join('^'),
          sysparmFields: 'sys_id,title,full_name,description,sc_catalog,active',
          sysparmLimit: parseInt(opts.limit, 10),
          sysparmDisplayValue: true,
        });
        spinner.stop();

        if (opts.json) { console.log(JSON.stringify(cats, null, 2)); return; }
        if (cats.length === 0) { console.log(chalk.dim('No categories found.')); return; }

        console.log();
        console.log(chalk.bold(`Service Catalog Categories  (${cats.length})`));
        console.log(chalk.dim('─'.repeat(60)));

        for (const cat of cats as Record<string, unknown>[]) {
          const title = str(cat['title']);
          const fullName = str(cat['full_name']);
          const catalog = str(cat['sc_catalog']);
          // Indent sub-categories based on > separators in full_name
          const depth = fullName.split('>').length - 1;
          const indent = '  '.repeat(Math.max(0, depth));
          console.log(`${indent}  ${chalk.white(title)}  ${catalog ? chalk.dim(`[${catalog}]`) : ''}`);
        }
        console.log();
      } catch (err) {
        spinner.fail(chalk.red('Failed to fetch categories'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}
