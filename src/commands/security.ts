import { Command } from 'commander';
import { writeFileSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance, getActiveProvider } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import { buildProvider } from '../lib/llm.js';
import type { LLMMessage } from '../lib/llm.js';

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

function bool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

// ---------------------------------------------------------------------------
// Security data types
// ---------------------------------------------------------------------------

interface SecurityData {
  user: {
    user_name: string;
    name: string;
    email: string;
    active: string;
    department: string;
    title: string;
    direct_roles: string[];
    groups: string[];
    group_roles: Array<{ group: string; role: string }>;
    effective_roles: string[];
  };
  table: string;
  acls: Array<{
    sys_id: string;
    name: string;
    operation: string;
    type: string;
    admin_overrides: boolean;
    has_condition: boolean;
    has_script: boolean;
    required_roles: string[];
  }>;
  business_rules: Array<{
    name: string;
    when: string;
    triggers: { insert: boolean; update: boolean; delete: boolean; query: boolean };
    has_condition: boolean;
    script_preview: string;
  }>;
  data_policies: Array<{ name: string; description: string }>;
  ui_policies: Array<{ description: string; has_script: boolean }>;
  client_scripts: Array<{ name: string; type: string; script_preview: string }>;
}

// ---------------------------------------------------------------------------
// Gather helpers
// ---------------------------------------------------------------------------

async function fetchUser(
  client: ServiceNowClient,
  username: string
): Promise<{ record: Record<string, unknown>; userId: string } | null> {
  const users = (await client.queryTable('sys_user', {
    sysparmQuery: `user_name=${username}`,
    sysparmFields: 'sys_id,user_name,name,email,active,department,location,title',
    sysparmLimit: 1,
    sysparmDisplayValue: true,
  })) as unknown as Record<string, unknown>[];
  if (users.length === 0) return null;
  return { record: users[0], userId: str(users[0]['sys_id']) };
}

async function fetchDirectRoles(
  client: ServiceNowClient,
  userId: string
): Promise<string[]> {
  try {
    const rows = (await client.queryTable('sys_user_has_role', {
      sysparmQuery: `user=${userId}^state=active`,
      sysparmFields: 'role',
      sysparmLimit: 500,
      sysparmDisplayValue: true,
    })) as unknown as Array<{ role: unknown }>;
    return rows.map((r) => str(r.role)).filter(Boolean);
  } catch {
    return [];
  }
}

async function fetchGroups(
  client: ServiceNowClient,
  userId: string
): Promise<Array<{ sys_id: string; name: string }>> {
  try {
    // Two queries: display values for names, raw values for sys_ids
    const [display, raw] = await Promise.all([
      client.queryTable('sys_user_grmember', {
        sysparmQuery: `user=${userId}`,
        sysparmFields: 'group',
        sysparmLimit: 500,
        sysparmDisplayValue: true,
      }) as unknown as Promise<Array<{ group: unknown }>>,
      client.queryTable('sys_user_grmember', {
        sysparmQuery: `user=${userId}`,
        sysparmFields: 'group',
        sysparmLimit: 500,
      }) as unknown as Promise<Array<{ group: unknown }>>,
    ]);
    return raw
      .map((m, i) => ({
        sys_id: str(m.group),
        name: str(display[i]?.group) || str(m.group),
      }))
      .filter((g) => g.sys_id);
  } catch {
    return [];
  }
}

async function fetchGroupRoles(
  client: ServiceNowClient,
  groups: Array<{ sys_id: string; name: string }>
): Promise<Array<{ group: string; role: string }>> {
  if (groups.length === 0) return [];
  try {
    const groupIds = groups.map((g) => g.sys_id).join(',');
    const rows = (await client.queryTable('sys_group_has_role', {
      sysparmQuery: `groupIN${groupIds}`,
      sysparmFields: 'group,role',
      sysparmLimit: 1000,
      sysparmDisplayValue: true,
    })) as unknown as Array<{ group: unknown; role: unknown }>;
    return rows
      .map((r) => ({ group: str(r.group), role: str(r.role) }))
      .filter((r) => r.role);
  } catch {
    return [];
  }
}

async function fetchAcls(
  client: ServiceNowClient,
  table: string,
  operation?: string
): Promise<{
  acls: Record<string, unknown>[];
  roleMap: Map<string, string[]>;
}> {
  const queryParts = [`nameSTARTSWITH${table}`, 'active=true'];
  if (operation) queryParts.push(`operation=${operation}`);

  const acls = (await client.queryTable('sys_security_acl', {
    sysparmQuery: queryParts.join('^'),
    sysparmFields: 'sys_id,name,operation,type,active,admin_overrides,condition,script',
    sysparmLimit: 500,
  })) as unknown as Record<string, unknown>[];

  const roleMap = new Map<string, string[]>();
  if (acls.length > 0) {
    const aclIds = acls.map((a) => str(a['sys_id'])).join(',');
    const roleRecords = (await client.queryTable('sys_security_acl_role', {
      sysparmQuery: `sys_security_aclIN${aclIds}`,
      sysparmFields: 'sys_security_acl,sys_user_role',
      sysparmDisplayValue: true,
      sysparmLimit: 2000,
    })) as unknown as Array<{ sys_security_acl: unknown; sys_user_role: unknown }>;

    for (const r of roleRecords) {
      const aclId =
        str(r.sys_security_acl) ||
        (r.sys_security_acl as Record<string, string>)?.['value'];
      const roleName = str(r.sys_user_role);
      if (!aclId || !roleName) continue;
      if (!roleMap.has(aclId)) roleMap.set(aclId, []);
      roleMap.get(aclId)!.push(roleName);
    }
  }

  return { acls, roleMap };
}

async function fetchBusinessRules(
  client: ServiceNowClient,
  table: string
): Promise<Record<string, unknown>[]> {
  try {
    const all = (await client.queryTable('sys_script', {
      sysparmQuery: `collection=${table}^active=true`,
      sysparmFields:
        'sys_id,name,when,action_insert,action_update,action_delete,action_query,condition,script',
      sysparmLimit: 200,
    })) as unknown as Record<string, unknown>[];

    const SECURITY_TERMS = [
      'setabortaction',
      'adderrormessage',
      'gs.hasrole',
      'gs.hasroleexactly',
      'current.setabortaction',
      'security',
      'restrict',
      'deny',
      'block',
      'forbidden',
      'unauthorized',
      'access',
    ];

    return all.filter((br) => {
      const script = String(br['script'] ?? '').toLowerCase();
      const name = String(br['name'] ?? '').toLowerCase();
      return SECURITY_TERMS.some((t) => script.includes(t) || name.includes(t));
    });
  } catch {
    return [];
  }
}

async function fetchDataPolicies(
  client: ServiceNowClient,
  table: string
): Promise<Record<string, unknown>[]> {
  try {
    return (await client.queryTable('sys_data_policy2', {
      sysparmQuery: `model_table=${table}^active=true`,
      sysparmFields: 'sys_id,name,conditions,short_description',
      sysparmLimit: 100,
      sysparmDisplayValue: true,
    })) as unknown as Record<string, unknown>[];
  } catch {
    return [];
  }
}

async function fetchUiPolicies(
  client: ServiceNowClient,
  table: string
): Promise<Record<string, unknown>[]> {
  try {
    return (await client.queryTable('sys_ui_policy', {
      sysparmQuery: `table=${table}^active=true`,
      sysparmFields: 'sys_id,short_description,conditions,script_true,script_false,run_scripts',
      sysparmLimit: 100,
      sysparmDisplayValue: true,
    })) as unknown as Record<string, unknown>[];
  } catch {
    return [];
  }
}

async function fetchClientScripts(
  client: ServiceNowClient,
  table: string
): Promise<Record<string, unknown>[]> {
  try {
    const all = (await client.queryTable('sys_script_client', {
      sysparmQuery: `table=${table}^active=true`,
      sysparmFields: 'sys_id,name,type,condition,script',
      sysparmLimit: 200,
    })) as unknown as Record<string, unknown>[];

    const SECURITY_TERMS = [
      'setreadonly',
      'setvisible',
      'setmandatory',
      'setdisabled',
      'security',
      'restrict',
      'access',
    ];
    return all.filter((cs) => {
      const script = String(cs['script'] ?? '').toLowerCase();
      const name = String(cs['name'] ?? '').toLowerCase();
      return SECURITY_TERMS.some((t) => script.includes(t) || name.includes(t));
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Build the LLM prompt
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(data: SecurityData, operation?: string): string {
  const opFocus = operation
    ? `Focus specifically on the **${operation}** operation.`
    : 'Cover all operations: read, write, create, delete.';

  return `You are a ServiceNow security expert. Analyze whether the user below can access the table described, using the security data provided.

${opFocus}

## User: ${data.user.user_name} (${data.user.name})
- Active: ${data.user.active}
- Department: ${data.user.department || '(none)'}
- Title: ${data.user.title || '(none)'}
- Direct roles: ${data.user.direct_roles.length ? data.user.direct_roles.join(', ') : '(none)'}
- Groups: ${data.user.groups.length ? data.user.groups.join(', ') : '(none)'}
- Group roles: ${data.user.group_roles.length ? [...new Set(data.user.group_roles.map((r) => r.role))].join(', ') : '(none)'}
- **Effective roles: ${data.user.effective_roles.length ? data.user.effective_roles.join(', ') : '(NONE)'}**

## Table: ${data.table}

## ACL Rules (${data.acls.length} total)
${
  data.acls.length === 0
    ? '(no ACLs found — table may be open or using inherited rules)'
    : data.acls
        .map(
          (a) =>
            `- ${a.operation.toUpperCase()} "${a.name}" — requires roles: [${a.required_roles.length ? a.required_roles.join(', ') : 'NONE (open)'}]${a.has_condition ? ' [has condition]' : ''}${a.has_script ? ' [has script]' : ''}${a.admin_overrides ? ' [admin overrides]' : ''}`
        )
        .join('\n')
}

## Security-relevant Business Rules (${data.business_rules.length})
${
  data.business_rules.length === 0
    ? '(none found)'
    : data.business_rules
        .map(
          (br) =>
            `- "${br.name}" (${br.when}) — triggers: ${Object.entries(br.triggers)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join('/')} | script excerpt: ${br.script_preview.replace(/\s+/g, ' ').slice(0, 200)}`
        )
        .join('\n')
}

## Data Policies (${data.data_policies.length})
${
  data.data_policies.length === 0
    ? '(none found)'
    : data.data_policies.map((dp) => `- "${dp.name}": ${dp.description}`).join('\n')
}

## UI Policies (${data.ui_policies.length})
${
  data.ui_policies.length === 0
    ? '(none found)'
    : data.ui_policies
        .map((up) => `- "${up.description}"${up.has_script ? ' [has script]' : ''}`)
        .join('\n')
}

## Client Scripts (${data.client_scripts.length} security-relevant)
${
  data.client_scripts.length === 0
    ? '(none found)'
    : data.client_scripts
        .map((cs) => `- "${cs.name}" (${cs.type}): ${cs.script_preview.replace(/\s+/g, ' ').slice(0, 150)}`)
        .join('\n')
}

---

Please provide:
1. **Access Summary** — for each operation (read, write, create, delete), state clearly: ALLOWED, DENIED, CONDITIONAL (depends on script/condition logic), or UNKNOWN.
2. **Effective Role Analysis** — which of the user's roles satisfy (or fail to satisfy) the ACL requirements for each operation.
3. **Blocking Components** — list each specific security layer that would prevent access, explaining why.
4. **Open Risks** — note any ACLs with no role requirement (open), which could grant unintended access.
5. **Recommendations** — practical steps to grant or restrict access if needed.

Be specific. Reference role names, ACL names, and business rule names directly.`;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function securityCommand(): Command {
  const cmd = new Command('security').description(
    'Analyze security and access controls for a user against a table'
  );

  cmd
    .command('analyze <username> <table>')
    .description(
      'Gather ACLs, roles, business rules, policies, and use AI to determine access'
    )
    .option(
      '--operation <op>',
      'Focus analysis on a specific operation: read, write, create, delete, execute'
    )
    .option('--json', 'Output the raw gathered security data as JSON (no LLM analysis)')
    .option('--no-llm', 'Print a structured summary without calling the LLM')
    .option('--save <file>', 'Save the LLM analysis to a file (markdown)')
    .option('--provider <name>', 'Override the active LLM provider for this command')
    .addHelpText(
      'after',
      `
Examples:
  snow security analyze nicholas.blanchard sn_grc_issue
  snow security analyze john.doe incident --operation read
  snow security analyze jane.smith sys_user --json
  snow security analyze admin change_request --save report.md
  snow security analyze nicholas.blanchard sn_grc_issue --no-llm
`
    )
    .action(
      async (
        username: string,
        table: string,
        opts: {
          operation?: string;
          json?: boolean;
          llm?: boolean;
          save?: string;
          provider?: string;
        }
      ) => {
        const instance = requireActiveInstance();
        const client = new ServiceNowClient(instance);

        // ── Gather phase ──────────────────────────────────────────────────

        const spinner = ora(`Resolving user "${username}"…`).start();

        // 1. User
        let userResult: { record: Record<string, unknown>; userId: string } | null;
        try {
          userResult = await fetchUser(client, username);
        } catch (err) {
          spinner.fail(chalk.red('Failed to fetch user'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
          return;
        }

        if (!userResult) {
          spinner.fail(chalk.red(`User not found: ${username}`));
          process.exit(1);
          return;
        }

        const { record: userRecord, userId } = userResult;
        spinner.text = `Fetching roles and group memberships for ${username}…`;

        // 2–4. Roles and groups (parallel)
        const [directRoles, groups] = await Promise.all([
          fetchDirectRoles(client, userId),
          fetchGroups(client, userId),
        ]);
        const groupRoles = await fetchGroupRoles(client, groups);
        const allRoles = new Set<string>([...directRoles, ...groupRoles.map((r) => r.role)]);

        spinner.text = `Fetching ACLs for ${table}…`;

        // 5. ACLs
        let acls: Record<string, unknown>[] = [];
        let aclRoleMap = new Map<string, string[]>();
        try {
          const result = await fetchAcls(client, table, opts.operation);
          acls = result.acls;
          aclRoleMap = result.roleMap;
        } catch (err) {
          spinner.warn(
            chalk.yellow(
              `Could not fetch ACLs: ${err instanceof Error ? err.message : String(err)}`
            )
          );
        }

        spinner.text = `Fetching security-related records for ${table}…`;

        // 6–9. Business rules, data policies, UI policies, client scripts (parallel)
        const [businessRules, dataPolicies, uiPolicies, clientScripts] = await Promise.all([
          fetchBusinessRules(client, table),
          fetchDataPolicies(client, table),
          fetchUiPolicies(client, table),
          fetchClientScripts(client, table),
        ]);

        spinner.succeed('Security data gathered.');

        // ── Assemble structured output ─────────────────────────────────────

        const aclsFormatted = acls.map((a) => ({
          sys_id: str(a['sys_id']),
          name: str(a['name']),
          operation: str(a['operation']),
          type: str(a['type']) || 'record',
          admin_overrides: bool(a['admin_overrides']),
          has_condition: Boolean(String(a['condition'] ?? '').trim()),
          has_script: Boolean(String(a['script'] ?? '').trim()),
          required_roles: aclRoleMap.get(str(a['sys_id'])) ?? [],
        }));

        const securityData: SecurityData = {
          user: {
            user_name: str(userRecord['user_name']),
            name: str(userRecord['name']),
            email: str(userRecord['email']),
            active: str(userRecord['active']),
            department: str(userRecord['department']),
            title: str(userRecord['title']),
            direct_roles: directRoles,
            groups: groups.map((g) => g.name),
            group_roles: groupRoles,
            effective_roles: Array.from(allRoles).sort(),
          },
          table,
          acls: aclsFormatted,
          business_rules: businessRules.map((br) => ({
            name: str(br['name']),
            when: str(br['when']),
            triggers: {
              insert: bool(br['action_insert']),
              update: bool(br['action_update']),
              delete: bool(br['action_delete']),
              query: bool(br['action_query']),
            },
            has_condition: Boolean(String(br['condition'] ?? '').trim()),
            script_preview: String(br['script'] ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 400),
          })),
          data_policies: dataPolicies.map((dp) => ({
            name: str(dp['name']),
            description: str(dp['short_description']),
          })),
          ui_policies: uiPolicies.map((up) => ({
            description: str(up['short_description']),
            has_script: Boolean(
              String(up['script_true'] ?? up['script_false'] ?? '').trim()
            ),
          })),
          client_scripts: clientScripts.map((cs) => ({
            name: str(cs['name']),
            type: str(cs['type']),
            script_preview: String(cs['script'] ?? '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 250),
          })),
        };

        // ── JSON output (raw data only) ────────────────────────────────────

        if (opts.json) {
          console.log(JSON.stringify(securityData, null, 2));
          return;
        }

        // ── Structured terminal summary ────────────────────────────────────

        const DIVIDER = chalk.dim('─'.repeat(68));
        console.log();
        console.log(DIVIDER);
        console.log(
          `  ${chalk.bold('Security Analysis')}   ` +
            `${chalk.cyan(username)} → ${chalk.cyan(table)}` +
            (opts.operation ? chalk.dim(`  [${opts.operation} only]`) : '')
        );
        console.log(DIVIDER);

        // User section
        console.log();
        console.log(`  ${chalk.bold('User')}`);
        console.log(`    ${chalk.dim('Full name:')}   ${securityData.user.name}`);
        console.log(
          `    ${chalk.dim('Active:')}      ${securityData.user.active === 'true' ? chalk.green('yes') : chalk.red('no')}`
        );
        if (securityData.user.department) {
          console.log(`    ${chalk.dim('Department:')}  ${securityData.user.department}`);
        }
        if (securityData.user.title) {
          console.log(`    ${chalk.dim('Title:')}       ${securityData.user.title}`);
        }

        console.log();
        console.log(`  ${chalk.bold('Roles')} (${securityData.user.effective_roles.length} effective)`);
        if (securityData.user.direct_roles.length > 0) {
          console.log(
            `    ${chalk.dim('Direct:')}     ${securityData.user.direct_roles.join(', ')}`
          );
        } else {
          console.log(`    ${chalk.dim('Direct:')}     ${chalk.dim('(none)')}`);
        }
        if (groups.length > 0) {
          console.log(
            `    ${chalk.dim('Groups:')}     ${securityData.user.groups.join(', ')}`
          );
          const uniqueGroupRoles = [...new Set(groupRoles.map((r) => r.role))];
          if (uniqueGroupRoles.length > 0) {
            console.log(
              `    ${chalk.dim('Via groups:')} ${uniqueGroupRoles.join(', ')}`
            );
          }
        }
        if (securityData.user.effective_roles.length === 0) {
          console.log(`    ${chalk.red('  No roles assigned.')}`);
        }

        // ACL section
        console.log();
        console.log(`  ${chalk.bold('ACL Rules')} (${aclsFormatted.length})`);
        if (aclsFormatted.length === 0) {
          console.log(
            `    ${chalk.yellow('No ACLs found — table may be open or using parent/global rules.')}`
          );
        } else {
          const operations = [...new Set(aclsFormatted.map((a) => a.operation))].sort();
          for (const op of operations) {
            const rules = aclsFormatted.filter((a) => a.operation === op);
            for (const rule of rules) {
              const userMeetsRole =
                rule.required_roles.length === 0 ||
                rule.required_roles.some((r) => allRoles.has(r));
              const uncertain = rule.has_condition || rule.has_script;

              let statusIcon: string;
              if (uncertain && !userMeetsRole) {
                statusIcon = chalk.red('✗');
              } else if (uncertain) {
                statusIcon = chalk.yellow('~'); // conditional
              } else if (rule.required_roles.length === 0) {
                statusIcon = chalk.yellow('○'); // open (no roles required)
              } else if (userMeetsRole) {
                statusIcon = chalk.green('✓');
              } else {
                statusIcon = chalk.red('✗');
              }

              const rolesStr =
                rule.required_roles.length === 0
                  ? chalk.yellow('(open)')
                  : rule.required_roles
                      .map((r) => (allRoles.has(r) ? chalk.green(r) : chalk.red(r)))
                      .join(', ');

              const flags = [
                rule.has_condition ? chalk.dim('[cond]') : '',
                rule.has_script ? chalk.dim('[script]') : '',
                rule.admin_overrides ? chalk.dim('[admin-overrides]') : '',
              ]
                .filter(Boolean)
                .join(' ');

              console.log(
                `    ${statusIcon} ${chalk.dim(op.padEnd(8))} ${chalk.bold(rule.name.padEnd(32))} ${rolesStr} ${flags}`
              );
            }
          }
          console.log();
          console.log(chalk.dim(`    Legend: ${chalk.green('✓')} user has required role  ${chalk.red('✗')} missing role  ${chalk.yellow('~')} conditional  ${chalk.yellow('○')} open`));
        }

        // Business rules
        if (securityData.business_rules.length > 0) {
          console.log();
          console.log(
            `  ${chalk.bold('Security-relevant Business Rules')} (${securityData.business_rules.length})`
          );
          for (const br of securityData.business_rules) {
            const triggers = Object.entries(br.triggers)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join('/');
            console.log(`    ${chalk.dim(br.when.padEnd(9))} ${br.name}  ${chalk.dim(triggers)}`);
          }
        }

        // Data policies
        if (securityData.data_policies.length > 0) {
          console.log();
          console.log(
            `  ${chalk.bold('Data Policies')} (${securityData.data_policies.length})`
          );
          for (const dp of securityData.data_policies) {
            console.log(`    ${dp.name}${dp.description ? chalk.dim(` — ${dp.description}`) : ''}`);
          }
        }

        console.log();
        console.log(DIVIDER);

        // ── Skip LLM if --no-llm ──────────────────────────────────────────
        if (opts.llm === false) {
          console.log(chalk.dim('  (LLM analysis skipped — use without --no-llm to get AI insights)'));
          console.log();
          return;
        }

        // ── LLM Analysis ──────────────────────────────────────────────────

        let llmProvider = getActiveProvider();
        if (!llmProvider) {
          console.log(
            chalk.yellow(
              '\n  No LLM provider configured. Run `snow provider set <name>` to enable AI analysis.'
            ) +
              chalk.dim('\n  Or use --no-llm to skip AI analysis and see only gathered data.\n')
          );
          return;
        }

        if (opts.provider) {
          const { getAIConfig } = await import('../lib/config.js');
          const ai = getAIConfig();
          const pc = ai.providers[opts.provider as keyof typeof ai.providers];
          if (!pc) {
            console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
            process.exit(1);
          }
          llmProvider = { name: opts.provider as typeof llmProvider.name, config: pc };
        }

        const provider = buildProvider(
          llmProvider.name,
          llmProvider.config.model,
          llmProvider.config.apiKey,
          llmProvider.config.baseUrl
        );

        const analysisPrompt = buildAnalysisPrompt(securityData, opts.operation);
        const messages: LLMMessage[] = [
          {
            role: 'system',
            content:
              'You are a ServiceNow security expert. Provide clear, structured security analysis. Use markdown formatting in your response.',
          },
          { role: 'user', content: analysisPrompt },
        ];

        const llmSpinner = ora(`Analyzing with ${provider.providerName}…`).start();
        let analysis: string;
        try {
          analysis = await provider.complete(messages);
          llmSpinner.succeed('Analysis complete.');
        } catch (err) {
          llmSpinner.fail(chalk.red('LLM request failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          return;
        }

        console.log();
        console.log(analysis);
        console.log();

        if (opts.save) {
          const header = `# Security Analysis: ${username} → ${table}\n\nGenerated: ${new Date().toISOString()}\n\n---\n\n`;
          writeFileSync(opts.save, header + analysis + '\n');
          console.log(chalk.dim(`  Analysis saved to ${opts.save}`));
          console.log();
        }
      }
    );

  return cmd;
}
