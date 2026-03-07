# snow-cli

A portable CLI for ServiceNow. Query tables, inspect schemas, edit and search script fields, bulk-update records, manage users and groups, handle attachments, promote update sets across environments, browse the Service Catalog, inspect Flow Designer flows, manage scoped applications, tail system logs, and generate complete applications using AI — all from your terminal.

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [snow instance](#snow-instance)
  - [snow table](#snow-table)
  - [snow schema](#snow-schema)
    - [snow schema map](#snow-schema-map)
  - [snow script](#snow-script)
  - [snow bulk](#snow-bulk)
  - [snow user](#snow-user)
  - [snow attachment](#snow-attachment)
  - [snow updateset](#snow-updateset)
  - [snow status](#snow-status)
  - [snow diff](#snow-diff)
  - [snow factory](#snow-factory)
  - [snow catalog](#snow-catalog)
  - [snow flow](#snow-flow)
  - [snow app](#snow-app)
  - [snow log](#snow-log)
  - [snow provider](#snow-provider)
  - [snow ai](#snow-ai)
- [Configuration File](#configuration-file)
- [Development](#development)

---

## Installation

**From npm (when published):**
```bash
npm install -g snow-cli
```

**From source:**
```bash
git clone <repo>
cd snow-cli
npm install
npm run build
npm link
```

Requires Node.js 18+.

---

## Quick Start

```bash
# 1. Add a ServiceNow instance
snow instance add

# 2. Query a table
snow table get incident -q "active=true" -l 10 -f "number,short_description,state,assigned_to"

# 3. Bulk-update records matching a query
snow bulk update incident -q "active=true^priority=1" --set assigned_to=admin --dry-run

# 4. Pull a script field, edit it locally, push it back
snow script pull sys_script_include <sys_id> script

# 5. Search for a pattern across all scripts in an app scope
snow script search x_myapp --contains "GlideRecord('old_table')"

# 6. Manage update sets — list, export, and promote to another instance
snow updateset list
snow updateset export "Sprint 42" --out ./updatesets
snow updateset apply ./sprint-42.xml --target prod

# 7. Add a user to a group or assign a role
snow user add-to-group john.doe "Network Support"
snow user assign-role john.doe itil

# 8. Download all attachments from a record
snow attachment pull incident <sys_id> --all --out ./downloads

# 9. Configure an AI provider and generate a feature
snow provider set openai
snow ai build "Create a script include that auto-routes incidents by category and urgency"

# 10. Compare schema/scripts between instances to detect drift
snow diff incident --against prod --fields
snow diff all --against test --scripts --scope x_myco_myapp

# 11. Run the full factory pipeline: plan → build → test → promote
snow factory "Build a hardware asset request app with approval workflow" --envs test,prod

# 11b. Run tests and auto-fix failures with the LLM optimization loop
snow factory "Create a Script Include named SLACalculator with risk level logic" --run-tests --optimize

# 12. Start an interactive session to build iteratively
snow ai chat

# 13. Browse the Service Catalog
snow catalog list
snow catalog search "VPN"
snow catalog get "Request VPN Access"

# 14. Inspect Flow Designer flows and actions
snow flow list
snow flow list --subflows --scope x_myco_myapp
snow flow get "My Approval Flow"

# 15. List scoped applications
snow app list
snow app get x_myco_myapp

# 16. Tail system logs
snow log
snow log --level err --follow
snow log app --scope x_myco_myapp
snow log tx --slow 2000
```

---

## Commands

### `snow instance`

Manage ServiceNow instance connections. Credentials are stored in `~/.snow/config.json` (mode `0600`).

| Command | Description |
|---|---|
| `snow instance add` | Interactively add an instance (prompts for alias, URL, auth type) |
| `snow instance list` | List all configured instances, showing the active one |
| `snow instance use <alias>` | Switch the active instance |
| `snow instance remove <alias>` | Remove an instance |
| `snow instance test` | Test the active instance connection |

**Adding an instance:**
```bash
# Interactive (recommended)
snow instance add

# Basic auth — non-interactive
snow instance add --alias dev --url https://dev12345.service-now.com --auth basic

# OAuth (password grant) — prompts for client ID and secret
snow instance add --alias prod --url https://prod.service-now.com --auth oauth
```

OAuth access tokens are fetched automatically using the password grant flow and cached in the config file with their expiry time. They are refreshed transparently when they expire.

---

### `snow table`

Table API CRUD operations. Output defaults to a terminal-friendly table; use `--json` for raw JSON.

```bash
# Query records (table format by default)
snow table get incident -q "active=true^priority=1" -l 20
snow table get incident -q "active=true" -f "number,short_description,assigned_to" -l 50

# Output as JSON array
snow table get incident -q "active=true" -l 5 --json

# Fetch a single record by sys_id
snow table fetch incident <sys_id>
snow table fetch incident <sys_id> -f "number,state,short_description"

# Create a record
snow table create incident -d '{"short_description":"VPN issue","urgency":"2","category":"network"}'

# Update a record
snow table update incident <sys_id> -d '{"state":"6","close_notes":"Resolved"}'

# Delete a record (prompts for confirmation)
snow table delete incident <sys_id>
snow table delete incident <sys_id> --yes   # skip confirmation
```

**`snow table get` flags:**

| Flag | Description |
|---|---|
| `-q, --query <sysparm_query>` | ServiceNow encoded query string |
| `-f, --fields <fields>` | Comma-separated field list to return |
| `-l, --limit <n>` | Max records (default: `20`) |
| `-o, --offset <n>` | Pagination offset (default: `0`) |
| `--display-value` | Return display values instead of raw values |
| `--json` | Output as a JSON array instead of a table |

**Output behaviour:** When a query returns more fields than can fit in the terminal, the CLI automatically switches to a **card layout** (one record per block) rather than trying to squash too many columns. Use `-f` to select specific fields for tabular output.

---

### `snow schema`

Inspect field definitions for any table, or generate a full cross-table schema map.

#### Field inspection

```bash
snow schema incident
snow schema sys_user --filter email         # filter fields by name or label
snow schema cmdb_ci_server --format json    # JSON output
```

Output columns: field name, label, type, max length, and flags (`M` = mandatory, `R` = read-only, `ref=<table>` for reference fields).

#### `snow schema map`

Crawl a table's reference and M2M fields to generate a complete relational schema diagram. The crawl follows references to the specified depth, building a graph of all connected tables including their scope information. Outputs Mermaid (`.mmd`) or DBML (`.dbml`) to disk.

```bash
# Mermaid diagram, depth 2 (default)
snow schema map incident

# DBML format, custom filename, saved to a directory
snow schema map incident --format dbml --out ./diagrams --name incident-full

# Follow 3 levels of references
snow schema map incident --depth 3

# Include glide_list (M2M) relationships
snow schema map incident --show-m2m

# Also crawl tables that reference incident (inbound — keep depth low)
snow schema map incident --inbound --depth 1

# Include choice field enum blocks in DBML output
snow schema map incident --format dbml --enums

# Generate the diagram then have the AI explain the data model
snow schema map incident --explain

# All options combined
snow schema map x_myco_myapp_request --depth 2 --format dbml --enums --explain --name myapp-schema
```

**Options:**

| Flag | Default | Description |
|---|---|---|
| `-d, --depth <n>` | `2` | How many levels of reference fields to follow |
| `--show-m2m` | off | Include `glide_list` fields as many-to-many relationships |
| `--format <fmt>` | `mermaid` | Output format: `mermaid` or `dbml` |
| `--out <dir>` | `.` | Directory to write the output file(s) |
| `--name <name>` | `<table>-schema` | Base filename — extension added automatically |
| `--inbound` | off | Also crawl tables that have reference fields pointing *to* this table |
| `--enums` | off | Fetch `sys_choice` values and emit Enum blocks (DBML) or `%%` comments (Mermaid) |
| `--explain` | off | Use the active AI provider to generate a plain-English explanation of the schema |

**Output files:**

| Format | File | Open with |
|---|---|---|
| Mermaid | `<name>.mmd` | VS Code Mermaid Preview, GitHub, mermaid.live |
| DBML | `<name>.dbml` | dbdiagram.io, any DBML-compatible tool |
| Explanation | `<name>.explanation.md` | Any Markdown viewer (`--explain` only) |

**How the crawl works:**

1. Fetches all fields for the root table from `sys_dictionary`, plus label and `sys_scope` via `sys_db_object`
2. For every `reference`-type field, records the relationship and queues the target table
3. Repeats for each discovered table until `--depth` is reached
4. With `--show-m2m`: also follows `glide_list` fields, shown as many-to-many edges
5. With `--inbound`: additionally queues tables that have reference fields pointing *to* the current table
6. Tables referenced by fields that fall outside the crawl depth are rendered as **stub placeholders** (marked `not crawled`) so all references in the diagram resolve without broken links

> **Tip:** `--inbound` with depth > 1 can produce very large graphs for highly-referenced tables like `sys_user` or `task`. Use `--depth 1` when combining these flags. A warning is also printed when the crawl discovers more than 50 tables.

**Scope annotations:**

Each table's application scope is fetched alongside its label. Both output formats include a scope summary header. In DBML, non-Global tables are annotated directly:

```dbml
// Scopes: Global (12), ITSM (3)
// Warning: tables from 2 scopes — cross-scope references present

Table incident [note: 'Incident | scope: ITSM'] { ... }
```

In Mermaid, scope information appears as `%%` comments at the top of the file.

**Choice enums (`--enums`):**

Queries `sys_choice` for every `choice`-type field across all crawled tables. In DBML, each set of choices becomes a named `Enum` block and the field type references it:

```dbml
Table incident {
  state incident__state [not null]
}

Enum incident__state {
  "1" [note: 'New']
  "2" [note: 'In Progress']
  "6" [note: 'Resolved']
}
```

In Mermaid, choice values are emitted as `%%` comments since `erDiagram` has no enum syntax.

**AI explanation (`--explain`):**

Requires a configured AI provider (`snow provider set`). After writing the schema file, the CLI sends the schema content to the active LLM and saves the Markdown response to `<name>.explanation.md`. The explanation is also printed to the terminal. It covers the business domain, key tables, notable relationships, and any cross-scope dependencies.

```bash
snow provider set anthropic   # configure a provider first
snow schema map incident --format dbml --explain
```

**Example output (Mermaid):**
```
%% Scopes: Global (8), ITSM (2)
incident }o--|| sys_user : "Caller"
incident }o--|| problem : "Problem"
incident }o--|| change_request : "RFC"
sys_user }o--|| cmn_department : "Department"
...
cmn_location { string sys_id }   %% stub: referenced but not crawled
```

**Example output (DBML):**
```dbml
// Scopes: Global (8), ITSM (2)

Table incident [note: 'Incident | scope: ITSM'] {
  caller_id varchar(32) [ref: > sys_user.sys_id]
  problem_id varchar(32) [ref: > problem.sys_id]
  state incident__state [not null]
}

// Placeholder tables — referenced but not crawled (increase --depth to explore)
Table cmn_schedule [note: 'not crawled'] {
  sys_id varchar(32) [pk]
}

// Choice field enums
Enum incident__state {
  "1" [note: 'New']
  "2" [note: 'In Progress']
  "6" [note: 'Resolved']
}
```

**Cardinality notation:**

| Relationship | Mermaid | Meaning |
|---|---|---|
| Reference field | `}o--\|\|` | Many records → one target |
| Glide list (M2M) | `}o--o{` | Many records ↔ many targets |

---

### `snow script`

Pull a script field to disk, open it in your editor, then push the edited version back — all in one workflow.

```bash
# Pull → edit → push (interactive)
snow script pull sys_script_include <sys_id> script

# Pull to a specific file path without opening an editor
snow script pull sys_script_include <sys_id> script --no-open -o ./my-script.js

# Push a local file to a script field
snow script push sys_script_include <sys_id> script ./my-script.js

# Push the last-pulled file for a record (no file path needed)
snow script push sys_script_include <sys_id> script

# List locally cached scripts
snow script list
```

**Supported field types and file extensions:**

| Field type | Extension |
|---|---|
| Script (default) | `.js` |
| HTML | `.html` |
| CSS | `.css` |
| XML | `.xml` |
| JSON | `.json` |

**Editor resolution order:**
1. `--editor <cmd>` flag
2. `$VISUAL` environment variable
3. `$EDITOR` environment variable
4. First found: `code`, `notepad++`, `notepad` (Windows) / `code`, `nvim`, `vim`, `nano`, `vi` (Unix)

Cached scripts are stored in `~/.snow/scripts/`.

#### `snow script search`

Search for a text pattern across script fields in a given app scope. Searches Script Includes, Business Rules, Client Scripts, UI Actions, UI Pages (HTML, client, and server scripts), and Scheduled Jobs.

```bash
# Find all scripts containing a string
snow script search x_myapp --contains "GlideRecord('incident')"

# Search only specific tables
snow script search x_myapp --contains "oldMethod" --tables sys_script_include,sys_script

# Use a JavaScript regex
snow script search x_myapp --contains "gs\.(log|warn)" --regex
```

Results show the record name, sys_id, and matching lines with line numbers (up to 5 preview lines per record).

**Options:**

| Flag | Description |
|---|---|
| `-c, --contains <pattern>` | Text or regex pattern to search for (required) |
| `-t, --tables <tables>` | Comma-separated table list (default: all 8 script tables) |
| `--regex` | Treat `--contains` as a JavaScript regex |
| `-l, --limit <n>` | Max records per table (default: `500`) |

#### `snow script replace`

Find and replace text across script fields in an app scope. Supports dry-run preview before committing changes.

```bash
# Preview what would change
snow script replace x_myapp --find "gs.log" --replace "gs.info" --dry-run

# Replace with confirmation prompt
snow script replace x_myapp --find "gs.log" --replace "gs.info"

# Replace with regex and skip confirmation
snow script replace x_myapp --find "GlideRecord\('old_table'\)" --replace "GlideRecord('new_table')" --regex --yes

# Target only specific tables
snow script replace x_myapp --find "deprecated.util" --replace "NewUtils" --tables sys_script_include
```

**Options:**

| Flag | Description |
|---|---|
| `-f, --find <pattern>` | Text to find (required) |
| `-r, --replace <text>` | Replacement text (required) |
| `-t, --tables <tables>` | Comma-separated table list (default: all 8 script tables) |
| `--regex` | Treat `--find` as a JavaScript regex |
| `-l, --limit <n>` | Max records per table (default: `500`) |
| `--dry-run` | Show matches without writing any changes |
| `--yes` | Skip confirmation prompt |

---

### `snow bulk`

Bulk update multiple records in one command. Fetches matching records, shows a preview, asks for confirmation, then patches each record.

```bash
# Preview affected records without making changes
snow bulk update incident -q "active=true^priority=1" --set state=2 --dry-run

# Update with confirmation prompt
snow bulk update incident -q "active=true^priority=1" --set state=2 --set assigned_to=admin

# Skip confirmation (useful in scripts)
snow bulk update sys_user -q "department=IT^active=true" --set location=NYC --yes

# Cap the number of records updated
snow bulk update incident -q "active=true" --set impact=2 --limit 50
```

**Options:**

| Flag | Description |
|---|---|
| `-q, --query <query>` | ServiceNow encoded query to select records (required) |
| `-s, --set <field=value>` | Field assignment — repeat for multiple fields (required) |
| `-l, --limit <n>` | Max records to update (default: `200`) |
| `--dry-run` | Show preview without making changes |
| `--yes` | Skip confirmation prompt |

The preview table shows the sys_id, display name, and new values for every record that will be updated.

---

### `snow user`

Manage group membership and role assignments for ServiceNow users. Users can be specified by `user_name`, email, display name, or sys_id.

```bash
# Add a user to a group
snow user add-to-group john.doe "Network Support"
snow user add-to-group john.doe@example.com "IT Operations" --yes

# Remove a user from a group
snow user remove-from-group john.doe "Network Support"

# Assign a role to a user
snow user assign-role john.doe itil

# Remove a role from a user
snow user remove-role john.doe itil --yes
```

Each command resolves the user and target, checks for existing membership/role to prevent duplicates, then prompts for confirmation before making any change.

| Command | Description |
|---|---|
| `snow user add-to-group <user> <group>` | Add user to a `sys_user_group` |
| `snow user remove-from-group <user> <group>` | Remove user from a `sys_user_group` |
| `snow user assign-role <user> <role>` | Grant a `sys_user_role` to a user |
| `snow user remove-role <user> <role>` | Revoke a `sys_user_role` from a user |

All subcommands accept `--yes` to skip the confirmation prompt.

---

### `snow attachment`

Download and upload file attachments on ServiceNow records via the Attachment API. Also available as `snow att`.

```bash
# List attachments on a record
snow attachment list incident <sys_id>
snow att ls incident <sys_id>

# Download all attachments to a directory
snow attachment pull incident <sys_id> --all --out ./downloads

# Download a specific attachment by file name
snow attachment pull incident <sys_id> --name report.pdf

# Upload a file as an attachment
snow attachment push incident <sys_id> ./fix-notes.pdf

# Override the auto-detected Content-Type
snow attachment push incident <sys_id> ./data.bin --type application/octet-stream
```

**`snow attachment pull` options:**

| Flag | Description |
|---|---|
| `-a, --all` | Download all attachments on the record |
| `-n, --name <file_name>` | Download a specific attachment by its file name |
| `-o, --out <dir>` | Output directory (default: current directory) |

**`snow attachment push` options:**

| Flag | Description |
|---|---|
| `-t, --type <content-type>` | Override the Content-Type header (auto-detected from extension by default) |

Content-Type is inferred from the file extension for common formats (PDF, PNG, JPG, CSV, XML, JSON, ZIP, DOCX, XLSX, etc.). Defaults to `application/octet-stream` for unknown types.

---

### `snow updateset`

Manage ServiceNow update sets from the CLI — list, inspect, export, import, and diff. Also available as `snow us`.

| Command | Description |
|---|---|
| `snow updateset list` | List update sets on the instance |
| `snow updateset current` | Show the currently active update set |
| `snow updateset set <name>` | Set the active update set |
| `snow updateset show <name>` | Show details and all captured items |
| `snow updateset capture <name> --add <table:sys_id>` | Add specific records to an update set |
| `snow updateset export <name>` | Download the update set as an XML file |
| `snow updateset apply <xml-file>` | Upload an XML file to another instance |
| `snow updateset diff <set1> <set2>` | Compare captured items between two update sets |

Names or sys_ids are accepted wherever `<name>` appears.

#### `snow updateset list`

```bash
# All in-progress and complete update sets (default: excludes "ignore")
snow updateset list

# Filter by state
snow updateset list --state "in progress"
snow updateset list --state complete --limit 20
```

**Options:**

| Flag | Description |
|---|---|
| `-s, --state <state>` | Filter by state: `in progress`, `complete`, `ignore` (default: all except `ignore`) |
| `-l, --limit <n>` | Max results (default: `50`) |

Output columns: **Name**, **State**, **Application** (scope), **Created by**, **Created on**. In-progress sets are highlighted in green; the active set is marked with a ★.

#### `snow updateset current`

```bash
snow updateset current
```

Shows the update set that is currently active for the authenticated user (read from `sys_user_preference`). REST API writes go to this update set.

#### `snow updateset set <name>`

```bash
snow updateset set "Sprint 42 - Incident fixes"
snow updateset set a1b2c3d4e5f6...   # sys_id also accepted
```

Stores the selection in `sys_user_preference` so subsequent REST API operations (table updates, script pushes, etc.) are captured into the selected update set.

#### `snow updateset show <name>`

```bash
snow updateset show "Sprint 42 - Incident fixes"
snow updateset show "Sprint 42 - Incident fixes" --limit 200
```

Displays update set metadata followed by a table of every captured item (`sys_update_xml`) with type, action, and target name.

#### `snow updateset capture <name> --add <table:sys_id>`

Force-captures specific records into an update set without modifying them:

```bash
# Capture a single record
snow updateset capture "My Update Set" --add sys_script_include:abc123...

# Capture multiple records at once
snow updateset capture "My Update Set" \
  --add sys_script_include:abc123... \
  --add sys_script:def456... \
  --yes
```

**How it works:** temporarily activates the target update set for the authenticated user, performs a no-op PATCH on each record to trigger ServiceNow's capture mechanism, then restores the previously active update set. The records themselves are not changed.

#### `snow updateset export <name>`

```bash
# Export to current directory
snow updateset export "Sprint 42 - Incident fixes"

# Export to a specific directory
snow updateset export "Sprint 42 - Incident fixes" --out ./updatesets
```

Calls `/export_update_set.do` and saves the XML to `<safe-name>.xml`. The file can be imported into any ServiceNow instance using `snow updateset apply` or via the ServiceNow UI.

#### `snow updateset apply <xml-file>`

Import an update set XML into an instance. Creates a **Retrieved Update Set** record that you then load, preview, and commit.

```bash
# Apply to the active instance
snow updateset apply ./sprint-42-incident-fixes.xml

# Apply to a different instance by alias
snow updateset apply ./sprint-42-incident-fixes.xml --target prod

# Skip confirmation
snow updateset apply ./sprint-42-incident-fixes.xml --target prod --yes
```

After uploading, the CLI prints the direct link to the Retrieved Update Set record and instructions for the load → preview → commit steps, which must be completed in the ServiceNow UI (or scripted separately).

#### `snow updateset diff <set1> <set2>`

Compare the captured items of two update sets side by side:

```bash
snow updateset diff "Sprint 42" "Sprint 43"
snow updateset diff a1b2c3...  b4c5d6...   # sys_ids
```

Output shows:
- Items only in the first set (removed in second) — in red
- Items only in the second set (added in second) — in green
- Items in both sets, flagged if the action changed (e.g. `INSERT_OR_UPDATE` → `DELETE`) — in yellow
- A summary line: `3 removed  5 added  1 changed  42 unchanged`

---

### `snow status`

Print a dashboard-style health and stats overview of the active instance. All sections run in parallel and degrade gracefully to `N/A` when the authenticated user lacks access.

```bash
snow status

# Omit syslog sections (faster for non-admin users, or when syslog is restricted)
snow status --no-errors
```

**Sections:**

| Section | What it shows |
|---|---|
| **Instance** | ServiceNow version (`glide.version`), cluster node count and status |
| **Users** | Total active user count |
| **Development** | Custom scoped app count, custom table count (`x_` prefix), in-progress update sets (up to 5, with author) |
| **Syslog errors** | Error count in the last hour + last 3 error messages with timestamps |
| **Scheduler errors** | Failed scheduled job count in the last 24h + last 3 messages |

**Example output:**
```
────────────────────────────────────────────────────
  snow-cli  ·  dev  (https://dev12345.service-now.com)
────────────────────────────────────────────────────

  Instance
  ────────
  Version               Utah Patch 7
  Cluster nodes         3 active / 3 total

  Users
  ─────
  Active users          1,234

  Development
  ───────────
  Custom apps           5
  Custom tables         34
  Update sets           2 in progress
                        • My Feature Branch     admin
                        • Hotfix-001             dev.user

  Syslog errors  (last hour)
  ──────────────────────────
  Error count           3
                        [10:34:01] Script error in BusinessRule 'Assign P...
                        [10:22:45] Invalid GlideRecord field: assigne_to

  Scheduler errors  (last 24h)
  ────────────────────────────
  Failed jobs           0
```

> **Note:** Version and cluster node stats require admin access to `sys_properties` and `sys_cluster_state`. Syslog sections require read access to the `syslog` table. Sections that can't be read are shown as `N/A` rather than failing the command.

---

### `snow diff`

Compare schema field definitions and script content between two configured instances. Useful for detecting drift — fields added/removed/changed, or scripts that diverged between dev and test/prod.

```bash
# Compare field definitions for a table
snow diff incident --against prod --fields

# Compare script content in an app scope between dev and test
snow diff all --against test --scripts --scope x_myco_myapp

# Compare both fields and scripts
snow diff sys_script_include --against prod --fields --scripts

# Output as Markdown (for pasting into docs or tickets)
snow diff incident --against prod --fields --markdown

# Output as JSON (for scripting or CI pipelines)
snow diff incident --against prod --fields --scripts --json

# Save the diff report to a file (ANSI stripped automatically)
snow diff all --against prod --scripts --scope x_myco_myapp --output ./diff-report.txt
```

The source is always the **active instance** (`snow instance use <alias>` to set it). `--against` specifies the target instance alias.

**Arguments:**

| Argument | Description |
|---|---|
| `<table>` | Table to compare for `--fields`. Use `all` with `--scripts` to scan all script-bearing tables. |

**Options:**

| Flag | Description |
|---|---|
| `--against <alias>` | Target instance alias to compare against (required) |
| `--fields` | Compare `sys_dictionary` field definitions |
| `--scripts` | Compare script field content across script-bearing tables |
| `--scope <prefix>` | Filter scripts by application scope prefix (e.g. `x_myco_myapp`) |
| `--markdown` | Output as Markdown for docs/tickets |
| `--json` | Output structured JSON (fields rows + script hunks) |
| `--output <file>` | Write the diff to a file (ANSI color codes stripped automatically) |

At least one of `--fields` or `--scripts` is required.

#### Field diff output

Shows every field that was **added** (only in target), **removed** (only in source), or **changed** (type, max_length, mandatory, read_only, reference, or active flag differs):

```
  Schema diff: incident
  ──────────────────────────────────────────────────
  Field                  Status    Detail
  ──────────────────────────────────────────────────────────────────────────
  x_myco_priority_code   added     type=string
  x_myco_legacy_flag     removed   type=boolean
  category               changed   max_length: 40 → 100
```

#### Script diff output

For each script-bearing table, shows scripts **added** (only in target), **removed** (only in source), or **changed** (content differs), with a contextual line diff for changed scripts:

```
  Script diff: sys_script_include
  ──────────────────────────────────────────────────
  + NewUtils  (only in prod)
  - OldHelper (only in dev)
  ~ IncidentRouter

  IncidentRouter
  --- dev
  +++ prod
  @@ lines 12–16 @@
     var gr = new GlideRecord('incident');
  -  gr.addQuery('state', 1);
  +  gr.addQuery('state', 2);
     gr.query();
```

**Script tables scanned** (when using `--scripts`):

| Table | Description |
|---|---|
| `sys_script_include` | Script Includes |
| `sys_script` | Business Rules |
| `sys_script_client` | Client Scripts |
| `sys_ui_action` | UI Actions |
| `sysauto_script` | Scheduled Script Executions |

---

### `snow factory`

AI-orchestrated multi-component application pipeline. Takes a natural language description, breaks it into a dependency-ordered build plan, generates each component via LLM, pushes to the source instance, optionally generates and runs ATF tests, then promotes through additional environments.

```bash
# Plan and build (deploys to active instance only)
snow factory "Build an employee onboarding app with custom tables, approval workflow, and email notifications"

# Full pipeline: dev → test → prod
snow factory "Build a hardware asset request app" --envs test,prod

# Force all artifacts into an existing application scope
snow factory "Add an approval business rule to the asset request app" --scope x_myco_assetreq

# Preview the plan without building
snow factory "Build an incident escalation app" --dry-run

# Generate and immediately run ATF tests
snow factory "Build a change approval workflow" --run-tests

# Generate ATF tests, run them, and auto-fix failures with the LLM (up to 3 retries)
snow factory "Create a priority calculator script include" --run-tests --optimize

# Same, but allow up to 5 fix iterations
snow factory "Create a priority calculator script include" --run-tests --optimize --max-retries 5

# Skip ATF test generation (faster)
snow factory "Add a business rule to auto-assign P1 incidents" --skip-tests

# Resume a failed or interrupted run
snow factory "..." --resume abc12345

# List recent factory runs
snow factory "" --list
```

**Options:**

| Flag | Description |
|---|---|
| `--envs <aliases>` | Comma-separated instance aliases to promote to after source, in order (e.g. `test,prod`) |
| `--scope <prefix>` | Override the application scope prefix for all artifacts (e.g. `x_myco_myapp`) |
| `--skip-tests` | Skip ATF test generation |
| `--run-tests` | Execute the generated ATF test suite immediately after pushing |
| `--optimize` | After running tests, auto-fix failures via LLM feedback loop (implies `--run-tests`) |
| `--max-retries <n>` | Max optimization iterations when using `--optimize` (default: `3`) |
| `--dry-run` | Show the generated plan only — no builds, no deployments |
| `--resume <id>` | Resume a previous run from its checkpoint (see `--list`) |
| `--list` | Show recent factory runs and their component completion status |

#### Pipeline phases

```
  [1/N] Planning
        LLM analyzes the prompt → structured plan with components, dependencies, risks
        Displays plan for review → confirm before proceeding

  [2/N] Building components
        Each component is built sequentially in dependency order
        Tables first, then script includes, then business rules / client scripts
        Each component saved to ~/.snow/factory/<run-id>/<component>/

  [3/N] Pushing to <source-instance>
        All artifacts pushed to the active instance via Table API
        Creates or updates existing records

  [4/N] Generating ATF tests (unless --skip-tests)
        LLM generates a test suite with server-side script assertions
        Tests pushed to the instance as sys_atf_test + sys_atf_step records
        If --run-tests or --optimize: suite is executed via the CICD API
        Pass/fail counts and per-test results are displayed

        If --optimize and tests failed:
          → LLM receives the failing test names + error messages + artifact source
          → Generates corrected artifacts, re-pushes them, re-runs the suite
          → Repeats until all pass or --max-retries is exhausted

  [5/N] Promoting to <env>  (once per additional env in --envs)
        Checks for pre-existing artifacts on the target
        Confirms before applying
        Uploads combined update set XML to sys_remote_update_set
        Prints direct link → then Load → Preview → Commit in the UI
```

#### Checkpointing and resume

Every factory run is checkpointed to `~/.snow/factory/<run-id>/state.json` after each completed phase. If a run is interrupted (network error, LLM failure, manual cancellation), resume it:

```bash
snow factory "" --list                 # find the run ID
snow factory "" --resume abc12345     # resume from last successful phase
```

The resume prompt argument is ignored when `--resume` is provided — the original prompt and plan are loaded from the checkpoint.

#### Auto-optimization loop

When `--optimize` is set, the factory runs an automated fix cycle after the initial ATF test run. For each iteration:

1. Failing test names and error messages are collected from the `sys_atf_result` table
2. The current source code of every script-bearing artifact is extracted from the local manifest
3. A structured fix prompt is sent to the LLM — no questions, just a corrected build
4. Fixed artifacts are merged into the build (replaced by `type + name`), re-pushed to the instance
5. The existing ATF suite is re-run; if all tests pass, the loop exits early

```
  [Optimize 1/3]  2 test(s) failing — asking LLM to fix...
  ────────────────────────────────────────────────
  Patching:
    ~ script_include     SLACalculator
  Re-pushing fixed artifacts to instance...
  Re-running ATF tests...
  3/3 tests passed
    ✓ Test low risk level
    ✓ Test medium risk level
    ✓ Test high risk level

  ✔ All tests passing after optimization!
```

If failures persist after all retries, a warning is shown and the best-effort build is kept on disk.

**Requirements for ATF test execution:**
- The `sn_cicd` plugin must be active on the instance
- The authenticated user must have the `sn_cicd` role
- ATF must be enabled (`System ATF` → `Properties` → `Enable ATF`)

The optimization loop uses the same LLM provider as the build. Each iteration costs one LLM call, so `--max-retries 3` (default) means at most 3 additional calls beyond the initial build.

#### Example output

```
  ────────────────────────────────────────────────────────
  snow factory  ·  anthropic
  Source: dev  https://dev12345.service-now.com
  Pipeline: dev → test → prod
  ────────────────────────────────────────────────────────

  [1/5] Planning
  ────────────────────────────────────────────────────────
  Employee Onboarding App
  Automates new-hire onboarding with task assignment, document tracking, and notifications
  scope: x_myco_onboard  v1.0.0

  Components (3) — ~14 artifacts
  1. Custom Tables          (no deps)
     Employee and HR document tracking tables
  2. Script Includes        ← depends on: tables
     OnboardingUtils class for task generation and notifications
  3. Business Rules         ← depends on: tables, scripts
     Auto-assign tasks on employee insert; notify on completion

  ⚠ Risks:
    • SMTP server must be configured for email notifications
    • MID Server required for Active Directory sync

  ? Execute factory pipeline? (3 components → dev → test → prod) Yes

  [2/5] Building components
  ────────────────────────────────────────────────────────
  ✓ Custom Tables  2 artifacts
     + table            x_myco_onboard_employee
     + table            x_myco_onboard_doc
  ✓ Script Includes  1 artifact
     + script_include   x_myco_onboard.OnboardingUtils
  ✓ Business Rules  3 artifacts
     + business_rule    Auto-Assign Tasks on Insert
     + business_rule    Notify Manager on Completion
     + scheduled_job    Weekly Onboarding Report

  ✔ 6 total artifacts combined

  [3/5] Pushing to dev
  ────────────────────────────────────────────────────────
  created  Table             x_myco_onboard_employee
  created  Table             x_myco_onboard_doc
  created  Script Include    x_myco_onboard.OnboardingUtils
  created  Business Rule     Auto-Assign Tasks on Insert
  ...
  6 pushed, 0 failed

  [4/5] Generating ATF tests
  ────────────────────────────────────────────────────────
  Employee Onboarding App — ATF Suite
  4 tests generated
    • Test employee record creation and field defaults  (3 steps)
    • Test OnboardingUtils task generation  (2 steps)
    • Test business rule fires on insert  (3 steps)
    • Test manager notification trigger  (2 steps)
  ✓ Test suite created
    https://dev12345.service-now.com/nav_to.do?uri=sys_atf_test_suite.do?sys_id=...
  Running ATF tests...
  4/4 tests passed
    ✓ Test employee record creation and field defaults
    ✓ Test OnboardingUtils task generation
    ✓ Test business rule fires on insert
    ✓ Test manager notification trigger
```

#### Permission-denied errors

Some artifact types require elevated roles to push via the Table API:

| Artifact | Required role |
|---|---|
| `table` (`sys_db_object`) | `admin` or `delegated_developer` |
| `decision_table` (`sys_decision`) | `admin` or `developer` |
| `flow_action` (`sys_hub_action_type_definition`) | `flow_designer` + `IntegrationHub` |

When a 403 is encountered the artifact is **skipped** (shown in yellow) rather than failing the whole run. The generated update set XML is always written to disk regardless — use it to import via the UI when Table API access is restricted:

```
  System Update Sets → Retrieved Update Sets → Import XML → Load → Preview → Commit
```

---

### `snow catalog`

Browse and search the ServiceNow Service Catalog.

```bash
# List catalog items
snow catalog list
snow catalog list --category "Hardware"
snow catalog list --catalog "Employee Center" -l 50

# Search by name or description
snow catalog search "VPN"
snow catalog search "laptop" --limit 10

# Get details for a specific item (by name or sys_id)
snow catalog get "Request VPN Access"
snow catalog get abc1234...

# List catalog categories
snow catalog categories
snow catalog categories --catalog "IT Catalog"
```

**`snow catalog list` options:**

| Flag | Description |
|---|---|
| `-q, --query <encoded>` | Encoded query filter |
| `--category <name>` | Filter by category name |
| `--catalog <name>` | Filter by catalog title |
| `-l, --limit <n>` | Max records (default: `25`) |
| `--json` | Output as JSON |

**`snow catalog search` options:**

| Flag | Description |
|---|---|
| `-l, --limit <n>` | Max records (default: `20`) |
| `--json` | Output as JSON |

**`snow catalog categories` options:**

| Flag | Description |
|---|---|
| `--catalog <name>` | Filter by catalog title |
| `-l, --limit <n>` | Max records (default: `100`) |
| `--json` | Output as JSON |

Sub-categories are indented based on their depth in the `full_name` hierarchy.

---

### `snow flow`

List and inspect Flow Designer flows, subflows, and custom actions.

```bash
# List flows
snow flow list
snow flow list --scope x_myco_myapp
snow flow list -l 50

# List subflows instead
snow flow list --subflows
snow flow list --subflows --scope x_myco_myapp

# Get details and inputs for a specific flow (by name or sys_id)
snow flow get "My Approval Flow"
snow flow get abc1234...

# List custom Flow Designer actions
snow flow actions
snow flow actions --scope x_myco_myapp
```

**`snow flow list` options:**

| Flag | Description |
|---|---|
| `--subflows` | Show subflows instead of flows |
| `--scope <prefix>` | Filter by application scope prefix |
| `-q, --query <encoded>` | Additional encoded query filter |
| `-l, --limit <n>` | Max records (default: `25`) |
| `--json` | Output as JSON |

**`snow flow actions` options:**

| Flag | Description |
|---|---|
| `--scope <prefix>` | Filter by application scope prefix |
| `-q, --query <encoded>` | Additional encoded query filter |
| `-l, --limit <n>` | Max records (default: `25`) |
| `--json` | Output as JSON |

`snow flow get` shows flow metadata, trigger type, run-as setting, and the list of typed input variables. It also prints the direct Flow Designer URL for the record.

Active flows are shown with a green `●`; inactive with a red `○`.

---

### `snow app`

List and inspect scoped applications on the active instance.

```bash
# List custom scoped applications (sys_app)
snow app list

# Include all system scopes (sys_scope)
snow app list --all

# Filter with an encoded query
snow app list -q "vendor=Acme Corp"

# Get details for a specific app by scope prefix or name
snow app get x_myco_myapp
snow app get "My Custom App"
snow app get abc1234...   # sys_id also accepted
```

**`snow app list` options:**

| Flag | Description |
|---|---|
| `--all` | Include all system scopes, not just custom applications |
| `-q, --query <encoded>` | Encoded query filter |
| `-l, --limit <n>` | Max records (default: `50`) |
| `--json` | Output as JSON |

`snow app get` shows scope prefix, sys_id, version, vendor, created/updated dates, and whether the scope has update set entries. It also prints helpful next-step commands for `snow factory` and `snow diff`.

---

### `snow log`

View system and application logs from the active instance.

```bash
# System log (default subcommand)
snow log
snow log system
snow log --level err
snow log --source Evaluator --limit 100

# Filter by scope
snow log --scope x_myco_myapp

# Follow mode — polls for new entries every 5 seconds
snow log --follow
snow log --follow --interval 10000

# Application log (requires admin role)
snow log app
snow log app --scope x_myco_myapp

# Transaction log
snow log tx
snow log tx --slow 2000   # only show responses > 2000ms
```

#### `snow log system` (default)

Queries the `syslog` table. Output columns: timestamp, level, source, message.

| Flag | Description |
|---|---|
| `--level <level>` | Filter by level: `err`, `warn`, `info`, `debug` |
| `--source <source>` | Filter by log source (e.g. `Evaluator`, `Script`) |
| `--scope <prefix>` | Filter by application scope prefix |
| `-q, --query <encoded>` | Additional encoded query filter |
| `-l, --limit <n>` | Max records (default: `50`) |
| `--follow` | Poll for new entries (Ctrl+C to stop) |
| `--interval <ms>` | Polling interval in ms when using `--follow` (default: `5000`) |
| `--json` | Output as JSON |

#### `snow log app`

Queries the `syslog_app_scope` table, which contains application-level log entries written by `gs.log()`, `gs.warn()`, etc. **Requires the `admin` role** — a clear error is shown if access is denied.

| Flag | Description |
|---|---|
| `--scope <prefix>` | Filter by application scope prefix |
| `--source <source>` | Filter by log source |
| `-l, --limit <n>` | Max records (default: `50`) |
| `--follow` | Poll for new entries |
| `--interval <ms>` | Polling interval in ms (default: `5000`) |
| `--json` | Output as JSON |

#### `snow log tx`

Queries the `syslog_transaction` table. Output columns: timestamp, HTTP status, response time (highlighted red if > 2s), username, URL.

| Flag | Description |
|---|---|
| `-l, --limit <n>` | Max records (default: `25`) |
| `--slow <ms>` | Only show transactions slower than this many milliseconds |
| `--json` | Output as JSON |

---

#### `snow ai test <path>`

Generate ATF tests for any previously generated build and push them to the active instance. Usable independently of `snow factory`.

```bash
# Generate and push tests for a build
snow ai test ./my-build/

# Generate, push, and immediately run
snow ai test ./my-build/ --run

# Custom suite name
snow ai test ./my-build/my-build.manifest.json --suite-name "Sprint 42 — Onboarding Tests"
```

**Options:**

| Flag | Description |
|---|---|
| `--run` | Execute the test suite immediately after pushing via the ATF API |
| `--suite-name <name>` | Override the generated suite name |

Requires access to `sys_atf_step_config`, `sys_atf_test`, `sys_atf_test_suite`, and `sys_atf_step` tables. ATF must be enabled on the instance.

---

### `snow provider`

Configure LLM providers used by `snow ai`. API keys and model preferences are stored in `~/.snow/config.json`.

| Command | Description |
|---|---|
| `snow provider set <name>` | Add or update a provider (prompts for key and model) |
| `snow provider list` | List all configured providers |
| `snow provider use <name>` | Set the active provider |
| `snow provider show` | Show the active provider details |
| `snow provider test [name]` | Send a test message to verify connectivity |
| `snow provider remove <name>` | Remove a provider configuration |

**Supported providers:**

| Name | Models | Notes |
|---|---|---|
| `openai` | `gpt-4o`, `gpt-4-turbo`, `gpt-4o-mini`, … | Requires OpenAI API key |
| `anthropic` | `claude-opus-4-6`, `claude-sonnet-4-6`, … | Requires Anthropic API key |
| `xai` | `grok-3`, `grok-2`, … | Requires xAI API key; uses OpenAI-compatible API |
| `ollama` | `llama3`, `mistral`, `codellama`, … | Local inference; no API key needed |

**Setup examples:**

```bash
# OpenAI (prompts interactively for key and model)
snow provider set openai

# Anthropic
snow provider set anthropic

# xAI / Grok
snow provider set xai

# Ollama (local — no key required)
snow provider set ollama --model llama3
snow provider set ollama --model codellama --url http://localhost:11434

# Non-interactive with flags
snow provider set openai --key sk-... --model gpt-4o

# Switch between configured providers
snow provider use anthropic
snow provider use openai

# Verify a provider is working
snow provider test
snow provider test anthropic
```

---

### `snow ai`

Generate ServiceNow applications using an LLM. The AI produces structured artifacts that are exported as an importable **update set XML** file and optionally pushed directly to your instance via the Table API. When a request warrants it, the AI automatically creates a **scoped application** to namespace the artifacts.

#### Supported artifact types

| Type | ServiceNow table(s) | Description |
|---|---|---|
| `script_include` | `sys_script_include` | Reusable server-side JavaScript class |
| `business_rule` | `sys_script` | Auto-triggers on table insert/update/delete/query |
| `client_script` | `sys_client_script` | Browser-side form script (onLoad, onChange, onSubmit) |
| `ui_action` | `sys_ui_action` | Form button or context menu item |
| `ui_page` | `sys_ui_page` | Custom HTML page with Jelly templating |
| `scheduled_job` | `sys_trigger` | Script that runs on a schedule |
| `table` | `sys_db_object` + `sys_dictionary` + `sys_choice` | Custom database table with typed columns and choice lists |
| `decision_table` | `sys_decision` + children | Ordered rule set mapping input conditions to an output value |
| `flow_action` | `sys_hub_action_type_definition` + children | Reusable custom action for Flow Designer |

#### Scoped applications

The AI automatically determines whether a build warrants its own application scope. Scope is added when:
- The request creates two or more custom tables
- The request is described as an "application" or "module"
- A distinct namespace is needed to avoid naming conflicts

When a scope is generated, the build includes a `sys_app` record and every artifact is stamped with `sys_scope`/`sys_package`. All custom table names and script include API names are automatically prefixed (e.g. `x_myco_myapp_tablename`). The scope is shown in the build summary:

```
My Incident App
  scope: x_myco_incapp  v1.0.0

+ table            x_myco_incapp_request
+ script_include   x_myco_incapp.RequestUtils
+ business_rule    Auto-Assign on Insert
```

For Table API push, the CLI resolves or creates the scoped application on the target instance before pushing artifacts.

#### `snow ai build <prompt>`

Generate a ServiceNow application from a text description. The AI may ask clarifying questions before generating — answer them interactively and the build proceeds once the AI has enough information. Saves output to a directory named after the update set.

```bash
snow ai build "Create a script include that routes incidents based on category and urgency"

snow ai build "Add a before business rule on the incident table that sets priority = urgency + impact when a record is inserted"

# Save to a custom directory
snow ai build "Create a client script that hides the CI field when category is Software" --output my-feature

# Push artifacts directly to the active instance after generating
snow ai build "Create a scheduled job that closes resolved incidents older than 30 days" --push

# Use a specific provider for this request only
snow ai build "..." --provider anthropic

# Debug mode — prints raw LLM response and full error traces
snow ai build "..." --debug
```

**Interactive clarification:** If your prompt is vague or the AI needs more detail, it will ask targeted questions before generating. You answer in the terminal and the conversation continues until the AI produces the final build.

```
AI > To generate the right artifacts, a few questions:
     1. Which table should the business rule operate on?
     2. Should it fire on insert, update, or both?

You > incident table, on insert only

[AI generates the build]
```

**Post-build flow:** After generating, the CLI presents two optional prompts:

1. **Review artifacts** — opens an interactive selector to inspect and edit any code field in your preferred editor before deploying
2. **Push to instance** — confirm to deploy directly, or decline to deploy later with `snow ai push`

**Output structure:**
```
incident-priority-router/
  incident-priority-router.xml            ← importable update set XML
  incident-priority-router.manifest.json  ← artifact manifest for snow ai push/review
```

**Importing the update set in ServiceNow:**
1. Navigate to **System Update Sets → Retrieved Update Sets**
2. Click **Import Update Set from XML**
3. Upload the `.xml` file
4. Click **Load Update Set**, then **Preview**, then **Commit**

**Generating tables:**
```
snow ai build "Create a custom table for tracking hardware asset requests with fields for requester, asset type, urgency, and status"
```
The AI generates `sys_db_object` + `sys_dictionary` entries for each column, plus `sys_choice` records for any choice fields. If the table extends `task`, inherited fields (number, state, assigned_to, etc.) are not re-declared.

**Generating decision tables:**
```
snow ai build "Create a decision table that maps urgency and impact values to a priority level"
```
Produces a `sys_decision` record with input columns, ordered rules, and per-rule conditions. Decision tables are evaluated top-down — the first matching rule wins.

**Generating flow actions:**
```
snow ai build "Create a Flow Designer action that creates an incident from an email subject and body and returns the sys_id"
```
Produces a `sys_hub_action_type_definition` with typed input and output variables. The action appears in the Flow Designer action picker under the specified category and can be used in any flow or subflow.

**Generating a scoped application:**
```
snow ai build "Build a full hardware asset request application with a custom table, approval workflow script include, and email notification business rule"
```
When the AI determines a scope is appropriate it generates the `sys_app` record and prefixes all custom artifacts automatically. You can also explicitly ask for a scope:
```
snow ai build "Create a scoped application called 'HR Onboarding' with scope prefix x_myco_hronboard ..."
```

#### `snow ai chat`

Interactive multi-turn session. The AI can ask clarifying questions before generating, and refines artifacts as the conversation continues. The update set is re-saved to disk automatically after each generation.

```bash
snow ai chat
snow ai chat --push          # auto-push to instance on each generation
snow ai chat --debug         # show raw LLM responses
snow ai chat --output ./my-app  # save all builds to a specific directory
```

**In-session commands:**

| Command | Action |
|---|---|
| `/status` | Show the current build summary and artifact list |
| `/save` | Write the current XML and manifest to disk |
| `/push` | Push the current build to the active ServiceNow instance |
| `/clear` | Reset the session (clears history and current build) |
| `/exit` | Quit |

After each generation, the CLI prompts whether to push to the active instance (unless `--push` is set, in which case it pushes automatically).

**Example session:**
```
You > I want to build an incident auto-assignment feature

AI > To generate the right artifacts, a few questions:
     1. Which teams/groups should incidents be routed to?
     2. What fields determine the routing — category, urgency, location, or something else?
     3. Should assignment happen on insert only, or also on update?

You > Route by category: Network → Network Ops, Software → App Support.
      Assignment on insert only.

AI > [generates script include + business rule]

+ script_include     IncidentRouter
+ business_rule      Auto-Assign Incident on Insert

✔ incident-auto-assignment/
    incident-auto-assignment.xml
    incident-auto-assignment.manifest.json

Push 2 artifact(s) to dev (https://dev12345.service-now.com)? (y/N)

You > Also add a UI action button to manually re-trigger the routing

AI > [generates updated build with all three artifacts]

+ script_include     IncidentRouter        (unchanged)
+ business_rule      Auto-Assign ...       (unchanged)
+ ui_action          Re-Route Incident     ← new
```

#### `snow ai review <path>`

Review and edit a previously generated build. Opens an interactive artifact selector, shows code with line numbers, and lets you open any field in your editor. Changes are saved back to the XML and manifest immediately. After reviewing, you can optionally push the (modified) build to the active instance.

```bash
# Review from a build directory
snow ai review ./incident-auto-assignment/

# Review from a manifest file
snow ai review ./incident-auto-assignment/incident-auto-assignment.manifest.json

# Review from the XML file (locates the sibling .manifest.json automatically)
snow ai review ./incident-auto-assignment/incident-auto-assignment.xml
```

**Review workflow:**
1. Select an artifact from the list
2. The code is printed with line numbers
3. Confirm to open in your editor (uses `$VISUAL`, `$EDITOR`, or auto-detected editor)
4. Save and close the editor — changes are written back to disk immediately
5. Select another artifact or choose **Done reviewing**
6. Confirm whether to push the build to the active instance

#### `snow ai push <path>`

Push a previously generated build to the active instance via Table API.

```bash
# Push from a build directory
snow ai push ./incident-auto-assignment/

# Push from a manifest file
snow ai push ./incident-auto-assignment/incident-auto-assignment.manifest.json
```

**Push behaviour per artifact type:**

| Artifact | Strategy |
|---|---|
| script_include, business_rule, etc. | Looks up by name — creates or updates the single record |
| `table` | Upserts `sys_db_object`; upserts each `sys_dictionary` column by table+element; upserts `sys_choice` rows by table+element+value |
| `decision_table` | Upserts `sys_decision`; deletes and recreates all input columns and rules on update |
| `flow_action` | Upserts `sys_hub_action_type_definition`; deletes and recreates all input/output variables on update |
| Scoped build | Resolves or creates the `sys_app` record first; stamps `sys_scope`/`sys_package` on every record |

---

## Configuration File

All settings are stored in `~/.snow/config.json`. The directory is created with mode `0700` and the file with `0600`.

```json
{
  "activeInstance": "dev",
  "instances": {
    "dev": {
      "alias": "dev",
      "url": "https://dev12345.service-now.com",
      "auth": {
        "type": "basic",
        "username": "admin",
        "password": "your-password"
      }
    },
    "prod": {
      "alias": "prod",
      "url": "https://prod.service-now.com",
      "auth": {
        "type": "oauth",
        "clientId": "...",
        "clientSecret": "...",
        "accessToken": "...",
        "tokenExpiry": 1700000000000
      }
    }
  },
  "ai": {
    "activeProvider": "openai",
    "providers": {
      "openai": {
        "model": "gpt-4o",
        "apiKey": "sk-..."
      },
      "anthropic": {
        "model": "claude-opus-4-6",
        "apiKey": "sk-ant-..."
      },
      "xai": {
        "model": "grok-3",
        "apiKey": "xai-...",
        "baseUrl": "https://api.x.ai/v1"
      },
      "ollama": {
        "model": "llama3",
        "baseUrl": "http://localhost:11434"
      }
    }
  }
}
```

---

## Development

```bash
npm run dev    # Watch mode — rebuilds on every file change
npm run build  # One-time production build to dist/
```

The entry point is `src/index.ts`. Commands live in `src/commands/`, shared utilities in `src/lib/`.

**Project structure:**
```
src/
  index.ts                  CLI entry point and command registration
  commands/
    instance.ts             snow instance
    table.ts                snow table
    schema.ts               snow schema
    script.ts               snow script (pull/push/list/search/replace)
    bulk.ts                 snow bulk (update)
    user.ts                 snow user (add-to-group/remove-from-group/assign-role/remove-role)
    attachment.ts           snow attachment (list/pull/push)
    updateset.ts            snow updateset (list/current/set/show/capture/export/apply/diff)
    status.ts               snow status
    diff.ts                 snow diff (cross-instance schema/script comparison)
    factory.ts              snow factory (AI-orchestrated multi-env app pipeline)
    catalog.ts              snow catalog (Service Catalog browse/search)
    flow.ts                 snow flow (Flow Designer flows, subflows, actions)
    app.ts                  snow app (scoped application metadata)
    log.ts                  snow log (system, app, and transaction logs)
    provider.ts             snow provider
    ai.ts                   snow ai (build, chat, review, push)
  lib/
    config.ts               Config file read/write + instance and provider helpers
    client.ts               ServiceNow HTTP client (axios, basic + OAuth auth)
    llm.ts                  LLM provider abstraction (OpenAI, Anthropic, xAI, Ollama)
    sn-context.ts           ServiceNow system prompt and artifact type definitions
    update-set.ts           XML update set generation and Table API push
    atf.ts                  ATF test generation and execution utilities
  types/
    index.ts                Shared TypeScript interfaces
```
