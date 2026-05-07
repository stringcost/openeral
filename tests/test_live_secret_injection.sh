#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0
INCONCLUSIVE=0
ERRORS=""

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [ -f ./.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

for cmd in docker openshell python3 psql curl; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Missing ANTHROPIC_API_KEY in environment or .env" >&2
  exit 1
fi

mkdir -p "$repo_root/.omx/logs"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
tag="${stamp,,}"
gateway_name="${OPENSHELL_GATEWAY_NAME:-openeral-live-${tag}}"
gateway_container="${OPENERAL_GATEWAY_CONTAINER:-${gateway_name}-gateway}"
gateway_state="${OPENERAL_GATEWAY_STATE:-$(mktemp -d)}"
claude_sandbox="claude-${tag}"
secret_sandbox="secret-pass-${tag}"
deny_sandbox="secret-deny-${tag}"
bad_auth_sandbox="secret-badauth-${tag}"
db_provider="openeral-db-${tag}"
claude_provider="openeral-claude-${tag}"
db_container="openeral-secret-${tag}"

gateway_image="${OPENERAL_GATEWAY_IMAGE:-ghcr.io/sandys/openeral/gateway:latest}"
supervisor_image="${OPENERAL_SUPERVISOR_IMAGE:-ghcr.io/sandys/openeral/supervisor:latest}"
sandbox_image="${OPENERAL_SANDBOX_IMAGE:-ghcr.io/sandys/openeral/sandbox:latest}"

result_file="$repo_root/.omx/logs/live-secret-${stamp}.env"
summary_file="$repo_root/.omx/logs/live-secret-${stamp}.summary.txt"
claude_output_file="$repo_root/.omx/logs/live-secret-${stamp}.claude.out"
secret_output_file="$repo_root/.omx/logs/live-secret-${stamp}.secret.out"
deny_output_file="$repo_root/.omx/logs/live-secret-${stamp}.deny.out"
bad_auth_output_file="$repo_root/.omx/logs/live-secret-${stamp}.badauth.out"
claude_logs_file="$repo_root/.omx/logs/live-secret-${stamp}.claude.logs.txt"
secret_logs_file="$repo_root/.omx/logs/live-secret-${stamp}.secret.logs.txt"
deny_logs_file="$repo_root/.omx/logs/live-secret-${stamp}.deny.logs.txt"
bad_auth_logs_file="$repo_root/.omx/logs/live-secret-${stamp}.badauth.logs.txt"

pick_port() {
python3 - "$@" <<'PY'
import socket
import sys
start = int(sys.argv[1])
end = int(sys.argv[2])
for port in range(start, end + 1):
    s = socket.socket()
    try:
        s.bind(("127.0.0.1", port))
    except OSError:
        continue
    else:
        print(port)
        s.close()
        break
PY
}

db_port="$(pick_port 15432 15532)"
gateway_port="${OPENSHELL_GATEWAY_PORT:-$(pick_port 18080 18180)}"

log() { printf '\n[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }

pass() {
  local msg="$1"
  PASS=$((PASS + 1))
  echo "PASS: $msg"
  printf 'PASS=%s\n' "$msg" >>"$result_file"
}

inconclusive() {
  local msg="$1"
  INCONCLUSIVE=$((INCONCLUSIVE + 1))
  echo "INCONCLUSIVE: $msg"
  printf 'INCONCLUSIVE=%s\n' "$msg" >>"$result_file"
}

fail() {
  local msg="$1"
  FAIL=$((FAIL + 1))
  ERRORS="${ERRORS}\n  FAIL: ${msg}"
  echo "FAIL: $msg" >&2
}

cleanup() {
  set +e
  openshell sandbox delete --gateway "$gateway_name" "$claude_sandbox" >/dev/null 2>&1 || true
  openshell sandbox delete --gateway "$gateway_name" "$secret_sandbox" >/dev/null 2>&1 || true
  openshell sandbox delete --gateway "$gateway_name" "$deny_sandbox" >/dev/null 2>&1 || true
  openshell sandbox delete --gateway "$gateway_name" "$bad_auth_sandbox" >/dev/null 2>&1 || true
  openshell gateway destroy --name "$gateway_name" >/dev/null 2>&1 || true
  docker rm -f "$gateway_container" "$db_container" >/dev/null 2>&1 || true
  if [ -d "$gateway_state" ] && [[ "$gateway_state" == /tmp/* ]]; then
    rm -rf "$gateway_state" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

collect_logs() {
  local sandbox_name="$1"
  local output_file="$2"

  for _ in $(seq 1 20); do
    : >"$output_file"
    openshell logs --gateway "$gateway_name" "$sandbox_name" --source sandbox --since 10m -n 1000 >"$output_file" 2>/dev/null || true
    openshell logs --gateway "$gateway_name" "$sandbox_name" --source gateway --since 10m -n 1000 >>"$output_file" 2>/dev/null || true
    if grep -q 'L7_REQUEST\|CONNECT' "$output_file"; then
      return 0
    fi
    sleep 1
  done
  return 1
}

cat >"$result_file" <<ENVVARS
STAMP=$stamp
GATEWAY_NAME=$gateway_name
GATEWAY_CONTAINER=$gateway_container
GATEWAY_PORT=$gateway_port
GATEWAY_STATE=$gateway_state
DB_CONTAINER=$db_container
DB_PORT=$db_port
DB_PROVIDER=$db_provider
CLAUDE_PROVIDER=$claude_provider
CLAUDE_SANDBOX=$claude_sandbox
SECRET_SANDBOX=$secret_sandbox
DENY_SANDBOX=$deny_sandbox
BADAUTH_SANDBOX=$bad_auth_sandbox
OPENERAL_GATEWAY_IMAGE=$gateway_image
OPENERAL_SUPERVISOR_IMAGE=$supervisor_image
OPENERAL_SANDBOX_IMAGE=$sandbox_image
SUMMARY_FILE=$summary_file
ENVVARS

cleanup

log "Starting fresh PostgreSQL on port $db_port"
docker run -d \
  --name "$db_container" \
  -e POSTGRES_USER=pgmount \
  -e POSTGRES_PASSWORD=pgmount \
  -e POSTGRES_DB=testdb \
  -p "${db_port}:5432" \
  postgres:16 >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$db_container" pg_isready -U pgmount -d testdb >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

for _ in $(seq 1 60); do
  if PGPASSWORD=pgmount psql -h localhost -p "$db_port" -U pgmount -d testdb -Atqc 'SELECT 1' >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

PGPASSWORD=pgmount psql -h localhost -p "$db_port" -U pgmount -d testdb -Atqc 'SELECT 1' >/dev/null
PGPASSWORD=pgmount psql -h localhost -p "$db_port" -U pgmount -d testdb -q <<'SQL'
DROP TABLE IF EXISTS public.users CASCADE;
CREATE TABLE public.users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT
);
INSERT INTO public.users (id, name, email) VALUES (1, 'Ada Lovelace', 'ada@example.com');
SQL

log "Starting Docker-driver gateway $gateway_name on port $gateway_port"
mkdir -p "$gateway_state/home"
docker_socket_gid="$(stat -c '%g' /var/run/docker.sock)"

docker run -d \
  --name "$gateway_container" \
  --network host \
  --user "$(id -u):$(id -g)" \
  --group-add "$docker_socket_gid" \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$gateway_state:$gateway_state" \
  -e HOME="$gateway_state/home" \
  -e XDG_DATA_HOME="$gateway_state" \
  -e OPENSHELL_BIND_ADDRESS=0.0.0.0 \
  -e OPENSHELL_SERVER_PORT="$gateway_port" \
  -e OPENSHELL_DB_URL="sqlite:${gateway_state}/openshell.db" \
  -e OPENSHELL_DRIVERS=docker \
  -e OPENSHELL_DISABLE_TLS=true \
  -e OPENSHELL_GRPC_ENDPOINT="http://127.0.0.1:${gateway_port}" \
  -e OPENSHELL_DOCKER_SUPERVISOR_IMAGE="$supervisor_image" \
  -e OPENSHELL_DOCKER_FUSE_DEVICE=/dev/fuse \
  -e OPENSHELL_SANDBOX_IMAGE="$sandbox_image" \
  "$gateway_image" \
  --bind-address 0.0.0.0 \
  --port "$gateway_port" >/dev/null

for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${gateway_port}/readyz" >/dev/null 2>&1; then
    gateway_ready=1
    break
  fi
  if ! docker ps --format '{{.Names}}' | grep -qx "$gateway_container"; then
    echo "Gateway container exited before ready" >&2
    docker logs "$gateway_container" >&2 || true
    exit 1
  fi
  sleep 1
done

if [ "${gateway_ready:-0}" != "1" ]; then
  echo "Gateway did not become ready in time" >&2
  docker logs "$gateway_container" >&2 || true
  exit 1
fi

openshell gateway add --local --name "$gateway_name" "http://127.0.0.1:${gateway_port}"
openshell gateway select "$gateway_name"

sandbox_db_url="postgresql://pgmount:pgmount@host.docker.internal:${db_port}/testdb"

log "Creating providers"
DATABASE_URL="$sandbox_db_url" openshell provider create \
  --gateway "$gateway_name" \
  --name "$db_provider" \
  --type generic \
  --credential DATABASE_URL

ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" openshell provider create \
  --gateway "$gateway_name" \
  --name "$claude_provider" \
  --type generic \
  --credential ANTHROPIC_API_KEY

log "Running Claude positive control"
claude_status=0
if openshell sandbox create \
  --gateway "$gateway_name" \
  --name "$claude_sandbox" \
  --from "$sandbox_image" \
  --provider "$db_provider" \
  --provider "$claude_provider" \
  --auto-providers \
  --no-tty -- \
  sh -lc 'set -e
    echo "RUN_ID='"$stamp"'"
    id
    echo "ANTHROPIC_ENV=$ANTHROPIC_API_KEY"
    test "$ANTHROPIC_API_KEY" = "openshell:resolve:env:ANTHROPIC_API_KEY"
    test -e /dev/fuse
    grep -E " /db | /home/agent " /proc/mounts
    test -w /home/agent
    cat /db/public/users/.filter/id/1/1/row.json
    HOME=/home/agent claude -p "Reply with READY and nothing else."
  ' >"$claude_output_file" 2>&1; then
  claude_status=0
else
  claude_status=$?
fi
printf 'CLAUDE_STATUS=%s\n' "$claude_status" >>"$result_file"
if [ "$claude_status" -ne 0 ]; then
  cat "$claude_output_file" >&2
  exit "$claude_status"
fi
grep -q 'ANTHROPIC_ENV=openshell:resolve:env:ANTHROPIC_API_KEY' "$claude_output_file"
grep -q 'Ada Lovelace' "$claude_output_file"
grep -q '^READY$' "$claude_output_file"
pass "Claude ran with placeholder key, /db, and persistent /home/agent"

if collect_logs "$claude_sandbox" "$claude_logs_file"; then
  grep -q 'L7_REQUEST' "$claude_logs_file" || inconclusive "Claude logs lacked L7_REQUEST"
  grep -q 'secret_injection_action=applied' "$claude_logs_file" || inconclusive "Claude logs lacked applied secret injection"
else
  inconclusive "Claude sandbox logs did not surface L7 evidence"
fi

log "Checking Claude persistence rows"
claude_row_count="$(PGPASSWORD=pgmount psql -h localhost -p "$db_port" -U pgmount -d testdb -Atqc "SELECT count(*) FROM _openeral.workspace_files WHERE path LIKE '/.claude%'")"
printf 'CLAUDE_ROW_COUNT=%s\n' "$claude_row_count" >>"$result_file"
if [ "${claude_row_count:-0}" -le 0 ]; then
  fail "Expected persisted /.claude* rows after Claude run"
else
  pass "Claude .claude state persisted to PostgreSQL"
fi

log "Running curl positive control"
openshell sandbox create \
  --gateway "$gateway_name" \
  --name "$secret_sandbox" \
  --from "$sandbox_image" \
  --provider "$db_provider" \
  --provider "$claude_provider" \
  --auto-providers \
  --no-tty -- \
  sh -lc 'set -e
    echo "RUN_ID='"$stamp"'"
    test -e /dev/fuse
    grep -E " /db | /home/agent " /proc/mounts
    test "$ANTHROPIC_API_KEY" = "openshell:resolve:env:ANTHROPIC_API_KEY"
    printf persist-ok > /home/agent/manual.txt
    code=$(curl -sS -o /tmp/models.json -w "%{http_code}" \
      https://api.anthropic.com/v1/models \
      -H "x-api-key: $ANTHROPIC_API_KEY" \
      -H "anthropic-version: 2023-06-01")
    printf "HTTP_CODE=%s\n" "$code"
    head -c 300 /tmp/models.json; echo
    cat /home/agent/manual.txt
  ' >"$secret_output_file" 2>&1
grep -q 'HTTP_CODE=200' "$secret_output_file"
grep -q 'claude-' "$secret_output_file"
grep -q 'persist-ok' "$secret_output_file"
pass "Authorized x-api-key placeholder was injected at egress"

if collect_logs "$secret_sandbox" "$secret_logs_file"; then
  grep -q 'L7_REQUEST' "$secret_logs_file" || inconclusive "Curl logs lacked L7_REQUEST"
  grep -q 'secret_injection_action=applied' "$secret_logs_file" || inconclusive "Curl logs lacked applied secret injection"
else
  inconclusive "Curl sandbox logs did not surface L7 evidence"
fi

manual_count="$(PGPASSWORD=pgmount psql -h localhost -p "$db_port" -U pgmount -d testdb -Atqc "SELECT count(*) FROM _openeral.workspace_files WHERE path = '/manual.txt' AND content = convert_to('persist-ok', 'UTF8')")"
printf 'MANUAL_COUNT=%s\n' "$manual_count" >>"$result_file"
if [ "$manual_count" != "1" ]; then
  fail "Expected one persisted /manual.txt row, got ${manual_count}"
else
  pass "Workspace write persisted to PostgreSQL"
fi

log "Running boundary-denial negative control"
openshell sandbox create \
  --gateway "$gateway_name" \
  --name "$deny_sandbox" \
  --from "$sandbox_image" \
  --provider "$db_provider" \
  --provider "$claude_provider" \
  --auto-providers \
  --no-tty -- \
  sh -lc 'set -e
    code=$(curl -sS -o /tmp/deny.txt -w "%{http_code}" \
      https://api.anthropic.com/v1/models \
      -H "Authorization: Bearer $ANTHROPIC_API_KEY" \
      -H "anthropic-version: 2023-06-01")
    printf "HTTP_CODE=%s\n" "$code"
    head -c 300 /tmp/deny.txt; echo
  ' >"$deny_output_file" 2>&1
grep -q 'HTTP_CODE=403' "$deny_output_file"
pass "Unauthorized placeholder header was denied by boundary policy"

if collect_logs "$deny_sandbox" "$deny_logs_file"; then
  grep -q 'secret_injection_action=denied' "$deny_logs_file" || inconclusive "Deny logs lacked denied secret injection"
else
  inconclusive "Deny sandbox logs did not surface L7 evidence"
fi

log "Running upstream-auth negative control"
openshell sandbox create \
  --gateway "$gateway_name" \
  --name "$bad_auth_sandbox" \
  --from "$sandbox_image" \
  --provider "$db_provider" \
  --provider "$claude_provider" \
  --auto-providers \
  --no-tty -- \
  sh -lc 'set -e
    code=$(curl -sS -o /tmp/badauth.txt -w "%{http_code}" \
      https://api.anthropic.com/v1/models \
      -H "x-api-key: not-a-real-key" \
      -H "anthropic-version: 2023-06-01")
    printf "HTTP_CODE=%s\n" "$code"
    head -c 300 /tmp/badauth.txt; echo
  ' >"$bad_auth_output_file" 2>&1
grep -Eq 'HTTP_CODE=40[13]' "$bad_auth_output_file"
pass "Non-placeholder bad key reached upstream and failed auth"

if collect_logs "$bad_auth_sandbox" "$bad_auth_logs_file"; then
  grep -q 'secret_injection_action=none' "$bad_auth_logs_file" || inconclusive "Bad-auth logs lacked none secret injection"
else
  inconclusive "Bad-auth sandbox logs did not surface L7 evidence"
fi

if grep -R -F "$ANTHROPIC_API_KEY" "$repo_root/.omx/logs/live-secret-${stamp}"* >/dev/null 2>&1; then
  fail "Raw Anthropic API key leaked into test artifacts"
else
  pass "Artifacts do not contain the raw Anthropic key"
fi

{
  echo "stamp=$stamp"
  echo "gateway=$gateway_name"
  echo "db_provider=$db_provider"
  echo "claude_provider=$claude_provider"
  echo "claude_status=$claude_status"
  echo "claude_row_count=$claude_row_count"
  echo "manual_count=$manual_count"
  echo "claude_output_file=$claude_output_file"
  echo "secret_output_file=$secret_output_file"
  echo "deny_output_file=$deny_output_file"
  echo "bad_auth_output_file=$bad_auth_output_file"
  echo "claude_logs_file=$claude_logs_file"
  echo "secret_logs_file=$secret_logs_file"
  echo "deny_logs_file=$deny_logs_file"
  echo "bad_auth_logs_file=$bad_auth_logs_file"
  echo "PASS_COUNT=$PASS"
  echo "FAIL_COUNT=$FAIL"
  echo "INCONCLUSIVE_COUNT=$INCONCLUSIVE"
} >"$summary_file"

cat "$summary_file"

if [ "$FAIL" -gt 0 ]; then
  echo -e "$ERRORS"
  exit 1
fi
if [ "$INCONCLUSIVE" -gt 0 ]; then
  echo -e "$ERRORS"
  exit 2
fi
