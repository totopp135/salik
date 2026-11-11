// Creates all tables and demo data. WARNING: wipes everything in the "etoll" database.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const pool = require('../src/db');

(async () => {
  try {
    console.log('Creating tables...');
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await pool.query(fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8'));

    console.log('Adding demo gate, prices and admin account...');
    const gateKey = await bcrypt.hash('demo-gate-key', 10);
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

    const adminHash = await bcrypt.hash('Admin123!', 10);
    await pool.query(
      `INSERT INTO staff_users (full_name, email, password_hash, role)
       VALUES ('System Admin','admin@etoll.local',$1,'ADMIN')`, [adminHash]);

    console.log('\nDone! Database is ready.');
    console.log('  Dashboard login : admin@etoll.local / Admin123!');
    console.log('  Gate credentials: code CAI-01 / key demo-gate-key');
  } catch (e) {
    console.error('\nSETUP FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
