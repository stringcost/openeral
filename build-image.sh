#!/bin/bash
set -e

# Build the local dev image (openeral-sandbox:dev) and import it into k3s.
# Use `npx openeral --dev` to launch with this image.
# `npx openeral` (no flag) always uses the published image and is unaffected by this script.

DEV_IMAGE="${OPENERAL_DEV_IMAGE:-openeral-sandbox:dev}"
FLAT_IMAGE="${DEV_IMAGE}-openeral-flat"

echo "=== Building OpenEral Dev Sandbox Image ==="
echo "  Image: $DEV_IMAGE"
echo ""

echo "Step 0: Checking Docker setup..."
if ! docker network inspect openshell-cluster-openshell >/dev/null 2>&1; then
  echo "  Creating Docker network..."
  docker network create --driver bridge openshell-cluster-openshell
fi
echo "✓ Docker setup verified"
echo ""

echo "Step 1: Building openeral-js..."
cd openeral-js
pnpm install
pnpm build
cd ..
echo "✓ openeral-js built"
echo ""

echo "Step 2: Building dev Docker image (this may take 5-10 minutes)..."
docker build -f sandboxes/openeral/Dockerfile -t "$DEV_IMAGE" .
echo "✓ Dev image built: $DEV_IMAGE"
echo ""

echo "Step 3: Verifying image..."
docker run --rm "$DEV_IMAGE" ls -la /opt/openeral/dist/ | head -10
echo "✓ Image verified — dist directory exists"
echo ""

echo "Step 4: Ensuring k3s cluster is running..."
if ! docker ps | grep -q openshell-cluster-openshell; then
  echo "  k3s container not running, starting with OpenShell gateway..."
  openshell gateway start
  echo "  Waiting for k3s to be ready (60 seconds)..."
  sleep 60
  if ! docker ps | grep -q openshell-cluster-openshell; then
    echo ""
    echo "⚠️  Failed to start k3s cluster!"
    echo "  1. Docker is running: docker ps"
    echo "  2. OpenShell is installed: openshell --version"
    echo "  3. Check logs: docker logs openshell-cluster-openshell"
    exit 1
  fi
else
  echo "  k3s container already running"
fi
echo "✓ k3s cluster is running"
echo ""

echo "Step 5: Removing old dev images from k3s..."
K3S_CTR="ctr --address /run/k3s/containerd/containerd.sock -n k8s.io"

# containerd stores images with the full docker.io/library/ prefix.
# Expand short names before passing to ctr so rm/tag find the right ref.
expand_ref() {
  local ref="$1"
  # If ref has no slash → library image (e.g. "openeral-sandbox:dev")
  if [[ "$ref" != */* ]]; then
    echo "docker.io/library/$ref"
    return
  fi
  # If first component has a dot or colon → already has explicit registry
  local first="${ref%%/*}"
  if [[ "$first" == *.* || "$first" == *:* || "$first" == "localhost" ]]; then
    echo "$ref"
    return
  fi
  # Single org component (e.g. "sandys/image:tag")
  echo "docker.io/$ref"
}

EXPANDED_DEV_IMAGE="$(expand_ref "$DEV_IMAGE")"
EXPANDED_FLAT_IMAGE="$(expand_ref "$FLAT_IMAGE")"

docker exec openshell-cluster-openshell sh -c "
  $K3S_CTR images rm '$EXPANDED_DEV_IMAGE' 2>/dev/null || true
  $K3S_CTR images rm '$EXPANDED_FLAT_IMAGE' 2>/dev/null || true
"
echo "✓ Old dev images removed (or were not present)"
echo ""

echo "Step 6: Flattening and importing dev image into k3s..."
# Docker images built on top of a base that replaces packages contain opaque
# whiteout files that mknod can't create inside a Docker container (seccomp).
# Fix: docker export produces a flat tarball with no whiteouts.

FSTAR="$(mktemp /tmp/openeral-fs-XXXXXX.tar)"
IMGTAR="$(mktemp /tmp/openeral-img-XXXXXX.tar)"

echo "  Step 6a: Flattening image layers..."
docker rm -f openeral-flatten-tmp 2>/dev/null || true
docker create --name openeral-flatten-tmp "$DEV_IMAGE" >/dev/null
docker export openeral-flatten-tmp -o "$FSTAR"
docker rm openeral-flatten-tmp >/dev/null
docker rmi -f "$FLAT_IMAGE" 2>/dev/null || true
docker import "$FSTAR" "$FLAT_IMAGE" >/dev/null
rm -f "$FSTAR"
echo "  ✓ Image flattened (single layer, no whiteouts)"

echo "  Step 6b: Saving and copying to k3s container..."
docker save "$FLAT_IMAGE" -o "$IMGTAR"
docker cp "$IMGTAR" openshell-cluster-openshell:/tmp/openeral-sandbox-import.tar
rm -f "$IMGTAR"

echo "  Step 6c: Importing into k3s..."
if docker exec openshell-cluster-openshell \
    $K3S_CTR images import /tmp/openeral-sandbox-import.tar; then
  # Use expanded refs — containerd does NOT expand short names in `ctr images tag`
  docker exec openshell-cluster-openshell \
    $K3S_CTR images tag "$EXPANDED_FLAT_IMAGE" "$EXPANDED_DEV_IMAGE" 2>/dev/null || true
  docker exec openshell-cluster-openshell rm -f /tmp/openeral-sandbox-import.tar
  echo "✓ Dev image imported to k3s: $DEV_IMAGE"
else
  docker exec openshell-cluster-openshell rm -f /tmp/openeral-sandbox-import.tar
  echo ""
  echo "✗ Image import failed. Try:"
  echo "  docker restart openshell-cluster-openshell"
  echo "  bash build-image.sh"
  exit 1
fi
echo ""

echo "=== Dev Build Complete! ==="
echo ""
echo "Run with the dev image:"
echo "  npx openeral --dev"
echo "  npx openeral -d"
echo ""
echo "Run with the published image (unchanged):"
echo "  npx openeral"
echo ""
