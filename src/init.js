// On first start (empty database) create all tables and the demo gate, prices and admin.
// Safe to run every time: it does nothing if the tables already exist.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { OVERDRAFT_LIMIT } = require('./rules');

// Small changes to an existing database, safe to run on every start.
async function migrate() {
  // Let wallets go negative down to the overdraft limit.
  const name = `wallets_overdraft_limit_${OVERDRAFT_LIMIT}`;
  const has = (await pool.query('SELECT 1 FROM pg_constraint WHERE conname = $1', [name])).rows[0];
  if (has) return;
  const old = (await pool.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'wallets'::regclass AND contype = 'c'
       AND (conname = 'wallets_balance_check' OR conname LIKE 'wallets_overdraft_limit_%')`)).rows;
  for (const r of old) await pool.query(`ALTER TABLE wallets DROP CONSTRAINT IF EXISTS "${r.conname}"`);
  await pool.query(`ALTER TABLE wallets ADD CONSTRAINT "${name}" CHECK (balance >= -${Number(OVERDRAFT_LIMIT)})`);
  console.log(`Wallets may now go down to -${OVERDRAFT_LIMIT} EGP`);
}

async function initDatabase() {
  const created = await createIfEmpty();
  await migrate();
  return created;
}

async function createIfEmpty() {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS t");
  if (rows[0].t) return false;

  console.log('Empty database: creating tables and demo data...');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

  const gateKey = await bcrypt.hash(process.env.GATE_API_KEY || 'demo-gate-key', 10);
  const gate = (await pool.query(
    `INSERT INTO toll_gates (code, name, highway, direction, api_key_hash)
     VALUES ('CAI-01','Cairo-Alexandria Desert Road Gate 1','Cairo-Alex Desert Road','North',$1)
     RETURNING id`, [gateKey])).rows[0];

  const prices = { MOTORCYCLE: 5, CAR: 10, MICROBUS: 30, BUS: 40, TRUCK: 60 };
  const types = (await pool.query('SELECT id, code FROM vehicle_types')).rows;
  for (const t of types) {
    await pool.query('INSERT INTO toll_rates (gate_id, vehicle_type_id, amount) VALUES ($1,$2,$3)',
      [gate.id, t.id, prices[t.code]]);
  }

  const adminHash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'Admin123!', 10);
  await pool.query(
    `INSERT INTO staff_users (full_name, email, password_hash, role)
     VALUES ('System Admin','admin@etoll.local',$1,'ADMIN')`, [adminHash]);
  console.log('Database ready. Admin: admin@etoll.local');
  return true;
}

module.exports = { initDatabase };
