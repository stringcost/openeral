/**
 * HTTP CONNECT tunnel for raw-TCP clients (specifically node-postgres).
 *
 * Context: inside an OpenShell sandbox, the kernel-level iptables rules in the
 * sandbox netns REJECT every outbound TCP packet that isn't destined for the
 * HTTP proxy at `10.200.0.1:3128`. Raw TCP to an external PostgreSQL host
 * cannot leave the sandbox.
 *
 * The HTTP CONNECT proxy accepts a `CONNECT host:port` request and — once it
 * returns `200 Connection Established` — relays bytes bidirectionally without
 * further inspection. That relay carries anything: pg wire protocol, its
 * end-to-end TLS handshake with Supabase, everything.
 *
 * This module returns a synchronous stream object that pg treats like a
 * `net.Socket`, but internally it is a `Duplex` wrapped around a private raw
 * Socket. pg then calls `setNoDelay(true)` and `.connect(port, host)` on it,
 * and pg's `'connect'` listener fires only after the tunnel is established.
 * No Promise-returning API (pg doesn't await the factory result).
 */

import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { URL } from 'node:url';

export interface TunneledSocketOptions {
  /** Proxy URL — e.g. "http://10.200.0.1:3128". Must be http, not https. */
  proxyUrl: string;
  /** CONNECT handshake timeout (ms) after the proxy TCP connection is up. */
  handshakeTimeoutMs?: number;
}

/**
 * Return a stream that pg treats as a `net.Socket`, but whose raw TCP goes
 * through an HTTP CONNECT proxy. Suitable for `pg.PoolConfig.stream`.
 *
 * Why a Duplex wrapper and not a patched net.Socket: pg attaches its
 * `'connect'` and `'data'` listeners AFTER calling `.connect()`. Monkey-
 * patching the socket's EventEmitter methods to intercept those additions
 * also intercepts Node's own internal listener bookkeeping and breaks the
 * readable stream. Giving pg a Duplex whose internal raw Socket is fully
 * encapsulated sidesteps the whole problem: pg's listeners live on the
 * Duplex, our handshake runs entirely against the inner Socket, and no
 * byte reaches the Duplex's readable side until the `200 Connection
 * Established` is parsed and stripped.
 */
export function createTunneledSocket(opts: TunneledSocketOptions): Socket {
  const { proxyUrl, handshakeTimeoutMs = 15_000 } = opts;

  const proxyU = new URL(proxyUrl);
  if (proxyU.protocol !== 'http:') {
    throw new Error(`http-connect-socket: proxy must be http://, got ${proxyU.protocol}`);
  }
  const proxyHost = proxyU.hostname;
  const proxyPort = parseInt(proxyU.port || '80', 10);

  // pg's `PoolConfig.stream` factory contract says "return a net.Socket".
  // What actually flows through pg is: setNoDelay, setKeepAlive, connect,
  // .on/.once, .write, .end, .destroy, and the 'connect'/'data'/'error'/
  // 'close' events. A stream.Duplex with those methods and events is
  // indistinguishable to pg — and gives us a clean boundary where user
  // bytes never touch the raw Socket until after the CONNECT tunnel is up.
  return new TunneledSocket({
    proxyHost,
    proxyPort,
    handshakeTimeoutMs,
  }) as unknown as Socket;
}

class TunneledSocket extends Duplex {
  private readonly raw: Socket;
  private readonly proxyHost: string;
  private readonly proxyPort: number;
  private readonly handshakeTimeoutMs: number;
  private targetHost = '';
  private targetPort = 0;
  private handshakeComplete = false;
  private buf = '';
  private handshakeTimer: NodeJS.Timeout | null = null;

  constructor(opts: { proxyHost: string; proxyPort: number; handshakeTimeoutMs: number }) {
    super();
    this.proxyHost = opts.proxyHost;
    this.proxyPort = opts.proxyPort;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs;
    this.raw = new Socket();

    this.raw.on('connect', () => this.onProxyConnect());
    this.raw.on('data', (chunk: Buffer) => this.onRawData(chunk));
    this.raw.on('error', (err) => this.destroy(err));
    this.raw.on('close', (hadErr) => {
      // Let Duplex own its lifecycle events. Manually emitting 'close' here
      // races with autoDestroy and can double-notify pg's Client.
      if (!this.destroyed) {
        this.destroy(
          hadErr ? new Error('http-connect-socket: proxy socket closed with error') : undefined,
        );
      }
    });
    this.raw.on('end', () => this.push(null));
  }

  // net.Socket-compatible knobs pg calls before connect.
  setNoDelay(enable?: boolean): this {
    this.raw.setNoDelay(enable);
    return this;
  }
  setKeepAlive(enable?: boolean, initialDelay?: number): this {
    this.raw.setKeepAlive(enable, initialDelay);
    return this;
  }
  setTimeout(timeout: number, cb?: () => void): this {
    this.raw.setTimeout(timeout, cb);
    return this;
  }
  ref(): this {
    this.raw.ref();
    return this;
  }
  unref(): this {
    this.raw.unref();
    return this;
  }

  connect(port: number, host?: string): this;
  connect(options: { port: number; host?: string }): this;
  connect(...args: unknown[]): this {
    if (typeof args[0] === 'number') {
      this.targetPort = args[0];
      this.targetHost = requireTargetHost(args[1]);
    } else if (typeof args[0] === 'object' && args[0] !== null) {
      const opt = args[0] as { port: number; host?: string };
      this.targetPort = opt.port;
      this.targetHost = requireTargetHost(opt.host);
    } else {
      throw new Error(`http-connect-socket: unsupported connect() arguments`);
    }
    this.raw.connect(this.proxyPort, this.proxyHost);
    return this;
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    // pg (and TLS-wrapped pg) writes here after handshake completes. We
    // forward straight to the real socket. During handshake the Duplex
    // Writable side is unused — we call this.raw.write() directly for
    // the CONNECT request.
    this.raw.write(chunk, encoding, cb);
  }

  override _read(): void {
    // No-op. push() is driven by the raw socket's 'data' event in
    // onRawData; consumers pull from our internal buffer automatically.
  }

  override _destroy(err: Error | null, cb: (err: Error | null) => void): void {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.raw.destroy(err ?? undefined);
    cb(err);
  }

  private onProxyConnect(): void {
    this.handshakeTimer = setTimeout(() => {
      if (!this.handshakeComplete) {
        this.destroy(
          new Error(
            `http-connect-socket: CONNECT handshake with ${this.proxyHost}:${this.proxyPort} timed out after ${this.handshakeTimeoutMs}ms`,
          ),
        );
      }
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref();

    const req =
      `CONNECT ${this.targetHost}:${this.targetPort} HTTP/1.1\r\n` +
      `Host: ${this.targetHost}:${this.targetPort}\r\n` +
      `Proxy-Connection: keep-alive\r\n\r\n`;
    this.raw.write(req);
  }

  private onRawData(chunk: Buffer): void {
    if (this.handshakeComplete) {
      // Post-handshake bytes go straight to the Duplex's readable side,
      // where pg (or the TLS wrapper around us) consumes them.
      this.push(chunk);
      return;
    }
    this.buf += chunk.toString('binary');
    const end = this.buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const statusLine = this.buf.slice(0, this.buf.indexOf('\r\n'));
    if (!/^HTTP\/\d\.\d\s+200\b/.test(statusLine)) {
      this.destroy(
        new Error(
          `http-connect-socket: tunnel to ${this.targetHost}:${this.targetPort} denied — ${statusLine}`,
        ),
      );
      return;
    }
    this.handshakeComplete = true;
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }

    // Any bytes past the header boundary are real tunnel data (e.g. pg
    // server greeting packed into the same TCP segment as the 200).
    const bodyStart = end + 4;
    if (bodyStart < this.buf.length) {
      this.push(Buffer.from(this.buf.slice(bodyStart), 'binary'));
    }
    this.buf = '';

    // Emit 'connect' on the Duplex — this is the user-facing signal that
    // the tunnel is live. pg's 'connect' handler runs next tick and starts
    // its wire protocol, which flows through _write → raw socket.
    this.emit('connect');
  }
}

function requireTargetHost(host: unknown): string {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('http-connect-socket: target host is required for CONNECT tunnel');
  }
  return host;
}

/**
 * Return the HTTP proxy URL active in this process env, if any.
 * Checks in the order OpenShell's child_env writes them.
 */
export function resolveHttpProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    undefined
  );
}

/**
 * Is the given hostname "local" (loopback or unset)?
 */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}
