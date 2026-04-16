import pg from 'pg';

export type DbPool = pg.Pool;

export function createPool(connectionString: string): DbPool {
  return new pg.Pool({ connectionString, max: 16, connectionTimeoutMillis: 15000 });
}
