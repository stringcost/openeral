#!/bin/bash
set -euo pipefail

# setup.sh — OpenEral sandbox entry point
#
# Called by: openshell sandbox create ... -- openeral [--shell]
# (or, equivalently, -- /opt/openeral/setup.sh — the `openeral` name is a
# /usr/local/bin shim installed in the Dockerfile.)
#
# Steps:
#   1. Run database migrations
#   2. Seed the workspace
#   3. Start openeral-bash daemon
#   4. Exec the selected agent (Claude Code or OpenClaw), or drop to bash (--shell)

# OpenShell's Node HTTP proxy path currently emits an experimental Undici warning
# in some environments. Keep setup output clean and, more importantly, keep
# warning text out of shell-captured values such as the StringCost presign URL.
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"

# Use /opt/openeral directly if accessible, otherwise copy to /home/agent
if [ -r /opt/openeral/dist/db/embedded.js ]; then
  OPENERAL_DIR=/opt/openeral
  echo "setup: using /opt/openeral directly"
else
  echo "setup: copying openeral to writable location..."
  # Use cp instead of tar to avoid permission issues
  mkdir -p /home/agent/openeral
  cp -r /opt/openeral/* /home/agent/openeral/ 2>/dev/null || {
    echo "setup: copy failed, trying with sudo..."
    # If copy fails, try to make /opt/openeral readable
    chmod -R a+rX /opt/openeral 2>/dev/null || true
    cp -r /opt/openeral/* /home/agent/openeral/
  }
  OPENERAL_DIR=/home/agent/openeral
fi

# Workspace ID defaults to sandbox ID (set by OpenShell supervisor)
export WORKSPACE_ID="${OPENSHELL_SANDBOX_ID:-default}"

# Capture the sandbox user's real HOME before we override it when launching agents.
# `openshell sandbox connect` gives a shell with this HOME (typically /sandbox),
# not /home/agent. We write a .bashrc there so reconnect sessions automatically
# set HOME=/home/agent and export StringCost env vars.
SANDBOX_USER_HOME="${HOME:-/sandbox}"

# Agent kind — injected by the `openclaw` generic provider as OPENERAL_AGENT=openclaw.
# OpenShell wraps ALL generic provider credentials as openshell:resolve:env:* placeholders,
# so OPENERAL_AGENT may arrive as a placeholder string rather than the literal "openclaw".
# Since OPENERAL_AGENT is only ever set by the openclaw provider, any non-empty value
# (literal or placeholder) means openclaw is active.
case "${OPENERAL_AGENT:-}" in
  openclaw|openshell:resolve:env:*)
    export OPENERAL_AGENT="openclaw"
    ;;
  *)
    export OPENERAL_AGENT="claude"
    ;;
esac

# OpenClaw's runtime npm-via-git installs reference git+ssh://git@github.com/…
# URLs (e.g. whiskeysockets/libsignal-node). The OpenShell sandbox policy only
# permits github.com:443 (HTTPS) for /usr/bin/git — port 22 (SSH) is blocked
# at the network layer and surfaces as "Temporary failure in name resolution"
# from npm/git. Configure git to rewrite the ssh forms to https so the existing
# github_ssh_over_https policy stanza handles the traffic.
#
# IMPORTANT: Use HOME=/home/agent explicitly — all OpenClaw plugin staging and
# TUI operations run with HOME=/home/agent. Writing to the default $HOME
# (the container initial HOME, typically /sandbox) means the rewrites land in
# the wrong .gitconfig file and are invisible to npm/git when they install
# plugin deps, causing a ~10 min hang on every "hi" (SSH port 22 blocked).
# We also re-apply these after syncToFs so a workspace-restored .gitconfig
# cannot overwrite our additions (see the block after the restore step below).
#
# CRITICAL: use --add. Without it, the three calls collapse onto a single
# single-value key and only the LAST rewrite (git+ssh://) survives — the
# ssh:// rewrite that npm-via-git actually needs gets silently dropped, and
# every plugin install retries SSH:22 (blocked) for ~30 min before failing.
if [ "${OPENERAL_AGENT}" = "openclaw" ]; then
  mkdir -p /home/agent
  HOME=/home/agent git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" 2>/dev/null || true
  # After the rewrite, git tunnels through OpenShell's TLS-terminating proxy
  # which presents a self-signed CA cert git does not trust ("server certificate
  # verification failed. CAfile: none"). The sandbox network policy already
  # gates which hosts are reachable, so leaving verify on adds no protection
  # but blocks every plugin install.
  HOME=/home/agent git config --global http.sslVerify false 2>/dev/null || true
fi

# StringCost API host. Defaults to the hosted service; override with
# STRINGCOST_API_BASE=http://<host-ip>:8080 (or similar) to point at a
# self-hosted control plane during local end-to-end testing.
export STRINGCOST_API_BASE="${STRINGCOST_API_BASE:-https://app.stringcost.com}"

# DATABASE_URL is REQUIRED. Resolution order:
#   1. DATABASE_URL / OPENERAL_DATABASE_URL / POSTGRES_URL already set in env — use it,
#      unless it's an OpenShell placeholder (which happens when the URL was
#      delivered via `openshell provider create --credential`; the provider
#      framework wraps every credential as a placeholder that only HTTP L7
#      inspection can resolve, and pg cannot use it).
#   2. Uploaded plaintext file at /sandbox/db-url (via `openshell sandbox
#      create --upload /tmp/db-url:/sandbox/db-url`). This is the only
#      documented way to deliver a usable raw-TCP credential into the sandbox.
#      --upload copies the source filename into the target directory, so
#      either `/sandbox/db-url` (file) or `/sandbox/db-url/<name>` (dir) works.
export DATABASE_URL="${DATABASE_URL:-${OPENERAL_DATABASE_URL:-${POSTGRES_URL:-}}}"
case "${DATABASE_URL:-}" in
  ''|openshell:resolve:env:*)
    DB_URL_FILE=""
    if [ -f /sandbox/db-url ]; then
      DB_URL_FILE=/sandbox/db-url
    elif [ -d /sandbox/db-url ]; then
      DB_URL_FILE="$(find /sandbox/db-url -maxdepth 2 -type f -name db-url | head -1)"
      [ -n "$DB_URL_FILE" ] || DB_URL_FILE="$(find /sandbox/db-url -maxdepth 1 -type f | head -1)"
    elif [ -f /sandbox/openeral-input/db-url ]; then
      DB_URL_FILE=/sandbox/openeral-input/db-url
    elif [ -d /sandbox/openeral-input ]; then
      DB_URL_FILE="$(find /sandbox/openeral-input -type f -name db-url | head -1)"
    fi
    if [ -n "$DB_URL_FILE" ]; then
      # Trim leading/trailing whitespace and CR (Windows line endings) — defensive
      # against `echo "$URL" > file` adding a trailing newline that Postgres rejects.
      DATABASE_URL="$(tr -d '\r' < "$DB_URL_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      export DATABASE_URL
      echo "setup.sh: loaded DATABASE_URL from uploaded $DB_URL_FILE"
    fi
    ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
  echo "setup.sh: error: DATABASE_URL is required." >&2
  echo "setup.sh:   Upload your PostgreSQL connection string when creating the sandbox:" >&2
  echo "setup.sh:     echo \"\$DATABASE_URL\" > /tmp/db-url" >&2
  echo "setup.sh:     openshell sandbox create --upload /tmp/db-url:/sandbox/db-url ..." >&2
  echo "setup.sh:   Or place it at /sandbox/openeral-input/db-url alongside the API key." >&2
  echo "setup.sh:   See README.md for the full command." >&2
  exit 1
fi

# ANTHROPIC_API_KEY file-based delivery for OpenClaw.
# OpenShell provider credentials arrive as openshell:resolve:env:* placeholders
# that the HTTP proxy resolves only for Claude Code's binary. OpenClaw's embedded
# gateway is a separate Node process; passing the placeholder to it causes
# Anthropic to reject every API call. Read the real key from an uploaded file
# instead so the literal value is exported into ANTHROPIC_API_KEY before exec'ing openclaw.
case "${ANTHROPIC_API_KEY:-}" in
  ''|openshell:resolve:env:*)
    ANTHROPIC_KEY_FILE=""
    if [ -f /sandbox/anthropic-api-key ]; then
      ANTHROPIC_KEY_FILE=/sandbox/anthropic-api-key
    elif [ -d /sandbox/anthropic-api-key ]; then
      # openshell --upload always places files INSIDE the destination directory
      # (e.g. --upload /tmp/my-key:/sandbox/anthropic-api-key puts the file at
      # /sandbox/anthropic-api-key/my-key). Pick any single file inside.
      ANTHROPIC_KEY_FILE="$(find /sandbox/anthropic-api-key -maxdepth 1 -type f | head -1)"
    elif [ -f /sandbox/openeral-input/anthropic-api-key ]; then
      ANTHROPIC_KEY_FILE=/sandbox/openeral-input/anthropic-api-key
    fi
    if [ -n "$ANTHROPIC_KEY_FILE" ]; then
      # Trim leading/trailing whitespace and CR (Windows line endings) — defensive
      # against `echo "$KEY" > file` adding a trailing newline. A key with a stray
      # newline is sent literally to Anthropic, which rejects it with 401; openclaw
      # then surfaces this as a generic "run aborted / timeout" in the TUI.
      ANTHROPIC_API_KEY="$(tr -d '\r' < "$ANTHROPIC_KEY_FILE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
      export ANTHROPIC_API_KEY
      echo "setup.sh: loaded ANTHROPIC_API_KEY from uploaded $ANTHROPIC_KEY_FILE"
    fi
    ;;
esac

# StringCost integration — both agents (Claude Code AND OpenClaw).
# Each agent gets its own presign with a distinct metadata.labels entry so the
# StringCost vendor portfolio can attribute token spend, COGS, and revenue to
# the right agent. Both agents read ANTHROPIC_BASE_URL at startup and route
# their /v1/messages calls through the StringCost proxy.

# Priority:
#   1. STRINGCOST_PROXY_URL already set → normalize and use it.
#   2. Uploaded presign JSON or URL under /sandbox/openeral-input → normalize and use it.
#   3. STRINGCOST_PROXY_URL stored from previous session → reuse.
#   4. STRINGCOST_API_KEY + raw ANTHROPIC_API_KEY present → create a new permanent presign
#      (expires_in=-1, max_uses=-1, cost_limit=$10), store in workspace, reuse on next launch.
#
STRINGCOST_PRESIGN_FILE=/home/agent/.openeral/presign.json

normalize_stringcost_proxy_url() {
  node -e '
const raw = (process.argv[1] || "").trim();
if (!raw) process.exit(0);

try {
  // Accept the hosted shape (https://proxy.stringcost.com/stringcost-proxy/t/...)
  // and any self-hosted shape (http(s)://<any-host>/stringcost-proxy/t/...).
  const match = raw.match(/https?:\/\/[^\s"'\''<>]+\/stringcost-proxy\/t\/[^\s"'\''<>]+/);
  const candidate = match ? match[0] : raw;
  const url = new URL(candidate);
  url.pathname = url.pathname.replace(/\/v1\/.*$/, "");
  url.search = "";
  url.hash = "";
  const normalized = url.toString().replace(/\/$/, "");
  if (!/^https?:\/\/[^/]+\/stringcost-proxy\/t\/[^/]+$/.test(normalized)) {
    throw new Error("unexpected StringCost proxy URL shape");
  }
  process.stdout.write(normalized);
} catch (err) {
  process.stderr.write((err && err.message) || String(err));
  process.exit(1);
}
' "$1"
}

if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_PROXY_URL" 2>/dev/null || true)"
  export STRINGCOST_PROXY_URL
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ]; then
  STRINGCOST_UPLOAD_FILE=""
  for candidate in \
    /sandbox/stringcost-presign \
    /sandbox/stringcost-url \
    /sandbox/openeral-input/presign.json \
    /sandbox/openeral-input/stringcost-url
  do
    if [ -f "$candidate" ]; then
      STRINGCOST_UPLOAD_FILE="$candidate"
      break
    fi
  done
  if [ -z "$STRINGCOST_UPLOAD_FILE" ] && [ -d /sandbox/openeral-input ]; then
    STRINGCOST_UPLOAD_FILE="$(find /sandbox/openeral-input -type f \( -name presign.json -o -name stringcost-url \) | head -1)"
  fi
  if [ -n "$STRINGCOST_UPLOAD_FILE" ]; then
    STRINGCOST_UPLOADED_URL="$(node -e "
try {
  const raw = require('fs').readFileSync(process.argv[1], 'utf8').trim();
  if (!raw) process.exit(0);
  try {
    const d = JSON.parse(raw);
    process.stdout.write((d && d.url) || '');
  } catch {
    process.stdout.write(raw);
  }
} catch {}
" "$STRINGCOST_UPLOAD_FILE" 2>/dev/null || true)"
    STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_UPLOADED_URL" 2>/dev/null || true)"
    if [ -n "$STRINGCOST_PROXY_URL" ]; then
      echo "setup.sh: using uploaded StringCost presign from $STRINGCOST_UPLOAD_FILE"
      export STRINGCOST_PROXY_URL
    fi
  fi
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -f "$STRINGCOST_PRESIGN_FILE" ]; then
  STRINGCOST_STORED_URL="$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  if (d && d.url) process.stdout.write(d.url);
} catch {}
" "$STRINGCOST_PRESIGN_FILE" 2>/dev/null || true)"
  STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_STORED_URL" 2>/dev/null || true)"
  if [ -n "$STRINGCOST_PROXY_URL" ]; then
    echo "setup.sh: reusing stored StringCost presign from $STRINGCOST_PRESIGN_FILE"
    export STRINGCOST_PROXY_URL
  fi
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -n "${STRINGCOST_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  case "${ANTHROPIC_API_KEY:-}" in
    openshell:resolve:env:*)
      echo "setup.sh: skipping StringCost presign creation because ANTHROPIC_API_KEY is an OpenShell placeholder; upload a host-created presign.json to /sandbox/openeral-input instead" >&2
      ;;
    *)
  echo "setup.sh: creating a permanent StringCost presign for $OPENERAL_AGENT..."
  mkdir -p "$(dirname "$STRINGCOST_PRESIGN_FILE")"
  STRINGCOST_PRESIGN_ERR=/tmp/openeral-stringcost-presign.err
  rm -f "$STRINGCOST_PRESIGN_ERR"
  set +e
  STRINGCOST_FULL_PRESIGN_URL="$(NODE_NO_WARNINGS=1 node -e "
const fetch = globalThis.fetch;
(async () => {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 30000);
  try {
    const apiBase = (process.env.STRINGCOST_API_BASE || 'https://app.stringcost.com').replace(/\/+$/, '');
    const agent = process.env.OPENERAL_AGENT === 'openclaw' ? 'openclaw' : 'claude-code';
    const r = await fetch(apiBase + '/v1/presign', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.STRINGCOST_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: process.env.ANTHROPIC_API_KEY,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000,
        // metadata.labels is what StringCost's vendor portfolio classifier
        // reads. 'tags' on the request body is NOT a presign-schema field
        // and would be silently dropped.
        metadata: {
          source: 'openeral-sandbox',
          client: agent,
          labels: ['openeral', agent],
        },
      }),
      signal: controller.signal,
    });
    clearTimeout(to);
    if (!r.ok) {
      const t = await r.text();
      process.stderr.write('presign failed (' + r.status + '): ' + t + '\n');
      process.exit(1);
    }
    const d = await r.json();
    if (!d || !d.url) {
      process.stderr.write('presign returned no URL\n');
      process.exit(1);
    }
    const fs = require('fs');
    fs.writeFileSync(process.argv[1], JSON.stringify({ url: d.url, created_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
    process.stdout.write(d.url);
  } catch (e) {
    process.stderr.write('presign error: ' + (e && e.message || String(e)) + '\n');
    process.exit(1);
  }
})();
" "$STRINGCOST_PRESIGN_FILE" 2>"$STRINGCOST_PRESIGN_ERR")"
  rc=$?
  if [ $rc -eq 0 ] && [ -n "$STRINGCOST_FULL_PRESIGN_URL" ]; then
    STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url "$STRINGCOST_FULL_PRESIGN_URL" 2>"$STRINGCOST_PRESIGN_ERR")"
    rc=$?
  else
    STRINGCOST_PROXY_URL=""
  fi
  set -e
  if [ $rc -eq 0 ] && [ -n "$STRINGCOST_PROXY_URL" ]; then
    echo "setup.sh: presign stored at $STRINGCOST_PRESIGN_FILE"
    export STRINGCOST_PROXY_URL
  else
    echo "setup.sh: presign creation failed — continuing without StringCost" >&2
    if [ -s "$STRINGCOST_PRESIGN_ERR" ]; then
      echo "  detail: $(cat "$STRINGCOST_PRESIGN_ERR")" >&2
    fi
    STRINGCOST_PROXY_URL=""
  fi
  rm -f "$STRINGCOST_PRESIGN_ERR"
      ;;
  esac
fi

# Export ANTHROPIC_BASE_URL once the proxy URL is resolved so every downstream
# child process inherits it: the openclaw gateway started via `setsid env ...`,
# the openclaw / claude exec at the end of this script, and any node -e blocks
# that read process.env.ANTHROPIC_BASE_URL while writing config files.
# Claude Code ALSO has it explicitly passed in its exec; OpenClaw needs it set
# in the parent shell because its gateway is launched as a background process
# that inherits this env.
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  export ANTHROPIC_BASE_URL="$STRINGCOST_PROXY_URL"
fi

# Apply proxy to Claude Code settings if we have one. OpenClaw has no
# ~/.claude/settings.json — it picks up ANTHROPIC_BASE_URL from the env at
# launch (see the OpenClaw exec block further down).
#
# ANTHROPIC_AUTH_TOKEN is set to a dummy value so Claude Code does not prompt
# for re-authentication when ANTHROPIC_API_KEY is absent (e.g. on reconnect).
# StringCost authenticates via the presign token embedded in ANTHROPIC_BASE_URL,
# not via the Bearer token Claude sends, so any non-empty value works here.
if [ -n "${STRINGCOST_PROXY_URL:-}" ] && [ "$OPENERAL_AGENT" != "openclaw" ]; then
  echo "setup.sh: writing StringCost proxy to ~/.claude/settings.json..."
  node -e "
const fs = require('fs');
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
s.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
delete s.env.ANTHROPIC_API_KEY;
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: StringCost proxy written to ~/.claude/settings.json');
"
fi

echo "setup.sh: running migrations..."
# Log which DB target we're pointing at (redact credentials from the URL)
DB_HOST="$(node -e "try { const u = new URL(process.env.DATABASE_URL); console.log(u.hostname + ':' + (u.port || '5432')); } catch { console.log('(unparseable)'); }")"
echo "setup.sh: using external PostgreSQL at $DB_HOST"

node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { runMigrations } = await import('$OPENERAL_DIR/dist/db/migrations.js');
    const { pool } = await getDatabaseConnection();
    await runMigrations(pool);
    await pool.end();
    console.log('setup.sh: migrations complete');
  }).catch(err => {
    // Print EVERY piece of info we have — demo users need something to go on
    const msg = err && (err.message || err.toString()) || '(no message)';
    const code = err && err.code ? ' code=' + err.code : '';
    const hint = err && err.code === 'ENOTFOUND' ? '  (DATABASE_URL host is not resolvable from the sandbox — ensure it is a public hostname like Supabase, not a loopback IP)' :
                 err && err.code === 'ECONNREFUSED' ? '  (DATABASE_URL host refused the connection — check port and firewall)' :
                 err && /password/i.test(msg) ? '  (credential rejected — re-check DATABASE_URL)' : '';
    console.error('setup.sh: migration failed:', msg + code);
    if (hint) console.error(hint);
    if (err && err.stack) console.error(err.stack);
    process.exit(1);
  });
"

echo "setup.sh: seeding workspace $WORKSPACE_ID..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const ws = await import('$OPENERAL_DIR/dist/db/workspace-queries.js');
    const { pool } = await getDatabaseConnection();

    try {
      await pool.query(
        \"INSERT INTO _openeral.workspace_config (id, display_name, config) VALUES (\\\$1, \\\$2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING\",
        [process.env.WORKSPACE_ID, 'sandbox']
      );
    } catch {}

    // Seed root, .claude dirs, and default security settings
    const defaultSettings = JSON.stringify({
      permissions: {
        allow: [
          \"Bash(npm run *)\",
          \"Bash(npm test *)\",
          \"Bash(git status)\",
          \"Bash(git diff *)\",
          \"Bash(git log *)\",
          \"Bash(git commit *)\",
          \"Bash(ls *)\",
          \"Bash(cat *)\",
          \"Bash(grep *)\"
        ],
        deny: [
          \"Read(~/.ssh/**)\",
          \"Read(~/.aws/**)\",
          \"Read(~/.azure/**)\",
          \"Read(~/.npmrc)\",
          \"Read(~/.git-credentials)\",
          \"Edit(~/.bashrc)\",
          \"Edit(~/.zshrc)\",
          \"Bash(curl *)\",
          \"Bash(wget *)\",
          \"Bash(nc *)\",
          \"Bash(ssh *)\",
          \"Bash(git push *)\",
          \"Read(*.env)\",
          \"Read(.env.*)\"
        ]
      },
      enableAllProjectMcpServers: false
    }, null, 2);

    const agentKind = process.env.OPENERAL_AGENT || 'claude';
    const autoDirs = agentKind === 'openclaw'
      ? ['/', '/.config', '/.openclaw']
      : ['/', '/.claude', '/.claude/projects'];
    const seedFiles = agentKind === 'openclaw'
      ? {}
      : { '/.claude/settings.json': defaultSettings };

    await ws.seedFromConfig(pool, process.env.WORKSPACE_ID, {
      autoDirs,
      seedFiles,
    });

    await pool.end();
    console.log('setup.sh: workspace seeded');
  }).catch(err => {
    console.error('setup.sh: seed failed:', err.message);
    process.exit(1);
  });
"

echo "setup.sh: restoring /home/agent from workspace..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { syncToFs, createHomeSyncOptions } = await import('$OPENERAL_DIR/dist/sync.js');
    const { pool } = await getDatabaseConnection();
    const count = await syncToFs(pool, process.env.WORKSPACE_ID, '/home/agent', createHomeSyncOptions({ prune: false }));
    await pool.end();
    console.log('setup.sh: restored ' + count + ' workspace entr' + (count === 1 ? 'y' : 'ies'));
  }).catch(err => {
    console.error('setup.sh: restore failed:', err.message);
    process.exit(1);
  });
"

# Re-apply git URL rewrites after the workspace restore. syncToFs is authoritative
# and may overwrite /home/agent/.gitconfig with an older version that lacks the
# ssh-to-https rewrites. Writing them again here guarantees the pre-stage
# (openclaw status --deep) and every subsequent npm/git operation finds them.
# --unset-all + --add (see top-of-file block) keeps all three rewrites alive.
if [ "${OPENERAL_AGENT}" = "openclaw" ]; then
  HOME=/home/agent git config --global --unset-all url."https://github.com/".insteadOf 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
  HOME=/home/agent git config --global --add url."https://github.com/".insteadOf "git+ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global http.sslVerify false 2>/dev/null || true
fi

# Re-apply runtime settings after the restore step. syncToFs intentionally makes
# PostgreSQL authoritative, so freshly generated settings must be written after it.
if [ -n "${STRINGCOST_PROXY_URL:-}" ] && [ "$OPENERAL_AGENT" != "openclaw" ]; then
  echo "setup.sh: writing StringCost proxy to ~/.claude/settings.json..."
  node -e "
const fs = require('fs');
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
s.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
delete s.env.ANTHROPIC_API_KEY;
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: StringCost proxy written to ~/.claude/settings.json');
"
fi

# Persist ANTHROPIC_BASE_URL to the shell environment so reconnect sessions
# (openshell sandbox connect) also route through StringCost even if
# ~/.claude/settings.json is reset by `claude init` or similar.
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  mkdir -p /home/agent/.openeral
  printf 'export ANTHROPIC_BASE_URL="%s"\nexport ANTHROPIC_AUTH_TOKEN="dummy"\nunset ANTHROPIC_API_KEY\n' \
    "$STRINGCOST_PROXY_URL" > /home/agent/.openeral/env.sh
  BASHRC=/home/agent/.bashrc
  if ! grep -q 'openeral/env.sh' "$BASHRC" 2>/dev/null; then
    printf '\n[ -f ~/.openeral/env.sh ] && . ~/.openeral/env.sh\n' >> "$BASHRC"
  fi
fi

# openshell sandbox connect gives a shell with HOME=$SANDBOX_USER_HOME (e.g. /sandbox),
# not /home/agent. Always patch that shell's .bashrc so reconnect sessions use
# the correct HOME — without this openclaw cannot find its config or gateway
# auth token regardless of whether StringCost is active.
if [ "$SANDBOX_USER_HOME" != "/home/agent" ] && [ -n "$SANDBOX_USER_HOME" ]; then
  CONNECT_BASHRC="$SANDBOX_USER_HOME/.bashrc"
  if ! grep -q 'openeral-connect' "$CONNECT_BASHRC" 2>/dev/null; then
    printf '\n# openeral-connect: set agent HOME for sandbox connect sessions\nexport HOME=/home/agent\n[ -f /home/agent/.openeral/env.sh ] && . /home/agent/.openeral/env.sh\n' \
      >> "$CONNECT_BASHRC"
  fi
  # Apply the same openclaw runtime env to reconnect sessions so manual
  # `openclaw` invocations don't re-pay startup overhead or hit TLS-verify
  # failures during plugin staging.
  if ! grep -q 'openeral-openclaw-env' "$CONNECT_BASHRC" 2>/dev/null; then
    printf '\n# openeral-openclaw-env: runtime env for manual openclaw invocations\nexport OPENCLAW_NO_RESPAWN=1\nexport NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache\nexport GIT_SSL_NO_VERIFY=true\nexport npm_config_strict_ssl=false\n' \
      >> "$CONNECT_BASHRC"
  fi
fi

echo "setup.sh: flushing /home/agent to workspace..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { syncFromFs, createHomeSyncOptions } = await import('$OPENERAL_DIR/dist/sync.js');
    const { pool } = await getDatabaseConnection();
    const count = await syncFromFs(pool, process.env.WORKSPACE_ID, '/home/agent', createHomeSyncOptions());
    await pool.end();
    console.log('setup.sh: flushed ' + count + ' workspace entr' + (count === 1 ? 'y' : 'ies'));
  }).catch(err => {
    console.error('setup.sh: flush failed:', err.message);
    process.exit(1);
  });
"

# Configure Socket.dev registry if SOCKET_TOKEN provider is available.
# The token value is a placeholder (openshell:resolve:env:SOCKET_TOKEN) —
# the OpenShell proxy resolves it to the real token in auth headers.
#
# Uses a separate openeral-managed file (/tmp/openeral-npmrc), NOT the user's
# ~/.npmrc, to avoid clobbering user config. Passed to npm via NPM_CONFIG_USERCONFIG.
OPENERAL_NPMRC=/tmp/openeral-npmrc
rm -f "$OPENERAL_NPMRC"
if [ -n "${SOCKET_TOKEN:-}" ]; then
  echo "setup.sh: configuring npm to use Socket.dev registry..."
  cat > "$OPENERAL_NPMRC" <<NPMRC
registry=https://registry.socket.dev/npm/
//registry.socket.dev/npm/:_authToken=${SOCKET_TOKEN}
NPMRC
  export NPM_CONFIG_USERCONFIG="$OPENERAL_NPMRC"
fi

echo "setup.sh: starting openeral-bash daemon..."
node "$OPENERAL_DIR/openeral-bash.mjs" --daemon &
DAEMON_PID=$!

# Wait for socket to appear
_d=0
while [ $_d -lt 300 ]; do
  [ -S /tmp/openeral-bash.sock ] && break
  [ $_d -eq 50 ] && echo "setup.sh: waiting for daemon to initialize..." >&2
  sleep 0.1
  _d=$((_d+1))
done

if [ -S /tmp/openeral-bash.sock ]; then
  echo "setup.sh: daemon ready (pid $DAEMON_PID)"
  # Clean up daemon on exit
  trap "kill $DAEMON_PID 2>/dev/null; rm -f /tmp/openeral-bash.sock" EXIT
else
  echo "setup.sh: warning: daemon not ready after 30s — using standalone mode" >&2
  unset DAEMON_PID
  trap "rm -f /tmp/openeral-bash.sock" EXIT
fi

if [ "$OPENERAL_AGENT" = "openclaw" ]; then
  # OpenClaw is baked into the image (see Dockerfile).
  # This fallback handles stale images — if you hit it, rebuild the image.
  if ! command -v openclaw >/dev/null 2>&1; then
    echo "setup.sh: OpenClaw not found in image — falling back to runtime install (slow)..." >&2
    SHARP_IGNORE_GLOBAL_LIBVIPS=1 npm install -g --loglevel=error openclaw@latest 2>&1 | tail -40
    if ! command -v openclaw >/dev/null 2>&1; then
      echo "setup.sh: ERROR: OpenClaw install failed" >&2
      exit 1
    fi
  fi

  # Set up the runtime env that every openclaw invocation in this block
  # depends on. This MUST happen before `openclaw onboard` runs — otherwise
  # onboard pays the full cold-start V8 JIT cost (~54s on first prompt per the
  # gateway trace) and frequently exceeds its timeout, leaving auth-profiles.json
  # half-written. Symptom: onboard exits non-zero, the TUI loads, but every
  # "hi" comes back as "run aborted / decision=surface_error reason=timeout".
  #
  # GIT_SSL_NO_VERIFY / npm_config_strict_ssl=false — npm-via-git uses its own
  #   TLS stack and ignores git's http.sslVerify config; without these, the
  #   plugin-install shell-outs still fail at the OpenShell terminating proxy.
  # OPENCLAW_NO_RESPAWN=1 — skip openclaw's self-respawn boot path (the doctor
  #   "Startup optimization" panel flags this; saves 1–2 s per invocation).
  # NODE_COMPILE_CACHE — V8 bytecode cache; makes the second+ runs of every
  #   openclaw subprocess (and there are many during onboard + plugin staging)
  #   noticeably faster.
  # OPENCLAW_PLUGIN_STAGE_DIR — keep bundled npm deps OUTSIDE /home/agent.
  #   /home/agent is synced to workspace_files in the DB; restoring a previous
  #   session's plugin-runtime-deps directory can leave a corrupt npm cache that
  #   makes the gateway fail to stage its 35 bundled packages (ENOENT on cache
  #   entries). /tmp is always writable by the sandbox user and is never synced.
  export GIT_SSL_NO_VERIFY=true
  export npm_config_strict_ssl=false
  export OPENCLAW_NO_RESPAWN=1
  export NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache
  export OPENCLAW_PLUGIN_STAGE_DIR=/tmp/openclaw-plugin-runtime-deps
  mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR" /tmp/openclaw-compile-cache

  # Seed the V8 compile cache from the image-baked copy. The Dockerfile primes
  # /opt/openclaw-compile-cache at build time by running the slow path
  # (status --deep + agent --local). Without this seed, onboard would JIT-compile
  # the entire openclaw codebase from cold every launch.
  if [ -d /opt/openclaw-compile-cache ] && [ -n "$(ls -A /opt/openclaw-compile-cache 2>/dev/null)" ]; then
    echo "setup.sh: seeding V8 compile cache from image..."
    # cp -rn: do not clobber any entry the running gateway has already written.
    cp -rn /opt/openclaw-compile-cache/. /tmp/openclaw-compile-cache/ 2>/dev/null || true
  fi

  # Install a diagnose script the user can run if openclaw misbehaves. Dumps
  # everything relevant: config, auth profile, gateway log tail, onboard log
  # tail, /readyz status, env vars. Lives in /home/agent so reconnect sessions
  # also find it.
  mkdir -p /home/agent/.openeral
  cat > /home/agent/.openeral/diagnose-openclaw.sh <<'DIAG_EOF'
#!/bin/bash
# OpenClaw diagnostic dump — run this if the TUI shows "run aborted" or hangs.
echo "=== openclaw version ==="
openclaw --version 2>&1 || true
echo
echo "=== env (relevant only) ==="
env | grep -E '^(HOME|ANTHROPIC_|OPENCLAW_|NODE_COMPILE_CACHE|GIT_SSL_NO_VERIFY|npm_config_)' | sed 's/\(ANTHROPIC_API_KEY=\).*/\1***REDACTED***/'
echo
echo "=== ~/.openclaw/openclaw.json ==="
if [ -f /home/agent/.openclaw/openclaw.json ]; then
  sed 's/\("ANTHROPIC_API_KEY":[[:space:]]*"\)[^"]*/\1***REDACTED***/' /home/agent/.openclaw/openclaw.json
else
  echo "(missing)"
fi
echo
echo "=== auth-profiles.json (exists?) ==="
ls -la /home/agent/.openclaw/agents/main/agent/auth-profiles.json 2>&1 || echo "(missing — onboard did not complete)"
echo
echo "=== /readyz ==="
curl -fsS -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:18789/readyz 2>&1 || echo "(unreachable)"
echo
echo "=== last 50 lines of gateway log ==="
tail -50 /tmp/openclaw-gateway.log 2>/dev/null || echo "(no log)"
echo
echo "=== last 50 lines of onboard log ==="
tail -50 /tmp/openclaw-onboard.log 2>/dev/null || echo "(no log)"
echo
echo "=== last 50 lines of bootstrap log ==="
tail -50 /tmp/openclaw-bootstrap.log 2>/dev/null || echo "(no log)"
DIAG_EOF
  chmod +x /home/agent/.openeral/diagnose-openclaw.sh

  # Run OpenClaw's non-interactive onboarding to create the proper auth profile.
  #
  # Writing only env.ANTHROPIC_API_KEY to openclaw.json is enough for Crestodian's
  # planner (it reads env vars directly), but the main agent's inference path
  # resolves credentials through auth-profiles.json — without that file, the TUI
  # surfaces "auth or provider access failed for anthropic" on the first prompt
  # and /auth opens an interactive OAuth flow that cannot complete in the sandbox.
  #
  # `openclaw onboard --non-interactive --auth-choice apiKey --anthropic-api-key`
  # is the documented automation entry point (see openclaw's docs/start/
  # wizard-cli-automation.md). It writes the auth profile to
  # ~/.openclaw/agents/main/agent/auth-profiles.json in the shape the agent runtime
  # expects, and is safe to re-run on each sandbox launch (idempotent merge).
  #
  # Skip --install-daemon: we launch the gateway manually below (no systemd).
  # --skip-bootstrap / --skip-skills: we seed workspace files ourselves via syncToFs.
  # --accept-risk: required when storing the key in plaintext mode.
  _openclaw_key_ok=false
  case "${ANTHROPIC_API_KEY:-}" in
    ''|openshell:resolve:env:*) ;;
    *) _openclaw_key_ok=true ;;
  esac
  if [ "$_openclaw_key_ok" = "true" ]; then
    echo "setup.sh: running openclaw onboard to create auth profile..."
    # 600s timeout: onboard does plugin discovery + dep resolution + auth-profile
    # write. With the V8 cache and PLUGIN_STAGE_DIR primed above, this typically
    # finishes in 60-180s, but cold network + dep download can push past 5 min.
    # The previous 120s was too aggressive — onboard was being SIGKILL'd by the
    # `timeout` command mid-write, leaving auth-profiles.json corrupt or absent
    # and every subsequent embedded run timing out as a result.
    #
    # IMPORTANT: `set -e` is active. The naive `cmd; rc=$?` pattern trips set -e
    # when onboard exits non-zero and aborts setup.sh entirely (symptom: setup
    # output stops at "running openclaw onboard..." and the sandbox session
    # exits). Wrap the call in `set +e` / `set -e` so a non-zero onboard is
    # surfaced as a warning instead of a fatal error.
    set +e
    HOME=/home/agent timeout 600 openclaw onboard --non-interactive \
      --mode local \
      --auth-choice apiKey \
      --anthropic-api-key "$ANTHROPIC_API_KEY" \
      --secret-input-mode plaintext \
      --gateway-port 18789 \
      --gateway-bind loopback \
      --skip-bootstrap \
      --skip-skills \
      --accept-risk \
      </dev/null >/tmp/openclaw-onboard.log 2>&1
    _onboard_rc=$?
    set -e
    if [ "$_onboard_rc" -eq 0 ]; then
      echo "setup.sh: openclaw onboard complete (auth profile written)"
    else
      echo "setup.sh: warning: openclaw onboard exited $_onboard_rc — last 30 lines of log:" >&2
      tail -30 /tmp/openclaw-onboard.log >&2 || true
      echo "setup.sh: (full log at /tmp/openclaw-onboard.log)" >&2
    fi

    # Verify auth-profiles.json was actually written. The embedded-run path
    # resolves credentials through this file specifically; without it, every
    # main-agent prompt returns "run aborted / decision=surface_error reason=timeout".
    AUTH_PROFILE_FILE=/home/agent/.openclaw/agents/main/agent/auth-profiles.json
    if [ ! -s "$AUTH_PROFILE_FILE" ]; then
      echo "setup.sh: warning: $AUTH_PROFILE_FILE is missing/empty after onboard." >&2
      echo "setup.sh:   Writing a minimal fallback auth profile so the embedded run path can" >&2
      echo "setup.sh:   resolve credentials. If this fallback does not work, run" >&2
      echo "setup.sh:   /home/agent/.openeral/diagnose-openclaw.sh inside the sandbox." >&2
      mkdir -p "$(dirname "$AUTH_PROFILE_FILE")"
      # Profile schema: openclaw resolves the profile by its content hash, so the
      # shape must match what `openclaw onboard` writes. Keep this minimal — only
      # the apiKey provider+secret are required for the embedded run path.
      HOME=/home/agent node -e "
const fs = require('fs');
const file = process.argv[1];
const key = process.env.ANTHROPIC_API_KEY || '';
if (!key) { process.stderr.write('no ANTHROPIC_API_KEY — cannot write fallback profile\n'); process.exit(1); }
const profile = {
  version: 1,
  profiles: {
    anthropic: {
      provider: 'anthropic',
      authType: 'apiKey',
      apiKey: key,
      createdAt: new Date().toISOString(),
      source: 'openeral-setup-fallback',
    },
  },
  defaultProfile: 'anthropic',
};
fs.mkdirSync(require('path').dirname(file), { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(profile, null, 2), { mode: 0o600 });
process.stdout.write('setup.sh: fallback auth profile written to ' + file + '\n');
" "$AUTH_PROFILE_FILE" || echo "setup.sh: fallback profile write failed" >&2
    fi
  fi

  # Write ~/.openclaw/openclaw.json to set our model defaults and handshake timeout.
  # This runs AFTER onboard so we layer our overrides on top of whatever onboard
  # wrote. Merge logic below uses `if (!config.x.y)` so existing fields are preserved.
  #
  # IMPORTANT: OpenShell placeholder values (openshell:resolve:env:*) are NOT written
  # to the config for the API key. Unlike Claude Code (a patched binary), OpenClaw's
  # Node.js gateway uses the Anthropic SDK directly and does not route through
  # OpenShell's HTTP proxy — so a placeholder in ANTHROPIC_API_KEY would be sent raw
  # to Anthropic, which rejects it, causing all API calls to hang silently.
  # Only real (non-placeholder) key values are written.
  echo "setup.sh: writing openclaw config..."
  HOME=/home/agent node -e "
const fs = require('fs');
const dir = process.env.HOME + '/.openclaw';
const file = dir + '/openclaw.json';
let config = {};
try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!config.env) config.env = {};
if (!config.gateway) config.gateway = {};
if (!config.gateway.mode) config.gateway.mode = 'local';
// 30 s handshake timeout — containers can be slow on cold cache; default is 3 s
if (!config.gateway.handshakeTimeoutMs) config.gateway.handshakeTimeoutMs = 30000;
if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
config.agents.defaults.model.primary = 'anthropic/claude-sonnet-4-6';
const rawKey = process.env.ANTHROPIC_API_KEY || '';
const realKey = rawKey.startsWith('openshell:resolve:env:') ? '' : rawKey;
if (realKey) {
  config.env.ANTHROPIC_API_KEY = realKey;
} else {
  delete config.env.ANTHROPIC_API_KEY;
}
// StringCost integration: route Anthropic traffic through the proxy.
// openclaw's built-in 'anthropic' provider hardcodes api.anthropic.com and
// ignores models.providers.anthropic.baseUrl for routing (see openclaw
// issue #56679 — that field is only read for header-shaping). The reliable
// path is to register a *new* provider name with api: 'anthropic-messages'
// and re-point anthropic/* model references to the new provider id.
// env.ANTHROPIC_BASE_URL is still written so any child process using the
// bare @anthropic-ai/sdk inherits it.
const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
if (baseUrl) {
  config.env.ANTHROPIC_BASE_URL = baseUrl;
} else {
  delete config.env.ANTHROPIC_BASE_URL;
}
delete config.env.ANTHROPIC_AUTH_TOKEN;
if (baseUrl) {
  if (!config.models) config.models = {};
  if (!config.models.mode) config.models.mode = 'merge';
  if (!config.models.providers) config.models.providers = {};
  // api: 'anthropic-messages' makes openclaw use Anthropic's wire format and
  // append '/v1/messages' to baseUrl automatically — the StringCost presign
  // URL has no /v1 suffix so this is correct. apiKey is required by openclaw
  // but ignored by the StringCost proxy (auth is via the presign token
  // already embedded in baseUrl).
  config.models.providers.stringcost = {
    baseUrl: baseUrl,
    api: 'anthropic-messages',
    apiKey: realKey || 'stringcost-presign-auth',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, maxTokens: 64000 },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 1000000, maxTokens: 32000 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 8192 },
    ],
  };
  const remap = id => (typeof id === 'string' && id.startsWith('anthropic/'))
    ? 'stringcost/' + id.slice('anthropic/'.length) : id;
  if (config.agents.defaults.model.primary) {
    config.agents.defaults.model.primary = remap(config.agents.defaults.model.primary);
  }
  if (Array.isArray(config.agents.defaults.model.fallbacks)) {
    config.agents.defaults.model.fallbacks =
      config.agents.defaults.model.fallbacks.map(remap);
  }
  // Strip dead-letter overrides on the built-in anthropic provider.
  if (config.models.providers.anthropic) {
    delete config.models.providers.anthropic.baseUrl;
    delete config.models.providers.anthropic.apiKey;
    delete config.models.providers.anthropic.api;
  }
} else {
  // No StringCost — remove any stringcost provider/mapping from prior runs.
  if (config.models && config.models.providers) {
    delete config.models.providers.stringcost;
    if (config.models.providers.anthropic) {
      delete config.models.providers.anthropic.baseUrl;
      delete config.models.providers.anthropic.apiKey;
      delete config.models.providers.anthropic.api;
    }
  }
  const restore = id => (typeof id === 'string' && id.startsWith('stringcost/'))
    ? 'anthropic/' + id.slice('stringcost/'.length) : id;
  if (config.agents.defaults.model.primary) {
    config.agents.defaults.model.primary = restore(config.agents.defaults.model.primary);
  }
  if (Array.isArray(config.agents.defaults.model.fallbacks)) {
    config.agents.defaults.model.fallbacks =
      config.agents.defaults.model.fallbacks.map(restore);
  }
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('setup.sh: openclaw config written to ' + file);
"

  # Warn if OpenClaw has no usable API credentials.
  # A placeholder (openshell:resolve:env:*) is NOT usable — unlike Claude Code,
  # OpenClaw's Node.js gateway does not route through OpenShell's HTTP proxy, so
  # the placeholder would be sent raw to Anthropic and every API call would hang.
  # $_openclaw_key_ok is set by the onboarding block above.
  if [ "$_openclaw_key_ok" = "false" ]; then
    echo "setup.sh: WARNING: OpenClaw has no usable API credentials." >&2
    echo "setup.sh:   ANTHROPIC_API_KEY is missing or is an OpenShell placeholder that" >&2
    echo "setup.sh:   OpenClaw's gateway cannot resolve. Responses will hang." >&2
    echo "setup.sh:   Upload a real key file before creating the sandbox:" >&2
    echo "setup.sh:     echo '<your-anthropic-api-key>' > /tmp/anthropic-api-key" >&2
    echo "setup.sh:     openshell sandbox create --upload /tmp/anthropic-api-key:/sandbox/anthropic-api-key ..." >&2
  fi

  # OpenClaw uses a gateway/client architecture: the gateway (ws://127.0.0.1:18789)
  # must be running before the openclaw client is launched.
  # In containers (no systemd), use `openclaw gateway --port 18789` as a foreground
  # process launched in the background, rather than `openclaw gateway start`
  # which requires a systemd user session.
  #
  # OPENCLAW_SKIP_ONBOARDING=1 — skip the interactive first-run onboarding wizard
  #   (config is already written by setup.sh above; without this the doctor check
  #   blocks even with </dev/null because it inspects TTY state during startup).
  # OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000 — lengthen the WebSocket pre-auth handshake
  #   timeout from the default 3 s to 30 s; containers with cold image caches can
  #   take several seconds between the TCP port opening and WebSocket RPC being live.
  #
  # OPENCLAW_PLUGIN_STAGE_DIR, NODE_COMPILE_CACHE, GIT_SSL_NO_VERIFY,
  # npm_config_strict_ssl, OPENCLAW_NO_RESPAWN are all exported earlier in this
  # block (before `openclaw onboard`) so onboard, the gateway, and the doctor
  # subcommands all see consistent env. See the runtime-env block above.

  echo "setup.sh: starting openclaw gateway..."
  # setsid puts the gateway in a new session with no controlling terminal.
  # Without this, exiting the openclaw TUI (Ctrl+C) sends SIGHUP to the entire
  # session including the background gateway, killing it. With setsid the gateway
  # survives TUI exit, so `openshell sandbox connect` finds it still running.
  setsid env OPENCLAW_SKIP_ONBOARDING=1 OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000 \
    OPENCLAW_NO_RESPAWN=1 \
    NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache \
    GIT_SSL_NO_VERIFY=true npm_config_strict_ssl=false \
    HOME=/home/agent openclaw gateway --port 18789 --allow-unconfigured \
    </dev/null >/tmp/openclaw-gateway.log 2>&1 &
  _gw_pid=$!
  echo "$_gw_pid" > /tmp/openclaw-gateway.pid
  # Wait up to 600s for /readyz (NOT just TCP).
  # TCP opens well before the WebSocket RPC layer is live; /readyz returns 200
  # only once the gateway is truly ready to accept client connections.
  # The gateway stages 35 bundled npm packages on every cold start, which can take
  # several minutes on slow networks. Wait up to 600s (10 min) before giving up.
  _gd=0
  while [ $_gd -lt 600 ]; do
    curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1 && break
    [ $_gd -eq 10 ] && echo "setup.sh: waiting for openclaw gateway readiness (/readyz) — this can take a few minutes on first run..." >&2
    [ $_gd -eq 60 ] && echo "setup.sh: still waiting for gateway (staging bundled deps)..." >&2
    [ $_gd -eq 120 ] && echo "setup.sh: still waiting for gateway (2 min)..." >&2
    [ $_gd -eq 180 ] && echo "setup.sh: still waiting for gateway (3 min)..." >&2
    [ $_gd -eq 240 ] && echo "setup.sh: still waiting for gateway (4 min)..." >&2
    [ $_gd -eq 300 ] && echo "setup.sh: still waiting for gateway (5 min)..." >&2
    [ $_gd -eq 420 ] && echo "setup.sh: still waiting for gateway (7 min)..." >&2
    [ $_gd -eq 540 ] && echo "setup.sh: still waiting for gateway (9 min)..." >&2
    sleep 1
    _gd=$((_gd+1))
  done
  if curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; then
    echo "setup.sh: openclaw gateway ready (pid $_gw_pid)"
  else
    echo "setup.sh: warning: openclaw gateway not ready after 600s — check /tmp/openclaw-gateway.log" >&2
    cat /tmp/openclaw-gateway.log >&2 || true
  fi

  # Re-apply auth credentials: the gateway modifies openclaw.json during startup
  # (adds gateway.auth.token, may clobber env settings on first run). Write our
  # auth settings back now that the gateway has finished its own modifications.
  echo "setup.sh: re-applying openclaw auth config..."
  HOME=/home/agent node -e "
const fs = require('fs');
const dir = process.env.HOME + '/.openclaw';
const file = dir + '/openclaw.json';
// Retry the read: the gateway may still be writing its config. Falling back
// to {} on a race-condition parse failure would produce a stub file smaller
// than the gateway's copy, triggering the gateway's backup-restore logic and
// losing the auth token. Retry up to 5 times with 800 ms between attempts.
let config = {};
for (let attempt = 0; attempt < 5; attempt++) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
      config = parsed;
      break;
    }
  } catch(e) {}
  if (attempt < 4) {
    const end = Date.now() + 800;
    while (Date.now() < end) {}
  }
}
if (!config.env) config.env = {};
const rawKey = process.env.ANTHROPIC_API_KEY || '';
const realKey = rawKey.startsWith('openshell:resolve:env:') ? '' : rawKey;
if (realKey) {
  config.env.ANTHROPIC_API_KEY = realKey;
} else {
  delete config.env.ANTHROPIC_API_KEY;
}
// StringCost integration — same logic as the initial openclaw config write
// above. Re-apply after the gateway's own config rewrite so the custom
// 'stringcost' provider and remapped model ids survive the gateway's
// startup-time merges. See openclaw issue #56679 for why we cannot just
// override the built-in anthropic provider's baseUrl.
const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
if (baseUrl) {
  config.env.ANTHROPIC_BASE_URL = baseUrl;
} else {
  delete config.env.ANTHROPIC_BASE_URL;
}
delete config.env.ANTHROPIC_AUTH_TOKEN;
if (!config.agents) config.agents = {};
if (!config.agents.defaults) config.agents.defaults = {};
if (!config.agents.defaults.model) config.agents.defaults.model = {};
if (baseUrl) {
  if (!config.models) config.models = {};
  if (!config.models.mode) config.models.mode = 'merge';
  if (!config.models.providers) config.models.providers = {};
  config.models.providers.stringcost = {
    baseUrl: baseUrl,
    api: 'anthropic-messages',
    apiKey: realKey || 'stringcost-presign-auth',
    models: [
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 1000000, maxTokens: 64000 },
      { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', contextWindow: 1000000, maxTokens: 32000 },
      { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextWindow: 200000, maxTokens: 8192 },
    ],
  };
  const remap = id => (typeof id === 'string' && id.startsWith('anthropic/'))
    ? 'stringcost/' + id.slice('anthropic/'.length) : id;
  if (config.agents.defaults.model.primary) {
    config.agents.defaults.model.primary = remap(config.agents.defaults.model.primary);
  }
  if (Array.isArray(config.agents.defaults.model.fallbacks)) {
    config.agents.defaults.model.fallbacks =
      config.agents.defaults.model.fallbacks.map(remap);
  }
  if (config.models.providers.anthropic) {
    delete config.models.providers.anthropic.baseUrl;
    delete config.models.providers.anthropic.apiKey;
    delete config.models.providers.anthropic.api;
  }
} else {
  if (config.models && config.models.providers) {
    delete config.models.providers.stringcost;
    if (config.models.providers.anthropic) {
      delete config.models.providers.anthropic.baseUrl;
      delete config.models.providers.anthropic.apiKey;
      delete config.models.providers.anthropic.api;
    }
  }
  const restore = id => (typeof id === 'string' && id.startsWith('stringcost/'))
    ? 'anthropic/' + id.slice('stringcost/'.length) : id;
  if (config.agents.defaults.model.primary) {
    config.agents.defaults.model.primary = restore(config.agents.defaults.model.primary);
  }
  if (Array.isArray(config.agents.defaults.model.fallbacks)) {
    config.agents.defaults.model.fallbacks =
      config.agents.defaults.model.fallbacks.map(restore);
  }
}
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('setup.sh: openclaw auth config applied');
"

  # After the config rewrite the gateway may briefly restart. Wait for /readyz
  # again before handing off to openclaw — a TCP check is not sufficient here.
  _gw_post=0
  while [ $_gw_post -lt 60 ]; do
    curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1 && break
    sleep 1
    _gw_post=$((_gw_post+1))
  done
  if curl -fsS http://127.0.0.1:18789/readyz >/dev/null 2>&1; then
    echo "setup.sh: gateway stable after auth config"
  else
    echo "setup.sh: warning: gateway not responding after config re-apply" >&2
    cat /tmp/openclaw-gateway.log >&2 || true
  fi

  # Pre-stage TUI plugin npm deps so the first user prompt doesn't pay the full
  # plugin-install latency (which was ~10 min in practice without this step).
  # The TUI's plugin-runtime-deps live under ~/.openclaw/plugin-runtime-deps/
  # because OPENCLAW_PLUGIN_STAGE_DIR is intentionally unset for the TUI process
  # (forwarding it caused the TUI to run its own concurrent staging loop and
  # freeze the terminal). Seed from an image-baked cache first (Dockerfile Fix
  # 3), then run a deep status probe so any remaining plugins finish staging
  # while we have a tty-free shell to absorb the wait.
  if [ -d /opt/openclaw-plugin-cache ] && [ -n "$(ls -A /opt/openclaw-plugin-cache 2>/dev/null)" ]; then
    echo "setup.sh: seeding TUI plugin cache from image..."
    mkdir -p /home/agent/.openclaw/plugin-runtime-deps
    # cp -rn: don't clobber files the workspace restore may have already placed.
    cp -rn /opt/openclaw-plugin-cache/. /home/agent/.openclaw/plugin-runtime-deps/ 2>/dev/null || true
  fi

  echo "setup.sh: pre-staging TUI plugin deps (this can take a few minutes on first run)..."
  # Same env (GIT_SSL_NO_VERIFY, npm_config_strict_ssl, OPENCLAW_NO_RESPAWN,
  # NODE_COMPILE_CACHE) was exported above, so this inherits it. The timeout
  # is shorter than gateway pre-stage because if it fails here, the TUI will
  # retry on demand — we don't want setup to block forever on a slow stage.
  HOME=/home/agent timeout 300 openclaw status --deep </dev/null \
    >/tmp/openclaw-bootstrap.log 2>&1 \
    && echo "setup.sh: TUI plugin pre-stage complete" \
    || echo "setup.sh: warning: TUI plugin pre-stage exited non-zero — continuing (see /tmp/openclaw-bootstrap.log)" >&2

  # Consolidate the plugin registry. After staging, the doctor often reports
  # "Persisted plugin registry is missing or stale" — `openclaw doctor --fix`
  # rebuilds ~/.openclaw/plugins/installs.json from what is actually present.
  # Without this, every TUI launch re-runs plugin discovery and partial install.
  HOME=/home/agent timeout 60 openclaw doctor --fix </dev/null \
    >>/tmp/openclaw-bootstrap.log 2>&1 \
    && echo "setup.sh: plugin registry consolidated" \
    || echo "setup.sh: note: doctor --fix exited non-zero — continuing" >&2

  echo "setup.sh: launching OpenClaw..."
  echo "setup.sh: if the TUI shows 'run aborted', exit and run:"
  echo "setup.sh:   bash /home/agent/.openeral/diagnose-openclaw.sh"
  # Auth credentials are now in ~/.openclaw/openclaw.json.
  # OPENCLAW_PLUGIN_STAGE_DIR is intentionally NOT forwarded: it is for the
  # gateway process only. Passing it to the TUI/client process causes openclaw
  # to run its own plugin staging loop on startup, which saturates the Node.js
  # event loop and makes the terminal completely unresponsive to keyboard input.
  #
  # When StringCost is active, pass ANTHROPIC_BASE_URL explicitly into the exec
  # env (mirroring the Claude Code launch below). The export earlier in setup.sh
  # already covers the gateway-inherit case; this line guarantees the TUI also
  # sees it even if anything between the export and here has touched the env.
  if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
    exec env -u STRINGCOST_API_KEY -u OPENCLAW_PLUGIN_STAGE_DIR \
      HOME=/home/agent \
      SHELL=/usr/local/bin/openeral-bash \
      PATH="$PATH" \
      OPENCLAW_NO_RESPAWN=1 \
      NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache \
      GIT_SSL_NO_VERIFY=true \
      npm_config_strict_ssl=false \
      ANTHROPIC_BASE_URL="$STRINGCOST_PROXY_URL" \
      openclaw "$@"
  else
    exec env -u STRINGCOST_API_KEY -u OPENCLAW_PLUGIN_STAGE_DIR \
      HOME=/home/agent \
      SHELL=/usr/local/bin/openeral-bash \
      PATH="$PATH" \
      OPENCLAW_NO_RESPAWN=1 \
      NODE_COMPILE_CACHE=/tmp/openclaw-compile-cache \
      GIT_SSL_NO_VERIFY=true \
      npm_config_strict_ssl=false \
      openclaw "$@"
  fi
fi

# Claude Code launch (reached only when OPENERAL_AGENT != openclaw, since openclaw execs above).
# Install Claude Code if not already present in the image
if ! command -v claude >/dev/null 2>&1; then
  echo "setup.sh: Claude CLI not found, installing..."
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -10
  if ! command -v claude >/dev/null 2>&1; then
    echo "setup.sh: ERROR: Claude CLI install failed" >&2
    exit 1
  fi
  echo "setup.sh: Claude CLI installed"
fi

# Claude Code reads ANTHROPIC_BASE_URL from process.env at startup for
# auth-mode selection. Export the proxy here so it's picked up before
# settings.json is consulted. STRINGCOST_API_KEY is only needed for presign
# creation — remove it before handing control to Claude Code.
echo "setup.sh: launching Claude Code..."
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  exec env -u STRINGCOST_API_KEY -u ANTHROPIC_AUTH_TOKEN \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openeral-bash \
    ANTHROPIC_BASE_URL="$STRINGCOST_PROXY_URL" \
    claude "$@"
else
  exec env \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openeral-bash \
    claude "$@"
fi
