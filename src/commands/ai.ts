import { Command } from 'commander';
import * as readline from 'readline';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { getActiveProvider, getActiveInstance } from '../lib/config.js';
import { buildProvider, extractJSON, type LLMMessage } from '../lib/llm.js';
import { SN_SYSTEM_PROMPT } from '../lib/sn-context.js';
import {
  validateBuild,
  generateUpdateSetXML,
  pushArtifacts,
} from '../lib/update-set.js';
import type { SNBuildResponse, SNArtifact } from '../types/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

let debugMode = false;

function dbg(label: string, value: unknown): void {
  if (!debugMode) return;
  console.error(chalk.dim(`[debug] ${label}`));
  if (typeof value === 'string') {
    console.error(chalk.dim(value));
  } else {
    console.error(chalk.dim(JSON.stringify(value, null, 2)));
  }
}

function resolveProvider() {
  const active = getActiveProvider();
  if (!active) {
    console.error(
      chalk.red('No LLM provider configured. Run `snow provider set <name>` first.')
    );
    process.exit(1);
  }
  dbg('active provider', { name: active.name, model: active.config.model });
  return buildProvider(
    active.name,
    active.config.model,
    active.config.apiKey,
    active.config.baseUrl
  );
}

/**
 * Normalise an LLM artifact response that may use flat fields instead of
 * the expected { type, fields: { ... } } shape.
 */
function normaliseBuildResponse(parsed: Record<string, unknown>): SNBuildResponse {
  const name = String(parsed['name'] ?? '');
  const description = String(parsed['description'] ?? '');

  if (!name) throw new Error('Response missing "name" field');

  const rawArtifacts = parsed['artifacts'];
  if (!Array.isArray(rawArtifacts)) {
    throw new Error('Response missing "artifacts" array');
  }

  const artifacts = rawArtifacts.map((a: unknown, i: number) => {
    if (typeof a !== 'object' || a === null) {
      throw new Error(`Artifact[${i}] is not an object`);
    }
    const art = a as Record<string, unknown>;
    const type = String(art['type'] ?? '');
    if (!type) throw new Error(`Artifact[${i}] missing "type"`);

    let fields: Record<string, unknown>;
    if (art['fields'] && typeof art['fields'] === 'object' && !Array.isArray(art['fields'])) {
      fields = art['fields'] as Record<string, unknown>;
    } else {
      const { type: _t, ...rest } = art;
      fields = rest;
    }

    return { type, fields } as SNArtifact;
  });

  // Parse optional scope
  let scope: SNBuildResponse['scope'];
  const rawScope = parsed['scope'];
  if (rawScope && typeof rawScope === 'object' && !Array.isArray(rawScope)) {
    const s = rawScope as Record<string, unknown>;
    const prefix = String(s['prefix'] ?? '');
    if (prefix) {
      scope = {
        prefix,
        name:    String(s['name']    ?? prefix),
        version: String(s['version'] ?? '1.0.0'),
        ...(s['vendor'] ? { vendor: String(s['vendor']) } : {}),
      };
    }
  }

  return { name, description, scope, artifacts };
}

function parseBuildResponse(raw: string): SNBuildResponse {
  const json = extractJSON(raw);
  dbg('extracted JSON', json);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  return normaliseBuildResponse(parsed);
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Compute the artifact diff between two builds for display. */
function diffBuilds(
  previous: SNBuildResponse | null,
  next: SNBuildResponse
): { added: SNArtifact[]; updated: SNArtifact[]; removed: SNArtifact[] } {
  if (!previous) {
    return { added: next.artifacts, updated: [], removed: [] };
  }

  const prevByKey = new Map(
    previous.artifacts.map((a) => [`${a.type}:${String(a.fields['name'] ?? '')}`, a])
  );
  const nextByKey = new Map(
    next.artifacts.map((a) => [`${a.type}:${String(a.fields['name'] ?? '')}`, a])
  );

  const added: SNArtifact[] = [];
  const updated: SNArtifact[] = [];
  const removed: SNArtifact[] = [];

  for (const [key, artifact] of nextByKey) {
    if (!prevByKey.has(key)) {
      added.push(artifact);
    } else {
      const prev = prevByKey.get(key)!;
      if (JSON.stringify(prev.fields) !== JSON.stringify(artifact.fields)) {
        updated.push(artifact);
      }
    }
  }
  for (const [key, artifact] of prevByKey) {
    if (!nextByKey.has(key)) removed.push(artifact);
  }

  return { added, updated, removed };
}

function printBuildSummary(
  build: SNBuildResponse,
  previous: SNBuildResponse | null = null
): void {
  console.log();
  if (previous && previous.name !== build.name) {
    console.log(`${chalk.bold(build.name)} ${chalk.dim(`(was: ${previous.name})`)}`);
  } else {
    console.log(chalk.bold(build.name));
  }
  if (build.description) console.log(chalk.dim(build.description));
  if (build.scope) {
    console.log(chalk.dim(`  scope: ${chalk.white(build.scope.prefix)}  v${build.scope.version}`));
  }
  console.log();

  if (previous) {
    const { added, updated, removed } = diffBuilds(previous, build);
    if (added.length === 0 && updated.length === 0 && removed.length === 0) {
      console.log(chalk.dim('  No changes to artifacts.'));
    } else {
      for (const a of added) {
        console.log(`  ${chalk.green('+')} ${chalk.cyan(a.type.padEnd(16))} ${String(a.fields['name'] ?? '')}`);
      }
      for (const a of updated) {
        console.log(`  ${chalk.yellow('~')} ${chalk.cyan(a.type.padEnd(16))} ${String(a.fields['name'] ?? '')}`);
      }
      for (const a of removed) {
        console.log(`  ${chalk.red('-')} ${chalk.cyan(a.type.padEnd(16))} ${String(a.fields['name'] ?? '')}`);
      }
    }
  } else {
    for (const a of build.artifacts) {
      const name = String(a.fields['name'] ?? '(unnamed)');
      console.log(`  ${chalk.green('+')} ${chalk.cyan(a.type.padEnd(16))} ${name}`);
    }
  }
  console.log();
}

/** Save build files into a named directory. Returns the directory path. */
function saveBuild(build: SNBuildResponse, customDir?: string): string {
  const dir = customDir ?? slugify(build.name);
  mkdirSync(dir, { recursive: true });
  const base = slugify(build.name);
  const xmlFile = join(dir, `${base}.xml`);
  const manifestFile = join(dir, `${base}.manifest.json`);
  writeFileSync(xmlFile, generateUpdateSetXML(build), 'utf-8');
  writeFileSync(manifestFile, JSON.stringify(build, null, 2), 'utf-8');
  return dir;
}

function printSaveResult(dir: string, build: SNBuildResponse): void {
  const base = slugify(build.name);
  console.log(chalk.green(`✔ ${dir}/`));
  console.log(chalk.dim(`    ${base}.xml`));
  console.log(chalk.dim(`    ${base}.manifest.json`));
  console.log(chalk.dim('  Import: System Update Sets → Retrieved Update Sets → Import XML'));
}

async function doPush(build: SNBuildResponse, buildDir?: string): Promise<void> {
  const instance = getActiveInstance();
  if (!instance) {
    console.error(chalk.red('No active instance. Run `snow instance add` first.'));
    process.exit(1);
  }
  const { ServiceNowClient } = await import('../lib/client.js');
  const client = new ServiceNowClient(instance);

  console.log(chalk.bold(`Pushing to ${instance.alias} (${instance.url})…`));

  const summary = await pushArtifacts(client, build, (msg) =>
    console.log(chalk.dim(msg))
  );

  const permErrors = summary.errors.filter(e => e.permissionDenied);
  const realErrors  = summary.errors.filter(e => !e.permissionDenied);

  console.log();
  for (const r of summary.results) {
    const action = r.action === 'created' ? chalk.green('created') : chalk.yellow('updated');
    console.log(`  ${action}  ${r.type.padEnd(18)} ${r.name}  ${chalk.dim(r.sysId)}`);
  }
  for (const e of permErrors) {
    console.log(`  ${chalk.yellow('skipped')}  ${e.type.padEnd(18)} ${e.name}  ${chalk.dim('(requires elevated permissions)')}`);
  }
  for (const e of realErrors) {
    console.log(`  ${chalk.red('error')}    ${e.type.padEnd(18)} ${e.name}  ${chalk.red(e.error)}`);
  }

  const summaryParts: string[] = [];
  if (summary.results.length) summaryParts.push(`${summary.results.length} pushed`);
  if (permErrors.length)      summaryParts.push(chalk.yellow(`${permErrors.length} require XML import`));
  if (realErrors.length)      summaryParts.push(chalk.red(`${realErrors.length} failed`));
  console.log(chalk.dim(`\n${summaryParts.join(', ')}`));

  if (permErrors.length > 0) {
    const xmlPath = buildDir ? join(buildDir, `${slugify(build.name)}.xml`) : null;
    console.log();
    console.log(chalk.yellow('  Some artifacts need admin/developer roles to push via Table API.'));
    if (xmlPath) {
      console.log(chalk.dim(`  Import this file in ServiceNow:`));
      console.log(chalk.white(`    ${xmlPath}`));
    }
    console.log(chalk.dim('  In ServiceNow: System Update Sets → Retrieved Update Sets → Import XML → Load → Preview → Commit'));
  }
}

/**
 * Prompt the user whether to push to the active instance.
 * If autoPush is true the confirmation is skipped and the push proceeds immediately.
 */
async function confirmPush(build: SNBuildResponse, dir: string, autoPush?: boolean): Promise<void> {
  const instance = getActiveInstance();
  if (!instance) {
    console.log(chalk.dim(`  Run \`snow ai push ${dir}/\` to deploy later.`));
    return;
  }

  let shouldPush = autoPush ?? false;

  if (!shouldPush) {
    console.log();
    const { confirm } = await import('@inquirer/prompts');
    shouldPush = await confirm({
      message: `Push ${build.artifacts.length} artifact(s) to ${chalk.cyan(instance.alias)} (${instance.url})?`,
      default: false,
    });
  }

  if (shouldPush) {
    console.log();
    await doPush(build, dir);
  } else {
    console.log(chalk.dim(`  Run \`snow ai push ${dir}/\` to deploy later.`));
  }
}

// ─── Review helpers ──────────────────────────────────────────────────────────

/** Code fields (and their file extension) for each artifact type. */
const CODE_FIELDS: Record<string, { field: string; ext: string; label: string }[]> = {
  script_include: [{ field: 'script',     ext: '.js',   label: 'Script' }],
  business_rule:  [{ field: 'script',     ext: '.js',   label: 'Script' }],
  client_script:  [{ field: 'script',     ext: '.js',   label: 'Script' }],
  ui_action:      [{ field: 'script',     ext: '.js',   label: 'Server Script' },
                   { field: 'onclick',    ext: '.js',   label: 'Client onclick' }],
  ui_page:        [{ field: 'html',              ext: '.html', label: 'HTML' },
                   { field: 'client_script',    ext: '.js',   label: 'Client Script' },
                   { field: 'processing_script', ext: '.js',  label: 'Processing Script' }],
  scheduled_job:  [{ field: 'script',     ext: '.js',   label: 'Script' }],
  flow_action:    [{ field: 'script',     ext: '.js',   label: 'Action Script' }],
  // table and decision_table have no inline code fields — schema is reviewed via the manifest
};

function resolveEditor(): string {
  if (process.env['VISUAL']) return process.env['VISUAL'];
  if (process.env['EDITOR']) return process.env['EDITOR'];
  const isWin = process.platform === 'win32';
  const lookup = isWin ? 'where' : 'which';
  const candidates = isWin
    ? ['code', 'notepad++', 'notepad']
    : ['code', 'nvim', 'vim', 'nano', 'vi'];
  for (const e of candidates) {
    if (spawnSync(lookup, [e], { encoding: 'utf-8', shell: isWin }).status === 0) return e;
  }
  return isWin ? 'notepad' : 'vi';
}

function resolveManifestPath(path: string): string {
  if (path.endsWith('.manifest.json') && existsSync(path)) return path;
  if (path.endsWith('.xml')) {
    const m = path.replace(/\.xml$/, '.manifest.json');
    if (existsSync(m)) return m;
  }
  if (existsSync(path) && !path.includes('.')) {
    const files = readdirSync(path).filter((f) => f.endsWith('.manifest.json'));
    if (files.length > 0) return join(path, files[0]);
  }
  console.error(chalk.red(`Cannot resolve build manifest from: ${path}`));
  console.error(chalk.dim('Pass a build directory, a .xml file, or a .manifest.json file.'));
  process.exit(1);
}

function printCodeBlock(code: string, label: string): void {
  const lines = code.split('\n');
  const width = Math.min(process.stdout.columns ?? 100, 100);
  console.log(chalk.dim('─'.repeat(width) + ` ${label}`));
  lines.forEach((line, i) => {
    const num = chalk.dim(String(i + 1).padStart(4) + '  ');
    console.log(num + line);
  });
  console.log(chalk.dim('─'.repeat(width)));
}

/**
 * Interactive review loop for a build.
 * Returns the (potentially modified) build.
 */
async function runReview(build: SNBuildResponse, buildDir: string): Promise<SNBuildResponse> {
  const { select, confirm } = await import('@inquirer/prompts');
  const editor = resolveEditor();
  let modified = false;

  console.log();
  console.log(chalk.bold(`Reviewing: ${build.name}`));
  console.log(chalk.dim(`${build.artifacts.length} artifact(s)  •  editor: ${editor}`));
  console.log();

  while (true) {
    // Build artifact selector choices
    const artifactChoices = build.artifacts.map((a, i) => {
      const name = String(a.fields['name'] ?? `(${a.type})`);
      const hasCode = (CODE_FIELDS[a.type] ?? []).some((f) => {
        const v = a.fields[f.field];
        return v !== undefined && v !== null && String(v).trim() !== '';
      });
      return {
        name: `${chalk.cyan(a.type.padEnd(16))} ${name}${hasCode ? '' : chalk.dim(' (no code)')}`,
        value: i,
      };
    });
    artifactChoices.push({ name: chalk.dim('── Done reviewing ──'), value: -1 });

    const selectedIndex: number = await select({
      message: 'Select an artifact to review:',
      choices: artifactChoices,
    });

    if (selectedIndex === -1) break;

    const artifact = build.artifacts[selectedIndex];
    const artifactName = String(artifact.fields['name'] ?? artifact.type);
    const codeFields = (CODE_FIELDS[artifact.type] ?? []).filter(
      (f) => artifact.fields[f.field] !== undefined
    );

    if (codeFields.length === 0) {
      console.log(chalk.yellow('  No editable code fields for this artifact type.'));
      continue;
    }

    // If multiple code fields, let user pick which one
    let fieldDef = codeFields[0];
    if (codeFields.length > 1) {
      const fieldIndex: number = await select({
        message: `Which field of "${artifactName}" to review?`,
        choices: codeFields.map((f, i) => ({ name: f.label, value: i })),
      });
      fieldDef = codeFields[fieldIndex];
    }

    const currentCode = String(artifact.fields[fieldDef.field] ?? '');
    console.log();
    printCodeBlock(currentCode, `${artifactName} — ${fieldDef.label}`);
    console.log();

    const shouldEdit = await confirm({ message: 'Open in editor to edit?', default: false });

    if (shouldEdit) {
      // Write to a temp file with the right extension
      const tmpFile = join(tmpdir(), `snow-review-${Date.now()}${fieldDef.ext}`);
      writeFileSync(tmpFile, currentCode, 'utf-8');

      const isWin = process.platform === 'win32';
      spawnSync(editor, [tmpFile], { stdio: 'inherit', shell: isWin });

      const updatedCode = readFileSync(tmpFile, 'utf-8');

      if (updatedCode !== currentCode) {
        build.artifacts[selectedIndex].fields[fieldDef.field] = updatedCode;
        modified = true;

        // Persist changes immediately
        const base = slugify(build.name);
        const xmlFile = join(buildDir, `${base}.xml`);
        const manifestFile = join(buildDir, `${base}.manifest.json`);
        writeFileSync(xmlFile, generateUpdateSetXML(build), 'utf-8');
        writeFileSync(manifestFile, JSON.stringify(build, null, 2), 'utf-8');
        console.log(chalk.green(`  ✔ Saved changes to ${basename(manifestFile)}`));
      } else {
        console.log(chalk.dim('  No changes made.'));
      }
    }

    console.log();
  }

  if (modified) {
    console.log(chalk.green('✔ Build updated with your edits.'));
  }

  return build;
}

// ─── Commands ─────────────────────────────────────────────────────────────────

export function aiCommand(): Command {
  const cmd = new Command('ai').description(
    'Generate ServiceNow applications using an LLM and export as an update set'
  );

  // snow ai build "<prompt>"
  cmd
    .command('build <prompt>')
    .description('Generate a ServiceNow application from a text description')
    .option('-o, --output <dir>', 'Output directory (default: slugified update set name)')
    .option('--push', 'Push artifacts directly to the active instance after generating')
    .option('--provider <name>', 'Override the active provider for this request')
    .option('--debug', 'Print raw LLM request/response and full error stack traces')
    .action(
      async (
        prompt: string,
        opts: { output?: string; push?: boolean; provider?: string; debug?: boolean }
      ) => {
        if (opts.debug) debugMode = true;

        let provider = resolveProvider();

        if (opts.provider) {
          const { getAIConfig } = await import('../lib/config.js');
          const ai = getAIConfig();
          const pc = ai.providers[opts.provider as keyof typeof ai.providers];
          if (!pc) {
            console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
            process.exit(1);
          }
          provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
        }

        dbg('prompt', prompt);

        // Conversation history — allows the LLM to ask clarifying questions
        // before generating. The build command loops until it receives JSON.
        const history: LLMMessage[] = [
          { role: 'system', content: SN_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ];

        // Use @inquirer/prompts for cross-platform input (works in MINGW64/Git Bash)
        const { input: promptInput } = await import('@inquirer/prompts');

        let build: SNBuildResponse | null = null;

        while (!build) {
          const spinner = ora(`Generating with ${provider.providerName}…`).start();

          let raw: string;
          try {
            raw = await provider.complete(history);
            spinner.stop();
            dbg('raw LLM response', raw);
          } catch (err) {
            spinner.fail(chalk.red('LLM request failed'));
            console.error(chalk.red(opts.debug && err instanceof Error ? (err.stack ?? err.message) : err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }

          history.push({ role: 'assistant', content: raw });

          // Try to parse as a build response
          let parsed: SNBuildResponse | null = null;
          try {
            parsed = parseBuildResponse(raw);
            dbg('parsed build', parsed);
          } catch {
            // Not JSON — treat as a clarifying question or conversational response
          }

          if (parsed) {
            build = parsed;
          } else {
            // Print the AI's message and prompt for a response
            console.log();
            const lines = raw.trim().split('\n');
            console.log(chalk.magenta('AI > ') + lines[0]);
            for (let i = 1; i < lines.length; i++) {
              console.log('     ' + lines[i]);
            }
            console.log();

            let answer = '';
            while (!answer.trim()) {
              answer = await promptInput({ message: chalk.cyan('You') });
            }
            history.push({ role: 'user', content: answer.trim() });
          }
        }

        const validationErrors = validateBuild(build);
        if (validationErrors.length > 0) {
          console.warn(chalk.yellow('Warning: some artifacts are missing required fields:'));
          for (const e of validationErrors) {
            console.warn(chalk.yellow(`  [${e.artifactIndex}] ${e.type} "${e.name}" — missing: ${e.missing.join(', ')}`));
          }
          console.log();
        }

        printBuildSummary(build);
        const dir = saveBuild(build, opts.output);
        printSaveResult(dir, build);

        // Offer to review / edit artifacts before pushing
        const { confirm: confirmReview } = await import('@inquirer/prompts');
        const wantReview = await confirmReview({
          message: 'Review generated artifacts before pushing?',
          default: false,
        });
        if (wantReview) {
          build = await runReview(build, dir);
        }

        await confirmPush(build, dir, opts.push);
      }
    );

  // snow ai push <dir or file>
  cmd
    .command('push <path>')
    .description('Push a previously generated build to the active instance via Table API')
    .action(async (path: string) => {
      // Accept: directory, .xml file (looks for sibling .manifest.json), or .manifest.json
      let manifestPath: string;

      if (path.endsWith('.manifest.json') && existsSync(path)) {
        manifestPath = path;
      } else if (path.endsWith('.xml') && existsSync(path.replace(/\.xml$/, '.manifest.json'))) {
        manifestPath = path.replace(/\.xml$/, '.manifest.json');
      } else if (!path.includes('.') && existsSync(path)) {
        // Treat as directory — find the manifest inside
        const files = (await import('fs')).readdirSync(path).filter((f: string) => f.endsWith('.manifest.json'));
        if (files.length === 0) {
          console.error(chalk.red(`No .manifest.json found in directory: ${path}`));
          process.exit(1);
        }
        manifestPath = join(path, files[0]);
      } else {
        console.error(chalk.red(`Cannot resolve build from: ${path}`));
        console.error(chalk.dim('Pass a build directory, a .xml file, or a .manifest.json file.'));
        process.exit(1);
      }

      const build = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SNBuildResponse;
      await doPush(build, dirname(manifestPath));
    });

  // snow ai chat — interactive multi-turn build session
  cmd
    .command('chat')
    .description('Interactively build a ServiceNow application through conversation with an LLM')
    .option('-o, --output <dir>', 'Directory to auto-save builds (default: slugified name)')
    .option('--push', 'Auto-push to the active instance when a build is generated')
    .option('--debug', 'Print raw LLM responses and full error stack traces')
    .action(async (opts: { output?: string; push?: boolean; debug?: boolean }) => {
      if (opts.debug) debugMode = true;
      const provider = resolveProvider();

      const history: LLMMessage[] = [
        { role: 'system', content: SN_SYSTEM_PROMPT },
      ];

      const BANNER = `
${chalk.bold.cyan('Snow AI — ServiceNow App Builder')}
${chalk.dim(`Provider: ${chalk.white(provider.providerName)}`)}
${chalk.dim('Describe what you want to build. The AI may ask clarifying questions before generating.')}
${chalk.dim('Slash commands:')}
  ${chalk.dim('/status    show current build')}
  ${chalk.dim('/save      write XML + manifest to disk')}
  ${chalk.dim('/push      push current build to active instance')}
  ${chalk.dim('/clear     reset the session')}
  ${chalk.dim('/exit      quit')}
`;
      console.log(BANNER);

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        prompt: chalk.cyan('You > '),
        terminal: true,
      });

      let lastBuild: SNBuildResponse | null = null;
      let buildDir: string | null = null;

      rl.prompt();

      rl.on('line', async (line: string) => {
        const input = line.trim();
        if (!input) { rl.prompt(); return; }

        // ── Slash commands ──────────────────────────────────────────────────

        if (input === '/exit' || input === '/quit') {
          console.log(chalk.dim('Bye.'));
          rl.close();
          return;
        }

        if (input === '/clear') {
          history.splice(1);
          lastBuild = null;
          buildDir = null;
          console.log(chalk.dim('Session cleared.'));
          rl.prompt();
          return;
        }

        if (input === '/status') {
          if (!lastBuild) {
            console.log(chalk.dim('No build yet. Describe what you want to build.'));
          } else {
            printBuildSummary(lastBuild);
            if (buildDir) console.log(chalk.dim(`Saved to: ${buildDir}/`));
          }
          rl.prompt();
          return;
        }

        if (input === '/save') {
          if (!lastBuild) {
            console.log(chalk.yellow('Nothing generated yet.'));
            rl.prompt();
            return;
          }
          const dir = saveBuild(lastBuild, opts.output);
          buildDir = dir;
          printSaveResult(dir, lastBuild);
          rl.prompt();
          return;
        }

        if (input === '/push') {
          if (!lastBuild) {
            console.log(chalk.yellow('Nothing generated yet.'));
            rl.prompt();
            return;
          }
          rl.pause();
          await doPush(lastBuild, buildDir ?? undefined);
          rl.resume();
          rl.prompt();
          return;
        }

        // ── Send to LLM ─────────────────────────────────────────────────────

        rl.pause();
        history.push({ role: 'user', content: input });

        const spinner = ora({ text: chalk.dim('Thinking…'), spinner: 'dots', color: 'cyan' }).start();

        let raw: string;
        try {
          raw = await provider.complete(history);
          spinner.stop();
          dbg('raw LLM response', raw);
        } catch (err) {
          spinner.stop();
          console.error(chalk.red(opts.debug && err instanceof Error ? (err.stack ?? err.message) : `Error: ${err instanceof Error ? err.message : String(err)}`));
          history.pop();
          rl.resume();
          rl.prompt();
          return;
        }

        history.push({ role: 'assistant', content: raw });

        // Try to parse as a build response (JSON)
        let parsedBuild: SNBuildResponse | null = null;
        try {
          parsedBuild = parseBuildResponse(raw);
          dbg('parsed build', parsedBuild);
        } catch (err) {
          if (opts.debug) {
            console.error(chalk.dim(`[debug] not a build response: ${err instanceof Error ? err.message : String(err)}`));
          }
        }

        if (parsedBuild) {
          // ── Build response — show diff, save, optionally push ──────────────
          const previous = lastBuild;
          lastBuild = parsedBuild;

          printBuildSummary(parsedBuild, previous);

          const validationErrors = validateBuild(parsedBuild);
          if (validationErrors.length > 0) {
            console.warn(chalk.yellow('Warning: some artifacts are missing required fields:'));
            for (const e of validationErrors) {
              console.warn(chalk.yellow(`  [${e.artifactIndex}] ${e.type} "${e.name}" — missing: ${e.missing.join(', ')}`));
            }
            console.log();
          }

          // Auto-save to directory
          const dir = saveBuild(parsedBuild, opts.output ?? buildDir ?? undefined);
          buildDir = dir;
          printSaveResult(dir, parsedBuild);

          await confirmPush(parsedBuild, dir, opts.push);
          console.log(chalk.dim(`  /push to redeploy  |  /save to re-save  |  /status for summary`));
          console.log();
        } else {
          // ── Conversational response — print as-is ────────────────────────
          console.log();
          const lines = raw.trim().split('\n');
          const prefix = chalk.magenta('AI > ');
          console.log(prefix + lines[0]);
          for (let i = 1; i < lines.length; i++) {
            console.log('     ' + lines[i]);
          }
          console.log();
        }

        rl.resume();
        rl.prompt();
      });

      rl.on('close', () => process.exit(0));
      process.on('SIGINT', () => {
        console.log(chalk.dim('\nBye.'));
        process.exit(0);
      });
    });

  // snow ai review <path>
  cmd
    .command('review <path>')
    .description('Review and edit generated artifacts, then optionally push to the active instance')
    .action(async (path: string) => {
      const manifestPath = resolveManifestPath(path);
      const buildDir = dirname(manifestPath);
      let build = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SNBuildResponse;

      build = await runReview(build, buildDir);
      console.log();
      await confirmPush(build, buildDir);
    });

  // snow ai test <path> — generate ATF tests for a build
  cmd
    .command('test <path>')
    .description('Generate ATF tests for a build and push them to the active instance')
    .option('--run', 'Execute the test suite immediately after pushing')
    .option('--suite-name <name>', 'Override the generated suite name')
    .action(async (path: string, opts: { run?: boolean; suiteName?: string }) => {
      const manifestPath = resolveManifestPath(path);
      const build = JSON.parse(readFileSync(manifestPath, 'utf-8')) as SNBuildResponse;

      const instance = getActiveInstance();
      if (!instance) {
        console.error(chalk.red('No active instance. Run `snow instance add` first.'));
        process.exit(1);
      }

      const { ServiceNowClient } = await import('../lib/client.js');
      const client = new ServiceNowClient(instance);

      // Verify ATF step config availability
      const { getServerScriptStepConfig, generateATFTests, pushATFSuite, runATFSuite } = await import('../lib/atf.js');
      const stepConfigSpinner = ora('Checking ATF step config...').start();
      const stepConfigSysId = await getServerScriptStepConfig(client);
      stepConfigSpinner.stop();

      if (!stepConfigSysId) {
        console.error(chalk.red('Could not find "Run server side script" ATF step config.'));
        console.error(chalk.dim('ATF may not be enabled on this instance, or the user lacks sys_atf_step_config access.'));
        process.exit(1);
      }

      // Generate tests
      const provider = resolveProvider();
      const genSpinner = ora(`Generating ATF tests with ${provider.providerName}...`).start();
      let suite: Awaited<ReturnType<typeof generateATFTests>>;
      try {
        suite = await generateATFTests(provider, build);
        genSpinner.stop();
      } catch (err) {
        genSpinner.fail(chalk.red('Test generation failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (opts.suiteName) suite.name = opts.suiteName;

      // Display generated suite
      console.log();
      console.log(chalk.bold(suite.name));
      if (suite.description) console.log(chalk.dim(suite.description));
      console.log();
      for (const t of suite.tests) {
        console.log(`  ${chalk.green('+')} ${t.name}  ${chalk.dim('(' + t.steps.length + ' steps)')}`);
        console.log(`     ${chalk.dim(t.short_description)}`);
      }
      console.log();

      // Push to instance
      const pushSpinner = ora(`Pushing ${suite.tests.length} tests to ${instance.alias}...`).start();
      let pushResult: Awaited<ReturnType<typeof pushATFSuite>>;
      try {
        pushResult = await pushATFSuite(client, suite, stepConfigSysId);
        pushSpinner.stop();
      } catch (err) {
        pushSpinner.fail(chalk.red('Failed to push ATF tests'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log(chalk.green(`✔ Test suite created`));
      console.log(`  ${chalk.dim('Suite sys_id:')} ${pushResult.suiteSysId}`);
      console.log(`  ${chalk.dim('Tests:')} ${pushResult.testCount}  ${chalk.dim('Steps:')} ${pushResult.stepCount}`);
      console.log(`  ${chalk.dim(pushResult.suiteUrl)}`);

      // Optionally run
      if (opts.run) {
        console.log();
        const runSpinner = ora('Running test suite...').start();
        try {
          const runResult = await runATFSuite(client, pushResult.suiteSysId);
          runSpinner.stop();
          const passColor = runResult.failed === 0 ? chalk.green : chalk.red;
          console.log(passColor(`${runResult.passed}/${runResult.total} tests passed  (${runResult.status})`));
          for (const t of runResult.testResults) {
            const icon = t.status === 'success' ? chalk.green('✓') : chalk.red('✗');
            const msg = t.message ? chalk.dim(`  ${t.message}`) : '';
            console.log(`  ${icon} ${t.name}${msg}`);
          }
        } catch (err) {
          runSpinner.fail(chalk.red('Test run failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
      }
    });

  // snow ai explain <table> [sys_id]
  cmd
    .command('explain <table> [sys_id]')
    .description('Ask the active LLM to explain a table structure or a specific record in plain English')
    .option('--provider <name>', 'Override the active provider for this request')
    .option('--save <file>', 'Save the explanation to a Markdown file')
    .addHelpText(
      'after',
      `
Examples:
  snow ai explain incident
  snow ai explain sys_script_include <sys_id>
  snow ai explain x_myco_myapp_request
  snow ai explain sys_script_include <sys_id> --save ./explanation.md
`
    )
    .action(
      async (
        table: string,
        sysId: string | undefined,
        opts: { provider?: string; save?: string }
      ) => {
        const instance = getActiveInstance();
        if (!instance) {
          console.error(chalk.red('No active instance. Run `snow instance add` first.'));
          process.exit(1);
        }

        let provider = resolveProvider();
        if (opts.provider) {
          const { getAIConfig } = await import('../lib/config.js');
          const ai = getAIConfig();
          const pc = ai.providers[opts.provider as keyof typeof ai.providers];
          if (!pc) {
            console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
            process.exit(1);
          }
          provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
        }

        const { ServiceNowClient } = await import('../lib/client.js');
        const client = new ServiceNowClient(instance);

        const spinner = ora('Fetching data from instance…').start();

        let context: string;
        try {
          if (!sysId) {
            // Explain a whole table — fetch metadata + field list
            const [tableInfoRaw, fieldsRaw] = await Promise.all([
              client.queryTable('sys_db_object', {
                sysparmQuery: `name=${table}`,
                sysparmFields: 'name,label,super_class,sys_scope',
                sysparmLimit: 1,
              }),
              client.queryTable('sys_dictionary', {
                sysparmQuery: `name=${table}^element!=NULL^elementISNOTEMPTY`,
                sysparmFields: 'element,column_label,internal_type,max_length,mandatory,reference',
                sysparmLimit: 200,
              }),
            ]);

            const ti = tableInfoRaw[0] as unknown as
              | { name: string; label: string; super_class: string; sys_scope: string }
              | undefined;

            const fields = fieldsRaw as unknown as Array<{
              element: string;
              column_label: string;
              internal_type: string;
              max_length: string;
              mandatory: string;
              reference: string;
            }>;

            const fieldLines = fields
              .map(
                (f) =>
                  `  ${f.element}  (${f.internal_type}${f.reference ? ' → ' + f.reference : ''})` +
                  `  "${f.column_label}"` +
                  (f.mandatory === 'true' ? '  [required]' : '')
              )
              .join('\n');

            context =
              `ServiceNow table: ${table}\n` +
              (ti?.label ? `Label: ${ti.label}\n` : '') +
              (ti?.super_class ? `Extends: ${ti.super_class}\n` : '') +
              (ti?.sys_scope ? `Scope: ${ti.sys_scope}\n` : '') +
              `\nFields (${fields.length}):\n${fieldLines}`;
          } else {
            // Explain a specific record
            const record = await client.getRecord(table, sysId, { sysparmDisplayValue: true });

            // Script field names per table — include full content for these
            const SCRIPT_FIELDS: Record<string, string[]> = {
              sys_script_include: ['script'],
              sys_script: ['script'],
              sys_ui_action: ['script'],
              sys_script_client: ['script'],
              sysauto_script: ['script'],
              sys_ui_page: ['html', 'client_script', 'processing_script'],
            };
            const scriptFields = new Set(SCRIPT_FIELDS[table] ?? []);

            const lines: string[] = [];
            for (const [key, val] of Object.entries(record)) {
              if (key === 'sys_id') continue;
              const strVal = typeof val === 'string' ? val : JSON.stringify(val);
              if (strVal.length > 300 && !scriptFields.has(key)) {
                lines.push(`  ${key}: ${strVal.slice(0, 300)}…`);
              } else {
                lines.push(`  ${key}: ${strVal}`);
              }
            }

            context = `ServiceNow record from table: ${table}\n\n${lines.join('\n')}`;
          }
        } catch (err) {
          spinner.fail(chalk.red('Failed to fetch instance data'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        spinner.text = `Asking ${provider.providerName} to explain…`;

        const systemPrompt = sysId
          ? 'You are a ServiceNow expert. Explain the provided record — its purpose, what it does, how it interacts with the platform, and any noteworthy aspects of the code or configuration. Be concise and technical.'
          : 'You are a ServiceNow expert. Explain the provided table — its business domain, key fields and their meanings, notable relationships to other tables, and typical use cases. Be concise and technical.';

        let explanation: string;
        try {
          explanation = await provider.complete([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: context },
          ]);
          spinner.stop();
        } catch (err) {
          spinner.fail(chalk.red('LLM request failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        const title = `${table}${sysId ? '  /  ' + sysId : ''}`;
        console.log();
        console.log(chalk.bold(title));
        console.log(chalk.dim('─'.repeat(Math.min(title.length + 4, 72))));
        console.log();
        for (const line of explanation.trim().split('\n')) {
          console.log(line);
        }
        console.log();

        if (opts.save) {
          const { writeFileSync } = await import('fs');
          const md =
            `# ${title}\n\n` +
            `_Explained by ${provider.providerName}_\n\n` +
            explanation.trim() +
            '\n';
          writeFileSync(opts.save, md);
          console.log(chalk.green(`Saved to ${opts.save}`));
          console.log();
        }
      }
    );

  // snow ai query "<natural language>"
  cmd
    .command('query <description...>')
    .description('Translate a natural language description into a ServiceNow encoded query string')
    .option('-t, --table <table>', 'Table name — provides field context to improve accuracy')
    .option('--run', 'Execute the generated query against the active instance (requires --table)')
    .option('-l, --limit <n>', 'Max records to return when using --run (default: 20)')
    .option('-f, --fields <fields>', 'Comma-separated fields to return when using --run')
    .option('--json', 'Output raw JSON when using --run')
    .option('--provider <name>', 'Override the active LLM provider')
    .addHelpText(
      'after',
      `
Examples:
  snow ai query open P1 incidents with no assignee
  snow ai query "change requests approved in the last 7 days" --table change_request
  snow ai query users in the Network Support group who are active --table sys_user
  snow ai query GRC issues where risk is high and state is not closed --table sn_grc_issue
  snow ai query active P1 incidents with no assignee --table incident --run -f number,short_description,assigned_to
`
    )
    .action(async (descriptionWords: string[], opts: { table?: string; run?: boolean; limit?: string; fields?: string; json?: boolean; provider?: string }) => {
      const description = descriptionWords.join(' ');
      let provider = resolveProvider();
      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      // Map of reference table → best identifier field for querying by display name
      const refIdentifierField: Record<string, string> = {
        sys_user: 'user_name',
        sys_user_group: 'name',
        core_company: 'name',
        cmn_location: 'name',
        cmn_department: 'name',
        business_unit: 'name',
        cmdb_ci: 'name',
        problem: 'number',
        change_request: 'number',
        incident: 'number',
        sc_request: 'number',
        sc_req_item: 'number',
        sc_task: 'number',
        task: 'number',
        sys_choice: 'label',
      };

      let fieldContext = '';
      if (opts.table) {
        try {
          const instance = getActiveInstance();
          if (instance) {
            const { ServiceNowClient } = await import('../lib/client.js');
            const client = new ServiceNowClient(instance);
            const fields = await client.queryTable('sys_dictionary', {
              sysparmQuery: `name=${opts.table}^element!=NULL^elementISNOTEMPTY`,
              sysparmFields: 'element,column_label,internal_type,reference',
              sysparmLimit: 150,
            }) as unknown as Array<{ element: string; column_label: string; internal_type: string; reference: string }>;
            if (fields.length > 0) {
              fieldContext = `\n\nAvailable fields on ${opts.table}:\n` +
                fields.map((f) => {
                  if (f.internal_type === 'reference' && f.reference) {
                    const idField = refIdentifierField[f.reference] ?? 'name';
                    return `  ${f.element} (reference → ${f.reference}, query as ${f.element}.${idField}=...): "${f.column_label}"`;
                  }
                  return `  ${f.element} (${f.internal_type}): "${f.column_label}"`;
                }).join('\n');
            }
          }
        } catch { /* non-fatal — proceed without field context */ }
      }

      const systemPrompt = `You are a ServiceNow query expert. Convert natural language descriptions into ServiceNow encoded query syntax.

Rules:
- Output ONLY the encoded query string — no explanation, no code block, no prefix
- Use ^ for AND, ^OR for OR
- Common operators: = != > < >= <= STARTSWITH ENDSWITH CONTAINS ISEMPTY ISNOTEMPTY IN NOTIN
- Date macros: javascript:gs.beginningOfToday(), javascript:gs.daysAgo(7), javascript:gs.beginningOfLastWeek()
- CRITICAL — Reference fields: NEVER use field=display_value for reference fields. Always dot-walk to the correct identifier:
    Groups (sys_user_group): assignment_group.name=..., support_group.name=...
    Users (sys_user): assigned_to.user_name=..., opened_by.user_name=...
    Companies/Departments/Locations: company.name=..., department.name=..., location.name=...
    CIs (cmdb_ci): cmdb_ci.name=...
    Records (incidents, changes, etc.): parent.number=INC0001
- If field context is provided, use the "query as field.identifier=..." hint for each reference field
- Boolean fields: use true/false
- State values depend on the table — use numeric values when known (e.g. incident state: 1=New, 2=In Progress, 6=Resolved, 7=Closed)
- Priority: 1=Critical, 2=High, 3=Moderate, 4=Low
- Empty/null checks: fieldISEMPTY or fieldISNOTEMPTY

Examples:
  "active P1 incidents assigned to Openspace" → active=true^priority=1^assignment_group.name=Openspace
  "active incidents assigned to nobody" → active=true^assignment_groupISEMPTY^assigned_toISEMPTY^state!=6^state!=7
  "change requests approved in the last week" → state=3^sys_updated_on>=javascript:gs.daysAgo(7)
  "users in IT department" → department.name=IT^active=true`;

      const userPrompt = `Convert to ServiceNow encoded query: "${description}"` +
        (opts.table ? `\nTable: ${opts.table}` : '') +
        fieldContext;

      const spinner = ora(`Generating query with ${provider.providerName}…`).start();
      let query: string;
      try {
        query = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Strip any accidental markdown/quotes the LLM may have added
      query = query.trim().replace(/^```[^\n]*\n?/, '').replace(/```$/, '').replace(/^["']|["']$/g, '').trim();

      console.log();
      if (opts.table) {
        console.log(chalk.dim(`  Table: ${opts.table}`));
      }
      console.log(chalk.dim(`  Query:`));
      console.log(`  ${chalk.cyan(query)}`);
      console.log();
      if (opts.table && !opts.run) {
        console.log(chalk.dim(`  Usage:`));
        console.log(chalk.dim(`  snow table get ${opts.table} -q "${query}"`));
        console.log();
      }

      if (opts.run) {
        if (!opts.table) {
          console.error(chalk.red('--run requires --table'));
          process.exit(1);
        }
        const instance = getActiveInstance();
        if (!instance) {
          console.error(chalk.red('No active instance. Run: snow instance add'));
          process.exit(1);
        }
        const { ServiceNowClient } = await import('../lib/client.js');
        const client = new ServiceNowClient(instance);
        const limit = parseInt(opts.limit ?? '20', 10);
        const runSpinner = ora(`Querying ${opts.table}…`).start();
        let rows: Record<string, unknown>[];
        try {
          rows = await client.queryTable(opts.table, {
            sysparmQuery: query,
            sysparmLimit: limit,
            ...(opts.fields ? { sysparmFields: opts.fields } : {}),
            sysparmDisplayValue: true,
          }) as Record<string, unknown>[];
          runSpinner.stop();
        } catch (err) {
          runSpinner.fail(chalk.red('Query failed'));
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }

        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }

        if (rows.length === 0) {
          console.log(chalk.dim('  No records found.'));
          console.log();
          return;
        }

        // Flatten reference fields and print a simple table
        const flattenValue = (v: unknown): string => {
          if (v && typeof v === 'object' && 'display_value' in (v as object)) {
            return String((v as { display_value: unknown }).display_value ?? '');
          }
          return v == null ? '' : String(v);
        };

        const keys = opts.fields
          ? opts.fields.split(',').map((s) => s.trim())
          : Object.keys(rows[0]);

        // Column widths
        const widths = keys.map((k) => Math.max(k.length, ...rows.map((r) => flattenValue(r[k]).length)));
        const maxWidth = 40;
        const clampedWidths = widths.map((w) => Math.min(w, maxWidth));

        const pad = (s: string, w: number) => s.length > w ? s.slice(0, w - 1) + '…' : s.padEnd(w);
        const header = keys.map((k, i) => pad(k, clampedWidths[i])).join('  ');
        const sep = clampedWidths.map((w) => '─'.repeat(w)).join('  ');

        console.log(chalk.bold(header));
        console.log(chalk.dim(sep));
        for (const row of rows) {
          console.log(keys.map((k, i) => pad(flattenValue(row[k]), clampedWidths[i])).join('  '));
        }
        console.log();
        console.log(chalk.dim(`  ${rows.length} record(s)`));
        console.log();
      }
    });

  // snow ai translate <encoded_query>
  cmd
    .command('translate <encodedQuery...>')
    .description('Translate a ServiceNow encoded query string into plain English')
    .option('-t, --table <table>', 'Table name — adds field label context for better translation')
    .option('--provider <name>', 'Override the active LLM provider')
    .addHelpText(
      'after',
      `
Examples:
  snow ai translate "active=true^priority=1^assigned_toISEMPTY"
  snow ai translate "state=1^ORstate=2^assigned_to.department.name=IT" --table incident
  snow ai translate "approval_set>=javascript:gs.daysAgo(30)^state=approved"
`
    )
    .action(async (encodedQueryWords: string[], opts: { table?: string; provider?: string }) => {
      const encodedQuery = encodedQueryWords.join(' ');
      let provider = resolveProvider();
      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      let fieldContext = '';
      if (opts.table) {
        try {
          const instance = getActiveInstance();
          if (instance) {
            const { ServiceNowClient } = await import('../lib/client.js');
            const client = new ServiceNowClient(instance);
            const fields = await client.queryTable('sys_dictionary', {
              sysparmQuery: `name=${opts.table}^element!=NULL^elementISNOTEMPTY`,
              sysparmFields: 'element,column_label,internal_type',
              sysparmLimit: 150,
            }) as unknown as Array<{ element: string; column_label: string }>;
            if (fields.length > 0) {
              fieldContext = `\n\nField labels for ${opts.table}:\n` +
                fields.map((f) => `  ${f.element} = "${f.column_label}"`).join('\n');
            }
          }
        } catch { /* non-fatal */ }
      }

      const systemPrompt = `You are a ServiceNow expert. Translate ServiceNow encoded query strings into clear, concise plain English.

Encoded query syntax rules:
- ^ means AND, ^OR means OR
- Operators: = (equals), != (not equals), > < >= <= (comparisons), STARTSWITH, ENDSWITH, CONTAINS, ISEMPTY, ISNOTEMPTY, IN, NOTIN
- Dot-walking: assigned_to.user_name means "the user_name field of the assigned_to reference"
- javascript: prefix means a dynamic date expression (e.g. javascript:gs.daysAgo(7) = 7 days ago)
- State fields often use numeric values that map to named states

Output a clear one-to-three sentence description of what records the query would return. Be specific about conditions. If a field is ambiguous, include both the field name and your best interpretation.`;

      const userPrompt = `Translate this ServiceNow encoded query to plain English:\n${encodedQuery}` +
        (opts.table ? `\nTable: ${opts.table}` : '') +
        fieldContext;

      const spinner = ora(`Translating with ${provider.providerName}…`).start();
      let explanation: string;
      try {
        explanation = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log();
      if (opts.table) console.log(chalk.dim(`  Table: ${opts.table}`));
      console.log(chalk.dim(`  Query:   ${chalk.reset(encodedQuery)}`));
      console.log(chalk.dim(`  Meaning:`));
      console.log();
      for (const line of explanation.trim().split('\n')) {
        console.log(`  ${line}`);
      }
      console.log();
    });

  // snow ai fix "<error message or stack trace>"
  cmd
    .command('fix <error...>')
    .description('Diagnose a ServiceNow error message or stack trace and suggest a fix')
    .option('-t, --table <table>', 'Table or script context (e.g. sys_script_include)')
    .option('--script <text>', 'The script body that produced the error (for deeper analysis)')
    .option('--provider <name>', 'Override the active LLM provider')
    .option('--save <file>', 'Save the diagnosis to a file')
    .addHelpText(
      'after',
      `
Examples:
  snow ai fix Cannot read property getValue of null
  snow ai fix "ReferenceError: current is not defined" --table sys_script
  snow ai fix User does not have role admin to access /api/now/table/sys_properties
  snow ai fix Transaction cancelled: script execution quota exceeded
`
    )
    .action(async (errorWords: string[], opts: { table?: string; script?: string; provider?: string; save?: string }) => {
      const error = errorWords.join(' ');
      let provider = resolveProvider();
      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      const systemPrompt = `You are a ServiceNow platform expert specialising in diagnosing runtime errors, script failures, and platform issues.

Common ServiceNow error categories you should recognise:
- GlideRecord errors: null references, invalid field names, missing .query() calls, getValue() on non-existent fields
- Scope errors: cross-scope access violations, missing application node, scope not found
- ACL/permission errors: role requirements, table access denied, field write protection
- Script execution quota: transaction cancelled, infinite loops, excessive DB queries
- API errors: REST API 400/401/403/404/500, invalid sys_id format, table not found
- Business rule logic errors: setAbortAction, addErrorMessage, current vs previous
- Client-side errors: g_form method misuse, UI policy conflicts, mandatory field validation
- Workflow/Flow errors: context not found, activity timeouts, missing input variables

For each error, provide:
1. **Root cause** — what is actually wrong, in plain terms
2. **Common triggers** — what typically causes this in ServiceNow
3. **Fix** — exact code change, configuration step, or role/permission to grant
4. **Prevention** — how to avoid it in future

Be specific and practical. Include code examples where relevant. Use ES5 JavaScript syntax for any script examples (no arrow functions, no const/let, use var).`;

      const userPrompt = 'ServiceNow error:\n```\n' + error + '\n```' +
        (opts.table ? `\nContext: ${opts.table}` : '') +
        (opts.script ? `\n\nScript that produced the error:\n\`\`\`js\n${opts.script}\n\`\`\`` : '');

      const spinner = ora(`Diagnosing with ${provider.providerName}…`).start();
      let diagnosis: string;
      try {
        diagnosis = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold('Error Diagnosis'));
      console.log(chalk.dim('─'.repeat(64)));
      console.log(chalk.dim(`  ${error.slice(0, 100)}${error.length > 100 ? '…' : ''}`));
      console.log(chalk.dim('─'.repeat(64)));
      console.log();
      for (const line of diagnosis.trim().split('\n')) {
        console.log(line);
      }
      console.log();

      if (opts.save) {
        const { writeFileSync } = await import('fs');
        const md = `# Error Diagnosis\n\n**Error:** \`${error}\`\n\n---\n\n${diagnosis.trim()}\n`;
        writeFileSync(opts.save, md);
        console.log(chalk.dim(`  Saved to ${opts.save}`));
        console.log();
      }
    });

  // ─── snow ai audit <table> <sys_id> ──────────────────────────────────────────
  cmd
    .command('audit <table> <sys_id>')
    .description('AI code review of a ServiceNow script record — checks correctness, performance, ES5 compliance, and security')
    .option('-f, --field <field>', 'Specific script field to review (default: all script fields on the record)')
    .option('--provider <name>', 'Override the active LLM provider')
    .option('--save <file>', 'Save the review to a markdown file')
    .addHelpText(
      'after',
      `
Examples:
  snow ai audit sys_script_include <sys_id>
  snow ai audit sys_business_rule <sys_id> --field script
  snow ai audit sys_script_client <sys_id> --save ./review.md
`
    )
    .action(async (table: string, sysId: string, opts: { field?: string; provider?: string; save?: string }) => {
      let provider = resolveProvider();
      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      const instance = getActiveInstance();
      if (!instance) {
        console.error(chalk.red('No active instance. Run: snow instance add'));
        process.exit(1);
      }
      const { ServiceNowClient } = await import('../lib/client.js');
      const client = new ServiceNowClient(instance);

      const spinner = ora(`Fetching ${table}/${sysId}…`).start();
      let record: Record<string, unknown>;
      let dictFields: Array<{ element: string; column_label: string; internal_type: string }>;
      try {
        [record, dictFields] = await Promise.all([
          client.getRecord(table, sysId) as Promise<Record<string, unknown>>,
          client.queryTable('sys_dictionary', {
            sysparmQuery: `name=${table}^internal_typeINscript,script_plain,conditions,condition^elementISNOTEMPTY`,
            sysparmFields: 'element,column_label,internal_type',
            sysparmLimit: 20,
          }) as unknown as Promise<Array<{ element: string; column_label: string; internal_type: string }>>,
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Determine fields to review
      let fieldsToReview: Array<{ element: string; label: string }>;
      if (opts.field) {
        fieldsToReview = [{ element: opts.field, label: opts.field }];
      } else if (dictFields.length > 0) {
        fieldsToReview = dictFields.map((f) => ({ element: f.element, label: f.column_label || f.element }));
      } else {
        // Fallback: common script field names
        const common = ['script', 'condition', 'filter_condition', 'html', 'message'];
        fieldsToReview = common
          .filter((f) => record[f] && String(record[f]).trim().length > 10)
          .map((f) => ({ element: f, label: f }));
      }

      if (fieldsToReview.length === 0) {
        console.log(chalk.yellow('No script fields found on this record.'));
        return;
      }

      let reviewContent = '';
      for (const f of fieldsToReview) {
        const value = String(record[f.element] ?? '').trim();
        if (!value || value.length < 5) continue;
        reviewContent += `\n### Field: ${f.label} (${f.element})\n\`\`\`js\n${value}\n\`\`\`\n`;
      }

      if (!reviewContent) {
        console.log(chalk.yellow('No script content found in the identified fields.'));
        return;
      }

      const tableContextMap: Record<string, string> = {
        sys_script_include: 'Script Include — server-side reusable library',
        sys_business_rule: `Business Rule on "${record['collection'] ?? ''}" — ${record['when'] ?? 'unknown'} trigger`,
        sys_script_client: `Client Script on "${record['table'] ?? ''}" — type: ${record['type'] ?? 'unknown'}`,
        sys_ui_action: `UI Action on "${record['table'] ?? ''}"`,
        sys_scheduled_script_type: 'Scheduled Script',
        sys_transform_script: 'Transform Map Script',
      };
      const ctx = tableContextMap[table] ?? `Script record on table: ${table}`;
      const recordName = String(record['name'] ?? sysId);

      const systemPrompt = `You are a senior ServiceNow developer performing a thorough code review.

Review the provided script(s) for:
1. **Correctness** — logical errors, missing null checks, incorrect GlideRecord usage, missing .query() calls
2. **Performance** — queries inside loops, no row limits on GlideRecord, excessive synchronous calls
3. **Security** — hardcoded credentials, privilege escalation, injection risks
4. **ES5 Compliance** — ServiceNow server scripts must be ES5: no arrow functions, no const/let (use var), no template literals, no destructuring, no class syntax (use Class.create())
5. **Best Practices** — proper use of GlideRecord, error handling, scope awareness
6. **Style & Maintainability** — naming conventions, clarity, comments on complex logic

Format your response as:

## Summary
<1-2 sentence overall assessment>

## Issues Found
For each issue:
### [Critical|High|Medium|Low|Info] — <short title>
- **Location:** <field or line>
- **Issue:** <what is wrong>
- **Fix:** <exact correction or recommendation>

## Positive Observations
<what the code does well>

## Overall Rating
<Needs Work | Acceptable | Good | Excellent>`;

      const reviewSpinner = ora(`Reviewing with ${provider.providerName}…`).start();
      let review: string;
      try {
        review = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Review this ServiceNow ${ctx}:\n\n**Record:** ${recordName}\n**Table:** ${table}\n${reviewContent}` },
        ]);
        reviewSpinner.stop();
      } catch (err) {
        reviewSpinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      console.log();
      console.log(chalk.bold(`Code Review: ${recordName}`));
      console.log(chalk.dim(`  Table: ${table}  |  sys_id: ${sysId}`));
      console.log(chalk.dim('─'.repeat(64)));
      console.log();
      for (const line of review.trim().split('\n')) {
        console.log(line);
      }
      console.log();

      if (opts.save) {
        const md = `# Code Review: ${recordName}\n\n**Table:** ${table}  \n**sys_id:** ${sysId}  \n\n---\n\n${review.trim()}\n`;
        writeFileSync(opts.save, md);
        console.log(chalk.dim(`  Saved to ${opts.save}`));
        console.log();
      }
    });

  // ─── snow ai impact <table> [--field <field>] ─────────────────────────────
  cmd
    .command('impact <table>')
    .description('Assess the blast radius of modifying a table or field — gathers all references and uses AI to predict what will break')
    .option('-f, --field <field>', 'Focus on a specific field within the table')
    .option('--provider <name>', 'Override the active LLM provider')
    .option('--save <file>', 'Save the analysis to a markdown file')
    .addHelpText(
      'after',
      `
Examples:
  snow ai impact incident
  snow ai impact incident --field category
  snow ai impact x_myco_myapp_orders --field status --save ./impact.md
`
    )
    .action(async (table: string, opts: { field?: string; provider?: string; save?: string }) => {
      let provider = resolveProvider();
      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      const instance = getActiveInstance();
      if (!instance) {
        console.error(chalk.red('No active instance. Run: snow instance add'));
        process.exit(1);
      }
      const { ServiceNowClient } = await import('../lib/client.js');
      const client = new ServiceNowClient(instance);

      const spinner = ora(`Gathering references to ${table}${opts.field ? `.${opts.field}` : ''}…`).start();

      type ArtRow = { name: string; [k: string]: string };
      let businessRules: ArtRow[] = [];
      let clientScripts: ArtRow[] = [];
      let uiPolicies: ArtRow[] = [];
      let uiActions: ArtRow[] = [];
      let dataPolicies: ArtRow[] = [];
      let transformMaps: ArtRow[] = [];
      let referencingFields: ArtRow[] = [];
      let fieldInfo: ArtRow[] = [];

      try {
        const fetches: Promise<void>[] = [
          client.queryTable('sys_script', {
            sysparmQuery: `sys_class_name=sys_business_rule^collection=${table}^active=true`,
            sysparmFields: 'name,when,order,filter_condition',
            sysparmLimit: 100,
          }).then((r) => { businessRules = r as unknown as ArtRow[]; }),

          client.queryTable('sys_script_client', {
            sysparmQuery: `table=${table}^active=true`,
            sysparmFields: 'name,type,filter_condition',
            sysparmLimit: 100,
          }).then((r) => { clientScripts = r as unknown as ArtRow[]; }),

          client.queryTable('sys_ui_policy', {
            sysparmQuery: `table=${table}^active=true`,
            sysparmFields: 'name,conditions',
            sysparmLimit: 100,
          }).then((r) => { uiPolicies = r as unknown as ArtRow[]; }),

          client.queryTable('sys_ui_action', {
            sysparmQuery: `table=${table}^active=true`,
            sysparmFields: 'name,action_name',
            sysparmLimit: 100,
          }).then((r) => { uiActions = r as unknown as ArtRow[]; }),

          client.queryTable('sys_data_policy2', {
            sysparmQuery: `model_table=${table}^active=true`,
            sysparmFields: 'name',
            sysparmLimit: 50,
          }).then((r) => { dataPolicies = r as unknown as ArtRow[]; }),

          client.queryTable('sys_transform_map', {
            sysparmQuery: `source_table=${table}^ORtarget_table=${table}`,
            sysparmFields: 'name,source_table,target_table',
            sysparmLimit: 50,
          }).then((r) => { transformMaps = r as unknown as ArtRow[]; }),

          client.queryTable('sys_dictionary', {
            sysparmQuery: `reference=${table}^internal_type=reference^nameNOT INsys_audit,sys_journal,sys_journal_field`,
            sysparmFields: 'name,element,column_label',
            sysparmLimit: 100,
          }).then((r) => { referencingFields = r as unknown as ArtRow[]; }),
        ];

        if (opts.field) {
          fetches.push(
            client.queryTable('sys_dictionary', {
              sysparmQuery: `name=${table}^element=${opts.field}`,
              sysparmFields: 'element,column_label,internal_type,mandatory,read_only,default_value',
              sysparmLimit: 1,
            }).then((r) => { fieldInfo = r as unknown as ArtRow[]; })
          );
        }

        await Promise.all(fetches);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      // Build prompt
      const target = opts.field ? `field \`${opts.field}\` on table \`${table}\`` : `table \`${table}\``;
      let promptBody = `# Impact Analysis: ${target}\n\n`;

      if (opts.field && fieldInfo.length > 0) {
        const fi = fieldInfo[0];
        promptBody += `## Field Definition\n- Label: ${fi.column_label}\n- Type: ${fi.internal_type}\n- Mandatory: ${fi.mandatory}\n- Read-only: ${fi.read_only}\n`;
        if (fi.default_value) promptBody += `- Default: ${fi.default_value}\n`;
        promptBody += '\n';
      }

      const section = (title: string, items: ArtRow[], extraFields: string[]) => {
        if (items.length === 0) return `## ${title}\nNone found.\n\n`;
        let s = `## ${title} (${items.length})\n`;
        for (const item of items) {
          s += `- **${item.name}**`;
          const extras = extraFields
            .filter((f) => f !== 'name' && item[f])
            .map((f) => `${f}: ${String(item[f]).slice(0, 80)}`);
          if (extras.length) s += ` — ${extras.join(', ')}`;
          s += '\n';
        }
        return s + '\n';
      };

      promptBody += section('Business Rules', businessRules, ['when', 'order', 'filter_condition']);
      promptBody += section('Client Scripts', clientScripts, ['type', 'filter_condition']);
      promptBody += section('UI Policies', uiPolicies, ['conditions']);
      promptBody += section('UI Actions', uiActions, ['action_name']);
      promptBody += section('Data Policies', dataPolicies, []);
      promptBody += section('Transform Maps', transformMaps, ['source_table', 'target_table']);
      promptBody += section('Tables With References To This Table', referencingFields, ['name', 'element', 'column_label']);

      const systemPrompt = `You are a senior ServiceNow architect specialising in change impact analysis.

Given all artifacts referencing a table or field, assess what happens if it is modified or removed.

Provide:
1. **Summary** — how widely used is this? (2-3 sentences)
2. **Immediate Break Risk** — what will fail the moment the change is deployed?
3. **Functional Impact** — which business processes are affected and how?
4. **Data Impact** — data migration needs, integrity constraints, or existing records affected?
5. **Testing Checklist** — specific scenarios to test after the change (bullet list)
6. **Recommended Approach** — how to safely make this change (phased rollout, deprecation, migration scripts, etc.)
7. **Risk Rating** — Low / Medium / High / Critical

Be specific: name the exact artifacts most at risk.`;

      const llmSpinner = ora(`Analysing with ${provider.providerName}…`).start();
      let analysis: string;
      try {
        analysis = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Analyse the impact of changing ${target}:\n\n${promptBody}` },
        ]);
        llmSpinner.stop();
      } catch (err) {
        llmSpinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const header = opts.field ? `${table}.${opts.field}` : table;
      const counts = [
        `${businessRules.length} BRs`,
        `${clientScripts.length} client scripts`,
        `${uiPolicies.length} UI policies`,
        `${uiActions.length} UI actions`,
        `${dataPolicies.length} data policies`,
        `${transformMaps.length} transform maps`,
        `${referencingFields.length} referencing tables`,
      ].join('  ');

      console.log();
      console.log(chalk.bold(`Impact Analysis: ${header}`));
      console.log(chalk.dim(`  ${counts}`));
      console.log(chalk.dim('─'.repeat(64)));
      console.log();
      for (const line of analysis.trim().split('\n')) {
        console.log(line);
      }
      console.log();

      if (opts.save) {
        const md = `# Impact Analysis: ${header}\n\n${counts}\n\n---\n\n${analysis.trim()}\n`;
        writeFileSync(opts.save, md);
        console.log(chalk.dim(`  Saved to ${opts.save}`));
        console.log();
      }
    });

  // ─── snow ai document <scope> ────────────────────────────────────────────
  cmd
    .command('document <scope>')
    .description('Generate comprehensive markdown documentation for a scoped application')
    .option('--provider <name>', 'Override the active LLM provider')
    .option('-o, --out <file>', 'Output file (default: <scope>-docs.md)')
    .addHelpText(
      'after',
      `
Examples:
  snow ai document x_myco_myapp
  snow ai document x_myco_myapp --out ./docs/myapp.md
`
    )
    .action(async (scope: string, opts: { provider?: string; out?: string }) => {
      let provider = resolveProvider();
      if (opts.provider) {
        const { getAIConfig } = await import('../lib/config.js');
        const ai = getAIConfig();
        const pc = ai.providers[opts.provider as keyof typeof ai.providers];
        if (!pc) {
          console.error(chalk.red(`Provider "${opts.provider}" is not configured.`));
          process.exit(1);
        }
        provider = buildProvider(opts.provider, pc.model, pc.apiKey, pc.baseUrl);
      }

      const instance = getActiveInstance();
      if (!instance) {
        console.error(chalk.red('No active instance. Run: snow instance add'));
        process.exit(1);
      }
      const { ServiceNowClient } = await import('../lib/client.js');
      const client = new ServiceNowClient(instance);

      const spinner = ora(`Fetching artifacts for scope ${chalk.cyan(scope)}…`).start();

      type AppRecord = { name: string; scope: string; version: string; short_description: string };
      type SIRecord = { name: string; api_name: string; script: string; description: string };
      type BRRecord = { name: string; collection: string; when: string; order: string; filter_condition: string; script: string };
      type CSRecord = { name: string; table: string; type: string; script: string };
      type UARecord = { name: string; table: string; action_name: string; script: string };
      type SJRecord = { name: string; script: string; run_period: string };

      const q = `sys_scope.scope=${scope}^active=true`;
      let appInfo: AppRecord[] = [];
      let scriptIncludes: SIRecord[] = [];
      let businessRules: BRRecord[] = [];
      let clientScripts: CSRecord[] = [];
      let uiActions: UARecord[] = [];
      let scheduledJobs: SJRecord[] = [];

      try {
        await Promise.all([
          client.queryTable('sys_app', {
            sysparmQuery: `scope=${scope}`,
            sysparmFields: 'name,scope,version,short_description',
            sysparmLimit: 1,
          }).then((r) => { appInfo = r as unknown as AppRecord[]; }),

          client.queryTable('sys_script_include', {
            sysparmQuery: q,
            sysparmFields: 'name,api_name,script,description',
            sysparmLimit: 100,
          }).then((r) => { scriptIncludes = r as unknown as SIRecord[]; }),

          client.queryTable('sys_script', {
            sysparmQuery: `${q}^sys_class_name=sys_business_rule`,
            sysparmFields: 'name,collection,when,order,filter_condition,script',
            sysparmLimit: 100,
          }).then((r) => { businessRules = r as unknown as BRRecord[]; }),

          client.queryTable('sys_script_client', {
            sysparmQuery: q,
            sysparmFields: 'name,table,type,script',
            sysparmLimit: 100,
          }).then((r) => { clientScripts = r as unknown as CSRecord[]; }),

          client.queryTable('sys_ui_action', {
            sysparmQuery: q,
            sysparmFields: 'name,table,action_name,script',
            sysparmLimit: 100,
          }).then((r) => { uiActions = r as unknown as UARecord[]; }),

          client.queryTable('sys_scheduled_script_type', {
            sysparmQuery: q,
            sysparmFields: 'name,script,run_period',
            sysparmLimit: 50,
          }).then((r) => { scheduledJobs = r as unknown as SJRecord[]; }),
        ]);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const totalArtifacts = scriptIncludes.length + businessRules.length +
        clientScripts.length + uiActions.length + scheduledJobs.length;

      if (totalArtifacts === 0) {
        console.log(chalk.yellow(`No artifacts found for scope: ${scope}`));
        console.log(chalk.dim('  Verify the scope prefix is correct (e.g. x_myco_myapp).'));
        return;
      }

      const TRUNC = 800;
      const trunc = (s: string) => s.length > TRUNC ? s.slice(0, TRUNC) + '\n// [... truncated]' : s;

      const app = appInfo[0];
      let promptBody = `# Application: ${app?.name || scope}\n`;
      promptBody += `**Scope:** ${scope}\n`;
      if (app?.version) promptBody += `**Version:** ${app.version}\n`;
      if (app?.short_description) promptBody += `**Description:** ${app.short_description}\n`;
      promptBody += `**Artifacts:** ${scriptIncludes.length} script includes, ${businessRules.length} business rules, ${clientScripts.length} client scripts, ${uiActions.length} UI actions, ${scheduledJobs.length} scheduled jobs\n\n`;

      if (scriptIncludes.length > 0) {
        promptBody += `## Script Includes\n`;
        for (const si of scriptIncludes) {
          promptBody += `\n### ${si.name}\n`;
          if (si.description) promptBody += `${si.description}\n`;
          promptBody += `**API Name:** ${si.api_name}\n\`\`\`js\n${trunc(si.script)}\n\`\`\`\n`;
        }
        promptBody += '\n';
      }

      if (businessRules.length > 0) {
        promptBody += `## Business Rules\n`;
        for (const br of businessRules) {
          promptBody += `\n### ${br.name}\n`;
          promptBody += `**Table:** ${br.collection} | **Trigger:** ${br.when} (order: ${br.order})\n`;
          if (br.filter_condition) promptBody += `**Condition:** ${br.filter_condition}\n`;
          promptBody += `\`\`\`js\n${trunc(br.script)}\n\`\`\`\n`;
        }
        promptBody += '\n';
      }

      if (clientScripts.length > 0) {
        promptBody += `## Client Scripts\n`;
        for (const cs of clientScripts) {
          promptBody += `\n### ${cs.name}\n`;
          promptBody += `**Table:** ${cs.table} | **Type:** ${cs.type}\n`;
          promptBody += `\`\`\`js\n${trunc(cs.script)}\n\`\`\`\n`;
        }
        promptBody += '\n';
      }

      if (uiActions.length > 0) {
        promptBody += `## UI Actions\n`;
        for (const ua of uiActions) {
          promptBody += `\n### ${ua.name}\n`;
          promptBody += `**Table:** ${ua.table} | **Action:** ${ua.action_name}\n`;
          if (ua.script) promptBody += `\`\`\`js\n${trunc(ua.script)}\n\`\`\`\n`;
        }
        promptBody += '\n';
      }

      if (scheduledJobs.length > 0) {
        promptBody += `## Scheduled Jobs\n`;
        for (const sj of scheduledJobs) {
          promptBody += `\n### ${sj.name}\n`;
          if (sj.run_period) promptBody += `**Schedule:** ${sj.run_period}\n`;
          promptBody += `\`\`\`js\n${trunc(sj.script)}\n\`\`\`\n`;
        }
        promptBody += '\n';
      }

      const systemPrompt = `You are a technical writer specialising in ServiceNow application documentation.

Generate comprehensive, developer-friendly markdown documentation for the provided ServiceNow scoped application. The output should be ready to use as a GitHub README or internal wiki page.

Structure your output as:

# <App Name>

## Overview
What the app does, its purpose, who uses it.

## Architecture
How the components fit together and key design decisions.

## Script Includes
For each: purpose, key methods with signatures, usage example.

## Business Rules
For each: trigger (table, when, condition), purpose, side effects.

## Client Scripts
For each: trigger (onLoad/onChange/onSubmit, table), what it does.

## UI Actions
Brief description of each button or context menu item.

## Scheduled Jobs
Frequency and purpose of each job.

## Dependencies
OOTB tables, other scoped apps, or external integrations.

## Deployment Notes
Configuration steps, required roles, or first-time setup.

Write clearly and accurately based on the actual code. Do not invent functionality.`;

      const llmSpinner = ora(`Generating docs with ${provider.providerName}…`).start();
      let docs: string;
      try {
        docs = await provider.complete([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Generate documentation for this ServiceNow application:\n\n${promptBody}` },
        ]);
        llmSpinner.stop();
      } catch (err) {
        llmSpinner.fail(chalk.red('LLM request failed'));
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const outFile = opts.out ?? `${scope}-docs.md`;
      writeFileSync(outFile, docs.trim() + '\n');

      console.log();
      console.log(chalk.green(`Documentation saved to: ${outFile}`));
      console.log(chalk.dim(`  ${totalArtifacts} artifacts documented`));
      console.log();
      // Print preview
      const previewLines = docs.trim().split('\n').slice(0, 8);
      console.log(chalk.dim('─'.repeat(60)));
      for (const line of previewLines) console.log(chalk.dim(line));
      console.log(chalk.dim('─'.repeat(60)));
      console.log();
    });

  // snow ai save-manifest <file.json>
  cmd
    .command('save-manifest <jsonFile>')
    .description('Convert a raw LLM JSON response into a build directory')
    .option('-o, --output <dir>', 'Output directory')
    .action(async (jsonFile: string, opts: { output?: string }) => {
      if (!existsSync(jsonFile)) {
        console.error(chalk.red(`File not found: ${jsonFile}`));
        process.exit(1);
      }
      let build: SNBuildResponse;
      try {
        build = parseBuildResponse(readFileSync(jsonFile, 'utf-8'));
      } catch (err) {
        console.error(chalk.red(`Failed to parse: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
      printBuildSummary(build);
      const dir = saveBuild(build, opts.output);
      printSaveResult(dir, build);
    });

  return cmd;
}
