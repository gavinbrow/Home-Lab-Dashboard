import pg from 'pg';
export function createPool(connectionString=process.env.DATABASE_URL) {
  if(!connectionString) throw new Error('DATABASE_URL is required');
  return new pg.Pool({connectionString,max:10,connectionTimeoutMillis:5000,statement_timeout:15000});
}
