---
title: Analysis & Monitoring
nav_order: 8
---

# Analysis & Monitoring
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow status

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

> **Note:** Version and cluster stats require admin access to `sys_properties` and `sys_cluster_state`. Syslog sections require read access to the `syslog` table. Sections that can't be read are shown as `N/A`.

---

## snow diff

Compare schema field definitions and script content between two configured instances. Useful for detecting drift — fields added/removed/changed, or scripts that diverged between dev and prod.

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

### Field diff output

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

### Script diff output

For each script-bearing table, shows scripts **added**, **removed**, or **changed**, with a contextual line diff for changed scripts:

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

**Script tables scanned:**

| Table | Description |
|---|---|
| `sys_script_include` | Script Includes |
| `sys_script` | Business Rules |
| `sys_script_client` | Client Scripts |
| `sys_ui_action` | UI Actions |
| `sysauto_script` | Scheduled Script Executions |
