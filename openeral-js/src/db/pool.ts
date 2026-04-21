import pg from 'pg';
import { URL } from 'node:url';
import { connectViaHttpProxy, isLocalHost, resolveHttpProxy } from './http-connect-socket.js';

export type DbPool = pg.Pool;

/**
 * Create a pg.Pool that tunnels through the OpenShell HTTP CONNECT proxy
 * when the current process has `HTTPS_PROXY`/`HTTP_PROXY` set AND the target
 * host is not a loopback address.
 *
 * This is how openeral reaches an external PostgreSQL (e.g. Supabase) from
 * inside an OpenShell sandbox: pg writes its wire protocol (including its
 * own end-to-end TLS) onto a socket that has already been through a CONNECT
 * handshake at the OpenShell proxy. The sandbox netns rejects direct TCP
 * to supabase:5432; the CONNECT tunnel is the only route.
 *
 * Outside an OpenShell sandbox (no HTTPS_PROXY), or for loopback targets
 * (PGlite, local testing), the pool behaves exactly like the previous
 * implementation — a plain `pg.Pool` with no tunneling.
 */
export function createPool(connectionString: string): DbPool {
  const proxyUrl = resolveHttpProxy();
  let targetHost: string | undefined;
  let targetPort = 5432;
  try {
    const u = new URL(connectionString);
    targetHost = u.hostname;
    if (u.port) targetPort = parseInt(u.port, 10);
  } catch {
    /* malformed connection string — fall through to pg's own error reporting */
  }

  const useTunnel = !!proxyUrl && !isLocalHost(targetHost);

  const poolConfig: pg.PoolConfig = {
    connectionString,
    max: 16,
    connectionTimeoutMillis: 15000,
  };

  if (useTunnel && targetHost) {
    // node-postgres invokes `stream` for every new connection. We hand back
    // a socket already past CONNECT — pg layers its pg wire protocol (and
    // TLS, if the connection string asks for sslmode=require) on top.
    poolConfig.stream = (() => connectViaHttpProxy({
      proxyUrl: proxyUrl!,
      targetHost: targetHost!,
      targetPort,
    })) as any;
  }

  return new pg.Pool(poolConfig);
}
