#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"

if [ -f ./.env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

for cmd in docker psql python3; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Missing required command: $cmd" >&2
    exit 1
  }
done

resolve_openshell_bin() {
  if [ -n "${OPENSHELL_BIN:-}" ]; then
    printf '%s\n' "$OPENSHELL_BIN"
    return 0
  fi

  if [ -x "$repo_root/.tmp/openshell-target/release/openshell" ]; then
    printf '%s\n' "$repo_root/.tmp/openshell-target/release/openshell"
    return 0
  fi

  if [ -x "$repo_root/vendor/openshell/target/release/openshell" ]; then
    printf '%s\n' "$repo_root/vendor/openshell/target/release/openshell"
    return 0
  fi

  command -v openshell
}

OPENSHELL_BIN="$(resolve_openshell_bin)"
DOCKER_GID="$(stat -c '%g' /var/run/docker.sock)"
RUNNER_IMAGE="${OPENSHELL_RUNNER_IMAGE:-openeral/openshell-cli-runner:dev}"
runner_state_dir="$repo_root/.tmp/openshell-cli"
mkdir -p "$runner_state_dir"

: "${OPENERAL_DATABASE_URL:?Missing OPENERAL_DATABASE_URL in environment or .env}"
: "${ANTHROPIC_API_KEY:?Missing ANTHROPIC_API_KEY in environment or .env}"

gateway_name="${OPENSHELL_GATEWAY_NAME:-openeral-supabase-$(date -u +%Y%m%d%H%M%S)}"
gateway_host="${OPENSHELL_GATEWAY_HOST:-host.docker.internal}"
cluster_container="openshell-cluster-${gateway_name}"
sandbox_name="${OPENERAL_SUPABASE_SANDBOX_NAME:-openeral-supabase}"
db_provider="${OPENERAL_SUPABASE_DB_PROVIDER:-openeral-db-${gateway_name}}"
claude_provider="${OPENERAL_SUPABASE_CLAUDE_PROVIDER:-openeral-claude-${gateway_name}}"
sandbox_image="${OPENERAL_SUPABASE_SANDBOX_IMAGE:-ghcr.io/nvidia/openshell-community/sandboxes/base:latest}"
policy_path="${OPENERAL_SUPABASE_POLICY_PATH:-$repo_root/sandboxes/openeral/policy.yaml}"
policy_path_runner="$policy_path"
case "$policy_path_runner" in
  "$repo_root"/*)
    policy_path_runner="/workspace${policy_path_runner#$repo_root}"
    ;;
esac
local_registry_container="${OPENERAL_LOCAL_REGISTRY_CONTAINER:-openeral-registry}"

cluster_image="${OPENSHELL_CLUSTER_IMAGE:-127.0.0.1:5000/openeral/cluster:dev}"
registry_host="${OPENSHELL_REGISTRY_HOST:-127.0.0.1:5000}"
registry_endpoint="${OPENSHELL_REGISTRY_ENDPOINT:-172.17.0.1:5000}"
registry_insecure="${OPENSHELL_REGISTRY_INSECURE:-true}"
image_repo_base="${IMAGE_REPO_BASE:-127.0.0.1:5000/openeral}"
image_tag="${IMAGE_TAG:-dev}"
push_images="${OPENSHELL_PUSH_IMAGES:-}"
gateway_registry_image="${OPENERAL_GATEWAY_REGISTRY_IMAGE:-${image_repo_base}/gateway:${image_tag}}"
supervisor_registry_image="${OPENERAL_SUPERVISOR_REGISTRY_IMAGE:-${image_repo_base}/supervisor:${image_tag}}"
gateway_source_image="${OPENERAL_GATEWAY_SOURCE_IMAGE:-openeral/gateway:dev}"
supervisor_source_image="${OPENERAL_SUPERVISOR_SOURCE_IMAGE:-openeral/supervisor:dev}"

pick_port() {
  python3 - "$@" <<'PY'
import random
import socket
import sys

start = int(sys.argv[1])
end = int(sys.argv[2])
ports = list(range(start, end + 1))
random.shuffle(ports)
for port in ports:
    sock = socket.socket()
    try:
        sock.bind(("127.0.0.1", port))
    except OSError:
        sock.close()
        continue
    print(port)
    sock.close()
    break
PY
}

gateway_port="${OPENSHELL_GATEWAY_PORT:-$(pick_port 18080 18180)}"

check_local_image() {
  local image="$1"
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "Required local image not found: $image" >&2
    exit 1
  }
}

check_local_image "$cluster_image"
if [ -n "$push_images" ]; then
  old_ifs="$IFS"
  IFS=','
  for image in $push_images; do
    image="${image## }"
    image="${image%% }"
    [ -n "$image" ] || continue
    check_local_image "$image"
  done
  IFS="$old_ifs"
fi
case "$registry_host" in
  127.0.0.1:5000|localhost:5000)
    check_local_image "$gateway_source_image"
    check_local_image "$supervisor_source_image"
    ;;
esac

ensure_local_registry() {
  case "$registry_host" in
    127.0.0.1:5000|localhost:5000)
      if docker ps --format '{{.Names}}' | grep -qx "$local_registry_container"; then
        :
      elif docker ps -a --format '{{.Names}}' | grep -qx "$local_registry_container"; then
        docker start "$local_registry_container" >/dev/null
      else
        docker run -d --name "$local_registry_container" -p 5000:5000 registry:2 >/dev/null
      fi

      python3 - <<'PY'
import sys
import time
import urllib.request

url = "http://127.0.0.1:5000/v2/"
last_error = None
for _ in range(30):
    try:
        with urllib.request.urlopen(url, timeout=1) as response:
            if response.status in (200, 401):
                sys.exit(0)
    except Exception as exc:  # noqa: BLE001
        last_error = exc
        time.sleep(1)

raise SystemExit(f"Local registry did not become ready: {last_error}")
PY

      docker push "$cluster_image" >/dev/null
      docker tag "$gateway_source_image" "$gateway_registry_image"
      docker tag "$supervisor_source_image" "$supervisor_registry_image"
      docker push "$gateway_registry_image" >/dev/null
      docker push "$supervisor_registry_image" >/dev/null
      ;;
  esac
}

run_cli() {
  if [ -f "$OPENSHELL_BIN" ] && docker image inspect "$RUNNER_IMAGE" >/dev/null 2>&1; then
    runner_bin="$OPENSHELL_BIN"
    case "$runner_bin" in
      "$repo_root"/*)
        runner_bin="/workspace${runner_bin#$repo_root}"
        ;;
    esac
    docker run --rm \
      --user "$(id -u):$(id -g)" \
      --group-add "$DOCKER_GID" \
      --add-host host.docker.internal:host-gateway \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v "$repo_root:/workspace" \
      -v "$runner_state_dir:/state" \
      -w /workspace/vendor/openshell \
      -e HOME=/state/home \
      -e XDG_CONFIG_HOME=/state/config \
      -e OPENSHELL_CLUSTER_IMAGE="$cluster_image" \
      -e OPENSHELL_REGISTRY_HOST="$registry_host" \
      -e OPENSHELL_REGISTRY_ENDPOINT="$registry_endpoint" \
      -e OPENSHELL_REGISTRY_INSECURE="$registry_insecure" \
      -e IMAGE_REPO_BASE="$image_repo_base" \
      -e IMAGE_TAG="$image_tag" \
      -e OPENSHELL_PUSH_IMAGES="$push_images" \
      -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
      -e OPENERAL_DATABASE_URL="${OPENERAL_DATABASE_URL:-}" \
      -e DATABASE_URL="${DATABASE_URL:-}" \
      -e OPENERAL_SUPABASE_POLICY_PATH="$policy_path_runner" \
      "$RUNNER_IMAGE" \
      "$runner_bin" "$@"
  else
    OPENSHELL_CLUSTER_IMAGE="$cluster_image" \
    OPENSHELL_REGISTRY_HOST="$registry_host" \
    OPENSHELL_REGISTRY_ENDPOINT="$registry_endpoint" \
    OPENSHELL_REGISTRY_INSECURE="$registry_insecure" \
    IMAGE_REPO_BASE="$image_repo_base" \
    IMAGE_TAG="$image_tag" \
    OPENSHELL_PUSH_IMAGES="$push_images" \
    "$OPENSHELL_BIN" "$@"
  fi
}

cleanup() {
  set +e
  run_cli sandbox delete --gateway "$gateway_name" "$sandbox_name" >/dev/null 2>&1 || true
  run_cli gateway destroy --name "$gateway_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for_sandbox_ready() {
  local timeout="${1:-180s}"

  docker exec "$cluster_container" \
    kubectl -n openshell wait \
      --for=jsonpath='{.status.conditions[?(@.type=="Ready")].status}'=True \
      "sandbox.agents.x-k8s.io/${sandbox_name}" \
      --timeout="$timeout" >/dev/null

  docker exec "$cluster_container" \
    kubectl -n openshell wait \
      --for=condition=Ready \
      "pod/${sandbox_name}" \
      --timeout="$timeout" >/dev/null
}

wait_for_exec_ready() {
  local tries=60
  local i
  for i in $(seq 1 "$tries"); do
    if run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty /bin/true >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done

  echo "Sandbox exec did not become ready for ${sandbox_name}" >&2
  docker exec "$cluster_container" kubectl -n openshell describe "pod/${sandbox_name}" >&2 || true
  exit 1
}

stabilize_gateway_runtime() {
  case "$registry_host" in
    127.0.0.1:5000|localhost:5000)
      docker exec "$cluster_container" \
        kubectl -n openshell set image statefulset/openshell \
          "helm-chart=${gateway_registry_image}" >/dev/null
      docker exec "$cluster_container" \
        kubectl -n openshell set env statefulset/openshell \
          "OPENSHELL_SUPERVISOR_IMAGE=${supervisor_registry_image}" \
          "OPENSHELL_K8S_SKIP_WORKSPACE_SEED=true" >/dev/null
      docker exec "$cluster_container" \
        kubectl -n openshell rollout status statefulset/openshell --timeout=180s >/dev/null
      ;;
  esac
}

preload_sandbox_image() {
  docker exec "$cluster_container" \
    sh -lc "crictl pull '$sandbox_image' >/dev/null"
}

echo "== preflight psql =="
psql "$OPENERAL_DATABASE_URL" -Atqc 'select 1'

echo "== openshell version =="
run_cli --version

echo "== local registry =="
ensure_local_registry

echo "== gateway start =="
run_cli gateway start \
  --name "$gateway_name" \
  --port "$gateway_port" \
  --gateway-host "$gateway_host" \
  --recreate

run_cli gateway info
stabilize_gateway_runtime

echo "== preload sandbox image =="
preload_sandbox_image

echo "== provider create db =="
DATABASE_URL="$OPENERAL_DATABASE_URL" \
run_cli provider create \
  --gateway "$gateway_name" \
  --name "$db_provider" \
  --type generic \
  --credential DATABASE_URL

echo "== provider create claude =="
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
run_cli provider create \
  --gateway "$gateway_name" \
  --name "$claude_provider" \
  --type generic \
  --credential ANTHROPIC_API_KEY

create_log="$(mktemp)"

echo "== sandbox create =="
if ! DATABASE_URL="$OPENERAL_DATABASE_URL" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  run_cli sandbox create \
    --gateway "$gateway_name" \
    --name "$sandbox_name" \
    --from "$sandbox_image" \
    --provider "$db_provider" \
    --provider "$claude_provider" \
    --policy "${OPENERAL_SUPABASE_POLICY_PATH:-$policy_path}" \
    --no-auto-providers \
    --no-tty -- env HOME=/sandbox sleep infinity >"$create_log" 2>&1; then
  cat "$create_log" >&2
fi
rm -f "$create_log"

wait_for_sandbox_ready
wait_for_exec_ready

echo "== ls /sandbox =="
run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty /bin/ls -la /sandbox

echo "== verify /.db exists =="
run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty /usr/bin/test -d /sandbox/.db

echo "== write workspace file =="
run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty \
  /usr/bin/python3 -c "from pathlib import Path; Path('/sandbox/e2e.txt').write_text('persist-ok')"
run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty /bin/cat /sandbox/e2e.txt

echo "== verify /.db write denied =="
if run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty \
  /usr/bin/python3 -c "from pathlib import Path; Path('/sandbox/.db/should_fail').write_text('x')"; then
  echo "Unexpected success writing under /sandbox/.db" >&2
  exit 1
fi

echo "== postgres workspace row =="
workspace_row="$(
psql "$OPENERAL_DATABASE_URL" -Atqc \
  "SELECT workspace_id || '|' || path || '|' || convert_from(content, 'UTF8')
   FROM _openeral.workspace_files
   WHERE workspace_id LIKE '%:${sandbox_name}' AND path = '/e2e.txt'
   ORDER BY workspace_id DESC
   LIMIT 1;"
)"
printf '%s\n' "$workspace_row"
printf '%s\n' "$workspace_row" | grep -q '|/e2e.txt|persist-ok'

echo "== claude =="
claude_output="$(
  run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty \
    /usr/bin/env HOME=/sandbox claude -p 'Reply with READY and nothing else.'
)"
printf '%s\n' "$claude_output"
printf '%s\n' "$claude_output" | grep -q 'READY'

echo "== claude row count =="
claude_rows="$(
psql "$OPENERAL_DATABASE_URL" -Atqc \
  "SELECT count(*)
   FROM _openeral.workspace_files
   WHERE workspace_id LIKE '%:${sandbox_name}' AND path LIKE '/.claude%';"
)"
printf '%s\n' "$claude_rows"
[ "${claude_rows:-0}" -gt 0 ]

echo "== recreate same sandbox name =="
run_cli sandbox delete --gateway "$gateway_name" "$sandbox_name" >/dev/null || true
sleep 2

recreate_log="$(mktemp)"
if ! DATABASE_URL="$OPENERAL_DATABASE_URL" ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  run_cli sandbox create \
    --gateway "$gateway_name" \
    --name "$sandbox_name" \
    --from "$sandbox_image" \
    --provider "$db_provider" \
    --provider "$claude_provider" \
    --policy "${OPENERAL_SUPABASE_POLICY_PATH:-$policy_path}" \
    --no-auto-providers \
    --no-tty -- env HOME=/sandbox sleep infinity >"$recreate_log" 2>&1; then
  cat "$recreate_log" >&2
fi
rm -f "$recreate_log"

wait_for_sandbox_ready
wait_for_exec_ready

echo "== persisted file after recreate =="
run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty /bin/cat /sandbox/e2e.txt

echo "== persisted claude rows after recreate =="
persisted_claude_rows="$(
psql "$OPENERAL_DATABASE_URL" -Atqc \
  "SELECT count(*)
   FROM _openeral.workspace_files
   WHERE workspace_id LIKE '%:${sandbox_name}' AND path LIKE '/.claude%';"
)"
printf '%s\n' "$persisted_claude_rows"
[ "${persisted_claude_rows:-0}" -gt 0 ]

echo "== claude after recreate =="
claude_again="$(
  run_cli sandbox exec --gateway "$gateway_name" --name "$sandbox_name" --no-tty \
    /usr/bin/env HOME=/sandbox claude -p 'Reply with READY-AGAIN and nothing else.'
)"
printf '%s\n' "$claude_again"
printf '%s\n' "$claude_again" | grep -q 'READY-AGAIN'

echo "Supabase .env validation passed"
