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
DB_CONTAINER="${OPENERAL_SMOKE_DB_CONTAINER:-openeral-smoke-postgres-${RANDOM}}"
DOWNLOAD_DIR=""

pick_port() {
    python3 - "$@" <<'PY'
import socket
import sys

start = int(sys.argv[1])
end = int(sys.argv[2])
for port in range(start, end + 1):
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
GATEWAY_PORT="${OPENSHELL_GATEWAY_PORT:-$(pick_port 18080 18180)}"

if [ -z "$DB_PORT" ] || [ -z "$GATEWAY_PORT" ]; then
    echo "Could not allocate free smoke-test ports" >&2
    exit 1
fi

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
trap cleanup EXIT

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
    --port "$GATEWAY_PORT" >/dev/null

for _ in $(seq 1 60); do
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
    if ! docker ps --format '{{.Names}}' | grep -qx "$GATEWAY_CONTAINER"; then
        echo "Gateway container exited before ready" >&2
        docker logs "$GATEWAY_CONTAINER" >&2 || true
        exit 1
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

SANDBOX_OUTPUT="$(
    openshell sandbox create \
        --gateway "$GATEWAY_NAME" \
        --name "$SANDBOX_NAME" \
        --from "$OPENERAL_SANDBOX_IMAGE" \
        --provider "$DB_PROVIDER" \
        --no-tty -- \
        sh -lc '
            set -e
            test -e /dev/fuse
            id
            grep -E " /db | /home/agent " /proc/mounts
            test -w /home/agent
            cat /db/public/users/.filter/id/1/1/row.json
            printf persist-ok > /home/agent/manual.txt
            cat /home/agent/manual.txt
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

echo "OpenShell Docker-driver smoke test passed"
