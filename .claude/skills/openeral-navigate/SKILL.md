---
name: openeral-navigate
description: Explore /db and manage files in /home/agent — available when running with DATABASE_URL via just-bash or OpenShell
---

# OpenEral Navigate

When running with `DATABASE_URL` set, two virtual mounts are available:

- `/db` — read-only database (schemas, tables, rows as files)
- `/home/agent` — read-write persistent workspace

These are available via the `pg` command (Claude Code path) or as virtual directories (custom agent path with just-bash).

## Database queries (Claude Code + custom agents)

```bash
pg "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
pg "SELECT * FROM public.users LIMIT 5"
pg "\d public.users"
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

## Workspace

Files written to `$HOME` persist to PostgreSQL (when `DATABASE_URL` is set):

```bash
mkdir -p $HOME/work
echo "notes" > $HOME/work/todo.txt
```

## Rules

- `/db` is read-only — writes throw EROFS
- `/tmp` is ephemeral
- Without `DATABASE_URL`, only session-local storage (no cross-session persistence, no `pg`, no `/db`)
- `ANTHROPIC_API_KEY` stays as a placeholder in the sandbox — resolved by the OpenShell proxy at egress
