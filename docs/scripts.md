---
title: Script Commands
nav_order: 5
---

# Script Commands
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow script

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

## snow script search

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

---

## snow script replace

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
