import { Command } from 'commander';
import { readFileSync, existsSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

const DIVIDER = chalk.dim('─'.repeat(52));

function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

function extractCsrfToken(html: string): string | null {
  // Try various patterns SN uses across versions
  const patterns = [
    /name="sysparm_ck"\s+value="([^"]+)"/i,
    /value="([^"]+)"\s+name="sysparm_ck"/i,
    /id="sysparm_ck"[^>]*value="([^"]+)"/i,
    /"sysparm_ck"[^>]*value="([^"]+)"/i,
    /sysparm_ck["']\s*:\s*["']([a-f0-9]+)["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) return m[1];
  }
  return null;
}

function extractOutput(html: string): string | null {
  // SN renders output inside a textarea named sysparm_output (classic/UI16)
  // or inside a <pre> block in newer versions
  const patterns = [
    /<textarea[^>]*name="sysparm_output"[^>]*>([\s\S]*?)<\/textarea>/i,
    /<textarea[^>]*id="output"[^>]*>([\s\S]*?)<\/textarea>/i,
    /<pre[^>]*id="output"[^>]*>([\s\S]*?)<\/pre>/i,
    /<pre[^>]*class="[^"]*output[^"]*"[^>]*>([\s\S]*?)<\/pre>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m != null) return decodeHtmlEntities(m[1]);
  }
  return null;
}

async function executeScript(
  client: ServiceNowClient,
  script: string,
  scope: string
): Promise<string> {
  const http = client.getAxiosInstance();

  // Step 1 — GET the page to obtain a CSRF token
  const getRes = await http.get<string>('/sys.scripts.do', { responseType: 'text' });
  const pageHtml = String(getRes.data);

  const csrfToken = extractCsrfToken(pageHtml);
  if (!csrfToken) {
    throw new Error(
      'Could not read the CSRF token from sys.scripts.do.\n' +
        'Make sure the authenticated user has the admin role and that the instance URL is correct.'
    );
  }

  // Step 2 — POST with the script
  const body = new URLSearchParams({
    script,
    sysparm_ck: csrfToken,
    sysparm_transaction_scope: scope,
  });

  const postRes = await http.post<string>('/sys.scripts.do', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    responseType: 'text',
  });

  const responseHtml = String(postRes.data);
  const output = extractOutput(responseHtml);

  if (output === null) {
    throw new Error(
      'Script was sent but no output section was found in the response.\n' +
        'The script may have caused a server error. Try --debug to inspect the raw response.'
    );
  }

  return output;
}

export function runCommand(): Command {
  const cmd = new Command('run')
    .description('Execute a server-side script on the active instance (requires admin)')
    .argument('[script]', 'Inline script to run, or a path to a .js file')
    .option('-f, --file <path>', 'Path to a .js file to execute (alternative to inline argument)')
    .option('-s, --scope <scope>', 'Application scope to run the script in', 'global')
    .option('--debug', 'Print the raw HTTP response for troubleshooting')
    .addHelpText(
      'after',
      `
Examples:
  snow run "gs.print('hello world')"
  snow run ./fix-bad-records.js
  snow run --scope x_myco_myapp "new MyUtils().doSomething()"
  snow run -f ./migrate.js --scope x_myco_hronboard

Notes:
  - Requires the admin role on the target instance.
  - Use gs.print() to write to the output captured by this command.
  - gs.info() / gs.log() write to the system log (visible in snow log) but not
    captured here.
`
    )
    .action(async (scriptArg: string | undefined, opts: { file?: string; scope: string; debug?: boolean }) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      // Resolve the script source
      let script: string;

      const filePath = opts.file ?? (scriptArg && existsSync(scriptArg) ? scriptArg : undefined);

      if (filePath) {
        if (!existsSync(filePath)) {
          console.error(chalk.red(`File not found: ${filePath}`));
          process.exit(1);
        }
        script = readFileSync(filePath, 'utf-8');
      } else if (scriptArg) {
        script = scriptArg;
      } else {
        console.error(
          chalk.red('Provide an inline script or a file path.\n') +
            chalk.dim('  snow run "gs.print(\'hello\')"') +
            '\n' +
            chalk.dim('  snow run ./my-script.js')
        );
        process.exit(1);
      }

      const label = filePath ?? (script.length > 48 ? script.slice(0, 47) + '…' : script);
      const spinner = ora(`Running on ${chalk.cyan(instance.alias)} (scope: ${opts.scope})…`).start();

      let output: string;
      try {
        output = await executeScript(client, script, opts.scope);
        spinner.stop();
      } catch (err) {
        spinner.fail(chalk.red('Script execution failed'));
        if (opts.debug && err instanceof Error) {
          console.error(chalk.dim(err.stack ?? err.message));
        } else {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        }
        process.exit(1);
      }

      console.log();
      console.log(DIVIDER);
      console.log(`  ${chalk.bold('Output')}  ${chalk.dim(label)}`);
      console.log(DIVIDER);

      if (output.trim() === '') {
        console.log(chalk.dim('  (no output)'));
      } else {
        for (const line of output.split('\n')) {
          console.log(`  ${line}`);
        }
      }

      console.log();
      console.log(DIVIDER);
      console.log();
    });

  return cmd;
}
