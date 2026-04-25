import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const policy = readFileSync(join(repoRoot, 'sandboxes/openeral/policy.yaml'), 'utf8');
const setup = readFileSync(join(repoRoot, 'sandboxes/openeral/setup.sh'), 'utf8');
const cli = readFileSync(join(__dirname, 'cli.ts'), 'utf8');

function launchBlock(source: string, marker: string): string {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\nfi', start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + '\nfi'.length);
}

function directAuthBranch(source: string, marker: string): string {
  const block = launchBlock(source, marker);
  const start = block.indexOf('\nelse\n');
  expect(start).toBeGreaterThanOrEqual(0);
  return block.slice(start);
}

function setupStringCostNormalizer(): string {
  const marker = 'normalize_stringcost_proxy_url() {';
  const start = setup.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const endMarker = '\n\nif [ -n "${STRINGCOST_PROXY_URL:-}" ]; then';
  const end = setup.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return setup.slice(start, end);
}

function normalizeWithSetup(input: string): string {
  return execFileSync(
    'bash',
    ['-c', `${setupStringCostNormalizer()}\nnormalize_stringcost_proxy_url "$1"`, 'normalize-test', input],
    { encoding: 'utf8' },
  ).trim();
}

describe('proxy policy (PROXY-PLAN compliance)', () => {
  it('has no secret_injection: fields (stock SecretResolver handles it)', () => {
    expect(policy).not.toMatch(/secret_injection:/);
  });

  it('has no egress_via: fields (not in stock OpenShell)', () => {
    expect(policy).not.toMatch(/egress_via:/);
  });

  it('has no egress_profile: fields (not in stock OpenShell)', () => {
    expect(policy).not.toMatch(/egress_profile:/);
  });

  it('Anthropic endpoint has protocol: rest + tls: terminate', () => {
    const anthropicSection = policy.slice(
      policy.indexOf('api.anthropic.com'),
      policy.indexOf('binaries:', policy.indexOf('api.anthropic.com')),
    );
    expect(anthropicSection).toContain('protocol: rest');
    expect(anthropicSection).toContain('tls: terminate');
  });

  it('Socket.dev endpoint has protocol: rest + tls: terminate', () => {
    expect(policy).toContain('registry.socket.dev');
    const socketSection = policy.slice(
      policy.indexOf('registry.socket.dev'),
      policy.indexOf('binaries:', policy.indexOf('registry.socket.dev')),
    );
    expect(socketSection).toContain('protocol: rest');
    expect(socketSection).toContain('tls: terminate');
  });

  it('Socket.dev endpoint is read-only (not access: full)', () => {
    const socketSection = policy.slice(
      policy.indexOf('registry.socket.dev'),
      policy.indexOf('binaries:', policy.indexOf('registry.socket.dev')),
    );
    expect(socketSection).toContain('access: read-only');
    expect(socketSection).not.toContain('access: full');
  });

  it('Socket.dev policy allows npm and node (node is the actual exe)', () => {
    const socketStart = policy.indexOf('socket_packages:');
    const nextPolicy = policy.indexOf('\n  #', socketStart + 1);
    const socketBlock = policy.slice(socketStart, nextPolicy > 0 ? nextPolicy : undefined);
    expect(socketBlock).toContain('/usr/bin/npm');
    expect(socketBlock).toContain('/usr/bin/node');
  });

  it('allows all current Supabase AWS pooler regions on both pooler ports', () => {
    // Keep in sync with Supabase Platform > Regions.
    const regions = [
      'us-west-1',
      'us-west-2',
      'us-east-1',
      'us-east-2',
      'ca-central-1',
      'eu-west-1',
      'eu-west-2',
      'eu-west-3',
      'eu-central-1',
      'eu-central-2',
      'eu-north-1',
      'ap-south-1',
      'ap-southeast-1',
      'ap-northeast-1',
      'ap-northeast-2',
      'ap-southeast-2',
      'sa-east-1',
    ];

    for (const region of regions) {
      for (const shard of ['aws-0', 'aws-1']) {
        for (const port of [5432, 6543]) {
          expect(policy).toContain(`${shard}-${region}.pooler.supabase.com, port: ${port}`);
        }
      }
    }
  });
});

describe('setup.sh Socket.dev integration', () => {
  it('configures Socket.dev registry when SOCKET_TOKEN is present', () => {
    expect(setup).toContain('SOCKET_TOKEN');
    expect(setup).toContain('registry.socket.dev');
    expect(setup).toContain('_authToken');
  });

  it('uses a separate openeral-managed file, not the user .npmrc', () => {
    // Must NOT write to /home/agent/.npmrc (user's file)
    expect(setup).not.toContain('/home/agent/.npmrc');
    // Must use a temp/openeral-owned file
    expect(setup).toMatch(/openeral-npmrc|OPENERAL_NPMRC/);
    // Must set NPM_CONFIG_USERCONFIG to point npm at the openeral file
    expect(setup).toContain('NPM_CONFIG_USERCONFIG');
  });

  it('does not delete any file in /home/agent', () => {
    expect(setup).not.toMatch(/rm.*\/home\/agent/);
  });

  it('does not hardcode the SOCKET_TOKEN value', () => {
    expect(setup).toContain('${SOCKET_TOKEN}');
    expect(setup).not.toMatch(/sock_[a-zA-Z0-9]/);
  });

  it('Socket.dev config is conditional (only when SOCKET_TOKEN is set)', () => {
    expect(setup).toMatch(/if \[ -n "\$\{SOCKET_TOKEN:-\}"/);
  });
});

describe('sandbox workspace persistence wiring', () => {
  const bashBridge = readFileSync(join(repoRoot, 'sandboxes/openeral/openeral-bash.mjs'), 'utf8');

  it('setup.sh restores and flushes the real Claude home', () => {
    expect(setup).toContain("import('$OPENERAL_DIR/dist/sync.js')");
    expect(setup).toContain('syncToFs(pool, process.env.WORKSPACE_ID');
    expect(setup).toContain('syncFromFs(pool, process.env.WORKSPACE_ID');
    expect(setup).toContain('createHomeSyncOptions({ prune: false })');
    expect(setup.indexOf('restoring /home/agent from workspace')).toBeLessThan(
      setup.indexOf('starting openeral-bash daemon'),
    );
  });

  it('CLI inline setup uses embedded or external PostgreSQL and restores home before launch', () => {
    expect(cli).toContain("import('$OPENERAL_DIR/dist/db/embedded.js')");
    expect(cli).toContain("import('$OPENERAL_DIR/dist/sync.js')");
    expect(cli).toContain('syncToFs(pool, process.env.WORKSPACE_ID');
    expect(cli).toContain('syncFromFs(pool, process.env.WORKSPACE_ID');
    expect(cli).toContain('createHomeSyncOptions({ prune: false })');
    expect(cli).not.toContain('setup: no DATABASE_URL — running in local-only mode');
  });

  it('openeral-bash keeps virtual Bash writes and real file-tool writes in sync', () => {
    expect(bashBridge).toContain("import('/opt/openeral/dist/sync.js')");
    expect(bashBridge).toContain('syncFromFs(pool, workspaceId, HOME_DIR, createHomeSyncOptions({ prune: true }))');
    expect(bashBridge).toContain('syncToFs(pool, workspaceId');
    expect(bashBridge).toContain('watchAndSync(pool, workspaceId, HOME_DIR, createHomeSyncOptions({ prune: true }))');
    expect(bashBridge).toContain('createHomeSyncOptions({ prune: true })');
    expect(bashBridge).toContain('syncWatch.isDirty()');
    expect(bashBridge).toContain('syncWatch.suspend');
    expect(bashBridge).toContain('syncFromFs failed');
    expect(bashBridge).toContain('syncToFs failed');
    expect(bashBridge).toContain('execCommandWithSync(shell, pool, workspaceId, command, syncWatch)');
  });
});

describe('setup.sh StringCost integration', () => {
  it('normalizes presign URLs before writing Claude settings', () => {
    expect(setup).toContain('normalize_stringcost_proxy_url');
    expect(setup).toContain('url.pathname = url.pathname.replace(/\\/v1\\/.*$/, "");');
    expect(setup).toContain('s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL');
  });

  it('prevents doubled /v1/messages when a live presign URL includes beta query params', () => {
    const baseUrl = normalizeWithSetup(
      'https://proxy.stringcost.com/stringcost-proxy/t/example-presign-id/v1/messages?beta=true',
    );

    expect(baseUrl).toBe('https://proxy.stringcost.com/stringcost-proxy/t/example-presign-id');
    expect(`${baseUrl}/v1/messages?beta=true`).not.toContain('/v1/messages/v1/messages');
  });

  it('extracts and normalizes StringCost URLs from noisy Claude/Node output', () => {
    const baseUrl = normalizeWithSetup(
      '(node:53) [UNDICI-ENVHTTPPROXYAGENT] Warning: EnvHttpProxyAgent is experimental\n' +
        'https://proxy.stringcost.com/stringcost-proxy/t/example-presign-id/v1/messages?beta=true',
    );

    expect(baseUrl).toBe('https://proxy.stringcost.com/stringcost-proxy/t/example-presign-id');
  });

  it('keeps Node warnings out of ANTHROPIC_BASE_URL', () => {
    expect(setup).toContain('export NODE_NO_WARNINGS="${NODE_NO_WARNINGS:-1}"');
    expect(setup).toContain('NODE_NO_WARNINGS=1 node');
    expect(setup).toContain('2>"$STRINGCOST_PRESIGN_ERR"');
    expect(setup).not.toContain('2>&1)"');
  });

  it('extracts StringCost URLs from noisy presign output', () => {
    expect(setup).toMatch(/raw\.match\(\/https:\\\/\\\/proxy\\\.stringcost\\\.com\\\/stringcost-proxy\\\/t\\\/\[\^\\s/);
    expect(setup).toContain('const candidate = match ? match[0] : raw;');
    expect(setup).toContain('const url = new URL(candidate);');
  });

  it('supports uploaded StringCost presigns for OpenShell placeholder-safe launches', () => {
    expect(setup).toContain('/sandbox/openeral-input/presign.json');
    expect(setup).toContain('setup.sh: using uploaded StringCost presign');
    expect(setup).toContain('skipping StringCost presign creation because ANTHROPIC_API_KEY is an OpenShell placeholder');
  });

  it('supports bundled upload inputs for OpenShell single-upload launches', () => {
    expect(setup).toContain('/sandbox/openeral-input/db-url');
    expect(setup).toContain('find /sandbox/openeral-input -type f -name db-url');
  });

  it('exports ANTHROPIC_BASE_URL to Claude Code at exec time', () => {
    // Claude Code reads these from process.env at startup for auth-mode
    // selection; settings.json alone isn't consulted in time.  Without the
    // exported env var, the fallback URL in settings.json wins and produces
    // doubled /v1/messages paths against StringCost.
    const execBlock = setup.slice(setup.indexOf('launching Claude Code'));
    expect(execBlock).toMatch(/ANTHROPIC_BASE_URL="\$STRINGCOST_PROXY_URL"/);
    expect(execBlock).not.toMatch(/-u ANTHROPIC_API_KEY/);
    expect(execBlock).toMatch(/-u STRINGCOST_API_KEY/);
    expect(execBlock).toMatch(/-u ANTHROPIC_AUTH_TOKEN/);
  });

  it('does not persist API keys in Claude settings', () => {
    const setupProxyBlock = launchBlock(setup, 'setup.sh: launching Claude Code');
    const cliProxyBlock = launchBlock(cli, 'setup: launching Claude Code');
    expect(setupProxyBlock).not.toMatch(/-u ANTHROPIC_API_KEY/);
    expect(cliProxyBlock).not.toMatch(/-u ANTHROPIC_API_KEY/);
    expect(setup).toContain('delete s.env.ANTHROPIC_API_KEY');
    expect(setup).toContain('delete s.env.ANTHROPIC_AUTH_TOKEN');
    expect(cli).toContain('delete s.env.ANTHROPIC_API_KEY');
    expect(cli).toContain('delete s.env.ANTHROPIC_AUTH_TOKEN');
  });

  it('preserves ANTHROPIC_API_KEY in setup.sh direct-auth launches', () => {
    const directBranch = directAuthBranch(setup, 'setup.sh: launching Claude Code');
    expect(directBranch).toContain('exec env');
    expect(directBranch).not.toMatch(/-u ANTHROPIC_API_KEY/);
  });

  it('preserves ANTHROPIC_API_KEY in CLI inline direct-auth launches', () => {
    const directBranch = directAuthBranch(cli, 'setup: launching Claude Code');
    expect(directBranch).toContain('exec env');
    expect(directBranch).not.toMatch(/-u ANTHROPIC_API_KEY/);
  });
});
