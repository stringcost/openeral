#!/bin/sh
set -e

CSI_IMAGE="${OPENERAL_CSI_IMAGE:-}"
if [ -z "$CSI_IMAGE" ]; then
  CSI_TAG="${IMAGE_TAG:-latest}"
  if [ -n "${IMAGE_REPO_BASE:-}" ]; then
    CSI_IMAGE="${IMAGE_REPO_BASE}/cluster:${CSI_TAG}"
  else
    CSI_IMAGE="ghcr.io/stringcost/openeral/cluster:${CSI_TAG}"
  fi
fi

SANDBOX_IMAGE="${OPENERAL_SANDBOX_IMAGE:-${OPENSHELL_SANDBOX_IMAGE:-}}"
PROJECT_SOURCE_PATH="${OPENERAL_PROJECT_SOURCE_PATH:-/opt/openeral/host-project-src}"
PROJECT_MOUNT_PATH="${OPENERAL_PROJECT_MOUNT_PATH:-/opt/openeral/host-project}"
PROJECT_SANDBOX_UID="${OPENERAL_PROJECT_SANDBOX_UID:-998}"
PROJECT_SANDBOX_GID="${OPENERAL_PROJECT_SANDBOX_GID:-998}"

prepare_project_mount() {
  if [ ! -d "$PROJECT_SOURCE_PATH" ]; then
    return 0
  fi

  mkdir -p "$PROJECT_MOUNT_PATH"
  if mountpoint -q "$PROJECT_MOUNT_PATH"; then
    umount "$PROJECT_MOUNT_PATH"
  fi

  HOST_UID="$(stat -c '%u' "$PROJECT_SOURCE_PATH")"
  HOST_GID="$(stat -c '%g' "$PROJECT_SOURCE_PATH")"
  IDMAP="u:${HOST_UID}:${PROJECT_SANDBOX_UID}:1 g:${HOST_GID}:${PROJECT_SANDBOX_GID}:1"

  mount -o "X-mount.idmap=${IDMAP}" --bind "$PROJECT_SOURCE_PATH" "$PROJECT_MOUNT_PATH"
}

CSI_MANIFEST="/opt/openeral/manifests/openshell-openeral-csi.yaml"
if [ -f "$CSI_MANIFEST" ]; then
  sed -i "s|__OPENERAL_CSI_IMAGE__|${CSI_IMAGE}|g" "$CSI_MANIFEST"
  HOST_GATEWAY_IP="$(getent ahostsv4 host.docker.internal 2>/dev/null | awk 'NR == 1 { print $1; exit }')"
  if [ -z "$HOST_GATEWAY_IP" ]; then
    HOST_GATEWAY_IP="$(ip -4 route | awk '/default/ { print $3; exit }')"
  fi
  if [ -n "$HOST_GATEWAY_IP" ]; then
    sed -i "s|__HOST_GATEWAY_IP__|${HOST_GATEWAY_IP}|g" "$CSI_MANIFEST"
  fi
fi

HELMCHART="/opt/openshell/manifests/openshell-helmchart.yaml"
if [ -f "$HELMCHART" ]; then
  sed -i 's|chart: https://%{KUBERNETES_API}%/static/charts/openshell-0.1.0.tgz|chart: https://%{KUBERNETES_API}%/static/charts/helm-chart-0.0.0.tgz|' "$HELMCHART"
  if [ -n "$SANDBOX_IMAGE" ]; then
    sed -i -E "s|sandboxImage:[[:space:]]*[^[:space:]]+|sandboxImage: ${SANDBOX_IMAGE}|" "$HELMCHART"
  fi
fi

prepare_project_mount

exec /usr/local/bin/cluster-entrypoint.sh "$@"
