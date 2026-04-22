import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '../..');
const policy = readFileSync(join(repoRoot, 'sandboxes/openeral/policy.yaml'), 'utf8');
const setup = readFileSync(join(repoRoot, 'sandboxes/openeral/setup.sh'), 'utf8');

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

describe('setup.sh StringCost integration', () => {
  it('normalizes presign URLs before writing Claude settings', () => {
    expect(setup).toContain('normalize_stringcost_proxy_url');
    expect(setup).toContain('url.pathname = url.pathname.replace(/\\/v1\\/.*$/, "");');
    expect(setup).toContain('s.env.ANTHROPIC_BASE_URL = process.env.STRINGCOST_PROXY_URL');
  });

  it('keeps Node warnings out of ANTHROPIC_BASE_URL', () => {
    expect(setup).toContain('NODE_NO_WARNINGS=1 node');
    expect(setup).toContain('2>"$STRINGCOST_PRESIGN_ERR"');
    expect(setup).not.toContain('2>&1)"');
  });
});
