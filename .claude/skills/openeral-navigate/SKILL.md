---
name: openeral-navigate
description: Use /db for read-only database context while keeping Claude state under /home/agent
---

# OpenEral Navigate

This skill is for the database side of the Claude Code sandbox.

The priority order is:

1. keep Claude running with `HOME=/home/agent`
2. use `/db` only when Claude needs live database context

`/db` and `/home/agent` must both be mounted by the OpenShell supervisor before
database navigation starts. Do not compensate for missing mounts with direct
database clients unless the task is explicitly a lower-level diagnostic.

## First Checks

```bash
grep -E ' /db | /home/agent ' /proc/mounts
```

If either mount is missing, stop treating it as a data-navigation problem. It is
an infrastructure problem; the fix belongs in the OpenShell Docker-driver
gateway/supervisor/sandbox path, not in ad hoc direct database clients.

## Fast Database Reads

Use `/db` like this:

```bash
ls /db
ls /db/public
cat /db/public/users/.info/columns.json
cat /db/public/users/.info/count
cat /db/public/users/.filter/id/42/42/row.json
ls /db/public/users/.order/created_at/desc/
```

Use `.filter/` for targeted lookups. It is the cheapest path for Claude-driven database inspection.

## Workspace Rule

Any notes, scripts, or generated files that Claude should keep must go under `/home/agent`.

```bash
mkdir -p /home/agent/work
printf 'notes\n' > /home/agent/work/todo.txt
```

If a tool stores state under `$HOME`, run it with:

```bash
HOME=/home/agent <tool>
```

Claude-visible secrets should remain provider placeholders. Real provider
values are injected by the OpenShell proxy at egress, not written into
`/home/agent`.

Do not repair missing state by uploading files into the sandbox. Durable Claude
state belongs in `/home/agent` so it passes through the PostgreSQL-backed FUSE
workspace.

`/home/agent/.claude/settings.json` is seeded automatically by bootstrap. To
refresh project memory for Claude, run:

```bash
openeral memory refresh --project-root /sandbox/project
```

The output lands under `/home/agent/.claude/projects/.../memory` and persists
through PostgreSQL.

## What Not To Do

- do not write to `/db`
- do not assume `/sandbox` is durable
- do not store credentials under `/home/agent`; common credential paths like
  `~/.ssh`, `~/.aws`, and `~/.npmrc` are denied by the FUSE workspace
- do not scan huge tables blindly when `.filter/` or `.info/count` will answer the question
