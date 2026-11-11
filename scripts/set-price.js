// Changes the toll price for one vehicle type at every gate.
// Usage: node scripts/set-price.js CAR 10
// The old price is kept in history (valid_to is set), the new one starts now.
const pool = require('../src/db');

const [code, amountText] = process.argv.slice(2);
const amount = Number(amountText);

(async () => {
  if (!code || !(amount >= 0)) {
    console.error('Usage: node scripts/set-price.js <MOTORCYCLE|CAR|MICROBUS|BUS|TRUCK> <amount>');
    process.exitCode = 1;
    return pool.end();
  }
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const type = (await c.query('SELECT id FROM vehicle_types WHERE code = $1', [code.toUpperCase()])).rows[0];
    if (!type) throw new Error('Unknown vehicle type ' + code);
    await c.query('UPDATE toll_rates SET valid_to = now() WHERE vehicle_type_id = $1 AND valid_to IS NULL', [type.id]);
    const r = await c.query(
      'INSERT INTO toll_rates (gate_id, vehicle_type_id, amount) SELECT id, $1, $2 FROM toll_gates',
      [type.id, amount]);
    await c.query('COMMIT');
    console.log(`OK: ${code.toUpperCase()} price is now ${amount} EGP at ${r.rowCount} gate(s)`);
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('FAILED:', e.message);
    process.exitCode = 1;
  } finally {
    c.release();
    await pool.end();
  }
})();
