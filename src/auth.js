const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const pool = require('./db');

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// kind = 'user' (mobile app) or 'staff' (dashboard)
function requireAuth(kind) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    try {
      const p = jwt.verify(token, process.env.JWT_SECRET);
      if (p.kind !== kind) return res.status(403).json({ error: 'Wrong token type' });
      req.auth = p;
      next();
    } catch (e) {
      res.status(401).json({ error: 'Invalid or expired token' });
    }
  };
}

function requireStaffRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.auth.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    next();
  };
}

// Gate devices authenticate with headers X-Gate-Code and X-Api-Key
async function requireGate(req, res, next) {
  try {
    const code = req.headers['x-gate-code'];
    const key = req.headers['x-api-key'];
    if (!code || !key) return res.status(401).json({ error: 'Missing gate credentials' });
    const { rows } = await pool.query('SELECT * FROM toll_gates WHERE code = $1', [code]);
    const gate = rows[0];
    if (!gate || !(await bcrypt.compare(key, gate.api_key_hash))) {
      return res.status(401).json({ error: 'Invalid gate credentials' });
    }
    req.gate = gate;
    next();
  } catch (e) { next(e); }
}

module.exports = { signToken, requireAuth, requireStaffRole, requireGate };
