import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { createServer, Server, Socket } from 'node:net';
import {
  createTunneledSocket,
  isLocalHost,
  resolveHttpProxy,
} from './http-connect-socket.js';

/**
 * Fake HTTP CONNECT proxy:
 *   - accepts any connection
 *   - parses the CONNECT request line
 *   - writes back a configurable status line
 *   - on 200, echoes any further client bytes back
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

describe('createTunneledSocket', () => {
  let proxy: Awaited<ReturnType<typeof createFakeProxy>> | null = null;

  afterEach(async () => {
    if (proxy) {
      await proxy.close();
      proxy = null;
    }
  });

  it('emits synthetic connect only after CONNECT handshake succeeds', async () => {
    proxy = await createFakeProxy('HTTP/1.1 200 Connection Established');

    const socket = createTunneledSocket({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });

    const connected = new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    // pg's contract: setNoDelay then connect(port, host).
    socket.setNoDelay(true);
    socket.connect(5432, 'supabase.example.com');

    await connected;
    expect(proxy.lastTarget()).toBe('supabase.example.com:5432');

    // Echo round-trip confirms the tunnel is transparent after handshake.
    const payload = Buffer.from('pg-wire-bytes');
    const echoed = await new Promise<Buffer>((resolve) => {
      socket.once('data', (d) => resolve(d));
      socket.write(payload);
    });
    expect(echoed).toEqual(payload);
    socket.destroy();
  });

  it('emits error when the proxy returns non-200', async () => {
    proxy = await createFakeProxy('HTTP/1.1 403 Forbidden');

    const socket = createTunneledSocket({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });

    const err = await new Promise<Error>((resolve) => {
      socket.once('error', resolve);
      socket.connect(5432, 'denied.example.com');
    });
    expect(err.message).toMatch(/403 Forbidden/);
    socket.destroy();
  });

  it('exposes setNoDelay and the pg-style connect(port, host) signature', async () => {
    proxy = await createFakeProxy('HTTP/1.1 200 Connection Established');
    const socket = createTunneledSocket({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });

    // Neither call should throw.
    expect(() => socket.setNoDelay(true)).not.toThrow();
    expect(() => socket.setKeepAlive(true)).not.toThrow();

    const connected = new Promise<void>((r) => socket.once('connect', () => r()));
    socket.connect(5432, 'target.example.com');
    await connected;

    socket.destroy();
  });

  it('rejects a non-http proxy URL', () => {
    expect(() =>
      createTunneledSocket({ proxyUrl: 'https://example.com:443' }),
    ).toThrow(/must be http/);
  });

  it('rejects a malformed proxy URL', () => {
    expect(() => createTunneledSocket({ proxyUrl: 'not-a-url' })).toThrow(/Invalid URL/);
  });

  it('accepts object-form connect({ port, host })', async () => {
    proxy = await createFakeProxy('HTTP/1.1 200 Connection Established');
    const socket = createTunneledSocket({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });

    const connected = new Promise<void>((r) => socket.once('connect', () => r()));
    // node-postgres typically passes { port, host }.
    (socket as any).connect({ port: 6543, host: 'pooler.example.com' });
    await connected;
    expect(proxy.lastTarget()).toBe('pooler.example.com:6543');
    socket.destroy();
  });

  it('hides CONNECT headers from listeners registered AFTER connect (pg contract)', async () => {
    // This mirrors pg/lib/connection.js exactly: setNoDelay, THEN connect(),
    // THEN attach 'connect'/'data' listeners. The proxy's
    // `HTTP/1.1 200 ...\r\n\r\n` must NEVER surface to the 'data' listener —
    // pg would parse it as pg wire protocol and terminate the connection.
    proxy = await createFakeProxy('HTTP/1.1 200 Connection Established');
    const socket = createTunneledSocket({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });

    // pg's order: setNoDelay first, THEN connect(), THEN listeners.
    socket.setNoDelay(true);
    socket.connect(5432, 'target.example.com');

    const seenBeforeConnect: Buffer[] = [];
    const seenAfterConnect: Buffer[] = [];
    let connectFired = false;

    socket.once('connect', () => {
      connectFired = true;
    });
    socket.on('data', (d) => {
      if (connectFired) seenAfterConnect.push(d);
      else seenBeforeConnect.push(d);
    });

    // Allow the handshake to complete.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(connectFired).toBe(true);
    expect(Buffer.concat(seenBeforeConnect).toString()).toBe('');

    const payload = Buffer.from('PG-WIRE-PAYLOAD');
    const echoed = await new Promise<Buffer>((resolve) => {
      socket.once('data', (d) => resolve(d));
      socket.write(payload);
    });
    expect(echoed).toEqual(payload);
    expect(Buffer.concat(seenAfterConnect).includes(payload)).toBe(true);
    // The proxy's response line must never surface to the user.
    const combined = Buffer.concat([...seenBeforeConnect, ...seenAfterConnect]).toString();
    expect(combined).not.toMatch(/HTTP\/1\.1/);
    socket.destroy();
  });

  it('late once("data") stays once — pg uses once("data") for SSL response', async () => {
    // pg attaches a `once('data', ...)` for the single-byte SSL response
    // ('S'/'N'). If our queue replays it with `on` instead of `once` the
    // listener would fire again on every subsequent pg-wire chunk.
    proxy = await createFakeProxy('HTTP/1.1 200 Connection Established');
    const socket = createTunneledSocket({
      proxyUrl: `http://127.0.0.1:${proxy.port}`,
    });

    socket.connect(5432, 'target.example.com');
    const calls: Buffer[] = [];
    socket.once('data', (d) => calls.push(d));

    // Wait for tunnel, then write two bursts — first is echoed back, then second.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    const first = Buffer.from('FIRST');
    const second = Buffer.from('SECOND');
    const gotSecond = new Promise<Buffer>((resolve) => socket.on('data', (d) => resolve(d)));
    socket.write(first);
    await new Promise<void>((r) => setTimeout(r, 30));
    socket.write(second);
    await gotSecond;

    // The once('data', ...) must have been called exactly once.
    expect(calls.length).toBe(1);
    socket.destroy();
  });
});

describe('resolveHttpProxy', () => {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY'];
  const originals: Record<string, string | undefined> = {};
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

  it('returns undefined with no proxy env', () => {
    expect(resolveHttpProxy({})).toBeUndefined();
  });

  it('prefers HTTPS_PROXY over others', () => {
    expect(
      resolveHttpProxy({
        HTTPS_PROXY: 'http://a:1',
        HTTP_PROXY: 'http://b:2',
        ALL_PROXY: 'http://c:3',
      }),
    ).toBe('http://a:1');
  });

  it('falls back through OpenShell precedence order', () => {
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
