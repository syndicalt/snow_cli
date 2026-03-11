---
title: Admin Operations
nav_order: 8
---

# Admin Operations
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow run

Execute a server-side script directly on the active instance, equivalent to the **Scripts - Background** page in the ServiceNow UI. Captures `gs.print()` output and displays it in the terminal.

**Requires the `admin` role.**

```bash
# Inline script
snow run "gs.print('hello world')"

# Run a local file
snow run ./fix-bad-records.js

# Run in a specific application scope
snow run --scope x_myco_myapp "new MyUtils().validate()"

# Combine file and scope
snow run -f ./migrate.js --scope x_myco_hronboard

# Debug raw HTTP response when parsing fails
snow run "gs.print(new GlideDateTime())" --debug
```

**Options:**

| Flag | Description |
|---|---|
| `-f, --file <path>` | Path to a `.js` file to execute (alternative to the inline argument) |
| `-s, --scope <scope>` | Application scope to run the script in (default: `global`) |
| `--debug` | Print the raw HTTP response for troubleshooting |

**Output notes:**

- Use `gs.print()` to write to the output captured by this command.
- `gs.info()`, `gs.log()`, and `gs.warn()` write to the system log and are visible with `snow log`, but are **not** captured here.
- If the script produces no output, `(no output)` is shown rather than an error.

**How it works:**

The command posts to ServiceNow's `/sys.scripts.do` processor (the same endpoint the background scripts UI page uses). It first performs a GET to obtain the CSRF token, then posts the script body. The response HTML is parsed to extract the output section. Multiple extraction patterns are tried to handle differences across ServiceNow versions.

---

## snow sys

Read and write system properties (`sys_properties`) from the command line. Useful for quick configuration changes without logging into the UI.

### snow sys get

```bash
snow sys get glide.email.smtp.host
snow sys get glide.ui.escape_html_minimal --json
```

Displays the property name, value, type, and description. Use `--json` for raw JSON output.

### snow sys set

```bash
# With confirmation prompt
snow sys set glide.email.active false

# Skip confirmation
snow sys set glide.smtp.host mail.example.com --yes

# Create a new property if it doesn't exist
snow sys set x_myco_myapp.feature_flag true
```

Shows the old and new values before applying. Prompts for confirmation unless `--yes` is passed. Creates the property if it does not already exist.

| Flag | Description |
|---|---|
| `--yes` | Skip the confirmation prompt |

### snow sys list

```bash
# List all glide.* properties (default)
snow sys list

# Filter by name prefix
snow sys list --filter glide.email

# Substring match (use % as wildcard)
snow sys list --filter %smtp%

# Increase the result limit
snow sys list --filter glide.ui -l 200

# JSON output
snow sys list --filter glide.security --json
```

| Flag | Description |
|---|---|
| `-f, --filter <pattern>` | Filter by property name. Plain text matches the prefix; include `%` for substring matching. |
| `-l, --limit <n>` | Max results (default: `50`) |
| `--json` | Output as a JSON array |
