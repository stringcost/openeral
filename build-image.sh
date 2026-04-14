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

echo "Step 5: Removing old image from k3s..."
docker exec openshell-cluster-openshell ctr -n k8s.io images rm ghcr.io/sandys/openeral/sandbox:just-bash 2>/dev/null || true
echo "✓ Old image removed"
echo ""

echo "Step 6: Importing to k3s (this takes 8-10 minutes, please be patient)..."
docker save ghcr.io/sandys/openeral/sandbox:just-bash | \
  docker exec -i openshell-cluster-openshell ctr -n k8s.io images import -
echo "✓ Image imported to k3s"
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
