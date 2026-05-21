---
name: openeral-navigate
description: Use /sandbox/.db for read-only database context while keeping durable workspace state under /sandbox and Claude config under /home/agent/.claude
---

# OpenEral Navigate

This skill is for the database-navigation side of the current Openeral sandbox.

Current contract:

1. durable writable state lives under `/sandbox`
2. database browsing lives under `/sandbox/.db`
3. local home lives at `/home/agent`
4. Claude config is mounted at `/home/agent/.claude`
5. source code is host-mounted at `/sandbox/project`

## First Checks

```bash
/bin/ls -la /sandbox
/usr/bin/test -d /sandbox/.db
/usr/bin/test -d /home/agent/.claude
```

If `/.db` is missing, treat that as an infrastructure/runtime issue, not a
query-navigation issue.

## Read-Only Database Navigation

Use the synthetic DB tree like this:

```bash
ls /sandbox/.db
ls /sandbox/.db/public
cat /sandbox/.db/public/users/.info/columns.json
cat /sandbox/.db/public/users/.info/count
cat /sandbox/.db/public/users/.filter/id/42/42/row.json
ls /sandbox/.db/public/users/.order/created_at/desc/
```

Use `.filter/` and `.info/` paths before broad directory walks.

## Durable Workspace Rule

General durable workspace state belongs under `/sandbox`.

```bash
mkdir -p /sandbox/work
printf 'notes\n' > /sandbox/work/todo.txt
```

Claude's own settings, memory, projects, sessions, and top-level config belong
under the mounted config directory:

```bash
ls /home/agent/.claude
cat /home/agent/.claude/.claude.json
```

Do not put source-code persistence expectations on `/sandbox/project`; that is
the host project mount and should stay out of `_openeral.workspace_files`.

## What Not To Do

- do not write under `/sandbox/.db`
- do not make all of `/home/agent` durable
- do not use `/home/agent/.claude.json`; Claude config is
  `/home/agent/.claude/.claude.json`
- do not assume a missing `/.db` can be papered over with ad hoc direct DB
  clients
- do not store the runtime story as `/db` plus whole-home persistence; that is
  the old stack
