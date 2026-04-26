#!/bin/bash
set -euo pipefail

# setup.sh — OpenEral sandbox entry point
#
# Called by: openshell sandbox create ... -- openeral-start
# (or legacy one-shot mode: ... -- openeral). Both names are /usr/local/bin
# shims to this script.
#
# Steps:
#   1. Run database migrations
#   2. Seed the workspace
#   3. Start openeral-bash daemon
#   4. In legacy openeral mode: exec Claude Code
#      In openeral-start service mode: keep the daemon alive for SSH sessions

# OpenShell's Node HTTP proxy path currently emits an experimental Undici warning
# in some environments. Keep setup output clean and, more importantly, keep
# warning text out of shell-captured values such as the StringCost presign URL.
export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"

OPENERAL_CMD="$(basename "$0")"
OPENERAL_SERVICE_MODE=0
if [ "$OPENERAL_CMD" = "openeral-start" ]; then
  OPENERAL_SERVICE_MODE=1
fi
if [ "${1:-}" = "--service" ]; then
  OPENERAL_SERVICE_MODE=1
  shift
fi
OPENERAL_CLI_SUBCOMMAND=0
case "${1:-}" in
  memory|stats|analyze|apply|optimize|presign) OPENERAL_CLI_SUBCOMMAND=1 ;;
esac

# Use /opt/openeral directly if accessible, otherwise copy to /home/agent
if [ -r /opt/openeral/dist/db/embedded.js ]; then
  OPENERAL_DIR=/opt/openeral
  [ "$OPENERAL_CLI_SUBCOMMAND" -eq 1 ] || echo "setup: using /opt/openeral directly"
else
  [ "$OPENERAL_CLI_SUBCOMMAND" -eq 1 ] || echo "setup: copying openeral to writable location..."
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

# When invoked inside an already-running sandbox, expose the openeral-js CLI
# through the same command name used as the sandbox entrypoint.
if [ "$OPENERAL_CLI_SUBCOMMAND" -eq 1 ]; then
  exec env HOME="/home/agent" OPENERAL_HOME="/home/agent" \
    node "$OPENERAL_DIR/dist/bin/openeral.js" "$@"
fi

# Workspace ID defaults to sandbox ID (set by OpenShell supervisor), but an
# explicit WORKSPACE_ID is the documented persistence key for service mode.
export WORKSPACE_ID="${WORKSPACE_ID:-${OPENSHELL_SANDBOX_ID:-default}}"

# Fix the PGlite data directory to a stable path so every Node.js process
# in this script uses the same embedded database. Keep it outside /home/agent
# so service-mode filesystem sync never recursively syncs PGlite internals.
export OPENERAL_DATA_DIR="${OPENERAL_DATA_DIR:-/var/lib/openeral/data}"
mkdir -p "$OPENERAL_DATA_DIR"

# If DATABASE_URL is provided (external PostgreSQL), propagate it so
# getDatabaseConnection() picks it up over PGlite.
#
# Resolution order:
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

# StringCost integration.
#
# Priority:
#   1. STRINGCOST_PROXY_URL already set → normalize and use it.
#   2. Uploaded presign JSON or URL under /sandbox/openeral-input → normalize and use it.
#   3. STRINGCOST_PROXY_URL stored from previous session in /home/agent/.openeral/presign.json → reuse.
#   4. STRINGCOST_API_KEY + raw ANTHROPIC_API_KEY present → create a new permanent presign
#      (expires_in=-1, max_uses=-1, cost_limit=$10), store in workspace, reuse on next launch.
STRINGCOST_PRESIGN_FILE=/home/agent/.openeral/presign.json

normalize_stringcost_proxy_url() {
  node -e '
const raw = (process.argv[1] || "").trim();
if (!raw) process.exit(0);

try {
  const match = raw.match(/https:\/\/proxy\.stringcost\.com\/stringcost-proxy\/t\/[^\s"'\''<>]+/);
  const candidate = match ? match[0] : raw;
  const url = new URL(candidate);
  url.pathname = url.pathname.replace(/\/v1\/.*$/, "");
  url.search = "";
  url.hash = "";
  const normalized = url.toString().replace(/\/$/, "");
  if (!/^https:\/\/proxy\.stringcost\.com\/stringcost-proxy\/t\/[^/]+$/.test(normalized)) {
    throw new Error("unexpected StringCost proxy URL shape");
  }
  process.stdout.write(normalized);
} catch (err) {
  process.stderr.write((err && err.message) || String(err));
  process.exit(1);
}
' "$1"
}

normalize_stringcost_proxy_url_or_warn() {
  local source="$1"
  local raw="$2"
  local err=/tmp/openeral-stringcost-normalize.err
  local normalized
  rm -f "$err"
  if normalized="$(normalize_stringcost_proxy_url "$raw" 2>"$err")"; then
    rm -f "$err"
    printf '%s' "$normalized"
    return 0
  fi
  if [ -n "$raw" ]; then
    local detail=""
    [ -s "$err" ] && detail=": $(cat "$err")"
    echo "setup.sh: ignoring invalid StringCost proxy URL from $source$detail" >&2
  fi
  rm -f "$err"
  return 0
}

if [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url_or_warn "STRINGCOST_PROXY_URL" "$STRINGCOST_PROXY_URL")"
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
    STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url_or_warn "$STRINGCOST_UPLOAD_FILE" "$STRINGCOST_UPLOADED_URL")"
    if [ -n "$STRINGCOST_PROXY_URL" ]; then
      echo "setup.sh: using uploaded StringCost presign from $STRINGCOST_UPLOAD_FILE"
      mkdir -p "$(dirname "$STRINGCOST_PRESIGN_FILE")"
      node -e "
const fs = require('fs');
fs.writeFileSync(process.argv[1], JSON.stringify({
  url: process.argv[2],
  uploaded_at: new Date().toISOString()
}, null, 2), { mode: 0o600 });
" "$STRINGCOST_PRESIGN_FILE" "$STRINGCOST_PROXY_URL"
      chmod 600 "$STRINGCOST_PRESIGN_FILE" 2>/dev/null || true
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
  STRINGCOST_PROXY_URL="$(normalize_stringcost_proxy_url_or_warn "$STRINGCOST_PRESIGN_FILE" "$STRINGCOST_STORED_URL")"
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
delete s.env.ANTHROPIC_API_KEY;
delete s.env.ANTHROPIC_AUTH_TOKEN;
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup.sh: StringCost proxy written to ~/.claude/settings.json');
"
fi

# Uploaded inputs can contain credentials. After they have been loaded into the
# entrypoint environment or copied to the managed presign file, remove them.
[ -z "${DB_URL_FILE:-}" ] || rm -f "$DB_URL_FILE" 2>/dev/null || true
[ -z "${STRINGCOST_UPLOAD_FILE:-}" ] || rm -f "$STRINGCOST_UPLOAD_FILE" 2>/dev/null || true

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
      autoDirs: ['/', '/.claude', '/.claude/projects', '/.openeral'],
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

shell_quote_value() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

write_export() {
  local name="$1"
  local value="$2"
  printf 'export %s=' "$name"
  shell_quote_value "$value"
  printf '\n'
}

write_session_env() {
  local session_env=/tmp/openeral-session.env
  {
    write_export HOME "/home/agent"
    if [ "$OPENERAL_SERVICE_MODE" -eq 1 ]; then
      write_export SHELL "/bin/bash"
    else
      write_export SHELL "/usr/local/bin/openeral-bash"
    fi
    write_export OPENERAL_HOME "/home/agent"
    write_export OPENERAL_DIR "$OPENERAL_DIR"
    write_export OPENERAL_DATA_DIR "$OPENERAL_DATA_DIR"
    write_export WORKSPACE_ID "$WORKSPACE_ID"
    write_export NODE_NO_WARNINGS "$NODE_NO_WARNINGS"
    [ -z "${NPM_CONFIG_USERCONFIG:-}" ] || write_export NPM_CONFIG_USERCONFIG "$NPM_CONFIG_USERCONFIG"
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      write_export ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"
    else
      # OpenShell exposes provider secrets to sandbox processes as placeholders.
      # In service mode, later SSH/exec sessions are separate processes, so
      # persist the standard placeholder for Claude's wrapper to inherit.
      write_export ANTHROPIC_API_KEY "openshell:resolve:env:ANTHROPIC_API_KEY"
    fi
    [ -z "${ANTHROPIC_BASE_URL:-}" ] || write_export ANTHROPIC_BASE_URL "$ANTHROPIC_BASE_URL"
    [ -z "${STRINGCOST_PROXY_URL:-}" ] || write_export ANTHROPIC_BASE_URL "$STRINGCOST_PROXY_URL"
  } > "$session_env"
  chmod 600 "$session_env" 2>/dev/null || true
}

write_shell_hint() {
  local snippet='
# OpenEral session environment.
[ -f /tmp/openeral-session.env ] && . /tmp/openeral-session.env
case "$-" in
  *i*)
    if [ -z "${OPENERAL_HINT_SHOWN:-}" ]; then
      export OPENERAL_HINT_SHOWN=1
      echo "OpenEral ready. Run '\''claude'\'' to start Claude Code; use /exit or Ctrl-D to return here; run '\''claude -c'\'' to continue."
    fi
    ;;
esac
'
  for profile in /sandbox/.bashrc /home/agent/.bashrc; do
    touch "$profile" 2>/dev/null || continue
    if ! grep -q 'OpenEral session environment' "$profile" 2>/dev/null; then
      printf '%s\n' "$snippet" >> "$profile" 2>/dev/null || true
    fi
  done
}

write_session_env
write_shell_hint

echo "setup.sh: starting openeral-bash daemon..."
if [ "$OPENERAL_SERVICE_MODE" -eq 1 ]; then
  export OPENERAL_ENABLE_SYNC=1
  export OPENERAL_HOME=/home/agent
else
  unset OPENERAL_ENABLE_SYNC
fi
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
  if [ "$OPENERAL_SERVICE_MODE" -eq 1 ]; then
    echo "setup.sh: ERROR: daemon not ready after 30s; service mode cannot start" >&2
    kill "$DAEMON_PID" 2>/dev/null || true
    rm -f /tmp/openeral-bash.sock
    exit 1
  fi
  echo "setup.sh: warning: daemon not ready after 30s — using standalone mode" >&2
  unset DAEMON_PID
  trap "rm -f /tmp/openeral-bash.sock" EXIT
fi

if [ "$OPENERAL_SERVICE_MODE" -eq 1 ] && [ -n "${STRINGCOST_PROXY_URL:-}" ]; then
  # Hydration may have restored an older settings file from PostgreSQL. Reapply
  # the current proxy config after hydration, then flush the scoped sync.
  mkdir -p /home/agent/.openeral
  node -e "
const fs = require('fs');
const presign = '/home/agent/.openeral/presign.json';
fs.writeFileSync(presign, JSON.stringify({ url: process.env.STRINGCOST_PROXY_URL, updated_at: new Date().toISOString() }, null, 2), { mode: 0o600 });
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
delete s.env.ANTHROPIC_API_KEY;
delete s.env.ANTHROPIC_AUTH_TOKEN;
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
"
  node "$OPENERAL_DIR/openeral-bash.mjs" --flush >/dev/null 2>&1 || true
fi

# Install Claude Code if not already present in the image. Production images
# preinstall /usr/local/bin/claude-real and expose /usr/local/bin/claude as the
# OpenEral wrapper; this fallback keeps local/dev images usable.
if ! command -v claude-real >/dev/null 2>&1; then
  echo "setup.sh: Claude CLI not found, installing..."
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -10
  CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
  if [ -z "$CLAUDE_BIN" ]; then
    echo "setup.sh: ERROR: Claude CLI install failed" >&2
    exit 1
  fi
  if [ "$CLAUDE_BIN" = "/usr/local/bin/claude" ]; then
    mv /usr/local/bin/claude /usr/local/bin/claude-real
  else
    ln -sf "$CLAUDE_BIN" /usr/local/bin/claude-real
  fi
  echo "setup.sh: Claude CLI installed"
fi

if [ "$OPENERAL_SERVICE_MODE" -eq 1 ]; then
  echo ""
  echo "OpenEral service is ready for workspace: $WORKSPACE_ID"
  echo "Connect with: openshell sandbox connect ${OPENSHELL_SANDBOX_ID:-<name>}"
  echo "Inside the sandbox: run 'claude' to start, '/exit' or Ctrl-D to stop, and 'claude -c' to continue."
  echo ""
  wait "$DAEMON_PID"
  exit $?
fi

# Launch Claude Code with persistent home.
#
# Claude Code reads ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN from process.env
# at startup for auth-mode selection; ~/.claude/settings.json is only
# consulted afterward. Delivering the proxy config via settings.json alone
# lands Claude in "API Usage Billing" mode against any stale URL on disk —
# which, if that URL still has the presign's /v1/messages suffix, produces a
# doubled /v1/messages/v1/messages path against StringCost. Export the vars
# here so the proxy is picked up at the auth-selection step.
# STRINGCOST_PROXY_URL was normalized by normalize_stringcost_proxy_url above.
#
# The proxy path preserves ANTHROPIC_API_KEY from the claude provider for
# Claude Code's local auth-mode selection and request signing. Do not write that
# key to settings.json; settings only stores the proxy base URL. STRINGCOST_API_KEY
# is only needed for presign creation, so remove it before handing control to
# Claude Code.
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
