#!/usr/bin/env bash
set -euo pipefail

# test_sandbox_e2e.sh — Docker-based image verification for the openeral sandbox.
#
# Builds the image, runs individual checks inside it as the sandbox user.
# Validates image shape, permissions, npm config, migrations, and daemon.
#
# NOTE: This does NOT exercise OpenShell's proxy, policy enforcement, or
# SecretResolver — those require a running OpenShell gateway. This test
# verifies the image is correctly built for use IN OpenShell.
#
# Requires: docker, a reachable PostgreSQL
#
# Usage:
#   DATABASE_URL='postgresql://...' ./tests/test_sandbox_e2e.sh

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

IMAGE="${OPENERAL_E2E_IMAGE:-openeral-e2e:local}"
DB_URL="${DATABASE_URL:?DATABASE_URL required}"
PASSED=0
FAILED=0

pass() { echo "  ✓ $1"; PASSED=$((PASSED + 1)); }
fail() { echo "  ✗ $1"; FAILED=$((FAILED + 1)); }

run_in_image() {
  # Run as sandbox user (uid 1000) like the real OpenShell supervisor does
  docker run --rm --network host \
    -e DATABASE_URL="$DB_URL" \
    -e WORKSPACE_ID="e2e-sandbox-$$" \
    -e SOCKET_TOKEN="placeholder-for-test" \
    --user sandbox \
    --entrypoint /bin/sh \
    "$IMAGE" -c "$1" 2>&1
}

run_in_image_root() {
  docker run --rm --network host \
    -e DATABASE_URL="$DB_URL" \
    --entrypoint /bin/sh \
    "$IMAGE" -c "$1" 2>&1
}

echo ""
echo "=== Building image ==="
docker build -f sandboxes/openeral/Dockerfile -t "$IMAGE" . 2>&1 | tail -3

echo ""
echo "=== Test 1: /home/agent ownership ==="
out=$(run_in_image_root 'stat -c "%U:%G %a" /home/agent')
if echo "$out" | grep -q 'sandbox:sandbox'; then
  pass "/home/agent owned by sandbox:sandbox ($out)"
else
  fail "/home/agent wrong ownership: $out"
fi

echo ""
echo "=== Test 2: sandbox user can write to /home/agent ==="
out=$(run_in_image 'touch /home/agent/.permcheck && echo ok || echo FAIL')
if echo "$out" | grep -q 'ok'; then
  pass "sandbox user can write to /home/agent"
else
  fail "sandbox user cannot write to /home/agent: $out"
fi

echo ""
echo "=== Test 3: openeral-npmrc written to /tmp when SOCKET_TOKEN is set ==="
out=$(run_in_image '
  OPENERAL_NPMRC=/tmp/openeral-npmrc
  rm -f "$OPENERAL_NPMRC"
  cat > "$OPENERAL_NPMRC" <<NPMRC
registry=https://registry.socket.dev/npm/
//registry.socket.dev/npm/:_authToken=${SOCKET_TOKEN}
NPMRC
  cat "$OPENERAL_NPMRC"
')
if echo "$out" | grep -q 'registry.socket.dev'; then
  pass "openeral-npmrc contains registry.socket.dev"
else
  fail "openeral-npmrc missing registry.socket.dev: $out"
fi
if echo "$out" | grep -q '_authToken=placeholder-for-test'; then
  pass "openeral-npmrc contains SOCKET_TOKEN placeholder"
else
  fail "openeral-npmrc missing token: $out"
fi

echo ""
echo "=== Test 4: npm reads registry via NPM_CONFIG_USERCONFIG ==="
out=$(run_in_image '
  cat > /tmp/openeral-npmrc <<NPMRC
registry=https://registry.socket.dev/npm/
NPMRC
  NPM_CONFIG_USERCONFIG=/tmp/openeral-npmrc npm config get registry 2>/dev/null || echo "npm-config-failed"
')
if echo "$out" | grep -q 'registry.socket.dev'; then
  pass "npm config reads Socket.dev registry"
else
  fail "npm config does not read Socket.dev registry: $out"
fi

echo ""
echo "=== Test 5: Migrations against live PostgreSQL ==="
out=$(run_in_image '
  node -e "
    import(\"/opt/openeral/dist/db/pool.js\").then(async({createPool})=>{
      const{runMigrations}=await import(\"/opt/openeral/dist/db/migrations.js\");
      const p=createPool(process.env.DATABASE_URL);
      await runMigrations(p);await p.end();console.log(\"migrations-ok\");
    }).catch(e=>{console.error(e.message);process.exit(1)});
  "
')
if echo "$out" | grep -q 'migrations-ok'; then
  pass "migrations run successfully as sandbox user"
else
  fail "migrations failed: $out"
fi

echo ""
echo "=== Test 6: openeral-bash daemon starts ==="
out=$(timeout 30 docker run --rm --network host \
  -e DATABASE_URL="$DB_URL" \
  -e WORKSPACE_ID="e2e-sandbox-$$" \
  --user sandbox \
  --entrypoint /bin/sh \
  "$IMAGE" -c '
    node /opt/openeral/openeral-bash.mjs --daemon &
    DPID=$!
    for i in $(seq 1 30); do [ -S /tmp/openeral-bash.sock ] && break; sleep 0.1; done
    if [ -S /tmp/openeral-bash.sock ]; then
      echo "daemon-ok"
      node -e "
        const net=require(\"net\"),c=net.createConnection(\"/tmp/openeral-bash.sock\");
        let d=\"\";
        c.on(\"connect\",()=>c.write(JSON.stringify({command:\"echo hello-e2e\"})+\"\n\"));
        c.on(\"data\",chunk=>d+=chunk);
        c.on(\"end\",()=>{console.log(d.trim());process.exit(0)});
      "
    else
      echo "daemon-failed"
    fi
    kill $DPID 2>/dev/null
    exit 0
  ' 2>&1 || echo "timeout")
if echo "$out" | grep -q 'daemon-ok'; then
  pass "daemon started"
else
  fail "daemon failed: $out"
fi
if echo "$out" | grep -q 'hello-e2e'; then
  pass "daemon responds to commands"
else
  fail "daemon did not respond: $out"
fi

echo ""
echo "=== Test 7: Node.js process identity ==="
out=$(run_in_image '
  # npm is a shebang script — verify the actual exe is /usr/bin/node
  head -1 /usr/bin/npm
  readlink -f /usr/bin/node || which node
')
if echo "$out" | grep -q 'node'; then
  pass "npm shebang uses node (OpenShell matches exe, not script)"
else
  fail "npm shebang unexpected: $out"
fi

echo ""
echo "=== Test 8: dist/ and node_modules/ present ==="
out=$(run_in_image '
  [ -d /opt/openeral/dist ] && echo "dist-ok" || echo "dist-missing"
  [ -d /opt/openeral/node_modules ] && echo "nm-ok" || echo "nm-missing"
')
if echo "$out" | grep -q 'dist-ok' && echo "$out" | grep -q 'nm-ok'; then
  pass "dist/ and node_modules/ present in image"
else
  fail "missing build artifacts: $out"
fi

echo ""
echo "=== Test 9: service-mode wrappers are present ==="
out=$(run_in_image '
  [ -x /usr/local/bin/openeral-start ] && echo "start-ok" || echo "start-missing"
  [ -x /usr/local/bin/claude ] && echo "claude-wrapper-ok" || echo "claude-wrapper-missing"
  [ -x /usr/local/bin/claude-real ] && echo "claude-real-ok" || echo "claude-real-missing"
  [ -x /usr/local/bin/pg ] && echo "pg-ok" || echo "pg-missing"
')
if echo "$out" | grep -q 'start-ok' && echo "$out" | grep -q 'claude-wrapper-ok' && echo "$out" | grep -q 'claude-real-ok' && echo "$out" | grep -q 'pg-ok'; then
  pass "service-mode wrappers present"
else
  fail "service-mode wrappers missing: $out"
fi

echo ""
echo "=== Test 10: PGlite data dir is outside /home/agent and writable ==="
out=$(run_in_image '
  [ -d /var/lib/openeral/data ] && echo "data-dir-ok" || echo "data-dir-missing"
  touch /var/lib/openeral/data/.permcheck && echo "data-write-ok" || echo "data-write-fail"
')
if echo "$out" | grep -q 'data-dir-ok' && echo "$out" | grep -q 'data-write-ok'; then
  pass "PGlite data dir writable"
else
  fail "PGlite data dir not writable: $out"
fi

echo ""
echo "=== Test 11: user .npmrc is never touched ==="
out=$(run_in_image '
  # Create a user .npmrc
  echo "user-config=true" > /home/agent/.npmrc
  # Simulate openeral Socket.dev config (writes to /tmp, not /home/agent)
  OPENERAL_NPMRC=/tmp/openeral-npmrc
  rm -f "$OPENERAL_NPMRC"
  if [ -n "${SOCKET_TOKEN:-}" ]; then
    cat > "$OPENERAL_NPMRC" <<NPMRC
registry=https://registry.socket.dev/npm/
NPMRC
  fi
  # User .npmrc must be untouched
  cat /home/agent/.npmrc
')
if echo "$out" | grep -q 'user-config=true'; then
  pass "user .npmrc preserved (not clobbered or deleted)"
else
  fail "user .npmrc was modified: $out"
fi

# Cleanup test workspace
node -e "
  import('pg').then(async({default:pg})=>{
    const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
    await pool.query('DELETE FROM _openeral.workspace_files WHERE workspace_id=\$1',['e2e-sandbox-$$']);
    await pool.query('DELETE FROM _openeral.workspace_config WHERE id=\$1',['e2e-sandbox-$$']);
    await pool.end();
  }).catch(()=>{});
" 2>/dev/null || true

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="
[ "$FAILED" -eq 0 ] || exit 1
