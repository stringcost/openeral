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
if [ "${OPENERAL_AGENT}" = "openclaw" ]; then
  mkdir -p /home/agent
  HOME=/home/agent git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
  HOME=/home/agent git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/" 2>/dev/null || true
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
      DATABASE_URL="$(cat "$DB_URL_FILE")"
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
      ANTHROPIC_API_KEY="$(cat "$ANTHROPIC_KEY_FILE")"
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

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -n "${STRINGCOST_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ] && [ "$OPENERAL_AGENT" != "openclaw" ]; then
  case "${ANTHROPIC_API_KEY:-}" in
    openshell:resolve:env:*)
      echo "setup.sh: skipping StringCost presign creation because ANTHROPIC_API_KEY is an OpenShell placeholder; upload a host-created presign.json to /sandbox/openeral-input instead" >&2
      ;;
    *)
  echo "setup.sh: creating a permanent StringCost presign..."
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
          client: 'claude-code',
          labels: ['openeral', 'claude-code'],
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
if [ "${OPENERAL_AGENT}" = "openclaw" ]; then
  HOME=/home/agent git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" 2>/dev/null || true
  HOME=/home/agent git config --global url."https://github.com/".insteadOf "git@github.com:" 2>/dev/null || true
  HOME=/home/agent git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/" 2>/dev/null || true
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

  # Write ~/.openclaw/openclaw.json so openclaw starts with the right model and
  # API credentials.
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
delete config.env.ANTHROPIC_BASE_URL;
delete config.env.ANTHROPIC_AUTH_TOKEN;
if (config.models && config.models.providers && config.models.providers.anthropic) {
  delete config.models.providers.anthropic.baseUrl;
  delete config.models.providers.anthropic.apiKey;
  delete config.models.providers.anthropic.api;
}
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log('setup.sh: openclaw config written to ' + file);
"

  # Warn if OpenClaw has no usable API credentials.
  # A placeholder (openshell:resolve:env:*) is NOT usable — unlike Claude Code,
  # OpenClaw's Node.js gateway does not route through OpenShell's HTTP proxy, so
  # the placeholder would be sent raw to Anthropic and every API call would hang.
  _openclaw_key_ok=false
  case "${ANTHROPIC_API_KEY:-}" in
    ''|openshell:resolve:env:*) ;;
    *) _openclaw_key_ok=true ;;
  esac
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
  # OPENCLAW_PLUGIN_STAGE_DIR — keep bundled npm deps OUTSIDE /home/agent.
  #   /home/agent is synced to workspace_files in the DB; restoring a previous
  #   session's plugin-runtime-deps directory can leave a corrupt npm cache that
  #   makes the gateway fail to stage its 35 bundled packages (ENOENT on cache
  #   entries). /tmp is always writable by the sandbox user and is never synced,
  #   so the gateway always gets a clean staging area on each sandbox launch.
  export OPENCLAW_PLUGIN_STAGE_DIR=/tmp/openclaw-plugin-runtime-deps
  mkdir -p "$OPENCLAW_PLUGIN_STAGE_DIR"

  echo "setup.sh: starting openclaw gateway..."
  # setsid puts the gateway in a new session with no controlling terminal.
  # Without this, exiting the openclaw TUI (Ctrl+C) sends SIGHUP to the entire
  # session including the background gateway, killing it. With setsid the gateway
  # survives TUI exit, so `openshell sandbox connect` finds it still running.
  setsid env OPENCLAW_SKIP_ONBOARDING=1 OPENCLAW_HANDSHAKE_TIMEOUT_MS=30000 \
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
delete config.env.ANTHROPIC_BASE_URL;
delete config.env.ANTHROPIC_AUTH_TOKEN;
if (config.models && config.models.providers && config.models.providers.anthropic) {
  delete config.models.providers.anthropic.baseUrl;
  delete config.models.providers.anthropic.apiKey;
  delete config.models.providers.anthropic.api;
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
  HOME=/home/agent timeout 600 openclaw status --deep </dev/null \
    >/tmp/openclaw-bootstrap.log 2>&1 \
    && echo "setup.sh: TUI plugin pre-stage complete" \
    || echo "setup.sh: warning: TUI plugin pre-stage exited non-zero — continuing (see /tmp/openclaw-bootstrap.log)" >&2

  echo "setup.sh: launching OpenClaw..."
  # Auth credentials are now in ~/.openclaw/openclaw.json.
  # OPENCLAW_PLUGIN_STAGE_DIR is intentionally NOT forwarded: it is for the
  # gateway process only. Passing it to the TUI/client process causes openclaw
  # to run its own plugin staging loop on startup, which saturates the Node.js
  # event loop and makes the terminal completely unresponsive to keyboard input.
  exec env -u STRINGCOST_API_KEY -u OPENCLAW_PLUGIN_STAGE_DIR \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openeral-bash \
    PATH="$PATH" \
    openclaw "$@"
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
