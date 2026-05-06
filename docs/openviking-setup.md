# OpenViking Setup Guide

**Date:** 2026-05-06  
**Purpose:** Install, configure, and use OpenViking with OpenEral

---

## What Is OpenViking?

OpenViking is a **separate Python HTTP server** that gives OpenEral semantic (vector-based) memory instead of keyword search. It runs at `http://localhost:1933` by default and exposes a REST API that OpenEral's client code calls.

Without OpenViking, OpenEral uses file-based keyword matching — fast, zero-setup, free.  
With OpenViking, OpenEral adds:

- **Semantic search** — "database connection" finds "PostgreSQL setup" even without keyword overlap
- **Cross-session memory** — facts survive sandbox restarts
- **Auto-capture** — shell commands and outputs are logged, then extracted into structured memories by an LLM
- **Migration** — convert existing markdown memory files into OpenViking's vector store

---

## Where Is OpenViking Data Stored?

**Not in OpenEral's PostgreSQL.** OpenViking has its own completely independent storage:

| Storage | What goes there |
|---------|----------------|
| OpenViking's own vector DB | Embeddings, ranked memories, session transcripts |
| OpenViking's own SQL schema | Metadata, resource index, session records |
| **OpenEral's PostgreSQL** | `workspace_files` — your `/home/agent` filesystem snapshots only |

OpenEral's `_openeral` schema on Supabase (or your own PostgreSQL) stores filesystem state.  
OpenViking's database is on the **OpenViking server machine** — a separate system entirely.

If you run OpenViking locally, its data lives wherever the server stores it (typically `~/.openviking/` or a local SQLite/Qdrant instance). If you run it on a hosted instance, data lives there.

---

## Installing the OpenViking Server

OpenViking is a Python package. Install it on the machine that will run the server:

```bash
pip install openviking
```

### Required configuration

OpenViking needs an embedding provider and (for auto-capture) a VLM provider:

```bash
# Volcengine Doubao (cheapest, recommended for embeddings)
export VOLCENGINE_ACCESS_KEY='your-key'
export VOLCENGINE_SECRET_KEY='your-secret'

# OR OpenAI embeddings
export OPENAI_API_KEY='sk-...'

# VLM for memory extraction (Claude, GPT-4, etc.)
export ANTHROPIC_API_KEY='sk-ant-...'
```

### Start the server

```bash
# Start on default port 1933
openviking serve

# Custom port
openviking serve --port 2000

# With explicit storage directory
openviking serve --data-dir ~/.openviking/data
```

Verify it is running:

```bash
curl http://localhost:1933/health
# {"status": "ok", "version": "..."}
```

---

## Two Deployment Options

### Option A — Server on the host, sandbox connects to it (Recommended)

Run OpenViking on your laptop/server. The OpenShell sandbox connects to it through the network policy.

**Step 1:** Start OpenViking on your host (see above).

**Step 2:** Add your host's IP to `sandboxes/openeral/policy.yaml`:

```yaml
network_policies:
  openviking:
    endpoints:
      - { host: host.docker.internal, port: 1933, tls: false }
    binaries:
      - { path: /usr/bin/node }
```

`host.docker.internal` resolves to the Docker host on Linux/Mac. On Linux you may need to use `172.17.0.1` (the default Docker bridge gateway) or your actual host IP.

**Step 3:** Configure the endpoint in `~/.openeral/openviking.json` (created automatically on first `openeral memory status` run, or create it manually):

```json
{
  "enabled": true,
  "endpoint": "http://host.docker.internal:1933",
  "timeoutMs": 15000,
  "agentId": "openeral-claude",
  "autoRecall": { "enabled": true, "limit": 6, "scoreThreshold": 0.15, "tokenBudget": 2000 },
  "autoCapture": { "enabled": true, "mode": "semantic", "intervalMinutes": 10, "timeoutMs": 30000 }
}
```

**Step 4:** Rebuild the sandbox image with the updated policy:

```bash
docker build -f sandboxes/openeral/Dockerfile -t openeral-sandbox:dev .
```

---

### Option B — OpenViking bundled inside the sandbox image

Install OpenViking inside the Docker image so it starts alongside the agent. Data does **not** persist across sandbox recreations unless you configure OpenViking to use external storage.

**Dockerfile addition** (after Node.js install):

```dockerfile
RUN pip3 install openviking
```

**setup.sh addition** (near the top, before the agent launches):

```bash
# Start OpenViking in the background
if command -v openviking >/dev/null 2>&1; then
  OPENVIKING_DATA_DIR="${HOME}/.openviking" \
    openviking serve --port 1933 </dev/null >>/tmp/openviking.log 2>&1 &
  # Wait up to 30s for the server to become ready
  for i in $(seq 1 30); do
    if curl -sf http://localhost:1933/health >/dev/null 2>&1; then
      echo "setup.sh: OpenViking ready" >&2
      break
    fi
    sleep 1
  done
fi
```

With this option, `endpoint` stays at `http://localhost:1933` (no policy change needed).

**Trade-off:** Memory is lost when the sandbox is deleted unless `OPENVIKING_DATA_DIR` points to a mounted external path.

---

## Using OpenViking with the OpenEral CLI

### Check connection status

```bash
npx openeral memory status
```

Example output:
```
OpenViking Status
─────────────────────────────────────────────
Connection:     ✓ Connected (http://localhost:1933)
Health:         ✓ Healthy
Latency:        45ms

Memory Stats
─────────────────────────────────────────────
User memories:      127
Agent memories:     43
Session archives:   8

Configuration
─────────────────────────────────────────────
Auto-recall:        ✓ Enabled (limit: 6, threshold: 0.15)
Auto-capture:       ✓ Enabled (interval: 10min)
Endpoint:           http://localhost:1933
Agent ID:           openeral-claude
```

If OpenViking is not running or not configured, the status command shows a disconnected state — it never blocks or errors the normal agent launch.

### Semantic memory refresh

```bash
# Default refresh using OpenViking for semantic search
npx openeral memory refresh --openviking

# Focus on a specific topic
npx openeral memory refresh --query "database setup" --openviking

# Preview without writing files
npx openeral memory refresh --openviking --dry-run
```

Without `--openviking`, the refresh uses keyword-only local ranking. With it, results are merged: 40% local keyword weight + 60% OpenViking semantic weight.

### Migrate existing memories to OpenViking

After enabling OpenViking, import your existing markdown memories so they become searchable semantically:

```bash
npx openeral memory migrate --to-openviking
```

This reads every `.md` file from your Claude project memory directory and stores each in OpenViking's vector store. The original files are left intact.

---

## Configuration Reference

Config file: `~/.openeral/openviking.json`

```json
{
  "enabled": false,
  "endpoint": "http://localhost:1933",
  "apiKey": null,
  "timeoutMs": 15000,
  "agentId": "openeral-claude",

  "autoRecall": {
    "enabled": true,
    "limit": 6,
    "scoreThreshold": 0.15,
    "tokenBudget": 2000
  },

  "autoCapture": {
    "enabled": true,
    "mode": "semantic",
    "intervalMinutes": 10,
    "timeoutMs": 30000
  }
}
```

| Field | Description |
|-------|-------------|
| `enabled` | Master switch. Set to `true` to activate. |
| `endpoint` | OpenViking server URL. `localhost:1933` for local or in-sandbox. |
| `apiKey` | API key if your OpenViking server requires authentication. |
| `timeoutMs` | Per-request timeout. Increase for slow networks. |
| `agentId` | Identifies which agent's memories to search. Set to `openeral-openclaw` when using OpenClaw. |
| `autoRecall.limit` | Max memories injected per prompt. |
| `autoRecall.scoreThreshold` | Minimum relevance score (0–1). |
| `autoRecall.tokenBudget` | Max tokens to inject from memories. |
| `autoCapture.enabled` | Whether to log commands to OpenViking sessions. |
| `autoCapture.intervalMinutes` | Background commit frequency. |
| `autoCapture.timeoutMs` | Max time to wait for commit before giving up. |

---

## Auto-Capture: How Shell Commands Become Memories

When `autoCapture.enabled` is true, the `openeral-bash` daemon logs every command you run and its output to an OpenViking session. Every 20 commands, the session is committed — OpenViking's VLM reads the transcript and extracts structured facts (preferences, decisions, error resolutions) into the vector store.

These facts then surface in future sessions via `memory refresh --openviking`, making your past work searchable semantically even without explicit note-taking.

The capture pipeline:
```
bash command → openeral-bash daemon → captureCommand()
                                           ↓
                                  appendTurn() to OpenViking session
                                           ↓ (every 20 turns)
                                  BackgroundCommitQueue.enqueue()
                                           ↓
                                  OpenViking VLM extraction
                                           ↓
                                  structured memories in vector store
```

---

## Works With Both Agents

OpenViking works with both Claude Code and OpenClaw. The `agentId` in the config distinguishes their memories:

- Claude Code → `agentId: "openeral-claude"` (default)
- OpenClaw → `agentId: "openeral-openclaw"`

Both agents' memories live in the same OpenViking server and can be queried across agents if needed.

---

## Circuit Breaker

If OpenViking fails 3 times in a row, the client stops retrying for 60 seconds. During the cooldown, all `memory refresh` and `memory status` operations fall back to local keyword-only mode silently. No user-facing errors — the fallback is seamless.

After 60 seconds, the next call retries OpenViking automatically.

---

## Troubleshooting

### `memory status` shows "Disconnected"
- Verify the server is running: `curl http://localhost:1933/health`
- Check `endpoint` in `~/.openeral/openviking.json`
- If inside the sandbox, check `policy.yaml` allowlists the host and port

### `memory refresh --openviking` returns only local results
- OpenViking server may be down (circuit breaker fallback is silent)
- Run `openeral memory status` to confirm connectivity
- Check `/tmp/openviking.log` if running Option B (in-sandbox)

### Auto-capture not working
- Confirm `autoCapture.enabled: true` in config
- The capture happens in the background; first commit occurs after 20 commands
- Check OpenViking server logs for extraction errors (usually missing VLM API key)

### High latency on `memory refresh --openviking`
- Normal range is 200–2000ms depending on embedding provider
- Reduce `autoRecall.limit` to 4 for faster results
- Check embedding provider API latency separately
