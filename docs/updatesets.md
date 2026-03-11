---
title: Update Sets
nav_order: 7
---

# Update Sets
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow updateset

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
| `snow updateset explain <name>` | AI-generated pre-promotion review of an update set |

Names or sys_ids are accepted wherever `<name>` appears.

---

### list

```bash
# All in-progress and complete update sets (default: excludes "ignore")
snow updateset list

# Filter by state
snow updateset list --state "in progress"
snow updateset list --state complete --limit 20
```

| Flag | Description |
|---|---|
| `-s, --state <state>` | Filter by state: `in progress`, `complete`, `ignore` (default: all except `ignore`) |
| `-l, --limit <n>` | Max results (default: `50`) |

Output columns: **Name**, **State**, **Application** (scope), **Created by**, **Created on**. In-progress sets are highlighted in green; the active set is marked with a star.

---

### current

```bash
snow updateset current
```

Shows the update set that is currently active for the authenticated user. REST API writes go to this update set.

---

### set

```bash
snow updateset set "Sprint 42 - Incident fixes"
snow updateset set a1b2c3d4e5f6...   # sys_id also accepted
```

Stores the selection in `sys_user_preference` so subsequent REST API operations are captured into the selected update set.

---

### show

```bash
snow updateset show "Sprint 42 - Incident fixes"
snow updateset show "Sprint 42 - Incident fixes" --limit 200
```

Displays update set metadata followed by a table of every captured item (`sys_update_xml`) with type, action, and target name.

---

### capture

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

---

### export

```bash
# Export to current directory
snow updateset export "Sprint 42 - Incident fixes"

# Export to a specific directory
snow updateset export "Sprint 42 - Incident fixes" --out ./updatesets
```

Calls `/export_update_set.do` and saves the XML to `<safe-name>.xml`. The file can be imported into any ServiceNow instance using `snow updateset apply` or via the ServiceNow UI.

---

### apply

Import an update set XML into an instance. Creates a **Retrieved Update Set** record that you then load, preview, and commit.

```bash
# Apply to the active instance
snow updateset apply ./sprint-42-incident-fixes.xml

# Apply to a different instance by alias
snow updateset apply ./sprint-42-incident-fixes.xml --target prod

# Skip confirmation
snow updateset apply ./sprint-42-incident-fixes.xml --target prod --yes
```

After uploading, the CLI prints the direct link to the Retrieved Update Set record and instructions for the load → preview → commit steps.

---

### diff

Compare the captured items of two update sets side by side:

```bash
snow updateset diff "Sprint 42" "Sprint 43"
snow updateset diff a1b2c3...  b4c5d6...   # sys_ids
```

Output shows:
- Items only in the first set (removed in second) — in red
- Items only in the second set (added in second) — in green
- Items in both sets, flagged if the action changed — in yellow
- A summary line: `3 removed  5 added  1 changed  42 unchanged`

---

### explain

AI-generated pre-promotion review of an update set. Fetches all captured items and their payloads, extracts script content, and asks the LLM to summarise what the update set does, what is affected, and what to test before committing.

```bash
snow updateset explain "Sprint 42"
snow updateset explain <sys_id>
snow updateset explain "My Feature Branch" --save ./pre-flight.md

# Use a specific LLM provider
snow updateset explain "Sprint 42" --provider anthropic
```

| Flag | Description |
|---|---|
| `--provider <name>` | Override the active LLM provider |
| `--save <file>` | Write the report to a markdown file |

**What the AI report covers:**

| Section | Description |
|---|---|
| **Summary** | What the update set does in plain English (2-4 sentences) |
| **Affected Areas** | Which tables, workflows, and business processes are touched |
| **Risk Assessment** | What could go wrong when promoting — rated Low / Medium / High |
| **Testing Checklist** | Specific scenarios to test before committing |
| **Dependencies** | Required roles, records, or other update sets this relies on |
| **Concerns** | Unusual patterns, anti-patterns in scripts, or things needing a second look |

Script content from business rules, script includes, client scripts, UI actions, scheduled jobs, and ACLs is extracted from the `sys_update_xml` payload and sent to the LLM. Scripts are truncated to 600 characters each to keep the prompt manageable.
