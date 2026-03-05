# snow-cli

A portable CLI for ServiceNow. Query tables, inspect schemas, edit script fields, and generate complete applications using AI — all from your terminal.

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Commands](#commands)
  - [snow instance](#snow-instance)
  - [snow table](#snow-table)
  - [snow schema](#snow-schema)
  - [snow script](#snow-script)
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

# 3. Configure an AI provider
snow provider set openai

# 4. Generate a simple feature
snow ai build "Create a script include that auto-routes incidents by category and urgency"

# 5. Generate a full scoped application (AI decides scope automatically)
snow ai build "Build a hardware asset request application with a custom table, approval script include, and assignment business rule"

# 6. Start an interactive session to build iteratively
snow ai chat
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

Inspect field definitions for any table by querying `sys_dictionary`.

```bash
snow schema incident
snow schema sys_user --filter email         # filter fields by name or label
snow schema cmdb_ci_server --format json    # JSON output
```

Output columns: field name, label, type, max length, and flags (`M` = mandatory, `R` = read-only, `ref=<table>` for reference fields).

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
    script.ts               snow script
    provider.ts             snow provider
    ai.ts                   snow ai (build, chat, review, push)
  lib/
    config.ts               Config file read/write + instance and provider helpers
    client.ts               ServiceNow HTTP client (axios, basic + OAuth auth)
    llm.ts                  LLM provider abstraction (OpenAI, Anthropic, xAI, Ollama)
    sn-context.ts           ServiceNow system prompt and artifact type definitions
    update-set.ts           XML update set generation and Table API push
  types/
    index.ts                Shared TypeScript interfaces
```
