import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync, readFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { confirm } from '@inquirer/prompts';
import { requireActiveInstance, loadConfig, getActiveProvider } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';
import { buildProvider, extractJSON, type LLMMessage } from '../lib/llm.js';
import { generateUpdateSetXML, pushArtifacts } from '../lib/update-set.js';
import {
  generateATFTests,
  getServerScriptStepConfig,
  pushATFSuite,
  runATFSuite,
  type ATFRunResult,
} from '../lib/atf.js';
import type { SNBuildResponse, SNArtifact, SNScope } from '../types/index.js';

// ---------------------------------------------------------------------------
// Planning types
// ---------------------------------------------------------------------------

interface FactoryComponent {
  id: string;
  name: string;
  description: string;
  artifact_types: string[];
  depends_on: string[];
  prompt: string;
}

interface FactoryPlan {
  name: string;
  description: string;
  scope?: SNScope;
  components: FactoryComponent[];
  risks: string[];
  estimated_artifacts: number;
}

interface ComponentState {
  id: string;
  status: 'pending' | 'done' | 'failed';
  buildDir?: string;
  artifactCount?: number;
  error?: string;
}

interface PromotionState {
  env: string;
  status: 'pending' | 'done' | 'failed';
  error?: string;
}

interface FactoryCheckpoint {
  id: string;
  startedAt: string;
  prompt: string;
  plan: FactoryPlan;
  envs: string[];
  components: ComponentState[];
  atfSuiteSysId?: string;
  promotions: PromotionState[];
}

// ---------------------------------------------------------------------------
// Planning system prompt
// ---------------------------------------------------------------------------

const FACTORY_PLAN_PROMPT = `
You are a ServiceNow solution architect. Analyze the feature/application request and break it into an ordered build plan.

Respond ONLY with a JSON object (optionally wrapped in a \`\`\`json code fence). No prose.

Schema:
\`\`\`json
{
  "name": "Human-readable app or feature name",
  "description": "What this app/feature does",
  "scope": { "prefix": "x_vendor_app", "name": "App Name", "version": "1.0.0" },
  "components": [
    {
      "id": "unique_snake_case_id",
      "name": "Component display name",
      "description": "What this component creates",
      "artifact_types": ["table", "script_include"],
      "depends_on": [],
      "prompt": "Specific, complete build request for this component with all field names, table names, scope prefix, and business logic details included"
    }
  ],
  "risks": ["Known challenge or integration requirement"],
  "estimated_artifacts": 10
}
\`\`\`

Planning rules:
- scope: include when the request creates 2+ custom tables, or describes an "application", "module", or "package". Omit for simple single-feature customisations.
- components: 1–5, ordered by dependency (always: tables → script_includes → business_rules/client_scripts → ui)
- each component.prompt must be a complete, self-contained build request for a code generator — include table names, field names, scope prefix, conditions, and all relevant business logic
- depends_on: list the IDs of components that must be built before this one
- risks: 2–4 realistic integration risks or constraints (e.g. "MID Server required for AD sync")
- estimated_artifacts: total count of SN artifacts (scripts + tables + columns count as 1)
- Do NOT generate ServiceNow code in this plan — only the planning metadata
`.trim();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FACTORY_DIR = join(homedir(), '.snow', 'factory');

function ensureFactoryDir(): void {
  mkdirSync(FACTORY_DIR, { recursive: true });
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function saveCheckpoint(state: FactoryCheckpoint): void {
  ensureFactoryDir();
  const dir = join(FACTORY_DIR, state.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'state.json'), JSON.stringify(state, null, 2), 'utf-8');
}

function loadCheckpoint(id: string): FactoryCheckpoint | null {
  const path = join(FACTORY_DIR, id, 'state.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as FactoryCheckpoint;
}

function listCheckpoints(): string[] {
  ensureFactoryDir();
  return readdirSync(FACTORY_DIR).filter(f =>
    existsSync(join(FACTORY_DIR, f, 'state.json'))
  );
}

function resolveProvider() {
  const active = getActiveProvider();
  if (!active) {
    console.error(chalk.red('No LLM provider configured. Run `snow provider set <name>` first.'));
    process.exit(1);
  }
  return buildProvider(active.name, active.config.model, active.config.apiKey, active.config.baseUrl);
}

function printDivider(): void {
  console.log(chalk.dim('─'.repeat(56)));
}

function printPhase(num: number, total: number, label: string): void {
  console.log();
  printDivider();
  console.log(`  ${chalk.bold.cyan(`[${num}/${total}]`)} ${chalk.bold(label)}`);
  printDivider();
}

// Apply an update-set XML to a target instance by POSTing to sys_remote_update_set
async function applyXMLToInstance(
  client: ServiceNowClient,
  xml: string,
  buildName: string
): Promise<string> {
  const res = await client.post<{ result: { sys_id?: string; name?: string } }>(
    '/api/now/table/sys_remote_update_set',
    {
      name: buildName,
      description: `Imported via snow factory`,
      payload: xml,
      state: 'loaded',
    }
  );
  return String(res.result.sys_id ?? '');
}

// ---------------------------------------------------------------------------
// Build a single component
// ---------------------------------------------------------------------------

async function buildComponent(
  provider: ReturnType<typeof resolveProvider>,
  component: FactoryComponent,
  plan: FactoryPlan,
  runDir: string,
  previousBuilds: SNBuildResponse[]
): Promise<SNBuildResponse> {
  // Add context from prior builds so the LLM can reference already-built artifacts
  let contextNote = '';
  if (previousBuilds.length > 0 && plan.scope) {
    const priorNames = previousBuilds
      .flatMap(b => b.artifacts)
      .map(a => `${a.type}: ${String(a.fields['name'] ?? '')}`)
      .filter(Boolean);
    contextNote =
      `\n\nContext from previously built components (use these names for cross-references):\n` +
      priorNames.map(n => `  - ${n}`).join('\n') +
      `\nScope prefix for all custom names: ${plan.scope.prefix}`;
  }

  // Prepend an explicit directive so the LLM skips clarifying questions in the factory pipeline.
  // The planning phase already extracted specific details; the builder should generate immediately.
  const factoryDirective =
    'IMPORTANT: This is an automated factory pipeline. ' +
    'Do NOT ask clarifying questions. Make reasonable assumptions for any missing details and ' +
    'respond immediately with the complete JSON build. ' +
    (plan.scope ? `Application scope prefix: ${plan.scope.prefix}. ` : '') +
    'Respond with ONLY the JSON build object wrapped in a ```json code fence.\n\n';

  const buildPrompt = factoryDirective + component.prompt + contextNote;

  const { SN_SYSTEM_PROMPT } = await import('../lib/sn-context.js');
  const history: LLMMessage[] = [
    { role: 'system', content: SN_SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt },
  ];

  // Conversation loop — handles rare cases where the LLM still asks a clarifying question.
  // Prompts the user interactively and continues until JSON is returned.
  const { input: promptInput } = await import('@inquirer/prompts');

  let parsed: Record<string, unknown> | null = null;
  while (!parsed) {
    const raw = await provider.complete(history);
    history.push({ role: 'assistant', content: raw });

    let json: string;
    try {
      json = extractJSON(raw);
      parsed = JSON.parse(json) as Record<string, unknown>;
      if (!parsed['artifacts']) parsed = null; // not a build response
    } catch {
      parsed = null;
    }

    if (!parsed) {
      // LLM asked a clarifying question despite the directive — surface it to the user
      console.log();
      const lines = raw.trim().split('\n');
      console.log(chalk.magenta(`  AI [${component.name}] > `) + lines[0]);
      for (let i = 1; i < lines.length; i++) console.log('     ' + lines[i]);
      console.log();
      const answer = await promptInput({ message: chalk.cyan('  You') });
      history.push({ role: 'user', content: answer.trim() || 'Please generate the build now with reasonable defaults.' });
    }
  }

  // Normalise (same logic as ai.ts normaliseBuildResponse)
  const name = String(parsed['name'] ?? component.name);
  const description = String(parsed['description'] ?? component.description);
  const rawArtifacts = Array.isArray(parsed['artifacts']) ? parsed['artifacts'] : [];
  const artifacts = rawArtifacts.map((a: unknown) => {
    const art = a as Record<string, unknown>;
    const type = String(art['type'] ?? '');
    let fields: Record<string, unknown>;
    if (art['fields'] && typeof art['fields'] === 'object' && !Array.isArray(art['fields'])) {
      fields = art['fields'] as Record<string, unknown>;
    } else {
      const { type: _t, ...rest } = art;
      fields = rest;
    }
    return { type, fields } as SNArtifact;
  });

  const build: SNBuildResponse = {
    name,
    description,
    scope: plan.scope,
    artifacts,
  };

  // Save component build to disk
  const compDir = join(runDir, component.id);
  mkdirSync(compDir, { recursive: true });
  const base = slugify(name);
  writeFileSync(join(compDir, `${base}.xml`), generateUpdateSetXML(build), 'utf-8');
  writeFileSync(join(compDir, `${base}.manifest.json`), JSON.stringify(build, null, 2), 'utf-8');

  return build;
}

// ---------------------------------------------------------------------------
// Auto-optimization loop
// ---------------------------------------------------------------------------

async function runOptimizationLoop(opts: {
  provider: ReturnType<typeof resolveProvider>;
  client: ServiceNowClient;
  build: SNBuildResponse;
  atfSuiteSysId: string;
  initialRunResult: ATFRunResult;
  maxRetries: number;
  runDir: string;
}): Promise<SNBuildResponse> {
  const { provider, client, atfSuiteSysId, maxRetries, runDir } = opts;
  let currentBuild = opts.build;
  let runResult = opts.initialRunResult;

  const { SN_SYSTEM_PROMPT } = await import('../lib/sn-context.js');

  for (let iteration = 1; iteration <= maxRetries; iteration++) {
    const failures = runResult.testResults.filter(t => t.status !== 'success');
    if (failures.length === 0) break;

    console.log();
    printDivider();
    console.log(`  ${chalk.bold.magenta(`[Optimize ${iteration}/${maxRetries}]`)} ${chalk.red(`${failures.length} test(s) failing`)} — asking LLM to fix...`);
    printDivider();

    // Summarise failures
    const failureLines = failures
      .map(t => `  - "${t.name}": ${t.message ?? 'no details'}`)
      .join('\n');

    // Include source for all script-bearing artifacts
    const artifactLines = currentBuild.artifacts
      .filter(a => a.fields['script'] ?? a.fields['condition'])
      .map(a => {
        const name = String(a.fields['name'] ?? '');
        const script = String(a.fields['script'] ?? '');
        const condition = String(a.fields['condition'] ?? '');
        let out = `[${a.type}: ${name}]`;
        if (script) out += `\nscript:\n${script}`;
        if (condition) out += `\ncondition:\n${condition}`;
        return out;
      })
      .join('\n\n---\n\n');

    const fixPrompt =
      `OPTIMIZATION LOOP — Iteration ${iteration} of ${maxRetries}\n\n` +
      `The following ATF tests failed after deploying the generated artifacts:\n\n` +
      `FAILING TESTS:\n${failureLines}\n\n` +
      `CURRENT ARTIFACT CODE:\n${artifactLines}\n\n` +
      `Your task: analyze the failures, identify root causes, and return corrected artifacts.\n` +
      `Rules:\n` +
      `- Return ONLY a JSON object wrapped in a \`\`\`json code fence\n` +
      `- Use the same schema: { "name": "...", "description": "...", "artifacts": [...] }\n` +
      `- Only include artifacts that need changes\n` +
      `- All scripts must be ES5 (var only, no arrow functions, no const/let)\n` +
      `- Do NOT ask clarifying questions — provide the fix immediately`;

    const messages: LLMMessage[] = [
      { role: 'system', content: SN_SYSTEM_PROMPT },
      { role: 'user', content: fixPrompt },
    ];

    const llmSpinner = ora(`  Calling LLM for fix...`).start();
    let fixedArtifacts: SNArtifact[];
    try {
      const raw = await provider.complete(messages);
      llmSpinner.stop();
      const json = extractJSON(raw);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      const rawArtifacts = Array.isArray(parsed['artifacts']) ? parsed['artifacts'] : [];
      fixedArtifacts = rawArtifacts.map((a: unknown) => {
        const art = a as Record<string, unknown>;
        const type = String(art['type'] ?? '');
        let fields: Record<string, unknown>;
        if (art['fields'] && typeof art['fields'] === 'object' && !Array.isArray(art['fields'])) {
          fields = art['fields'] as Record<string, unknown>;
        } else {
          const { type: _t, ...rest } = art;
          fields = rest;
        }
        return { type, fields } as SNArtifact;
      });
    } catch (err) {
      llmSpinner.fail(chalk.yellow(`  LLM call failed on iteration ${iteration} — stopping optimization`));
      console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
      break;
    }

    // Merge fixed artifacts into current build (replace by type + name, add new ones)
    const mergedArtifacts = currentBuild.artifacts.map(orig => {
      const fix = fixedArtifacts.find(
        f => f.type === orig.type && String(f.fields['name']) === String(orig.fields['name'])
      );
      return fix ?? orig;
    });
    const addedArtifacts = fixedArtifacts.filter(
      f => !currentBuild.artifacts.some(
        orig => orig.type === f.type && String(orig.fields['name']) === String(f.fields['name'])
      )
    );

    const updatedBuild: SNBuildResponse = {
      ...currentBuild,
      artifacts: [...mergedArtifacts, ...addedArtifacts],
    };

    // Show which artifacts changed
    const changed = fixedArtifacts.filter(f =>
      currentBuild.artifacts.some(
        orig => orig.type === f.type && String(orig.fields['name']) === String(f.fields['name'])
      )
    );
    if (changed.length > 0) {
      console.log(`  ${chalk.dim('Patching:')}`);
      for (const a of changed) {
        console.log(`    ${chalk.yellow('~')} ${chalk.cyan(a.type.padEnd(16))} ${String(a.fields['name'] ?? '')}`);
      }
    }

    // Re-push the updated artifacts
    const pushSpinner = ora(`  Re-pushing fixed artifacts to instance...`).start();
    try {
      await pushArtifacts(client, updatedBuild);
      pushSpinner.stop();
    } catch (err) {
      pushSpinner.fail(chalk.yellow('Re-push failed — stopping optimization'));
      console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
      break;
    }

    // Persist updated manifest to disk
    const base = slugify(updatedBuild.name);
    writeFileSync(join(runDir, `${base}.xml`), generateUpdateSetXML(updatedBuild), 'utf-8');
    writeFileSync(join(runDir, `${base}.manifest.json`), JSON.stringify(updatedBuild, null, 2), 'utf-8');

    // Re-run the existing ATF suite
    const testSpinner = ora(`  Re-running ATF tests...`).start();
    try {
      runResult = await runATFSuite(client, atfSuiteSysId);
      testSpinner.stop();
    } catch (err) {
      testSpinner.fail(chalk.yellow('ATF re-run failed — stopping optimization'));
      console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
      break;
    }

    const passColor = runResult.failed === 0 ? chalk.green : chalk.yellow;
    console.log(`  ${passColor(`${runResult.passed}/${runResult.total} tests passed`)}`);
    for (const t of runResult.testResults) {
      const icon = t.status === 'success' ? chalk.green('✓') : chalk.red('✗');
      const msg = t.message ? chalk.dim(`  (${t.message})`) : '';
      console.log(`    ${icon} ${t.name}${msg}`);
    }

    currentBuild = updatedBuild;

    if (runResult.failed === 0) {
      console.log();
      console.log(chalk.green('  ✔ All tests passing after optimization!'));
      break;
    }
  }

  if (runResult.failed > 0) {
    console.log();
    console.log(chalk.yellow(`  ⚠ ${runResult.failed} test(s) still failing after ${maxRetries} optimization iteration(s).`));
    console.log(chalk.dim('  Review the ATF suite in ServiceNow for details.'));
  }

  return currentBuild;
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export function factoryCommand(): Command {
  const cmd = new Command('factory')
    .description('AI-orchestrated multi-component ServiceNow app pipeline: plan → build → test → promote')
    .argument('<prompt>', 'Natural language description of the application to build')
    .option('--envs <aliases>', 'Comma-separated instance aliases to deploy to in order (default: active instance only)', '')
    .option('--scope <prefix>', 'Override the application scope prefix (e.g. x_myco_myapp)')
    .option('--skip-tests', 'Skip ATF test generation')
    .option('--run-tests', 'Execute ATF tests on the source instance after generating them')
    .option('--optimize', 'Auto-fix failing ATF tests via LLM feedback loop (implies --run-tests)')
    .option('--max-retries <n>', 'Max optimization iterations (used with --optimize)', '3')
    .option('--dry-run', 'Show the plan only — do not build or deploy')
    .option('--resume <id>', 'Resume a previous factory run from its checkpoint')
    .option('--list', 'List recent factory runs and their status')
    .action(async (
      prompt: string,
      opts: {
        envs?: string;
        scope?: string;
        skipTests?: boolean;
        runTests?: boolean;
        optimize?: boolean;
        maxRetries?: string;
        dryRun?: boolean;
        resume?: string;
        list?: boolean;
      }
    ) => {

      // ── List mode ────────────────────────────────────────────────────────
      if (opts.list) {
        const runs = listCheckpoints();
        if (runs.length === 0) {
          console.log(chalk.dim('No factory runs found.'));
          return;
        }
        console.log();
        console.log(chalk.bold('Recent factory runs:'));
        for (const id of runs.slice(-10).reverse()) {
          const cp = loadCheckpoint(id);
          if (!cp) continue;
          const done = cp.components.filter(c => c.status === 'done').length;
          const total = cp.components.length;
          const pct = total > 0 ? `${done}/${total}` : '?';
          const statusColor = done === total ? chalk.green : chalk.yellow;
          console.log(`  ${chalk.cyan(id)}  ${statusColor(pct)} components  ${chalk.dim(cp.plan.name)}`);
        }
        console.log();
        console.log(chalk.dim('Resume with: snow factory "<prompt>" --resume <id>'));
        return;
      }

      // ── Resume from checkpoint ────────────────────────────────────────────
      let checkpoint: FactoryCheckpoint | null = null;
      if (opts.resume) {
        checkpoint = loadCheckpoint(opts.resume);
        if (!checkpoint) {
          console.error(chalk.red(`No checkpoint found for run: ${opts.resume}`));
          process.exit(1);
        }
        console.log(chalk.cyan(`Resuming factory run: ${opts.resume}`));
      }

      const provider = resolveProvider();
      const sourceInstance = requireActiveInstance();

      const targetEnvAliases: string[] = opts.envs
        ? opts.envs.split(',').map(a => a.trim()).filter(Boolean)
        : [];

      // Validate target envs
      const config = loadConfig();
      for (const alias of targetEnvAliases) {
        if (!config.instances[alias]) {
          console.error(chalk.red(`Instance "${alias}" not found. Run \`snow instance list\`.`));
          process.exit(1);
        }
      }

      // ── Phase 0: Banner ───────────────────────────────────────────────────
      console.log();
      printDivider();
      console.log(`  ${chalk.bold.cyan('snow factory')}  ·  ${chalk.bold(provider.providerName)}`);
      console.log(`  ${chalk.dim('Source:')} ${chalk.cyan(sourceInstance.alias)}  ${chalk.dim(sourceInstance.url)}`);
      if (targetEnvAliases.length > 0) {
        console.log(`  ${chalk.dim('Pipeline:')} ${[sourceInstance.alias, ...targetEnvAliases].join(chalk.dim(' → '))}`);
      }
      printDivider();

      const TOTAL_PHASES = 3 + (opts.skipTests ? 0 : 1) + targetEnvAliases.length;

      // ── Phase 1: Planning ─────────────────────────────────────────────────
      let plan: FactoryPlan;
      let runId: string;
      let runDir: string;

      if (checkpoint) {
        plan = checkpoint.plan;
        runId = checkpoint.id;
        runDir = join(FACTORY_DIR, runId);
      } else {
        printPhase(1, TOTAL_PHASES, 'Planning');

        const spinner = ora('Analyzing requirements and generating plan...').start();

        let planRaw: string;
        try {
          const messages: LLMMessage[] = [
            { role: 'system', content: FACTORY_PLAN_PROMPT },
            { role: 'user', content: prompt },
          ];
          planRaw = await provider.complete(messages);
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red('Planning failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        try {
          const json = extractJSON(planRaw);
          plan = JSON.parse(json) as FactoryPlan;
        } catch {
          console.error(chalk.red('Failed to parse plan response from LLM.'));
          console.error(chalk.dim(planRaw.slice(0, 500)));
          process.exit(1);
        }

        // Apply --scope override if provided
        if (opts.scope) {
          plan.scope = {
            prefix:  opts.scope,
            name:    plan.scope?.name ?? plan.name,
            version: plan.scope?.version ?? '1.0.0',
            vendor:  plan.scope?.vendor,
          };
        }

        // Display plan
        console.log();
        console.log(`  ${chalk.bold(plan.name)}`);
        if (plan.description) console.log(`  ${chalk.dim(plan.description)}`);
        if (plan.scope) {
          console.log(`  ${chalk.dim('scope:')} ${chalk.white(plan.scope.prefix)}  v${plan.scope.version}`);
        }
        console.log();
        console.log(`  ${chalk.bold('Components')} (${plan.components.length}) — ~${plan.estimated_artifacts} artifacts`);
        for (let i = 0; i < plan.components.length; i++) {
          const c = plan.components[i];
          const deps = c.depends_on.length > 0 ? chalk.dim(` ← depends on: ${c.depends_on.join(', ')}`) : '';
          console.log(`  ${chalk.dim(String(i + 1) + '.')} ${chalk.white(c.name)}${deps}`);
          console.log(`     ${chalk.dim(c.description)}`);
        }
        if (plan.risks.length > 0) {
          console.log();
          console.log(`  ${chalk.yellow('⚠ Risks:')}`);
          for (const r of plan.risks) {
            console.log(`    ${chalk.dim('•')} ${chalk.yellow(r)}`);
          }
        }
        console.log();

        if (opts.dryRun) {
          console.log(chalk.dim('  --dry-run: stopping here. No builds or deployments made.'));
          console.log();
          return;
        }

        const proceed = await confirm({
          message: `Execute factory pipeline? (${plan.components.length} components → ${sourceInstance.alias}${targetEnvAliases.length > 0 ? ' → ' + targetEnvAliases.join(' → ') : ''})`,
          default: true,
        });

        if (!proceed) {
          console.log(chalk.dim('Cancelled.'));
          return;
        }

        // Initialise checkpoint
        runId = randomUUID().slice(0, 8);
        runDir = join(FACTORY_DIR, runId);
        mkdirSync(runDir, { recursive: true });

        checkpoint = {
          id: runId,
          startedAt: new Date().toISOString(),
          prompt,
          plan,
          envs: targetEnvAliases,
          components: plan.components.map(c => ({ id: c.id, status: 'pending' as const })),
          promotions: targetEnvAliases.map(e => ({ env: e, status: 'pending' as const })),
        };
        saveCheckpoint(checkpoint);
      }

      // ── Phase 2: Build each component ────────────────────────────────────
      printPhase(2, TOTAL_PHASES, 'Building components');

      const componentBuilds: SNBuildResponse[] = [];

      for (let i = 0; i < plan.components.length; i++) {
        const component = plan.components[i];
        const compState = checkpoint.components.find(c => c.id === component.id)!;

        if (compState.status === 'done' && compState.buildDir) {
          // Load from checkpoint
          const files = readdirSync(compState.buildDir).filter(f => f.endsWith('.manifest.json'));
          if (files.length > 0) {
            const existing = JSON.parse(
              readFileSync(join(compState.buildDir, files[0]), 'utf-8')
            ) as SNBuildResponse;
            componentBuilds.push(existing);
            console.log(chalk.dim(`  [${i + 1}/${plan.components.length}] ${component.name} — resumed from checkpoint`));
            continue;
          }
        }

        const spinner = ora(`  [${i + 1}/${plan.components.length}] Building: ${component.name}...`).start();

        let build: SNBuildResponse;
        try {
          build = await buildComponent(provider, component, plan, runDir, componentBuilds);
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red(`  Failed: ${component.name}`));
          console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
          compState.status = 'failed';
          compState.error = err instanceof Error ? err.message : String(err);
          saveCheckpoint(checkpoint);

          // Offer to skip and continue (only if there are more components)
          if (i < plan.components.length - 1) {
            const { confirm: confirmSkip } = await import('@inquirer/prompts');
            const skip = await confirmSkip({
              message: `Skip "${component.name}" and continue with remaining components?`,
              default: false,
            });
            if (skip) {
              console.log(chalk.yellow(`  Skipping. Continuing with remaining components...`));
              continue;
            }
          }

          console.log(chalk.yellow(`\n  Factory run saved. Resume with: snow factory "" --resume ${runId}`));
          process.exit(1);
        }

        componentBuilds.push(build);
        compState.status = 'done';
        compState.buildDir = join(runDir, component.id);
        compState.artifactCount = build.artifacts.length;
        saveCheckpoint(checkpoint);

        // Print component summary
        console.log(`  ${chalk.green('✓')} ${chalk.bold(component.name)}  ${chalk.dim(`${build.artifacts.length} artifacts`)}`);
        for (const a of build.artifacts) {
          const name = String(a.fields['name'] ?? '');
          console.log(`     ${chalk.green('+')} ${chalk.cyan(a.type.padEnd(16))} ${name}`);
        }
      }

      // Merge all component builds into one combined build
      let combinedBuild: SNBuildResponse = {
        name: plan.name,
        description: plan.description,
        scope: plan.scope,
        artifacts: componentBuilds.flatMap(b => b.artifacts),
      };

      // Save combined manifest
      const combinedBase = slugify(plan.name);
      writeFileSync(join(runDir, `${combinedBase}.xml`), generateUpdateSetXML(combinedBuild), 'utf-8');
      writeFileSync(join(runDir, `${combinedBase}.manifest.json`), JSON.stringify(combinedBuild, null, 2), 'utf-8');

      console.log();
      console.log(chalk.green(`  ✔ ${combinedBuild.artifacts.length} total artifacts combined`));
      console.log(chalk.dim(`  Saved: ${join(runDir, combinedBase + '.xml')}`));

      // ── Phase 3: Push to source env ───────────────────────────────────────
      printPhase(3, TOTAL_PHASES, `Pushing to ${sourceInstance.alias}`);

      const sourceClient = new ServiceNowClient(sourceInstance);
      const pushSpinner = ora(`  Pushing ${combinedBuild.artifacts.length} artifacts to ${sourceInstance.alias}...`).start();

      let pushSummary: Awaited<ReturnType<typeof pushArtifacts>>;
      try {
        pushSummary = await pushArtifacts(sourceClient, combinedBuild);
        pushSpinner.stop();
      } catch (err) {
        pushSpinner.fail(chalk.red('Push failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const permErrors = pushSummary.errors.filter(e => e.permissionDenied);
      const realErrors  = pushSummary.errors.filter(e => !e.permissionDenied);

      for (const r of pushSummary.results) {
        const action = r.action === 'created' ? chalk.green('created') : chalk.yellow('updated');
        console.log(`  ${action}  ${r.type.padEnd(18)} ${r.name}`);
      }
      for (const e of permErrors) {
        console.log(`  ${chalk.yellow('skipped')}  ${e.type.padEnd(18)} ${e.name}  ${chalk.dim('(requires elevated permissions)')}`);
      }
      for (const e of realErrors) {
        console.log(`  ${chalk.red('error')}    ${e.type.padEnd(18)} ${e.name}  ${chalk.red(e.error)}`);
      }

      const summaryParts: string[] = [];
      if (pushSummary.results.length) summaryParts.push(`${pushSummary.results.length} pushed`);
      if (permErrors.length)          summaryParts.push(chalk.yellow(`${permErrors.length} require XML import`));
      if (realErrors.length)          summaryParts.push(chalk.red(`${realErrors.length} failed`));
      console.log(chalk.dim(`\n  ${summaryParts.join(', ')}`));

      if (permErrors.length > 0) {
        console.log();
        console.log(chalk.yellow('  Some artifacts need admin/developer roles to push via Table API.'));
        console.log(chalk.dim('  Import them using the generated update set XML:'));
        console.log(chalk.dim(`    ${join(runDir, combinedBase + '.xml')}`));
        console.log(chalk.dim('    In ServiceNow: System Update Sets → Retrieved Update Sets → Import XML → Load → Preview → Commit'));
      }

      // ── Phase 4: ATF test generation (optional) ───────────────────────────
      let phaseNum = 4;

      if (!opts.skipTests) {
        printPhase(phaseNum++, TOTAL_PHASES, 'Generating ATF tests');

        const stepConfigSysId = await getServerScriptStepConfig(sourceClient);

        if (!stepConfigSysId) {
          console.log(chalk.yellow('  Could not find "Run server side script" ATF step config — skipping test generation.'));
          console.log(chalk.dim('  This may mean ATF is not enabled on this instance, or the user lacks access.'));
        } else {
          const atfSpinner = ora('  Generating ATF tests...').start();
          let atfSuite: Awaited<ReturnType<typeof generateATFTests>>;
          try {
            atfSuite = await generateATFTests(provider, combinedBuild);
            atfSpinner.stop();
          } catch (err) {
            atfSpinner.fail(chalk.yellow('ATF generation failed (non-fatal)'));
            console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
            atfSuite = null as never;
          }

          if (atfSuite) {
            console.log(`  ${chalk.bold(atfSuite.name)}`);
            console.log(`  ${chalk.dim(atfSuite.tests.length + ' tests generated')}`);
            for (const t of atfSuite.tests) {
              console.log(`    ${chalk.dim('•')} ${t.name}  ${chalk.dim('(' + t.steps.length + ' steps)')}`);
            }

            const pushAtfSpinner = ora('  Pushing ATF tests to instance...').start();
            let atfResult: Awaited<ReturnType<typeof pushATFSuite>>;
            try {
              atfResult = await pushATFSuite(sourceClient, atfSuite, stepConfigSysId);
              pushAtfSpinner.stop();
              checkpoint.atfSuiteSysId = atfResult.suiteSysId;
              saveCheckpoint(checkpoint);
              console.log(chalk.green(`  ✓ Test suite created`));
              console.log(chalk.dim(`    ${atfResult.suiteUrl}`));
            } catch (err) {
              pushAtfSpinner.fail(chalk.yellow('ATF push failed (non-fatal)'));
              console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
              atfResult = null as never;
            }

            if ((opts.runTests || opts.optimize) && atfResult) {
              const runSpinner = ora('  Running ATF tests...').start();
              try {
                const runResult = await runATFSuite(sourceClient, atfResult.suiteSysId);
                runSpinner.stop();
                const passColor = runResult.failed === 0 ? chalk.green : chalk.red;
                console.log(`  ${passColor(`${runResult.passed}/${runResult.total} tests passed`)}`);
                for (const t of runResult.testResults) {
                  const icon = t.status === 'success' ? chalk.green('✓') : chalk.red('✗');
                  const msg = t.message ? chalk.dim(`  (${t.message})`) : '';
                  console.log(`    ${icon} ${t.name}${msg}`);
                }

                if (opts.optimize && runResult.failed > 0) {
                  combinedBuild = await runOptimizationLoop({
                    provider,
                    client: sourceClient,
                    build: combinedBuild,
                    atfSuiteSysId: atfResult.suiteSysId,
                    initialRunResult: runResult,
                    maxRetries: parseInt(opts.maxRetries ?? '3', 10),
                    runDir,
                  });
                }
              } catch (err) {
                runSpinner.fail(chalk.yellow('ATF run failed (non-fatal)'));
                console.error(chalk.dim(`  ${err instanceof Error ? err.message : String(err)}`));
              }
            }
          }
        }
      }

      // ── Phase 5+: Promote to additional envs ─────────────────────────────
      const combinedXML = readFileSync(join(runDir, `${combinedBase}.xml`), 'utf-8');

      for (const targetAlias of targetEnvAliases) {
        const promoState = checkpoint.promotions.find(p => p.env === targetAlias)!;
        if (promoState?.status === 'done') {
          console.log(chalk.dim(`  Already promoted to ${targetAlias} (checkpoint)`));
          continue;
        }

        printPhase(phaseNum++, TOTAL_PHASES, `Promoting to ${targetAlias}`);

        const targetInstance = config.instances[targetAlias];
        const targetClient = new ServiceNowClient(targetInstance);

        // Diff against target before promoting
        const diffSpinner = ora(`  Checking existing state on ${targetAlias}...`).start();
        let priorArtifactCount = 0;
        try {
          for (const art of combinedBuild.artifacts.slice(0, 3)) {
            // Quick existence check — just counts how many artifacts already exist
            const { ARTIFACT_TABLE } = await import('../lib/sn-context.js');
            const table = ARTIFACT_TABLE[art.type];
            if (!table) continue;
            const name = String(art.fields['name'] ?? '');
            if (!name) continue;
            const existing = await targetClient.queryTable(table, {
              sysparmQuery: `name=${name}`,
              sysparmLimit: 1,
              sysparmFields: 'sys_id',
            });
            if (existing.length > 0) priorArtifactCount++;
          }
          diffSpinner.stop();
          if (priorArtifactCount > 0) {
            console.log(chalk.yellow(`  ${priorArtifactCount}+ of the first 3 artifacts already exist on ${targetAlias} — promotion will update them`));
          } else {
            console.log(chalk.dim(`  No pre-existing artifacts detected on ${targetAlias}`));
          }
        } catch {
          diffSpinner.stop();
        }

        const shouldPromote = await confirm({
          message: `Apply update set XML to ${chalk.cyan(targetAlias)} (${targetInstance.url})?`,
          default: true,
        });

        if (!shouldPromote) {
          console.log(chalk.dim(`  Skipped promotion to ${targetAlias}.`));
          continue;
        }

        const applySpinner = ora(`  Applying to ${targetAlias}...`).start();
        try {
          const remoteSetSysId = await applyXMLToInstance(targetClient, combinedXML, plan.name);
          applySpinner.stop();
          promoState.status = 'done';
          saveCheckpoint(checkpoint);
          const url = `${targetInstance.url.replace(/\/$/, '')}/nav_to.do?uri=sys_remote_update_set.do?sys_id=${remoteSetSysId}`;
          console.log(chalk.green(`  ✓ Uploaded to ${targetAlias}`));
          console.log(chalk.dim(`    ${url}`));
          console.log(chalk.dim('    Next: Load → Preview → Commit in ServiceNow UI'));
        } catch (err) {
          applySpinner.fail(chalk.red(`  Failed to apply to ${targetAlias}`));
          console.error(chalk.red(`  ${err instanceof Error ? err.message : String(err)}`));
          promoState.status = 'failed';
          promoState.error = err instanceof Error ? err.message : String(err);
          saveCheckpoint(checkpoint);
        }
      }

      // ── Final report ──────────────────────────────────────────────────────
      console.log();
      printDivider();
      console.log(`  ${chalk.bold.green('Factory complete:  ' + plan.name)}`);
      printDivider();

      const built = checkpoint.components.filter(c => c.status === 'done').length;
      const total = checkpoint.components.length;
      console.log(`  ${chalk.dim('Components built:')} ${chalk.white(`${built}/${total}`)}`);
      console.log(`  ${chalk.dim('Total artifacts:')}  ${chalk.white(String(combinedBuild.artifacts.length))}`);
      console.log(`  ${chalk.dim('Pushed to:')}        ${chalk.cyan(sourceInstance.alias)}`);

      if (checkpoint.atfSuiteSysId) {
        console.log(`  ${chalk.dim('ATF suite:')}        ${chalk.cyan(checkpoint.atfSuiteSysId)}`);
      }

      const promoted = checkpoint.promotions.filter(p => p.status === 'done');
      if (promoted.length > 0) {
        console.log(`  ${chalk.dim('Promoted to:')}      ${promoted.map(p => chalk.cyan(p.env)).join(', ')}`);
      }

      console.log(`  ${chalk.dim('Run ID:')}           ${chalk.dim(runId)}`);
      console.log(`  ${chalk.dim('Output dir:')}       ${chalk.dim(runDir)}`);
      console.log();
      console.log(chalk.dim(`  To push manually later:`));
      console.log(chalk.dim(`    snow ai push ${join(runDir, combinedBase + '.manifest.json')}`));
      console.log();
      printDivider();
      console.log();
    });

  return cmd;
}
