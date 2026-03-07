import { Command } from 'commander';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { createReadStream, statSync } from 'fs';
import chalk from 'chalk';
import ora from 'ora';
import { requireActiveInstance } from '../lib/config.js';
import { ServiceNowClient } from '../lib/client.js';

interface AttachmentMeta {
  sys_id: string;
  file_name: string;
  content_type: string;
  size_bytes: string;
  table_name: string;
  table_sys_id: string;
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function listAttachments(client: ServiceNowClient, table: string, sysId: string): Promise<AttachmentMeta[]> {
  const res = await client.get<{ result: AttachmentMeta[] }>('/api/now/attachment', {
    params: {
      sysparm_query: `table_name=${table}^table_sys_id=${sysId}`,
      sysparm_fields: 'sys_id,file_name,content_type,size_bytes,table_name,table_sys_id',
      sysparm_limit: 500,
    },
  });
  return res.result ?? [];
}

async function downloadAttachment(client: ServiceNowClient, attSysId: string): Promise<Buffer> {
  const res = await client.getAxiosInstance().get<ArrayBuffer>(
    `/api/now/attachment/${attSysId}/file`,
    { responseType: 'arraybuffer' }
  );
  return Buffer.from(res.data);
}

export function attachmentCommand(): Command {
  const cmd = new Command('attachment')
    .alias('att')
    .description('Manage ServiceNow record attachments');

  // snow attachment list <table> <sys_id>
  cmd
    .command('list <table> <sys_id>')
    .alias('ls')
    .description('List attachments on a record')
    .action(async (table: string, sysId: string) => {
      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const spinner = ora('Fetching attachments...').start();
      let attachments: AttachmentMeta[];
      try {
        attachments = await listAttachments(client, table, sysId);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (attachments.length === 0) {
        console.log(chalk.dim('No attachments found.'));
        return;
      }

      console.log(chalk.bold(`\n${attachments.length} attachment(s) on ${table}/${sysId}:\n`));
      const nameWidth = Math.max(9, ...attachments.map(a => a.file_name.length));
      const typeWidth = Math.max(12, ...attachments.map(a => a.content_type.length));

      console.log(
        chalk.bold(
          `${'File name'.padEnd(nameWidth)}  ${'Content-Type'.padEnd(typeWidth)}  Size       sys_id`
        )
      );
      console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(typeWidth)}  ---------  ${'-'.repeat(32)}`);

      for (const att of attachments) {
        const size = humanSize(parseInt(att.size_bytes, 10) || 0);
        console.log(
          `${chalk.cyan(att.file_name.padEnd(nameWidth))}  ${att.content_type.padEnd(typeWidth)}  ${size.padStart(9)}  ${chalk.dim(att.sys_id)}`
        );
      }
    });

  // snow attachment pull <table> <sys_id> [--all] [--out <dir>]
  cmd
    .command('pull <table> <sys_id>')
    .description('Download attachment(s) from a record')
    .option('-a, --all', 'Download all attachments')
    .option('-n, --name <file_name>', 'Download a specific attachment by file name')
    .option('-o, --out <dir>', 'Output directory (default: current directory)')
    .action(async (
      table: string,
      sysId: string,
      opts: { all?: boolean; name?: string; out?: string }
    ) => {
      if (!opts.all && !opts.name) {
        console.error(chalk.red('Specify --all to download all attachments, or --name <file_name> for one.'));
        process.exit(1);
      }

      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);
      const outDir = opts.out ?? '.';

      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const spinner = ora('Fetching attachment list...').start();
      let attachments: AttachmentMeta[];
      try {
        attachments = await listAttachments(client, table, sysId);
        spinner.stop();
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (attachments.length === 0) {
        console.log(chalk.dim('No attachments found.'));
        return;
      }

      let targets = attachments;
      if (opts.name) {
        targets = attachments.filter(a => a.file_name === opts.name);
        if (targets.length === 0) {
          console.error(chalk.red(`No attachment named "${opts.name}" found.`));
          process.exit(1);
        }
      }

      let downloaded = 0;
      for (const att of targets) {
        const dlSpinner = ora(`Downloading ${att.file_name}...`).start();
        try {
          const buf = await downloadAttachment(client, att.sys_id);
          const dest = join(outDir, att.file_name);
          writeFileSync(dest, buf);
          dlSpinner.succeed(chalk.green(`Saved: ${dest} (${humanSize(buf.length)})`));
          downloaded++;
        } catch (err) {
          dlSpinner.fail(chalk.red(`Failed ${att.file_name}: ${err instanceof Error ? err.message : String(err)}`));
        }
      }

      if (targets.length > 1) {
        console.log(chalk.bold(`\n${downloaded}/${targets.length} downloaded to ${outDir}`));
      }
    });

  // snow attachment push <table> <sys_id> <file>
  cmd
    .command('push <table> <sys_id> <file>')
    .description('Upload a file as an attachment to a record')
    .option('-t, --type <content-type>', 'Override Content-Type (auto-detected by default)')
    .action(async (
      table: string,
      sysId: string,
      file: string,
      opts: { type?: string }
    ) => {
      if (!existsSync(file)) {
        console.error(chalk.red(`File not found: ${file}`));
        process.exit(1);
      }

      const instance = requireActiveInstance();
      const client = new ServiceNowClient(instance);

      const fileName = basename(file);
      const stat = statSync(file);
      const contentType = opts.type ?? guessContentType(fileName);

      const spinner = ora(`Uploading ${fileName} (${humanSize(stat.size)})...`).start();
      try {
        const stream = createReadStream(file);
        const res = await client.getAxiosInstance().post<{ result: AttachmentMeta }>(
          '/api/now/attachment/file',
          stream,
          {
            params: {
              table_name: table,
              table_sys_id: sysId,
              file_name: fileName,
            },
            headers: {
              'Content-Type': contentType,
              'Content-Length': stat.size,
            },
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
          }
        );
        const created = res.data.result;
        spinner.succeed(
          chalk.green(`Uploaded: ${created.file_name} (${humanSize(parseInt(created.size_bytes, 10))}) — sys_id: ${created.sys_id}`)
        );
      } catch (err) {
        spinner.fail();
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  return cmd;
}

function guessContentType(fileName: string): string {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
  const map: Record<string, string> = {
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.json': 'application/json',
    '.zip': 'application/zip',
    '.js': 'application/javascript',
    '.html': 'text/html',
    '.css': 'text/css',
    '.md': 'text/markdown',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
  return map[ext] ?? 'application/octet-stream';
}
