

const { Pool } = require('pg');

if (!process.env.PG_CONNECTION_STRING) {
  console.warn(
    'WARNING: PG_CONNECTION_STRING is not set. Set it in your .env file (see .env.example).'
  );
}

const pool = new Pool({
  connectionString: process.env.PG_CONNECTION_STRING,

  ssl: { rejectUnauthorized: false },

  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {

  console.error('Unexpected Postgres pool error:', err);
});

module.exports = { pool };