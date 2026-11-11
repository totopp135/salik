// Loads DATABASE_URL: .env.local is written by `neon deploy` / `neon env pull`;
// on Render the value comes from the service's environment variables.
require('dotenv').config({ path: ['.env.local', '.env'] });
const { Pool } = require('pg');

// Neon (and other cloud databases) require SSL; a local PostgreSQL does not.
// For this long-running Express server, use Neon's pooled connection string (host contains "-pooler").
const url = process.env.DATABASE_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('host=/');
const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
});
// Neon suspends idle computes; a dropped idle client must not crash the server.
pool.on('error', (err) => console.error('Database connection error:', err.message));
module.exports = pool;
