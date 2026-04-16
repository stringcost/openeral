#!/bin/bash
set -e

echo "=== Building OpenEral Sandbox Image ==="
echo ""

echo "Step 0: Checking Docker setup..."
# Ensure Docker network exists
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

echo "Step 2: Building Docker image (this may take 5-10 minutes)..."
docker build -f sandboxes/openeral/Dockerfile -t ghcr.io/sandys/openeral/sandbox:just-bash .
echo "✓ Docker image built"
echo ""

echo "Step 3: Verifying image..."
docker run --rm ghcr.io/sandys/openeral/sandbox:just-bash ls -la /opt/openeral/dist/ | head -10
echo "✓ Image verified - dist directory exists"
echo ""

echo "Step 4: Ensuring k3s cluster is running..."
# Check if container exists and is running
if ! docker ps | grep -q openshell-cluster-openshell; then
  echo "  k3s container not running, starting with OpenShell gateway..."
  
  # Use OpenShell CLI to start the gateway properly
  openshell gateway start
  
  # Wait for k3s to be ready (longer wait for first-time setup)
  echo "  Waiting for k3s to be ready (60 seconds)..."
  sleep 60
  
  # Verify it's running
  if ! docker ps | grep -q openshell-cluster-openshell; then
    echo ""
    echo "⚠️  Failed to start k3s cluster!"
    echo ""
    echo "The gateway may still be starting. Please check:"
    echo "  1. Docker is running: docker ps"
    echo "  2. OpenShell is installed: openshell --version"
    echo "  3. Check logs: docker logs openshell-cluster-openshell"
    echo "  4. Try running 'openshell gateway start' manually"
    echo ""
    exit 1
  fi
else
  echo "  k3s container already running"
fi
echo "✓ k3s cluster is running"
echo ""

echo "Step 5: Removing old images from k3s..."
K3S_CTR="ctr --address /run/k3s/containerd/containerd.sock -n k8s.io"
docker exec openshell-cluster-openshell sh -c "
  $K3S_CTR images rm ghcr.io/sandys/openeral/sandbox:just-bash 2>/dev/null || true
  $K3S_CTR images rm ghcr.io/sandys/openeral/sandbox:just-bash-openeral-flat 2>/dev/null || true
"
echo "✓ Old images removed (or were not present)"
echo ""

echo "Step 6: Flattening and importing image into k3s..."
# Docker images built on top of a base that replaces system packages (e.g. apt
# installing nodejs over an existing npm) contain opaque whiteout files
# (.wh..wh..opq).  k3s's containerd extracts these by calling mknod to create
# whiteout char devices in the overlayfs upper dir — but mknod is restricted
# inside a Docker container (seccomp/AppArmor), so the pod is stuck Pending.
#
# Fix: docker export produces a flat filesystem tarball with no whiteouts.
# docker import turns that into a single-layer image.  This extracts cleanly
# on any Linux system regardless of mknod restrictions.

FLAT_IMAGE="ghcr.io/sandys/openeral/sandbox:just-bash-openeral-flat"
FSTAR="$(mktemp /tmp/openeral-fs-XXXXXX.tar)"
IMGTAR="$(mktemp /tmp/openeral-img-XXXXXX.tar)"

echo "  Step 6a: Flattening image layers..."
docker rm -f openeral-flatten-tmp 2>/dev/null || true
docker create --name openeral-flatten-tmp ghcr.io/sandys/openeral/sandbox:just-bash >/dev/null
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
  # Retag the flat image as the expected sandbox image name
  docker exec openshell-cluster-openshell \
    $K3S_CTR images tag "$FLAT_IMAGE" ghcr.io/sandys/openeral/sandbox:just-bash 2>/dev/null || true
  docker exec openshell-cluster-openshell rm -f /tmp/openeral-sandbox-import.tar
  echo "✓ Image imported to k3s"
else
  docker exec openshell-cluster-openshell rm -f /tmp/openeral-sandbox-import.tar
  echo ""
  echo "✗ Image import failed. Try:"
  echo "  docker restart openshell-cluster-openshell"
  echo "  bash build-image.sh"
  exit 1
fi
echo ""

echo "=== Build Complete! ==="
echo ""
echo "Now you can run:"
echo "  cd openeral-js"
echo "  npx openeral"
echo ""
echo "You'll have all features:"
echo "  ✓ Database persistence"
echo "  ✓ StringCost tracking"
echo "  ✓ Token usage monitoring"
echo "  ✓ npx openeral optimize stats"
echo "  ✓ npx openeral optimize analyze"
echo "  ✓ npx openeral optimize apply"
