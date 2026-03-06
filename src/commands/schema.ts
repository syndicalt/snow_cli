import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

// ─── Shared types ─────────────────────────────────────────────────────────────

interface DictionaryEntry {
  element: { value: string; display_value: string };
  column_label: { value: string; display_value: string };
  internal_type: { value: string; display_value: string };
  max_length: { value: string };
  mandatory: { value: string };
  read_only: { value: string };
  reference: { value: string; display_value: string };
  default_value: { value: string };
  comments: { value: string };
}

// ─── Schema map types ─────────────────────────────────────────────────────────

interface TableField {
  name: string;
  label: string;
  type: string;
  maxLength?: number;
  mandatory: boolean;
  reference?: string;
}

interface TableNode {
  name: string;
  label: string;
  fields: TableField[];
}

interface SchemaEdge {
  from: string;
  field: string;
  fieldLabel: string;
  to: string;
  type: 'reference' | 'glide_list';
}

interface SchemaGraph {
  tables: Map<string, TableNode>;
  edges: SchemaEdge[];
}

// ─── Schema crawl helpers ─────────────────────────────────────────────────────

async function fetchTableFields(
  client: ServiceNowClient,
  tableName: string
): Promise<TableField[]> {
  const res = await client.get<{ result: DictionaryEntry[] }>(
    '/api/now/table/sys_dictionary',
    {
      params: {
        sysparm_query: `name=${tableName}^elementISNOTEMPTY`,
        sysparm_fields: 'element,column_label,internal_type,max_length,mandatory,reference',
        sysparm_display_value: 'all',
        sysparm_limit: 500,
        sysparm_exclude_reference_link: true,
      },
    }
  );
  return (res.result ?? [])
    .map((e) => ({
      name: e.element?.value ?? '',
      label: e.column_label?.display_value ?? '',
      type: e.internal_type?.value ?? 'string',
      maxLength: e.max_length?.value ? parseInt(e.max_length.value, 10) : undefined,
      mandatory: e.mandatory?.value === 'true',
      reference: e.reference?.value || undefined,
    }))
    .filter((f) => f.name);
}

async function fetchTableLabel(
  client: ServiceNowClient,
  tableName: string
): Promise<string> {
  try {
    const res = await client.get<{ result: { label: { display_value: string } }[] }>(
      '/api/now/table/sys_db_object',
      {
        params: {
          sysparm_query: `name=${tableName}`,
          sysparm_fields: 'label',
          sysparm_display_value: 'all',
          sysparm_limit: 1,
        },
      }
    );
    if (res.result?.length > 0) return res.result[0].label?.display_value || tableName;
  } catch { /* ignore */ }
  return tableName;
}

async function crawlSchema(
  client: ServiceNowClient,
  rootTable: string,
  maxDepth: number,
  showM2m: boolean,
  onProgress: (msg: string) => void
): Promise<SchemaGraph> {
  const tables = new Map<string, TableNode>();
  const edges: SchemaEdge[] = [];
  const queue: Array<{ table: string; depth: number }> = [{ table: rootTable, depth: 0 }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { table, depth } = queue.shift()!;
    if (visited.has(table)) continue;
    visited.add(table);

    onProgress(`  [depth ${depth}] ${table}`);

    const [fields, label] = await Promise.all([
      fetchTableFields(client, table),
      fetchTableLabel(client, table),
    ]);

    tables.set(table, { name: table, label, fields });

    if (depth < maxDepth) {
      for (const field of fields) {
        const isRef = field.type === 'reference' && field.reference;
        const isM2m = showM2m && field.type === 'glide_list' && field.reference;

        if (isRef || isM2m) {
          const target = field.reference!;
          const alreadyEdge = edges.some((e) => e.from === table && e.field === field.name);
          if (!alreadyEdge) {
            edges.push({
              from: table,
              field: field.name,
              fieldLabel: field.label,
              to: target,
              type: isRef ? 'reference' : 'glide_list',
            });
          }
          if (!visited.has(target)) {
            queue.push({ table: target, depth: depth + 1 });
          }
        }
      }
    }
  }

  return { tables, edges };
}

// ─── Type mappings ────────────────────────────────────────────────────────────

const MERMAID_TYPES: Record<string, string> = {
  integer: 'int', long: 'bigint', float: 'float', decimal: 'float',
  currency: 'float', boolean: 'boolean', date: 'date', glide_date: 'date',
  glide_date_time: 'datetime', reference: 'string', glide_list: 'string',
};

const DBML_TYPES: Record<string, string> = {
  integer: 'int', long: 'bigint', float: 'float', decimal: 'decimal(15,4)',
  currency: 'decimal(15,2)', boolean: 'boolean', date: 'date', glide_date: 'date',
  glide_date_time: 'datetime', reference: 'varchar(32)', glide_list: 'text',
  choice: 'varchar(40)', script: 'text', html: 'text',
  url: 'varchar(1024)', email: 'varchar(255)', phone_number: 'varchar(40)',
};

function toMermaidType(t: string): string { return MERMAID_TYPES[t] ?? 'string'; }
function toDBMLType(t: string): string { return DBML_TYPES[t] ?? 'varchar(255)'; }

// ─── Stub table collection ────────────────────────────────────────────────────

/**
 * Returns table names that are referenced by fields in the graph but were not
 * themselves crawled (e.g. beyond the depth limit). These need placeholder
 * entries so that DBML ref annotations and Mermaid relationships resolve.
 */
function collectStubTables(graph: SchemaGraph): Set<string> {
  const stubs = new Set<string>();
  for (const [, node] of graph.tables) {
    for (const f of node.fields) {
      if (f.reference && !graph.tables.has(f.reference)) {
        stubs.add(f.reference);
      }
    }
  }
  return stubs;
}

// ─── Renderers ────────────────────────────────────────────────────────────────

function renderMermaid(graph: SchemaGraph, rootTable: string): string {
  const lines: string[] = [
    `---`,
    `title: Schema map — ${rootTable}`,
    `---`,
    `erDiagram`,
  ];

  // Fully crawled tables
  for (const [, node] of graph.tables) {
    lines.push(`  ${node.name} {`);
    for (const f of node.fields) {
      if (f.type === 'glide_list') continue; // shown as edges
      const mType = toMermaidType(f.type);
      const note = f.mandatory ? ' "M"' : '';
      lines.push(`    ${mType} ${f.name}${note}`);
    }
    lines.push(`  }`);
  }

  // Crawled edges
  lines.push('');
  for (const edge of graph.edges) {
    if (!graph.tables.has(edge.to)) continue;
    const rel = edge.type === 'glide_list' ? `}o--o{` : `}o--||`;
    const safeLabel = edge.fieldLabel.replace(/"/g, "'");
    lines.push(`  ${edge.from} ${rel} ${edge.to} : "${safeLabel}"`);
  }

  // Stub tables — referenced but not crawled
  const stubs = collectStubTables(graph);
  if (stubs.size > 0) {
    lines.push('');
    lines.push(`  %% Stub tables — referenced but not crawled (increase --depth to explore)`);
    for (const stubName of [...stubs].sort()) {
      lines.push(`  ${stubName} {`);
      lines.push(`    string sys_id`);
      lines.push(`  }`);
    }
    // Relationship lines from crawled tables into stubs
    for (const [, node] of graph.tables) {
      for (const f of node.fields) {
        if (f.reference && stubs.has(f.reference)) {
          const rel = f.type === 'glide_list' ? `}o--o{` : `}o--||`;
          const safeLabel = f.label.replace(/"/g, "'");
          lines.push(`  ${node.name} ${rel} ${f.reference} : "${safeLabel}"`);
        }
      }
    }
  }

  return lines.join('\n');
}

function renderDBML(graph: SchemaGraph, rootTable: string): string {
  const lines: string[] = [
    `// Schema map — ${rootTable}`,
    `// Generated by @syndicalt/snow-cli`,
    '',
  ];

  // Fully crawled tables
  for (const [, node] of graph.tables) {
    const safeNote = node.label.replace(/'/g, "\\'");
    lines.push(`Table ${node.name} [note: '${safeNote}'] {`);
    for (const f of node.fields) {
      const dbType = toDBMLType(f.type);
      const annots: string[] = [];
      if (f.name === 'sys_id') annots.push('pk');
      if (f.mandatory) annots.push('not null');
      if (f.type === 'reference' && f.reference) annots.push(`ref: > ${f.reference}.sys_id`);
      const annotStr = annots.length ? ` [${annots.join(', ')}]` : '';
      lines.push(`  ${f.name} ${dbType}${annotStr}`);
    }
    lines.push(`}`);
    lines.push('');
  }

  // Explicit M2M refs
  for (const edge of graph.edges) {
    if (edge.type === 'glide_list' && graph.tables.has(edge.to)) {
      lines.push(`Ref: ${edge.from}.${edge.field} <> ${edge.to}.sys_id // ${edge.fieldLabel}`);
    }
  }

  // Stub tables — referenced by fields but not crawled
  const stubs = collectStubTables(graph);
  if (stubs.size > 0) {
    lines.push('');
    lines.push(`// Placeholder tables — referenced but not crawled (increase --depth to explore)`);
    for (const stubName of [...stubs].sort()) {
      lines.push(`Table ${stubName} [note: 'not crawled'] {`);
      lines.push(`  sys_id varchar(32) [pk]`);
      lines.push(`}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── sub-commands ─────────────────────────────────────────────────────────────

function schemaShowCommand(): Command {
  return new Command('show')
    .description('Show field schema for a ServiceNow table')
    .argument('<table>', 'Table name (e.g. incident, sys_user)')
    .option('--format <fmt>', 'Output format: table or json', 'table')
    .option('-f, --filter <text>', 'Filter fields by name or label (case-insensitive)')
    .action(async (table: string, opts: { format: 'table' | 'json'; filter?: string }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const spinner = ora(`Loading schema for ${table}...`).start();

      try {
        const res = await client.get<{ result: DictionaryEntry[] }>(
          '/api/now/table/sys_dictionary',
          {
            params: {
              sysparm_query: `name=${table}^elementISNOTEMPTY`,
              sysparm_fields:
                'element,column_label,internal_type,max_length,mandatory,read_only,reference,default_value,comments',
              sysparm_display_value: 'all',
              sysparm_limit: 500,
              sysparm_exclude_reference_link: true,
            },
          }
        );

        spinner.stop();
        let entries = res.result ?? [];

        if (opts.filter) {
          const filterLower = opts.filter.toLowerCase();
          entries = entries.filter(
            (e) =>
              e.element?.value?.toLowerCase().includes(filterLower) ||
              e.column_label?.display_value?.toLowerCase().includes(filterLower)
          );
        }

        if (entries.length === 0) {
          console.log(chalk.dim(`No fields found for table "${table}".`));
          return;
        }

        if (opts.format === 'json') {
          const mapped = entries.map((e) => ({
            name: e.element?.value,
            label: e.column_label?.display_value,
            type: e.internal_type?.value,
            maxLength: e.max_length?.value ? parseInt(e.max_length.value, 10) : undefined,
            mandatory: e.mandatory?.value === 'true',
            readOnly: e.read_only?.value === 'true',
            reference: e.reference?.value || undefined,
            defaultValue: e.default_value?.value || undefined,
            comments: e.comments?.value || undefined,
          }));
          console.log(JSON.stringify(mapped, null, 2));
          return;
        }

        console.log(chalk.bold(`\nSchema for ${chalk.cyan(table)} (${entries.length} fields)\n`));
        const colWidths = { name: 30, label: 30, type: 20 };
        const header = [
          'Field Name'.padEnd(colWidths.name),
          'Label'.padEnd(colWidths.label),
          'Type'.padEnd(colWidths.type),
          'Flags',
        ].join('  ');
        console.log(chalk.bold(header));
        console.log(chalk.dim('-'.repeat(header.length)));

        for (const e of entries) {
          const name  = (e.element?.value ?? '').slice(0, colWidths.name).padEnd(colWidths.name);
          const label = (e.column_label?.display_value ?? '').slice(0, colWidths.label).padEnd(colWidths.label);
          const type  = (e.internal_type?.value ?? '').slice(0, colWidths.type).padEnd(colWidths.type);
          const flags: string[] = [];
          if (e.mandatory?.value === 'true') flags.push(chalk.red('M'));
          if (e.read_only?.value === 'true')  flags.push(chalk.yellow('R'));
          if (e.reference?.value)             flags.push(chalk.blue(`ref:${e.reference.value}`));
          console.log(`${name}  ${label}  ${type}  ${flags.join(' ')}`);
        }

        console.log(chalk.dim('\nFlags: M=mandatory  R=read-only  ref=reference table'));
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

function schemaMapCommand(): Command {
  return new Command('map')
    .description('Crawl table references and generate a Mermaid or DBML schema map')
    .argument('<table>', 'Root table to start from (e.g. incident, x_myapp_request)')
    .option('-d, --depth <n>', 'Levels of references to follow', '2')
    .option('--show-m2m', 'Include glide_list fields as M2M relationships', false)
    .option('--format <fmt>', 'Output format: mermaid or dbml', 'mermaid')
    .option('--out <dir>', 'Directory to write the output file', '.')
    .action(async (
      table: string,
      opts: { depth: string; showM2m: boolean; format: string; out: string }
    ) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const depth = Math.max(0, parseInt(opts.depth, 10) || 2);
      const fmt = opts.format === 'dbml' ? 'dbml' : 'mermaid';

      console.log(
        chalk.bold(`\nBuilding schema map for ${chalk.cyan(table)}`),
        chalk.dim(`(depth: ${depth}, m2m: ${opts.showM2m}, format: ${fmt})\n`)
      );

      const spinner = ora('Crawling…').start();

      try {
        const graph = await crawlSchema(
          client,
          table,
          depth,
          opts.showM2m,
          (msg) => { spinner.text = msg; }
        );

        spinner.stop();

        const output = fmt === 'dbml'
          ? renderDBML(graph, table)
          : renderMermaid(graph, table);

        const ext = fmt === 'dbml' ? '.dbml' : '.mmd';
        const outDir = resolve(opts.out);
        mkdirSync(outDir, { recursive: true });
        const outFile = join(outDir, `${table}-schema${ext}`);
        writeFileSync(outFile, output, 'utf8');

        const tableCount = graph.tables.size;
        const edgeCount  = graph.edges.filter((e) => graph.tables.has(e.to)).length;
        const m2mCount   = graph.edges.filter((e) => e.type === 'glide_list' && graph.tables.has(e.to)).length;

        console.log(chalk.green(`\nSchema map written to ${outFile}`));
        console.log(chalk.dim(
          `${tableCount} table${tableCount !== 1 ? 's' : ''}, ` +
          `${edgeCount - m2mCount} reference${edgeCount - m2mCount !== 1 ? 's' : ''}` +
          (m2mCount ? `, ${m2mCount} M2M link${m2mCount !== 1 ? 's' : ''}` : '')
        ));

        if (fmt === 'mermaid') {
          console.log(chalk.dim('\nOpen the .mmd file in any Mermaid viewer, or paste into https://mermaid.live'));
        } else {
          console.log(chalk.dim('\nOpen the .dbml file in https://dbdiagram.io or any DBML-compatible tool'));
        }
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

// ─── Public export ────────────────────────────────────────────────────────────

export function schemaCommand(): Command {
  const cmd = new Command('schema').description('Schema inspection and mapping');
  // isDefault: true → `snow schema <table>` routes here (backward compat)
  cmd.addCommand(schemaShowCommand(), { isDefault: true });
  cmd.addCommand(schemaMapCommand());
  return cmd;
}
