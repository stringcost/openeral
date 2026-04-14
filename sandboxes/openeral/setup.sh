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

# StringCost integration - if STRINGCOST_PROXY_URL is set, use it as ANTHROPIC_BASE_URL
if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  export ANTHROPIC_BASE_URL="${STRINGCOST_PROXY_URL}"
  echo "setup.sh: using StringCost proxy at ${ANTHROPIC_BASE_URL}"
fi

echo "setup.sh: running migrations..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { runMigrations } = await import('$OPENERAL_DIR/dist/db/migrations.js');
    const { pool } = await getDatabaseConnection();
    await runMigrations(pool);
    await pool.end();
    console.log('setup.sh: migrations complete');
  }).catch(err => {
    console.error('setup.sh: migration failed:', err.message);
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

    await ws.seedFromConfig(pool, process.env.WORKSPACE_ID, {
      autoDirs: ['/', '/.claude', '/.claude/projects'],
      seedFiles: {},
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

# Wait for socket to appear
for i in $(seq 1 30); do
  [ -S /tmp/openeral-bash.sock ] && break
  sleep 0.1
done

if [ ! -S /tmp/openeral-bash.sock ]; then
  echo "setup.sh: daemon failed to start" >&2
  exit 1
fi

echo "setup.sh: daemon ready (pid $DAEMON_PID)"

# Clean up daemon on exit
trap "kill $DAEMON_PID 2>/dev/null; rm -f /tmp/openeral-bash.sock" EXIT

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
exec env \
  HOME=/home/agent \
  SHELL=/usr/local/bin/openeral-bash \
  claude "$@"
