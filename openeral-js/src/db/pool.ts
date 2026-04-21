import pg from 'pg';
import { URL } from 'node:url';
import { createTunneledSocket, isLocalHost, resolveHttpProxy } from './http-connect-socket.js';

export type DbPool = pg.Pool;

/**
 * Create a pg.Pool that tunnels through the OpenShell HTTP CONNECT proxy
 * when the current process has `HTTPS_PROXY`/`HTTP_PROXY` set AND the target
 * host is not a loopback address.
 *
 * This is how openeral reaches an external PostgreSQL (e.g. Supabase) from
 * inside an OpenShell sandbox. The sandbox netns rejects direct TCP to
 * supabase:5432; the CONNECT tunnel is the only route.
 *
 * Outside an OpenShell sandbox (no HTTPS_PROXY), or for loopback targets
 * (PGlite, local testing), the pool behaves exactly like the previous
 * implementation — a plain `pg.Pool` with no tunneling.
 */
export function createPool(connectionString: string): DbPool {
  const proxyUrl = resolveHttpProxy();
  let targetHost: string | undefined;
  try {
    const u = new URL(connectionString);
    targetHost = u.hostname;
  } catch {
    /* malformed connection string — pg will surface the error */
  }

  const useTunnel = !!proxyUrl && !isLocalHost(targetHost);

  const poolConfig: pg.PoolConfig = {
    connectionString,
    max: 16,
    connectionTimeoutMillis: 15000,
  };

  if (useTunnel) {
    // pg 8.20 calls `stream` *synchronously* and expects a raw net.Socket.
    // It then calls `setNoDelay(true)` and `.connect(port, host)` on the
    // returned socket. Our tunneled socket accepts `.connect(port, host)`,
    // routes the TCP to the proxy, and fires 'connect' only once CONNECT
    // has been negotiated — matching pg's expectations.
    poolConfig.stream = (() =>
      createTunneledSocket({ proxyUrl: proxyUrl! })) as pg.PoolConfig['stream'];
  }

  return new pg.Pool(poolConfig);
}
