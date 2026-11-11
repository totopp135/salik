// On first start (empty database) create all tables and the demo gate, prices and admin.
// Safe to run every time: it does nothing if the tables already exist.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('./db');

async function initDatabase() {
  const { rows } = await pool.query("SELECT to_regclass('public.users') AS t");
  if (rows[0].t) return false;

  console.log('Empty database: creating tables and demo data...');
  await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

  const gateKey = await bcrypt.hash(process.env.GATE_API_KEY || 'demo-gate-key', 10);
  const gate = (await pool.query(
    `INSERT INTO toll_gates (code, name, highway, direction, api_key_hash)
     VALUES ('CAI-01','Cairo-Alexandria Desert Road Gate 1','Cairo-Alex Desert Road','North',$1)
     RETURNING id`, [gateKey])).rows[0];

  const prices = { MOTORCYCLE: 5, CAR: 20, MICROBUS: 30, BUS: 40, TRUCK: 60 };
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
