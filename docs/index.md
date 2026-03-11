---
title: snow-cli
layout: home
nav_order: 1
---

# snow-cli

A portable CLI for ServiceNow. Query tables, inspect schemas, edit and search script fields, bulk-update records, manage users and groups, handle attachments, promote update sets across environments, browse the Service Catalog, inspect Flow Designer flows, manage scoped applications, tail system logs, analyse user access across every security layer, and generate complete applications using AI — all from your terminal.

---

## Commands at a glance

| Command | Description |
|---|---|
| [`snow instance`](instance) | Add and switch ServiceNow instance connections |
| [`snow table`](data#snow-table) | Query, create, update, and delete records |
| [`snow schema`](data#snow-schema) | Inspect field definitions and generate schema diagrams |
| [`snow script`](scripts) | Pull, edit, push, search, and replace script fields |
| [`snow bulk`](data#snow-bulk) | Bulk-update records matching a query |
| [`snow user`](users-attachments#snow-user) | Manage group membership and role assignments |
| [`snow attachment`](users-attachments#snow-attachment) | Download and upload record attachments |
| [`snow updateset`](updatesets) | List, export, import, and diff update sets |
| [`snow run`](admin#snow-run) | Execute a server-side script on the instance |
| [`snow sys`](admin#snow-sys) | Read and write system properties |
| [`snow approval`](admin#snow-approval) | List, approve, and reject approval requests |
| [`snow watch`](admin#snow-watch) | Poll a record and print field changes in real time |
| [`snow acl`](admin#snow-acl) | Inspect Access Control rules for a table |
| [`snow import`](admin#snow-import) | Import records from a JSON or CSV file |
| [`snow status`](analysis#snow-status) | Dashboard health and stats overview |
| [`snow diff`](analysis#snow-diff) | Compare schema and scripts between instances |
| [`snow security`](analysis#snow-security) | Analyse user access across all security layers with AI |
| [`snow factory`](ai#snow-factory) | AI-orchestrated multi-component application pipeline |
| [`snow catalog`](browse#snow-catalog) | Browse the Service Catalog |
| [`snow flow`](browse#snow-flow) | Inspect Flow Designer flows and actions |
| [`snow app`](browse#snow-app) | List and inspect scoped applications |
| [`snow log`](browse#snow-log) | Tail system, app, and transaction logs |
| [`snow provider`](ai#snow-provider) | Configure LLM providers for AI commands |
| [`snow ai`](ai#snow-ai) | Generate ServiceNow artifacts from natural language |
| [`snow ai explain`](ai#snow-ai-explain) | Ask the LLM to explain any table or record in plain English |

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

## Quick start

```bash
# 1. Add a ServiceNow instance
snow instance add

# 2. Query a table
snow table get incident -q "active=true" -l 10 -f "number,short_description,state,assigned_to"

# 3. Pull a script, edit it locally, and push it back
snow script pull sys_script_include <sys_id> script

# 4. Configure an AI provider and generate a feature
snow provider set openai
snow ai build "Create a script include that auto-routes incidents by category and urgency"

# 5. Run the full factory pipeline
snow factory "Build a hardware asset request app with approval workflow" --envs test,prod
```

Continue to [Getting Started](getting-started) for a full walkthrough.
