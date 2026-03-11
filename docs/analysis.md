---
title: Analysis & Monitoring
nav_order: 9
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

---

## snow security

Analyse whether a specific user can access a ServiceNow table by gathering all active security layers — ACLs, business rules, data policies, UI policies, and client scripts — and optionally feeding the complete picture to an LLM for a structured access verdict.

### snow security analyze

```bash
# Full analysis with AI verdict
snow security analyze nicholas.blanchard sn_grc_issue

# Focus on a single operation
snow security analyze john.doe incident --operation read

# Structured summary only (no LLM call)
snow security analyze jane.smith sys_user --no-llm

# Raw JSON output (all gathered data, no LLM)
snow security analyze nicholas.blanchard change_request --json

# Save the AI analysis to a Markdown file
snow security analyze nicholas.blanchard sn_grc_issue --save report.md

# Use a specific LLM provider
snow security analyze admin sys_user --provider anthropic
```

**Options:**

| Flag | Description |
|---|---|
| `--operation <op>` | Narrow the analysis to one operation: `read`, `write`, `create`, `delete`, `execute` |
| `--no-llm` | Print the gathered data summary without calling the LLM |
| `--json` | Emit all gathered security data as a raw JSON object and exit |
| `--save <file>` | Write the AI analysis to a Markdown file |
| `--provider <name>` | Override the active LLM provider for this command |

**What it gathers:**

| Layer | Table queried | What is fetched |
|---|---|---|
| **User identity** | `sys_user` | Name, email, active status, department, title |
| **Direct roles** | `sys_user_has_role` | Roles assigned directly to the user |
| **Group memberships** | `sys_user_grmember` | All groups the user belongs to |
| **Group roles** | `sys_group_has_role` | Roles inherited through each group |
| **ACL rules** | `sys_security_acl` + `sys_security_acl_role` | All active ACLs for the table, with required roles |
| **Business rules** | `sys_script` | Active BRs that contain security-related logic (`setAbortAction`, `gs.hasRole`, etc.) |
| **Data policies** | `sys_data_policy2` | Active data policies applied to the table |
| **UI policies** | `sys_ui_policy` | Active UI policies, flagging those with scripts |
| **Client scripts** | `sys_script_client` | Active client scripts containing field restriction logic |

**Terminal output:**

The summary view shows each ACL rule with a status icon for the user:

| Icon | Meaning |
|---|---|
| `✓` (green) | User holds a required role — role-based check passes |
| `✗` (red) | User is missing all required roles |
| `~` (yellow) | Role check passes but rule has a condition or script — actual access may still vary |
| `○` (yellow) | No roles required — the ACL is open to any authenticated user |

**AI analysis sections:**

When an LLM provider is configured, the analysis report includes:

1. **Access Summary** — per-operation verdict: `ALLOWED`, `DENIED`, `CONDITIONAL`, or `UNKNOWN`
2. **Effective Role Analysis** — which roles satisfy or fail each ACL, by operation
3. **Blocking Components** — the specific ACL names, business rules, or policies that would prevent access
4. **Open Risks** — ACLs with no role requirement that could grant unintended broad access
5. **Recommendations** — practical steps to grant or restrict access

**How it works:**

The command resolves the full effective role set (direct roles + roles inherited through every group), then fetches all active ACLs for the table and joins their required roles. Business rules are filtered to those containing security-relevant patterns (`setAbortAction`, `gs.hasRole`, `addErrorMessage`, etc.) to avoid flooding the LLM with unrelated logic. All gathered data is assembled into a structured prompt and sent to the configured LLM provider.
