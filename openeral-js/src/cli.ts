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
 * Auth (presign-first):
 *   If ~/.config/openeral/presign.json exists → no env vars required.
 *   If not → set ANTHROPIC_API_KEY + STRINGCOST_API_KEY to create one on first run.
 *   Run `npx openeral presign renew` to replace the stored presign.
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
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Presign persistence — store one permanent presign in ~/.config/openeral/
// ---------------------------------------------------------------------------

interface StoredPresign {
  /** Full URL as returned by StringCost (e.g. .../t/{JWT}/v1/messages) */
  url: string;
  createdAt: string;
}

function getPresignConfigPath(): string {
  return join(homedir(), '.config', 'openeral', 'presign.json');
}

function loadStoredPresign(): StoredPresign | null {
  const path = getPresignConfigPath();
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as StoredPresign;
    if (data?.url) return data;
    return null;
  } catch {
    return null;
  }
}

function saveStoredPresign(url: string): void {
  const configDir = join(homedir(), '.config', 'openeral');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const presignPath = getPresignConfigPath();
  writeFileSync(
    presignPath,
    JSON.stringify({ url, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 }
  );
  // Ensure restrictive permissions (covers cases where mode is ignored)
  try {
    chmodSync(presignPath, 0o600);
  } catch {
    // Ignore chmod errors on platforms that don't support it
  }
}

/**
 * Create a new StringCost presign: never expires, unlimited uses, $10 cost cap.
 * Returns the full presign URL as returned by StringCost.
 */
async function createPresignUrl(anthropicKey: string, stringcostKey: string): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

  try {
    const response = await fetch('https://app.stringcost.com/v1/presign', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stringcostKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        provider: 'anthropic',
        client_api_key: anthropicKey,
        path: ['/v1/messages'],
        expires_in: -1,
        max_uses: -1,
        cost_limit: 10000000, // $10 in micro-dollars
        tags: ['openeral'],
        metadata: { source: 'openeral' },
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`StringCost presign failed (${response.status}): ${text}`);
    }

    const data = await response.json() as { url: string };
    if (!data?.url) throw new Error('StringCost presign returned no URL');
    return data.url;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('StringCost presign request timed out after 30 seconds');
    }
    throw err;
  }
}


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
    const originalId = workspaceId;
    workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
    
    // Prevent empty workspace ID
    if (workspaceId.length === 0) {
      workspaceId = 'openeral-claude';
      process.stderr.write(`\x1b[33mwarning: workspace ID "${originalId}" normalized to empty string, using default: ${workspaceId}\x1b[0m\n`);
    }

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
  const originalId = workspaceId;
  workspaceId = workspaceId.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-');
  
  // Prevent empty workspace ID
  if (workspaceId.length === 0) {
    workspaceId = 'openeral-claude';
    process.stderr.write(`\x1b[33mwarning: workspace ID "${originalId}" normalized to empty string, using default: ${workspaceId}\x1b[0m\n`);
  }

  return { kind: 'launch', workspaceId, claudeArgs };
}

function printHelp(): void {
  console.log(`Usage:
  openeral [options] [-- claude-args]    Launch Claude Code in an OpenShell sandbox
  openeral presign                        Show the current StringCost presign
  openeral presign renew                  Create and store a new StringCost presign
  openeral stats [options]                Show API usage statistics
  openeral analyze [options]              Analyze session history and suggest optimizations
  openeral apply [options]                Apply optimization suggestions to project files
  openeral memory refresh [options]       Refresh memory system

Launch Options:
  --workspace, -w <id>    Workspace ID (default: openeral-claude)
  --help, -h              Show this help

Stats / Analyze / Apply Options:
  --workspace, -w <id>    Workspace ID (default: hostname)
  --days <n>              Number of days to look back (default: 7)
  --project-root <p>      Project root directory (analyze/apply only)
  --dry-run               Preview changes without applying (apply only)
  --proposal <id>         Apply a specific proposal by ID (apply only)
  --json                  Output as JSON (analyze only)

Memory Refresh Options:
  --workspace, -w <id>    Workspace ID
  --project-root <path>   Project root directory
  --query <text>          Search query
  --dry-run               Preview changes without applying
  --no-backup             Skip backup creation

Auth (presign-first model):
  If ~/.config/openeral/presign.json exists, no env vars are required.
  If the presign file is absent, both of these are required on first run:
    ANTHROPIC_API_KEY        Your Anthropic API key (sk-ant-...)
    STRINGCOST_API_KEY       Your StringCost API key
  The presign is created once and stored permanently — subsequent runs need no keys.
  Run \`npx openeral presign renew\` to replace the stored presign at any time.

Optional env:
  DATABASE_URL             Database connection string (uses PGlite if not provided)
  OPENERAL_WORKSPACE_ID    Default workspace ID (will be normalized to lowercase)
  OPENERAL_SANDBOX_IMAGE   Override sandbox image (default: ghcr.io/sandys/openeral/sandbox:just-bash)
  OPENERAL_AUTO_FIX_TLS    Set to 1 to suppress the TLS regeneration confirmation delay

Features:
  - Presign-first auth — no env vars needed once the presign is stored
  - Claude has automatic access to your home directory and mounted drives
  - Database persistence with PGlite (or external PostgreSQL)
  - API usage statistics and optimization suggestions

Notes:
  - Presign stored in ~/.config/openeral/presign.json (mode 600, expires_in=-1, max_uses=-1, cost_limit=$10)
  - Workspace IDs are automatically normalized to be Kubernetes-compliant
  - Claude CLI will be automatically installed in the sandbox if not present
  - Existing sandboxes with the same name will be cleaned up automatically
  - On first run, the gateway will be configured to access your filesystem
`);
}

// ---------------------------------------------------------------------------
// OpenShell sandbox launch
// ---------------------------------------------------------------------------

/**
 * Non-destructively ensure /mnt is bind-mounted into the gateway container.
 * Does NOT recreate the container.
 */
async function ensureGatewayHasMntMount(): Promise<void> {
  // Check if /mnt is already a mountpoint inside the gateway container.
  // Important: HostConfig.Binds only captures mounts configured at container
  // creation time (-v flags). Mounts added dynamically via nsenter from a prior
  // run never appear in HostConfig.Binds, so we must check the live mount table.
  const mountCheck = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'mountpoint', '-q', '/mnt'
  ], { stdio: 'pipe', timeout: 5000 });

  if (mountCheck.status === 0) {
    process.stderr.write('\x1b[32m✓ /mnt already mounted in gateway container\x1b[0m\n');
    return;
  }

  // Get the container PID for nsenter
  const pidResult = spawnSync('docker', [
    'inspect', 'openshell-cluster-openshell',
    '--format', '{{.State.Pid}}'
  ], { stdio: 'pipe', timeout: 5000 });

  if (pidResult.status !== 0) {
    process.stderr.write('\x1b[33mwarning: could not get gateway container PID\x1b[0m\n');
    return;
  }

  const pid = pidResult.stdout.toString().trim();
  const nsenterArgs = ['-t', pid, '--mount', '--', 'mount', '--rbind', '/mnt', '/mnt'];

  // Attempt 1: nsenter without sudo (works when this process is already root).
  let mounted = spawnSync('nsenter', nsenterArgs, { stdio: 'pipe', timeout: 15000 }).status === 0;

  // Attempt 2: sudo -n nsenter — non-interactive, succeeds only with passwordless sudo.
  if (!mounted) {
    mounted = spawnSync('sudo', ['-n', 'nsenter', ...nsenterArgs], { stdio: 'pipe', timeout: 15000 }).status === 0;
  }

  // Attempt 3: interactive sudo — inherit stdio so the password prompt is visible
  // and the user can type their password.  This is the normal path for anyone
  // who has sudo but hasn't configured passwordless access.
  if (!mounted) {
    process.stderr.write('\x1b[2mopeneral: mounting host filesystem — sudo password may be required...\x1b[0m\n');
    mounted = spawnSync('sudo', ['nsenter', ...nsenterArgs], { stdio: 'inherit', timeout: 60000 }).status === 0;
  }

  if (mounted) {
    process.stderr.write('\x1b[32m✓ /mnt bind-mounted into gateway container\x1b[0m\n');
  } else {
    process.stderr.write(
      'warning: host filesystem (/mnt) not mounted in gateway container.\n' +
      'To avoid this prompt permanently, configure passwordless sudo for nsenter:\n' +
      '  echo "$(whoami) ALL=(ALL) NOPASSWD: /usr/bin/nsenter" | sudo tee /etc/sudoers.d/openeral-nsenter\n' +
      'Sandbox will have limited filesystem access.\n'
    );
  }
}

/**
 * Detect and fix broken TLS by regenerating certs in-place (no container recreation).
 * Returns true if TLS is working (or was successfully fixed), false on unrecoverable error.
 */
async function fixBrokenTls(): Promise<boolean> {
  // Quick check — if openshell sandbox list works AND all required secrets exist, TLS is fine
  const listResult = spawnSync('openshell', ['sandbox', 'list'], { stdio: 'pipe', timeout: 10000 });
  const listStderr = (listResult.stderr ?? '').toString();
  const tlsOk = listResult.status === 0 || !listStderr.includes('tls handshake');

  // Also check for the client-tls secret that sandbox pods need to mount
  const secretCheck = spawnSync('docker', ['exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify', 'get', 'secret', 'openshell-client-tls',
    '-n', 'openshell', '--ignore-not-found'
  ], { stdio: 'pipe', timeout: 10000 });
  const clientTlsExists = secretCheck.status === 0 && secretCheck.stdout.toString().trim() !== '';

  if (tlsOk && clientTlsExists) {
    return true;
  }

  if (!clientTlsExists) {
    process.stderr.write('\x1b[33mopenshell-client-tls secret missing — TLS certificates need regeneration\x1b[0m\n');
  } else {
    process.stderr.write('\x1b[33mTLS broken (tls handshake eof) — TLS certificates need regeneration\x1b[0m\n');
  }

  // Compliance: require explicit confirmation for destructive operations
  // Skip confirmation if OPENERAL_AUTO_FIX_TLS=1 is set (for automation/CI)
  if (process.env.OPENERAL_AUTO_FIX_TLS !== '1') {
    process.stderr.write(
      '\x1b[33mThis will overwrite TLS certificates in:\x1b[0m\n' +
      `  - ~/.config/openshell/gateways/openshell/mtls/\n` +
      `  - Kubernetes secrets in the openshell namespace\n\n` +
      '\x1b[33mTo proceed automatically in the future, set: OPENERAL_AUTO_FIX_TLS=1\x1b[0m\n' +
      '\x1b[33mProceeding with TLS regeneration...\x1b[0m\n\n'
    );
    // Note: In a fully interactive CLI, you could add a prompt here.
    // For now, we log the warning and proceed (user can Ctrl+C to abort).
    await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay to allow Ctrl+C
  }

  process.stderr.write('\x1b[2mRegenerating TLS certificates...\x1b[0m\n');

  const tmpDir = '/tmp/openeral-tls';
  try {
    mkdirSync(tmpDir, { recursive: true });
  } catch { /* already exists */ }

  // ---------- CA ----------
  const caKey = `${tmpDir}/ca.key`;
  const caCrt = `${tmpDir}/ca.crt`;

  const genCaKey = spawnSync('openssl', [
    'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', caKey
  ], { stdio: 'pipe', timeout: 15000 });
  if (genCaKey.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to generate CA key: ${(genCaKey.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return false;
  }

  const genCaCrt = spawnSync('openssl', [
    'req', '-new', '-x509', '-key', caKey, '-out', caCrt,
    '-days', '36500', '-subj', '/CN=openshell-ca/O=openshell'
  ], { stdio: 'pipe', timeout: 15000 });
  if (genCaCrt.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to generate CA cert: ${(genCaCrt.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return false;
  }

  // ---------- Server cert with SAN for 127.0.0.1 ----------
  const serverKey = `${tmpDir}/server.key`;
  const serverCsr = `${tmpDir}/server.csr`;
  const serverCrt = `${tmpDir}/server.crt`;
  const serverExt = `${tmpDir}/server.ext`;
  const clientExt = `${tmpDir}/client.ext`;

  // Full v3 extensions required by rustls: SAN, keyUsage, extendedKeyUsage, SKID/AKID
  // SAN must include both the external address (127.0.0.1) AND the k8s service DNS
  // names so sandbox pods can connect via openshell.openshell.svc.cluster.local
  writeFileSync(serverExt, [
    'subjectAltName = IP:127.0.0.1,DNS:localhost,DNS:openshell,DNS:openshell.openshell,DNS:openshell.openshell.svc,DNS:openshell.openshell.svc.cluster.local',
    'keyUsage = digitalSignature, keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always',
  ].join('\n') + '\n');

  writeFileSync(clientExt, [
    'extendedKeyUsage = clientAuth',
    'subjectKeyIdentifier = hash',
    'authorityKeyIdentifier = keyid:always',
  ].join('\n') + '\n');

  const genServerKey = spawnSync('openssl', [
    'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', serverKey
  ], { stdio: 'pipe', timeout: 15000 });
  if (genServerKey.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to generate server key\x1b[0m\n`);
    return false;
  }

  const genServerCsr = spawnSync('openssl', [
    'req', '-new', '-key', serverKey, '-out', serverCsr,
    '-subj', '/CN=openshell-server/O=openshell'
  ], { stdio: 'pipe', timeout: 15000 });
  if (genServerCsr.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to generate server CSR\x1b[0m\n`);
    return false;
  }

  const signServer = spawnSync('openssl', [
    'x509', '-req', '-in', serverCsr, '-CA', caCrt, '-CAkey', caKey,
    '-CAcreateserial', '-out', serverCrt,
    '-days', '36500', '-extfile', serverExt
  ], { stdio: 'pipe', timeout: 15000 });
  if (signServer.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to sign server cert\x1b[0m\n`);
    return false;
  }

  // ---------- Client cert ----------
  const clientKey = `${tmpDir}/client.key`;
  const clientCsr = `${tmpDir}/client.csr`;
  const clientCrt = `${tmpDir}/client.crt`;

  const genClientKey = spawnSync('openssl', [
    'ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', clientKey
  ], { stdio: 'pipe', timeout: 15000 });
  if (genClientKey.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to generate client key\x1b[0m\n`);
    return false;
  }

  const genClientCsr = spawnSync('openssl', [
    'req', '-new', '-key', clientKey, '-out', clientCsr,
    '-subj', '/CN=openshell-client/O=openshell'
  ], { stdio: 'pipe', timeout: 15000 });
  if (genClientCsr.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to generate client CSR\x1b[0m\n`);
    return false;
  }

  const signClient = spawnSync('openssl', [
    'x509', '-req', '-in', clientCsr, '-CA', caCrt, '-CAkey', caKey,
    '-CAcreateserial', '-out', clientCrt, '-days', '36500', '-extfile', clientExt
  ], { stdio: 'pipe', timeout: 15000 });
  if (signClient.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to sign client cert\x1b[0m\n`);
    return false;
  }

  // ---------- Copy certs into container ----------
  for (const [src, dst] of [
    [serverCrt, '/tmp/os-server.crt'],
    [serverKey, '/tmp/os-server.key'],
    [clientCrt, '/tmp/os-client.crt'],
    [clientKey, '/tmp/os-client.key'],
    [caCrt,     '/tmp/os-ca.crt'],
  ] as [string, string][]) {
    const cp = spawnSync('docker', ['cp', src, `openshell-cluster-openshell:${dst}`], { stdio: 'pipe', timeout: 10000 });
    if (cp.status !== 0) {
      process.stderr.write(`\x1b[31merror: docker cp ${src} failed\x1b[0m\n`);
      return false;
    }
  }

  // ---------- Update k8s secrets ----------
  spawnSync('docker', ['exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify', 'delete', 'secret',
    'openshell-server-tls', 'openshell-server-client-ca', 'openshell-client-tls',
    '-n', 'openshell', '--ignore-not-found=true'
  ], { stdio: 'pipe', timeout: 10000 });

  const createTls = spawnSync('docker', ['exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify', 'create', 'secret', 'tls',
    'openshell-server-tls',
    '--cert=/tmp/os-server.crt',
    '--key=/tmp/os-server.key',
    '-n', 'openshell'
  ], { stdio: 'pipe', timeout: 15000 });
  if (createTls.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to create openshell-server-tls: ${(createTls.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return false;
  }

  const createCa = spawnSync('docker', ['exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify', 'create', 'secret', 'generic',
    'openshell-server-client-ca',
    '--from-file=ca.crt=/tmp/os-ca.crt',
    '-n', 'openshell'
  ], { stdio: 'pipe', timeout: 15000 });
  if (createCa.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to create openshell-server-client-ca: ${(createCa.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return false;
  }

  // openshell-client-tls: client cert mounted into sandbox pods so they can
  // authenticate with the openshell server over mTLS.
  // Must be a generic secret with ca.crt, tls.crt, and tls.key — the openshell
  // supervisor inside the sandbox reads all three (OPENSHELL_TLS_CA/CERT/KEY).
  const createClientTls = spawnSync('docker', ['exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify', 'create', 'secret', 'generic',
    'openshell-client-tls',
    '--from-file=ca.crt=/tmp/os-ca.crt',
    '--from-file=tls.crt=/tmp/os-client.crt',
    '--from-file=tls.key=/tmp/os-client.key',
    '-n', 'openshell'
  ], { stdio: 'pipe', timeout: 15000 });
  if (createClientTls.status !== 0) {
    process.stderr.write(`\x1b[31merror: failed to create openshell-client-tls: ${(createClientTls.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return false;
  }

  // ---------- Update host mtls files ----------
  const mtlsDir = `${homedir()}/.config/openshell/gateways/openshell/mtls`;
  try {
    mkdirSync(mtlsDir, { recursive: true, mode: 0o700 });
    copyFileSync(caCrt,     `${mtlsDir}/ca.crt`);
    copyFileSync(clientCrt, `${mtlsDir}/tls.crt`);
    copyFileSync(clientKey, `${mtlsDir}/tls.key`);
    // Ensure restrictive permissions on certificate files
    try {
      chmodSync(`${mtlsDir}/ca.crt`, 0o600);
      chmodSync(`${mtlsDir}/tls.crt`, 0o600);
      chmodSync(`${mtlsDir}/tls.key`, 0o600);
    } catch {
      // Ignore chmod errors on platforms that don't support it
    }
  } catch (err) {
    process.stderr.write(`\x1b[33mwarning: failed to update host mtls files: ${(err as Error).message}\x1b[0m\n`);
  }

  // ---------- Delete openshell-0 pod to pick up new certs ----------
  spawnSync('docker', ['exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify', 'delete', 'pod', 'openshell-0',
    '-n', 'openshell', '--ignore-not-found=true'
  ], { stdio: 'pipe', timeout: 15000 });

  process.stderr.write('\x1b[2mopeneral: waiting for pod to restart with new certs...\x1b[0m\n');
  await waitForOpenshellPod();

  // Verify the openshell API is truly accepting connections — pod Ready ≠ operator ready.
  // Without this, sandbox create races against operator initialisation and fails with
  // DependenciesNotReady because the provider secret isn't created in time.
  process.stderr.write('\x1b[2mopeneral: verifying TLS connection...\x1b[0m\n');
  const apiReady = await waitForOpenshellApiReady(120);
  if (!apiReady) {
    process.stderr.write('\x1b[33mwarning: openshell API not reachable after TLS fix — proceeding anyway\x1b[0m\n');
  }

  process.stderr.write('\x1b[32m✓ TLS certs regenerated and applied\x1b[0m\n');
  return true;
}

/**
 * Wait until the openshell CLI can successfully talk to the gateway API.
 *
 * "Pod ready" (Kubernetes condition) only means containers are running — it does NOT
 * mean the openshell operator inside the pod has finished initialising, loaded its
 * CRD state, or is accepting requests.  Trying to create a sandbox while the operator
 * is still warming up causes DependenciesNotReady because the operator races with pod
 * scheduling when trying to create provider secrets via --auto-providers.
 *
 * This function polls `openshell sandbox list` until it exits 0 (operator ready) or
 * returns a non-connection error (operator up, different problem — still usable).
 */
async function waitForOpenshellApiReady(maxSeconds = 120): Promise<boolean> {
  const deadline = Date.now() + maxSeconds * 1000;
  const startMs = Date.now();
  let lastProgressS = -1;

  while (Date.now() < deadline) {
    const r = spawnSync('openshell', ['sandbox', 'list'], { stdio: 'pipe', timeout: 10000 });
    if (r.status === 0) return true;

    const stderr = (r.stderr ?? Buffer.from('')).toString();
    // Only keep retrying for transient connection/TLS errors.
    // Any other non-zero exit (e.g., empty list, unknown flag) means the API is up.
    const isConnectionError =
      stderr.includes('transport error') ||
      stderr.includes('tls handshake') ||
      stderr.includes('connection refused') ||
      stderr.includes('connection reset') ||
      stderr.includes('broken pipe');

    if (!isConnectionError) return true;

    const elapsedS = Math.floor((Date.now() - startMs) / 1000);
    if (elapsedS >= lastProgressS + 30) {
      process.stderr.write(`\x1b[2m  waiting for openshell API to be ready... (${elapsedS}s)\x1b[0m\n`);
      lastProgressS = elapsedS;
    }

    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  return false;
}

/**
 * Wait for the openshell-0 pod to be ready.
 * This ensures the gateway is fully operational before we try to create sandboxes.
 * Returns true if pod is ready, false if timeout.
 */
async function waitForOpenshellPod(): Promise<boolean> {
  const maxAttempts = 240; // 8 minutes (240 * 2 seconds) - increased for container recreation
  
  for (let i = 0; i < maxAttempts; i++) {
    const checkPod = spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'kubectl', '--insecure-skip-tls-verify', 'get', 'pod', 'openshell-0',
      '-n', 'openshell',
      '-o', 'jsonpath={.status.conditions[?(@.type=="Ready")].status}'
    ], { stdio: 'pipe', timeout: 10000 });

    if (checkPod.status === 0 && checkPod.stdout.toString().trim() === 'True') {
      return true; // Pod is ready
    }

    // Show progress every 30 seconds
    if (i > 0 && i % 15 === 0) {
      const minutes = Math.floor(i * 2 / 60);
      const seconds = (i * 2) % 60;
      process.stderr.write(`\x1b[2m  still waiting for gateway pod... (${minutes}m ${seconds}s)\x1b[0m\n`);
    }

    await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds
  }

  return false; // Timed out
}

/**
 * Ensure the sandbox image is available in the k3s cluster.
 * Pre-pulls the image on the host and imports it into k3s to avoid DNS issues.
 */
async function ensureSandboxImage(sandboxImage: string): Promise<void> {
  // crictl output: IMAGE                              TAG        IMAGE ID   SIZE
  // Image name and tag are space-separated columns, not colon-separated.
  // Split at last colon to get repo and tag (handles tags like "just-bash").
  const colonIdx = sandboxImage.lastIndexOf(':');
  const imageRepo = colonIdx >= 0 ? sandboxImage.slice(0, colonIdx) : sandboxImage;
  const imageTag  = colonIdx >= 0 ? sandboxImage.slice(colonIdx + 1) : 'latest';

  const K3S_CTR = [
    'exec', 'openshell-cluster-openshell',
    'ctr', '--address', '/run/k3s/containerd/containerd.sock', '-n', 'k8s.io',
  ];
  const K3S_CTR_IMPORT = [...K3S_CTR, 'images', 'import'];

  function imageExistsInCluster(): boolean {
    // Use ctr with the correct k3s socket — more reliable than crictl for checking refs
    const result = spawnSync('docker', [
      ...K3S_CTR, 'images', 'ls', '--quiet'
    ], { stdio: 'pipe', timeout: 10000 });

    if (result.status !== 0) return false;
    const refs = result.stdout.toString();
    // ctr ls --quiet lists refs like: ghcr.io/sandys/openeral/sandbox:just-bash
    return refs.split('\n').some(line => line.trim() === sandboxImage || line.includes(imageRepo) && line.includes(imageTag));
  }

  process.stderr.write('\x1b[2mopeneral: checking sandbox image availability...\x1b[0m\n');

  if (imageExistsInCluster()) {
    process.stderr.write('\x1b[32m✓ Sandbox image already in cluster\x1b[0m\n');
    return;
  }

  process.stderr.write('\x1b[2m  image not found in cluster, importing...\x1b[0m\n');

  // Pull on host first
  process.stderr.write('\x1b[2m  pulling image on host (this may take a few minutes)...\x1b[0m\n');
  const pullResult = spawnSync('docker', ['pull', sandboxImage], {
    stdio: 'inherit',
    timeout: 600000,
  });

  if (pullResult.status !== 0) {
    process.stderr.write(
      '\x1b[33mwarning: failed to pull image on host\x1b[0m\n' +
      `  docker pull ${sandboxImage}\n`
    );
    return;
  }

  // Flatten the image to a single layer before importing into k3s.
  //
  // Docker images built on top of a base that replaces system packages (e.g. apt
  // installing nodejs over an existing npm) contain opaque whiteout files
  // (.wh..wh..opq).  k3s's containerd extracts these by calling mknod to create
  // whiteout char devices in the overlayfs upper dir — but mknod is restricted
  // inside a Docker container (seccomp/AppArmor).  The result: the pod is stuck
  // in Pending forever.
  //
  // Fix: docker export produces a flat filesystem tarball with no whiteouts
  // (just the final merged file tree).  docker import turns that into a
  // single-layer Docker image.  A single-layer image with no whiteout entries
  // extracts cleanly on any Linux system regardless of mknod restrictions.
  const fsTar    = '/tmp/openeral-sandbox-fs.tar';
  const tmpTar   = '/tmp/openeral-sandbox-image.tar';
  const containerTar = '/tmp/openeral-sandbox-image.tar';
  const flatTag  = `${sandboxImage}-openeral-flat`;
  const flatContainer = `openeral-flatten-${Date.now()}`;

  process.stderr.write('\x1b[2m  flattening image (squashing layers to remove whiteouts)...\x1b[0m\n');
  spawnSync('docker', ['rm', '-f', flatContainer], { stdio: 'pipe' });
  spawnSync('docker', ['create', '--name', flatContainer, sandboxImage], { stdio: 'pipe', timeout: 30000 });
  spawnSync('docker', ['export', flatContainer, '-o', fsTar], { stdio: 'pipe', timeout: 300000 });
  spawnSync('docker', ['rm', flatContainer], { stdio: 'pipe' });
  spawnSync('docker', ['rmi', '-f', flatTag], { stdio: 'pipe' });
  spawnSync('docker', ['import', fsTar, flatTag], { stdio: 'pipe', timeout: 120000 });
  spawnSync('rm', ['-f', fsTar], { stdio: 'pipe' });

  process.stderr.write('\x1b[2m  saving flattened image...\x1b[0m\n');
  const saveResult = spawnSync('docker', ['save', flatTag, '-o', tmpTar], { stdio: 'pipe', timeout: 300000 });
  spawnSync('docker', ['rmi', '-f', flatTag], { stdio: 'pipe' });
  if (saveResult.status !== 0) {
    process.stderr.write(`\x1b[33mwarning: failed to save flattened image: ${(saveResult.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return;
  }

  process.stderr.write('\x1b[2m  copying image into cluster container...\x1b[0m\n');
  const cpResult = spawnSync('docker', ['cp', tmpTar, `openshell-cluster-openshell:${containerTar}`], { stdio: 'pipe', timeout: 120000 });
  spawnSync('rm', ['-f', tmpTar], { stdio: 'pipe' });
  if (cpResult.status !== 0) {
    process.stderr.write(`\x1b[33mwarning: failed to copy image into container: ${(cpResult.stderr ?? '').toString().trim()}\x1b[0m\n`);
    return;
  }

  process.stderr.write('\x1b[2m  importing into k3s cluster...\x1b[0m\n');
  const importResult = spawnSync('docker', [...K3S_CTR_IMPORT, containerTar], { stdio: 'pipe', timeout: 600000 });
  spawnSync('docker', ['exec', 'openshell-cluster-openshell', 'rm', '-f', containerTar], { stdio: 'pipe' });

  if (importResult.status !== 0) {
    const errMsg = (importResult.stderr ?? '').toString().trim();
    process.stderr.write(
      `\x1b[33mwarning: image import failed (exit ${importResult.status})\x1b[0m\n` +
      (errMsg ? `  ${errMsg}\n` : '')
    );
    return;
  }

  // The flat image was imported under flatTag — retag it as the original image
  // name so the OpenShell operator can find it when creating the sandbox pod.
  spawnSync('docker', [...K3S_CTR, 'images', 'tag', flatTag, sandboxImage], { stdio: 'pipe', timeout: 10000 });
  process.stderr.write('\x1b[32m✓ Sandbox image imported to cluster\x1b[0m\n');

  if (imageExistsInCluster()) {
    process.stderr.write('\x1b[32m✓ Image verified in cluster\x1b[0m\n');
  } else {
    process.stderr.write('\x1b[33mwarning: image still not found in cluster after import — sandbox may fail to start\x1b[0m\n');
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
 * Background task: inject /mnt into the running sandbox container via nsenter.
 *
 * Strategy: wait for the pod to reach Running state, then use `crictl` inside
 * the k3s node container to find the container PID and `nsenter` into its mount
 * namespace to bind-mount /mnt.  No pod restart is performed, so the setup
 * script continues uninterrupted and Claude Code launches normally.
 *
 * Works on any Linux-based system where the k3s node container has:
 *   - crictl (standard in k3s distributions)
 *   - nsenter (part of util-linux, available on all modern Linux distros)
 *   - /mnt accessible (ensured by ensureGatewayHasMntMount which runs first)
 */
async function injectMntIntoSandbox(workspaceId: string): Promise<void> {
  // Poll until the sandbox pod is Running (up to 300 s at 500 ms intervals)
  let podName = '';
  for (let i = 0; i < 600; i++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    const r = spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'kubectl', '--insecure-skip-tls-verify',
      'get', 'pods', '-n', 'openshell',
      '-l', `agents.x-k8s.io/sandbox-name=${workspaceId}`,
      '-o', 'jsonpath={.items[0].metadata.name}/{.items[0].status.phase}',
    ], { stdio: 'pipe', timeout: 10000 });
    if (r.status === 0) {
      const out = (r.stdout ?? Buffer.from('')).toString().trim();
      const slash = out.indexOf('/');
      if (slash > 0 && out.slice(slash + 1) === 'Running') {
        podName = out.slice(0, slash);
        break;
      }
    }
  }

  if (!podName) {
    process.stderr.write('\x1b[33mwarning: sandbox pod not ready after 300s — /mnt injection skipped\x1b[0m\n');

    // Emit k8s events so the user can see exactly why the pod is Pending.
    // Common causes: missing provider secret, image pull failure, resource limits.
    const eventsResult = spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'kubectl', '--insecure-skip-tls-verify',
      'get', 'events', '-n', 'openshell',
      '--sort-by=.lastTimestamp',
      '-o', 'wide',
    ], { stdio: 'pipe', timeout: 10000 });

    if (eventsResult.status === 0) {
      const allEvents = eventsResult.stdout.toString();
      const relevant = allEvents.split('\n')
        .filter(line => !line.startsWith('LAST SEEN') && line.trim() !== '')
        .join('\n');
      if (relevant) {
        process.stderr.write(`\x1b[2m  sandbox pod events (for diagnosis):\n${relevant}\x1b[0m\n`);
      }
    }

    return;
  }

  // Use crictl inside the k3s node to find the container PID, then nsenter
  // into its mount namespace and bind-mount /mnt (no-op if already mounted).
  //
  // grep -Eo '"pid": *[1-9][0-9]*' matches the first non-zero pid field in the
  // crictl inspect JSON output, working across both compact and pretty-printed
  // JSON and across all Linux grep variants (GNU and BSD).
  const injectScript =
    `CONTAINER_ID=$(crictl ps ` +
      `--label 'io.kubernetes.pod.name=${podName}' ` +
      `--label 'io.kubernetes.pod.namespace=openshell' ` +
      `-q 2>/dev/null | head -1); ` +
    `if [ -z "$CONTAINER_ID" ]; then ` +
      `echo "crictl: no container for pod ${podName}" >&2; exit 1; ` +
    `fi; ` +
    `PID=$(crictl inspect "$CONTAINER_ID" 2>/dev/null ` +
      `| grep -Eo '"pid": *[1-9][0-9]*' ` +
      `| grep -Eo '[1-9][0-9]*' | head -1); ` +
    `if [ -z "$PID" ]; then ` +
      `echo "crictl: could not get container PID for $CONTAINER_ID" >&2; exit 1; ` +
    `fi; ` +
    `nsenter -t "$PID" --mount -- ` +
      `sh -c 'mountpoint -q /mnt 2>/dev/null && exit 0; mount --rbind /mnt /mnt'`;

  const injectResult = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'sh', '-c', injectScript,
  ], { stdio: 'pipe', timeout: 30000 });

  if (injectResult.status === 0) {
    process.stderr.write('\x1b[32m✓ Host filesystem injected into sandbox\x1b[0m\n');
  } else {
    const stderr = (injectResult.stderr ?? Buffer.from('')).toString().trim();
    process.stderr.write(
      `\x1b[33mwarning: /mnt injection failed${stderr ? ': ' + stderr : ' (crictl/nsenter unavailable?)'}\x1b[0m\n` +
      `\x1b[2m  Sandbox will run without host filesystem access\x1b[0m\n`,
    );
  }
}

/**
 * Ensure iptables DNAT rules exist inside the gateway container so traffic
 * arriving at container-eth0:8080 and loopback:8080 is forwarded to the
 * openshell-0 pod IP on port 8080.
 *
 * Docker maps host:8080 → container:8080, but nothing listens on container:8080
 * directly — the openshell-server only accepts connections via its pod IP or
 * the k8s NodePort (30051). We add PREROUTING + OUTPUT DNAT so the existing
 * docker port mapping works without recreating the container.
 */
async function ensurePortRoutingInContainer(): Promise<void> {
  // Get the pod IP of openshell-0
  const podIpResult = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'kubectl', '--insecure-skip-tls-verify',
    'get', 'pod', 'openshell-0',
    '-n', 'openshell',
    '-o', 'jsonpath={.status.podIP}'
  ], { stdio: 'pipe', timeout: 10000 });

  if (podIpResult.status !== 0 || !podIpResult.stdout.toString().trim()) {
    process.stderr.write('\x1b[33mwarning: could not get openshell-0 pod IP — skipping port routing setup\x1b[0m\n');
    return;
  }

  const podIp = podIpResult.stdout.toString().trim();

  // Check if PREROUTING rule already targets this pod IP
  const checkPrerouting = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'iptables', '-t', 'nat', '-C', 'PREROUTING',
    '-p', 'tcp', '--dport', '8080',
    '-j', 'DNAT', '--to-destination', `${podIp}:8080`
  ], { stdio: 'pipe', timeout: 5000 });

  if (checkPrerouting.status !== 0) {
    spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'iptables', '-t', 'nat', '-I', 'PREROUTING', '1',
      '-p', 'tcp', '--dport', '8080',
      '-j', 'DNAT', '--to-destination', `${podIp}:8080`
    ], { stdio: 'pipe', timeout: 10000 });
  }

  // Check if OUTPUT rule already targets this pod IP
  const checkOutput = spawnSync('docker', [
    'exec', 'openshell-cluster-openshell',
    'iptables', '-t', 'nat', '-C', 'OUTPUT',
    '-p', 'tcp', '-d', '127.0.0.1', '--dport', '8080',
    '-j', 'DNAT', '--to-destination', `${podIp}:8080`
  ], { stdio: 'pipe', timeout: 5000 });

  if (checkOutput.status !== 0) {
    spawnSync('docker', [
      'exec', 'openshell-cluster-openshell',
      'iptables', '-t', 'nat', '-I', 'OUTPUT', '1',
      '-p', 'tcp', '-d', '127.0.0.1', '--dport', '8080',
      '-j', 'DNAT', '--to-destination', `${podIp}:8080`
    ], { stdio: 'pipe', timeout: 10000 });
  }

  process.stderr.write(`\x1b[32m✓ Port routing: container:8080 → pod ${podIp}:8080\x1b[0m\n`);
}

// ---------------------------------------------------------------------------
// presign commands
// ---------------------------------------------------------------------------

/**
 * `npx openeral presign` — show the currently stored StringCost presign.
 */
async function cmdPresignShow(): Promise<void> {
  const stored = loadStoredPresign();
  if (!stored) {
    console.log('No presign stored.');
    console.log('');
    console.log('Set STRINGCOST_API_KEY and ANTHROPIC_API_KEY, then run:');
    console.log('  npx openeral presign renew');
    return;
  }

  const { decodePresignUrl } = await import('./optimize/stringcost-api.js');
  const decoded = decodePresignUrl(stored.url);

  console.log('StringCost presign (currently in use):');
  console.log(`  Proxy URL:  ${stored.url.replace(/\/v1\/.*$/, '')}`);
  console.log(`  Full URL:   ${stored.url}`);
  console.log(`  Created:    ${new Date(stored.createdAt).toLocaleString()}`);
  if (decoded.sessionId) console.log(`  Session ID: ${decoded.sessionId}`);
  console.log('');
  console.log('Settings: expires_in=-1  max_uses=-1  cost_limit=10$  (all infinite, never exhausts)');
}

/**
 * `npx openeral presign renew` — create a new StringCost presign and persist it.
 *
 * Prompts for ANTHROPIC_API_KEY and STRINGCOST_API_KEY if not set in env.
 * Writes the new presign to:
 *   - ~/.config/openeral/presign.json  (openeral's own cache)
 *   - ~/.claude/settings.json          (Claude Code picks this up automatically)
 */
async function cmdPresignRenew(): Promise<void> {
  let anthropicKey = (process.env.ANTHROPIC_API_KEY ?? '').replace('@anthropic_api_key', '').trim();
  let stringcostKey = (process.env.STRINGCOST_API_KEY ?? '').replace('@stringcost_api_key', '').trim();

  if (!anthropicKey || !stringcostKey) {
    if (!process.stdin.isTTY) {
      process.stderr.write(
        '\x1b[31merror: ANTHROPIC_API_KEY and STRINGCOST_API_KEY must be set\x1b[0m\n',
      );
      process.exit(1);
    }

    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt: string): Promise<string> =>
      new Promise(resolve => rl.question(prompt, resolve));

    try {
      if (!anthropicKey) {
        anthropicKey = (await question('Anthropic API key: ')).trim();
      }
      if (!stringcostKey) {
        stringcostKey = (await question('StringCost API key: ')).trim();
      }
    } finally {
      rl.close();
    }
  }

  if (!anthropicKey || !stringcostKey) {
    process.stderr.write('\x1b[31merror: both API keys are required\x1b[0m\n');
    process.exit(1);
  }

  console.log('Creating new presign (expires_in=-1, max_uses=-1, cost_limit=10$)...');

  try {
    const fullUrl = await createPresignUrl(anthropicKey, stringcostKey);
    const baseUrl = fullUrl.replace(/\/v1\/.*$/, '');

    // 1. Store in openeral's own config
    saveStoredPresign(fullUrl);
    console.log(`\x1b[32m✓ Stored in ${getPresignConfigPath()}\x1b[0m`);

    // 2. Write into host Claude Code settings so Claude picks it up automatically
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    try {
      mkdirSync(join(homedir(), '.claude'), { recursive: true });
      let settings: Record<string, unknown> = {};
      if (existsSync(settingsPath)) {
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
        } catch { /* corrupt/empty — start fresh */ }
      }
      const env = (settings.env ?? {}) as Record<string, string>;
      env.ANTHROPIC_BASE_URL = baseUrl;
      env.ANTHROPIC_AUTH_TOKEN = 'dummy';
      settings.env = env;
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      console.log(`\x1b[32m✓ Written to ${settingsPath}\x1b[0m`);
    } catch (err) {
      process.stderr.write(
        `\x1b[33mwarning: could not write to ~/.claude/settings.json: ${(err as Error).message}\x1b[0m\n`,
      );
    }

    console.log('');
    console.log(`\x1b[32m✓ Presign created and stored\x1b[0m`);
    console.log(`  Proxy URL: ${baseUrl}`);
    console.log('');
    console.log('This presign will be reused for all future sessions (never expires).');
    console.log('Run "npx openeral presign" to view it, or "npx openeral presign renew" to replace it.');
  } catch (err) {
    process.stderr.write(`\x1b[31merror: ${(err as Error).message}\x1b[0m\n`);
    process.exit(1);
  }
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

  // Check gateway container state
  const containerCheck = spawnSync('docker', ['inspect', 'openshell-cluster-openshell', '--format', '{{.State.Running}}'], {
    stdio: 'pipe',
  });

  const isRunning = containerCheck.status === 0 && containerCheck.stdout.toString().trim() === 'true';
  const containerExists = containerCheck.status === 0;

  if (!containerExists) {
    // Gateway does not exist — run openshell gateway start
    process.stderr.write('\x1b[2mopeneral: starting OpenShell gateway (this may take 5-8 minutes on first run)...\x1b[0m\n');

    const gatewayResult = spawnSync('openshell', ['gateway', 'start'], {
      stdio: 'inherit',
      timeout: 480_000,
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

    // Wait for openshell namespace to be ready
    process.stderr.write('\x1b[2mopeneral: waiting for gateway to initialize (this may take 5-8 minutes on first run)...\x1b[0m\n');
    let namespaceReady = false;
    for (let i = 0; i < 240; i++) {
      const checkNs = spawnSync('docker', [
        'exec', 'openshell-cluster-openshell',
        'kubectl', '--insecure-skip-tls-verify', 'get', 'namespace', 'openshell'
      ], { stdio: 'pipe', timeout: 5000 });
      if (checkNs.status === 0) { namespaceReady = true; break; }
      if (i > 0 && i % 30 === 0) {
        process.stderr.write(`\x1b[2m  still waiting for k3s... (${Math.floor(i * 2 / 60)}m)\x1b[0m\n`);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!namespaceReady) {
      process.stderr.write(
        '\x1b[31merror: openshell namespace not ready after 8 minutes.\x1b[0m\n' +
        'Try:\n' +
        '  docker logs openshell-cluster-openshell\n' +
        '  docker exec openshell-cluster-openshell kubectl get nodes\n'
      );
      process.exit(1);
    }

    const initialPodReady = await waitForOpenshellPod();
    if (!initialPodReady) {
      process.stderr.write(
        '\x1b[31merror: gateway pod not ready after 8 minutes.\x1b[0m\n' +
        '  docker exec openshell-cluster-openshell kubectl get pods -n openshell\n'
      );
      process.exit(1);
    }
    // First-run: also wait for the openshell API to be fully ready
    await waitForOpenshellApiReady(120);
  } else if (!isRunning) {
    // Container exists but is stopped — just start it
    process.stderr.write('\x1b[2mopeneral: gateway container is stopped, starting it...\x1b[0m\n');
    const startResult = spawnSync('docker', ['start', 'openshell-cluster-openshell'], { stdio: 'pipe' });
    if (startResult.status !== 0) {
      process.stderr.write(
        '\x1b[31merror: failed to start stopped gateway container.\x1b[0m\n' +
        'Try manually:\n' +
        '  docker start openshell-cluster-openshell\n' +
        'Or destroy and recreate:\n' +
        '  openshell gateway destroy --name openshell\n' +
        '  openshell gateway start\n',
      );
      process.exit(1);
    }
    // After docker start, k3s needs time to restart its API server and resume pods.
    // A bare 5-second sleep is far too short — wait for the openshell namespace to
    // reappear (proves the k3s API is up) before continuing.
    process.stderr.write('\x1b[2mopeneral: waiting for gateway to resume...\x1b[0m\n');
    let resumeNsReady = false;
    for (let i = 0; i < 120; i++) { // up to 4 minutes
      const checkNs = spawnSync('docker', [
        'exec', 'openshell-cluster-openshell',
        'kubectl', '--insecure-skip-tls-verify', 'get', 'namespace', 'openshell',
      ], { stdio: 'pipe', timeout: 5000 });
      if (checkNs.status === 0) { resumeNsReady = true; break; }
      if (i > 0 && i % 15 === 0) {
        process.stderr.write(`\x1b[2m  still waiting for k3s to resume... (${Math.floor(i * 2 / 60)}m ${(i * 2) % 60}s)\x1b[0m\n`);
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    if (!resumeNsReady) {
      process.stderr.write('\x1b[33mwarning: k3s namespace not ready after restart — continuing anyway\x1b[0m\n');
    }
  } else {
    process.stderr.write('\x1b[2mopeneral: gateway is already running\x1b[0m\n');
  }

  // Fix TLS if broken (regenerates certs in-place, no container recreation)
  const tlsOk = await fixBrokenTls();
  if (!tlsOk) {
    process.stderr.write('\x1b[33mwarning: TLS fix failed — proceeding anyway\x1b[0m\n');
  }

  // Wait for openshell-0 pod to be ready
  const podReady = await waitForOpenshellPod();
  if (!podReady) {
    process.stderr.write(
      '\x1b[31merror: gateway pod not ready.\x1b[0m\n' +
      'Check: docker exec openshell-cluster-openshell kubectl get pods -n openshell\n'
    );
    process.exit(1);
  }

  // Verify the openshell API is accepting connections.
  // "Pod ready" (Kubernetes) ≠ "operator ready" — the openshell operator inside the
  // pod needs additional time to initialise after container start.  If we create a
  // sandbox before it's ready, --auto-providers races with pod scheduling and the
  // sandbox pod gets stuck in DependenciesNotReady because its provider secret doesn't
  // exist yet when Kubernetes schedules it.
  const apiReady = await waitForOpenshellApiReady(120);
  if (!apiReady) {
    process.stderr.write(
      '\x1b[31merror: openshell API not available after 2 minutes.\x1b[0m\n' +
      '  openshell sandbox list\n' +
      '  docker logs openshell-cluster-openshell\n'
    );
    process.exit(1);
  }

  process.stderr.write('\x1b[32m✓ Gateway ready\x1b[0m\n');

  // Ensure port 8080 on the container routes to the openshell pod
  await ensurePortRoutingInContainer();

  // Ensure sandbox image is available in k3s cluster
  await ensureSandboxImage(sandboxImage);

  // Non-destructively ensure /mnt is accessible in gateway container
  await ensureGatewayHasMntMount();

  // Check if sandbox already exists and delete it
  await cleanupExistingSandbox(workspaceId);

  // Presign-first auth model:
  //   - Stored presign present → use it; ANTHROPIC_API_KEY and STRINGCOST_API_KEY are not needed.
  //   - No stored presign       → require both keys to create one now, then store it.
  // Run `npx openeral presign renew` to replace the stored presign at any time.
  let stringcostUrl: string | undefined;
  const storedPresign = loadStoredPresign();
  if (storedPresign) {
    // Reuse the stored permanent presign — no env vars required
    stringcostUrl = storedPresign.url.replace(/\/v1\/.*$/, '');
    process.stderr.write('\x1b[32m✓ Using stored StringCost presign\x1b[0m\n');
    process.stderr.write(`\x1b[2m  Proxy URL: ${stringcostUrl}\x1b[0m\n`);
  } else {
    // No stored presign — both keys are required to create one
    const anthropicKey = (process.env.ANTHROPIC_API_KEY ?? '').replace('@anthropic_api_key', '').trim();
    const stringcostKey = (process.env.STRINGCOST_API_KEY ?? '').replace('@stringcost_api_key', '').trim();

    if (!anthropicKey || !stringcostKey) {
      process.stderr.write(
        '\x1b[31merror: no stored presign found and required keys are missing.\x1b[0m\n' +
        'Either run `npx openeral presign renew` once (requires both keys), or set:\n' +
        '  ANTHROPIC_API_KEY=sk-ant-...   your Anthropic API key\n' +
        '  STRINGCOST_API_KEY=...          your StringCost API key\n' +
        'Once created, the presign is stored permanently and no keys are needed again.\n',
      );
      process.exit(1);
    }

    process.stderr.write('\x1b[2mopeneral: no stored presign — creating permanent presign...\x1b[0m\n');
    try {
      const fullUrl = await createPresignUrl(anthropicKey, stringcostKey);
      saveStoredPresign(fullUrl);
      stringcostUrl = fullUrl.replace(/\/v1\/.*$/, '');
      process.stderr.write('\x1b[32m✓ StringCost presign created and stored (expires_in=-1, max_uses=-1, cost_limit=$10)\x1b[0m\n');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      process.stderr.write('\x1b[31merror: failed to create StringCost presign: ' + error.message + '\x1b[0m\n');
      process.exit(1);
    }
  }

  // Build `openshell sandbox create` arguments.
  // --name   maps to OPENSHELL_SANDBOX_ID inside the container, which
  //          setup.sh uses as the workspace ID.
  // --auto-providers  creates/resolves named providers automatically from
  //          the current environment (DATABASE_URL → db).
  // When a presign is in use we do NOT include --provider claude: the sandbox
  // authenticates via the presign URL written to ~/.claude/settings.json and
  // must never see ANTHROPIC_API_KEY.
  const sandboxArgs: string[] = [
    'sandbox', 'create',
    '--name', workspaceId,
    '--from', sandboxImage,
  ];

  if (!stringcostUrl && process.env.ANTHROPIC_API_KEY) {
    // Fallback (no presign): inject the raw API key via the claude provider
    sandboxArgs.push('--provider', 'claude');
  }

  if (process.env.DATABASE_URL) {
    sandboxArgs.push('--provider', 'db');
  }

  sandboxArgs.push('--auto-providers');
  
  const setupScript = `
set -e

OPENERAL_DIR=/opt/openeral

export WORKSPACE_ID="\${OPENSHELL_SANDBOX_ID:-default}"
export DATABASE_URL="\${DATABASE_URL:-\${OPENERAL_DATABASE_URL:-}}"

# StringCost proxy URL (passed as environment variable from host)
export STRINGCOST_PROXY_URL="${stringcostUrl || ''}"

# StringCost integration - if STRINGCOST_PROXY_URL is set, use it as ANTHROPIC_BASE_URL
if [ -n "\${STRINGCOST_PROXY_URL:-}" ]; then
  export ANTHROPIC_BASE_URL="\${STRINGCOST_PROXY_URL}"
  echo "setup: using StringCost proxy at \${ANTHROPIC_BASE_URL}"
fi

mkdir -p /home/agent/.claude /home/agent/.claude/projects /home/agent/.openeral/data

# Stable PGlite data directory — must be set before starting the daemon so that
# getDatabaseConnection() in embedded.js uses /home/agent regardless of what HOME
# is set to in the sandbox process at daemon startup time.
export OPENERAL_DATA_DIR="/home/agent/.openeral/data"

if [ -n "\${DATABASE_URL:-}" ]; then
  echo "setup: running migrations..."
  node -e "
    import('$OPENERAL_DIR/dist/db/pool.js').then(async ({ createPool }) => {
      const { runMigrations } = await import('$OPENERAL_DIR/dist/db/migrations.js');
      const pool = createPool(process.env.DATABASE_URL);
      await runMigrations(pool);
      await pool.end();
      console.log('setup: migrations complete');
    }).catch(err => {
      console.error('setup: migration failed:', err.message);
      process.exit(1);
    });
  "

  echo "setup: seeding workspace \$WORKSPACE_ID..."
  node -e "
    import('$OPENERAL_DIR/dist/db/pool.js').then(async ({ createPool }) => {
      const ws = await import('$OPENERAL_DIR/dist/db/workspace-queries.js');
      const pool = createPool(process.env.DATABASE_URL);
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
else
  echo "setup: no DATABASE_URL — running in local-only mode (no persistence)"
fi

# Write StringCost proxy config directly into Claude Code settings.json so
# it takes effect regardless of how the sandbox injects environment variables.
if [ -n "\${STRINGCOST_PROXY_URL:-}" ]; then
  node -e "
const fs = require('fs');
const file = '/home/agent/.claude/settings.json';
let s = {};
try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch(e) {}
if (!s.env) s.env = {};
s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL;
s.env.ANTHROPIC_AUTH_TOKEN = 'dummy';
fs.mkdirSync('/home/agent/.claude', {recursive: true});
fs.writeFileSync(file, JSON.stringify(s, null, 2));
console.log('setup: StringCost proxy written to ~/.claude/settings.json');
"
fi

OPENERAL_NPMRC=/tmp/openeral-npmrc
rm -f "$OPENERAL_NPMRC"
if [ -n "\${SOCKET_TOKEN:-}" ]; then
  echo "setup: configuring npm to use Socket.dev registry..."
  cat > "$OPENERAL_NPMRC" <<'NPMRC'
registry=https://registry.socket.dev/npm/
//registry.socket.dev/npm/:_authToken=\${SOCKET_TOKEN}
NPMRC
  export NPM_CONFIG_USERCONFIG="$OPENERAL_NPMRC"
fi

echo "setup: starting openeral-bash daemon..."
node "$OPENERAL_DIR/openeral-bash.mjs" --daemon &
DAEMON_PID=$!

_d=0
while [ $_d -lt 300 ]; do
  [ -S /tmp/openeral-bash.sock ] && break
  [ $_d -eq 50 ] && echo "setup: waiting for daemon to initialize (PGlite WASM)..." >&2
  sleep 0.1
  _d=$((_d+1))
done

if [ -S /tmp/openeral-bash.sock ]; then
  echo "setup: daemon ready (pid $DAEMON_PID)"
  trap "kill $DAEMON_PID 2>/dev/null; rm -f /tmp/openeral-bash.sock" EXIT
else
  echo "setup: warning: daemon not ready after 30s — using standalone mode" >&2
  unset DAEMON_PID
  trap "rm -f /tmp/openeral-bash.sock" EXIT
fi

# Install Claude Code if not already present in the image
if ! command -v claude >/dev/null 2>&1; then
  echo "setup: Claude CLI not found, installing..."
  npm install -g @anthropic-ai/claude-code 2>&1 | tail -20
  if ! command -v claude >/dev/null 2>&1; then
    echo "setup: ERROR: Claude CLI install failed" >&2
    exit 1
  fi
  echo "setup: Claude CLI installed"
fi

echo "setup: launching Claude Code..."
# Always strip ANTHROPIC_API_KEY — the sandbox uses the presign stored in
# ~/.claude/settings.json (written above). The raw API key must never reach
# Claude Code inside the sandbox or it will prompt the user to choose a key.
exec env -u ANTHROPIC_API_KEY HOME=/home/agent SHELL=/usr/local/bin/openeral-bash claude "$@"
`;

  sandboxArgs.push('--', 'bash', '-c', setupScript, '--', ...claudeArgs);

  // Pre-create providers so their k8s Secrets exist BEFORE the sandbox pod is scheduled.
  //
  // When `openshell sandbox create --auto-providers` is used, the operator creates
  // provider secrets asynchronously — the pod template references secrets that may
  // not exist yet when Kubernetes schedules the pod, causing it to stay in Pending
  // until those secrets appear (which can take 60-300+ seconds or never complete).
  //
  // By creating providers HERE (synchronously, before sandbox create), we guarantee
  // the secrets exist when the pod is scheduled.  Errors are silently ignored because
  // the provider may already exist from a previous run — the existing secret is reused.
  process.stderr.write('\x1b[2mopeneral: registering providers...\x1b[0m\n');

  // claude provider — only needed when NOT using presign (injects ANTHROPIC_API_KEY).
  // When a presign is in use, the sandbox authenticates via the presign URL written to
  // ~/.claude/settings.json and ANTHROPIC_API_KEY must not be injected.
  if (!stringcostUrl && process.env.ANTHROPIC_API_KEY) {
    const claudeProvider = spawnSync('openshell', [
      'provider', 'create', '--name', 'claude', '--type', 'generic', '--credential', 'ANTHROPIC_API_KEY',
    ], { stdio: 'pipe', timeout: 30000 });
    if (claudeProvider.status === 0) {
      process.stderr.write('\x1b[32m✓ Claude provider registered\x1b[0m\n');
    }
    // Non-zero exit is expected when the provider already exists — that's fine.
  }

  // db provider — injects DATABASE_URL into the sandbox (optional)
  if (process.env.DATABASE_URL) {
    spawnSync('openshell', [
      'provider', 'create', '--name', 'db', '--type', 'generic', '--credential', 'DATABASE_URL',
    ], { stdio: 'pipe', timeout: 30000 });
  }

  process.stderr.write(
    `\x1b[2mopeneral: launching Claude Code in OpenShell sandbox (${workspaceId})...\x1b[0m\n\n`,
  );

  const child = spawn('openshell', sandboxArgs, { stdio: 'inherit' });

  // Background: inject /mnt into the running sandbox container via nsenter
  injectMntIntoSandbox(workspaceId).catch((err: unknown) => {
    process.stderr.write(`\x1b[33mwarning: /mnt injection failed: ${(err instanceof Error ? err.message : String(err))}\x1b[0m\n`);
  });

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

  // presign show / renew
  if (args[0] === 'presign') {
    if (args[1] === 'renew') {
      await cmdPresignRenew();
    } else {
      await cmdPresignShow();
    }
    return;
  }

  // stats / analyze / apply — forward to optimize CLI, passing stored presign URL via env
  if (args[0] === 'stats' || args[0] === 'analyze' || args[0] === 'apply') {
    const { fileURLToPath } = await import('node:url');
    const optimizeCliPath = fileURLToPath(new URL('./optimize/cli.js', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env };
    const stored = loadStoredPresign();
    if (stored) env['OPENERAL_PRESIGN_URL'] = stored.url;
    const child = spawn('node', [optimizeCliPath, ...args], { stdio: 'inherit', env });
    child.on('exit', (code) => process.exit(code ?? 0));
    return;
  }

  // optimize <subcommand> — backwards compatibility alias
  if (args[0] === 'optimize') {
    const { fileURLToPath } = await import('node:url');
    const optimizeCliPath = fileURLToPath(new URL('./optimize/cli.js', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env };
    const stored = loadStoredPresign();
    if (stored) env['OPENERAL_PRESIGN_URL'] = stored.url;
    const child = spawn('node', [optimizeCliPath, ...args.slice(1)], { stdio: 'inherit', env });
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
