#!/usr/bin/env bash
set -euo pipefail

: "${OPENERAL_GATEWAY_IMAGE:?must be set}"
: "${OPENERAL_SUPERVISOR_IMAGE:?must be set}"
: "${OPENERAL_SANDBOX_IMAGE:?must be set}"

command -v docker >/dev/null 2>&1 || {
    echo "docker is not on PATH" >&2
    exit 1
}
command -v openshell >/dev/null 2>&1 || {
    echo "openshell CLI is not on PATH" >&2
    exit 1
}
command -v python3 >/dev/null 2>&1 || {
    echo "python3 is not on PATH" >&2
    exit 1
}
openshell --version

GATEWAY_NAME="${OPENSHELL_GATEWAY_NAME:-openeral-smoke-${RANDOM}}"
GATEWAY_CONTAINER="${OPENERAL_GATEWAY_CONTAINER:-${GATEWAY_NAME}-gateway}"
GATEWAY_STATE="${OPENERAL_GATEWAY_STATE:-$(mktemp -d)}"
SANDBOX_NAME="${OPENERAL_SANDBOX_NAME:-openeral-smoke-${RANDOM}}"
DB_PROVIDER="${OPENERAL_DB_PROVIDER:-openeral-db-${RANDOM}}"
SOCKET_PROVIDER="${OPENERAL_SOCKET_PROVIDER:-openeral-socket-${RANDOM}}"
DB_CONTAINER="${OPENERAL_SMOKE_DB_CONTAINER:-openeral-smoke-postgres-${RANDOM}}"
DOWNLOAD_DIR=""

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

DB_PORT="${OPENERAL_SMOKE_DB_PORT:-$(pick_port 15432 15532)}"
GATEWAY_PORT="${OPENSHELL_GATEWAY_PORT:-$(pick_port 28080 49151)}"

if [ -z "$DB_PORT" ] || [ -z "$GATEWAY_PORT" ]; then
    echo "Could not allocate free smoke-test ports" >&2
    exit 1
fi

dump_gateway_logs() {
    set +e
    if docker ps -a --format '{{.Names}}' | grep -qx "$GATEWAY_CONTAINER"; then
        echo "--- gateway logs (${GATEWAY_CONTAINER}) ---" >&2
        docker logs "$GATEWAY_CONTAINER" >&2 || true
        echo "--- end gateway logs ---" >&2
    fi
}

dump_sandbox_logs() {
    set +e
    echo "--- sandbox logs (${SANDBOX_NAME}) ---" >&2
    openshell --gateway "$GATEWAY_NAME" logs "$SANDBOX_NAME" -n 300 --source all >&2 || true
    echo "--- end sandbox logs ---" >&2

    echo "--- docker containers visible to smoke (${SANDBOX_NAME}) ---" >&2
    docker ps -a \
        --format 'id={{.ID}} name={{.Names}} status={{.Status}} image={{.Image}} labels={{.Labels}}' \
        | grep -E "openshell|${SANDBOX_NAME}|${GATEWAY_NAME}" >&2 || true
    echo "--- end docker containers visible to smoke ---" >&2

    local containers
    containers="$(
        docker ps -aq \
            --filter "label=openshell.ai/managed-by=openshell" \
            --filter "label=openshell.ai/sandbox-name=${SANDBOX_NAME}" 2>/dev/null || true
    )"
    if [ -z "$containers" ]; then
        containers="$(
            docker ps -aq \
                --filter "label=openshell.ai/managed-by=openshell" 2>/dev/null \
                | while read -r container; do
                    [ -n "$container" ] || continue
                    docker inspect --format '{{.Name}} {{json .Config.Labels}}' "$container" 2>/dev/null \
                        | grep -q "$SANDBOX_NAME" && printf '%s\n' "$container"
                done
        )"
    fi
    if [ -z "$containers" ]; then
        containers="$(
            docker ps -aq \
                --filter "name=${SANDBOX_NAME}" 2>/dev/null || true
        )"
    fi
    if [ -n "$containers" ]; then
        echo "--- raw sandbox container logs (${SANDBOX_NAME}) ---" >&2
        for container in $containers; do
            docker inspect \
                --format 'container={{.Name}} id={{.Id}} status={{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}} oom={{.State.OOMKilled}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}' \
                "$container" >&2 || true
            docker logs --tail 400 "$container" >&2 || true
        done
        echo "--- end raw sandbox container logs ---" >&2
    fi
}

cleanup() {
    set +e
    openshell sandbox delete --gateway "$GATEWAY_NAME" "$SANDBOX_NAME" >/dev/null 2>&1 || true
    openshell gateway destroy --name "$GATEWAY_NAME" >/dev/null 2>&1 || true
    docker rm -f "$GATEWAY_CONTAINER" "$DB_CONTAINER" >/dev/null 2>&1 || true
    if [ -n "$DOWNLOAD_DIR" ]; then
        rm -rf "$DOWNLOAD_DIR" >/dev/null 2>&1 || true
    fi
    if [ -d "$GATEWAY_STATE" ] && [[ "$GATEWAY_STATE" == /tmp/* ]]; then
        rm -rf "$GATEWAY_STATE" >/dev/null 2>&1 || true
    fi
}

on_exit() {
    status=$?
    if [ "$status" -ne 0 ]; then
        dump_sandbox_logs
        dump_gateway_logs
    fi
    cleanup
    exit "$status"
}
trap on_exit EXIT

docker rm -f "$GATEWAY_CONTAINER" "$DB_CONTAINER" >/dev/null 2>&1 || true

docker run -d \
    --name "$DB_CONTAINER" \
    -e POSTGRES_USER=pgmount \
    -e POSTGRES_PASSWORD=pgmount \
    -e POSTGRES_DB=testdb \
    -p "${DB_PORT}:5432" \
    postgres:16 >/dev/null

for _ in $(seq 1 30); do
    if docker exec "$DB_CONTAINER" pg_isready -U pgmount -d testdb >/dev/null 2>&1; then
        DB_READY=1
        break
    fi
    sleep 1
done

if [ "${DB_READY:-0}" != "1" ]; then
    echo "PostgreSQL did not become ready in time" >&2
    exit 1
fi

for _ in $(seq 1 30); do
    if PGPASSWORD=pgmount psql -h localhost -p "$DB_PORT" -U pgmount -d testdb -Atqc 'SELECT 1' >/dev/null 2>&1; then
        DB_HOST_READY=1
        break
    fi
    sleep 1
done

if [ "${DB_HOST_READY:-0}" != "1" ]; then
    echo "PostgreSQL did not accept host connections in time" >&2
    exit 1
fi

PGPASSWORD=pgmount psql -h localhost -p "$DB_PORT" -U pgmount -d testdb -q <<'SQL'
DROP TABLE IF EXISTS public.users CASCADE;
CREATE TABLE public.users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT
);
INSERT INTO public.users (id, name, email) VALUES
    (1, 'Ada Lovelace', 'ada@example.com');
SQL

mkdir -p "$GATEWAY_STATE/home"
docker_socket_gid="$(stat -c '%g' /var/run/docker.sock)"

docker run -d \
    --name "$GATEWAY_CONTAINER" \
    --network host \
    --user "$(id -u):$(id -g)" \
    --group-add "$docker_socket_gid" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$GATEWAY_STATE:$GATEWAY_STATE" \
    -e HOME="$GATEWAY_STATE/home" \
    -e XDG_DATA_HOME="$GATEWAY_STATE" \
    -e OPENSHELL_BIND_ADDRESS=0.0.0.0 \
    -e OPENSHELL_SERVER_PORT="$GATEWAY_PORT" \
    -e OPENSHELL_DB_URL="sqlite:${GATEWAY_STATE}/openshell.db" \
    -e OPENSHELL_DRIVERS=docker \
    -e OPENSHELL_DISABLE_TLS=true \
    -e OPENSHELL_GRPC_ENDPOINT="http://127.0.0.1:${GATEWAY_PORT}" \
    -e OPENSHELL_DOCKER_SUPERVISOR_IMAGE="$OPENERAL_SUPERVISOR_IMAGE" \
    -e OPENSHELL_DOCKER_FUSE_DEVICE=/dev/fuse \
    -e OPENSHELL_SANDBOX_IMAGE="$OPENERAL_SANDBOX_IMAGE" \
    "$OPENERAL_GATEWAY_IMAGE" \
    --bind-address 0.0.0.0 \
    --port "$GATEWAY_PORT" \
    --disable-tls >/dev/null

for _ in $(seq 1 60); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$GATEWAY_CONTAINER" 2>/dev/null || echo false)" != "true" ]; then
        echo "Gateway container exited before ready" >&2
        docker logs "$GATEWAY_CONTAINER" >&2 || true
        exit 1
    fi
    if ! docker logs "$GATEWAY_CONTAINER" 2>&1 | grep -q "Server listening"; then
        sleep 1
        continue
    fi
    if python3 - "$GATEWAY_PORT" <<'PY' >/dev/null 2>&1
import socket
import sys

with socket.create_connection(("127.0.0.1", int(sys.argv[1])), timeout=1):
    pass
PY
    then
        GATEWAY_READY=1
        break
    fi
    sleep 1
done

if [ "${GATEWAY_READY:-0}" != "1" ]; then
    echo "Gateway did not become ready in time" >&2
    docker logs "$GATEWAY_CONTAINER" >&2 || true
    exit 1
fi

openshell gateway add --local --name "$GATEWAY_NAME" "http://127.0.0.1:${GATEWAY_PORT}"
openshell gateway select "$GATEWAY_NAME"

sandbox_db_url="postgresql://pgmount:pgmount@host.docker.internal:${DB_PORT}/testdb"

DATABASE_URL="$sandbox_db_url" openshell provider create \
    --gateway "$GATEWAY_NAME" \
    --name "$DB_PROVIDER" \
    --type generic \
    --credential DATABASE_URL

SOCKET_TOKEN="smoke-socket-token" openshell provider create \
    --gateway "$GATEWAY_NAME" \
    --name "$SOCKET_PROVIDER" \
    --type generic \
    --credential SOCKET_TOKEN

SANDBOX_OUTPUT="$(
    openshell sandbox create \
        --gateway "$GATEWAY_NAME" \
        --name "$SANDBOX_NAME" \
        --from "$OPENERAL_SANDBOX_IMAGE" \
        --provider "$DB_PROVIDER" \
        --provider "$SOCKET_PROVIDER" \
        --no-tty -- \
        sh -lc '
            set -e
            test -e /dev/fuse
            id
            grep -E " /db | /home/agent " /proc/mounts
            test -w /home/agent
            test "$HOME" = /home/agent
            test -f /home/agent/.claude/settings.json
            grep -q enableAllProjectMcpServers /home/agent/.claude/settings.json
            test -f /tmp/openeral-npmrc
            grep -q openshell:resolve:env:SOCKET_TOKEN /tmp/openeral-npmrc
            test ! -e /home/agent/.npmrc
            ! mkdir /home/agent/.ssh
            cat /db/public/users/.filter/id/1/1/row.json
            printf persist-ok > /home/agent/manual.txt
            cat /home/agent/manual.txt
            openeral memory refresh --dry-run --project-root /home/agent
        '
)"
printf '%s\n' "$SANDBOX_OUTPUT"

printf '%s\n' "$SANDBOX_OUTPUT" | grep -q 'Ada Lovelace'
printf '%s\n' "$SANDBOX_OUTPUT" | grep -q 'persist-ok'
printf '%s\n' "$SANDBOX_OUTPUT" | grep -q 'uid='

DOWNLOAD_DIR="$(mktemp -d)"
openshell sandbox download \
    --gateway "$GATEWAY_NAME" \
    "$SANDBOX_NAME" \
    /home/agent/manual.txt \
    "$DOWNLOAD_DIR"

DOWNLOADED_MANUAL="$DOWNLOAD_DIR/manual.txt"
if [ ! -f "$DOWNLOADED_MANUAL" ]; then
    echo "Expected downloaded manual.txt at ${DOWNLOADED_MANUAL}" >&2
    exit 1
fi

if [ "$(cat "$DOWNLOADED_MANUAL")" != "persist-ok" ]; then
    echo "Expected downloaded manual.txt to contain persist-ok" >&2
    exit 1
fi

MANUAL_COUNT="$(
    PGPASSWORD=pgmount psql -h localhost -p "$DB_PORT" -U pgmount -d testdb -Atqc \
        "SELECT count(*) FROM _openeral.workspace_files WHERE path = '/manual.txt' AND content = convert_to('persist-ok', 'UTF8')"
)"
if [ "$MANUAL_COUNT" != "1" ]; then
    echo "Expected one persisted /manual.txt row, got ${MANUAL_COUNT}" >&2
    exit 1
fi

CLAUDE_SETTINGS_COUNT="$(
    PGPASSWORD=pgmount psql -h localhost -p "$DB_PORT" -U pgmount -d testdb -Atqc \
        "SELECT count(*) FROM _openeral.workspace_files WHERE path = '/.claude/settings.json'"
)"
if [ "$CLAUDE_SETTINGS_COUNT" != "1" ]; then
    echo "Expected one persisted /.claude/settings.json row, got ${CLAUDE_SETTINGS_COUNT}" >&2
    exit 1
fi

echo "OpenShell Docker-driver smoke test passed"
