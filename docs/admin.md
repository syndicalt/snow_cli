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

---

## snow approval

List and action ServiceNow approval requests (`sysapproval_approver`).

### snow approval list

```bash
# List your pending approvals (basic auth: scoped to current user automatically)
snow approval list

# All users' approvals
snow approval list --all

# Filter by state
snow approval list --state approved
snow approval list --state rejected -l 50

# JSON output
snow approval list --json
```

| Flag | Description |
|---|---|
| `--state <state>` | Filter by state: `requested`, `approved`, `rejected`, `cancelled` (default: `requested`) |
| `--all` | Show all approvers' records (default: scoped to the authenticated user for basic auth) |
| `-l, --limit <n>` | Max results (default: `25`) |
| `--json` | Output as JSON |

### snow approval approve

```bash
snow approval approve <sys_id>
snow approval approve <sys_id> --comment "Reviewed and approved"
snow approval approve <sys_id> --yes   # skip confirmation
```

### snow approval reject

```bash
snow approval reject <sys_id> --comment "Needs security review first"
snow approval reject <sys_id> --yes
```

Both `approve` and `reject` accept:

| Flag | Description |
|---|---|
| `-c, --comment <text>` | Comment to attach to the approval record |
| `--yes` | Skip the confirmation prompt |

---

## snow watch

Poll a record at a regular interval and print a diff whenever any field value changes. Press Ctrl+C to stop.

```bash
# Watch all fields on a record
snow watch incident <sys_id>

# Watch specific fields only
snow watch incident <sys_id> --fields state,assigned_to,priority

# Faster polling, specific fields
snow watch sys_update_set <sys_id> --fields state --interval 3000

# Watch an approval record
snow watch sysapproval_approver <sys_id> --fields state,comments
```

| Flag | Description |
|---|---|
| `-f, --fields <fields>` | Comma-separated list of fields to watch (default: all fields) |
| `-i, --interval <ms>` | Polling interval in milliseconds, minimum 1000 (default: `5000`) |
| `--no-display-value` | Use raw values instead of display values |

**Output format:** When one or more fields change, the timestamp, field name, old value, and new value are printed. Multi-line fields (e.g. scripts) are shown as `<N lines>` rather than their full content.

---

## snow acl

Inspect Access Control List (ACL) rules for a table. Reads from `sys_security_acl` and joins role requirements from `sys_security_acl_role`.

```bash
# All active table-level ACLs for incident
snow acl list incident

# Filter by operation
snow acl list incident --operation read
snow acl list incident --operation write

# Filter to ACLs that require a specific role
snow acl list incident --role itil
snow acl list sys_user --role admin

# Include field-level ACLs
snow acl list incident --fields

# Include inactive ACLs
snow acl list incident --inactive

# JSON output
snow acl list incident --json
```

| Flag | Description |
|---|---|
| `--operation <op>` | Filter by operation: `read`, `write`, `create`, `delete`, `execute` |
| `--role <role>` | Filter to ACLs that require a specific role (substring match) |
| `--inactive` | Include inactive ACLs (default: active only) |
| `--fields` | Include field-level ACLs in addition to table-level rules |
| `--json` | Output as JSON (includes role array per ACL) |

**Output** shows each ACL rule with its operation (colour-coded), type, and the roles required. Rules with no role requirement are flagged in yellow. Flags such as `[condition]`, `[script]`, and `[admin-overrides]` are shown inline.

---

## snow import

Import records into a ServiceNow table from a JSON array or CSV file. Supports upsert (update-or-create) and dry-run preview.

```bash
# Import a JSON array
snow import ./users.json --table sys_user

# Import a CSV file, upsert on user_name
snow import ./users.csv --table sys_user --upsert user_name

# Preview without making changes
snow import ./incidents.json --table incident --dry-run

# Skip confirmation and limit records processed
snow import ./data.csv --table x_myco_request --yes --limit 100

# Upsert incidents by number
snow import ./incidents.csv --table incident --upsert number --yes
```

| Flag | Description |
|---|---|
| `-t, --table <table>` | Target table name (required) |
| `-u, --upsert <field>` | Field to match for upsert — if a record with that field value exists it is updated, otherwise a new record is created |
| `--dry-run` | Show what would be created or updated without making any changes |
| `-l, --limit <n>` | Max records to process from the file |
| `--yes` | Skip the confirmation prompt |

**File formats:**

| Extension | Parsing |
|---|---|
| `.json` | Expects a JSON array of objects (or a single object) |
| `.csv` | RFC 4180 CSV with a header row; quoted fields and escaped quotes supported |
| Other | Tries JSON first, then CSV |

**Upsert behaviour:** For each record, if `--upsert <field>` is set and the field has a value, the CLI queries for an existing record matching `field=value`. If found, it patches the record; otherwise it creates a new one. Without `--upsert`, every row is always created.
