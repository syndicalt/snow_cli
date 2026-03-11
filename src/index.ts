import { Command } from 'commander';
import chalk from 'chalk';
import { instanceCommand } from './commands/instance.js';
import { tableCommand } from './commands/table.js';
import { schemaCommand } from './commands/schema.js';
import { scriptCommand } from './commands/script.js';
import { providerCommand } from './commands/provider.js';
import { aiCommand } from './commands/ai.js';
import { bulkCommand } from './commands/bulk.js';
import { userCommand } from './commands/user.js';
import { attachmentCommand } from './commands/attachment.js';
import { updatesetCommand } from './commands/updateset.js';
import { statusCommand } from './commands/status.js';
import { diffCommand } from './commands/diff.js';
import { factoryCommand } from './commands/factory.js';
import { catalogCommand } from './commands/catalog.js';
import { flowCommand } from './commands/flow.js';
import { appCommand } from './commands/app.js';
import { logCommand } from './commands/log.js';
import { runCommand } from './commands/run.js';
import { sysCommand } from './commands/sys.js';
import { approvalCommand } from './commands/approval.js';
import { watchCommand } from './commands/watch.js';
import { aclCommand } from './commands/acl.js';
import { importCommand } from './commands/import.js';
import { securityCommand } from './commands/security.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
    ) as { version: string };
    return pkg.version;
  } catch {
    return '0.0.0';
  }
}

const program = new Command();

program
  .name('snow')
  .description(chalk.bold('snow') + ' — ServiceNow CLI: query tables, edit scripts, and generate apps with AI')
  .version(getVersion(), '-v, --version', 'Output the current version')
  .addHelpText(
    'after',
    `
${chalk.bold('Examples:')}
  ${chalk.dim('# Add a ServiceNow instance')}
  snow instance add

  ${chalk.dim('# Query records from a table')}
  snow table get incident -q "active=true" -l 10

  ${chalk.dim('# View the schema for a table')}
  snow schema incident

  ${chalk.dim('# Pull a script field, edit it, and push back')}
  snow script pull sys_script_include <sys_id> script

  ${chalk.dim('# Configure an LLM provider (OpenAI, Anthropic, xAI/Grok, or Ollama)')}
  snow provider set openai
  snow provider set anthropic
  snow provider set xai
  snow provider set ollama --model llama3

  ${chalk.dim('# Generate a ServiceNow app and export as an update set XML')}
  snow ai build "Create a script include that auto-routes incidents by category"

  ${chalk.dim('# Generate and immediately push artifacts to the active instance')}
  snow ai build "Create a business rule that sets priority on incident insert" --push

  ${chalk.dim('# Interactive multi-turn app builder')}
  snow ai chat
`
  );

program.addCommand(instanceCommand());
program.addCommand(tableCommand());
program.addCommand(schemaCommand());
program.addCommand(scriptCommand());
program.addCommand(bulkCommand());
program.addCommand(userCommand());
program.addCommand(attachmentCommand());
program.addCommand(updatesetCommand());
program.addCommand(statusCommand());
program.addCommand(diffCommand());
program.addCommand(factoryCommand());
program.addCommand(catalogCommand());
program.addCommand(flowCommand());
program.addCommand(appCommand());
program.addCommand(logCommand());
program.addCommand(runCommand());
program.addCommand(sysCommand());
program.addCommand(approvalCommand());
program.addCommand(watchCommand());
program.addCommand(aclCommand());
program.addCommand(importCommand());
program.addCommand(securityCommand());
program.addCommand(providerCommand());
program.addCommand(aiCommand());

// Alias: `snow instances` → `snow instance list`
program
  .command('instances', { hidden: true })
  .description('Alias for `snow instance list`')
  .action(() => {
    const sub = instanceCommand();
    sub.parse(['node', 'snow', 'list']);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(chalk.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
