---
title: Instance Management
nav_order: 3
---

# Instance Management
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## snow instance

Manage ServiceNow instance connections. Credentials are stored in `~/.snow/config.json` (mode `0600`).

| Command | Description |
|---|---|
| `snow instance add` | Interactively add an instance (prompts for alias, URL, auth type) |
| `snow instance list` | List all configured instances, showing the active one |
| `snow instance use <alias>` | Switch the active instance |
| `snow instance remove <alias>` | Remove an instance |
| `snow instance test` | Test the active instance connection |

### Adding an instance

```bash
# Interactive (recommended)
snow instance add

# Basic auth — non-interactive
snow instance add --alias dev --url https://dev12345.service-now.com --auth basic

# OAuth (password grant) — prompts for client ID and secret
snow instance add --alias prod --url https://prod.service-now.com --auth oauth
```

OAuth access tokens are fetched automatically using the password grant flow and cached in the config file with their expiry time. They are refreshed transparently when they expire.

### Switching instances

```bash
snow instance use prod
snow instance list   # shows active instance with a marker
snow instance test   # verifies the active connection
```
