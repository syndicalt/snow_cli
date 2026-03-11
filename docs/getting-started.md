---
title: Getting Started
nav_order: 2
---

# Getting Started
{: .no_toc }

<details open markdown="block">
  <summary>Contents</summary>
  {: .text-delta }
- TOC
{:toc}
</details>

---

## Installation

**From npm:**
```bash
npm install -g snow-cli
```

**From source:**
```bash
git clone https://github.com/tuckerman/snow-cli
cd snow-cli
npm install
npm run build
npm link
```

Requires Node.js 18+.

---

## Adding an instance

```bash
snow instance add
```

This prompts for an alias, URL, and authentication type. You can also pass flags directly:

```bash
# Basic auth
snow instance add --alias dev --url https://dev12345.service-now.com --auth basic

# OAuth (password grant) — prompts for client ID and secret
snow instance add --alias prod --url https://prod.service-now.com --auth oauth
```

OAuth tokens are fetched automatically and refreshed transparently when they expire.

Switch between instances at any time:

```bash
snow instance use prod
snow instance use dev
```

Test the active connection:

```bash
snow instance test
```

---

## Configuration file

All settings are stored in `~/.snow/config.json` (mode `0600`). The directory is created with mode `0700`.

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
      "openai": { "model": "gpt-4o", "apiKey": "sk-..." },
      "anthropic": { "model": "claude-opus-4-6", "apiKey": "sk-ant-..." },
      "xai": { "model": "grok-3", "apiKey": "xai-...", "baseUrl": "https://api.x.ai/v1" },
      "ollama": { "model": "llama3", "baseUrl": "http://localhost:11434" }
    }
  }
}
```

---

## Quick start walkthrough

```bash
# Query records with a filter and field selection
snow table get incident -q "active=true^priority=1" -l 20 -f "number,short_description,state,assigned_to"

# Bulk-update records matching a query
snow bulk update incident -q "active=true^priority=1" --set assigned_to=admin --dry-run

# Pull a script field, edit it locally, push it back
snow script pull sys_script_include <sys_id> script

# Search for a pattern across all scripts in an app scope
snow script search x_myapp --contains "GlideRecord('old_table')"

# Manage update sets — list, export, and promote to another instance
snow updateset list
snow updateset export "Sprint 42" --out ./updatesets
snow updateset apply ./sprint-42.xml --target prod

# Add a user to a group or assign a role
snow user add-to-group john.doe "Network Support"
snow user assign-role john.doe itil

# Download all attachments from a record
snow attachment pull incident <sys_id> --all --out ./downloads

# Configure an AI provider and generate a feature
snow provider set openai
snow ai build "Create a script include that auto-routes incidents by category and urgency"

# Compare schema/scripts between instances to detect drift
snow diff incident --against prod --fields
snow diff all --against test --scripts --scope x_myco_myapp

# Run a background script directly on the instance
snow run "gs.print(gs.getProperty('glide.version'))"
snow run ./fix-records.js --scope x_myco_myapp

# Read and write system properties
snow sys get glide.email.active
snow sys set glide.email.active false

# List and action approval requests
snow approval list
snow approval approve <sys_id> --comment "Reviewed and approved"

# Watch a record for field changes in real time
snow watch incident <sys_id> --fields state,assigned_to,priority

# Inspect ACL rules for a table
snow acl list incident --operation read
snow acl list sn_grc_issue --role itil --fields

# Import records from a CSV or JSON file
snow import ./users.csv --table sys_user --upsert user_name
snow import ./incidents.json --table incident --dry-run

# Analyse whether a user can access a table (gathers ACLs, roles, BRs, policies)
snow security analyze nicholas.blanchard sn_grc_issue
snow security analyze john.doe incident --operation read --no-llm

# Translate natural language to an encoded query (and back)
snow ai query "open P1 incidents with no assignee" --table incident
snow ai translate "active=true^priority=1^assigned_toISEMPTY" --table incident

# Diagnose a ServiceNow error
snow ai fix "Cannot read property 'getValue' of null"
snow ai fix "Transaction cancelled: script execution quota exceeded"

# Analyse recent log errors with AI
snow log analyze
snow log analyze --scope x_myco_myapp --save ./error-report.md

# Run the full factory pipeline: plan → build → test → promote
snow factory "Build a hardware asset request app with approval workflow" --envs test,prod
```

---

## Setting up AI providers

The `snow ai`, `snow factory`, and `snow security analyze` commands use a configured LLM provider. See [AI & Factory](ai#snow-provider) for full details.

```bash
# OpenAI (prompts interactively for key and model)
snow provider set openai

# Anthropic
snow provider set anthropic

# xAI / Grok
snow provider set xai

# Ollama (local — no key required)
snow provider set ollama --model llama3

# Verify a provider is working
snow provider test

# Switch between configured providers
snow provider use anthropic
```
