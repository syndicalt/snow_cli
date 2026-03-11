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
