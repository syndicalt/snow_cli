---
title: Browse & Logs
nav_order: 10
---

# Browse & Logs
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow catalog

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

**snow catalog list options:**

| Flag | Description |
|---|---|
| `-q, --query <encoded>` | Encoded query filter |
| `--category <name>` | Filter by category name |
| `--catalog <name>` | Filter by catalog title |
| `-l, --limit <n>` | Max records (default: `25`) |
| `--json` | Output as JSON |

**snow catalog search options:**

| Flag | Description |
|---|---|
| `-l, --limit <n>` | Max records (default: `20`) |
| `--json` | Output as JSON |

**snow catalog categories options:**

| Flag | Description |
|---|---|
| `--catalog <name>` | Filter by catalog title |
| `-l, --limit <n>` | Max records (default: `100`) |
| `--json` | Output as JSON |

Sub-categories are indented based on their depth in the `full_name` hierarchy.

---

## snow flow

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

**snow flow list options:**

| Flag | Description |
|---|---|
| `--subflows` | Show subflows instead of flows |
| `--scope <prefix>` | Filter by application scope prefix |
| `-q, --query <encoded>` | Additional encoded query filter |
| `-l, --limit <n>` | Max records (default: `25`) |
| `--json` | Output as JSON |

**snow flow actions options:**

| Flag | Description |
|---|---|
| `--scope <prefix>` | Filter by application scope prefix |
| `-q, --query <encoded>` | Additional encoded query filter |
| `-l, --limit <n>` | Max records (default: `25`) |
| `--json` | Output as JSON |

`snow flow get` shows flow metadata, trigger type, run-as setting, and the list of typed input variables. It also prints the direct Flow Designer URL. Active flows are shown with a green dot; inactive with a red dot.

---

## snow app

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

**snow app list options:**

| Flag | Description |
|---|---|
| `--all` | Include all system scopes, not just custom applications |
| `-q, --query <encoded>` | Encoded query filter |
| `-l, --limit <n>` | Max records (default: `50`) |
| `--json` | Output as JSON |

`snow app get` shows scope prefix, sys_id, version, vendor, created/updated dates, and whether the scope has update set entries. It also prints helpful next-step commands for `snow factory` and `snow diff`.

---

## snow log

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

### snow log system (default)

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

### snow log app

Queries the `syslog_app_scope` table — application-level log entries written by `gs.log()`, `gs.warn()`, etc. **Requires the `admin` role.**

| Flag | Description |
|---|---|
| `--scope <prefix>` | Filter by application scope prefix |
| `--source <source>` | Filter by log source |
| `-l, --limit <n>` | Max records (default: `50`) |
| `--follow` | Poll for new entries |
| `--interval <ms>` | Polling interval in ms (default: `5000`) |
| `--json` | Output as JSON |

### snow log tx

Queries the `syslog_transaction` table. Output columns: timestamp, HTTP status, response time (highlighted red if > 2s), username, URL.

| Flag | Description |
|---|---|
| `-l, --limit <n>` | Max records (default: `25`) |
| `--slow <ms>` | Only show transactions slower than this many milliseconds |
| `--json` | Output as JSON |
