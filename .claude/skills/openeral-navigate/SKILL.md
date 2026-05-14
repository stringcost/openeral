---
name: openeral-navigate
description: Use /sandbox/.db for read-only database context while keeping durable state under /sandbox
---

# OpenEral Navigate

This skill is for the database-navigation side of the current Openeral sandbox.

Current contract:

1. durable writable state lives under `/sandbox`
2. database browsing lives under `/sandbox/.db`
3. `HOME=/sandbox`

## First Checks

```bash
/bin/ls -la /sandbox
/usr/bin/test -d /sandbox/.db
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

Anything Claude or a tool should keep must go under `/sandbox`.

```bash
mkdir -p /sandbox/work
printf 'notes\n' > /sandbox/work/todo.txt
```

If a tool stores state under `$HOME`, run it with:

```bash
HOME=/sandbox <tool>
```

## What Not To Do

- do not write under `/sandbox/.db`
- do not switch docs or commands back to `/home/agent`
- do not assume a missing `/.db` can be papered over with ad hoc direct DB
  clients
- do not store the runtime story as `/db` plus `/home/agent`; that is the old
  stack
