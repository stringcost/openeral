#!/usr/bin/env bash
# Ensure /mnt is bind-mounted into the OpenShell gateway container.
# On WSL2 this requires a one-time container recreation (~30s).
# On native Linux it uses nsenter (no restart needed).
set -euo pipefail

GATEWAY=openshell-cluster-openshell

if docker exec "$GATEWAY" mountpoint -q /mnt 2>/dev/null; then
  echo "✓ /mnt already mounted in gateway"
  exit 0
fi

if grep -qi microsoft /proc/version 2>/dev/null; then
  echo "WSL2: recreating gateway with /mnt (one-time, ~30s)..."

  _IMG=$(docker inspect "$GATEWAY" --format '{{.Config.Image}}')
  _PORT=$(docker inspect "$GATEWAY" \
    --format '{{range $k,$v := .HostConfig.PortBindings}}{{range $v}}{{.HostPort}}{{end}}{{end}}')
  mapfile -t _ENVS < <(docker inspect "$GATEWAY" \
    --format '{{range .Config.Env}}{{println .}}{{end}}')
  _EARGS=(); for _e in "${_ENVS[@]}"; do [[ -n "$_e" ]] && _EARGS+=(-e "$_e"); done

  docker stop "$GATEWAY" 2>/dev/null || true
  docker rm   "$GATEWAY" 2>/dev/null || true
  docker run -d --name "$GATEWAY" --privileged \
    -p "${_PORT:-8080}:8080" "${_EARGS[@]}" -v /mnt:/mnt "$_IMG"

  echo "Waiting for k3s..."
  until docker exec "$GATEWAY" \
    kubectl --insecure-skip-tls-verify get namespace openshell >/dev/null 2>&1
  do sleep 5; done
  echo "✓ Gateway ready with /mnt"

else
  _PID="$(docker inspect "$GATEWAY" --format '{{.State.Pid}}' 2>/dev/null)"
  if [[ -z "$_PID" || "$_PID" == "0" ]]; then
    echo "warning: could not get gateway PID — skipping /mnt injection" >&2
    exit 1
  fi
  echo "Mounting /mnt into gateway (may require sudo)..."
  sudo nsenter -t "$_PID" --mount -- mount --rbind /mnt /mnt
  echo "✓ /mnt mounted in gateway"
fi
