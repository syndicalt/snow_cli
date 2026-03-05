import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import {
  getAIConfig,
  setProviderConfig,
  removeProviderConfig,
  setActiveProvider,
  getActiveProvider,
} from '../lib/config.js';
import { buildProvider } from '../lib/llm.js';
import type { LLMProviderName } from '../types/index.js';

const PROVIDER_NAMES: LLMProviderName[] = ['openai', 'anthropic', 'xai', 'ollama'];

const PROVIDER_DEFAULTS: Record<LLMProviderName, { model: string; baseUrl?: string }> = {
  openai:    { model: 'gpt-4o' },
  anthropic: { model: 'claude-opus-4-6' },
  xai:       { model: 'grok-3', baseUrl: 'https://api.x.ai/v1' },
  ollama:    { model: 'llama3', baseUrl: 'http://localhost:11434' },
};

export function providerCommand(): Command {
  const cmd = new Command('provider').description(
    'Configure LLM providers for AI-powered ServiceNow app generation'
  );

  // snow provider list
  cmd
    .command('list')
    .alias('ls')
    .description('List configured LLM providers')
    .action(() => {
      const ai = getAIConfig();
      const configured = Object.entries(ai.providers) as [LLMProviderName, { model: string; apiKey?: string; baseUrl?: string }][];

      if (configured.length === 0) {
        console.log(chalk.dim('No providers configured. Run `snow provider set <name>` to add one.'));
        console.log();
        console.log(chalk.bold('Available providers:'));
        for (const name of PROVIDER_NAMES) {
          const d = PROVIDER_DEFAULTS[name];
          console.log(`  ${chalk.cyan(name.padEnd(12))} default model: ${chalk.dim(d.model)}`);
        }
        return;
      }

      console.log(chalk.bold('Configured providers:'));
      for (const [name, config] of configured) {
        const isActive = ai.activeProvider === name;
        const marker = isActive ? chalk.green('✔ ') : '  ';
        const keyDisplay = config.apiKey
          ? chalk.dim('key: ' + config.apiKey.slice(0, 8) + '…')
          : chalk.dim('(no key — local)');
        const urlDisplay = config.baseUrl ? chalk.dim(` @ ${config.baseUrl}`) : '';
        console.log(`${marker}${chalk.cyan(name.padEnd(12))} ${config.model}  ${keyDisplay}${urlDisplay}`);
      }
      if (ai.activeProvider) {
        console.log();
        console.log(chalk.dim(`Active: ${ai.activeProvider}`));
      }
    });

  // snow provider set <name>
  cmd
    .command('set <name>')
    .description('Add or update an LLM provider configuration')
    .option('-k, --key <apiKey>', 'API key (not required for ollama)')
    .option('-m, --model <model>', 'Model name to use')
    .option('-u, --url <baseUrl>', 'Custom base URL (for ollama or self-hosted endpoints)')
    .action(
      async (
        name: string,
        opts: { key?: string; model?: string; url?: string }
      ) => {
        if (!PROVIDER_NAMES.includes(name as LLMProviderName)) {
          console.error(
            chalk.red(`Unknown provider: ${name}. Choose from: ${PROVIDER_NAMES.join(', ')}`)
          );
          process.exit(1);
        }

        const providerName = name as LLMProviderName;
        const defaults = PROVIDER_DEFAULTS[providerName];

        // Interactive prompts for missing required values
        let apiKey = opts.key;
        let model = opts.model ?? defaults.model;
        let baseUrl = opts.url ?? defaults.baseUrl;

        if (providerName !== 'ollama' && !apiKey) {
          const { input, password } = await import('@inquirer/prompts');
          apiKey = await password({ message: `${name} API key:` });
          if (!opts.model) {
            model = await input({
              message: `Model (default: ${defaults.model}):`,
              default: defaults.model,
            });
          }
        }

        setProviderConfig(providerName, {
          model,
          ...(apiKey ? { apiKey } : {}),
          ...(baseUrl ? { baseUrl } : {}),
        });

        console.log(chalk.green(`✔ Provider "${name}" configured (model: ${model})`));
        const ai = getAIConfig();
        if (ai.activeProvider === providerName) {
          console.log(chalk.dim('This is now the active provider.'));
        } else {
          console.log(chalk.dim(`Run \`snow provider use ${name}\` to activate it.`));
        }
      }
    );

  // snow provider use <name>
  cmd
    .command('use <name>')
    .description('Set the active LLM provider')
    .action((name: string) => {
      if (!PROVIDER_NAMES.includes(name as LLMProviderName)) {
        console.error(chalk.red(`Unknown provider: ${name}`));
        process.exit(1);
      }
      const ok = setActiveProvider(name as LLMProviderName);
      if (!ok) {
        console.error(chalk.red(`Provider "${name}" is not configured. Run \`snow provider set ${name}\` first.`));
        process.exit(1);
      }
      console.log(chalk.green(`✔ Active provider set to: ${name}`));
    });

  // snow provider remove <name>
  cmd
    .command('remove <name>')
    .alias('rm')
    .description('Remove a provider configuration')
    .action((name: string) => {
      const ok = removeProviderConfig(name as LLMProviderName);
      if (!ok) {
        console.error(chalk.yellow(`Provider "${name}" was not configured.`));
        process.exit(1);
      }
      console.log(chalk.green(`✔ Removed provider: ${name}`));
    });

  // snow provider test [name]
  cmd
    .command('test [name]')
    .description('Send a test message to verify provider connectivity')
    .action(async (name?: string) => {
      let providerName: LLMProviderName;
      let config: { model: string; apiKey?: string; baseUrl?: string };

      if (name) {
        const ai = getAIConfig();
        const stored = ai.providers[name as LLMProviderName];
        if (!stored) {
          console.error(chalk.red(`Provider "${name}" is not configured.`));
          process.exit(1);
        }
        providerName = name as LLMProviderName;
        config = stored;
      } else {
        const active = getActiveProvider();
        if (!active) {
          console.error(chalk.red('No active provider configured. Run `snow provider set <name>`.'));
          process.exit(1);
        }
        providerName = active.name;
        config = active.config;
      }

      const spinner = ora(`Testing ${providerName} (${config.model})…`).start();
      try {
        const provider = buildProvider(providerName, config.model, config.apiKey, config.baseUrl);
        const response = await provider.complete([
          { role: 'user', content: 'Reply with exactly: "snow-cli connection OK"' },
        ]);
        spinner.succeed(chalk.green(`${providerName} responded: ${response.trim()}`));
      } catch (err) {
        spinner.fail(chalk.red(`Connection failed: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }
    });

  // snow provider show
  cmd
    .command('show')
    .description('Show the active provider configuration')
    .action(() => {
      const active = getActiveProvider();
      if (!active) {
        console.log(chalk.dim('No active provider. Run `snow provider set <name>`.'));
        return;
      }
      console.log(chalk.bold('Active provider:'));
      console.log(`  Name:    ${chalk.cyan(active.name)}`);
      console.log(`  Model:   ${active.config.model}`);
      if (active.config.baseUrl) {
        console.log(`  URL:     ${chalk.dim(active.config.baseUrl)}`);
      }
      if (active.config.apiKey) {
        console.log(`  API Key: ${chalk.dim(active.config.apiKey.slice(0, 8) + '…')}`);
      }
    });

  return cmd;
}
