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
 * This module produces a `net.Socket` whose `.connect(port, host)` transparently
 * routes through the proxy. It's designed to match pg 8.20's `stream` option
 * contract: the factory returns a **synchronous** Socket, pg then calls
 * `setNoDelay(true)` and `.connect(port, host)` on it, and pg's `'connect'`
 * listener fires only after the tunnel is established. No Promise-returning
 * API (pg doesn't await the factory result).
 */

import { Socket } from 'node:net';
import { URL } from 'node:url';

export interface TunneledSocketOptions {
  /** Proxy URL — e.g. "http://10.200.0.1:3128". Must be http, not https. */
  proxyUrl: string;
  /** CONNECT handshake timeout (ms) after the proxy TCP connection is up. */
  handshakeTimeoutMs?: number;
}

/**
 * Return a synchronous `net.Socket` whose `.connect(port, host)` actually
 * routes through an HTTP CONNECT proxy. Suitable for passing as pg's
 * `PoolConfig.stream` factory.
 *
 * Internals:
 *   - Override `connect(port, host)` to TCP-connect to the PROXY instead,
 *     and remember the real target.
 *   - At `.connect()` time, snapshot any user-registered `'connect'` listeners
 *     (pg's own) and remove them. They must not fire on the raw proxy TCP
 *     connect — the tunnel isn't ready yet. We replay them after the
 *     CONNECT handshake succeeds.
 *   - Install our own `'connect'` listener that writes `CONNECT target:port`
 *     to the already-open proxy socket.
 *   - A `'data'` listener parses the CONNECT response. On `200`, we replay
 *     the saved user listeners — so pg's `'connect'` handler fires exactly
 *     once, and only after the tunnel is ready.
 *   - On non-200, destroy the socket with an error whose message includes
 *     the full proxy status line so misconfigurations are diagnosable.
 *
 * We deliberately do NOT intercept `emit('connect')`. Suppressing the native
 * emission breaks stream.Readable's internal flow-mode activation — after
 * which `'data'` never fires and the CONNECT response is silently dropped.
 */
export function createTunneledSocket(opts: TunneledSocketOptions): Socket {
  const { proxyUrl, handshakeTimeoutMs = 15_000 } = opts;

  const proxyU = new URL(proxyUrl);
  if (proxyU.protocol !== 'http:') {
    throw new Error(`http-connect-socket: proxy must be http://, got ${proxyU.protocol}`);
  }
  const proxyHost = proxyU.hostname;
  const proxyPort = parseInt(proxyU.port || '80', 10);

  const socket = new Socket();
  let targetHost = '';
  let targetPort = 0;
  let handshakeComplete = false;
  let buf = '';
  const savedConnectListeners: Array<(...args: unknown[]) => void> = [];

  // Data listener catches the proxy's CONNECT response.
  socket.on('data', (chunk: Buffer) => {
    if (handshakeComplete) return; // normal tunnel data — let other listeners handle
    buf += chunk.toString('binary');
    const end = buf.indexOf('\r\n\r\n');
    if (end === -1) return;
    const statusLine = buf.slice(0, buf.indexOf('\r\n'));
    if (!/^HTTP\/\d\.\d\s+200\b/.test(statusLine)) {
      socket.destroy(
        new Error(
          `http-connect-socket: tunnel to ${targetHost}:${targetPort} denied — ${statusLine}`,
        ),
      );
      return;
    }
    // Any tunnel bytes that arrived in the same chunk as the response headers
    // must be pushed back onto the socket for downstream consumers.
    const bodyStart = end + 4;
    if (bodyStart < buf.length) {
      socket.unshift(Buffer.from(buf.slice(bodyStart), 'binary'));
    }
    buf = '';
    handshakeComplete = true;
    // Replay the user's saved 'connect' listeners now that the tunnel is up.
    // We invoke them directly rather than re-adding + emitting — the native
    // 'connect' already fired for the proxy TCP, and we've suppressed exactly
    // those listeners; re-emitting would be a second event.
    for (const fn of savedConnectListeners) {
      try {
        fn();
      } catch (e) {
        socket.emit('error', e as Error);
      }
    }
  });

  // Override connect() to go to the proxy instead of the target, remembering
  // the real target for the CONNECT line.
  const origConnect = Socket.prototype.connect;
  (socket as any).connect = function (...args: unknown[]): Socket {
    // Parse target from the overloaded connect() signature.
    //   connect(options, [connectListener])
    //   connect(port, [host], [connectListener])
    if (typeof args[0] === 'number') {
      targetPort = args[0];
      targetHost = typeof args[1] === 'string' ? args[1] : 'localhost';
    } else if (typeof args[0] === 'object' && args[0] !== null) {
      const opt = args[0] as { port: number; host?: string };
      targetPort = opt.port;
      targetHost = opt.host ?? 'localhost';
    } else {
      throw new Error(`http-connect-socket: unsupported connect() arguments`);
    }

    // Snapshot any 'connect' listeners the caller attached (pg, tests) and
    // remove them — they must not fire on the raw proxy TCP connect.
    for (const fn of socket.listeners('connect')) {
      savedConnectListeners.push(fn as (...args: unknown[]) => void);
    }
    socket.removeAllListeners('connect');

    // Our 'connect' listener: TCP to proxy is up, kick off the CONNECT
    // handshake and arm a timeout.
    socket.on('connect', () => {
      setTimeout(() => {
        if (!handshakeComplete) {
          socket.destroy(
            new Error(
              `http-connect-socket: CONNECT handshake with ${proxyHost}:${proxyPort} timed out after ${handshakeTimeoutMs}ms`,
            ),
          );
        }
      }, handshakeTimeoutMs).unref();
      const req =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`;
      socket.write(req);
    });

    // Actually dial the proxy. Cast: `connect` has many overloads; object form is valid.
    (origConnect as (opts: { port: number; host: string }) => Socket).call(socket, {
      port: proxyPort,
      host: proxyHost,
    });
    return socket;
  };

  return socket;
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
