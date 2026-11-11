const pool = require('./db');
const { normalizePlate } = require('./plate');

const LOW_CONFIDENCE = 0.75;

async function getRate(c, gateId, vehicleTypeId, ts) {
  const { rows } = await c.query(
    `SELECT amount FROM toll_rates
     WHERE gate_id = $1 AND vehicle_type_id = $2
       AND valid_from <= $3 AND (valid_to IS NULL OR valid_to > $3)
     ORDER BY valid_from DESC LIMIT 1`,
    [gateId, vehicleTypeId, ts]
  );
  if (!rows[0]) throw new Error('No toll price configured for this gate and vehicle type');
  return Number(rows[0].amount);
}

async function insertPassage(c, gate, vehicleId, plate, conf, method, img, status, amount, ts) {
  const { rows } = await c.query(
    `INSERT INTO gate_passages
       (gate_id, vehicle_id, detected_plate, anpr_confidence, method, image_url, status, amount_charged, passed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [gate.id, vehicleId, plate, conf, method, img, status, amount, ts]
  );
  return rows[0];
}

async function createAlert(c, reportId, passageId, gateId) {
  await c.query(
    'INSERT INTO security_alerts (report_id, passage_id, gate_id) VALUES ($1,$2,$3)',
    [reportId, passageId, gateId]
  );
}

async function processPassage(gate, body) {
  const plate = normalizePlate(body.plate);
  const confidence = body.confidence == null ? 1 : Number(body.confidence);
  const method = body.method || 'ANPR';
  const imageUrl = body.image_url || null;
  const ts = body.timestamp ? new Date(body.timestamp) : new Date();

  const c = await pool.connect();
  let notify = null;
  try {
    await c.query('BEGIN');

    const stolen = (await c.query(
      `SELECT id FROM stolen_vehicle_reports WHERE plate_number = $1 AND status = 'ACTIVE' LIMIT 1`,
      [plate]
    )).rows[0];

    const vehicle = (await c.query(
      `SELECT id, user_id, vehicle_type_id FROM vehicles WHERE plate_number = $1 AND is_active`,
      [plate]
    )).rows[0];

    // Unknown vehicle
    if (!vehicle) {
      let status = 'UNREGISTERED';
      if (stolen) status = 'STOLEN_ALERT';
      else if (confidence < LOW_CONFIDENCE) status = 'MANUAL_REVIEW';
      const p = await insertPassage(c, gate, null, plate, confidence, method, imageUrl, status, 0, ts);
      if (stolen) await createAlert(c, stolen.id, p.id, gate.id);
      await c.query('COMMIT');
      return {
        action: stolen ? 'OPEN_AND_FLAG' : (status === 'MANUAL_REVIEW' ? 'REVIEW' : 'OPEN'),
        status, passage_id: p.id
      };
    }

    // Known vehicle: price + wallet
    const amount = await getRate(c, gate.id, vehicle.vehicle_type_id, ts);
    const wallet = (await c.query(
      'SELECT id, balance FROM wallets WHERE user_id = $1 FOR UPDATE', [vehicle.user_id]
    )).rows[0];

    const canPay = Number(wallet.balance) >= amount;
    const status = stolen ? 'STOLEN_ALERT' : (canPay ? 'PAID' : 'INSUFFICIENT_BALANCE');
    const passage = await insertPassage(
      c, gate, vehicle.id, plate, confidence, method, imageUrl, status, canPay ? amount : 0, ts
    );

    let newBalance = Number(wallet.balance);
    if (canPay) {
      const upd = await c.query(
        'UPDATE wallets SET balance = balance - $1, updated_at = now() WHERE id = $2 RETURNING balance',
        [amount, wallet.id]
      );
      newBalance = Number(upd.rows[0].balance);
      await c.query(
        `INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, passage_id, description)
         VALUES ($1,'TOLL_DEDUCTION',$2,$3,$4,$5)`,
        [wallet.id, -amount, newBalance, passage.id, 'Toll - ' + gate.name]
      );
    } else {
      await c.query(
        `INSERT INTO violations (passage_id, vehicle_id, user_id, toll_amount, due_date)
         VALUES ($1,$2,$3,$4, CURRENT_DATE + 7)`,
        [passage.id, vehicle.id, vehicle.user_id, amount]
      );
    }
    if (stolen) await createAlert(c, stolen.id, passage.id, gate.id);

    await c.query('COMMIT');

    notify = canPay
      ? { title: 'Toll paid', body: `${amount} EGP deducted at ${gate.name}. New balance: ${newBalance} EGP.` }
      : { title: 'Insufficient balance', body: `You passed ${gate.name} but your balance is too low for the ${amount} EGP toll. Please top up.` };
    // In-app notification now; real push (Firebase) is added later with the mobile app.
    pool.query(
      'INSERT INTO notifications (user_id, title, body, data) VALUES ($1,$2,$3,$4)',
      [vehicle.user_id, notify.title, notify.body, JSON.stringify({ passage_id: passage.id })]
    ).catch((e) => console.error('Notification error:', e.message));

    return {
      action: stolen ? 'OPEN_AND_FLAG' : 'OPEN',
      status, amount_charged: canPay ? amount : 0, passage_id: passage.id
    };
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

module.exports = { processPassage };
