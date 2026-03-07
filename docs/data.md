---
title: Data Commands
nav_order: 4
---

# Data Commands
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow table

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

### snow table get flags

| Flag | Description |
|---|---|
| `-q, --query <sysparm_query>` | ServiceNow encoded query string |
| `-f, --fields <fields>` | Comma-separated field list to return |
| `-l, --limit <n>` | Max records (default: `20`) |
| `-o, --offset <n>` | Pagination offset (default: `0`) |
| `--display-value` | Return display values instead of raw values |
| `--json` | Output as a JSON array instead of a table |

**Output behaviour:** When a query returns more fields than can fit in the terminal, the CLI automatically switches to a **card layout** (one record per block). Use `-f` to select specific fields for tabular output.

---

## snow schema

Inspect field definitions for any table, or generate a full cross-table schema map.

### Field inspection

```bash
snow schema incident
snow schema sys_user --filter email         # filter fields by name or label
snow schema cmdb_ci_server --format json    # JSON output
```

Output columns: field name, label, type, max length, and flags (`M` = mandatory, `R` = read-only, `ref=<table>` for reference fields).

### snow schema map

Crawl a table's reference and M2M fields to generate a complete relational schema diagram. Outputs Mermaid (`.mmd`) or DBML (`.dbml`) to disk.

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
```

**Options:**

| Flag | Default | Description |
|---|---|---|
| `-d, --depth <n>` | `2` | How many levels of reference fields to follow |
| `--show-m2m` | off | Include `glide_list` fields as many-to-many relationships |
| `--format <fmt>` | `mermaid` | Output format: `mermaid` or `dbml` |
| `--out <dir>` | `.` | Directory to write the output file(s) |
| `--name <name>` | `<table>-schema` | Base filename — extension added automatically |
| `--inbound` | off | Also crawl tables that have reference fields pointing to this table |
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
5. With `--inbound`: additionally queues tables that have reference fields pointing to the current table
6. Tables referenced outside the crawl depth are rendered as **stub placeholders** so all references resolve without broken links

**Cardinality notation:**

| Relationship | Mermaid | Meaning |
|---|---|---|
| Reference field | `}o--\|\|` | Many records → one target |
| Glide list (M2M) | `}o--o{` | Many records ↔ many targets |

**AI explanation (`--explain`):** Requires a configured AI provider (`snow provider set`). After writing the schema file, the CLI sends the schema content to the active LLM and saves the Markdown response to `<name>.explanation.md`.

---

## snow bulk

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
