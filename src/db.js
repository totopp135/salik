require('dotenv').config();
const { Pool } = require('pg');

// Cloud databases (Render, Neon...) require SSL; a local PostgreSQL does not.
const url = process.env.DATABASE_URL || '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(url) || url.includes('host=/');
const pool = new Pool({
  connectionString: url,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});
module.exports = pool;
