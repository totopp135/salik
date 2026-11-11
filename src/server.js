require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const pool = require('./db');
const { signToken, requireAuth, requireStaffRole, requireGate } = require('./auth');
const { processPassage } = require('./passage');
const { normalizePlate } = require('./plate');
const { readPlate, readQr, diagnose } = require('./scan');

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));  // photos from the staff app
// The site opens on the app; the staff dashboard is at /dashboard
app.get('/', (req, res) => res.redirect('/app/'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

app.get('/health', (req, res) => res.json({ ok: true, service: 'e-Toll backend' }));

/* ============ GATE (ANPR device) ============ */
app.post('/api/v1/gate/passages', requireGate, wrap(async (req, res) => {
  if (!req.body.plate) return res.status(400).json({ error: 'plate is required' });
  res.json(await processPassage(req.gate, req.body));
}));

app.post('/api/v1/gate/heartbeat', requireGate, wrap(async (req, res) => {
  await pool.query('UPDATE toll_gates SET last_heartbeat = now() WHERE id = $1', [req.gate.id]);
  res.json({ ok: true });
}));

/* ============ MOBILE APP: auth ============ */
app.post('/api/v1/app/auth/register', wrap(async (req, res) => {
  const { full_name, phone, password, email } = req.body;
  if (!full_name || !phone || !password) return res.status(400).json({ error: 'full_name, phone, password are required' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  const hash = await bcrypt.hash(password, 10);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const u = (await c.query(
      'INSERT INTO users (full_name, phone, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, full_name, phone',
      [full_name, phone, email || null, hash]
    )).rows[0];
    await c.query('INSERT INTO wallets (user_id) VALUES ($1)', [u.id]);
    await c.query('COMMIT');
    res.status(201).json({ user: u, token: signToken({ kind: 'user', id: u.id }) });
  } catch (e) {
    await c.query('ROLLBACK');
    if (e.code === '23505') return res.status(409).json({ error: 'Phone or email already registered' });
    throw e;
  } finally { c.release(); }
}));

app.post('/api/v1/app/auth/login', wrap(async (req, res) => {
  const { phone, password } = req.body;
  const u = (await pool.query('SELECT * FROM users WHERE phone = $1', [phone])).rows[0];
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) {
    return res.status(401).json({ error: 'Wrong phone or password' });
  }
  res.json({ user: { id: u.id, full_name: u.full_name, phone: u.phone }, token: signToken({ kind: 'user', id: u.id }) });
}));

/* ============ MOBILE APP: vehicles ============ */
const user = requireAuth('user');

app.get('/api/v1/app/vehicles', user, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT v.id, v.plate_number, v.make, v.model, v.color, v.qr_token, vt.code AS vehicle_type
     FROM vehicles v JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
     WHERE v.user_id = $1 AND v.is_active ORDER BY v.created_at DESC`, [req.auth.id]);
  res.json(rows);
}));

app.post('/api/v1/app/vehicles', user, wrap(async (req, res) => {
  const { plate, vehicle_type_id, make, model, color } = req.body;
  if (!plate || !vehicle_type_id) return res.status(400).json({ error: 'plate and vehicle_type_id are required' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO vehicles (user_id, vehicle_type_id, plate_number, plate_raw, make, model, color, qr_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7, encode(gen_random_bytes(16),'hex')) RETURNING *`,
      [req.auth.id, vehicle_type_id, normalizePlate(plate), plate, make || null, model || null, color || null]);
    res.status(201).json(rows[0]);
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'This plate is already linked to an account' });
    if (e.code === '23503') return res.status(400).json({ error: 'Unknown vehicle_type_id' });
    throw e;
  }
}));

/* ============ MOBILE APP: wallet ============ */
app.get('/api/v1/app/wallet', user, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT balance, currency FROM wallets WHERE user_id = $1', [req.auth.id]);
  // Current toll price for the driver's first vehicle (a private car if none yet),
  // so the app can show how many trips the balance covers without hard-coding prices.
  const price = (await pool.query(
    `SELECT r.amount AS toll_price, vt.name AS toll_vehicle
     FROM vehicle_types vt
     JOIN toll_rates r ON r.vehicle_type_id = vt.id
       AND r.valid_from <= now() AND (r.valid_to IS NULL OR r.valid_to > now())
     WHERE vt.id = COALESCE(
       (SELECT vehicle_type_id FROM vehicles WHERE user_id = $1 AND is_active ORDER BY created_at LIMIT 1),
       (SELECT id FROM vehicle_types WHERE code = 'CAR'))
     ORDER BY r.amount LIMIT 1`, [req.auth.id])).rows[0] || {};
  res.json({ ...rows[0], ...price });
}));

app.get('/api/v1/app/wallet/transactions', user, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.amount, t.balance_after, t.description, t.created_at
     FROM wallet_transactions t JOIN wallets w ON w.id = t.wallet_id
     WHERE w.user_id = $1 ORDER BY t.created_at DESC LIMIT 100`, [req.auth.id]);
  res.json(rows);
}));

// DEMO top-up: credits instantly with no real payment. Real gateways come later.
app.post('/api/v1/app/wallet/topup-demo', user, wrap(async (req, res) => {
  const amount = Number(req.body.amount);
  if (!(amount > 0) || amount > 10000) return res.status(400).json({ error: 'amount must be between 1 and 10000' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const p = (await c.query(
      `INSERT INTO payments (user_id, method, amount, status, completed_at)
       VALUES ($1,'OTHER',$2,'SUCCESS',now()) RETURNING id`, [req.auth.id, amount])).rows[0];
    const w = (await c.query(
      'UPDATE wallets SET balance = balance + $1, updated_at = now() WHERE user_id = $2 RETURNING id, balance',
      [amount, req.auth.id])).rows[0];
    await c.query(
      `INSERT INTO wallet_transactions (wallet_id, type, amount, balance_after, payment_id, description)
       VALUES ($1,'TOPUP',$2,$3,$4,'Wallet top-up (demo)')`, [w.id, amount, w.balance, p.id]);
    await c.query('COMMIT');
    res.json({ balance: w.balance });
  } catch (e) { await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}));

/* ============ MOBILE APP: trips + notifications + violations ============ */
app.get('/api/v1/app/trips', user, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.passed_at, p.status, p.amount_charged, g.name AS gate, v.plate_number
     FROM gate_passages p
     JOIN vehicles v ON v.id = p.vehicle_id
     JOIN toll_gates g ON g.id = p.gate_id
     WHERE v.user_id = $1 ORDER BY p.passed_at DESC LIMIT 100`, [req.auth.id]);
  res.json(rows);
}));

app.get('/api/v1/app/notifications', user, wrap(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, body, is_read, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100',
    [req.auth.id]);
  res.json(rows);
}));

app.get('/api/v1/app/violations', user, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, toll_amount, fine_amount, status, due_date FROM violations
     WHERE user_id = $1 AND status = 'OPEN' ORDER BY created_at DESC`, [req.auth.id]);
  res.json(rows);
}));

/* ============ DASHBOARD (staff) ============ */
app.post('/api/v1/admin/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body;
  const s = (await pool.query('SELECT * FROM staff_users WHERE email = $1 AND is_active', [email])).rows[0];
  if (!s || !(await bcrypt.compare(password || '', s.password_hash))) {
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  res.json({ staff: { id: s.id, full_name: s.full_name, role: s.role },
             token: signToken({ kind: 'staff', id: s.id, role: s.role }) });
}));

const staff = requireAuth('staff');

app.get('/api/v1/admin/passages', staff, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.passed_at, p.detected_plate, p.status, p.amount_charged, g.name AS gate
     FROM gate_passages p JOIN toll_gates g ON g.id = p.gate_id
     ORDER BY p.passed_at DESC LIMIT 100`);
  res.json(rows);
}));

app.get('/api/v1/admin/stats', staff, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT
       (SELECT COUNT(*)::int FROM gate_passages WHERE passed_at >= date_trunc('day', now())) AS passages_today,
       (SELECT COALESCE(SUM(amount_charged),0) FROM gate_passages WHERE passed_at >= date_trunc('day', now())) AS revenue_today,
       (SELECT COUNT(*)::int FROM security_alerts WHERE status = 'NEW') AS open_alerts,
       (SELECT COUNT(*)::int FROM users) AS drivers,
       (SELECT COUNT(*)::int FROM vehicles WHERE is_active) AS vehicles,
       (SELECT COUNT(*)::int FROM violations WHERE status = 'OPEN') AS unpaid_tolls,
       (SELECT COALESCE(SUM(toll_amount + fine_amount),0) FROM violations WHERE status = 'OPEN') AS unpaid_amount,
       (SELECT COALESCE(json_object_agg(status, n), '{}'::json) FROM (
          SELECT status, COUNT(*)::int AS n FROM gate_passages
          WHERE passed_at >= date_trunc('day', now()) GROUP BY status) s) AS by_status`);
  res.json(rows[0]);
}));

/* ============ STAFF APP: scan at the gate ============ */
app.get('/api/v1/admin/gates', staff, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, code, name FROM toll_gates ORDER BY name');
  res.json(rows);
}));

app.get('/api/v1/admin/scan/diagnose', staff, wrap(async (req, res) => res.json(await diagnose())));

// Photo of a car -> plate number (the operator confirms it before charging)
app.post('/api/v1/admin/scan/read-plate', staff, wrap(async (req, res) => {
  res.json(await readPlate(req.body.image));
}));

// Photo of a driver's QR code -> the linked vehicle
app.post('/api/v1/admin/scan/read-qr', staff, wrap(async (req, res) => {
  const text = await readQr(req.body.image);
  if (!text) return res.status(422).json({ error: 'No QR code found in the photo. Hold the camera closer and try again.' });
  const token = String(text).replace(/^ETOLL:/i, '').trim();
  const { rows } = await pool.query(
    `SELECT v.plate_number, vt.code AS vehicle_type, u.full_name AS owner
     FROM vehicles v JOIN vehicle_types vt ON vt.id = v.vehicle_type_id JOIN users u ON u.id = v.user_id
     WHERE v.qr_token = $1 AND v.is_active`, [token]);
  if (!rows[0]) return res.status(404).json({ error: 'This QR code is not linked to any active vehicle.' });
  res.json(rows[0]);
}));

// Charge the toll for a confirmed plate at the chosen gate
app.post('/api/v1/admin/scan/charge', staff, requireStaffRole('ADMIN', 'OPERATOR'), wrap(async (req, res) => {
  const { gate_id, plate, method } = req.body;
  if (!plate) return res.status(400).json({ error: 'plate is required' });
  const gate = (await pool.query(
    gate_id ? 'SELECT * FROM toll_gates WHERE id = $1' : 'SELECT * FROM toll_gates ORDER BY created_at LIMIT 1',
    gate_id ? [gate_id] : [])).rows[0];
  if (!gate) return res.status(400).json({ error: 'Unknown gate' });
  const m = ['ANPR', 'QR', 'MANUAL'].includes(method) ? method : 'MANUAL';
  const result = await processPassage(gate, { plate, method: m, confidence: 1 });
  const owner = (await pool.query(
    `SELECT u.full_name, w.balance FROM vehicles v JOIN users u ON u.id = v.user_id
     JOIN wallets w ON w.user_id = u.id WHERE v.plate_number = $1 AND v.is_active`, [normalizePlate(plate)])).rows[0];
  res.json({ ...result, plate: normalizePlate(plate), gate: gate.name,
             owner: owner ? owner.full_name : null, balance: owner ? owner.balance : null });
}));

app.post('/api/v1/admin/stolen-reports', staff, requireStaffRole('POLICE', 'ADMIN'), wrap(async (req, res) => {
  const { plate_number, report_number, description } = req.body;
  if (!plate_number) return res.status(400).json({ error: 'plate_number is required' });
  const plate = normalizePlate(plate_number);
  const v = (await pool.query('SELECT id FROM vehicles WHERE plate_number = $1 AND is_active', [plate])).rows[0];
  const { rows } = await pool.query(
    `INSERT INTO stolen_vehicle_reports (plate_number, vehicle_id, report_number, reported_by, description)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [plate, v ? v.id : null, report_number || null, req.auth.id, description || null]);
  res.status(201).json(rows[0]);
}));

app.get('/api/v1/admin/alerts', staff, requireStaffRole('POLICE', 'ADMIN'), wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT a.id, a.status, a.created_at, r.plate_number, g.name AS gate
     FROM security_alerts a
     JOIN stolen_vehicle_reports r ON r.id = a.report_id
     JOIN toll_gates g ON g.id = a.gate_id
     ORDER BY a.created_at DESC LIMIT 100`);
  res.json(rows);
}));

/* ============ errors ============ */
app.use((err, req, res, next) => {
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

const port = process.env.PORT || 3000;
const { initDatabase } = require('./init');
initDatabase()
  .catch((e) => console.error('Database setup failed:', e.message))
  .finally(() => app.listen(port, () => {
  console.log(`e-Toll backend running on http://localhost:${port}`);
  // Addresses a phone on the same Wi-Fi can open
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) console.log(`  Phone app: http://${n.address}:${port}/app/`);
    }
  }
}));
