import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, Server, Socket } from 'node:net';
import {
  connectViaHttpProxy,
  isLocalHost,
  resolveHttpProxy,
} from './http-connect-socket.js';

/**
 * Spin up a fake HTTP CONNECT proxy on a random port that:
 *   - Waits for `CONNECT host:port HTTP/1.1` (+ headers + blank line)
 *   - Writes back a configurable status line
 *   - On 200, echoes any subsequent client bytes back to the client
 *   - Records the target the client asked for
 */
function createFakeProxy(status: string): Promise<{
  server: Server;
  port: number;
  lastTarget: () => string | null;
  close: () => Promise<void>;
}> {
  return new Promise((resolve) => {
    let lastTarget: string | null = null;
    const server = createServer((sock: Socket) => {
      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('binary');
        const end = buf.indexOf('\r\n\r\n');
        if (end === -1) return;
        const reqLine = buf.split('\r\n', 1)[0];
        const match = reqLine.match(/^CONNECT\s+(\S+)\s+HTTP\/1\.\d$/);
        lastTarget = match ? match[1] : null;
        sock.off('data', onData);
        sock.write(`${status}\r\n\r\n`);
        if (status.startsWith('HTTP/1.1 200')) {
          // Echo mode: whatever the client writes next, bounce back.
          sock.on('data', (d) => sock.write(d));
        } else {
          sock.end();
        }
      };
      sock.on('data', onData);
      sock.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        server,
        port,
        lastTarget: () => lastTarget,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}

describe('connectViaHttpProxy', () => {
  let proxy: Awaited<ReturnType<typeof createFakeProxy>> | null = null;

  afterEach(async () => {
    if (proxy) {
      await proxy.close();
      proxy = null;
    }
  });

  it('resolves a socket when the proxy returns 200', async () => {
    proxy = await createFakeProxy('HTTP/1.1 200 Connection Established');
    const socket = await connectViaHttpProxy({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
      targetHost: 'supabase.example.com',
      targetPort: 5432,
    });
    expect(proxy.lastTarget()).toBe('supabase.example.com:5432');

    // Echo round-trip confirms the socket is still live and positioned after the handshake.
    const payload = Buffer.from('pg-wire-bytes');
    const echoed = await new Promise<Buffer>((resolve) => {
      socket.on('data', (d) => resolve(d));
      socket.write(payload);
    });
    expect(echoed).toEqual(payload);
    socket.destroy();
  });

  it('rejects with the proxy status line on non-200', async () => {
    proxy = await createFakeProxy('HTTP/1.1 403 Forbidden');
    await expect(
      connectViaHttpProxy({
        proxyUrl: `http://127.0.0.1:${proxy.port}`,
        targetHost: 'denied.example.com',
        targetPort: 5432,
      }),
    ).rejects.toThrow(/403 Forbidden/);
  });

  it('rejects when the proxy closes without a response', async () => {
    // Server accepts the connection and immediately closes.
    const server = createServer((s) => s.destroy());
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', () => res()));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      await expect(
        connectViaHttpProxy({
          proxyUrl: `http://127.0.0.1:${port}`,
          targetHost: 'supabase.example.com',
          targetPort: 5432,
          connectTimeoutMs: 2_000,
          handshakeTimeoutMs: 2_000,
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });

  it('validates the proxy URL', async () => {
    await expect(
      connectViaHttpProxy({
        proxyUrl: 'not-a-url',
        targetHost: 'x',
        targetPort: 1,
      }),
    ).rejects.toThrow(/invalid proxy URL/);
    await expect(
      connectViaHttpProxy({
        proxyUrl: 'https://example.com:443',
        targetHost: 'x',
        targetPort: 1,
      }),
    ).rejects.toThrow(/must be http/);
  });
});

describe('resolveHttpProxy', () => {
  const originals: Record<string, string | undefined> = {};
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY'];

  beforeEach(() => {
    for (const k of keys) {
      originals[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of keys) {
      if (originals[k] === undefined) delete process.env[k];
      else process.env[k] = originals[k];
    }
  });

  it('returns undefined when no proxy env is set', () => {
    expect(resolveHttpProxy({})).toBeUndefined();
  });

  it('prefers HTTPS_PROXY', () => {
    expect(
      resolveHttpProxy({
        HTTPS_PROXY: 'http://a:1',
        HTTP_PROXY: 'http://b:2',
        ALL_PROXY: 'http://c:3',
      }),
    ).toBe('http://a:1');
  });

  it('falls back through the OpenShell env precedence', () => {
    expect(resolveHttpProxy({ https_proxy: 'http://b:2' })).toBe('http://b:2');
    expect(resolveHttpProxy({ HTTP_PROXY: 'http://c:3' })).toBe('http://c:3');
    expect(resolveHttpProxy({ http_proxy: 'http://d:4' })).toBe('http://d:4');
    expect(resolveHttpProxy({ ALL_PROXY: 'http://e:5' })).toBe('http://e:5');
  });
});

describe('isLocalHost', () => {
  it.each([
    ['localhost', true],
    ['LOCALHOST', true],
    ['127.0.0.1', true],
    ['127.0.0.2', true],
    ['::1', true],
    [undefined, true],
    ['', true],
    ['aws-1-ap-northeast-1.pooler.supabase.com', false],
    ['10.0.0.1', false],
    ['example.com', false],
  ])('isLocalHost(%p) === %p', (host, expected) => {
    expect(isLocalHost(host as any)).toBe(expected);
  });
});
