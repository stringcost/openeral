#!/bin/bash
set -euo pipefail

# setup.sh — OpenEral sandbox entry point
#
# Called by: openshell sandbox create ... -- /opt/openeral/setup.sh
#
# Steps:
#   1. Run database migrations
#   2. Seed the workspace
#   3. Start openeral-bash daemon
#   4. Exec Claude Code

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

# Fix the PGlite data directory to a stable path so every Node.js process
# in this script uses the same embedded database.  /home/agent is a real
# directory in the container (created in the Dockerfile).
export OPENERAL_DATA_DIR="${OPENERAL_DATA_DIR:-/home/agent/.openeral/data}"
mkdir -p "$OPENERAL_DATA_DIR"

# If DATABASE_URL is provided (external PostgreSQL), propagate it so
# getDatabaseConnection() picks it up over PGlite.
export DATABASE_URL="${DATABASE_URL:-${OPENERAL_DATABASE_URL:-}}"

# StringCost integration.
#
# Priority:
#   1. STRINGCOST_PROXY_URL already set → use it verbatim.
#   2. STRINGCOST_PROXY_URL stored from previous session in /home/agent/.openeral/presign.json → reuse.
#   3. STRINGCOST_API_KEY + ANTHROPIC_API_KEY present → create a new permanent presign
#      (expires_in=-1, max_uses=-1, cost_limit=$10), store in workspace, reuse on next launch.
STRINGCOST_PRESIGN_FILE=/home/agent/.openeral/presign.json

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -f "$STRINGCOST_PRESIGN_FILE" ]; then
  STRINGCOST_PROXY_URL="$(node -e "
try {
  const d = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
  if (d && d.url) process.stdout.write(d.url);
} catch {}
" "$STRINGCOST_PRESIGN_FILE" 2>/dev/null || true)"
  if [ -n "$STRINGCOST_PROXY_URL" ]; then
    echo "setup.sh: reusing stored StringCost presign from $STRINGCOST_PRESIGN_FILE"
    export STRINGCOST_PROXY_URL
  fi
fi

if [ -z "${STRINGCOST_PROXY_URL:-}" ] && [ -n "${STRINGCOST_API_KEY:-}" ] && [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "setup.sh: creating a permanent StringCost presign..."
  mkdir -p "$(dirname "$STRINGCOST_PRESIGN_FILE")"
  set +e
  STRINGCOST_PROXY_URL="$(node -e "
const fetch = globalThis.fetch;
(async () => {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 30000);
  try {
    const r = await fetch('https://app.stringcost.com/v1/presign', {
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
        tags: ['openeral'],
        metadata: { source: 'openeral-sandbox' },
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
" "$STRINGCOST_PRESIGN_FILE" 2>&1)"
  rc=$?
  set -e
  if [ $rc -eq 0 ] && [ -n "$STRINGCOST_PROXY_URL" ]; then
    echo "setup.sh: presign stored at $STRINGCOST_PRESIGN_FILE"
    export STRINGCOST_PROXY_URL
  else
    echo "setup.sh: presign creation failed — continuing without StringCost" >&2
    echo "  detail: $STRINGCOST_PROXY_URL" >&2
    STRINGCOST_PROXY_URL=""
  fi
fi

# Apply proxy to Claude Code settings if we have one
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  echo "setup.sh: writing StringCost proxy to ~/.claude/settings.json..."
  node -e "
const fs = require('fs');
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
s.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: StringCost proxy written to ~/.claude/settings.json');
"
fi

echo "setup.sh: running migrations..."
# Log which DB target we're pointing at (redact credentials from the URL)
if [ -n "${DATABASE_URL:-}" ]; then
  DB_HOST="$(node -e "try { const u = new URL(process.env.DATABASE_URL); console.log(u.hostname + ':' + (u.port || '5432')); } catch { console.log('(unparseable)'); }")"
  echo "setup.sh: using external PostgreSQL at $DB_HOST"
else
  echo "setup.sh: using embedded PGlite at $OPENERAL_DATA_DIR"
fi

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

    await ws.seedFromConfig(pool, process.env.WORKSPACE_ID, {
      autoDirs: ['/', '/.claude', '/.claude/projects'],
      seedFiles: {
        '/.claude/settings.json': defaultSettings
      },
    });

    await pool.end();
    console.log('setup.sh: workspace seeded');
  }).catch(err => {
    console.error('setup.sh: seed failed:', err.message);
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

# Wait for socket to appear — PGlite WASM can take 5-15s to initialize
_d=0
while [ $_d -lt 300 ]; do
  [ -S /tmp/openeral-bash.sock ] && break
  [ $_d -eq 50 ] && echo "setup.sh: waiting for daemon to initialize (PGlite WASM)..." >&2
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

# Launch Claude Code with persistent home
echo "setup.sh: launching Claude Code..."
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  exec env -u ANTHROPIC_API_KEY \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openeral-bash \
    claude "$@"
else
  exec env \
    HOME=/home/agent \
    SHELL=/usr/local/bin/openeral-bash \
    claude "$@"
fi
