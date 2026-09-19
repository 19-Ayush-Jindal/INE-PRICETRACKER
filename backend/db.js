// db.js
//
// One shared connection pool to Postgres (Supabase), used by both the API
// routes in server.js and the scraper's logging calls.

const { Pool } = require('pg');

if (!process.env.PG_CONNECTION_STRING) {
  // Fail loudly and immediately rather than limping along with a broken
  // pool - a missing DB connection should never be a silent surprise later.
  console.warn(
    'WARNING: PG_CONNECTION_STRING is not set. Set it in your .env file (see .env.example).'
  );
}

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,
  // Supabase (and most hosted Postgres providers) require SSL. The
  // rejectUnauthorized: false is the standard escape hatch for their
  // self-signed-looking certificate chains - it still encrypts the
  // connection, it just doesn't verify the CA chain.
  ssl: { rejectUnauthorized: false },
  // Without this, a wrong host/port/credentials in PG_CONNECTION_STRING (or
  // a network that can't reach Supabase at all) can leave `pg` hanging
  // indefinitely trying to connect, instead of failing with a clear error -
  // that silent hang is exactly what made the whole server look "stuck" on
  // startup with no error message. 10 seconds is generous for a normal
  // connection but still short enough to fail fast and say why.
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  // A background/idle client failed - log it, don't crash the whole server
  // over one bad connection in the pool.
  console.error('Unexpected Postgres pool error:', err);
});

module.exports = { pool };