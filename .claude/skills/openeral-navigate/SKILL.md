---
name: openeral-navigate
description: Query PostgreSQL with pg in OpenEral; /db virtual browsing is available only for custom-agent just-bash usage
---

# OpenEral Navigate

In Claude Code service mode, use the real shell plus the `pg` helper. The `/db` and virtual `/home/agent` mounts are custom-agent just-bash features, not Claude Code runtime mounts.

## Database queries (Claude Code + custom agents)

```bash
pg "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
pg "SELECT * FROM public.users LIMIT 5"
```

## /db virtual filesystem (custom agent path only)

When using `createOpeneralShell()` with just-bash, the database is browsable as files:

```bash
ls /db                                          # schemas
ls /db/public                                   # tables
cat /db/public/users/.info/columns.json         # column metadata
cat /db/public/users/.info/schema.sql           # CREATE TABLE DDL
cat /db/public/users/.info/count                # row count
cat /db/public/users/page_1/1/row.json          # row as JSON
ls /db/public/users/.filter/status/active/      # filtered rows
ls /db/public/users/.order/created_at/desc/     # sorted rows
```

Prefer `.filter/` and `.info/count` over scanning page trees.

## Claude Code Workspace

Claude Code runs with `HOME=/home/agent`. With `DATABASE_URL` set, OpenEral syncs Claude state under `$HOME/.claude/**` and OpenEral state under `$HOME/.openeral/**` to PostgreSQL. Arbitrary source code and temporary work directories remain sandbox-local.

```bash
openeral memory refresh --query "current project"
claude -c
```

## Rules

- `/db` is read-only — writes throw EROFS
- `/tmp` is ephemeral
- Without `DATABASE_URL`, embedded PGlite is scoped to the running sandbox lifetime
- `ANTHROPIC_API_KEY` stays as a placeholder in the sandbox — resolved by the OpenShell proxy at egress
