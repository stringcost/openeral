# OpenEral Sandbox Assets

This directory no longer describes the primary runtime path by itself.

Current understanding of the stack:

- the verified runtime uses the embedded-k3s OpenShell path
- the sandbox image in the active flow is the stock community `base` image
- the durable writable path is `/sandbox`
- the read-only database browser is `/sandbox/.db`
- the external DB contract is shell-sourced `OPENERAL_DATABASE_URL`

## What In This Directory Is Still Active

The main active asset here is:

- [policy.yaml](/home/sss/Code/pgmount/sandboxes/openeral/policy.yaml)

That policy is passed explicitly during the current validation flow and is the
repo-owned policy surface for:

- Anthropic traffic
- Claude telemetry allowlist additions
- optional package and provider-related egress rules

## What Is Historical / Secondary

The old custom openeral sandbox image and its `/home/agent`-centric runtime are
not the current verified story.

That means this directory should not be read as:

- “the supported sandbox image is `sandboxes/openeral/Dockerfile`”
- “the active durability path is `/home/agent`”
- “the active DB mount is top-level `/db`”

Those were earlier runtime shapes. The current repo docs should point to the
root [README.md](/home/sss/Code/pgmount/README.md) for the real stack.

## Current Known Gap

Storage and persistence are verified on the current stack, but the final
`claude -p` completion through `openshell sandbox exec` is still an open issue.

Do not overstate this directory as proving a fully green end-to-end runtime by
itself.
