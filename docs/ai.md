---
title: AI & Factory
nav_order: 11
---

# AI & Factory
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow provider

Configure LLM providers used by `snow ai` and `snow factory`. API keys and model preferences are stored in `~/.snow/config.json`.

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
| `openai` | `gpt-4o`, `gpt-4-turbo`, `gpt-4o-mini`, ... | Requires OpenAI API key |
| `anthropic` | `claude-opus-4-6`, `claude-sonnet-4-6`, ... | Requires Anthropic API key |
| `xai` | `grok-3`, `grok-2`, ... | Requires xAI API key; uses OpenAI-compatible API |
| `ollama` | `llama3`, `mistral`, `codellama`, ... | Local inference; no API key needed |

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

## snow ai

Generate ServiceNow applications using an LLM. The AI produces structured artifacts that are exported as an importable **update set XML** file and optionally pushed directly to your instance via the Table API.

### Supported artifact types

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

### Scoped applications

The AI automatically determines whether a build warrants its own application scope. Scope is added when:
- The request creates two or more custom tables
- The request is described as an "application" or "module"
- A distinct namespace is needed to avoid naming conflicts

All custom table names and script include API names are automatically prefixed (e.g. `x_myco_myapp_tablename`).

---

### snow ai build

Generate a ServiceNow application from a text description. The AI may ask clarifying questions before generating — answer them interactively and the build proceeds once the AI has enough information.

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

**Interactive clarification:**
```
AI > To generate the right artifacts, a few questions:
     1. Which table should the business rule operate on?
     2. Should it fire on insert, update, or both?

You > incident table, on insert only

[AI generates the build]
```

**Post-build flow:** After generating, the CLI presents two optional prompts:
1. **Review artifacts** — opens an interactive selector to inspect and edit any code field in your preferred editor
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

---

### snow ai chat

Interactive multi-turn session. The AI can ask clarifying questions before generating, and refines artifacts as the conversation continues.

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

**Example session:**
```
You > I want to build an incident auto-assignment feature

AI > To generate the right artifacts, a few questions:
     1. Which teams/groups should incidents be routed to?
     2. What fields determine the routing?
     3. Should assignment happen on insert only, or also on update?

You > Route by category: Network → Network Ops, Software → App Support.
      Assignment on insert only.

AI > [generates script include + business rule]

+ script_include     IncidentRouter
+ business_rule      Auto-Assign Incident on Insert

You > Also add a UI action button to manually re-trigger the routing

AI > [generates updated build with all three artifacts]

+ script_include     IncidentRouter        (unchanged)
+ business_rule      Auto-Assign ...       (unchanged)
+ ui_action          Re-Route Incident     ← new
```

---

### snow ai review

Review and edit a previously generated build. Opens an interactive artifact selector, shows code with line numbers, and lets you open any field in your editor.

```bash
snow ai review ./incident-auto-assignment/
snow ai review ./incident-auto-assignment/incident-auto-assignment.manifest.json
snow ai review ./incident-auto-assignment/incident-auto-assignment.xml
```

**Review workflow:**
1. Select an artifact from the list
2. The code is printed with line numbers
3. Confirm to open in your editor
4. Save and close the editor — changes are written back to disk immediately
5. Select another artifact or choose **Done reviewing**
6. Confirm whether to push the build to the active instance

---

### snow ai push

Push a previously generated build to the active instance via Table API.

```bash
snow ai push ./incident-auto-assignment/
snow ai push ./incident-auto-assignment/incident-auto-assignment.manifest.json
```

**Push behaviour per artifact type:**

| Artifact | Strategy |
|---|---|
| script_include, business_rule, etc. | Looks up by name — creates or updates the single record |
| `table` | Upserts `sys_db_object`; upserts each `sys_dictionary` column; upserts `sys_choice` rows |
| `decision_table` | Upserts `sys_decision`; deletes and recreates all input columns and rules on update |
| `flow_action` | Upserts `sys_hub_action_type_definition`; deletes and recreates all input/output variables on update |
| Scoped build | Resolves or creates the `sys_app` record first; stamps `sys_scope`/`sys_package` on every record |

---

### snow ai test

Generate ATF tests for any previously generated build and push them to the active instance.

```bash
# Generate and push tests for a build
snow ai test ./my-build/

# Generate, push, and immediately run
snow ai test ./my-build/ --run

# Custom suite name
snow ai test ./my-build/my-build.manifest.json --suite-name "Sprint 42 — Onboarding Tests"
```

| Flag | Description |
|---|---|
| `--run` | Execute the test suite immediately after pushing |
| `--suite-name <name>` | Override the generated suite name |

Requires access to `sys_atf_step_config`, `sys_atf_test`, `sys_atf_test_suite`, and `sys_atf_step` tables. ATF must be enabled on the instance.

---

## snow factory

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

# Resume a failed or interrupted run
snow factory "..." --resume abc12345

# List recent factory runs
snow factory "" --list
```

**Options:**

| Flag | Description |
|---|---|
| `--envs <aliases>` | Comma-separated instance aliases to promote to after source (e.g. `test,prod`) |
| `--scope <prefix>` | Override the application scope prefix for all artifacts |
| `--skip-tests` | Skip ATF test generation |
| `--run-tests` | Execute the generated ATF test suite immediately after pushing |
| `--optimize` | After running tests, auto-fix failures via LLM feedback loop (implies `--run-tests`) |
| `--max-retries <n>` | Max optimization iterations when using `--optimize` (default: `3`) |
| `--dry-run` | Show the generated plan only — no builds, no deployments |
| `--resume <id>` | Resume a previous run from its checkpoint |
| `--list` | Show recent factory runs and their component completion status |

### Pipeline phases

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

        If --optimize and tests failed:
          → LLM receives the failing test names + error messages + artifact source
          → Generates corrected artifacts, re-pushes them, re-runs the suite
          → Repeats until all pass or --max-retries is exhausted

  [5/N] Promoting to <env>  (once per additional env in --envs)
        Checks for pre-existing artifacts on the target
        Confirms before applying
        Uploads combined update set XML
        Prints direct link → then Load → Preview → Commit in the UI
```

### Checkpointing and resume

Every factory run is checkpointed to `~/.snow/factory/<run-id>/state.json` after each completed phase. If a run is interrupted, resume it:

```bash
snow factory "" --list                 # find the run ID
snow factory "" --resume abc12345     # resume from last successful phase
```

### Auto-optimization loop

When `--optimize` is set, the factory runs an automated fix cycle after the initial ATF test run. For each iteration:

1. Failing test names and error messages are collected from `sys_atf_result`
2. The current source of every script-bearing artifact is extracted from the local manifest
3. A structured fix prompt is sent to the LLM — no questions, just a corrected build
4. Fixed artifacts are merged into the build, re-pushed to the instance
5. The existing ATF suite is re-run; if all tests pass, the loop exits early

**Example optimization output:**
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

### Permission-denied errors

Some artifact types require elevated roles to push via the Table API:

| Artifact | Required role |
|---|---|
| `table` (`sys_db_object`) | `admin` or `delegated_developer` |
| `decision_table` (`sys_decision`) | `admin` or `developer` |
| `flow_action` (`sys_hub_action_type_definition`) | `flow_designer` + `IntegrationHub` |

When a 403 is encountered the artifact is **skipped** (shown in yellow) rather than failing the whole run. The generated update set XML is always written to disk regardless — use it to import via the UI:

```
System Update Sets → Retrieved Update Sets → Import XML → Load → Preview → Commit
```

### ATF requirements

- The `sn_cicd` plugin must be active on the instance
- The authenticated user must have the `sn_cicd` role
- ATF must be enabled (System ATF → Properties → Enable ATF)

---

## snow ai explain

Ask the active LLM to explain any ServiceNow table or specific record in plain English. The CLI fetches live schema and record data from the instance, feeds it to the LLM, and prints a concise technical explanation.

```bash
# Explain what a table is for
snow ai explain incident
snow ai explain x_myco_hronboard_request
snow ai explain sys_user

# Explain a specific record (e.g. a Script Include)
snow ai explain sys_script_include <sys_id>
snow ai explain sys_script <sys_id>

# Save the explanation to a Markdown file
snow ai explain sys_script_include <sys_id> --save ./explanation.md

# Use a specific provider for this request
snow ai explain incident --provider anthropic
```

**Options:**

| Flag | Description |
|---|---|
| `--provider <name>` | Override the active LLM provider for this request |
| `--save <file>` | Write the explanation to a Markdown file |

**Table explanation** (`snow ai explain <table>`):

Fetches table metadata from `sys_db_object` (label, parent class, scope) and all field definitions from `sys_dictionary`, then asks the LLM to describe the table's business domain, key fields and their meanings, notable relationships to other tables, and typical use cases.

**Record explanation** (`snow ai explain <table> <sys_id>`):

Fetches the full record with display values. For script-bearing tables (`sys_script_include`, `sys_script`, `sys_ui_action`, `sys_script_client`, `sysauto_script`, `sys_ui_page`), the full script content is included so the LLM can explain what the code does.

**Example output:**
```
incident
────────

The incident table is ServiceNow's core ITSM record type, representing
unplanned interruptions or reductions in quality of IT services. It
extends the task table, inheriting fields like number, state, assigned_to,
short_description, and description.

Key fields:
  caller_id       → The user who reported the issue
  category        → High-level classification (Network, Software, Hardware…)
  urgency / impact → Drive priority via the priority matrix
  assignment_group → The team responsible for resolution
  resolved_at      → Populated when state moves to Resolved (6)

Relationships:
  Extends task (inherits SLA, approval, and activity log machinery)
  caller_id → sys_user
  assignment_group → sys_user_group
  problem_id → problem (root cause linking)
  change_request → change_request (change causing the incident)

Typical use: Create incidents via the Service Desk, self-service portal,
email ingest, or API. Drive SLA tracking, escalation rules, and reporting
through the standard task hierarchy.
```
