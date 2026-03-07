---
title: Users & Attachments
nav_order: 6
---

# Users & Attachments
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow user

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

## snow attachment

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

### snow attachment pull options

| Flag | Description |
|---|---|
| `-a, --all` | Download all attachments on the record |
| `-n, --name <file_name>` | Download a specific attachment by its file name |
| `-o, --out <dir>` | Output directory (default: current directory) |

### snow attachment push options

| Flag | Description |
|---|---|
| `-t, --type <content-type>` | Override the Content-Type header (auto-detected from extension by default) |

Content-Type is inferred from the file extension for common formats (PDF, PNG, JPG, CSV, XML, JSON, ZIP, DOCX, XLSX, etc.). Defaults to `application/octet-stream` for unknown types.
