/**
 * HTTP CONNECT tunnel for raw-TCP clients (specifically node-postgres).
 *
 * Context: inside an OpenShell sandbox, the kernel-level iptables rules in the
 * sandbox netns REJECT every outbound TCP packet that isn't destined for the
 * HTTP proxy at `10.200.0.1:3128`. Raw TCP to an external PostgreSQL host
 * cannot leave the sandbox.
 *
 * The HTTP CONNECT proxy, however, accepts a `CONNECT host:port` request and —
 * once it returns `200 Connection Established` — relays bytes bidirectionally
 * without further inspection. That relay carries anything: the pg wire
 * protocol, its end-to-end TLS handshake with Supabase, everything.
 *
 * `connectViaHttpProxy()` produces a Node `net.Socket` that is already past
 * the CONNECT handshake, ready to be handed to node-postgres via the Pool's
 * `stream` factory option. pg then writes its own wire protocol (including
 * its own TLS) onto the tunneled socket and the proxy just shuttles bytes.
 */

import { Socket, createConnection } from 'node:net';
import { URL } from 'node:url';

export interface HttpConnectOptions {
  /** Proxy URL — e.g. "http://10.200.0.1:3128". Must be http, not https. */
  proxyUrl: string;
  /** Target host the tunnel should reach (DNS is done proxy-side). */
  targetHost: string;
  /** Target port. */
  targetPort: number;
  /** TCP connect timeout for reaching the proxy (ms). Default 15_000. */
  connectTimeoutMs?: number;
  /** CONNECT handshake read timeout (ms). Default 15_000. */
  handshakeTimeoutMs?: number;
}

/**
 * Open a TCP socket, negotiate HTTP CONNECT against `proxyUrl`, and resolve
 * a `Socket` that is positioned at the start of the tunneled byte stream.
 *
 * On non-200 responses, rejects with an error whose message includes the full
 * status line so the proxy's deny reason is surfaced (e.g. `403 binary policy
 * denied`, `502 upstream dns lookup failed`).
 */
export function connectViaHttpProxy(opts: HttpConnectOptions): Promise<Socket> {
  const {
    proxyUrl,
    targetHost,
    targetPort,
    connectTimeoutMs = 15_000,
    handshakeTimeoutMs = 15_000,
  } = opts;

  let proxy: URL;
  try {
    proxy = new URL(proxyUrl);
  } catch (err) {
    return Promise.reject(new Error(`http-connect-socket: invalid proxy URL ${proxyUrl}`));
  }
  if (proxy.protocol !== 'http:') {
    return Promise.reject(
      new Error(`http-connect-socket: proxy must be http://, got ${proxy.protocol}`),
    );
  }
  const proxyHost = proxy.hostname;
  const proxyPort = parseInt(proxy.port || '80', 10);

  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: proxyHost, port: proxyPort });
    let buf = '';
    let settled = false;

    const connectTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(
        new Error(
          `http-connect-socket: TCP connect to proxy ${proxyHost}:${proxyPort} timed out after ${connectTimeoutMs}ms`,
        ),
      );
    }, connectTimeoutMs);

    let handshakeTimer: NodeJS.Timeout | null = null;

    const finish = (err: Error | null, s?: Socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      if (handshakeTimer) clearTimeout(handshakeTimer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('end', onEnd);
      if (err) {
        socket.destroy();
        reject(err);
      } else {
        resolve(s!);
      }
    };

    const onData = (chunk: Buffer) => {
      buf += chunk.toString('binary');
      const headerEnd = buf.indexOf('\r\n\r\n');
      if (headerEnd === -1) return; // keep buffering
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      // Spec: HTTP/1.1 200 Connection Established
      const match = statusLine.match(/^HTTP\/\d\.\d\s+(\d{3})\s*(.*)$/);
      if (!match) {
        finish(new Error(`http-connect-socket: unparseable proxy response: ${statusLine}`));
        return;
      }
      const status = parseInt(match[1], 10);
      if (status !== 200) {
        finish(
          new Error(
            `http-connect-socket: tunnel to ${targetHost}:${targetPort} denied — ${statusLine}`,
          ),
        );
        return;
      }
      // Any payload bytes arrived after the \r\n\r\n belong to the tunnel —
      // unshift them back so the pg client reads them first.
      const bodyStart = headerEnd + 4;
      if (bodyStart < buf.length) {
        socket.unshift(Buffer.from(buf.slice(bodyStart), 'binary'));
      }
      finish(null, socket);
    };

    const onError = (err: Error) => finish(err);
    const onEnd = () =>
      finish(new Error('http-connect-socket: proxy closed connection before CONNECT response'));

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      handshakeTimer = setTimeout(() => {
        finish(
          new Error(
            `http-connect-socket: CONNECT handshake with ${proxyHost}:${proxyPort} timed out after ${handshakeTimeoutMs}ms`,
          ),
        );
      }, handshakeTimeoutMs);

      const req =
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
        `Host: ${targetHost}:${targetPort}\r\n` +
        `Proxy-Connection: keep-alive\r\n\r\n`;
      socket.write(req);
    });

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
  });
}

/**
 * Return the HTTP proxy URL active in this process env, if any.
 * Checks in the order OpenShell's child_env writes them.
 */
export function resolveHttpProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return (
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || undefined
  );
}

/**
 * Is the given hostname "local" (loopback or unset)? Used to decide whether
 * a connection needs tunneling.
 */
export function isLocalHost(host: string | undefined): boolean {
  if (!host) return true;
  const h = host.toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}
