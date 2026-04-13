#!/usr/bin/env node

/**
 * openeral CLI — run Claude Code inside an OpenShell sandbox.
 *
 * `npx openeral` launches an OpenShell sandbox from the openeral image.
 * Inside the sandbox, setup.sh runs migrations, seeds the workspace,
 * starts the openeral-bash daemon, then execs `claude`.
 *
 * Usage:
 *   npx openeral                      # interactive Claude Code
 *   npx openeral -- -p 'hello'        # non-interactive
 *   npx openeral --workspace myid     # custom workspace ID
 *   npx openeral optimize stats       # show optimization stats
 *
 * Required env:
 *   ANTHROPIC_API_KEY       Claude API key
 *
 * Optional env:
 *   DATABASE_URL            Database connection string (uses PGlite if not provided)
 *   OPENERAL_WORKSPACE_ID   Workspace ID (default: openeral-claude, normalized to lowercase)
 *   OPENERAL_SANDBOX_IMAGE  Override sandbox image (default: ghcr.io/sandys/openeral/sandbox:just-bash)
 *
 * Features:
 *   - Automatic TLS certificate generation for OpenShell gateway
 *   - Automatic Claude CLI installation if not present in sandbox
 *   - Automatic sandbox cleanup to prevent duplicate errors
 *   - Kubernetes-compliant workspace name normalization
 *   - Extended startup timeout (8 minutes) for first-time setup
 *   - PGlite support for local development (no PostgreSQL required)
 */

import { spawn, spawnSync } from 'node:child_process';

type ParsedArgs =
  | { kind: 'launch'; workspaceId: string; claudeArgs: string[] }
  | { kind: 'memory-refresh'; workspaceId: string; projectRoot: string; query: string; dryRun: boolean; backup: boolean }
  | { kind: 'help' };

export function parseCliArgs(args: string[]): ParsedArgs {
  // Check for help
  if (args.includes('--help') || args.includes('-h')) {
    const dashIdx = args.indexOf('--');
    const helpIdx = Math.max(args.indexOf('--help'), args.indexOf('-h'));
    if (dashIdx === -1 || helpIdx < dashIdx) {
      return { kind: 'help' };
    }
  }

  // Check for memory refresh command
  if (args[0] === 'memory' && args[1] === 'refresh') {
    let workspaceId = process.env.OPENERAL_WORKSPACE_ID || 'openeral-claude';
    let projectRoot = '';
    let query = '';
    let dryRun = false;
    let backup = true;

    for (let i = 2; i < args.length; i++) {
      if ((args[i] === '--workspace' || args[i] === '-w') && args[i + 1]) {
        workspaceId = args[++i];
      } else if (args[i] === '--project-root' && args[i + 1]) {
        projectRoot = args[++i];
      } else if (args[i] === '--query' && args[i + 1]) {
        query = args[++i];
      } else if (args[i] === '--dry-run') {
        dryRun = true;
      } else if (args[i] === '--no-backup') {
        backup = false;
      }
    }

    // Normalize workspace ID to be Kubernetes-compliant
    workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');

    return { kind: 'memory-refresh', workspaceId, projectRoot, query, dryRun, backup };
  }

  // Default: launch mode
  let workspaceId = process.env.OPENERAL_WORKSPACE_ID || 'openeral-claude';
  let claudeArgs: string[] = [];

  const dashIdx = args.indexOf('--');
  const ownArgs = dashIdx >= 0 ? args.slice(0, dashIdx) : args;
  claudeArgs = dashIdx >= 0 ? args.slice(dashIdx + 1) : [];

  for (let i = 0; i < ownArgs.length; i++) {
    if ((ownArgs[i] === '--workspace' || ownArgs[i] === '-w') && ownArgs[i + 1]) {
      workspaceId = ownArgs[++i];
    }
  }

  // Normalize workspace ID to be Kubernetes-compliant (lowercase, alphanumeric + hyphens)
  workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');

  return { kind: 'launch', workspaceId, claudeArgs };
}

function printHelp(): void {
  console.log(`Usage:
  openeral [options] [-- claude-args]    Launch Claude Code in an OpenShell sandbox
  openeral memory refresh [options]      Refresh memory system

Launch Options:
  --workspace, -w <id>    Workspace ID (default: openeral-claude)
  --help, -h              Show this help

Memory Refresh Options:
  --workspace, -w <id>    Workspace ID
  --project-root <path>   Project root directory
  --query <text>          Search query
  --dry-run               Preview changes without applying
  --no-backup             Skip backup creation

Environment Variables:
  ANTHROPIC_API_KEY        Claude API key (required)
  DATABASE_URL             Database connection string (optional, uses PGlite if not provided)
  OPENERAL_WORKSPACE_ID    Default workspace ID (will be normalized to lowercase)
  OPENERAL_SANDBOX_IMAGE   Override sandbox image (default: ghcr.io/sandys/openeral/sandbox:just-bash)

Notes:
  - Workspace IDs are automatically normalized to be Kubernetes-compliant (lowercase, alphanumeric + hyphens)
  - Claude CLI will be automatically installed in the sandbox if not present
  - Existing sandboxes with the same name will be cleaned up automatically
  - PGlite is used by default for local development (no PostgreSQL required)
`);
}

// ---------------------------------------------------------------------------
// OpenShell sandbox launch
// ---------------------------------------------------------------------------

/**
 * Ensure TLS secrets exist in the openshell namespace.
 * This is a common issue on first run where the Helm chart expects
 * TLS secrets but they don't exist yet.
 */
async function ensureTlsSecrets(): Promise<void> {
  // Check if secrets already exist
  const checkSecrets = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'kubectl', 'get', 'secret',
    'openshell-server-tls',
    '-n', 'openshell'
  ], { stdio: 'pipe' });

  if (checkSecrets.status === 0) {
    // Secrets already exist
    return;
  }

  // Wait for openshell namespace to exist (may take a moment after gateway starts)
  let namespaceReady = false;
  for (let i = 0; i < 30; i++) {
    const checkNs = spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'kubectl', 'get', 'namespace', 'openshell'
    ], { stdio: 'pipe' });
    
    if (checkNs.status === 0) {
      namespaceReady = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
  }

  if (!namespaceReady) {
    process.stderr.write('\x1b[33mwarning: openshell namespace not ready, skipping TLS setup\x1b[0m\n');
    return;
  }

  process.stderr.write('\x1b[2mopeneral: creating TLS certificates...\x1b[0m\n');

  // Generate self-signed certificate
  const genCert = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'sh', '-c',
    'openssl req -x509 -newkey rsa:4096 -keyout /tmp/tls.key -out /tmp/tls.crt -days 365 -nodes -subj "/CN=openshell.openshell.svc.cluster.local"'
  ], { stdio: 'pipe' });

  if (genCert.status !== 0) {
    process.stderr.write('\x1b[33mwarning: failed to generate TLS certificate\x1b[0m\n');
    return;
  }

  // Create server TLS secret
  const createServerTls = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'kubectl', 'create', 'secret', 'tls',
    'openshell-server-tls',
    '--cert=/tmp/tls.crt',
    '--key=/tmp/tls.key',
    '-n', 'openshell'
  ], { stdio: 'pipe' });

  if (createServerTls.status !== 0) {
    // Secret might already exist, that's okay
    return;
  }

  // Create client CA secret
  spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'kubectl', 'create', 'secret', 'generic',
    'openshell-server-client-ca',
    '--from-file=ca.crt=/tmp/tls.crt',
    '-n', 'openshell'
  ], { stdio: 'pipe' });

  process.stderr.write('\x1b[32m✓ TLS certificates created\x1b[0m\n');
}

/**
 * Wait for the openshell-0 pod to be ready.
 * This ensures the gateway is fully operational before we try to create sandboxes.
 * Returns true if pod is ready, false if timeout.
 */
async function waitForOpenshellPod(): Promise<boolean> {
  const maxAttempts = 60; // 2 minutes (60 * 2 seconds)
  
  for (let i = 0; i < maxAttempts; i++) {
    const checkPod = spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'kubectl', 'get', 'pod', 'openshell-0',
      '-n', 'openshell',
      '-o', 'jsonpath={.status.conditions[?(@.type=="Ready")].status}'
    ], { stdio: 'pipe' });

    if (checkPod.status === 0 && checkPod.stdout.toString().trim() === 'True') {
      return true; // Pod is ready
    }

    // Show progress every 10 seconds
    if (i > 0 && i % 5 === 0) {
      process.stderr.write('\x1b[2m  still waiting for gateway pod...\x1b[0m\n');
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
  }

  process.stderr.write('\x1b[33mwarning: gateway pod not ready after 2 minutes, continuing anyway\x1b[0m\n');
  return false;
}

/**
 * Ensure the sandbox image is available in the k3s cluster.
 * Pre-pulls the image on the host and imports it into k3s to avoid DNS issues.
 */
async function ensureSandboxImage(sandboxImage: string): Promise<void> {
  process.stderr.write('\x1b[2mopeneral: ensuring sandbox image is available...\x1b[0m\n');

  // Extract image name and tag for checking
  // e.g., "ghcr.io/sandys/openeral/sandbox:just-bash" -> check for "sandbox" and "just-bash"
  const imageParts = sandboxImage.split('/');
  const imageNameTag = imageParts[imageParts.length - 1]; // "sandbox:just-bash"
  const [imageName, imageTag] = imageNameTag.split(':'); // ["sandbox", "just-bash"]

  // Check if image exists in k3s
  const checkImage = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'crictl', 'images'
  ], { stdio: 'pipe', timeout: 10000 });

  const imageList = checkImage.stdout.toString();
  
  // Check if both image name and tag are present
  if (imageList.includes(imageName) && imageList.includes(imageTag)) {
    process.stderr.write('\x1b[32m✓ Sandbox image available in cluster\x1b[0m\n');
    return;
  }

  process.stderr.write('\x1b[2m  image not found in cluster, importing...\x1b[0m\n');

  // Pull on host
  process.stderr.write('\x1b[2m  pulling image on host (this may take a few minutes)...\x1b[0m\n');
  const pullResult = spawnSync('docker', ['pull', sandboxImage], {
    stdio: 'inherit',
    timeout: 600000, // 10 minutes for slow connections
  });

  if (pullResult.status !== 0) {
    process.stderr.write(
      '\x1b[33mwarning: failed to pull image on host\x1b[0m\n' +
      'The sandbox may fail to start. Try manually:\n' +
      `  docker pull ${sandboxImage}\n`
    );
    return;
  }

  // Import into k3s using pipe (more efficient than save/load)
  process.stderr.write('\x1b[2m  importing into k3s cluster (this may take 3-5 minutes)...\x1b[0m\n');
  
  // Use docker save piped to ctr import with timeout
  const saveProc = spawn('docker', ['save', sandboxImage]);
  const importProc = spawn('docker', [
    'exec', '-i', 'openshell-cluster-openshell',
    'ctr', '-n', 'k8s.io', 'images', 'import', '-'
  ]);

  saveProc.stdout.pipe(importProc.stdin);

  // Add timeout for import
  const importTimeout = setTimeout(() => {
    saveProc.kill();
    importProc.kill();
    process.stderr.write(
      '\x1b[33mwarning: image import timed out after 5 minutes\x1b[0m\n' +
      'Continuing anyway - the image may already be imported.\n'
    );
  }, 300000); // 5 minute timeout

  await new Promise<void>((resolve) => {
    importProc.on('exit', (code) => {
      clearTimeout(importTimeout);
      if (code === 0) {
        process.stderr.write('\x1b[32m✓ Sandbox image imported to cluster\x1b[0m\n');
      } else {
        process.stderr.write(
          '\x1b[33mwarning: image import may have failed (exit code: ' + code + ')\x1b[0m\n' +
          'Continuing anyway - checking if image is available...\n'
        );
      }
      resolve();
    });

    importProc.on('error', (err) => {
      clearTimeout(importTimeout);
      process.stderr.write(`\x1b[33mwarning: ${err.message}\x1b[0m\n`);
      resolve();
    });

    // Also handle save process errors
    saveProc.on('error', (err) => {
      clearTimeout(importTimeout);
      process.stderr.write(`\x1b[33mwarning: save failed: ${err.message}\x1b[0m\n`);
      importProc.kill();
      resolve();
    });
  });

  // Verify image is actually available (check again with better logic)
  const verifyImage = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'crictl', 'images'
  ], { stdio: 'pipe', timeout: 10000 });

  const verifyList = verifyImage.stdout.toString();
  if (verifyList.includes(imageName) && verifyList.includes(imageTag)) {
    process.stderr.write('\x1b[32m✓ Image verified in cluster\x1b[0m\n');
  } else {
    process.stderr.write(
      '\x1b[33mwarning: image not found in cluster after import\x1b[0m\n' +
      'The sandbox may fail to start due to missing image.\n' +
      'Try manually: docker save ' + sandboxImage + ' | docker exec -i openshell-cluster-openshell ctr -n k8s.io images import -\n'
    );
  }
}

/**
 * Ensure Claude CLI is available in the sandbox.
 * If not installed, install it using npm.
 */
async function ensureClaudeInSandbox(workspaceId: string, sandboxImage: string): Promise<void> {
  process.stderr.write('\x1b[2mopeneral: checking Claude CLI availability...\x1b[0m\n');

  // Create a temporary sandbox to check if Claude is installed
  const checkArgs = [
    'sandbox', 'create',
    '--name', `${workspaceId}-claude-check`,
    '--from', sandboxImage,
    '--',
    'sh', '-c', 'command -v claude || echo "NOT_FOUND"'
  ];

  const checkResult = spawnSync('openshell', checkArgs, {
    stdio: 'pipe',
    timeout: 30000,
  });

  const output = checkResult.stdout?.toString() || '';
  const claudeNotFound = output.includes('NOT_FOUND') || checkResult.status !== 0;

  // Clean up the check sandbox
  spawnSync('openshell', ['sandbox', 'delete', `${workspaceId}-claude-check`], {
    stdio: 'pipe',
  });

  if (claudeNotFound) {
    process.stderr.write('\x1b[2mopeneral: Claude CLI not found, installing...\x1b[0m\n');

    // Install Claude CLI in a temporary sandbox
    const installArgs = [
      'sandbox', 'create',
      '--name', `${workspaceId}-claude-install`,
      '--from', sandboxImage,
      '--',
      'sh', '-c',
      'npm install -g @anthropic-ai/claude-cli && echo "INSTALL_SUCCESS"'
    ];

    const installResult = spawnSync('openshell', installArgs, {
      stdio: 'pipe',
      timeout: 120000, // 2 minutes for npm install
    });

    const installOutput = installResult.stdout?.toString() || '';
    
    // Clean up the install sandbox
    spawnSync('openshell', ['sandbox', 'delete', `${workspaceId}-claude-install`], {
      stdio: 'pipe',
    });

    if (!installOutput.includes('INSTALL_SUCCESS') || installResult.status !== 0) {
      process.stderr.write(
        '\x1b[33mwarning: failed to install Claude CLI automatically\x1b[0m\n' +
        'You may need to install it manually in the sandbox:\n' +
        '  npm install -g @anthropic-ai/claude-cli\n'
      );
    } else {
      process.stderr.write('\x1b[32m✓ Claude CLI installed\x1b[0m\n');
    }
  } else {
    process.stderr.write('\x1b[32m✓ Claude CLI available\x1b[0m\n');
  }
}

/**
 * Cleanup existing sandbox if it exists.
 * This prevents UNIQUE constraint errors when recreating sandboxes.
 */
async function cleanupExistingSandbox(workspaceId: string): Promise<void> {
  // Check if sandbox exists
  const listResult = spawnSync('openshell', ['sandbox', 'list'], {
    stdio: 'pipe',
    timeout: 10000,
  });

  if (listResult.status !== 0) {
    // Can't list sandboxes, skip cleanup
    return;
  }

  const output = listResult.stdout.toString();
  if (!output.includes(workspaceId)) {
    // Sandbox doesn't exist, nothing to clean up
    return;
  }

  process.stderr.write(`\x1b[2mopeneral: cleaning up existing sandbox '${workspaceId}'...\x1b[0m\n`);

  // Delete the existing sandbox
  const deleteResult = spawnSync('openshell', ['sandbox', 'delete', workspaceId], {
    stdio: 'pipe',
    timeout: 30000,
  });

  if (deleteResult.status === 0) {
    process.stderr.write('\x1b[32m✓ Existing sandbox cleaned up\x1b[0m\n');
  } else {
    // Deletion failed, but continue anyway - the create might still work
    process.stderr.write('\x1b[33mwarning: failed to delete existing sandbox, continuing anyway\x1b[0m\n');
  }

  // Wait a moment for cleanup to complete
  await new Promise(resolve => setTimeout(resolve, 2000));
}

/**
 * Launch Claude Code inside an OpenShell sandbox.
 *
 * Flow:
 *   1. Ensure the OpenShell gateway is running (idempotent).
 *   2. Create a sandbox from the openeral image and attach to it.
 *      setup.sh runs migrations, seeds the workspace, starts the
 *      openeral-bash daemon, then execs `claude`.
 */
async function launchViaSandbox(workspaceId: string, claudeArgs: string[]): Promise<void> {
  const sandboxImage =
    process.env.OPENERAL_SANDBOX_IMAGE ?? 'ghcr.io/sandys/openeral/sandbox:just-bash';

  // Check if openshell is installed
  const checkResult = spawnSync('openshell', ['--version'], { stdio: 'pipe' });
  if (checkResult.error) {
    const isNotFound = (checkResult.error as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      process.stderr.write(
        '\x1b[31merror: `openshell` is not installed.\x1b[0m\n' +
        'openeral runs Claude Code inside an OpenShell sandbox — install OpenShell first:\n' +
        '  https://docs.openshell.dev/install\n',
      );
      process.exit(1);
    }
  }

  // Check if Docker is running
  const dockerCheck = spawnSync('docker', ['info'], { stdio: 'pipe', timeout: 5000 });
  if (dockerCheck.error || dockerCheck.status !== 0) {
    process.stderr.write(
      '\x1b[31merror: Docker is not running.\x1b[0m\n' +
      'OpenShell requires Docker. Start it with:\n' +
      '  sudo systemctl start docker\n' +
      '  # or on WSL: sudo service docker start\n',
    );
    process.exit(1);
  }

  // Check if OpenShell network exists, create if needed
  const networkCheck = spawnSync('docker', ['network', 'inspect', 'openshell-cluster-openshell'], {
    stdio: 'pipe',
  });

  if (networkCheck.status !== 0) {
    process.stderr.write('\x1b[2mopeneral: creating OpenShell network...\x1b[0m\n');
    const networkCreate = spawnSync('docker', [
      'network', 'create',
      '--driver', 'bridge',
      'openshell-cluster-openshell'
    ], { stdio: 'pipe' });

    if (networkCreate.status !== 0) {
      process.stderr.write(
        '\x1b[31merror: failed to create Docker network.\x1b[0m\n' +
        'Try manually:\n' +
        '  docker network create --driver bridge openshell-cluster-openshell\n',
      );
      process.exit(1);
    }
  }

  // Start the gateway and wait for it to be ready
  process.stderr.write('\x1b[2mopeneral: starting OpenShell gateway (this may take 5-8 minutes on first run)...\x1b[0m\n');
  
  // Start gateway synchronously with a longer timeout
  const gatewayResult = spawnSync('openshell', ['gateway', 'start'], {
    stdio: 'inherit', // Show gateway output so user sees progress
    timeout: 480_000, // 8 minutes - gateway can be slow on first run, especially with image pulls
  });

  if (gatewayResult.error) {
    if (gatewayResult.error.message.includes('ETIMEDOUT')) {
      process.stderr.write(
        '\x1b[31merror: gateway startup timed out after 8 minutes.\x1b[0m\n' +
        'This usually means Docker is slow or the gateway image is downloading.\n' +
        'Check Docker status: docker ps\n' +
        'Check gateway logs: docker logs openshell-cluster-openshell\n',
      );
    } else {
      process.stderr.write(
        `\x1b[31merror: failed to start gateway: ${gatewayResult.error.message}\x1b[0m\n`,
      );
    }
    process.exit(1);
  }

  if (gatewayResult.status !== 0) {
    process.stderr.write(
      '\x1b[31merror: gateway failed to start (exit code ' + gatewayResult.status + ').\x1b[0m\n' +
      'Check gateway logs: docker logs openshell-cluster-openshell\n',
    );
    process.exit(1);
  }

  // Ensure TLS secrets exist (common issue on first run)
  process.stderr.write('\x1b[2mopeneral: ensuring TLS certificates...\x1b[0m\n');
  await ensureTlsSecrets();

  // Wait for openshell pod to be ready
  process.stderr.write('\x1b[2mopeneral: waiting for gateway pod to be ready...\x1b[0m\n');
  const podReady = await waitForOpenshellPod();

  // Verify gateway is actually running (optional check, pod readiness is more reliable)
  if (podReady) {
    const statusResult = spawnSync('openshell', ['gateway', 'status'], {
      stdio: 'pipe',
      timeout: 10000, // Increased timeout
    });

    if (statusResult.status !== 0) {
      // Gateway status check failed, but pod is ready - this is okay, continue
      process.stderr.write('\x1b[33mwarning: gateway status check failed, but pod is ready\x1b[0m\n');
    }
  }

  process.stderr.write('\x1b[32m✓ Gateway ready\x1b[0m\n');

  // Ensure sandbox image is available in k3s cluster
  await ensureSandboxImage(sandboxImage);

  // Ensure Claude is available in the sandbox
  await ensureClaudeInSandbox(workspaceId, sandboxImage);

  // Check if sandbox already exists and delete it
  await cleanupExistingSandbox(workspaceId);

  // Build `openshell sandbox create` arguments.
  // --name   maps to OPENSHELL_SANDBOX_ID inside the container, which
  //          setup.sh uses as the workspace ID.
  // --auto-providers  creates/resolves named providers automatically from
  //          the current environment (ANTHROPIC_API_KEY → claude,
  //          DATABASE_URL → db).
  const sandboxArgs: string[] = [
    'sandbox', 'create',
    '--name', workspaceId,
    '--from', sandboxImage,
    '--provider', 'claude',
  ];

  if (process.env.DATABASE_URL) {
    sandboxArgs.push('--provider', 'db');
  }

  sandboxArgs.push('--auto-providers');
  
  // Run setup commands inline instead of via script file to avoid permission issues
  // This replicates the functionality of /opt/openeral/setup.sh
  const setupCommands = `
set -eu
OPENERAL_DIR=/opt/openeral
export WORKSPACE_ID="\${OPENSHELL_SANDBOX_ID:-default}"
export OPENERAL_DATA_DIR="\${OPENERAL_DATA_DIR:-/home/agent/.openeral/data}"
mkdir -p "$OPENERAL_DATA_DIR"
export DATABASE_URL="\${DATABASE_URL:-\${OPENERAL_DATABASE_URL:-}}"

echo "setup: running migrations..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const { runMigrations } = await import('$OPENERAL_DIR/dist/db/migrations.js');
    const { pool } = await getDatabaseConnection();
    await runMigrations(pool);
    await pool.end();
    console.log('setup: migrations complete');
  }).catch(err => {
    console.error('setup: migration failed:', err.message);
    process.exit(1);
  });
"

echo "setup: seeding workspace $WORKSPACE_ID..."
node -e "
  import('$OPENERAL_DIR/dist/db/embedded.js').then(async ({ getDatabaseConnection }) => {
    const ws = await import('$OPENERAL_DIR/dist/db/workspace-queries.js');
    const { pool } = await getDatabaseConnection();

    try {
      await pool.query(
        \\"INSERT INTO _openeral.workspace_config (id, display_name, config) VALUES (\\\\$1, \\\\$2, '{}'::jsonb) ON CONFLICT (id) DO NOTHING\\",
        [process.env.WORKSPACE_ID, 'sandbox']
      );
    } catch {}

    await ws.seedFromConfig(pool, process.env.WORKSPACE_ID, {
      autoDirs: ['/', '/.claude', '/.claude/projects'],
      seedFiles: {},
    });

    await pool.end();
    console.log('setup: workspace seeded');
  }).catch(err => {
    console.error('setup: seed failed:', err.message);
    process.exit(1);
  });
"

OPENERAL_NPMRC=/tmp/openeral-npmrc
rm -f "$OPENERAL_NPMRC"
if [ -n "\${SOCKET_TOKEN:-}" ]; then
  echo "setup: configuring npm to use Socket.dev registry..."
  cat > "$OPENERAL_NPMRC" <<NPMRC
registry=https://registry.socket.dev/npm/
//registry.socket.dev/npm/:_authToken=\${SOCKET_TOKEN}
NPMRC
  export NPM_CONFIG_USERCONFIG="$OPENERAL_NPMRC"
fi

echo "setup: starting openeral-bash daemon..."
node "$OPENERAL_DIR/openeral-bash.mjs" --daemon &
DAEMON_PID=$!

for i in $(seq 1 30); do
  [ -S /tmp/openeral-bash.sock ] && break
  sleep 0.1
done

if [ ! -S /tmp/openeral-bash.sock ]; then
  echo "setup: daemon failed to start" >&2
  exit 1
fi

echo "setup: daemon ready (pid $DAEMON_PID)"
trap "kill $DAEMON_PID 2>/dev/null; rm -f /tmp/openeral-bash.sock" EXIT

echo "setup: launching Claude Code..."
exec env HOME=/home/agent SHELL=/usr/local/bin/openeral-bash claude ${claudeArgs.join(' ')}
`;

  sandboxArgs.push('--', 'sh', '-c', setupCommands);

  process.stderr.write(
    `\x1b[2mopeneral: launching Claude Code in OpenShell sandbox (${workspaceId})...\x1b[0m\n\n`,
  );

  const child = spawn('openshell', sandboxArgs, { stdio: 'inherit' });

  child.on('error', (err: NodeJS.ErrnoException) => {
    process.stderr.write(`\x1b[31merror: ${err.message}\x1b[0m\n`);
    process.exit(1);
  });

  child.on('exit', (code) => process.exit(code ?? 0));

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => child.kill(sig));
  }
}

export async function main() {
  const args = process.argv.slice(2);

  // Delegate optimize subcommand to its own CLI module
  if (args[0] === 'optimize') {
    const { fileURLToPath } = await import('node:url');
    const optimizeCliPath = fileURLToPath(new URL('./optimize/cli.js', import.meta.url));

    const child = spawn('node', [optimizeCliPath, ...args.slice(1)], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  const parsed = parseCliArgs(args);

  if (parsed.kind === 'help') {
    printHelp();
    return;
  }

  if (parsed.kind === 'memory-refresh') {
    process.stderr.write('\x1b[31mopeneral: memory refresh not yet implemented\x1b[0m\n');
    process.exit(1);
  }

  const { workspaceId, claudeArgs } = parsed;

  process.stderr.write(`\x1b[2mopeneral: workspace  ${workspaceId}\x1b[0m\n`);
  await launchViaSandbox(workspaceId, claudeArgs);
}
